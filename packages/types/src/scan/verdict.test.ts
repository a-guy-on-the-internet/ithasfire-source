import { describe, expect, it } from "vitest";

import {
  SCAN_UNKNOWN_REASONS,
  TICKET_SCAN_STATUSES,
  TICKET_STATUS_COPY,
} from "./ticket-status-copy";
import {
  ADMIT_REJECTION_FALLBACK_KEY,
  SCAN_FEEDBACK_KINDS,
  SCAN_GLYPHS,
  SCAN_GLYPH_IDS,
  UNRECOGNISED_SCAN_REASON_GUIDANCE,
  VERDICT_FEEDBACK,
  resolveAdmitOutcomeVerdictKey,
  resolveAdmitRejectionVerdictKey,
  MAX_VERDICT_STATE_LENGTH,
  MAX_VERDICT_WORD_LENGTH,
  SCAN_UNKNOWN_VERDICT,
  SCAN_VERDICTS,
  SCAN_VERDICT_KEYS,
  TICKET_STATUS_VERDICT,
  UNRECOGNISED_STATUS_VERDICT_KEY,
  VERDICT_TONES,
  isScanVerdictKey,
  resolveScanUnknownVerdictKey,
  resolveTicketStatusVerdictKey,
  scanVerdict,
  verdictStateLine,
  type ScanVerdictKey,
} from "./verdict";

/**
 * The shared verdict map, asserted rather than eyeballed.
 *
 * The tests that matter most here are the ones about what the WORD says. The
 * DS's rule (D-123) is that the word is an instruction, and the two-tone system
 * only works because of it: with `pass` and `fail` as the only fills, the word
 * is the channel that separates "this pass was already used" from "we could not
 * check it" — outcomes with opposite correct actions.
 */

describe("the map is total and well-formed", () => {
  it("covers every key exactly once, with the key matching its slot", () => {
    expect(Object.keys(SCAN_VERDICTS).sort()).toEqual(
      [...SCAN_VERDICT_KEYS].sort(),
    );
    for (const key of SCAN_VERDICT_KEYS) {
      expect(SCAN_VERDICTS[key].key, key).toBe(key);
    }
  });

  it("uses only the two DS tones, and uses both", () => {
    const tones = new Set(SCAN_VERDICT_KEYS.map((k) => SCAN_VERDICTS[k].tone));
    for (const tone of tones) expect(VERDICT_TONES).toContain(tone);
    // A map that had drifted to one tone would still pass the line above.
    expect([...tones].sort()).toEqual([...VERDICT_TONES].sort());
  });

  it("gives every entry a non-empty state and word", () => {
    for (const key of SCAN_VERDICT_KEYS) {
      const v = SCAN_VERDICTS[key];
      expect(v.state.trim().length, key).toBeGreaterThan(0);
      expect(v.word.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("gives every entry a unique i18n key pair", () => {
    const keys = SCAN_VERDICT_KEYS.flatMap((k) => [
      SCAN_VERDICTS[k].stateKey,
      SCAN_VERDICTS[k].wordKey,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the WORD is an instruction (DS D-123)", () => {
  it("is uppercase, unpunctuated, and short enough to read at arm's length", () => {
    for (const key of SCAN_VERDICT_KEYS) {
      const { word } = SCAN_VERDICTS[key];
      expect(word, key).toBe(word.toUpperCase());
      expect(word, key).not.toMatch(/[.!?,;:]/);
      expect(word.length, `${key}: "${word}"`).toBeLessThanOrEqual(
        MAX_VERDICT_WORD_LENGTH,
      );
    }
  });

  it("never repeats the state line — the word says what to DO, not what it is", () => {
    // "Refunded / REFUNDED" is the failure mode: it burns the biggest type on
    // the screen restating a line the operator already read, and leaves the
    // actual decision to the colour.
    for (const key of SCAN_VERDICT_KEYS) {
      const { state, word } = SCAN_VERDICTS[key];
      expect(word, key).not.toBe(state.toUpperCase());
    }
  });

  it("does not overstate a code we merely could not CHECK", () => {
    // The safety rule, written down. A code missing from the offline manifest
    // is not evidence the ticket is bad; `STOP` there turns away a
    // possibly-valid holder because of OUR sync gap.
    expect(SCAN_VERDICTS.cantVerifyOffline.word).toBe("CHECK FIRST");
    expect(SCAN_VERDICTS.cantVerifyOffline.word).not.toBe("STOP");
    // Same class: the pass is fine, the door is not open yet.
    expect(SCAN_VERDICTS.doorsNotOpen.word).toBe("HOLD");
    expect(SCAN_VERDICTS.doorsNotOpen.word).not.toBe("STOP");
    // And neither state line may CLAIM invalidity.
    expect(SCAN_VERDICTS.cantVerifyOffline.state).not.toMatch(/\binvalid\b/i);
    expect(SCAN_VERDICTS.doorsNotOpen.state).not.toMatch(/\binvalid\b/i);
  });

  it("never tells the operator to admit on a fail tone", () => {
    // The one-way door: no `fail` verdict may carry a word that reads as
    // permission. This is the assertion that would catch a well-meaning
    // "soften CHECK FIRST to LET THEM IN" edit.
    const ADMIT_WORDS = /\b(LET THEM IN|ADMIT|CHECK THEM IN|GO|ENTER)\b/;
    for (const key of SCAN_VERDICT_KEYS) {
      const v = SCAN_VERDICTS[key];
      if (v.tone === "fail") expect(v.word, key).not.toMatch(ADMIT_WORDS);
    }
  });

  it("keeps every pass verdict's word an affirmative action", () => {
    const passKeys = SCAN_VERDICT_KEYS.filter(
      (k) => SCAN_VERDICTS[k].tone === "pass",
    );
    expect(passKeys.sort()).toEqual(["admitted", "valid", "volunteer"]);
    for (const key of passKeys) {
      expect(SCAN_VERDICTS[key].word, key).not.toMatch(
        /\b(STOP|HOLD|CHECK FIRST|TRY AGAIN|USE SEARCH)\b/,
      );
    }
  });
});

describe("the STATE line", () => {
  it("is sentence case and fits beside the appended time", () => {
    for (const key of SCAN_VERDICT_KEYS) {
      const { state } = SCAN_VERDICTS[key];
      expect(state.length, `${key}: "${state}"`).toBeLessThanOrEqual(
        MAX_VERDICT_STATE_LENGTH,
      );
      expect(state, key).not.toMatch(/[.!?]/);
      // Not SHOUTED in the source — surfaces uppercase it, and a pre-shouted
      // source would silently double the transform in a catalog translation.
      expect(state, key).not.toBe(state.toUpperCase());
    }
  });

  it("distinguishes every outcome that shares a word", () => {
    // With two tones and one word for eleven fails, the state line is the ONLY
    // channel left that separates them. Two `STOP` entries with the same state
    // would be one outcome wearing two keys.
    const seen = new Map<string, ScanVerdictKey>();
    for (const key of SCAN_VERDICT_KEYS) {
      const state = SCAN_VERDICTS[key].state.toLowerCase();
      expect(seen.get(state), `"${state}" is shared with ${seen.get(state)}`)
        .toBeUndefined();
      seen.set(state, key);
    }
  });

  it("appends a pre-formatted time with the DS's separator", () => {
    expect(verdictStateLine("alreadyUsed", "8:14 PM")).toBe(
      "ALREADY USED · 8:14 PM",
    );
    expect(verdictStateLine("alreadyUsed")).toBe("ALREADY USED");
    expect(verdictStateLine("alreadyUsed", null)).toBe("ALREADY USED");
    // Whitespace is not a time.
    expect(verdictStateLine("alreadyUsed", "  ")).toBe("ALREADY USED");
  });
});

describe("outcome → key", () => {
  it("maps every ticket status", () => {
    expect(Object.keys(TICKET_STATUS_VERDICT).sort()).toEqual(
      [...TICKET_SCAN_STATUSES].sort(),
    );
    for (const status of TICKET_SCAN_STATUSES) {
      expect(isScanVerdictKey(TICKET_STATUS_VERDICT[status]), status).toBe(true);
    }
  });

  it("agrees with `admittable` about which status is a pass", () => {
    // Two independently-authored tables encode the same rule on different
    // axes. This is the assertion that stops them drifting: a status flipped to
    // `pass` here without `admittable` moving would paint the amber PASS field
    // over a ticket the rail refuses to admit.
    for (const status of TICKET_SCAN_STATUSES) {
      const tone = SCAN_VERDICTS[TICKET_STATUS_VERDICT[status]].tone;
      expect(tone === "pass", status).toBe(TICKET_STATUS_COPY[status].admittable);
    }
  });

  it("maps every unknown reason, and each to its own key", () => {
    expect(Object.keys(SCAN_UNKNOWN_VERDICT).sort()).toEqual(
      [...SCAN_UNKNOWN_REASONS].sort(),
    );
    const keys = SCAN_UNKNOWN_REASONS.map((r) => SCAN_UNKNOWN_VERDICT[r]);
    // "No match", "Tampered" and "Unreadable" are three different facts about
    // a payload; the shared `label` in `ticket-status-copy` ("Not recognized")
    // is what this map exists to improve on.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fails closed on a status the build has never heard of", () => {
    for (const bogus of ["TELEPORTED", "valid", "", null, undefined]) {
      const key = resolveTicketStatusVerdictKey(bogus);
      expect(key, String(bogus)).toBe(UNRECOGNISED_STATUS_VERDICT_KEY);
      expect(scanVerdict(key).tone).toBe("fail");
    }
  });

  it("fails CLOSED on an unknown-payload reason — STOP, same as an unknown status", () => {
    // Orchestrator ruling: an unrecognised reason is not a rescan loop. It
    // resolves to the same key, and so the same word, as an unrecognised
    // status.
    for (const bogus of ["whatever", "", "constructor", null, undefined]) {
      const key = resolveScanUnknownVerdictKey(bogus);
      expect(key, String(bogus)).toBe(UNRECOGNISED_STATUS_VERDICT_KEY);
      expect(scanVerdict(key).word).toBe("STOP");
    }
    expect(resolveScanUnknownVerdictKey("malformed")).toBe("unreadable");
    expect(resolveScanUnknownVerdictKey("signature_failed")).toBe("tampered");
    // Its detail must not contradict STOP with "try again".
    expect(UNRECOGNISED_SCAN_REASON_GUIDANCE.guidance).not.toMatch(/try again/i);
  });

  it("recognises exactly the declared keys", () => {
    for (const key of SCAN_VERDICT_KEYS) expect(isScanVerdictKey(key)).toBe(true);
    for (const bogus of ["Valid", "stop", 7, null, undefined, {}]) {
      expect(isScanVerdictKey(bogus), String(bogus)).toBe(false);
    }
  });
});

describe("a failed round trip has two keys, by stage", () => {
  it("separates a failed LOOKUP from a failed WRITE, both TRY AGAIN", () => {
    expect(scanVerdict("scanFailed").state).toBe("Scan failed");
    expect(scanVerdict("notRecorded").state).toBe("Not recorded");
    for (const key of ["scanFailed", "notRecorded"] as const) {
      expect(scanVerdict(key).tone).toBe("fail");
      expect(scanVerdict(key).word).toBe("TRY AGAIN");
      expect(SCAN_GLYPHS[key]).toBe("ServerOff");
    }
  });
});

describe("a settled admit → key (shared by both surfaces)", () => {
  it("only ACCEPTED is an admission", () => {
    expect(resolveAdmitOutcomeVerdictKey({ outcome: "ACCEPTED" })).toBe(
      "admitted",
    );
    expect(resolveAdmitOutcomeVerdictKey({ outcome: "REPLAY" })).toBe(
      "alreadyUsed",
    );
    for (const outcome of ["REJECTED", "SOMETHING_NEW", ""]) {
      expect(
        scanVerdict(resolveAdmitOutcomeVerdictKey({ outcome })).tone,
        outcome,
      ).toBe("fail");
    }
  });

  it("maps every server rejection reason to its own verdict", () => {
    expect(resolveAdmitRejectionVerdictKey("ticket_not_found")).toBe("noMatch");
    expect(resolveAdmitRejectionVerdictKey("ticket_not_valid")).toBe("invalid");
    expect(resolveAdmitRejectionVerdictKey("event_mismatch")).toBe("wrongEvent");
    expect(resolveAdmitRejectionVerdictKey("event_not_active")).toBe(
      "doorsNotOpen",
    );
    expect(
      resolveAdmitOutcomeVerdictKey({
        outcome: "REJECTED",
        reason: "event_not_active",
      }),
    ).toBe("doorsNotOpen");
  });

  it("fails CLOSED onto STOP on an unknown rejection reason, including prototype names", () => {
    for (const bogus of ["new_reason", "constructor", "toString", "", null, undefined]) {
      expect(resolveAdmitRejectionVerdictKey(bogus), String(bogus)).toBe(
        ADMIT_REJECTION_FALLBACK_KEY,
      );
    }
    expect(ADMIT_REJECTION_FALLBACK_KEY).toBe("unrecognised");
    expect(scanVerdict(ADMIT_REJECTION_FALLBACK_KEY).word).toBe("STOP");
  });

  it("an unknown OUTCOME is not an admission and not a refusal: notRecorded", () => {
    expect(resolveAdmitOutcomeVerdictKey({ outcome: "PARTIAL" })).toBe(
      "notRecorded",
    );
  });
});

describe("the shared glyph-name table", () => {
  it("is total over the keys and names only declared glyphs", () => {
    expect(Object.keys(SCAN_GLYPHS).sort()).toEqual([...SCAN_VERDICT_KEYS].sort());
    for (const key of SCAN_VERDICT_KEYS) {
      expect(SCAN_GLYPH_IDS, key).toContain(SCAN_GLYPHS[key]);
    }
  });

  it("uses every declared glyph (no dead names)", () => {
    const used = new Set(SCAN_VERDICT_KEYS.map((k) => SCAN_GLYPHS[k]));
    expect([...used].sort()).toEqual([...SCAN_GLYPH_IDS].sort());
  });
});

describe("the shared feedback table", () => {
  it("is total, and every signature is reachable", () => {
    expect(Object.keys(VERDICT_FEEDBACK).sort()).toEqual(
      [...SCAN_VERDICT_KEYS].sort(),
    );
    const used = new Set(SCAN_VERDICT_KEYS.map((k) => VERDICT_FEEDBACK[k]));
    expect([...used].sort()).toEqual([...SCAN_FEEDBACK_KINDS].sort());
  });

  it("fires `valid` if and ONLY if the tone is `pass`", () => {
    for (const key of SCAN_VERDICT_KEYS) {
      expect(VERDICT_FEEDBACK[key] === "valid", key).toBe(
        SCAN_VERDICTS[key].tone === "pass",
      );
    }
  });
});

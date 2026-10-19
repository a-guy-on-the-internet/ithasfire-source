import { describe, expect, it } from "vitest";

import {
  MAX_VERDICT_WORD_LENGTH,
  SCAN_VERDICTS,
  TICKET_SCAN_STATUSES,
} from "@th/types";

import {
  SCAN_GLYPHS,
  presentScanResult,
  verdictStampKey,
  type ScanResultDescriptor,
} from "./scan-result-presentation";
import { describeScanResult } from "./scan-result-types";

/**
 * What an operator is TOLD, asserted rather than eyeballed.
 *
 * The tests that matter most here are the redundancy ones — "can't verify is
 * not invalid", "every outcome differs on more than colour". Both encode
 * decisions a future refactor would otherwise be free to quietly undo, and both
 * are about not making a false accusation at a door.
 *
 * They matter MORE now than they did under four tone families. With two fills,
 * eleven outcomes share the `fail` field, so the state line, the word and the
 * glyph are the entire vocabulary. Colour cannot carry any of it.
 */

const ALL: ScanResultDescriptor[] = [
  ...TICKET_SCAN_STATUSES.map((status) => ({
    kind: "ticket" as const,
    status,
  })),
  { kind: "wrong_event" },
  { kind: "unknown", reason: "malformed" },
  { kind: "unknown", reason: "ticket_not_found" },
  { kind: "unknown", reason: "signature_failed" },
  { kind: "volunteer", roleLabel: "Bar", shiftLabel: "8–11pm" },
  { kind: "offline_unverifiable", reason: "not_in_manifest" },
  { kind: "offline_unverifiable", reason: "unreadable_payload" },
  { kind: "offline_unverifiable", reason: "unrecognized_status" },
  { kind: "offline_unverifiable", reason: "lookup_failed" },
  { kind: "volunteer_needs_connection" },
];

describe("presentScanResult — the verdict table", () => {
  it("maps every ticket status to the designed key and tone", () => {
    const p = (status: string) => presentScanResult({ kind: "ticket", status });
    expect(p("VALID").key).toBe("valid");
    expect(p("VALID").tone).toBe("pass");
    expect(p("VALID").word).toBe("LET THEM IN");

    expect(p("SCANNED").key).toBe("alreadyUsed");
    expect(p("SCANNED").word).toBe("STOP");

    for (const [status, key] of [
      ["INVALID", "invalid"],
      ["REFUNDED", "refunded"],
      ["LISTED", "listed"],
      ["VOID", "voided"],
    ] as const) {
      expect(p(status).key, status).toBe(key);
      expect(p(status).tone, status).toBe("fail");
      expect(p(status).word, status).toBe("STOP");
    }
  });

  it("admits on VALID and nothing else", () => {
    for (const d of ALL) {
      const admittable = presentScanResult(d).admittable;
      const isValid = d.kind === "ticket" && d.status === "VALID";
      expect(admittable, JSON.stringify(d)).toBe(isValid);
    }
  });

  it("never says STOP for an outcome that is not the holder's fault", () => {
    // The two words the Design System does not ship, and the reason they exist.
    // A code missing from the offline manifest is not evidence the ticket is
    // bad; STOP there tells the operator to turn away a possibly-valid holder
    // because of OUR sync gap. The state line and the detail carry the nuance.
    const offline = presentScanResult({
      kind: "offline_unverifiable",
      reason: "not_in_manifest",
    });
    expect(offline.word).toBe("CHECK FIRST");
    expect(offline.state).toBe("CAN'T VERIFY OFFLINE");

    const volunteerOffline = presentScanResult({
      kind: "volunteer_needs_connection",
    });
    expect(volunteerOffline.word).toBe("USE SEARCH");
    expect(volunteerOffline.state).toBe("NEEDS SIGNAL");
  });

  it("falls closed on a status the build does not recognise", () => {
    const p = presentScanResult({ kind: "ticket", status: "TELEPORTED" });
    expect(p.key).toBe("unrecognised");
    expect(p.tone).toBe("fail");
    expect(p.admittable).toBe(false);
    // …without claiming to know WHICH kind of not-a-pass it is.
    expect(p.state).not.toBe(SCAN_VERDICTS.invalid.state);
  });
});

describe("presentScanResult — redundancy contract", () => {
  it("'can't verify offline' is NOT 'not a ticket'", () => {
    const invalid = presentScanResult({ kind: "ticket", status: "INVALID" });
    const cantVerify = presentScanResult({
      kind: "offline_unverifiable",
      reason: "not_in_manifest",
    });
    // Same FIELD (both fail — the operator should hesitate). But three of the
    // four channels MUST differ, because a cache miss is not evidence of
    // forgery and the state must never CLAIM invalidity.
    expect(cantVerify.tone).toBe(invalid.tone);
    expect(cantVerify.glyph).not.toBe(invalid.glyph);
    expect(cantVerify.state).not.toBe(invalid.state);
    expect(cantVerify.word).not.toBe(invalid.word);
    expect(cantVerify.state).not.toMatch(/invalid/i);
    // The detail DIS-claims invalidity explicitly — that clause is the safety
    // mechanism, not a softener.
    expect(cantVerify.detail ?? "").toMatch(/does not mean it's invalid/i);
    // Strip the disclaimer; nothing that remains may assert invalidity.
    expect(
      (cantVerify.detail ?? "").replace(/that does not mean it's invalid/i, ""),
    ).not.toMatch(/\binvalid\b/i);
  });

  it("never lets COLOUR alone carry the outcome", () => {
    // The real invariant, and it bites harder with two fills than four. Several
    // outcomes deliberately share a presentation because they are the same FACT
    // — `offline_unverifiable/unreadable_payload` and `unknown/malformed` are
    // both "we couldn't read this QR" — and the three "can't verify offline"
    // reasons differ only in their explanation. What must never happen is a
    // tone whose members are distinguishable ONLY by that tone.
    const stateWords = new Map<string, Set<string>>();
    const details = new Map<string, Set<string>>();
    for (const d of ALL) {
      const p = presentScanResult(d);
      const bucket = (m: Map<string, Set<string>>) =>
        m.get(p.tone) ?? m.set(p.tone, new Set()).get(p.tone)!;
      bucket(stateWords).add(`${p.state}|${p.word}`);
      bucket(details).add(p.detail ?? "");
    }
    for (const [tone, meanings] of details) {
      if (meanings.size <= 1) continue;
      expect(
        stateWords.get(tone)!.size,
        `tone "${tone}" carries ${meanings.size} distinct meanings but only ` +
          `${stateWords.get(tone)!.size} state/word pair(s) — colour is doing the work`,
      ).toBeGreaterThan(1);
    }
  });

  it("keeps key ⇄ state ⇄ word ⇄ glyph a consistent mapping", () => {
    // One key must never appear with two different words: the operator is
    // learning a vocabulary, and an inconsistent one is worse than a small one.
    for (const d of ALL) {
      const p = presentScanResult(d);
      const shared = SCAN_VERDICTS[p.key];
      expect(p.word, p.key).toBe(shared.word);
      expect(p.tone, p.key).toBe(shared.tone);
      // The state line is the shared state, uppercased, plus an optional time.
      expect(p.state, p.key).toContain(shared.state.toUpperCase());
      expect(p.glyph, p.key).toBe(SCAN_GLYPHS[p.key]);
    }
  });

  it("keeps every word short enough to read at arm's length", () => {
    for (const d of ALL) {
      const { word } = presentScanResult(d);
      expect(word.length, word).toBeLessThanOrEqual(MAX_VERDICT_WORD_LENGTH);
      expect(word, word).toBe(word.toUpperCase());
      expect(word, word).not.toMatch(/[.!?]/);
    }
  });

  it("always carries a state line — the word alone is not an outcome", () => {
    for (const d of ALL) {
      expect(presentScanResult(d).state.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("presentScanResult — copy", () => {
  it("uses the FR-008 shared LISTED string verbatim", () => {
    expect(presentScanResult({ kind: "ticket", status: "LISTED" }).detail).toBe(
      "Listed for resale — do not admit.",
    );
  });

  it("gives VALID no detail line — the ADMIT button is the copy", () => {
    expect(presentScanResult({ kind: "ticket", status: "VALID" }).detail).toBe(
      null,
    );
  });

  it("puts the scan time in the ALREADY USED line AND the state line", () => {
    // The Design System appends the time to the state line (`ALREADY USED ·
    // 8:14 PM`) — it is the fact that settles an argument with a stranger.
    const p = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      scannedAtLabel: "21:14",
    });
    expect(p.state).toBe("ALREADY USED · 21:14");
    expect(p.detail).toBe("Scanned at 21:14 — already admitted.");
  });

  it("omits the time from the state line when there is none", () => {
    expect(presentScanResult({ kind: "ticket", status: "SCANNED" }).state).toBe(
      "ALREADY USED",
    );
  });

  it("names the selected event in the wrong-event detail", () => {
    expect(
      presentScanResult({
        kind: "wrong_event",
        selectedEventName: "Basement Show",
      }).detail,
    ).toContain("Basement Show");
  });
});

describe("describeScanResult", () => {
  it("carries the offline reason through untouched", () => {
    const d = describeScanResult({
      kind: "offline_unverifiable",
      reason: "lookup_failed",
      provenance: {
        source: "offline",
        manifestSyncedAt: null,
        manifestAgeMs: null,
        stale: true,
      },
    });
    expect(d).toEqual({
      kind: "offline_unverifiable",
      reason: "lookup_failed",
    });
  });

  it("prefers an APPROVED volunteer candidate over the first one", () => {
    const candidate = (status: string, roleLabel: string) => ({
      signupId: `s-${roleLabel}`,
      humanId: "h1",
      humanDisplayName: "A",
      humanContactMasked: "",
      eventId: "e1",
      eventTitle: "E",
      roleId: "r",
      roleLabel,
      shiftId: "sh",
      shiftLabel: "8–11pm",
      shiftStartAt: "",
      shiftEndAt: "",
      status: status as "APPROVED" | "CHECKED_IN" | "NO_SHOW",
      checkedInAt: null,
      checkedInByHumanId: null,
      window: "within" as const,
      scanWindowNote: "",
      alsoHoldsTicket: false,
    });
    const d = describeScanResult({
      kind: "volunteer",
      humanId: "h1",
      displayName: "A",
      candidates: [candidate("NO_SHOW", "Door"), candidate("APPROVED", "Bar")],
      alsoHoldsTicket: [],
    });
    expect(d).toMatchObject({ kind: "volunteer", roleLabel: "Bar" });
  });
});

describe("presentScanResult — the post-admit confirmation", () => {
  /**
   * A ticket reads `SCANNED` in two very different situations, and they must
   * not look the same:
   *
   *   - this operator just admitted them → ADMITTED, the PASS field;
   *   - they were already in when the pass was presented → ALREADY USED, fail.
   *
   * The scanner re-resolves after a manual admit, so without this the operator
   * was shown the do-not-admit field moments after being told the admission
   * worked. That is a safety problem, not a cosmetic one: it teaches the
   * operator to read the fail field as "fine, carry on", which is the exact
   * reflex that lets a genuine duplicate through at 1am.
   */
  it("renders the PASS field, not the do-not-admit one", () => {
    const p = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      admitted: true,
      scannedAtLabel: "9:41 PM",
    });
    expect(p.key).toBe("admitted");
    expect(p.tone).toBe("pass");
    expect(p.word).toBe("DONE");
    expect(p.state).toBe("ADMITTED · 9:41 PM");
    expect(p.detail).toBe("Admitted at 9:41 PM.");
  });

  it("differs from a stale SCANNED on the word, the state AND the glyph", () => {
    const admitted = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      admitted: true,
    });
    const stale = presentScanResult({ kind: "ticket", status: "SCANNED" });
    expect(admitted.word).not.toBe(stale.word);
    expect(admitted.state).not.toBe(stale.state);
    expect(admitted.glyph).not.toBe(stale.glyph);
    expect(admitted.tone).not.toBe(stale.tone);
  });

  it("still refuses to mark it admittable — the admission already happened", () => {
    expect(
      presentScanResult({ kind: "ticket", status: "SCANNED", admitted: true })
        .admittable,
    ).toBe(false);
  });

  it("says so without a time when the server sent none", () => {
    expect(
      presentScanResult({ kind: "ticket", status: "SCANNED", admitted: true })
        .detail,
    ).toBe("Admission recorded.");
  });

  /**
   * `admitted` is set at the TAP, before the server answers. It is honoured
   * only on SCANNED — the status an ACCEPTED admit produces — exactly as on
   * the web. Previously VALID + admitted rendered ADMITTED / DONE, which is
   * what an admit the server REJECTED (doors closed → re-resolve VALID) or a
   * refund race (→ REFUNDED) showed: DONE, though nothing was recorded.
   */
  it.each([
    ["VALID", "valid", "pass"],
    ["REFUNDED", "refunded", "fail"],
    ["INVALID", "invalid", "fail"],
    ["VOID", "voided", "fail"],
    ["LISTED", "listed", "fail"],
  ] as const)(
    "ignores `admitted` on %s — the status stands (%s)",
    (status, key, tone) => {
      const p = presentScanResult({ kind: "ticket", status, admitted: true });
      expect(p.key).toBe(key);
      expect(p.tone).toBe(tone);
      expect(p.word).not.toBe("DONE");
    },
  );
});

describe("presentScanResult — an admit that did not become an admission", () => {
  it("REJECTED event_not_active → HOLD, not DONE", () => {
    const p = presentScanResult({
      kind: "admit_settled",
      outcome: { outcome: "REJECTED", reason: "event_not_active" },
    });
    expect(p.key).toBe("doorsNotOpen");
    expect(p.word).toBe("HOLD");
    expect(p.tone).toBe("fail");
    expect(p.detail).toMatch(/Settings/);
  });

  it("REJECTED ticket_not_valid (refund race) → STOP", () => {
    const p = presentScanResult({
      kind: "admit_settled",
      outcome: { outcome: "REJECTED", reason: "ticket_not_valid" },
    });
    expect(p.key).toBe("invalid");
    expect(p.word).toBe("STOP");
  });

  it("REJECTED event_mismatch names the selected event", () => {
    const p = presentScanResult({
      kind: "admit_settled",
      outcome: { outcome: "REJECTED", reason: "event_mismatch" },
      selectedEventName: "Door Test",
    });
    expect(p.key).toBe("wrongEvent");
    expect(p.detail).toContain("Door Test");
  });

  it("an unknown rejection reason fails closed onto STOP (ruling)", () => {
    const p = presentScanResult({
      kind: "admit_settled",
      outcome: { outcome: "REJECTED", reason: "brand_new_reason" },
    });
    expect(p.key).toBe("unrecognised");
    expect(p.word).toBe("STOP");
    expect(p.detail).not.toMatch(/try again/i);
  });

  it("REPLAY (two doors) → ALREADY USED / STOP with the ORIGINAL time", () => {
    const p = presentScanResult({
      kind: "admit_settled",
      outcome: { outcome: "REPLAY" },
      scannedAtLabel: "9:14 PM",
    });
    expect(p.key).toBe("alreadyUsed");
    expect(p.word).toBe("STOP");
    expect(p.state).toBe("ALREADY USED · 9:14 PM");
    expect(p.detail).toBe("Scanned at 9:14 PM — already admitted.");
  });
});

describe("presentScanResult — a failed round trip, by stage", () => {
  it("a LOOKUP that threw is SCAN FAILED, with the shared ServerOff glyph", () => {
    const p = presentScanResult({
      kind: "failure",
      stage: "lookup",
      detail: "Network request failed",
    });
    expect(p.key).toBe("scanFailed");
    expect(p.state).toBe("SCAN FAILED");
    expect(p.word).toBe("TRY AGAIN");
    expect(p.glyph).toBe("ServerOff");
    expect(p.detail).toBe("Network request failed");
  });

  it("a WRITE that threw is NOT RECORDED", () => {
    const p = presentScanResult({
      kind: "failure",
      stage: "record",
      detail: "Forbidden",
    });
    expect(p.key).toBe("notRecorded");
    expect(p.state).toBe("NOT RECORDED");
  });

  it("never renders an empty detail", () => {
    expect(
      presentScanResult({ kind: "failure", stage: "lookup", detail: " " })
        .detail,
    ).toMatch(/look this pass up/);
  });
});

describe("presentScanResult — an unknown-payload reason this build never heard of", () => {
  it("fails CLOSED onto STOP, not a TRY AGAIN rescan loop", () => {
    const p = presentScanResult({ kind: "unknown", reason: "brand_new_reason" });
    expect(p.key).toBe("unrecognised");
    expect(p.word).toBe("STOP");
    expect(p.detail).not.toMatch(/try again/i);
  });
});

describe("presentScanResult — the re-admit guard is VISIBLE", () => {
  const readmit = presentScanResult({
    kind: "ticket",
    status: "VALID",
    admittedHereRecently: true,
  });

  it("renders the fail field, not the PASS one", () => {
    /**
     * `planExpressMode` halts on `recently_admitted_here` — but the RESULT
     * still says `VALID` (a full manifest re-sync overwrites an optimistic
     * local SCANNED before the queue reports it), so the screen painted the
     * PASS field and the rail offered ADMIT. The guard exists for one scenario
     * — a shared or screenshotted QR presented twice inside that window — and
     * in exactly that scenario an operator trained by express to read the pass
     * field as "walk on" saw the pass field.
     */
    expect(readmit.key).toBe("admittedHere");
    expect(readmit.tone).toBe("fail");
    expect(readmit.word).toBe("STOP");
    expect(readmit.state).toBe("ADMITTED HERE");
  });

  it("is NOT admittable — which is what suppresses the rail's ADMIT", () => {
    expect(readmit.admittable).toBe(false);
  });

  it("names the DEVICE-LOCAL admit, since the status does not corroborate it", () => {
    // The operator is being told something the ticket's own status contradicts.
    // The detail has to say where the claim comes from, or it reads as a bug.
    expect(readmit.detail).toMatch(/this device/i);
  });

  it("differs from a server SCANNED on the state line and the detail", () => {
    // Same field, same word — it IS a used pass. "The server says this was
    // scanned" and "I admitted this here, minutes ago" are different facts with
    // different recoveries, and the state line is what carries that.
    const scanned = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      scannedAtLabel: "9:41 PM",
    });
    expect(readmit.state).not.toBe(scanned.state);
    expect(readmit.detail).not.toBe(scanned.detail);
  });

  it("OUTRANKS a fresh admit — a prior admission is the more conservative read", () => {
    const both = presentScanResult({
      kind: "ticket",
      status: "VALID",
      admitted: true,
      admittedHereRecently: true,
    });
    expect(both.key).toBe("admittedHere");
    expect(both.tone).toBe("fail");
  });

  it("changes NOTHING when the flag is absent or false", () => {
    const plain = presentScanResult({ kind: "ticket", status: "VALID" });
    expect(plain.tone).toBe("pass");
    expect(plain.admittable).toBe(true);
    expect(
      presentScanResult({
        kind: "ticket",
        status: "VALID",
        admittedHereRecently: false,
      }),
    ).toEqual(plain);
  });

  it("applies ONLY to VALID — any other status shows its own state line", () => {
    // Before the redesign the flag only ever applied to VALID; the redesign
    // let it outrank REFUNDED / INVALID / VOID, so the state line read
    // "ADMITTED HERE" instead of "REFUNDED". The real status is the stronger,
    // server-shaped fact.
    for (const [status, key, state] of [
      ["SCANNED", "alreadyUsed", "ALREADY USED"],
      ["INVALID", "invalid", "NOT A TICKET"],
      ["REFUNDED", "refunded", "REFUNDED"],
      ["LISTED", "listed", "LISTED FOR RESALE"],
      ["VOID", "voided", "VOIDED"],
    ] as const) {
      const p = presentScanResult({
        kind: "ticket",
        status,
        admittedHereRecently: true,
      });
      expect(p.key, status).toBe(key);
      expect(p.state, status).toBe(state);
      expect(p.tone, status).toBe("fail");
      expect(p.admittable, status).toBe(false);
    }
  });

  it("survives the descriptor round trip from a real result", () => {
    const d = describeScanResult(
      {
        kind: "ticket",
        ticketId: "tk_1",
        ticketCode: "TKT-1",
        status: "VALID",
        scannedAt: null,
        holderHumanId: "hm_1",
        holderDisplay: "Sam Rivera",
        ticketTypeName: "GA",
        alsoVolunteering: [],
      },
      { admittedHereRecently: true },
    );
    expect(presentScanResult(d).key).toBe("admittedHere");
  });

  it("carries a fresh admit through the descriptor round trip too", () => {
    const d = describeScanResult(
      {
        kind: "ticket",
        ticketId: "tk_1",
        ticketCode: "TKT-1",
        status: "SCANNED",
        scannedAt: null,
        holderHumanId: "hm_1",
        holderDisplay: "Sam Rivera",
        ticketTypeName: "GA",
        alsoVolunteering: [],
      },
      { admitted: true },
    );
    expect(presentScanResult(d).key).toBe("admitted");
  });
});

describe("verdictStampKey — the stamp's replay identity", () => {
  // Only the fields the key reads; the rest of a result is irrelevant to it.
  const ticket = (ticketCode: string) =>
    ({ kind: "ticket", ticketCode }) as Parameters<typeof verdictStampKey>[1];

  it("is verdict key + ticket code, so the same outcome on a new ticket re-stamps", () => {
    expect(verdictStampKey({ key: "valid" }, ticket("A"))).toBe("valid|A");
    expect(verdictStampKey({ key: "valid" }, ticket("A"))).not.toBe(
      verdictStampKey({ key: "valid" }, ticket("B")),
    );
  });

  it("changes when an admit lands on the same ticket", () => {
    expect(verdictStampKey({ key: "valid" }, ticket("A"))).not.toBe(
      verdictStampKey({ key: "admitted" }, ticket("A")),
    );
  });

  it("uses the result kind with no ticket code, and `error` for a failure", () => {
    expect(
      verdictStampKey({ key: "volunteer" }, { kind: "volunteer" } as Parameters<
        typeof verdictStampKey
      >[1]),
    ).toBe("volunteer|volunteer");
    expect(verdictStampKey({ key: "scanFailed" }, null)).toBe(
      "scanFailed|error",
    );
  });
});

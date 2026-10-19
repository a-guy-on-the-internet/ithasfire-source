/**
 * The outcome → verdict table, asserted in node.
 *
 * Mirrors `apps/scanner/src/lib/scan-result-presentation.test.ts`: the decision
 * of what a door operator is told is pure, so it is asserted here rather than
 * eyeballed in a browser.
 *
 * The load-bearing assertion in this file is that the tone/state/word come from
 * `@th/types`' SHARED map and not from a local table — NFR-007. Every previous
 * version of this surface owned a hand-copied table, and both copies drifted.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_VERDICT_STATE_LENGTH,
  MAX_VERDICT_WORD_LENGTH,
  SCAN_UNKNOWN_COPY,
  SCAN_VERDICTS,
  SCAN_VERDICT_KEYS,
  TICKET_SCAN_STATUSES,
  TICKET_STATUS_COPY,
  TICKET_STATUS_VERDICT,
  VERDICT_TONES,
  verdictStateLine,
} from "@th/types";
import type {
  ResolveScanPayloadOutput,
  ResolveScanPayloadVolunteerResult,
} from "@th/core/use-cases/scanning";

import { SCAN_FAILURE_COPY } from "../scan-failure-copy";
import {
  ADMIT_REJECTION_FALLBACK_KEY,
  SCAN_GLYPHS,
  actionTapDismissable,
  describeScanResult,
  planScanAction,
  planScanDetail,
  presentScanResult,
  primaryVolunteerCandidate,
  resolveAdmitRejectionVerdictKey,
  type ScanResultDescriptor,
} from "../scan-result-presentation";

// ── Fixtures ────────────────────────────────────────────────────────────────

const candidate = (
  over: Partial<ResolveScanPayloadVolunteerResult["candidates"][number]> = {},
): ResolveScanPayloadVolunteerResult["candidates"][number] => ({
  signupId: "sg_1",
  humanId: "hu_1",
  humanDisplayName: "Marisol D.",
  humanContactMasked: "m•••@example.com",
  eventId: "ev_1",
  eventTitle: "Autumn Showcase",
  roleId: "ro_1",
  roleLabel: "Door",
  shiftId: "sh_1",
  shiftLabel: "19:00–23:00",
  shiftStartAt: "2026-08-06T19:00:00.000Z",
  shiftEndAt: "2026-08-06T23:00:00.000Z",
  status: "APPROVED",
  checkedInAt: null,
  checkedInByHumanId: null,
  window: "within",
  scanWindowNote: "Shift starts in 20 minutes.",
  alsoHoldsTicket: false,
  ...over,
});

const ticketResult = (
  over: Partial<Extract<ResolveScanPayloadOutput, { kind: "ticket" }>> = {},
): ResolveScanPayloadOutput =>
  ({
    kind: "ticket",
    ticketId: "tk_id",
    ticketCode: "tk_9f3a2b7c1d4e",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hu_1",
    holderDisplay: "Marisol D.",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    ...over,
  }) as ResolveScanPayloadOutput;

const volunteerResult = (
  over: Partial<ResolveScanPayloadVolunteerResult> = {},
): ResolveScanPayloadOutput => ({
  kind: "volunteer",
  humanId: "hu_1",
  displayName: "Marisol D.",
  candidates: [candidate()],
  alsoHoldsTicket: [],
  ...over,
});

const formatTime = () => "21:14";

// ── The shared map is a real import (NFR-007) ───────────────────────────────

describe("the verdict vocabulary comes from @th/types, not from here", () => {
  it("reads tone, state and word straight out of SCAN_VERDICTS", () => {
    // The point of the shared module. If this file ever grows its own table,
    // the two surfaces drift again — which is exactly how the web came to
    // label INVALID as "Voided" while the scanner did not.
    const descriptors: Array<[ScanResultDescriptor, string]> = [
      [{ kind: "ticket", status: "VALID" }, "valid"],
      [{ kind: "ticket", status: "SCANNED" }, "alreadyUsed"],
      [{ kind: "ticket", status: "INVALID" }, "invalid"],
      [{ kind: "ticket", status: "REFUNDED" }, "refunded"],
      [{ kind: "ticket", status: "LISTED" }, "listed"],
      [{ kind: "ticket", status: "VOID" }, "voided"],
      [{ kind: "ticket", status: "TELEPORTED" }, "unrecognised"],
      [{ kind: "wrong_event" }, "wrongEvent"],
      [{ kind: "unknown", reason: "malformed" }, "unreadable"],
      [{ kind: "unknown", reason: "ticket_not_found" }, "noMatch"],
      [{ kind: "unknown", reason: "signature_failed" }, "tampered"],
      [{ kind: "volunteer" }, "volunteer"],
      [{ kind: "admitted" }, "admitted"],
      [{ kind: "failure", stage: "record", detail: "boom" }, "notRecorded"],
      [{ kind: "failure", stage: "lookup", detail: "boom" }, "scanFailed"],
      [{ kind: "unknown", reason: "wat" }, "unrecognised"],
    ];
    for (const [descriptor, key] of descriptors) {
      const p = presentScanResult(descriptor);
      const shared = SCAN_VERDICTS[key as keyof typeof SCAN_VERDICTS];
      expect(p.key, JSON.stringify(descriptor)).toBe(key);
      expect(p.tone).toBe(shared.tone);
      expect(p.word).toBe(shared.word);
      expect(p.state).toBe(verdictStateLine(p.key, null));
    }
  });

  it("resolves every ticket status through the SHARED status map", () => {
    for (const status of TICKET_SCAN_STATUSES) {
      expect(presentScanResult({ kind: "ticket", status }).key).toBe(
        TICKET_STATUS_VERDICT[status],
      );
    }
  });

  it("only ever paints one of the two shared tones", () => {
    for (const key of SCAN_VERDICT_KEYS) {
      expect(VERDICT_TONES).toContain(SCAN_VERDICTS[key].tone);
    }
    expect(VERDICT_TONES).toHaveLength(2);
  });

  it("gives every shared key a glyph — colour is never the only channel", () => {
    // Two fills carry nineteen outcomes, so the glyph stopped being a nicety: a
    // deuteranope reads amber and flame as two similar blocks.
    expect(Object.keys(SCAN_GLYPHS).sort()).toEqual([...SCAN_VERDICT_KEYS].sort());
    for (const key of SCAN_VERDICT_KEYS) {
      expect(SCAN_GLYPHS[key], key).toBeTruthy();
    }
  });
});

// ── Ticket statuses ─────────────────────────────────────────────────────────

describe("presentScanResult — ticket statuses", () => {
  it.each([
    ["VALID", "pass", "LET THEM IN", "Valid", "CheckCircle2", true],
    ["SCANNED", "fail", "STOP", "Already used", "CheckCheck", false],
    ["INVALID", "fail", "STOP", "Not a ticket", "XCircle", false],
    ["REFUNDED", "fail", "STOP", "Refunded", "CircleDollarSign", false],
    ["LISTED", "fail", "STOP", "Listed for resale", "Tag", false],
    ["VOID", "fail", "STOP", "Voided", "Ban", false],
  ])(
    "%s → %s / %s / %s",
    (status, tone, word, state, glyph, admittable) => {
      const p = presentScanResult({ kind: "ticket", status });
      expect(p.tone).toBe(tone);
      expect(p.word).toBe(word);
      expect(p.state).toBe(state.toUpperCase());
      expect(p.glyph).toBe(glyph);
      expect(p.admittable).toBe(admittable);
    },
  );

  it("covers every status the shared map knows about", () => {
    // If `@th/types` gains a seventh ticket status, this fails rather than
    // letting it fall through to the fail-closed fallback unnoticed.
    for (const status of TICKET_SCAN_STATUSES) {
      const p = presentScanResult({ kind: "ticket", status });
      expect(p.key, `${status} fell through to the unknown fallback`).not.toBe(
        "unrecognised",
      );
      expect(VERDICT_TONES).toContain(p.tone);
    }
  });

  it("reads the detail line from the shared map, not a local literal", () => {
    // The exact bug this replaces: the web labelled INVALID with VOID's copy
    // ("Voided — do not admit.") and had no copy for VOID at all.
    expect(presentScanResult({ kind: "ticket", status: "INVALID" }).detail).toBe(
      TICKET_STATUS_COPY.INVALID.guidance,
    );
    expect(presentScanResult({ kind: "ticket", status: "INVALID" }).detail).toBe(
      "Invalid ticket — do not admit.",
    );
    expect(presentScanResult({ kind: "ticket", status: "VOID" }).detail).toBe(
      "Voided — do not admit.",
    );
    expect(presentScanResult({ kind: "ticket", status: "LISTED" }).detail).toBe(
      "Listed for resale — do not admit.",
    );
  });

  it("says nothing under LET THEM IN — the ADMIT button is the copy", () => {
    expect(presentScanResult({ kind: "ticket", status: "VALID" }).detail).toBeNull();
  });

  it("appends the prior scan time to the STATE line, DS-style", () => {
    const p = presentScanResult({
      kind: "ticket",
      status: "SCANNED",
      scannedAtLabel: "21:14",
    });
    expect(p.state).toBe("ALREADY USED · 21:14");
    expect(p.detail).toBe("Scanned at 21:14 — already admitted.");
  });

  it("does NOT append a time to a state where it is not a fact", () => {
    // A VALID pass has a `scannedAt` of null; a REFUNDED one may carry a stale
    // label. "NOT A TICKET · 21:14" reads as a claim about this scan.
    expect(
      presentScanResult({
        kind: "ticket",
        status: "INVALID",
        scannedAtLabel: "21:14",
      }).state,
    ).toBe("NOT A TICKET");
  });

  it("falls CLOSED on an unrecognised status without claiming invalidity", () => {
    const p = presentScanResult({ kind: "ticket", status: "TELEPORTED" });
    expect(p.tone).toBe("fail");
    expect(p.admittable).toBe(false);
    // Its own state line and glyph: colour alone must not carry a false
    // accusation, and neither may a borrowed word.
    expect(p.key).toBe("unrecognised");
    expect(p.state).toBe("UNRECOGNISED");
    expect(p.glyph).toBe("ShieldQuestion");
    expect(p.glyph).not.toBe(
      presentScanResult({ kind: "ticket", status: "INVALID" }).glyph,
    );
  });
});

// ── Other outcomes ──────────────────────────────────────────────────────────

describe("presentScanResult — non-ticket outcomes", () => {
  it("wrong_event says STOP but names the selected event in the why", () => {
    const p = presentScanResult({
      kind: "wrong_event",
      selectedEventName: "Autumn Showcase",
    });
    expect(p.tone).toBe("fail");
    expect(p.state).toBe("WRONG EVENT");
    expect(p.word).toBe("STOP");
    expect(p.detail).toContain("Autumn Showcase");
  });

  it("wrong_event degrades to a generic line with no event title", () => {
    expect(
      presentScanResult({ kind: "wrong_event", selectedEventName: null }).detail,
    ).toBe(
      "This QR is for a different event. Dismiss to switch events, or scan a pass for the selected event.",
    );
  });

  it.each([
    ["malformed", "unreadable", "UNREADABLE", "TRY AGAIN", "HelpCircle"],
    ["ticket_not_found", "noMatch", "NO MATCH", "STOP", "SearchX"],
    ["signature_failed", "tampered", "TAMPERED", "STOP", "ShieldAlert"],
  ])("unknown/%s → %s", (reason, key, state, word, glyph) => {
    const p = presentScanResult({ kind: "unknown", reason });
    expect(p.tone).toBe("fail");
    expect(p.key).toBe(key);
    expect(p.state).toBe(state);
    expect(p.word).toBe(word);
    expect(p.glyph).toBe(glyph);
  });

  it("says TRY AGAIN, not STOP, when we could not READ the code", () => {
    // A claim about the QR, not about the holder. The recovery is another scan.
    expect(presentScanResult({ kind: "unknown", reason: "malformed" }).word).toBe(
      "TRY AGAIN",
    );
  });

  it("an unrecognised unknown-reason fails CLOSED onto STOP, like an unknown status", () => {
    // Ruling: never a TRY AGAIN rescan loop on a reason this build has never
    // heard of. Resolved through the SHARED resolver, not a local ternary.
    const p = presentScanResult({ kind: "unknown", reason: "wat" });
    expect(p.key).toBe("unrecognised");
    expect(p.word).toBe("STOP");
    expect(p.detail).not.toMatch(/try again/i);
  });

  it("a volunteer is a PASS but never admittable", () => {
    const p = presentScanResult({
      kind: "volunteer",
      roleLabel: "Door",
      shiftLabel: "19:00–23:00",
      scanWindowNote: "Shift starts in 20 minutes.",
    });
    expect(p.tone).toBe("pass");
    expect(p.state).toBe("VOLUNTEER");
    // A DIFFERENT instruction from a ticket's: check-in, not admission.
    expect(p.word).toBe("CHECK THEM IN");
    expect(p.detail).toBe("Door — 19:00–23:00. Shift starts in 20 minutes.");
    // `admittable` gates the ADMIT action; a volunteer pass is not a ticket.
    expect(p.admittable).toBe(false);
  });

  it("a volunteer with no role still carries a state and a word", () => {
    const p = presentScanResult({ kind: "volunteer" });
    expect(p.state).toBe("VOLUNTEER");
    expect(p.word).toBe("CHECK THEM IN");
  });

  it("a failed WRITE renders as a FAIL verdict, not a stray banner", () => {
    const p = presentScanResult({
      kind: "failure",
      stage: "record",
      detail: SCAN_FAILURE_COPY.offline.guidance,
      supportRef: "volunteer_scan_token_not_configured",
    });
    expect(p.tone).toBe("fail");
    expect(p.key).toBe("notRecorded");
    expect(p.state).toBe("NOT RECORDED");
    // TRY AGAIN, not STOP: nothing was recorded, and we are not claiming the
    // pass is bad.
    expect(p.word).toBe("TRY AGAIN");
    expect(p.detail).toBe(SCAN_FAILURE_COPY.offline.guidance);
  });

  it("a failed LOOKUP is SCAN FAILED, not NOT RECORDED — same as the scanner", () => {
    const p = presentScanResult({
      kind: "failure",
      stage: "lookup",
      detail: SCAN_FAILURE_COPY.offline.guidance,
    });
    expect(p.key).toBe("scanFailed");
    expect(p.state).toBe("SCAN FAILED");
    expect(p.word).toBe("TRY AGAIN");
    expect(p.glyph).toBe("ServerOff");
  });

  it("keeps a raw code as a SUPPORT ref, never as the detail line", () => {
    // The live defect: `volunteer_scan_token_not_configured` was the operator's
    // guidance on a full-bleed verdict.
    const p = presentScanResult({
      kind: "failure",
      stage: "lookup",
      detail: SCAN_FAILURE_COPY.server.guidance,
      supportRef: "volunteer_scan_token_not_configured",
    });
    expect(p.detail).not.toContain("volunteer_scan_token_not_configured");
    expect(p.supportRef).toBe("volunteer_scan_token_not_configured");
  });

  it("an empty detail still says something actionable", () => {
    expect(
      presentScanResult({ kind: "failure", stage: "record", detail: "  " })
        .detail,
    ).toBe(SCAN_FAILURE_COPY.unknown.guidance);
  });

  it("no outcome but a failure carries a support ref", () => {
    for (const descriptor of [
      { kind: "ticket", status: "VALID" },
      { kind: "ticket", status: "SCANNED" },
      { kind: "wrong_event", selectedEventName: "x" },
      { kind: "unknown", reason: "malformed" },
      { kind: "volunteer", roleLabel: "Door" },
      { kind: "admit_rejected", reason: "event_not_active" },
      { kind: "admitted" },
    ] satisfies ScanResultDescriptor[]) {
      expect(
        presentScanResult(descriptor).supportRef,
        `${descriptor.kind} leaked a support ref`,
      ).toBeNull();
    }
  });
});

// ── ADMITTED vs ALREADY USED ────────────────────────────────────────────────

/**
 * The two ways a ticket is `SCANNED`. They must never collapse together: the
 * fail tone's whole job is "stop, this pass has been used", and firing it as
 * the confirmation of a successful admission teaches an operator to read it as
 * "fine, carry on" — the reflex that lets a genuine duplicate through at 1am.
 */
describe("a SCANNED ticket means two different things", () => {
  const justAdmitted = presentScanResult({
    kind: "ticket",
    status: "SCANNED",
    scannedAtLabel: "22:10",
    admitted: true,
  });
  const alreadyUsed = presentScanResult({
    kind: "ticket",
    status: "SCANNED",
    scannedAtLabel: "22:10",
    admitted: false,
  });

  it("confirms MY admission as a PASS", () => {
    expect(justAdmitted.tone).toBe("pass");
    expect(justAdmitted.key).toBe("admitted");
    expect(justAdmitted.state).toBe("ADMITTED · 22:10");
    expect(justAdmitted.word).toBe("DONE");
    expect(justAdmitted.detail).toBe("Admitted at 22:10.");
  });

  it("warns about SOMEONE ELSE'S admission as a FAIL", () => {
    expect(alreadyUsed.tone).toBe("fail");
    expect(alreadyUsed.key).toBe("alreadyUsed");
    expect(alreadyUsed.state).toBe("ALREADY USED · 22:10");
    expect(alreadyUsed.word).toBe("STOP");
    expect(alreadyUsed.detail).toBe("Scanned at 22:10 — already admitted.");
  });

  it("separates them on EVERY channel — tone, state, word and glyph", () => {
    expect(justAdmitted.tone).not.toBe(alreadyUsed.tone);
    expect(justAdmitted.state).not.toBe(alreadyUsed.state);
    expect(justAdmitted.word).not.toBe(alreadyUsed.word);
    expect(justAdmitted.glyph).not.toBe(alreadyUsed.glyph);
  });

  it("keeps DONE distinct from LET THEM IN too", () => {
    // Same tone, opposite sides of the action: "let this person in" vs "this
    // person is in". Same fill, so the other channels have to carry it.
    const valid = presentScanResult({ kind: "ticket", status: "VALID" });
    expect(justAdmitted.tone).toBe(valid.tone);
    expect(justAdmitted.word).not.toBe(valid.word);
    expect(justAdmitted.state).not.toBe(valid.state);
    expect(justAdmitted.glyph).not.toBe(valid.glyph);
  });

  it("never offers ADMIT again on either of them", () => {
    expect(justAdmitted.admittable).toBe(false);
    expect(alreadyUsed.admittable).toBe(false);
  });

  it("degrades to a timeless sentence rather than 'Admitted at null'", () => {
    expect(
      presentScanResult({ kind: "ticket", status: "SCANNED", admitted: true })
        .detail,
    ).toBe("Admission recorded.");
  });

  it("only ADMITTED wears the door glyph, on either descriptor shape", () => {
    // The standalone `{kind:"admitted"}` fallback and the flagged ticket must
    // present identically — one shared key, not two tables to drift.
    const fallback = presentScanResult({ kind: "admitted" });
    expect(fallback.key).toBe(justAdmitted.key);
    expect(fallback.tone).toBe(justAdmitted.tone);
    expect(fallback.word).toBe(justAdmitted.word);
    expect(fallback.glyph).toBe(justAdmitted.glyph);
  });
});

// ── A rejected admit (a 200, not a throw) ───────────────────────────────────

describe("presentScanResult — admit rejections", () => {
  it.each([
    ["ticket_not_found", "noMatch", "NO MATCH", "STOP", "SearchX"],
    ["ticket_not_valid", "invalid", "NOT A TICKET", "STOP", "XCircle"],
    ["event_mismatch", "wrongEvent", "WRONG EVENT", "STOP", "CalendarX2"],
    ["event_not_active", "doorsNotOpen", "DOORS NOT OPEN", "HOLD", "Clock"],
  ])("%s → %s", (reason, key, state, word, glyph) => {
    const p = presentScanResult({ kind: "admit_rejected", reason });
    expect(p.key).toBe(key);
    expect(p.tone).toBe("fail");
    expect(p.state).toBe(state);
    expect(p.word).toBe(word);
    expect(p.glyph).toBe(glyph);
    expect(p.admittable).toBe(false);
    expect(p.detail?.length).toBeGreaterThan(0);
  });

  it("maps the four server reasons onto SHARED keys, not local rows", () => {
    expect(resolveAdmitRejectionVerdictKey("ticket_not_found")).toBe("noMatch");
    expect(resolveAdmitRejectionVerdictKey("ticket_not_valid")).toBe("invalid");
    expect(resolveAdmitRejectionVerdictKey("event_mismatch")).toBe("wrongEvent");
    expect(resolveAdmitRejectionVerdictKey("event_not_active")).toBe(
      "doorsNotOpen",
    );
  });

  it("reuses the SHARED copy where the server really is talking about the ticket", () => {
    expect(
      presentScanResult({ kind: "admit_rejected", reason: "ticket_not_found" })
        .detail,
    ).toBe(SCAN_UNKNOWN_COPY.ticket_not_found.guidance);
    expect(
      presentScanResult({ kind: "admit_rejected", reason: "ticket_not_valid" })
        .detail,
    ).toBe(TICKET_STATUS_COPY.INVALID.guidance);
  });

  it("says HOLD, not STOP, when the DOOR is shut", () => {
    // The reason an operator could otherwise tap ADMIT forever: `scanTicket`
    // enforces the check-in window, `resolveScanPayload` does not, so the card
    // read a pass and every tap silently did nothing. Nothing is wrong with the
    // person — STOP would send a legitimate holder away.
    const p = presentScanResult({
      kind: "admit_rejected",
      reason: "event_not_active",
    });
    expect(p.word).toBe("HOLD");
    expect(p.detail).toContain("check-in");
  });

  it("fails CLOSED on a reason it has never heard of", () => {
    const p = presentScanResult({ kind: "admit_rejected", reason: "wat" });
    expect(p.key).toBe(ADMIT_REJECTION_FALLBACK_KEY);
    // Ruling: an unknown rejection reason fails closed onto STOP, the same
    // key as an unknown status or resolve reason — never a TRY AGAIN loop
    // against a server that keeps refusing.
    expect(p.key).toBe("unrecognised");
    expect(p.tone).toBe("fail");
    expect(p.word).toBe("STOP");
    expect(p.detail).not.toMatch(/try again/i);
    // Still not `invalid`'s channels: no accusation the server never made.
    expect(p.glyph).not.toBe(
      presentScanResult({ kind: "ticket", status: "INVALID" }).glyph,
    );
  });

  it("covers every reason the server can actually send", () => {
    // Mirrors `scanTicketOutputSchema`'s REJECTED reason enum
    // (packages/core/src/use-cases/tickets/scan-ticket.ts). A new server reason
    // fails here rather than silently landing on the fallback.
    for (const reason of [
      "ticket_not_found",
      "event_not_active",
      "event_mismatch",
      "ticket_not_valid",
    ]) {
      expect(
        presentScanResult({ kind: "admit_rejected", reason }).key,
        `${reason} fell through to the fallback`,
      ).not.toBe(ADMIT_REJECTION_FALLBACK_KEY);
    }
  });
});

// ── The two type lines fit the smallest phone ───────────────────────────────

describe("state and word fit the smallest phone", () => {
  const descriptors: ScanResultDescriptor[] = [
    ...TICKET_SCAN_STATUSES.map((status) => ({ kind: "ticket" as const, status })),
    { kind: "ticket", status: "SOMETHING_NEW" },
    { kind: "ticket", status: "SCANNED", admitted: true },
    { kind: "wrong_event", selectedEventName: "x" },
    { kind: "unknown", reason: "malformed" },
    { kind: "unknown", reason: "ticket_not_found" },
    { kind: "unknown", reason: "signature_failed" },
    { kind: "volunteer", roleLabel: "Door", shiftLabel: "19–23" },
    { kind: "failure", stage: "record", detail: "boom" },
    { kind: "failure", stage: "lookup", detail: "boom" },
    { kind: "admit_rejected", reason: "ticket_not_found" },
    { kind: "admit_rejected", reason: "event_not_active" },
    { kind: "admit_rejected", reason: "event_mismatch" },
    { kind: "admit_rejected", reason: "ticket_not_valid" },
    { kind: "admit_rejected", reason: "wat" },
    { kind: "admitted" },
  ];

  it.each(descriptors.map((d) => [JSON.stringify(d), d] as const))(
    "%s",
    (_label, descriptor) => {
      const p = presentScanResult(descriptor);
      // The word is set at the display rung; a longer one stops being readable
      // at arm's length in 300ms. The state shares its line with a time.
      expect(p.word.length).toBeLessThanOrEqual(MAX_VERDICT_WORD_LENGTH);
      expect(p.word).toBe(p.word.toUpperCase());
      expect(p.state.length).toBeGreaterThan(0);
      expect(p.state.split(" · ")[0]!.length).toBeLessThanOrEqual(
        MAX_VERDICT_STATE_LENGTH,
      );
      expect(p.state).toBe(p.state.toUpperCase());
    },
  );
});

// ── describeScanResult ──────────────────────────────────────────────────────

describe("describeScanResult", () => {
  it("formats the prior scan time through the injected formatter", () => {
    const d = describeScanResult(
      ticketResult({ status: "SCANNED", scannedAt: new Date("2026-08-06T21:14:00Z") }),
      { formatTime, selectedEventName: null },
    );
    expect(d).toEqual({
      kind: "ticket",
      status: "SCANNED",
      scannedAtLabel: "21:14",
      // A resolve can never know who admitted the ticket: `admitted` is only
      // ever true straight off an ACCEPTED `scanTicket`.
      admitted: false,
    });
  });

  it("leaves the scan label null when the ticket has never been scanned", () => {
    const d = describeScanResult(ticketResult(), { formatTime });
    expect(d).toMatchObject({ kind: "ticket", scannedAtLabel: null });
  });

  it("describes a volunteer from the APPROVED candidate, not the first row", () => {
    const d = describeScanResult(
      volunteerResult({
        candidates: [
          candidate({ signupId: "sg_old", status: "NO_SHOW", roleLabel: "Bar" }),
          candidate({ signupId: "sg_now", status: "APPROVED", roleLabel: "Door" }),
        ],
      }),
      { formatTime },
    );
    expect(d).toMatchObject({ kind: "volunteer", roleLabel: "Door" });
  });

  it("passes the selected event name through for wrong_event", () => {
    const d = describeScanResult(
      { kind: "wrong_event", payloadKind: "ticket", scannedEventId: "ev_2" },
      { formatTime, selectedEventName: "Autumn Showcase" },
    );
    expect(d).toEqual({
      kind: "wrong_event",
      selectedEventName: "Autumn Showcase",
    });
  });
});

// ── Actions + dismiss semantics ─────────────────────────────────────────────

describe("planScanAction", () => {
  it("offers ADMIT for a VALID ticket, keyed on the ticket code", () => {
    expect(
      planScanAction({
        result: ticketResult(),
        admittable: true,
        canCheckInVolunteer: true,
      }),
    ).toEqual({ kind: "admit", ticketCode: "tk_9f3a2b7c1d4e" });
  });

  it("never offers ADMIT for a non-admittable ticket", () => {
    expect(
      planScanAction({
        result: ticketResult({ status: "REFUNDED" }),
        admittable: false,
        canCheckInVolunteer: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("offers CHECK IN for an APPROVED volunteer", () => {
    expect(
      planScanAction({
        result: volunteerResult(),
        admittable: false,
        canCheckInVolunteer: true,
      }),
    ).toEqual({ kind: "check-in", signupId: "sg_1", locked: false });
  });

  it("locks — rather than hides — check-in for an operator without the role", () => {
    // A SCANNER-role operator must still read "this is the action, and it is
    // not yours" instead of finding no button at all.
    expect(
      planScanAction({
        result: volunteerResult(),
        admittable: false,
        canCheckInVolunteer: false,
      }),
    ).toMatchObject({ kind: "check-in", locked: true });
  });

  it("falls back to dismiss when no candidate can be checked in", () => {
    expect(
      planScanAction({
        result: volunteerResult({
          candidates: [candidate({ status: "CHECKED_IN" })],
        }),
        admittable: false,
        canCheckInVolunteer: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("dismisses for the error state (no result at all)", () => {
    expect(
      planScanAction({
        result: null,
        admittable: false,
        canCheckInVolunteer: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });
});

describe("actionTapDismissable", () => {
  it("refuses tap-to-dismiss on ADMIT — a tap would silently skip an admission", () => {
    expect(actionTapDismissable({ kind: "admit", ticketCode: "x" })).toBe(false);
  });

  it("allows it everywhere else", () => {
    expect(actionTapDismissable({ kind: "dismiss" })).toBe(true);
    expect(
      actionTapDismissable({ kind: "check-in", signupId: "s", locked: false }),
    ).toBe(true);
  });
});

// ── Detail plan ─────────────────────────────────────────────────────────────

describe("planScanDetail — the `!!children` regression guard", () => {
  it("gives a plain FAIL verdict NO detail band", () => {
    // Phase A shipped `hasDetail = !!children`, which is always true because a
    // React element is truthy even when the component returns null. Ten of
    // eleven states grew an empty band cut into the tone fill.
    for (const status of ["INVALID", "REFUNDED", "LISTED"] as const) {
      expect(planScanDetail(ticketResult({ status })).hasDetail).toBe(false);
    }
    expect(
      planScanDetail({ kind: "unknown", reason: "malformed" }).hasDetail,
    ).toBe(false);
    expect(
      planScanDetail({
        kind: "wrong_event",
        payloadKind: "ticket",
        scannedEventId: "ev_2",
      }).hasDetail,
    ).toBe(false);
    expect(planScanDetail(null).hasDetail).toBe(false);
  });

  it("gives a ticket detail only when it has cross-context rows", () => {
    expect(planScanDetail(ticketResult()).hasDetail).toBe(false);
    const withVolunteering = planScanDetail(
      ticketResult({ alsoVolunteering: [candidate()] }),
    );
    expect(withVolunteering.hasDetail).toBe(true);
    expect(withVolunteering.alsoVolunteeringCount).toBe(1);
  });

  it("always gives a volunteer detail — even with no eligible signups", () => {
    const empty = planScanDetail(volunteerResult({ candidates: [] }));
    expect(empty.hasDetail).toBe(true);
    expect(empty.isVolunteer).toBe(true);
  });

  it("counts the volunteer's other tickets", () => {
    const plan = planScanDetail(
      volunteerResult({
        alsoHoldsTicket: [
          {
            ticketId: "t1",
            ticketCode: "tk_a",
            status: "VALID",
            scannedAt: null,
          },
        ],
      }),
    );
    expect(plan.alsoHoldsTicketCount).toBe(1);
  });
});

describe("primaryVolunteerCandidate", () => {
  it("prefers the APPROVED signup", () => {
    const result = volunteerResult({
      candidates: [
        candidate({ signupId: "a", status: "NO_SHOW" }),
        candidate({ signupId: "b", status: "APPROVED" }),
      ],
    }) as ResolveScanPayloadVolunteerResult;
    expect(primaryVolunteerCandidate(result)?.signupId).toBe("b");
  });

  it("returns null when there are no candidates", () => {
    const result = volunteerResult({
      candidates: [],
    }) as ResolveScanPayloadVolunteerResult;
    expect(primaryVolunteerCandidate(result)).toBeNull();
  });
});

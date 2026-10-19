/**
 * FR-014 — the tallies an organizer quotes. These are claims a venue makes to a
 * promoter, so every rule that moves either number is asserted.
 */
import { describe, expect, it } from "vitest";

import type { ResolveScanPayloadOutput } from "@th/core/use-cases/scanning";

import {
  EMPTY_SCAN_SESSION_TALLY,
  tallyAdmitOutcome,
  tallyResolvedResult,
} from "../scan-session-tally";

const ticket = (
  over: Record<string, unknown> = {},
): ResolveScanPayloadOutput =>
  ({
    kind: "ticket",
    ticketId: "id",
    ticketCode: "tk_a",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hu",
    holderDisplay: "Marisol D.",
    ticketTypeName: null,
    alsoVolunteering: [],
    ...over,
  }) as ResolveScanPayloadOutput;

describe("admitted", () => {
  it("counts one admission per ACCEPTED outcome", () => {
    let t = EMPTY_SCAN_SESSION_TALLY;
    t = tallyAdmitOutcome(t, { outcome: "ACCEPTED" }, "tk_a");
    t = tallyAdmitOutcome(t, { outcome: "ACCEPTED" }, "tk_b");
    expect(t.admitted).toBe(2);
    expect(t.alreadyIn).toBe(0);
  });

  it("counts nothing for a REJECTED admit", () => {
    // A refusal admitted nobody and is not a repeat. Counting it either way
    // would be a lie in a number the venue quotes.
    const t = tallyAdmitOutcome(
      EMPTY_SCAN_SESSION_TALLY,
      { outcome: "REJECTED" },
      "tk_a",
    );
    expect(t).toEqual(EMPTY_SCAN_SESSION_TALLY);
  });

  it("never counts a resolve as an admission", () => {
    // The whole bug in the counter this replaces.
    const t = tallyResolvedResult(EMPTY_SCAN_SESSION_TALLY, ticket());
    expect(t.admitted).toBe(0);
  });

  it("counts nothing for wrong-event, unknown or volunteer resolves", () => {
    let t = EMPTY_SCAN_SESSION_TALLY;
    t = tallyResolvedResult(t, {
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: "ev",
    });
    t = tallyResolvedResult(t, { kind: "unknown", reason: "malformed" });
    t = tallyResolvedResult(t, {
      kind: "volunteer",
      humanId: "hu",
      displayName: "Marisol D.",
      candidates: [],
      alsoHoldsTicket: [],
    });
    expect(t).toEqual(EMPTY_SCAN_SESSION_TALLY);
  });
});

describe("alreadyIn", () => {
  it("counts a used pass being presented again", () => {
    const t = tallyResolvedResult(
      EMPTY_SCAN_SESSION_TALLY,
      ticket({ status: "SCANNED" }),
    );
    expect(t.alreadyIn).toBe(1);
  });

  it("counts one distinct pass once, however many times it is read", () => {
    let t = EMPTY_SCAN_SESSION_TALLY;
    for (let i = 0; i < 4; i++) {
      t = tallyResolvedResult(t, ticket({ status: "SCANNED" }));
    }
    expect(t.alreadyIn).toBe(1);
    expect(t.countedRepeats).toEqual(["tk_a"]);
  });

  it("counts different passes separately", () => {
    let t = tallyResolvedResult(
      EMPTY_SCAN_SESSION_TALLY,
      ticket({ status: "SCANNED" }),
    );
    t = tallyResolvedResult(t, ticket({ ticketCode: "tk_b", status: "SCANNED" }));
    expect(t.alreadyIn).toBe(2);
  });

  it("does NOT count an admission as a repeat — nothing re-resolves it", () => {
    // There is no post-admit re-resolve any more: the SCANNED card is derived
    // from the admit response (`scan-admit-outcome.ts`), so the resolve path is
    // never handed the admission we just made and the old `countRepeat: false`
    // opt-out has no caller left.
    const t = tallyAdmitOutcome(
      EMPTY_SCAN_SESSION_TALLY,
      { outcome: "ACCEPTED" },
      "tk_a",
    );
    expect(t.admitted).toBe(1);
    expect(t.alreadyIn).toBe(0);
  });

  it("still counts that pass if it comes back LATER in the session", () => {
    let t = tallyAdmitOutcome(
      EMPTY_SCAN_SESSION_TALLY,
      { outcome: "ACCEPTED" },
      "tk_a",
    );
    // …someone presents the same pass at the door again.
    t = tallyResolvedResult(t, ticket({ status: "SCANNED" }));
    expect(t.admitted).toBe(1);
    expect(t.alreadyIn).toBe(1);
  });

  it("counts ONE admission however many times ADMIT is tapped", () => {
    // `scanTicket`'s idempotency window is 10s, so a double tap replays the
    // cached ACCEPTED verbatim. A ticket can only be admitted once, so a second
    // ACCEPTED for one code is never a second person through the door — and the
    // admitted count is a number a venue quotes to a promoter.
    let t = tallyAdmitOutcome(
      EMPTY_SCAN_SESSION_TALLY,
      { outcome: "ACCEPTED" },
      "tk_a",
    );
    t = tallyAdmitOutcome(t, { outcome: "ACCEPTED" }, "tk_a");
    t = tallyAdmitOutcome(t, { outcome: "ACCEPTED" }, "tk_a");
    expect(t.admitted).toBe(1);

    // A DIFFERENT ticket is a different person.
    t = tallyAdmitOutcome(t, { outcome: "ACCEPTED" }, "tk_b");
    expect(t.admitted).toBe(2);
  });

  it("counts a REPLAY admit, deduped against the resolve path", () => {
    let t = tallyResolvedResult(
      EMPTY_SCAN_SESSION_TALLY,
      ticket({ status: "SCANNED" }),
    );
    t = tallyAdmitOutcome(t, { outcome: "REPLAY" }, "tk_a");
    expect(t.alreadyIn).toBe(1);
  });
});

describe("immutability", () => {
  it("never mutates the tally it is given", () => {
    const start = EMPTY_SCAN_SESSION_TALLY;
    tallyAdmitOutcome(start, { outcome: "ACCEPTED" }, "tk_a");
    tallyResolvedResult(start, ticket({ status: "SCANNED" }));
    expect(start).toEqual({
      admitted: 0,
      alreadyIn: 0,
      countedAdmits: [],
      countedRepeats: [],
    });
  });
});

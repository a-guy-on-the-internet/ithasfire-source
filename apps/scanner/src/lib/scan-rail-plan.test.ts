import { describe, expect, it } from "vitest";

import {
  planScanRail,
  railHoldable,
  railTapDismissable,
  type ScanRailExpressState,
  type ScanRailPlan,
} from "./scan-rail-plan";
import type {
  AnyScanResult,
  Candidate,
  TicketResult,
  VolunteerResult,
} from "./scan-result-types";

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  signupId: "sg_1",
  humanId: "hm_1",
  humanDisplayName: "Marisol Delgado-Rivera",
  humanContactMasked: "m•••@example.com",
  eventId: "ev_1",
  eventTitle: "Door Test",
  roleId: "rl_1",
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

const volunteer = (candidates: Candidate[]): VolunteerResult => ({
  kind: "volunteer",
  humanId: "hm_1",
  displayName: "Marisol Delgado-Rivera",
  candidates,
  alsoHoldsTicket: [],
});

const ticket = (status: TicketResult["status"]): TicketResult => ({
  kind: "ticket",
  ticketId: "tk_1",
  ticketCode: "TKT-DOOR-0001",
  status,
  scannedAt: null,
  holderHumanId: "hm_2",
  holderDisplay: "Sam Rivera",
  ticketTypeName: "General Admission",
  alsoVolunteering: [],
});

const plan = (result: AnyScanResult, over: Partial<{
  admittable: boolean;
  canCheckInVolunteer: boolean;
  express: ScanRailExpressState | null;
}> = {}) =>
  planScanRail({
    result,
    admittable: over.admittable ?? false,
    canCheckInVolunteer: over.canCheckInVolunteer ?? true,
    express: over.express ?? null,
  });

const express = (
  over: Partial<ScanRailExpressState> = {},
): ScanRailExpressState => ({
  autoAdmit: true,
  autoDismiss: true,
  undoRefused: false,
  ...over,
});

describe("planScanRail", () => {
  it("offers ADMIT for a ticket the presenter called admittable", () => {
    expect(plan(ticket("VALID"), { admittable: true })).toEqual({
      kind: "admit",
      ticketCode: "TKT-DOOR-0001",
    });
  });

  it("offers CHECK IN for a volunteer with an APPROVED signup", () => {
    // The regression: volunteers are `admittable: false` BY DESIGN (only a
    // literal ticket VALID is admittable), so a rail keyed on `admittable`
    // alone sent every volunteer to "Dismiss and scan next" — stranding the
    // only action available below the fold, behind a gesture whose rail
    // button dismissed the result.
    expect(plan(volunteer([candidate()]))).toEqual({
      kind: "check-in",
      signupId: "sg_1",
      locked: false,
    });
  });

  it("prefers the APPROVED signup when several are present", () => {
    const result = plan(
      volunteer([
        candidate({ signupId: "sg_old", status: "NO_SHOW" }),
        candidate({ signupId: "sg_now", status: "APPROVED" }),
      ]),
    );
    expect(result).toEqual({
      kind: "check-in",
      signupId: "sg_now",
      locked: false,
    });
  });

  it("LOCKS rather than hides the action for a SCANNER-role operator", () => {
    // `locked` keeps the primary-action framing with an explanatory hint. A
    // missing button reads as "this volunteer has no action", which is a
    // different and wrong story.
    expect(plan(volunteer([candidate()]), { canCheckInVolunteer: false })).toEqual(
      { kind: "check-in", signupId: "sg_1", locked: true },
    );
  });

  it("falls back to DISMISS when no signup is APPROVED", () => {
    // CHECKED_IN / NO_SHOW have no server-side action — offering a button the
    // server would reject is worse than offering none.
    expect(plan(volunteer([candidate({ status: "CHECKED_IN" })]))).toEqual({
      kind: "dismiss",
    });
    expect(plan(volunteer([]))).toEqual({ kind: "dismiss" });
  });

  it("DISMISSES every terminal ticket state", () => {
    for (const status of ["SCANNED", "INVALID", "REFUNDED", "LISTED", "VOID"] as const) {
      expect(plan(ticket(status))).toEqual({ kind: "dismiss" });
    }
  });

  it("DISMISSES wrong_event, unknown and the offline-only states", () => {
    expect(
      plan({ kind: "wrong_event", payloadKind: "ticket", scannedEventId: "ev_2" }),
    ).toEqual({ kind: "dismiss" });
    expect(plan({ kind: "unknown", reason: "malformed" })).toEqual({
      kind: "dismiss",
    });
    expect(
      plan({
        kind: "offline_unverifiable",
        reason: "not_in_manifest",
        provenance: {
          source: "offline",
          manifestSyncedAt: 0,
          manifestAgeMs: 0,
          stale: false,
        },
      }),
    ).toEqual({ kind: "dismiss" });
    expect(
      plan({
        kind: "volunteer_needs_connection",
        provenance: {
          source: "offline",
          manifestSyncedAt: null,
          manifestAgeMs: null,
          stale: true,
        },
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("never offers ADMIT when the presenter said the ticket is not admittable", () => {
    // The rail and the state read ONE presentation object; this asserts the
    // rail cannot second-guess it into an "ADMIT under a red screen".
    expect(plan(ticket("VALID"), { admittable: false })).toEqual({
      kind: "dismiss",
    });
  });
});

describe("planScanRail — express (FR-004 / NFR-002)", () => {
  it("offers UNDO alone while a dwell is running", () => {
    expect(
      plan(ticket("VALID"), { admittable: true, express: express() }),
    ).toEqual({ kind: "express-undo" });
  });

  it("BLOCKER 1: adds DISMISS when a screen reader suspended auto-dismiss", () => {
    // With `autoDismiss: false` (NFR-002) no dwell will ever fire. The shipped
    // rail rendered the express branch anyway — whose only control is UNDO —
    // while tap-to-dismiss was withheld because VALID *is* admittable. Nothing
    // on the screen could clear the state; the only exits were the TopBar back
    // button and a tab round-trip that remounts the screen. Per scan. For every
    // VoiceOver/TalkBack operator.
    expect(
      plan(ticket("VALID"), {
        admittable: true,
        express: express({ autoDismiss: false }),
      }),
    ).toEqual({ kind: "express-undo-with-dismiss" });
  });

  it("BLOCKER 2: a refused UNDO never falls back to ADMIT", () => {
    // The shipped handler did `setExpressPlan(null)` on refusal, which React 18
    // batched with the notice — the rail moved to `admit`, putting a second
    // admission under the thumb one frame after the operator failed to revert
    // the first one.
    for (const autoDismiss of [true, false]) {
      expect(
        plan(ticket("VALID"), {
          admittable: true,
          express: express({ autoDismiss, undoRefused: true }),
        }),
      ).toEqual({ kind: "refused" });
    }
  });

  it("ignores a halted express plan entirely", () => {
    // `autoAdmit: false` means express did NOT admit — the manual rail applies,
    // including for the re-admit guard's halt (which the presenter renders as
    // ALREADY IN, hence `admittable: false`).
    expect(
      plan(ticket("VALID"), {
        admittable: true,
        express: express({ autoAdmit: false }),
      }),
    ).toEqual({ kind: "admit", ticketCode: "TKT-DOOR-0001" });
    expect(
      plan(ticket("VALID"), {
        admittable: false,
        express: express({ autoAdmit: false }),
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("express outranks the volunteer row (a volunteer can never auto-admit)", () => {
    // Defence in depth: `planExpressMode` halts on `not_a_ticket`, so this
    // combination is unreachable — but if it ever became reachable, the rail
    // must not offer CHECK IN under a state that already admitted someone.
    expect(plan(volunteer([candidate()]), { express: express() })).toEqual({
      kind: "express-undo",
    });
  });
});

describe("railTapDismissable / railHoldable", () => {
  it("withholds tap-to-dismiss ONLY where a tap would destroy something", () => {
    // `admit`: a tap silently skips an admission (design §2.4).
    expect(railTapDismissable({ kind: "admit", ticketCode: "X" })).toBe(false);
    // `express-undo`: the dwell owns the exit and the block is the hold target.
    expect(railTapDismissable({ kind: "express-undo" })).toBe(false);
  });

  it("ALLOWS tap-to-dismiss everywhere else, including both express exits", () => {
    // The admission has already happened in both express cases, so §2.4's
    // "a tap silently skips an admission" hazard does not exist.
    expect(railTapDismissable({ kind: "express-undo-with-dismiss" })).toBe(true);
    expect(railTapDismissable({ kind: "refused" })).toBe(true);
    expect(railTapDismissable({ kind: "dismiss" })).toBe(true);
    expect(
      railTapDismissable({ kind: "check-in", signupId: "sg_1", locked: false }),
    ).toBe(true);
  });

  it("offers press-and-hold only while a dwell is actually running", () => {
    expect(railHoldable({ kind: "express-undo" })).toBe(true);
    for (const p of [
      { kind: "express-undo-with-dismiss" },
      { kind: "refused" },
      { kind: "dismiss" },
      { kind: "admit", ticketCode: "X" },
      { kind: "check-in", signupId: "sg_1", locked: false },
    ] as const) {
      expect(railHoldable(p)).toBe(false);
    }
  });

  it("EVERY kind has a named way out (adding one without an exit is a type error)", () => {
    /**
     * The invariant blocker 1 violated: a result state the operator cannot
     * clear. Each kind must declare its exit, and the `Record` makes a new kind
     * with no entry fail to compile — which is the only kind of guard that
     * would have caught `express-undo-with-dismiss` not existing.
     */
    const EXITS: Record<
      ScanRailPlan["kind"],
      "tap" | "dwell" | "rail-secondary"
    > = {
      // ADMIT + SKIP: SKIP is the exit; a tap is withheld on purpose.
      admit: "rail-secondary",
      "check-in": "tap",
      dismiss: "tap",
      // The only kind with neither a tap nor a dismiss button — and the only
      // kind whose dwell clears the state on its own.
      "express-undo": "dwell",
      "express-undo-with-dismiss": "tap",
      refused: "tap",
    };

    const sample: Record<ScanRailPlan["kind"], ScanRailPlan> = {
      admit: { kind: "admit", ticketCode: "X" },
      "check-in": { kind: "check-in", signupId: "sg_1", locked: false },
      dismiss: { kind: "dismiss" },
      "express-undo": { kind: "express-undo" },
      "express-undo-with-dismiss": { kind: "express-undo-with-dismiss" },
      refused: { kind: "refused" },
    };

    for (const [kind, exit] of Object.entries(EXITS)) {
      const plan = sample[kind as ScanRailPlan["kind"]];
      // "tap" is the only exit this module itself can prove.
      expect(railTapDismissable(plan)).toBe(exit === "tap");
      // And a dwell exists exactly where the block is holdable.
      expect(railHoldable(plan)).toBe(exit === "dwell");
    }
  });
});

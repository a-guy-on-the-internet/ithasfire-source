import { describe, expect, it } from "vitest";

import { planResultDetail } from "./result-detail-plan";
import { presentScanResult } from "./scan-result-presentation";
import type { ScanResultDescriptor } from "./scan-result-presentation";

/**
 * The regression this file exists for: `ToneResultState` derived "is there
 * detail?" from `!!children`, the host always passed a `<ResultDetail/>`
 * element, and a React element is truthy even when the component renders
 * `null`. Ten of the eleven states therefore grew a `surface`-coloured band
 * and a 44pt "⌄ MORE" row pointing at an empty panel — and 260 green tests
 * saw none of it, because every one of them was a pure-function test of a
 * module that had no say in the matter.
 */

/** The eleven design states, as `presentScanResult` descriptors. */
const STATES: Array<{ label: string; descriptor: ScanResultDescriptor }> = [
  { label: "1 VALID", descriptor: { kind: "ticket", status: "VALID" } },
  { label: "2 SCANNED", descriptor: { kind: "ticket", status: "SCANNED" } },
  { label: "3 REFUNDED", descriptor: { kind: "ticket", status: "REFUNDED" } },
  { label: "4 VOID", descriptor: { kind: "ticket", status: "VOID" } },
  { label: "5 LISTED", descriptor: { kind: "ticket", status: "LISTED" } },
  { label: "6 INVALID", descriptor: { kind: "ticket", status: "INVALID" } },
  { label: "7 wrong_event", descriptor: { kind: "wrong_event" } },
  { label: "8 malformed", descriptor: { kind: "unknown", reason: "malformed" } },
  {
    label: "8b ticket_not_found",
    descriptor: { kind: "unknown", reason: "ticket_not_found" },
  },
  {
    label: "8c signature_failed",
    descriptor: { kind: "unknown", reason: "signature_failed" },
  },
  { label: "9 volunteer", descriptor: { kind: "volunteer" } },
  {
    label: "10 volunteer offline",
    descriptor: { kind: "volunteer_needs_connection" },
  },
  {
    label: "11 not in manifest",
    descriptor: { kind: "offline_unverifiable", reason: "not_in_manifest" },
  },
];

/** A bare result: nothing extra to show below the fold. */
const bare = (descriptor: ScanResultDescriptor) =>
  planResultDetail({
    kind: descriptor.kind,
    admittable: presentScanResult(descriptor).admittable,
    showAdmitAction: false,
    status: descriptor.kind === "ticket" ? descriptor.status : null,
  });

describe("planResultDetail — the '⌄ MORE' affordance", () => {
  it.each(STATES.filter((s) => s.descriptor.kind !== "volunteer"))(
    "$label has NO detail when there is nothing to put there",
    ({ descriptor }) => {
      expect(bare(descriptor).hasDetail).toBe(false);
    },
  );

  it("a volunteer ALWAYS has detail", () => {
    // Candidate row, scan-window note, check-in time, `alsoHoldsTicket` — and
    // even the empty case says "No eligible signups for this event.", which
    // appears nowhere else on the screen.
    expect(bare({ kind: "volunteer" }).hasDetail).toBe(true);
  });

  it("VALID with same-order tickets HAS detail (the bulk-admit block)", () => {
    const plan = planResultDetail({
      kind: "ticket",
      admittable: true,
      showAdmitAction: false,
      status: "VALID",
      sameOrderCount: 2,
      canBulkAdmit: true,
    });
    expect(plan.hasDetail).toBe(true);
    expect(plan.bulkCount).toBe(2);
  });

  it("drops the bulk block when the host wired no handler", () => {
    const plan = planResultDetail({
      kind: "ticket",
      admittable: true,
      showAdmitAction: false,
      status: "VALID",
      sameOrderCount: 2,
      canBulkAdmit: false,
    });
    expect(plan.bulkCount).toBe(0);
    expect(plan.hasDetail).toBe(false);
  });

  it("never offers bulk admit on a non-admittable ticket", () => {
    // Same-order siblings of a REFUNDED ticket are not a reason to admit
    // anyone; the bulk block is an ADMIT affordance.
    const plan = planResultDetail({
      kind: "ticket",
      admittable: false,
      showAdmitAction: false,
      status: "REFUNDED",
      sameOrderCount: 3,
      canBulkAdmit: true,
    });
    expect(plan.bulkCount).toBe(0);
    expect(plan.hasDetail).toBe(false);
  });

  it("SCANNED HAS detail only when there is a timestamp to show", () => {
    const withTime = planResultDetail({
      kind: "ticket",
      admittable: false,
      showAdmitAction: false,
      status: "SCANNED",
      scannedAtLabel: "21:14",
    });
    expect(withTime.hasDetail).toBe(true);
    expect(withTime.showScanHistory).toBe(true);

    const withoutTime = planResultDetail({
      kind: "ticket",
      admittable: false,
      showAdmitAction: false,
      status: "SCANNED",
      scannedAtLabel: null,
    });
    expect(withoutTime.hasDetail).toBe(false);
    expect(withoutTime.showScanHistory).toBe(false);
  });

  it("a ticket with alsoVolunteering candidates HAS detail", () => {
    expect(
      planResultDetail({
        kind: "ticket",
        admittable: false,
        showAdmitAction: false,
        status: "INVALID",
        alsoVolunteeringCount: 1,
      }).hasDetail,
    ).toBe(true);
  });

  it("an inline host's in-panel ADMIT counts as detail (it has no rail)", () => {
    const plan = planResultDetail({
      kind: "ticket",
      admittable: true,
      showAdmitAction: true,
      status: "VALID",
    });
    expect(plan.showAdmitAction).toBe(true);
    expect(plan.hasDetail).toBe(true);
  });

  it("does NOT show an in-panel ADMIT for a non-admittable ticket", () => {
    const plan = planResultDetail({
      kind: "ticket",
      admittable: false,
      showAdmitAction: true,
      status: "VOID",
    });
    expect(plan.showAdmitAction).toBe(false);
    expect(plan.hasDetail).toBe(false);
  });
});

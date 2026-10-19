import { describe, expect, it } from "vitest";

import {
  REFUSED_ROW_PREFIX,
  planAdmitSettlement,
  planRefusalSurface,
  refusedRowLabel,
} from "./admit-settlement";
import { presentScanResult } from "./scan-result-presentation";

/**
 * The `.then` of the scan screen's `handleAdmit`. There is no screen-level
 * harness for `unified-scan-screen.tsx` (vitest runs in node), so the branch
 * is a pure planner and this is its test.
 */
const fmt = (v: Date | string) =>
  (v instanceof Date ? v : new Date(v)).toISOString().slice(11, 16);

describe("planAdmitSettlement", () => {
  it("ACCEPTED keeps the mark (the only outcome that may)", () => {
    expect(
      planAdmitSettlement(
        { outcome: "ACCEPTED", scannedAt: new Date() },
        { formatTime: fmt },
      ),
    ).toEqual({ kind: "accepted" });
  });

  it("REJECTED event_not_active (doors closed) → HOLD, revert the local mark", () => {
    const plan = planAdmitSettlement(
      { outcome: "REJECTED", reason: "event_not_active" },
      { formatTime: fmt },
    );
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.key).toBe("doorsNotOpen");
    expect(plan.keepLocalScanned).toBe(false);
    expect(plan.feedback).toBe("wrong_event");
    const p = presentScanResult(plan.descriptor);
    expect(p.word).toBe("HOLD");
    expect(p.tone).toBe("fail");
  });

  it("REJECTED ticket_not_valid (refund race) → STOP, rejected buzz", () => {
    const plan = planAdmitSettlement(
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      { formatTime: fmt },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(plan.key).toBe("invalid");
    expect(plan.feedback).toBe("rejected");
    expect(plan.keepLocalScanned).toBe(false);
  });

  it("REJECTED event_mismatch carries the selected event name", () => {
    const plan = planAdmitSettlement(
      { outcome: "REJECTED", reason: "event_mismatch" },
      { formatTime: fmt, selectedEventName: "Door Test" },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(presentScanResult(plan.descriptor).detail).toContain("Door Test");
  });

  it("REPLAY (two doors) → ALREADY USED at the ORIGINAL time, keep SCANNED locally", () => {
    const plan = planAdmitSettlement(
      {
        outcome: "REPLAY",
        scannedAt: "2026-10-06T22:00:00.000Z",
        previousScannedAt: "2026-10-06T21:14:00.000Z",
      },
      { formatTime: fmt },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(plan.key).toBe("alreadyUsed");
    expect(plan.keepLocalScanned).toBe(true);
    expect(plan.feedback).toBe("already_scanned");
    const p = presentScanResult(plan.descriptor);
    expect(p.state).toBe("ALREADY USED · 21:14");
    expect(p.word).toBe("STOP");
  });

  it("an outcome this build has never heard of is NOT an admission", () => {
    const plan = planAdmitSettlement(
      { outcome: "PARTIAL" },
      { formatTime: fmt },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(plan.key).toBe("notRecorded");
    expect(plan.keepLocalScanned).toBe(false);
    expect(plan.feedback).toBe("rejected");
  });
});

describe("planAdmitSettlement — unknown rejection reason (ruling: fail closed)", () => {
  it("REJECTED with a reason this build never heard of → STOP, rejected buzz", () => {
    const plan = planAdmitSettlement(
      { outcome: "REJECTED", reason: "brand_new_reason" },
      { formatTime: fmt },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(plan.key).toBe("unrecognised");
    expect(presentScanResult(plan.descriptor).word).toBe("STOP");
    expect(plan.feedback).toBe("rejected");
    expect(plan.keepLocalScanned).toBe(false);
  });

  it("REJECTED event_not_active stays doorsNotOpen (HOLD)", () => {
    const plan = planAdmitSettlement(
      { outcome: "REJECTED", reason: "event_not_active" },
      { formatTime: fmt },
    );
    if (plan.kind !== "refused") throw new Error("expected refused");
    expect(plan.key).toBe("doorsNotOpen");
    expect(presentScanResult(plan.descriptor).word).toBe("HOLD");
  });
});

describe("planRefusalSurface — a refusal is never invisible or misattributed", () => {
  const replay = {
    kind: "admit_settled" as const,
    outcome: { outcome: "REPLAY" },
    scannedAtLabel: "21:14",
  };
  const thrown = {
    kind: "failure" as const,
    stage: "record" as const,
    detail: "Forbidden",
  };
  /** Everything visible on the verdict, in the order it is read. */
  const visible = (d: Parameters<typeof presentScanResult>[0]) => {
    const p = presentScanResult(d);
    return [p.state, p.word, p.detail ?? ""];
  };

  it("current: shows the verdict unmarked; the announcement is what is shown", () => {
    const s = planRefusalSurface({
      current: true,
      screenOccupied: true,
      descriptor: replay,
      holderName: "Ana",
    });
    expect(s.show).toEqual(replay);
    expect(s.notice).toBeNull();
    for (const part of visible(s.show!)) expect(s.announcement).toContain(part);
    expect(presentScanResult(s.show!).detail).not.toMatch(/EARLIER SCAN/);
  });

  it("late, screen free (express dwell expired): the VISIBLE detail says it is an earlier scan", () => {
    // Express door: A goes green, the dwell expires, A's REPLAY lands at 1.6s
    // while B steps up. An unmarked full-bleed STOP would read as B's verdict.
    const s = planRefusalSurface({
      current: false,
      screenOccupied: false,
      descriptor: replay,
      holderName: "Ana Ruiz",
    });
    expect(s.show).not.toBeNull();
    const p = presentScanResult(s.show!);
    expect(p.detail).toMatch(/^EARLIER SCAN \(Ana Ruiz\) — not the person in front of you\./);
    expect(p.word).toBe("STOP");
    // The screen reader hears exactly the visible words.
    for (const part of visible(s.show!)) expect(s.announcement).toContain(part);
  });

  it("late, screen free, holder unknown: still marked earlier", () => {
    const s = planRefusalSurface({
      current: false,
      screenOccupied: false,
      descriptor: thrown,
    });
    const p = presentScanResult(s.show!);
    expect(p.key).toBe("notRecorded");
    expect(p.detail).toMatch(/^EARLIER SCAN — not the person in front of you\./);
    expect(p.detail).toContain("Forbidden");
  });

  it("late, another verdict up (camera or search): never shown over it — notice instead", () => {
    const s = planRefusalSurface({
      current: false,
      screenOccupied: true,
      descriptor: replay,
      holderName: "Ana",
    });
    expect(s.show).toBeNull();
    expect(s.notice).toContain(REFUSED_ROW_PREFIX);
    expect(s.notice).toContain("Ana");
    expect(s.notice).toContain(presentScanResult(replay).state);
    expect(s.notice).toMatch(/recent scans/i);
    expect(s.announcement).toBe(s.notice);
  });

  it("a thrown permanent rejection takes the same paths", () => {
    expect(
      planRefusalSurface({ current: true, screenOccupied: false, descriptor: thrown })
        .show,
    ).toEqual(thrown);
    expect(
      planRefusalSurface({ current: false, screenOccupied: true, descriptor: thrown })
        .notice,
    ).toContain("NOT RECORDED");
  });
});

describe("refusedRowLabel — the row the notice points at", () => {
  it("marks a refused row with the verdict it was refused with", () => {
    expect(refusedRowLabel("alreadyUsed")).toBe("NOT ADMITTED · ALREADY USED");
    expect(refusedRowLabel("doorsNotOpen")).toBe("NOT ADMITTED · DOORS NOT OPEN");
  });

  it("marks an unknown stored key without inventing a state", () => {
    expect(refusedRowLabel("from_a_newer_build")).toBe(REFUSED_ROW_PREFIX);
  });

  it("leaves an admission that stands unmarked", () => {
    expect(refusedRowLabel(null)).toBeNull();
  });
});

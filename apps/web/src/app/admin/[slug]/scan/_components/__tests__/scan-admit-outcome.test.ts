/**
 * FR-013 — an admit the server ACCEPTED must never render as a failure.
 *
 * This is the module that exists because the opposite happened at a door: a
 * ticket was admitted, the database recorded `SCANNED`, the tally read
 * `1 ADMITTED` — and the decorative post-admit re-resolve failed and replaced
 * the confirmation with a full-bleed red SCAN FAILED. From that screen the only
 * two things an operator can do are turn the person away or re-scan them.
 */
import { describe, expect, it } from "vitest";

import type { ResolveScanPayloadOutput } from "@th/core/use-cases/scanning";

import { resolveAdmitOutcome } from "../scan-admit-outcome";
import { presentScanResult } from "../scan-result-presentation";

const ticket = (
  over: Partial<Extract<ResolveScanPayloadOutput, { kind: "ticket" }>> = {},
): ResolveScanPayloadOutput =>
  ({
    kind: "ticket",
    ticketId: "tk_id",
    ticketCode: "SEED-E00-002-0",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hu_1",
    holderDisplay: "Mason L.",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    ...over,
  }) as ResolveScanPayloadOutput;

const SCANNED_AT = new Date("2026-08-08T03:10:37.000Z");

describe("resolveAdmitOutcome — ACCEPTED", () => {
  it("derives the SCANNED card from the admit response, synchronously", () => {
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "ACCEPTED", scannedAt: SCANNED_AT },
      "SEED-E00-002-0",
    );
    expect(next.kind).toBe("result");
    if (next.kind !== "result") throw new Error("unreachable");
    // The flag that makes this the PASS confirmation (DONE) rather than the
    // FAIL "this pass has been used" warning (STOP).
    expect(next.admitted).toBe(true);
    expect(next.result).toMatchObject({
      kind: "ticket",
      ticketCode: "SEED-E00-002-0",
      status: "SCANNED",
      scannedAt: SCANNED_AT,
      // Admitting a ticket changes nothing else about it, which is exactly why
      // the round trip that used to re-fetch all of this was unnecessary.
      holderDisplay: "Mason L.",
      ticketTypeName: "General Admission",
    });
  });

  it("never produces a failure verdict, whatever the response is missing", () => {
    // The invariant, stated as a property. A server that stops sending
    // `scannedAt`, or sends it unparseable, must degrade the TIME — not the
    // fact that this person was admitted.
    for (const outcome of [
      { outcome: "ACCEPTED" as const, scannedAt: SCANNED_AT },
      { outcome: "ACCEPTED" as const, scannedAt: SCANNED_AT.toISOString() },
      { outcome: "ACCEPTED" as const, scannedAt: null },
      { outcome: "ACCEPTED" as const },
      { outcome: "ACCEPTED" as const, scannedAt: "not a date" },
    ]) {
      const next = resolveAdmitOutcome(ticket(), outcome, "SEED-E00-002-0");
      const presentation =
        next.kind === "result"
          ? presentScanResult({
              kind: "ticket",
              status: "SCANNED",
              admitted: next.admitted,
            })
          : presentScanResult(next.descriptor);
      // An admit the server ACCEPTED must never render as a failure.
      expect(presentation.key, JSON.stringify(outcome)).toBe("admitted");
      expect(presentation.tone, JSON.stringify(outcome)).toBe("pass");
      expect(presentation.word, JSON.stringify(outcome)).toBe("DONE");
    }
  });

  it("does not patch one person's admission onto another person's card", () => {
    // The screen moved on to a different ticket while the admit was in flight.
    const next = resolveAdmitOutcome(
      ticket({ ticketCode: "SOMEONE-ELSE" }),
      { outcome: "ACCEPTED", scannedAt: SCANNED_AT },
      "SEED-E00-002-0",
    );
    expect(next.kind).toBe("override");
    if (next.kind !== "override") throw new Error("unreachable");
    // …and it STILL does not become an error: the server admitted somebody.
    const p = presentScanResult(next.descriptor);
    expect(p.tone).toBe("pass");
    expect(p.key).toBe("admitted");
    expect(p.word).toBe("DONE");
  });

  it("holds the same line with no card in hand at all", () => {
    const next = resolveAdmitOutcome(
      null,
      { outcome: "ACCEPTED", scannedAt: SCANNED_AT },
      "SEED-E00-002-0",
    );
    expect(next.kind).toBe("override");
    if (next.kind !== "override") throw new Error("unreachable");
    expect(presentScanResult(next.descriptor).tone).toBe("pass");
  });
});

describe("resolveAdmitOutcome — REPLAY", () => {
  it("stays ALREADY USED — a replay means someone ELSE already let them in", () => {
    const next = resolveAdmitOutcome(
      ticket(),
      {
        outcome: "REPLAY",
        scannedAt: SCANNED_AT,
        previousScannedAt: new Date("2026-08-08T02:00:00.000Z"),
      },
      "SEED-E00-002-0",
    );
    if (next.kind !== "result") throw new Error("unreachable");
    expect(next.admitted).toBe(false);
    expect(
      presentScanResult({
        kind: "ticket",
        status: "SCANNED",
        admitted: next.admitted,
      }).key,
    ).toBe("alreadyUsed");
  });

  it("shows the ORIGINAL admission time, not 'now'", () => {
    const originally = new Date("2026-08-08T02:00:00.000Z");
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "REPLAY", scannedAt: SCANNED_AT, previousScannedAt: originally },
      "SEED-E00-002-0",
    );
    if (next.kind !== "result") throw new Error("unreachable");
    // "already admitted at 21:14" means the first time, not this tap.
    expect(next.result).toMatchObject({ status: "SCANNED", scannedAt: originally });
  });

  it("falls back to the response's own timestamp when there is no prior one", () => {
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "REPLAY", scannedAt: SCANNED_AT },
      "SEED-E00-002-0",
    );
    if (next.kind !== "result") throw new Error("unreachable");
    expect(next.result).toMatchObject({ scannedAt: SCANNED_AT });
  });
});

describe("resolveAdmitOutcome — REJECTED", () => {
  it.each([
    ["event_not_active", "doorsNotOpen"],
    ["event_mismatch", "wrongEvent"],
    ["ticket_not_found", "noMatch"],
    ["ticket_not_valid", "invalid"],
  ])("%s surfaces as its own verdict instead of silence", (reason, key) => {
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "REJECTED", reason },
      "SEED-E00-002-0",
    );
    expect(next.kind).toBe("override");
    if (next.kind !== "override") throw new Error("unreachable");
    expect(presentScanResult(next.descriptor).key).toBe(key);
  });

  it("never leaves the card on a PASS the operator can keep tapping", () => {
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "REJECTED", reason: "event_not_active" },
      "SEED-E00-002-0",
    );
    if (next.kind !== "override") throw new Error("unreachable");
    expect(presentScanResult(next.descriptor).admittable).toBe(false);
  });

  it("handles a reason the client has never heard of", () => {
    const next = resolveAdmitOutcome(
      ticket(),
      { outcome: "REJECTED", reason: "some_new_server_reason" },
      "SEED-E00-002-0",
    );
    if (next.kind !== "override") throw new Error("unreachable");
    // Fails CLOSED onto the shared `unrecognised` key (STOP) — the ruling for
    // every unknown reason, on either axis.
    expect(presentScanResult(next.descriptor).key).toBe("unrecognised");
    expect(presentScanResult(next.descriptor).word).toBe("STOP");
  });
});

describe("purity", () => {
  it("never mutates the card it was handed", () => {
    const before = ticket();
    const snapshot = JSON.stringify(before);
    resolveAdmitOutcome(
      before,
      { outcome: "ACCEPTED", scannedAt: SCANNED_AT },
      "SEED-E00-002-0",
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

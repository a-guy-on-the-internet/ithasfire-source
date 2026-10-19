import { describe, expect, it } from "vitest";

import {
  aggregateItems,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../checkout-helpers";

// Fixture mirrors fee-waiver-pricing.test.ts — same policy shape, same helpers.
function makeContext(
  overrides: Partial<{
    platformFixedCents: number;
    buyerFeePct: number;
    feeMode: "ABSORB" | "PASS_THROUGH";
    maxPlatformFeeCents: number | null;
    minFeeCents: number;
  }> = {},
): PayoutTermsContext {
  return {
    agreement: {
      id: "agreement-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: null,
      feePolicyId: "policy-1",
      version: 1,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "policy-1",
      version: 1,
      feeMode: overrides.feeMode ?? "PASS_THROUGH",
      buyerFeePct: overrides.buyerFeePct ?? 0,
      maxFeeCents: null,
      minFeeCents: overrides.minFeeCents ?? 0,
      maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
      platformFixedCents: overrides.platformFixedCents ?? 30,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0.0025,
      payoutFixedCents: 25,
      monthlyPayoutCents: 200,
      payoutMinimumCents: 1000,
    },
  } as unknown as PayoutTermsContext;
}

/**
 * Fixed evaluation instant for `computeOrderAmounts`, which now REQUIRES one
 * (time-based-ticket-pricing FR-003). No fixture here carries a scheduled
 * price change, so every expectation below is unchanged from before that
 * parameter existed — a call-signature addition, not a behaviour change
 * (NFR-001).
 */
const NOW = new Date("2026-01-01T00:00:00.000Z");

const TICKET_TYPE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeTicketTypes(priceCents: number) {
  return new Map<string, TicketTypeSummary>([
    [
      TICKET_TYPE_ID,
      {
        id: TICKET_TYPE_ID,
        priceCents,
        pricingMode: "FIXED",
        minimumCents: null,
        seatSectionId: null,
        // Explicit, not omitted: these are REQUIRED on TicketTypeSummary
        // (FR-003's compile-time safety net). Letting the `as` cast paper over
        // them would mean the fixtures never exercise the mechanism the whole
        // design leans on. Unscheduled here — no expectation in this file
        // depends on `now`.
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      } as TicketTypeSummary,
    ],
  ]);
}

function itemsOf(qty: number) {
  return aggregateItems([{ ticketTypeId: TICKET_TYPE_ID, qty }] as never);
}

const metaOf = (item: { meta: unknown }) => item.meta as Record<string, unknown>;

describe("order-level platform fee cap — pricing", () => {
  it("PASS_THROUGH: caps the buyer-funded fee and the buyer's charge together", () => {
    // 5 × 30¢ = 150¢ platform fee, order-capped at 100¢.
    const result = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH", maxPlatformFeeCents: 100 }),
      { now: NOW },
    );

    expect(result.amountGrossCents).toBe(25_000);
    expect(result.feesPlatformCents).toBe(100);
    expect(result.buyerFeesCents).toBe(100);
    expect(result.paymentIntentAmountCents).toBe(25_100);
    // Per-item accounting sums to the cap; buyer totals track the reduction.
    const items = result.items;
    const platformSum = items.reduce(
      (sum, item) => sum + (metaOf(item).platformFeePerTicketCents as number),
      0,
    );
    expect(platformSum).toBe(100);
    const buyerSum = items.reduce(
      (sum, item) => sum + (metaOf(item).buyerTotalCents as number),
      0,
    );
    expect(buyerSum).toBe(25_100);
    for (const item of items) {
      expect(metaOf(item).platformFeeCapped).toBe(true);
    }
  });

  // ABSORB is removed (docs/decisions/absorb-removed.md): a legacy ABSORB
  // policy row prices exactly like PASS_THROUGH, cap included. (The old
  // ABSORB regression — the cap driving buyerFeesCents negative — is
  // unreachable now; the PASS_THROUGH floor still guards it.)
  it("a policy still saying ABSORB: the capped fee is charged on top, as in PASS_THROUGH", () => {
    const legacy = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(5000),
      makeContext({ feeMode: "ABSORB", maxPlatformFeeCents: 100 }),
      { now: NOW },
    );
    const passThrough = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH", maxPlatformFeeCents: 100 }),
      { now: NOW },
    );

    expect(legacy).toEqual(passThrough);
    expect(legacy.feesPlatformCents).toBe(100);
    expect(legacy.buyerFeesCents).toBe(100);
    expect(legacy.paymentIntentAmountCents).toBe(25_100);
  });

  // The waiver deliberately runs AFTER the cap, on the cap-scaled per-item
  // fees, and shares the same PASS_THROUGH buyer-side gate — pin the
  // combination (and its legacy-ABSORB-row twin below) so the two blocks
  // can't drift apart.
  it("PASS_THROUGH: cap then waiver — waiver subtracts scaled fees from both sides", () => {
    // 5 × 30¢ = 150 capped to 100 → per-item scaled 20/20/20/20/20 (floor +
    // last-item remainder). Waiving 2 tickets removes 2 × 20 = 40 from both
    // the platform fee and the buyer's charge.
    const result = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(5000),
      makeContext({ feeMode: "PASS_THROUGH", maxPlatformFeeCents: 100 }),
      { now: NOW, waivedTickets: 2 },
    );

    expect(result.waivedTicketCount).toBe(2);
    expect(result.feesPlatformCents).toBe(60);
    expect(result.buyerFeesCents).toBe(60);
    expect(result.paymentIntentAmountCents).toBe(25_060);
    const platformSum = result.items.reduce(
      (sum, item) => sum + (metaOf(item).platformFeePerTicketCents as number),
      0,
    );
    expect(platformSum).toBe(60);
  });

  it("a policy still saying ABSORB: cap then waiver prices as PASS_THROUGH", () => {
    const result = computeOrderAmounts(
      itemsOf(5),
      makeTicketTypes(5000),
      makeContext({ feeMode: "ABSORB", maxPlatformFeeCents: 100 }),
      { now: NOW, waivedTickets: 2 },
    );

    expect(result.waivedTicketCount).toBe(2);
    expect(result.feesPlatformCents).toBe(60);
    expect(result.buyerFeesCents).toBe(60);
    expect(result.paymentIntentAmountCents).toBe(25_060);
  });
});

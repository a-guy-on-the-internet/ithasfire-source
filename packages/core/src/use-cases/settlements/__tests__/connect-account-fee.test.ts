import { describe, expect, it } from "vitest";

import {
  computeConnectAccountFeeDeduction,
  startOfUtcMonth,
} from "../connect-account-fee";

const FEE = 200; // Stripe's $2 monthly active-account fee
const MINIMUM = 1000; // $10 payout minimum

function base(overrides: Record<string, unknown> = {}) {
  return {
    groupTotalCents: 5000,
    feeCents: FEE,
    payoutMinimumCents: MINIMUM,
    hasTicketingRevenueInPayout: false,
    hasMembershipRevenueInPayout: true,
    accountAlreadyActiveThisMonth: false,
    ...overrides,
  };
}

describe("computeConnectAccountFeeDeduction", () => {
  it("deducts the fee when membership revenue is the sole reason for the payout", () => {
    expect(computeConnectAccountFeeDeduction(base())).toEqual({
      deductionCents: FEE,
      reason: "deducted",
    });
  });

  it("deducts nothing when the payout also carries ticket revenue", () => {
    // The account was going to be active regardless, so the membership payout
    // carries zero marginal cost. This is the promise made to the venue.
    expect(
      computeConnectAccountFeeDeduction(
        base({ hasTicketingRevenueInPayout: true }),
      ),
    ).toEqual({
      deductionCents: 0,
      reason: "ticketing_revenue_in_payout",
    });
  });

  it("deducts nothing from a pure ticketing payout", () => {
    // Today's entire payout population. Applying the migration must not change
    // a single existing transfer amount.
    expect(
      computeConnectAccountFeeDeduction(
        base({
          hasTicketingRevenueInPayout: true,
          hasMembershipRevenueInPayout: false,
        }),
      ),
    ).toEqual({
      deductionCents: 0,
      reason: "ticketing_revenue_in_payout",
    });
  });

  it("deducts nothing when the account already received a payout this month", () => {
    // Stripe bills $2 per account-MONTH, so a second payout in the same month
    // costs us nothing extra and must never be charged again.
    expect(
      computeConnectAccountFeeDeduction(
        base({ accountAlreadyActiveThisMonth: true }),
      ),
    ).toEqual({
      deductionCents: 0,
      reason: "account_already_active_this_month",
    });
  });

  it("requires positive membership evidence — an unclassifiable group is left alone", () => {
    expect(
      computeConnectAccountFeeDeduction(
        base({ hasMembershipRevenueInPayout: false }),
      ),
    ).toEqual({
      deductionCents: 0,
      reason: "no_membership_revenue_in_payout",
    });
  });

  it("deducts nothing when the fee is not configured (recovery off)", () => {
    expect(computeConnectAccountFeeDeduction(base({ feeCents: 0 }))).toEqual({
      deductionCents: 0,
      reason: "no_fee_configured",
    });
  });

  // ── Order of operations: minimum gate FIRST ───────────────────────────────

  it("never charges a balance below the payout minimum", () => {
    // The spec's guarantee: a sub-minimum balance does not pay out, and is
    // therefore never charged the $2. The caller filters these out before we
    // get here; this asserts the helper's defensive re-check.
    expect(
      computeConnectAccountFeeDeduction(base({ groupTotalCents: 300 })),
    ).toEqual({
      deductionCents: 0,
      reason: "below_payout_minimum",
    });
  });

  it("deducts from a payout sitting exactly at the minimum, taking it below the minimum", () => {
    // DOCUMENTED BEHAVIOUR: the minimum gates the GROSS balance ("is this worth
    // moving at all"), and is deliberately NOT re-applied to the net. Re-gating
    // would make a payee whose steady balance sits just above the minimum pay
    // out only every other month — the same "your money arrives later" delay
    // the spec rejects when it rules out quarterly batching.
    const result = computeConnectAccountFeeDeduction(
      base({ groupTotalCents: MINIMUM }),
    );
    expect(result).toEqual({ deductionCents: FEE, reason: "deducted" });
    expect(MINIMUM - result.deductionCents).toBe(800);
  });

  it("withholds nothing rather than produce a zero or negative transfer", () => {
    // Only reachable via a misconfigured policy (minimum < fee). We absorb the
    // fee instead of sending Stripe a transfer of 0 — or of dust that would
    // cost more in payout fees than it moves.
    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 200, payoutMinimumCents: 100 }),
      ),
    ).toEqual({ deductionCents: 0, reason: "would_zero_transfer" });

    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 150, payoutMinimumCents: 100 }),
      ),
    ).toEqual({ deductionCents: 0, reason: "would_zero_transfer" });
  });

  // ── Prior withholding: debt recovery comes FIRST ──────────────────────────

  it("evaluates the zero-transfer fail-safe against the post-debt remainder, not the gross", () => {
    // 1100 gross fits the fee on its own, but 1000 of debt recovery runs
    // first and the 100 remainder cannot fit a $2 fee — absorbed, not taken.
    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 1100, priorWithholdingCents: 1000 }),
      ),
    ).toEqual({ deductionCents: 0, reason: "would_zero_transfer" });

    // With headroom for the fee AND at least one transferable cent, deduct.
    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 1301, priorWithholdingCents: 1100 }),
      ),
    ).toEqual({ deductionCents: FEE, reason: "deducted" });

    // Exactly no transferable cent left → absorbed.
    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 1300, priorWithholdingCents: 1100 }),
      ),
    ).toEqual({ deductionCents: 0, reason: "would_zero_transfer" });
  });

  it("keeps the minimum gate on the GROSS even when debt shrinks the remainder", () => {
    // Whether a balance is worth moving is a question about the balance — a
    // 5000-cent group is above the gate even though debt leaves only a
    // 500-cent remainder (well under the 1000 minimum). The fee still fits
    // that remainder with a cent to spare, so it deducts: the remainder is
    // checked by the zero-transfer fail-safe, never re-gated on the minimum.
    expect(
      computeConnectAccountFeeDeduction(
        base({ groupTotalCents: 5000, priorWithholdingCents: 4500 }),
      ),
    ).toEqual({ deductionCents: FEE, reason: "deducted" });
  });

  it("leaves at least one cent transferable in every accepted case", () => {
    // Invariant sweep: no input may ever produce a deduction that — together
    // with any prior (debt) withholding — meets or exceeds the payout.
    for (let total = 0; total <= 1500; total += 1) {
      for (const minimum of [0, 100, 200, 1000]) {
        for (const prior of [0, 100, 500, 1000]) {
          const { deductionCents } = computeConnectAccountFeeDeduction(
            base({
              groupTotalCents: total,
              payoutMinimumCents: minimum,
              priorWithholdingCents: prior,
            }),
          );
          expect(deductionCents).toBeGreaterThanOrEqual(0);
          if (deductionCents > 0) {
            expect(total - prior - deductionCents).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  it("rejects non-integer and negative money inputs", () => {
    expect(() =>
      computeConnectAccountFeeDeduction(base({ groupTotalCents: 100.5 })),
    ).toThrow();
    expect(() =>
      computeConnectAccountFeeDeduction(base({ feeCents: -200 })),
    ).toThrow();
    expect(() =>
      computeConnectAccountFeeDeduction(base({ priorWithholdingCents: -1 })),
    ).toThrow();
    // .strict() — an unexpected key is a bug, not something to silently ignore.
    expect(() =>
      computeConnectAccountFeeDeduction(base({ hasTicketSales: true })),
    ).toThrow();
  });
});

describe("startOfUtcMonth", () => {
  it("returns midnight on the first of the month, in UTC", () => {
    expect(
      startOfUtcMonth(new Date("2026-03-05T06:00:00Z")).toISOString(),
    ).toBe("2026-03-01T00:00:00.000Z");
  });

  it("is idempotent on a value already at the boundary", () => {
    const boundary = new Date("2026-01-01T00:00:00.000Z");
    expect(startOfUtcMonth(boundary).toISOString()).toBe(
      boundary.toISOString(),
    );
  });

  it("does not roll back a year at the January boundary", () => {
    expect(
      startOfUtcMonth(new Date("2026-12-31T23:59:59.999Z")).toISOString(),
    ).toBe("2026-12-01T00:00:00.000Z");
  });
});

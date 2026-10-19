import { describe, expect, it } from "vitest";

import {
  aggregateItems,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "@th/core/use-cases/orders/checkout-helpers";
import {
  computePlatformFeePerTicketCents,
  SALE_FEE_MODE,
} from "@th/core/lib/pricing/compute-ticket-price-for-agreement";
import { solveTaxLinesAndProcessorFee } from "@th/core/lib/pricing/solve-tax-and-processor-fee";
import type { TaxImposition } from "@th/core/lib/pricing/tax-impositions";

import {
  estimateCartTotal,
  type FeeRatesForOrderEstimate,
} from "./order-estimate";

/**
 * PRICING-MATH PARITY for pay-what-you-want lines: the checkout's pre-hold
 * estimate must equal the money functions the charge is built from.
 *
 * What this checks — and what it does not: server side it runs
 * `computeOrderAmounts` over the cart (ADJUSTABLE lines priced at
 * `donationAmountCents`) and then the same `solveTaxLinesAndProcessorFee`
 * call `createCheckout` makes, with no promo, credit or fee waiver. It does
 * NOT run `createCheckout` itself; the PaymentIntent amount (and a promo) is
 * compared in `pay-what-you-want-create-checkout.test.ts`. Client side: the
 * checkout's `estimateCartTotal` with the chosen amounts and the
 * `platformFeeRates` `getCheckoutFeeRates` exposes. Every case must agree to
 * the cent.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const PWYW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIXED_PRICE = 4500;
const RATE_BPS = 888;

type Policy = {
  feeMode: "PASS_THROUGH" | "ABSORB";
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  platformFixedCents: number;
  /** ORDER-level platform fee cap (`FeePolicy.maxPlatformFeeCents`). */
  maxPlatformFeeCents?: number | null;
};

/** The owner's shape: 3.33% capped at 50¢ per ticket; Stripe 2.9% + 30¢. */
const OWNER_POLICY: Policy = {
  feeMode: "PASS_THROUGH",
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  platformFixedCents: 0,
};

function makeContext(policy: Policy): PayoutTermsContext {
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
      feeMode: policy.feeMode,
      buyerFeePct: policy.buyerFeePct,
      maxFeeCents: policy.maxFeeCents,
      minFeeCents: policy.minFeeCents,
      maxPlatformFeeCents: policy.maxPlatformFeeCents ?? null,
      platformFixedCents: policy.platformFixedCents,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0.0025,
      payoutFixedCents: 25,
      monthlyPayoutCents: 200,
      payoutMinimumCents: 1000,
    },
  } as unknown as PayoutTermsContext;
}

const tier = (
  id: string,
  overrides: Partial<TicketTypeSummary>,
): TicketTypeSummary =>
  ({
    id,
    priceCents: 0,
    pricingMode: "FIXED",
    minimumCents: null,
    seatSectionId: null,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
    ...overrides,
  }) as TicketTypeSummary;

const TIERS = new Map<string, TicketTypeSummary>([
  [PWYW_ID, tier(PWYW_ID, { pricingMode: "ADJUSTABLE", minimumCents: 500 })],
  [FIXED_ID, tier(FIXED_ID, { priceCents: FIXED_PRICE })],
]);

const sales = (base: "TICKET_FACE" | "BUYER_TOTAL"): TaxImposition[] => [
  {
    code: "SALES",
    label: "Sales tax",
    jurisdiction: "US/XX",
    rateBps: RATE_BPS,
    base,
    collector: "PLATFORM",
  },
];

type Line = { ticketTypeId: string; qty: number; donationAmountCents?: number };

/** What `createCheckout` charges (pre-promo, pre-credit). */
function serverTotal(lines: Line[], policy: Policy, taxLines: TaxImposition[]) {
  const computation = computeOrderAmounts(
    aggregateItems(lines),
    TIERS,
    makeContext(policy),
    { now: NOW, seatPrices: new Map() },
  );
  const { taxCents, processorFeeCents } = solveTaxLinesAndProcessorFee({
    taxableGrossCents: computation.amountGrossCents,
    buyerPlatformFeeCents: computation.buyerFeesCents,
    taxLines,
    passThrough: computation.effectiveFeeMode === "PASS_THROUGH",
    processorPct: computation.processorPct,
    processorFixedCents: computation.processorFixedCents,
  });
  return {
    grossCents: computation.amountGrossCents,
    platformFeeCents: computation.buyerFeesCents,
    taxCents,
    processorFeeCents,
    totalCents:
      computation.amountGrossCents +
      computation.buyerFeesCents +
      taxCents +
      processorFeeCents,
  };
}

/** What the checkout page estimates, from the fee-rates payload. */
function clientTotal(lines: Line[], policy: Policy, taxLines: TaxImposition[]) {
  // The page is sent the server's mode, never the policy row's: always
  // SALE_FEE_MODE (ABSORB is removed, docs/decisions/absorb-removed.md).
  const passThrough = SALE_FEE_MODE === "PASS_THROUGH";
  const rates = {
    buyerFeePct: policy.buyerFeePct,
    maxFeeCents: policy.maxFeeCents,
    minFeeCents: policy.minFeeCents,
    platformFixedCents: policy.platformFixedCents,
  };
  const feeRates: FeeRatesForOrderEstimate = {
    feeMode: SALE_FEE_MODE,
    admissionTaxRateBps: RATE_BPS,
    taxImpositions: taxLines,
    processorPct: passThrough ? 0.029 : null,
    processorFixedCents: passThrough ? 30 : null,
    maxPlatformFeeCents: passThrough
      ? (policy.maxPlatformFeeCents ?? null)
      : null,
    platformFeeRates: passThrough ? rates : null,
    // The fixed tier's row, exactly as the estimator builds it.
    perTicketEstimates: [
      {
        ticketTypeId: FIXED_ID,
        unitPriceCents: FIXED_PRICE,
        platformFeeCents: passThrough
          ? computePlatformFeePerTicketCents(FIXED_PRICE, rates)
          : 0,
      },
    ],
  };
  return estimateCartTotal(
    feeRates,
    lines.map((line) => ({
      ticketTypeId: line.ticketTypeId,
      qty: line.qty,
      priceCents: line.ticketTypeId === FIXED_ID ? FIXED_PRICE : 0,
      chosenAmountCents: line.donationAmountCents ?? null,
    })),
  );
}

function expectParity(lines: Line[], policy: Policy, taxLines: TaxImposition[]) {
  const server = serverTotal(lines, policy, taxLines);
  const client = clientTotal(lines, policy, taxLines);
  expect(client).toEqual(server);
  return server;
}

describe("PWYW estimate === charge (server parity)", () => {
  it("a chosen $15 × 2, TICKET_FACE tax", () => {
    const total = expectParity(
      [{ ticketTypeId: PWYW_ID, qty: 2, donationAmountCents: 1500 }],
      OWNER_POLICY,
      sales("TICKET_FACE"),
    );
    // The owner's rule, spelled out: the whole $30 is the gross, fees on top.
    expect(total.grossCents).toBe(3000);
    expect(total.platformFeeCents).toBe(100); // 2 × min(round(1500 × 3.33%), 50)
  });

  it("a mixed cart: PWYW $22.50 + fixed $45.00 × 2", () => {
    expectParity(
      [
        { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 2250 },
        { ticketTypeId: FIXED_ID, qty: 2 },
      ],
      OWNER_POLICY,
      sales("TICKET_FACE"),
    );
  });

  it("BUYER_TOTAL (Tennessee): tax on face + fees, solved jointly with processing", () => {
    expectParity(
      [
        { ticketTypeId: PWYW_ID, qty: 3, donationAmountCents: 1234 },
        { ticketTypeId: FIXED_ID, qty: 1 },
      ],
      OWNER_POLICY,
      sales("BUYER_TOTAL"),
    );
  });

  it("an amount where the minimum fee applies ($7.50: 25¢ by rate, $1.00 floor)", () => {
    const total = expectParity(
      [{ ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 750 }],
      { ...OWNER_POLICY, minFeeCents: 100 },
      sales("TICKET_FACE"),
    );
    expect(total.platformFeeCents).toBe(100);
  });

  it("the ORDER-level platform fee cap binds across PWYW + fixed lines", () => {
    // Uncapped: 3 × 50¢ (PWYW $22.50) + 2 × 50¢ (fixed $45) = $2.50.
    const total = expectParity(
      [
        { ticketTypeId: PWYW_ID, qty: 3, donationAmountCents: 2250 },
        { ticketTypeId: FIXED_ID, qty: 2 },
      ],
      { ...OWNER_POLICY, maxPlatformFeeCents: 120 },
      sales("BUYER_TOTAL"),
    );
    expect(total.platformFeeCents).toBe(120);
  });

  it("a policy still saying ABSORB: fees on top, the same charge as PASS_THROUGH", () => {
    // It used to be face + tax only; ABSORB is removed.
    const lines = [{ ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 1500 }];
    const legacy = expectParity(
      lines,
      { ...OWNER_POLICY, feeMode: "ABSORB" },
      sales("TICKET_FACE"),
    );
    expect(legacy).toEqual(expectParity(lines, OWNER_POLICY, sales("TICKET_FACE")));
    expect(legacy.totalCents).toBeGreaterThan(
      1500 + Math.round((1500 * RATE_BPS) / 10_000),
    );
  });

  it("the $10,000.00 cap itself prices without overflow", () => {
    expectParity(
      [{ ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 1_000_000 }],
      OWNER_POLICY,
      sales("BUYER_TOTAL"),
    );
  });
});

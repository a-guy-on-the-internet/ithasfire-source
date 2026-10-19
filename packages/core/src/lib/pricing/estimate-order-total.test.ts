import { describe, expect, it } from "vitest";

import {
  aggregateItems,
  buildPricingPayoutTermsContext,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../use-cases/orders/checkout-helpers";
import {
  computeTicketPriceForAgreement,
  SALE_FEE_MODE,
} from "./compute-ticket-price-for-agreement";
import { estimateBuyerTicketPricingForEvent } from "../../use-cases/events/_shared/estimate-buyer-ticket-pricing";
import { solveProcessingFeeGrossUp } from "./processing-cost-schedule";
import {
  estimateOrderTotal,
  type EstimateOrderTotalItem,
} from "./estimate-order-total";
import type { TaxableBase } from "./taxable-base";
import type { TaxImposition } from "./tax-impositions";
import { referenceBuyerTotalTax } from "./__fixtures__/buyer-total-tax-oracle";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * The imposition list a situs with this sales rate + base resolves to (the
 * shipped local table is empty): one SALES line, or none at a zero rate —
 * exactly `resolveTaxImpositions`' output, so every pinned literal below is
 * computed on the same inputs it was before the list existed.
 */
function salesOnly(
  taxRateBps: number,
  base: TaxableBase = "TICKET_FACE",
): TaxImposition[] {
  return taxRateBps > 0
    ? [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/XX",
          rateBps: taxRateBps,
          base,
          collector: "PLATFORM",
        },
      ]
    : [];
}
const testClock = { now: () => TEST_NOW };

// ─────────────────────────────────────────────────────────────────────────────
// Server-math fixtures — the estimator must EQUAL this pipeline:
//   computeOrderAmounts (gross, per-ticket platform w/ order cap)
//   + round(gross × taxRateBps / 10⁴)          (update-order-items.ts:190-195)
//   + solveProcessingFeeGrossUp ONCE per order (update-order-items.ts:196-205,
//     create-checkout.ts preProcessorBase gross-up)
// ─────────────────────────────────────────────────────────────────────────────

type PolicyOverrides = Partial<{
  platformFixedCents: number;
  buyerFeePct: number;
  feeMode: "ABSORB" | "PASS_THROUGH";
  maxPlatformFeeCents: number | null;
  minFeeCents: number;
  processsorFeePct: number;
  processorFixedCents: number;
}>;

// Mirrors the seeded GLOBAL policy shape: Stripe 2.9% + 30¢ card rate.
function makeContext(overrides: PolicyOverrides = {}): PayoutTermsContext {
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
      processsorFeePct: overrides.processsorFeePct ?? 0.029,
      processorFixedCents: overrides.processorFixedCents ?? 30,
      payoutPct: 0.0025,
      payoutFixedCents: 25,
      monthlyPayoutCents: 200,
      payoutMinimumCents: 1000,
    },
  } as unknown as PayoutTermsContext;
}

type CartLine = { ticketTypeId: string; priceCents: number; qty: number };

function makeTicketTypes(lines: CartLine[]) {
  return new Map<string, TicketTypeSummary>(
    lines.map((line) => [
      line.ticketTypeId,
      {
        id: line.ticketTypeId,
        priceCents: line.priceCents,
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
    ]),
  );
}

/**
 * The server's actual buyer charge (pre-discount/credit) for a cart:
 * computeOrderAmounts → aggregate tax → order-level processor gross-up.
 */
function serverBuyerTotal(
  lines: CartLine[],
  ctx: PayoutTermsContext,
  taxRateBps: number,
  taxableBase: TaxableBase = "TICKET_FACE",
) {
  const computation = computeOrderAmounts(
    aggregateItems(
      lines.map(({ ticketTypeId, qty }) => ({ ticketTypeId, qty })) as never,
    ),
    makeTicketTypes(lines),
    ctx,
    { now: NOW, seatPrices: new Map() },
  );
  const passThrough = computation.effectiveFeeMode === "PASS_THROUGH";
  const taxable = taxRateBps > 0 && computation.amountGrossCents > 0;
  // BUYER_TOTAL + PASS_THROUGH is the one circular case: the tax covers the
  // processor fee and the processor fee is grossed up over the tax.
  const joint =
    taxable && passThrough && taxableBase === "BUYER_TOTAL"
      ? referenceBuyerTotalTax(
          computation.amountGrossCents + computation.feesPlatformCents,
          taxRateBps,
          computation.processorPct,
          computation.processorFixedCents,
        )
      : null;
  const taxCents = joint
    ? joint.taxCents
    : taxable
      ? Math.round((computation.amountGrossCents * taxRateBps) / 10_000)
      : 0;
  const processorFeeCents = joint
    ? joint.processorFeeCents
    : passThrough
      ? solveProcessingFeeGrossUp(
          computation.amountGrossCents +
            computation.feesPlatformCents +
            taxCents,
          computation.processorPct,
          computation.processorFixedCents,
        )
      : 0;
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

/**
 * Build the estimator's items the way a client does: per-ticket platform fee
 * from the qty=1 pricing solve — exactly what `estimateBuyerTicketPricingForEvent`
 * puts on each `perTicketEstimates` row.
 */
function estimatorItems(
  lines: CartLine[],
  ctx: PayoutTermsContext,
): EstimateOrderTotalItem[] {
  const pricingAgreement = buildPricingPayoutTermsContext(ctx);
  // The mode the server hands the client (`estimate.feeMode`): always
  // SALE_FEE_MODE, whatever the terms or policy row says.
  const effectiveFeeMode = SALE_FEE_MODE;
  return lines.map((line) => ({
    faceCents: line.priceCents,
    platformFeePerTicketCents:
      effectiveFeeMode === "PASS_THROUGH" && line.priceCents > 0
        ? computeTicketPriceForAgreement({
            qty: 1,
            unitPriceCents: line.priceCents,
            agreement: pricingAgreement,
          }).platformFeePerTicketCents
        : 0,
    qty: line.qty,
  }));
}

function expectParity(
  lines: CartLine[],
  overrides: PolicyOverrides,
  taxRateBps: number,
  taxableBase: TaxableBase = "TICKET_FACE",
) {
  const ctx = makeContext(overrides);
  const server = serverBuyerTotal(lines, ctx, taxRateBps, taxableBase);
  const estimate = estimateOrderTotal({
    items: estimatorItems(lines, ctx),
    taxImpositions: salesOnly(taxRateBps, taxableBase),
    // What the server sends, not the policy fixture's stored mode.
    feeMode: SALE_FEE_MODE,
    processorPct: overrides.processsorFeePct ?? 0.029,
    processorFixedCents: overrides.processorFixedCents ?? 30,
    maxPlatformFeeCents: overrides.maxPlatformFeeCents ?? null,
  });

  expect(estimate.grossCents).toBe(server.grossCents);
  expect(estimate.platformFeeCents).toBe(server.platformFeeCents);
  expect(estimate.taxCents).toBe(server.taxCents);
  expect(estimate.processorFeeCents).toBe(server.processorFeeCents);
  expect(estimate.totalCents).toBe(server.totalCents);
  return estimate;
}

/**
 * Fixed evaluation instant for `computeOrderAmounts`, which now REQUIRES one
 * (time-based-ticket-pricing FR-003). No fixture here carries a scheduled
 * price change, so every expectation below is unchanged from before that
 * parameter existed — a call-signature addition, not a behaviour change
 * (NFR-001).
 */
const NOW = new Date("2026-01-01T00:00:00.000Z");

const TT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("estimateOrderTotal — parity with server checkout math", () => {
  it("regression: 2 × $45.00 @ 8.88% tax, 2.9% + 30¢ → $101.85, NOT $102.18", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    const estimate = expectParity(lines, { platformFixedCents: 30 }, 888);
    expect(estimate.totalCents).toBe(10_185);

    // The buggy path this replaces: fee-inclusive per-unit total × qty.
    // Per-unit mirrors estimate-buyer-ticket-pricing.ts (tax + gross-up per
    // ticket): 4500 + 30 + 400 + 179 = 5109 → naive 2× = 10218 (33¢ high:
    // a second 30¢ fixed fee plus tax/percent rounding drift).
    const perTicketTax = Math.round((4500 * 888) / 10_000);
    const perTicketProcessor = solveProcessingFeeGrossUp(
      4500 + 30 + perTicketTax,
      0.029,
      30,
    );
    const buyerUnitTotalCents = 4500 + 30 + perTicketTax + perTicketProcessor;
    expect(buyerUnitTotalCents).toBe(5109);
    expect(buyerUnitTotalCents * 2).toBe(10_218);
    expect(estimate.totalCents).not.toBe(buyerUnitTotalCents * 2);
  });

  it("matches the server for qty 1..5 of one ticket type", () => {
    for (let qty = 1; qty <= 5; qty += 1) {
      expectParity(
        [{ ticketTypeId: TT_A, priceCents: 4500, qty }],
        { platformFixedCents: 30 },
        888,
      );
    }
  });

  it("is exact at qty=1 (equals the per-ticket buyer unit total)", () => {
    const estimate = expectParity(
      [{ ticketTypeId: TT_A, priceCents: 4500, qty: 1 }],
      { platformFixedCents: 30 },
      888,
    );
    expect(estimate.totalCents).toBe(5109);
  });

  it("matches the server for mixed ticket types with a percentage platform fee", () => {
    expectParity(
      [
        { ticketTypeId: TT_A, priceCents: 4500, qty: 2 },
        { ticketTypeId: TT_B, priceCents: 2500, qty: 1 },
        { ticketTypeId: TT_C, priceCents: 10_000, qty: 3 },
      ],
      { buyerFeePct: 0.1, platformFixedCents: 30 },
      975,
    );
  });

  it("matches the server with zero tax", () => {
    expectParity(
      [
        { ticketTypeId: TT_A, priceCents: 4500, qty: 3 },
        { ticketTypeId: TT_B, priceCents: 1500, qty: 2 },
      ],
      { platformFixedCents: 30 },
      0,
    );
  });

  it("matches the server with zero platform fee", () => {
    const estimate = expectParity(
      [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }],
      { platformFixedCents: 0, buyerFeePct: 0 },
      888,
    );
    expect(estimate.platformFeeCents).toBe(0);
  });

  // ABSORB is removed (docs/decisions/absorb-removed.md): a policy row that
  // still says ABSORB is priced fees-on-top by the server, and the estimator,
  // fed the server's mode, agrees with it to the cent.
  it("a policy still saying ABSORB: server and estimator both charge fees on top", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    const legacy = expectParity(
      lines,
      { feeMode: "ABSORB", platformFixedCents: 30 },
      888,
    );
    expect(legacy).toEqual(expectParity(lines, { platformFixedCents: 30 }, 888));
    // Not the old face + tax (9000 + 799).
    expect(legacy.totalCents).not.toBe(9799);
    expect(legacy.platformFeeCents).toBe(60);
    expect(legacy.processorFeeCents).toBeGreaterThan(0);
  });

  it("applies the order-level platform fee cap like computeOrderAmounts", () => {
    // 5 × 30¢ = 150¢ platform fee, capped at 100¢ across the order.
    const estimate = expectParity(
      [{ ticketTypeId: TT_A, priceCents: 4500, qty: 5 }],
      { platformFixedCents: 30, maxPlatformFeeCents: 100 },
      888,
    );
    expect(estimate.platformFeeCents).toBe(100);
  });

  it("a policy still saying ABSORB + order cap: the capped fee is charged on top", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 5000, qty: 5 }];
    const legacy = expectParity(
      lines,
      { feeMode: "ABSORB", platformFixedCents: 30, maxPlatformFeeCents: 100 },
      888,
    );
    expect(legacy).toEqual(
      expectParity(
        lines,
        { platformFixedCents: 30, maxPlatformFeeCents: 100 },
        888,
      ),
    );
    expect(legacy.platformFeeCents).toBe(100);
  });

  it("returns all zeros for a free order (server zeroes every buyer fee)", () => {
    const estimate = estimateOrderTotal({
      items: [{ faceCents: 0, platformFeePerTicketCents: 0, qty: 3 }],
      taxImpositions: salesOnly(888),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(estimate).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      taxCents: 0,
      processorFeeCents: 0,
      totalCents: 0,
    });
  });

  it("returns all zeros for an empty cart", () => {
    const estimate = estimateOrderTotal({
      items: [],
      taxImpositions: salesOnly(888),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(estimate.totalCents).toBe(0);
  });

  it("ignores negative quantities instead of crediting the total", () => {
    const estimate = estimateOrderTotal({
      items: [
        { faceCents: 4500, platformFeePerTicketCents: 30, qty: 1 },
        { faceCents: 4500, platformFeePerTicketCents: 30, qty: -2 },
      ],
      taxImpositions: salesOnly(0),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(estimate.grossCents).toBe(4500);
  });

  // ── Jurisdictional taxable base ───────────────────────────────────────────
  // Tennessee taxes everything the buyer pays. The estimate has to match the
  // charge to the cent, or the buyer is quoted one number and billed another.

  it("TN (BUYER_TOTAL): matches the server, and taxes MORE than the face-only base", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 2500, qty: 1 }];
    const tn = expectParity(lines, { platformFixedCents: 50 }, 975, "BUYER_TOTAL");
    const face = expectParity(lines, { platformFixedCents: 50 }, 975);

    // base = 2500 face + 50 platform + 115 processor = 2665 → 9.75% → 260
    expect(tn.taxCents).toBe(260);
    expect(tn.processorFeeCents).toBe(115);
    expect(tn.totalCents).toBe(2925);

    // The pre-change (face-only) numbers, for contrast: 16¢ less tax.
    expect(face.taxCents).toBe(244);
    expect(face.totalCents).toBe(2909);
    expect(tn.taxCents - face.taxCents).toBe(16);
  });

  it("TN: matches the server for qty 1..5 and for a mixed cart with a % platform fee", () => {
    for (let qty = 1; qty <= 5; qty += 1) {
      expectParity(
        [{ ticketTypeId: TT_A, priceCents: 4500, qty }],
        { platformFixedCents: 30 },
        975,
        "BUYER_TOTAL",
      );
    }
    expectParity(
      [
        { ticketTypeId: TT_A, priceCents: 4500, qty: 2 },
        { ticketTypeId: TT_B, priceCents: 2500, qty: 1 },
        { ticketTypeId: TT_C, priceCents: 10_000, qty: 3 },
      ],
      { buyerFeePct: 0.1, platformFixedCents: 30 },
      975,
      "BUYER_TOTAL",
    );
  });

  it("TN + order-level platform fee cap: the cap shrinks the taxable base too", () => {
    const capped = expectParity(
      [{ ticketTypeId: TT_A, priceCents: 4500, qty: 5 }],
      { platformFixedCents: 30, maxPlatformFeeCents: 100 },
      975,
      "BUYER_TOTAL",
    );
    expect(capped.platformFeeCents).toBe(100);
  });

  it("TN, a policy still saying ABSORB: priced fees-on-top on the buyer-total base", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    const legacy = expectParity(
      lines,
      { feeMode: "ABSORB" as const, platformFixedCents: 30 },
      975,
      "BUYER_TOTAL",
    );
    expect(legacy).toEqual(
      expectParity(lines, { platformFixedCents: 30 }, 975, "BUYER_TOTAL"),
    );
    // The buyer-total base taxes the fees too, so tax exceeds tax-on-face.
    expect(legacy.taxCents).toBeGreaterThan(Math.round((9000 * 975) / 10_000));
    expect(legacy.processorFeeCents).toBeGreaterThan(0);
  });

  it("TN at a zero rate collects nothing — identical to the face base", () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    expect(expectParity(lines, { platformFixedCents: 30 }, 0, "BUYER_TOTAL")).toEqual(
      expectParity(lines, { platformFixedCents: 30 }, 0),
    );
  });

  // ── BYTE-IDENTICAL REGRESSION: every non-TN base is untouched ─────────────
  it("a TICKET_FACE cart is byte-identical to the pinned pre-change numbers", () => {
    // Captured from HEAD before the taxable base existed.
    const cases = [
      { taxRateBps: 650, expected: { taxCents: 163, processorFeeCents: 112 } }, // FL 6.5%
      { taxRateBps: 862, expected: { taxCents: 216, processorFeeCents: 114 } }, // CA/SF 8.625%
      { taxRateBps: 0, expected: { taxCents: 0, processorFeeCents: 108 } }, // no situs / no rate
    ];
    for (const { taxRateBps, expected } of cases) {
      const estimate = expectParity(
        [{ ticketTypeId: TT_A, priceCents: 2500, qty: 1 }],
        { platformFixedCents: 50 },
        taxRateBps,
      );
      expect({
        taxCents: estimate.taxCents,
        processorFeeCents: estimate.processorFeeCents,
      }).toEqual(expected);
      expect(estimate.totalCents).toBe(
        2500 + 50 + expected.taxCents + expected.processorFeeCents,
      );
      // The literals above are HEAD's arithmetic, re-derived from the UNCHANGED
      // `solveProcessingFeeGrossUp` over the face-only base — so a drift in
      // either the literal or the function fails here.
      expect(expected.taxCents).toBe(Math.round((2500 * taxRateBps) / 10_000));
      expect(expected.processorFeeCents).toBe(
        solveProcessingFeeGrossUp(2500 + 50 + expected.taxCents, 0.029, 30),
      );
    }
  });

  it("the imposition list is the whole tax input: a second PLATFORM line adds its own rounding", () => {
    const items: EstimateOrderTotalItem[] = [
      { faceCents: 2500, platformFeePerTicketCents: 50, qty: 3 },
    ];
    const shared = {
      items,
      feeMode: "PASS_THROUGH" as const,
      processorPct: 0.029,
      processorFixedCents: 30,
    };
    const sales = estimateOrderTotal({
      ...shared,
      taxImpositions: salesOnly(975),
    });
    const withCity = estimateOrderTotal({
      ...shared,
      taxImpositions: [
        ...salesOnly(975),
        { ...salesOnly(500)[0]!, code: "CITY_AMUSEMENT" },
      ],
    });
    // Sales line unchanged (the pinned face-only 9.75% on 7500); the city
    // line is its own round(7500 × 5%) = 375 on top.
    expect(sales.taxCents).toBe(Math.round((7500 * 975) / 10_000));
    expect(withCity.taxCents).toBe(sales.taxCents + 375);
    expect(withCity.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(7500 + 150 + withCity.taxCents, 0.029, 30),
    );
    // An empty list is no tax at all.
    expect(
      estimateOrderTotal({ ...shared, taxImpositions: [] }).taxCents,
    ).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end parity: rows produced by the REAL server row-builder
// (estimateBuyerTicketPricingForEvent — the shape clients actually receive via
// getCheckoutFeeRates) fed into the estimator. Guards against the row builder
// and the hand-built `estimatorItems` harness drifting apart.
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateOrderTotal — parity with real estimateBuyerTicketPricingForEvent rows", () => {
  // Repos mock mirrors makeContext's policy exactly: buyerFeePct 0,
  // platformFixedCents 30, minFee 0, Stripe 2.9% + 30¢, PASS_THROUGH.
  function makeRowBuilderRepos() {
    const agreement = {
      id: "agreement-1",
      kind: "PRIMARY_SPLIT",
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
      feePolicyId: "policy-1",
      payoutSchedule: "WEEK_OF_EVENT",
      isDefault: false,
      settlementCurrency: "usd",
      version: 1,
    };
    const feePolicy = {
      id: "policy-1",
      scopeType: "EVENT",
      scopeId: "event-1",
      status: "ACTIVE",
      version: 1,
      effectiveTo: null,
      buyerFeePct: 0,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 30,
      feeMode: "PASS_THROUGH",
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0.9,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    };
    return {
      payoutTerms: {
        listByEvent: async () => [agreement],
        listLines: async () => [
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
      },
      feePolicies: {
        getById: async (id: string) => (id === "policy-1" ? feePolicy : null),
        resolveEffective: async () => null,
      },
      events: {},
    } as never;
  }

  const makeSummary = (id: string, priceCents: number) =>
    ({
      id,
      name: "T",
      description: null,
      priceCents,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 100,
      status: "ACTIVE",
      seatSectionId: null,
      resaleAllowed: false,
      resaleCapCents: null,
      transferAllowed: true,
    }) as never;

  async function realRows(
    lines: CartLine[],
    taxRateBps: number,
    taxableBase: TaxableBase = "TICKET_FACE",
  ) {
    const result = await estimateBuyerTicketPricingForEvent(
      { repos: makeRowBuilderRepos(), clock: testClock },
      {
        id: "event-1",
        orgId: "org-1",
        admissionTaxRateBps: taxRateBps,
      } as never,
      lines.map((line) => makeSummary(line.ticketTypeId, line.priceCents)),
      { taxImpositions: salesOnly(taxRateBps, taxableBase) },
    );
    const byId = new Map(
      result.perTicketEstimates.map((row) => [row.ticketTypeId, row]),
    );
    return lines.map((line) => {
      const row = byId.get(line.ticketTypeId)!;
      // Same mapping the web wrapper (order-estimate.ts) applies.
      return {
        faceCents: row.unitPriceCents,
        platformFeePerTicketCents: row.platformFeeCents,
        qty: line.qty,
      };
    });
  }

  it("regression cart via real rows: 2 × $45.00 @ 8.88% → $101.85", async () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    const items = await realRows(lines, 888);
    const estimate = estimateOrderTotal({
      items,
      taxImpositions: salesOnly(888),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    const server = serverBuyerTotal(
      lines,
      makeContext({ platformFixedCents: 30 }),
      888,
    );
    expect(estimate.totalCents).toBe(10_185);
    expect(estimate).toEqual(server);
  });

  it("TN via real rows: 2 × $45.00 @ 9.75% BUYER_TOTAL matches the server", async () => {
    const lines = [{ ticketTypeId: TT_A, priceCents: 4500, qty: 2 }];
    const items = await realRows(lines, 975, "BUYER_TOTAL");
    const estimate = estimateOrderTotal({
      items,
      taxImpositions: salesOnly(975, "BUYER_TOTAL"),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    const server = serverBuyerTotal(
      lines,
      makeContext({ platformFixedCents: 30 }),
      975,
      "BUYER_TOTAL",
    );
    expect(estimate).toEqual(server);
    // Strictly more tax than the same cart on the face-only base.
    const faceOnly = estimateOrderTotal({
      items: await realRows(lines, 975),
      taxImpositions: salesOnly(975),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(estimate.taxCents).toBeGreaterThan(faceOnly.taxCents);
    expect(estimate.totalCents).toBeGreaterThan(faceOnly.totalCents);
  });

  // Owner ruling 2026-10-10: "If $0 is the cost of the tickets there shouldn't
  // be any fee." This case used to be a DECLARED DIVERGENCE: the rows quote a
  // free ticket at zero, while computeOrderAmounts charged max(fixed, minFee)
  // on each free ticket of a paid order, so the estimate sat 2 × 30¢ (plus
  // the processing on it) below the charge. The charge now agrees with the
  // rows.
  it.each([
    ["TICKET_FACE", "fixed 30¢", { platformFixedCents: 30 }],
    ["BUYER_TOTAL", "fixed 30¢", { platformFixedCents: 30 }],
  ] as Array<[TaxableBase, string, PolicyOverrides]>)(
    "mixed free+paid via real rows (%s, %s): estimate === charge === the paid ticket's charge alone",
    async (taxableBase, _policyName, overrides) => {
      const lines = [
        { ticketTypeId: TT_A, priceCents: 4500, qty: 1 },
        { ticketTypeId: TT_B, priceCents: 0, qty: 2 },
      ];
      const items = await realRows(lines, 888, taxableBase);
      const estimate = estimateOrderTotal({
        items,
        taxImpositions: salesOnly(888, taxableBase),
        feeMode: "PASS_THROUGH",
        processorPct: 0.029,
        processorFixedCents: 30,
      });
      const fullServer = serverBuyerTotal(
        lines,
        makeContext(overrides),
        888,
        taxableBase,
      );
      const paidOnlyServer = serverBuyerTotal(
        [lines[0]!],
        makeContext(overrides),
        888,
        taxableBase,
      );

      // The free tickets add nothing to the charge…
      expect(fullServer).toEqual(paidOnlyServer);
      expect(fullServer.platformFeeCents).toBe(30);
      // …and the estimate is that charge, to the cent.
      expect(estimate).toEqual(fullServer);
    },
  );
});

describe("estimateOrderTotal — a $0 ticket carries no fee (owner ruling 2026-10-10)", () => {
  it.each([
    ["fixed part", { buyerFeePct: 0.05, platformFixedCents: 50 }],
    ["minimum fee", { buyerFeePct: 0.05, platformFixedCents: 0, minFeeCents: 50 }],
    [
      "order-level cap",
      { buyerFeePct: 0.05, platformFixedCents: 50, maxPlatformFeeCents: 251 },
    ],
  ] as Array<[string, PolicyOverrides]>)(
    "estimate === charge for paid + free under a %s, on both tax bases",
    (_name, overrides) => {
      const lines = [
        { ticketTypeId: TT_A, priceCents: 3000, qty: 2 },
        { ticketTypeId: TT_B, priceCents: 0, qty: 3 },
      ];
      for (const base of ["TICKET_FACE", "BUYER_TOTAL"] as TaxableBase[]) {
        const mixed = expectParity(lines, overrides, 975, base);
        const paidAlone = expectParity([lines[0]!], overrides, 975, base);
        expect(mixed).toEqual(paidAlone);
      }
    },
  );

  it("holds the rule itself: a $0 line handed a fee still contributes none", () => {
    const paid = { faceCents: 3000, platformFeePerTicketCents: 200, qty: 1 };
    const input = {
      taxImpositions: salesOnly(975, "BUYER_TOTAL"),
      feeMode: "PASS_THROUGH" as const,
      processorPct: 0.029,
      processorFixedCents: 30,
    };
    const alone = estimateOrderTotal({ ...input, items: [paid] });
    const withFree = estimateOrderTotal({
      ...input,
      items: [paid, { faceCents: 0, platformFeePerTicketCents: 50, qty: 2 }],
    });

    expect(alone.platformFeeCents).toBe(200);
    expect(withFree).toEqual(alone);
  });
});

describe("estimateOrderTotal — discountCents (priced like createCheckout)", () => {
  const sales = (base: TaxableBase) => salesOnly(888, base);
  const ITEMS: EstimateOrderTotalItem[] = [
    { faceCents: 3500, platformFeePerTicketCents: 50, qty: 1 },
    { faceCents: 2000, platformFeePerTicketCents: 50, qty: 1 },
  ];

  it("TICKET_FACE: tax and gross-up on gross − discount; the platform fee is untouched", () => {
    const r = estimateOrderTotal({
      items: ITEMS,
      taxImpositions: sales("TICKET_FACE"),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
      discountCents: 550,
    });
    const tax = Math.round((4950 * 888) / 10_000);
    const processor = solveProcessingFeeGrossUp(4950 + 100 + tax, 0.029, 30);
    expect(r).toEqual({
      grossCents: 5500,
      platformFeeCents: 100,
      taxCents: tax,
      processorFeeCents: processor,
      totalCents: 4950 + 100 + tax + processor,
    });
    // The live figure.
    expect(r.totalCents).toBe(5685);
  });

  it("BUYER_TOTAL (TN): the joint solve runs on the DISCOUNTED base", () => {
    const r = estimateOrderTotal({
      items: ITEMS,
      taxImpositions: sales("BUYER_TOTAL"),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
      discountCents: 550,
    });
    // Independent oracle: brute-force the circular tax/processing pair.
    const oracle = referenceBuyerTotalTax(4950 + 100, 888, 0.029, 30);
    expect(r.taxCents).toBe(oracle.taxCents);
    expect(r.processorFeeCents).toBe(oracle.processorFeeCents);
    expect(r.totalCents).toBe(
      4950 + 100 + oracle.taxCents + oracle.processorFeeCents,
    );
  });

  it("ABSORB: face − discount + tax on it; no fees", () => {
    const r = estimateOrderTotal({
      items: ITEMS,
      taxImpositions: sales("TICKET_FACE"),
      feeMode: "ABSORB",
      processorPct: 0.029,
      processorFixedCents: 30,
      discountCents: 550,
    });
    const tax = Math.round((4950 * 888) / 10_000);
    expect(r).toEqual({
      grossCents: 5500,
      platformFeeCents: 0,
      taxCents: tax,
      processorFeeCents: 0,
      totalCents: 4950 + tax,
    });
  });

  it.each([5500, 9999])(
    "a discount of %i ≥ the gross is a free order: nothing charged",
    (discountCents) => {
      expect(
        estimateOrderTotal({
          items: ITEMS,
          taxImpositions: sales("BUYER_TOTAL"),
          feeMode: "PASS_THROUGH",
          processorPct: 0.029,
          processorFixedCents: 30,
          discountCents,
        }),
      ).toEqual({
        grossCents: 5500,
        platformFeeCents: 0,
        taxCents: 0,
        processorFeeCents: 0,
        totalCents: 0,
      });
    },
  );

  it("omitted / 0 / negative discount changes nothing", () => {
    const base = {
      items: ITEMS,
      taxImpositions: sales("TICKET_FACE"),
      feeMode: "PASS_THROUGH" as const,
      processorPct: 0.029,
      processorFixedCents: 30,
    };
    const none = estimateOrderTotal(base);
    expect(estimateOrderTotal({ ...base, discountCents: 0 })).toEqual(none);
    expect(estimateOrderTotal({ ...base, discountCents: -100 })).toEqual(none);
  });
});

// Owner ruling, 2026-10-10: "yes a promo brought down to $0 should have no fee
// too." The charge takes no platform fee for a ticket a discount makes free;
// `previewPromos` reports how much fee that is (`platformFeeReductionCents`,
// net of the order cap) and the estimate subtracts it. The end-to-end parity
// against the real charge is `apps/web/src/lib/pricing/
// promo-to-zero-create-checkout.test.ts`; these pin the arithmetic.
describe("estimateOrderTotal — platformFeeReductionCents (a ticket a discount made free)", () => {
  const sales = (base: TaxableBase) => salesOnly(975, base);
  // $30 (200¢ fee) + $50 (300¢ fee) on 5% + 50¢; a code makes the $50 free.
  const MIXED: EstimateOrderTotalItem[] = [
    { faceCents: 3000, platformFeePerTicketCents: 200, qty: 1 },
    { faceCents: 5000, platformFeePerTicketCents: 300, qty: 1 },
  ];
  const ALONE: EstimateOrderTotalItem[] = [
    { faceCents: 3000, platformFeePerTicketCents: 200, qty: 1 },
  ];
  const rates = {
    feeMode: "PASS_THROUGH" as const,
    processorPct: 0.029,
    processorFixedCents: 30,
  };

  it.each(["TICKET_FACE", "BUYER_TOTAL"] as TaxableBase[])(
    "%s: the cart with the free ticket is estimated at the paid ticket's own total",
    (base) => {
      const mixed = estimateOrderTotal({
        items: MIXED,
        taxImpositions: sales(base),
        ...rates,
        discountCents: 5000,
        platformFeeReductionCents: 300,
      });
      const alone = estimateOrderTotal({
        items: ALONE,
        taxImpositions: sales(base),
        ...rates,
      });
      expect(mixed.platformFeeCents).toBe(200);
      expect(mixed.taxCents).toBe(alone.taxCents);
      expect(mixed.processorFeeCents).toBe(alone.processorFeeCents);
      expect(mixed.totalCents).toBe(alone.totalCents);
      // `grossCents` stays the pre-discount subtotal, as before.
      expect(mixed.grossCents).toBe(8000);
    },
  );

  it("pins the Tennessee figure: $36.62, not the $40.03 the fee on the free ticket made it", () => {
    const input = {
      items: MIXED,
      taxImpositions: sales("BUYER_TOTAL"),
      ...rates,
      discountCents: 5000,
    };
    expect(estimateOrderTotal(input).totalCents).toBe(4003);
    expect(
      estimateOrderTotal({ ...input, platformFeeReductionCents: 300 }).totalCents,
    ).toBe(3662);
  });

  it("comes off AFTER the order-level cap, because the figure is already net of it", () => {
    // Cap 251¢: the two fees (500¢) cap to 251¢, and the paid ticket's 200¢
    // alone is under the cap. The preview reports 251 − 200 = 51, not 300.
    const mixed = estimateOrderTotal({
      items: MIXED,
      taxImpositions: sales("BUYER_TOTAL"),
      ...rates,
      maxPlatformFeeCents: 251,
      discountCents: 5000,
      platformFeeReductionCents: 51,
    });
    const alone = estimateOrderTotal({
      items: ALONE,
      taxImpositions: sales("BUYER_TOTAL"),
      ...rates,
      maxPlatformFeeCents: 251,
    });
    expect(mixed.platformFeeCents).toBe(200);
    expect(mixed.totalCents).toBe(alone.totalCents);
  });

  it("never drives the fee below zero, and omitted / 0 / negative changes nothing", () => {
    const base = {
      items: MIXED,
      taxImpositions: sales("TICKET_FACE"),
      ...rates,
      discountCents: 1000,
    };
    const none = estimateOrderTotal(base);
    expect(estimateOrderTotal({ ...base, platformFeeReductionCents: 0 })).toEqual(none);
    expect(estimateOrderTotal({ ...base, platformFeeReductionCents: -50 })).toEqual(none);
    expect(
      estimateOrderTotal({ ...base, platformFeeReductionCents: 99_999 }).platformFeeCents,
    ).toBe(0);
  });
});

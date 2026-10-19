import { describe, expect, it, vi } from "vitest";

import { computePlatformFeePerTicketCents } from "../../../lib/pricing/compute-ticket-price-for-agreement";
import { estimateOrderTotal } from "../../../lib/pricing/estimate-order-total";
import { MAX_DONATION_AMOUNT_CENTS } from "../../../lib/pricing/pay-what-you-want";
import { createCheckoutInputSchema } from "../../orders/create-checkout";
import { updateOrderItemsInputSchema } from "../../orders/update-order-items";
import { recordCashSaleInputSchema } from "../../pos/record-cash-sale";
import { startPosSaleInputSchema } from "../../pos/start-pos-sale";
import { summarizePricing } from "../_shared/event-pricing";
import { estimateCheckoutTax } from "../estimate-checkout-tax";
import { getCheckoutFeeRates } from "../get-checkout-fee-rates";

/**
 * Pay-what-you-want (ADJUSTABLE) quotes.
 *
 * The rule: the buyer's chosen amount IS the ticket price. Platform fee,
 * processing and tax go on top exactly as for a FIXED tier whose price equals
 * that amount — `computeOrderAmounts` charges it that way (unit = donation).
 * So every assertion here is a parity check: a PWYW amount X must quote the
 * same as a FIXED tier priced X.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PWYW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIXED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const CHOSEN_CENTS = 1500;
const RATE_BPS = 975;

const clock = { now: () => new Date("2026-06-01T00:00:00.000Z") };

type Situs = { countryCode: string; region: string; postalCode: string };
const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };
const MIAMI: Situs = { countryCode: "US", region: "FL", postalCode: "33139" };

function tier(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    name: id === PWYW_ID ? "Pay What You Want" : "General",
    description: null,
    priceCents: 0,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE",
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
    ...overrides,
  };
}

/** 3.33% capped at 50¢ per ticket, PASS_THROUGH, Stripe card rate. */
function makeRepos(
  situs: Situs,
  feeMode: "PASS_THROUGH" | "ABSORB",
  { minFeeCents = 0, pwywStatus = "ACTIVE" } = {},
) {
  const feePolicy = {
    id: "policy-1",
    version: 1,
    status: "ACTIVE",
    scopeType: "GLOBAL",
    scopeId: null,
    effectiveTo: null,
    feeMode,
    buyerFeePct: 0.0333,
    maxFeeCents: 50,
    minFeeCents,
    maxPlatformFeeCents: null,
    platformFixedCents: 0,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };
  return {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        title: "Gallery Walk",
        slug: "gallery-walk",
        status: "PUBLISHED",
        currency: "usd",
        admissionTaxRateBps: RATE_BPS,
        placeId: null,
        savedLocationId: null,
        ...situs,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: null,
      })),
      listTicketTypes: vi.fn(async () => [
        tier(PWYW_ID, {
          pricingMode: "ADJUSTABLE",
          minimumCents: 500,
          suggestedCents: 1500,
          status: pwywStatus,
        }),
        tier(FIXED_ID, { priceCents: CHOSEN_CENTS }),
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: "agreement-1",
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode,
          feePolicyId: "policy-1",
          version: 1,
        },
      ]),
      listLines: vi.fn(async () => [
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
      ]),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) =>
        id === "policy-1" ? feePolicy : null,
      ),
      resolveEffective: vi.fn(async () => null),
    },
    places: { getById: vi.fn(async () => null) },
    savedLocations: { getById: vi.fn(async () => null) },
  } as never as Parameters<typeof getCheckoutFeeRates>[0]["repos"];
}

describe("getCheckoutFeeRates — platformFeeRates for a buyer-chosen amount", () => {
  it("PASS_THROUGH: the rates price a PWYW amount exactly like a FIXED tier of that price", async () => {
    const result = await getCheckoutFeeRates(
      { repos: makeRepos(MIAMI, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID },
    );

    expect(result.platformFeeRates).toEqual({
      buyerFeePct: 0.0333,
      maxFeeCents: 50,
      minFeeCents: 0,
      platformFixedCents: 0,
    });
    const fixedRow = result.perTicketEstimates.find(
      (row) => row.ticketTypeId === FIXED_ID,
    )!;
    // round(1500 × 3.33%) = 50 → at the 50¢ cap.
    expect(fixedRow.platformFeeCents).toBe(50);
    expect(
      computePlatformFeePerTicketCents(
        CHOSEN_CENTS,
        result.platformFeeRates!,
      ),
    ).toBe(fixedRow.platformFeeCents);
    // Below the cap too: $7.50 → round(24.975) = 25¢.
    expect(
      computePlatformFeePerTicketCents(750, result.platformFeeRates!),
    ).toBe(25);
  });

  it("a policy still saying ABSORB: fees go on top, so the rates are returned", async () => {
    // ABSORB is removed (docs/decisions/absorb-removed.md); it used to return
    // null rates here. A legacy row prices like PASS_THROUGH.
    const legacy = await getCheckoutFeeRates(
      { repos: makeRepos(MIAMI, "ABSORB"), clock },
      { eventId: EVENT_ID },
    );
    const passThrough = await getCheckoutFeeRates(
      { repos: makeRepos(MIAMI, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID },
    );
    expect(legacy.feeMode).toBe("PASS_THROUGH");
    expect(legacy.platformFeeRates).not.toBeNull();
    expect(legacy).toEqual(passThrough);
  });
});

describe("estimateCheckoutTax — a PWYW line is taxed on the chosen amount", () => {
  const quote = (
    situs: Situs,
    item: { ticketTypeId: string; qty: number; donationAmountCents?: number },
  ) =>
    estimateCheckoutTax(
      { repos: makeRepos(situs, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID, items: [item] },
    );

  it.each([
    ["TICKET_FACE (FL)", MIAMI],
    ["BUYER_TOTAL (TN)", NASHVILLE],
  ])(
    "%s: PWYW $15 × 2 quotes the same tax as FIXED $15 × 2",
    async (_label, situs) => {
      const pwyw = await quote(situs, {
        ticketTypeId: PWYW_ID,
        qty: 2,
        donationAmountCents: CHOSEN_CENTS,
      });
      const fixed = await quote(situs, { ticketTypeId: FIXED_ID, qty: 2 });

      expect(fixed.taxAmountCents).toBeGreaterThan(0);
      expect(pwyw.taxAmountCents).toBe(fixed.taxAmountCents);
    },
  );

  it("the chosen amount is ignored on a FIXED tier (its price is not the buyer's to name)", async () => {
    const withStray = await quote(MIAMI, {
      ticketTypeId: FIXED_ID,
      qty: 1,
      donationAmountCents: 1,
    });
    const plain = await quote(MIAMI, { ticketTypeId: FIXED_ID, qty: 1 });
    expect(withStray.taxAmountCents).toBe(plain.taxAmountCents);
  });

  it("a PWYW line without an amount is quoted at its floor, never its stored $0", async () => {
    const result = await quote(MIAMI, { ticketTypeId: PWYW_ID, qty: 1 });
    // round(500 × 9.75%) = 49
    expect(result.taxAmountCents).toBe(49);
  });

  // Owner ruling 2026-10-10: "If $0 is the cost of the tickets there shouldn't
  // be any fee." This case used to pin the opposite: the $0 line was charged
  // the policy's minimum fee, and under BUYER_TOTAL that fee was taxed.
  it("keeps a $0 PWYW line, which pays no fee: under BUYER_TOTAL it adds no tax, whatever the minimum fee", async () => {
    type Item = { ticketTypeId: string; qty: number; donationAmountCents?: number };
    const PAID: Item = { ticketTypeId: FIXED_ID, qty: 1 };
    const FREE_PWYW: Item = { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 0 };
    const run = (minFeeCents: number, items: Item[]) =>
      estimateCheckoutTax(
        { repos: makeRepos(NASHVILLE, "PASS_THROUGH", { minFeeCents }), clock },
        { eventId: EVENT_ID, items },
      );
    // A 150¢ minimum: the $15 ticket's fee is max(50, 150) = 150¢.
    const withMinFee = await run(150, [PAID, FREE_PWYW]);
    const expected = estimateOrderTotal({
      items: [
        { faceCents: CHOSEN_CENTS, platformFeePerTicketCents: 150, qty: 1 },
        // $0 face: no fee, so nothing of it reaches the taxable base.
        { faceCents: 0, platformFeePerTicketCents: 0, qty: 1 },
      ],
      taxImpositions: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: RATE_BPS,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
        },
      ],
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(withMinFee.taxAmountCents).toBe(expected.taxCents);
    // The $0 line adds nothing: the tax is the paid ticket's tax alone.
    expect(withMinFee.taxAmountCents).toBe(
      (await run(150, [PAID])).taxAmountCents,
    );
    // And the minimum IS live in this fixture (it moves the paid ticket's fee,
    // and so the tax), so the $0 line is not passing by a minimum of zero.
    expect(withMinFee.taxAmountCents).toBeGreaterThan(
      (await run(0, [PAID, FREE_PWYW])).taxAmountCents,
    );
  });

  it("refuses an INACTIVE PWYW tier under BUYER_TOTAL, like a fixed one", async () => {
    await expect(
      estimateCheckoutTax(
        {
          repos: makeRepos(NASHVILLE, "PASS_THROUGH", { pwywStatus: "PAUSED" }),
          clock,
        },
        {
          eventId: EVENT_ID,
          items: [
            { ticketTypeId: PWYW_ID, qty: 1, donationAmountCents: 1500 },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });
  });

  it("refuses an amount above the $10,000.00 per-ticket cap", async () => {
    await expect(
      quote(MIAMI, {
        ticketTypeId: PWYW_ID,
        qty: 1,
        donationAmountCents: MAX_DONATION_AMOUNT_CENTS + 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
          code: "invalid_input",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: expect.arrayContaining(["donationAmountCents"]),
              message: expect.stringMatching(/\$10,000\.00 per-ticket maximum/),
            }),
          ]),
        }),
    );
    await expect(
      quote(MIAMI, {
        ticketTypeId: PWYW_ID,
        qty: 1,
        donationAmountCents: MAX_DONATION_AMOUNT_CENTS,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("the $10,000.00 cap on the charge inputs", () => {
  const item = (donationAmountCents: number) => ({
    ticketTypeId: PWYW_ID,
    qty: 1,
    donationAmountCents,
  });

  it.each([
    [
      "createCheckout",
      (d: number) =>
        createCheckoutInputSchema.safeParse({
          eventId: EVENT_ID,
          items: [item(d)],
          termsAccepted: true,
          refundPolicyAccepted: true,
        }),
    ],
    [
      "updateOrderItems",
      (d: number) =>
        updateOrderItemsInputSchema.safeParse({
          eventId: EVENT_ID,
          items: [item(d)],
        }),
    ],
  ] as const)("%s refuses one cent over, with a readable message", (_n, parse) => {
    const over = parse(MAX_DONATION_AMOUNT_CENTS + 1);
    expect(over.success).toBe(false);
    const issue = over.error!.issues.find((i) =>
      i.path.includes("donationAmountCents"),
    );
    expect(issue?.message).toMatch(/\$10,000\.00 per-ticket maximum/);
    // 2^31 — the Int overflow that used to reach the database as a 500.
    expect(parse(2 ** 31).success).toBe(false);
  });
});

describe("listing prices quote a PWYW tier at its floor", () => {
  it("getCheckoutFeeRates prices the PWYW row at the $5 floor, fees on top", async () => {
    const result = await getCheckoutFeeRates(
      { repos: makeRepos(MIAMI, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID },
    );
    const row = result.perTicketEstimates.find(
      (r) => r.ticketTypeId === PWYW_ID,
    )!;
    expect(row.unitPriceCents).toBe(500);
    expect(row.platformFeeCents).toBe(
      computePlatformFeePerTicketCents(500, result.platformFeeRates!),
    );
    expect(row.buyerUnitTotalCents).toBeGreaterThan(500);
  });

  it("summarizePricing: a $5-minimum tier is paid, a $0-minimum tier is pay-what-you-want (not free)", () => {
    const now = clock.now();
    const base = tier(PWYW_ID, {
      pricingMode: "ADJUSTABLE",
      minimumCents: 500,
      suggestedCents: 1500,
    });
    expect(summarizePricing([base], now)).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: 500,
    });
    // Owner ruling 2026-10-06 (F2): a floor-0 PWYW tier never reads "Free".
    expect(summarizePricing([{ ...base, minimumCents: 0 }], now)).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: true,
      paidTierCount: 0,
      minPaidPriceCents: null,
    });
    // An unset minimum is a floor of 0 too.
    expect(
      summarizePricing([{ ...base, minimumCents: null }], now)
        .hasPayWhatYouWantTier,
    ).toBe(true);
  });

  it("summarizePricing: floor-0 PWYW beside free and paid tiers keeps both flags apart", () => {
    const now = clock.now();
    const pwyw = tier(PWYW_ID, {
      pricingMode: "ADJUSTABLE",
      minimumCents: 0,
      suggestedCents: 1500,
    });
    const free = tier("tt-free", { priceCents: 0 });
    const paid = tier("tt-paid", { priceCents: 2500 });
    expect(summarizePricing([pwyw, free, paid], now)).toEqual({
      hasFreeTier: true,
      hasPayWhatYouWantTier: true,
      paidTierCount: 1,
      minPaidPriceCents: 2500,
    });
    // An archived floor-0 PWYW tier contributes nothing.
    expect(
      summarizePricing([{ ...pwyw, status: "ARCHIVED" }, paid], now),
    ).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: 2500,
    });
  });
});

describe("the $10,000.00 cap on the POS inputs (same shared schema)", () => {
  const donationIssue = (
    schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
    donationAmountCents: number,
  ) =>
    schema
      .safeParse({
        eventId: EVENT_ID,
        items: [{ ticketTypeId: PWYW_ID, qty: 1, donationAmountCents }],
      })
      .error?.issues.find((i) => i.path.includes("donationAmountCents"));

  it.each([
    ["recordCashSale", recordCashSaleInputSchema],
    ["startPosSale", startPosSaleInputSchema],
  ] as const)("%s refuses one cent over the cap, accepts the cap", (_n, schema) => {
    expect(
      donationIssue(schema as never, MAX_DONATION_AMOUNT_CENTS + 1)?.message,
    ).toMatch(/\$10,000\.00 per-ticket maximum/);
    expect(donationIssue(schema as never, MAX_DONATION_AMOUNT_CENTS)).toBeUndefined();
  });
});

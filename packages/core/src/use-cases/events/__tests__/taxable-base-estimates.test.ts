import { describe, expect, it, vi } from "vitest";

// Test seam: lets a case inject local impositions into the REAL resolver
// (its `rules` parameter) without touching the shipped, empty table.
const seam = vi.hoisted(() => ({
  rules: undefined as undefined | ReadonlyArray<unknown>,
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) =>
      actual.resolveTaxImpositions(
        args,
        seam.rules as Parameters<typeof actual.resolveTaxImpositions>[1],
      ),
  };
});

import { estimateOrderTotal } from "../../../lib/pricing/estimate-order-total";
import { solveProcessingFeeGrossUp } from "../../../lib/pricing/processing-cost-schedule";
import { estimateBuyerTicketPricingForEvent } from "../_shared/estimate-buyer-ticket-pricing";
import { estimateCheckoutTax } from "../estimate-checkout-tax";
import { getCheckoutFeeRates } from "../get-checkout-fee-rates";
import type { TaxImposition } from "../../../lib/pricing/tax-impositions";
import type { TaxableBase } from "../../../lib/pricing/taxable-base";

/**
 * The BUYER-FACING estimates under a jurisdictional taxable base.
 *
 * The charge side is pinned in `orders/__tests__/create-checkout.test.ts`
 * ("jurisdictional taxable base"): the SAME fixture — $25 face, $0.50 flat
 * platform fee, Stripe 2.9% + 30¢, PASS_THROUGH, Nashville at 9.75% — charges
 * tax 260¢, processor 115¢, total 2925¢. Every estimate here has to land on
 * those exact numbers, because a quote that differs from the charge is the
 * defect, not a rounding detail.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const FACE_CENTS = 2500;
const PLATFORM_FEE_CENTS = 50;
const NASHVILLE_BPS = 975;

/** What the charge path produces for this fixture (pinned in create-checkout). */
const TN_CHARGE = { taxCents: 260, processorFeeCents: 115, totalCents: 2925 };
/** What HEAD produced for the same fixture on a face-only base. */
const FACE_CHARGE = { taxCents: 244, processorFeeCents: 115, totalCents: 2909 };

const clock = { now: () => new Date("2026-06-01T00:00:00.000Z") };

/** A Nashville-rate SALES line on an explicit base (for base-threading cases). */
function salesAt(base: TaxableBase): TaxImposition[] {
  return [
    {
      code: "SALES",
      label: "Sales tax",
      jurisdiction: "US/TN",
      rateBps: NASHVILLE_BPS,
      base,
      collector: "PLATFORM",
    },
  ];
}

type Situs = {
  countryCode: string | null;
  region: string | null;
  postalCode: string | null;
};

const NASHVILLE: Situs = {
  countryCode: "US",
  region: "TN",
  postalCode: "37203",
};
const MIAMI: Situs = { countryCode: "US", region: "FL", postalCode: "33139" };
const SAN_FRANCISCO: Situs = {
  countryCode: "US",
  region: "CA",
  postalCode: "94103",
};
const NO_SITUS: Situs = { countryCode: null, region: null, postalCode: null };

function makeEvent(situs: Situs, admissionTaxRateBps: number) {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Nashville Show",
    slug: "nashville-show",
    status: "PUBLISHED",
    currency: "usd",
    admissionTaxRateBps,
    // INLINE jurisdiction — `eventTaxRateLocationRef` resolves it with no
    // Place / SavedLocation read at all.
    placeId: null,
    savedLocationId: null,
    postalCode: situs.postalCode,
    countryCode: situs.countryCode,
    region: situs.region,
    startsAt: new Date("2026-12-01T20:00:00.000Z"),
    endsAt: null,
  };
}

function makeTicketType() {
  return {
    id: TT_ID,
    name: "General",
    description: null,
    priceCents: FACE_CENTS,
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
  };
}

/**
 * PASS_THROUGH policy matching the create-checkout fixture: flat 50¢ platform
 * fee per ticket, Stripe card rate, no caps.
 */
function makeRepos(situs: Situs, admissionTaxRateBps = NASHVILLE_BPS) {
  const feePolicy = {
    id: "policy-1",
    version: 1,
    status: "ACTIVE",
    scopeType: "GLOBAL",
    scopeId: null,
    effectiveTo: null,
    feeMode: "PASS_THROUGH",
    buyerFeePct: 0,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: PLATFORM_FEE_CENTS,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };
  return {
    events: {
      getById: vi.fn(async () => makeEvent(situs, admissionTaxRateBps)),
      listTicketTypes: vi.fn(async () => [makeTicketType()]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: "agreement-1",
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "PASS_THROUGH",
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
      getById: vi.fn(async (id: string) => (id === "policy-1" ? feePolicy : null)),
      resolveEffective: vi.fn(async () => null),
    },
    // Present but never called for an inline jurisdiction — a read here would be
    // an unnecessary query on the hottest checkout path.
    places: { getById: vi.fn(async () => null) },
    savedLocations: { getById: vi.fn(async () => null) },
  } as never as Parameters<typeof getCheckoutFeeRates>[0]["repos"] & {
    events: { listTicketTypes: ReturnType<typeof vi.fn> };
    payoutTerms: { listByEvent: ReturnType<typeof vi.fn> };
    places: { getById: ReturnType<typeof vi.fn> };
    savedLocations: { getById: ReturnType<typeof vi.fn> };
  };
}

describe("getCheckoutFeeRates — jurisdictional taxable base", () => {
  it("TN: reports BUYER_TOTAL and quotes the CHARGE, to the cent", async () => {
    const repos = makeRepos(NASHVILLE);
    const result = await getCheckoutFeeRates({ repos, clock }, {
      eventId: EVENT_ID,
    });

    expect(result.taxableBase).toBe("BUYER_TOTAL");
    // The list clients charge from: exactly the TN SALES line on the total.
    expect(result.taxImpositions).toEqual(salesAt("BUYER_TOTAL"));
    const row = result.perTicketEstimates[0]!;
    expect(row.taxEstimateCents).toBe(TN_CHARGE.taxCents);
    expect(row.processorFeeCents).toBe(TN_CHARGE.processorFeeCents);
    expect(row.buyerUnitTotalCents).toBe(TN_CHARGE.totalCents);

    // The order-level estimate a client runs over these rows — the number the
    // cart actually shows — must equal the charge too.
    const cart = estimateOrderTotal({
      items: [
        {
          faceCents: row.unitPriceCents,
          platformFeePerTicketCents: row.platformFeeCents,
          qty: 1,
        },
      ],
      taxImpositions: result.taxImpositions,
      feeMode: result.feeMode,
      processorPct: result.processorPct ?? 0,
      processorFixedCents: result.processorFixedCents ?? 0,
      maxPlatformFeeCents: result.maxPlatformFeeCents,
    });
    expect(cart.taxCents).toBe(TN_CHARGE.taxCents);
    expect(cart.processorFeeCents).toBe(TN_CHARGE.processorFeeCents);
    expect(cart.totalCents).toBe(TN_CHARGE.totalCents);
  });

  it("an inline jurisdiction costs ZERO extra repo reads", async () => {
    const repos = makeRepos(NASHVILLE);
    await getCheckoutFeeRates({ repos, clock }, { eventId: EVENT_ID });
    expect(repos.places.getById).not.toHaveBeenCalled();
    expect(repos.savedLocations.getById).not.toHaveBeenCalled();
  });

  it.each([
    ["US/FL", MIAMI],
    ["US/CA", SAN_FRANCISCO],
    ["no situs", NO_SITUS],
  ])("%s: TICKET_FACE, byte-identical to HEAD", async (_label, situs) => {
    const result = await getCheckoutFeeRates(
      { repos: makeRepos(situs), clock },
      { eventId: EVENT_ID },
    );

    expect(result.taxableBase).toBe("TICKET_FACE");
    const row = result.perTicketEstimates[0]!;
    expect(row.taxEstimateCents).toBe(FACE_CHARGE.taxCents);
    expect(row.processorFeeCents).toBe(FACE_CHARGE.processorFeeCents);
    expect(row.buyerUnitTotalCents).toBe(FACE_CHARGE.totalCents);
    // HEAD's arithmetic, spelled out.
    expect(row.taxEstimateCents).toBe(
      Math.round((FACE_CENTS * NASHVILLE_BPS) / 10_000),
    );
    expect(row.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(
        FACE_CENTS + PLATFORM_FEE_CENTS + FACE_CHARGE.taxCents,
        0.029,
        30,
      ),
    );
  });
});

describe("estimateCheckoutTax — jurisdictional taxable base", () => {
  const run = async (situs: Situs, qty = 1, bps = NASHVILLE_BPS) =>
    estimateCheckoutTax(
      { repos: makeRepos(situs, bps), clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty }] },
    );

  it("TN: the 'Est. tax' line is the tax the buyer is charged", async () => {
    expect((await run(NASHVILLE)).taxAmountCents).toBe(TN_CHARGE.taxCents);
  });

  it("TN: a 2-ticket cart taxes the ORDER-level buyer total, not 2× a per-ticket tax", async () => {
    const { taxAmountCents } = await run(NASHVILLE, 2);

    // gross 5000 + platform 100 → one order-level gross-up, one tax rounding.
    const orderLevel = estimateOrderTotal({
      items: [
        {
          faceCents: FACE_CENTS,
          platformFeePerTicketCents: PLATFORM_FEE_CENTS,
          qty: 2,
        },
      ],
      taxImpositions: salesAt("BUYER_TOTAL"),
      feeMode: "PASS_THROUGH",
      processorPct: 0.029,
      processorFixedCents: 30,
    });
    expect(taxAmountCents).toBe(orderLevel.taxCents);
    // Strictly less than doubling the single-ticket tax: the 30¢ fixed
    // processor fee is charged once per ORDER, so the base is not 2× either.
    expect(taxAmountCents).toBeLessThan(TN_CHARGE.taxCents * 2);
  });

  it.each([
    ["US/FL", MIAMI],
    ["US/CA", SAN_FRANCISCO],
    ["no situs", NO_SITUS],
  ])("%s: byte-identical to HEAD (round(subtotal × rate))", async (_l, situs) => {
    expect((await run(situs)).taxAmountCents).toBe(FACE_CHARGE.taxCents);
    expect((await run(situs, 3)).taxAmountCents).toBe(
      Math.round((FACE_CENTS * 3 * NASHVILLE_BPS) / 10_000),
    );
  });

  it("a zero rate collects nothing, TN or not", async () => {
    expect((await run(NASHVILLE, 1, 0)).taxAmountCents).toBe(0);
    expect((await run(NASHVILLE, 1, 0)).taxRateBps).toBeNull();
  });

  it("refuses an INACTIVE tier under BUYER_TOTAL rather than quoting it a 0 fee", async () => {
    // The estimator only prices ACTIVE tiers, so an inactive-but-requested type
    // has no row. Treating a missing row as "no platform fee" would silently
    // UNDER-state the taxable base — a wrong tax on a cart that cannot be
    // bought anyway. Refuse, exactly as the unit-price loop refuses an unknown
    // type.
    const repos = makeRepos(NASHVILLE);
    (repos.events.listTicketTypes as ReturnType<typeof vi.fn>).mockImplementation(
      async () => [{ ...makeTicketType(), status: "PAUSED" }],
    );

    await expect(
      estimateCheckoutTax(
        { repos, clock },
        { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });
  });

  it("an INACTIVE tier on a TICKET_FACE event still quotes (unchanged behaviour)", async () => {
    const repos = makeRepos(MIAMI);
    (repos.events.listTicketTypes as ReturnType<typeof vi.fn>).mockImplementation(
      async () => [{ ...makeTicketType(), status: "PAUSED" }],
    );

    const result = await estimateCheckoutTax(
      { repos, clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(result.taxAmountCents).toBe(FACE_CHARGE.taxCents);
  });

  it("TICKET_FACE does NOT pay for the fee-policy reads a BUYER_TOTAL base needs", async () => {
    const faceRepos = makeRepos(MIAMI);
    await estimateCheckoutTax(
      { repos: faceRepos, clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(faceRepos.payoutTerms.listByEvent).not.toHaveBeenCalled();

    const tnRepos = makeRepos(NASHVILLE);
    await estimateCheckoutTax(
      { repos: tnRepos, clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(tnRepos.payoutTerms.listByEvent).toHaveBeenCalled();
  });
});

describe("estimateBuyerTicketPricingForEvent — base threading", () => {
  it("TICKET_FACE keeps the pre-change per-ticket tax", async () => {
    const result = await estimateBuyerTicketPricingForEvent(
      { repos: makeRepos(NASHVILLE), clock },
      makeEvent(NASHVILLE, NASHVILLE_BPS) as never,
      [makeTicketType()] as never,
      { taxImpositions: salesAt("TICKET_FACE") },
    );
    expect(result.taxImpositions[0]!.base).toBe("TICKET_FACE");
    expect(result.perTicketEstimates[0]!.taxEstimateCents).toBe(
      FACE_CHARGE.taxCents,
    );
  });

  it("the imposition list is REQUIRED — omitting it cannot silently price with no tax / the face base", async () => {
    // A silent `TICKET_FACE` default is what let four money-adjacent surfaces
    // (both seat maps, the search index, JSON-LD) keep the pre-Tennessee base
    // while looking migrated. The type makes omission a compile error; this pins
    // the runtime half, so an `as never` cast in a future caller cannot slip
    // through either.
    await expect(
      estimateBuyerTicketPricingForEvent(
        { repos: makeRepos(NASHVILLE), clock },
        makeEvent(NASHVILLE, NASHVILLE_BPS) as never,
        [makeTicketType()] as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("widens the per-ticket tax when the base is threaded in", async () => {
    const result = await estimateBuyerTicketPricingForEvent(
      { repos: makeRepos(NASHVILLE), clock },
      makeEvent(NASHVILLE, NASHVILLE_BPS) as never,
      [makeTicketType()] as never,
      { taxImpositions: salesAt("BUYER_TOTAL") },
    );
    expect(result.taxImpositions[0]!.base).toBe("BUYER_TOTAL");
    expect(result.perTicketEstimates[0]!.taxEstimateCents).toBe(
      TN_CHARGE.taxCents,
    );
    // The numeric rates the order-level solve needs come back too.
    expect(result.processorPct).toBe(0.029);
    expect(result.processorFixedCents).toBe(30);
    expect(result.maxPlatformFeeCents).toBeNull();
  });

  it("a free tier is untouched by the base", async () => {
    const result = await estimateBuyerTicketPricingForEvent(
      { repos: makeRepos(NASHVILLE), clock },
      makeEvent(NASHVILLE, NASHVILLE_BPS) as never,
      [{ ...makeTicketType(), priceCents: 0 }] as never,
      { taxImpositions: salesAt("BUYER_TOTAL") },
    );
    expect(result.perTicketEstimates[0]).toMatchObject({
      unitPriceCents: 0,
      taxEstimateCents: 0,
      buyerUnitTotalCents: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A NULL stamp is "unresolved", not 0%. Checkout resolves the rate live
// (`resolveCheckoutTax`: Canada table → venue cache → ZipTax), so these quotes
// take every answer it reaches without the provider (`resolveQuoteTaxRateBps`).
// ─────────────────────────────────────────────────────────────────────────────
describe("checkout quotes — NULL admission-tax stamp", () => {
  const PLACE_ID = "33333333-3333-4333-8333-333333333333";

  /** An unstamped event at a Nashville Place whose cached rate is `cached`. */
  function unstampedAtPlace(cached: number | null) {
    const repos = makeRepos(NASHVILLE);
    (repos.events.getById as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        ...makeEvent(NO_SITUS, 0),
        admissionTaxRateBps: null,
        placeId: PLACE_ID,
      }),
    );
    repos.places.getById.mockImplementation(async () => ({
      id: PLACE_ID,
      ...NASHVILLE,
      admissionTaxRateBps: cached,
      taxRateSource: cached == null ? null : "ziptax",
    }));
    return repos;
  }

  it("getCheckoutFeeRates: the venue's cached rate prices the quote at the CHARGE", async () => {
    const result = await getCheckoutFeeRates(
      { repos: unstampedAtPlace(NASHVILLE_BPS), clock },
      { eventId: EVENT_ID },
    );
    expect(result.admissionTaxRateBps).toBe(NASHVILLE_BPS);
    expect(result.taxImpositions).toEqual(salesAt("BUYER_TOTAL"));
    const row = result.perTicketEstimates[0]!;
    expect(row.taxEstimateCents).toBe(TN_CHARGE.taxCents);
    expect(row.buyerUnitTotalCents).toBe(TN_CHARGE.totalCents);
  });

  it("getCheckoutFeeRates: no cached rate → the rate is reported UNKNOWN (null), not resolved", async () => {
    const result = await getCheckoutFeeRates(
      { repos: unstampedAtPlace(null), clock },
      { eventId: EVENT_ID },
    );
    // OPEN (owner decision): the per-ticket rows still tax at 0 here; the
    // payload has no "unknown" value for them. Only the rate is asserted.
    expect(result.admissionTaxRateBps).toBeNull();
  });

  it("estimateCheckoutTax: the venue's cached rate is the 'Est. tax' the buyer is charged", async () => {
    const result = await estimateCheckoutTax(
      { repos: unstampedAtPlace(NASHVILLE_BPS), clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(result.taxAmountCents).toBe(TN_CHARGE.taxCents);
    expect(result.taxRateBps).toBe(NASHVILLE_BPS);
  });

  it("a STALE TN stamp on an instruction-only event quotes 0 tax, as checkout charges", async () => {
    const repos = makeRepos(NASHVILLE);
    (repos.events.getById as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({ ...makeEvent(NASHVILLE, NASHVILLE_BPS), instructionalAdmission: true }),
    );
    const tax = await estimateCheckoutTax(
      { repos, clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(tax.taxAmountCents).toBe(0);
    expect(tax.taxRateBps).toBeNull();
    const rates = await getCheckoutFeeRates({ repos, clock }, { eventId: EVENT_ID });
    expect(rates.admissionTaxRateBps).toBe(0);
    expect(rates.perTicketEstimates[0]!.taxEstimateCents).toBe(0);
  });

  it("a STAMPED event is unchanged and reads no venue cache", async () => {
    const repos = makeRepos(NASHVILLE);
    const rates = await getCheckoutFeeRates({ repos, clock }, { eventId: EVENT_ID });
    const tax = await estimateCheckoutTax(
      { repos, clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(rates.perTicketEstimates[0]!.buyerUnitTotalCents).toBe(
      TN_CHARGE.totalCents,
    );
    expect(tax.taxAmountCents).toBe(TN_CHARGE.taxCents);
    expect(repos.places.getById).not.toHaveBeenCalled();
  });
});

// `region: "TN"` is deliberate: it matches the Nashville fixture so the rule applies.
const MPLS_RULE = {
  code: "MPLS_ENTERTAINMENT",
  label: "Minneapolis entertainment tax",
  jurisdiction: "US/MN/Minneapolis",
  countryCode: "US",
  region: "TN",
  postalCodes: null,
  rateBps: 300,
  base: "TICKET_FACE" as const,
  collector: "PLATFORM" as const,
  source: "test",
};

describe("getCheckoutFeeRates — uniformTaxBase", () => {
  it("no tax lines → null", async () => {
    const result = await getCheckoutFeeRates(
      { repos: makeRepos(NASHVILLE, 0), clock },
      { eventId: EVENT_ID },
    );
    expect(result.taxImpositions).toEqual([]);
    expect(result.uniformTaxBase).toBeNull();
  });

  it("one SALES line → its base", async () => {
    const result = await getCheckoutFeeRates(
      { repos: makeRepos(NASHVILLE), clock },
      { eventId: EVENT_ID },
    );
    expect(result.uniformTaxBase).toBe("BUYER_TOTAL");
  });

  it("SALES on BUYER_TOTAL + a local TICKET_FACE line → null", async () => {
    seam.rules = [MPLS_RULE];
    try {
      const result = await getCheckoutFeeRates(
        { repos: makeRepos(NASHVILLE), clock },
        { eventId: EVENT_ID },
      );
      expect(result.taxImpositions.map((l) => [l.code, l.base])).toEqual([
        ["SALES", "BUYER_TOTAL"],
        ["MPLS_ENTERTAINMENT", "TICKET_FACE"],
      ]);
      expect(result.uniformTaxBase).toBeNull();
    } finally {
      seam.rules = undefined;
    }
  });

  it("two PLATFORM lines on the same base → that base", async () => {
    seam.rules = [{ ...MPLS_RULE, base: "BUYER_TOTAL" as const }];
    try {
      const result = await getCheckoutFeeRates(
        { repos: makeRepos(NASHVILLE), clock },
        { eventId: EVENT_ID },
      );
      expect(result.uniformTaxBase).toBe("BUYER_TOTAL");
    } finally {
      seam.rules = undefined;
    }
  });
});

describe("estimateCheckoutTax — taxImpositions", () => {
  it("returns the lines it taxed with, beside the unchanged totals", async () => {
    const result = await estimateCheckoutTax(
      { repos: makeRepos(NASHVILLE), clock },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
    );
    expect(result.taxImpositions).toEqual(salesAt("BUYER_TOTAL"));
    expect(result.taxAmountCents).toBe(TN_CHARGE.taxCents);
    expect(result.taxRateBps).toBe(NASHVILLE_BPS);
  });

  it("lists a local line too, and the quote taxes it", async () => {
    seam.rules = [MPLS_RULE];
    try {
      const result = await estimateCheckoutTax(
        { repos: makeRepos(NASHVILLE), clock },
        { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
      );
      expect(result.taxImpositions.map((l) => l.code)).toEqual([
        "SALES",
        "MPLS_ENTERTAINMENT",
      ]);
      expect(result.taxAmountCents).toBe(TN_CHARGE.taxCents + 75);
    } finally {
      seam.rules = undefined;
    }
  });
});

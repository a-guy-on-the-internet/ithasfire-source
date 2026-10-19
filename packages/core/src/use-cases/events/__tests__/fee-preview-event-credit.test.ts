import { describe, expect, it, vi } from "vitest";

import {
  aggregateItems,
  buildFeePolicySnapshot,
  computeOrderAmounts,
  unseatedSeatPrices,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../orders/checkout-helpers";
import { computeAgreementBasis } from "../../orders/finalize-from-payment-intent";
import { getEventFeePreview } from "../get-event-fee-preview";

/**
 * The builder's fee preview says what the EVENT is credited for one ticket
 * (`eventCreditCents`), next to what the buyer pays.
 *
 * Owner ruling, 2026-10-11: the platform fee is taken once. The buyer pays it
 * on top of the ticket price and settlement credits the event the FULL ticket
 * price (`computeAgreementBasis` on an order marked
 * `organiserCredit: "FULL_PRICE"`). The pinned case is a $75.00 ticket: fee
 * 50, credit 7500 (`orders/__tests__/compute-agreement-basis.test.ts`).
 * Spec: docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml (FR-007).
 *
 * The preview is forward-looking, so it always shows the rule a NEW sale is
 * credited under. These tests hold it to the function settlement runs, fed
 * the snapshot checkout stamps.
 */

/** The marker a new sale carries; what the preview must agree with. */
const FULL_PRICE = { organiserCredit: "FULL_PRICE" } as const;

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "55555555-5555-4555-8555-555555555555";

const SEVENTY_FIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FREE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const clock = { now: () => NOW };

type Situs = { countryCode: string; region: string; postalCode: string };
const NEW_YORK: Situs = { countryCode: "US", region: "NY", postalCode: "10001" };
const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };

type Schedule = { scheduledPriceCents: number; scheduledPriceAt: Date };

const tier = (
  id: string,
  name: string,
  priceCents: number,
  schedule: Schedule | null = null,
) => ({
  id,
  name,
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
  scheduledPriceCents: schedule?.scheduledPriceCents ?? null,
  scheduledPriceAt: schedule?.scheduledPriceAt ?? null,
  salesOpenAt: null,
  salesCloseAt: null,
});
type Tier = ReturnType<typeof tier>;

/** The live GLOBAL policy's shape: 3.33% capped at 50¢, no fixed part, no floor. */
const feePolicy = (overrides: { minFeeCents?: number } = {}) => ({
  id: "policy-1",
  version: 1,
  status: "ACTIVE",
  scopeType: "GLOBAL",
  scopeId: null,
  effectiveTo: null,
  feeMode: "PASS_THROUGH",
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: overrides.minFeeCents ?? 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
});

const AGREEMENT = {
  id: "agreement-1",
  kind: "PRIMARY",
  status: "ACTIVE",
  feeMode: "PASS_THROUGH",
  feePolicyId: "policy-1",
  version: 1,
};

const LINES = [
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
];

function makeRepos(input: {
  tiers: Tier[];
  situs?: Situs;
  minFeeCents?: number;
  /**
   * An event with no stamped rate at a venue with none cached: the rate is
   * UNKNOWN unless a lookup answers (the "FAILED lookup" fixture of
   * `fee-preview-matches-event-page.test.ts`).
   */
  taxRate?: "stamped" | "unknown";
}) {
  const situs = input.situs ?? NEW_YORK;
  const unknown = input.taxRate === "unknown";
  const policy = feePolicy({ minFeeCents: input.minFeeCents });
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
        admissionTaxRateBps: unknown ? null : 888,
        placeId: unknown ? PLACE_ID : null,
        savedLocationId: null,
        ...situs,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: null,
      })),
      listTicketTypes: vi.fn(async () => input.tiers),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [AGREEMENT]),
      listLines: vi.fn(async () => LINES),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) => (id === "policy-1" ? policy : null)),
      resolveEffective: vi.fn(async () => null),
    },
    places: {
      getById: vi.fn(async () =>
        unknown
          ? {
              id: PLACE_ID,
              ...situs,
              addressLine1: "1 Penn Plaza",
              city: "New York",
              admissionTaxRateBps: null,
              taxRateSource: null,
            }
          : null,
      ),
      fillTaxRateIfUnset: vi.fn(async () => false),
    },
    savedLocations: { getById: vi.fn(async () => null) },
    authz: { getOrgMembership: vi.fn(async () => ({ role: "OWNER" })) },
  } as never;
}

async function preview(input: Parameters<typeof makeRepos>[0]) {
  const result = await getEventFeePreview(
    { repos: makeRepos(input), clock },
    { actorHumanId: ACTOR, eventId: EVENT_ID },
  );
  const row = (id: string) => {
    const found = result.ticketBreakdowns.find((b) => b.ticketTypeId === id);
    if (!found) throw new Error(`no breakdown for ${id}`);
    return found;
  };
  return { result, row };
}

/**
 * Settlement's basis for the ORDER checkout writes for one ticket of this
 * tier: the charge site's own gross and platform fee (`computeOrderAmounts`)
 * and the snapshot checkout stamps beside them (`buildFeePolicySnapshot`, as
 * `price-cart.ts` does), through `computeAgreementBasis`. Independent of the
 * preview's own figures, so it is the non-circular half of "the preview
 * cannot drift from settlement".
 */
function basisOfOneTicketOrder(row: Tier, minFeeCents?: number): number {
  const items = aggregateItems([{ ticketTypeId: row.id, qty: 1 }]);
  const context = {
    agreement: AGREEMENT,
    lines: LINES,
    feePolicy: feePolicy({ minFeeCents }),
  } as unknown as PayoutTermsContext;
  const order = computeOrderAmounts(
    items,
    new Map([[row.id, row as unknown as TicketTypeSummary]]),
    context,
    { now: NOW, seatPrices: unseatedSeatPrices(items) },
  );
  return computeAgreementBasis({
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    feePolicySnapshot: buildFeePolicySnapshot(context, NOW),
  });
}

const PRICED_TIERS = [
  tier(SEVENTY_FIVE_ID, "Seventy-five", 7500),
  tier(TEN_ID, "Ten", 1000),
  tier(FREE_ID, "Free", 0),
];

describe("fee preview — what the event is credited for one ticket", () => {
  it("a $75.00 ticket: the buyer pays the 50¢ fee on top, the event is credited the full 7500", async () => {
    const { row } = await preview({ tiers: PRICED_TIERS });
    const b = row(SEVENTY_FIVE_ID);

    expect(b.unitPriceCents).toBe(7500);
    // round(7500 × 0.0333) = 250, capped to 50.
    expect(b.platformFeeCents).toBe(50);
    expect(b.eventCreditCents).toBe(7500);
    expect(b.eventCreditCents).toBe(
      computeAgreementBasis({
        amountGrossCents: 7500,
        feesPlatformCents: 50,
        feePolicySnapshot: FULL_PRICE,
      }),
    );
    // Not the pre-ruling figure an unmarked order keeps.
    expect(b.eventCreditCents).not.toBe(
      computeAgreementBasis({
        amountGrossCents: 7500,
        feesPlatformCents: 50,
        feePolicySnapshot: null,
      }),
    );
    // The buyer pays the 50¢ on top of the 7500 (plus tax and the processing
    // fee); it is not taken from the event as well.
    expect(b.buyerTotalCents).toBeGreaterThanOrEqual(7500 + 50);
  });

  it("a $10.00 ticket: the 33¢ fee is the buyer's, the event is credited 1000", async () => {
    const { row } = await preview({ tiers: PRICED_TIERS });
    const b = row(TEN_ID);

    expect(b.unitPriceCents).toBe(1000);
    // round(1000 × 0.0333) = round(33.3) = 33, under the 50¢ cap.
    expect(b.platformFeeCents).toBe(33);
    expect(b.eventCreditCents).toBe(1000);
    expect(b.eventCreditCents).toBe(
      computeAgreementBasis({
        amountGrossCents: 1000,
        feesPlatformCents: 33,
        feePolicySnapshot: FULL_PRICE,
      }),
    );
  });

  it("a $0 ticket carries no fee and credits 0", async () => {
    const { row } = await preview({ tiers: PRICED_TIERS });
    const b = row(FREE_ID);

    expect(b.unitPriceCents).toBe(0);
    expect(b.platformFeeCents).toBe(0);
    expect(b.eventCreditCents).toBe(0);
    expect(b.eventCreditCents).toBe(
      computeAgreementBasis({
        amountGrossCents: 0,
        feesPlatformCents: 0,
        feePolicySnapshot: FULL_PRICE,
      }),
    );
  });

  it("an UNKNOWN tax rate hides 'Buyer pays' but not the credit: it does not depend on tax", async () => {
    const repos = makeRepos({ tiers: PRICED_TIERS, taxRate: "unknown" });
    const { TaxRateLookupError } = await import("@th/ports/tax-rate-lookup");
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", { providerCode: 108 });
    });

    const result = await getEventFeePreview(
      {
        repos,
        clock,
        taxLookup: { taxRateLookup: { lookupByPostalCode }, repos },
      },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);

    const byId = new Map(result.ticketBreakdowns.map((b) => [b.ticketTypeId, b]));
    const seventyFive = byId.get(SEVENTY_FIVE_ID)!;
    const ten = byId.get(TEN_ID)!;

    // The tax-dependent figures are withheld (owner ruling 2026-10-06)...
    for (const b of [seventyFive, ten]) {
      expect(b.taxEstimateCents).toBeNull();
      expect(b.processorFeeCents).toBeNull();
      expect(b.buyerTotalCents).toBeNull();
    }
    // ...and the credit is the same number it is when the rate is known.
    expect(seventyFive.platformFeeCents).toBe(50);
    expect(seventyFive.eventCreditCents).toBe(7500);
    expect(ten.platformFeeCents).toBe(33);
    expect(ten.eventCreditCents).toBe(1000);
    expect(byId.get(FREE_ID)!.eventCreditCents).toBe(0);

    for (const b of result.ticketBreakdowns) {
      expect(b.eventCreditCents).toBe(
        computeAgreementBasis({
          amountGrossCents: b.unitPriceCents,
          feesPlatformCents: b.platformFeeCents,
          feePolicySnapshot: FULL_PRICE,
        }),
      );
    }
  });
});

describe("fee preview — the credit follows the EFFECTIVE price of a scheduled change", () => {
  const FLIPPED_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const AT_BOUNDARY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const PENDING_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  // Stored $10.00, scheduled to become $75.00. The two prices have different
  // fees (33 and 50) and different credits (1000 and 7500), so reading the
  // wrong one cannot pass.
  const scheduled = (id: string, name: string, scheduledPriceAt: Date) =>
    tier(id, name, 1000, { scheduledPriceCents: 7500, scheduledPriceAt });

  const tiers = [
    scheduled(FLIPPED_ID, "Flipped yesterday", new Date("2026-05-31T00:00:00.000Z")),
    scheduled(AT_BOUNDARY_ID, "Flips at this instant", new Date(NOW.getTime())),
    scheduled(PENDING_ID, "Flips tomorrow", new Date("2026-06-02T00:00:00.000Z")),
  ];

  it("a change that has already flipped is credited at the scheduled price", async () => {
    const { row } = await preview({ tiers });
    const b = row(FLIPPED_ID);

    expect(b.unitPriceCents).toBe(7500);
    expect(b.platformFeeCents).toBe(50);
    expect(b.eventCreditCents).toBe(7500);
  });

  it("the flip is inclusive at the boundary, for the credit as for the price", async () => {
    const { row } = await preview({ tiers });
    const b = row(AT_BOUNDARY_ID);

    expect(b.unitPriceCents).toBe(7500);
    expect(b.eventCreditCents).toBe(7500);
  });

  it("a change that has not flipped yet is credited at the stored price", async () => {
    const { row } = await preview({ tiers });
    const b = row(PENDING_ID);

    expect(b.unitPriceCents).toBe(1000);
    expect(b.platformFeeCents).toBe(33);
    expect(b.eventCreditCents).toBe(1000);
  });

  it("each is the basis of the order checkout writes at that instant", async () => {
    const { row } = await preview({ tiers });
    for (const t of tiers) {
      expect(row(t.id).eventCreditCents).toBe(basisOfOneTicketOrder(t));
    }
  });
});

describe("fee preview — the credit is the ticket price at every price (PASS_THROUGH, known tax)", () => {
  // Around the cap (50¢ is reached at round(p × 0.0333) >= 50, i.e. $15.01),
  // the smallest prices, and the event page's two reference tiers.
  const PRICES_CENTS = [
    0, 1, 14, 15, 16, 100, 999, 1000, 1486, 1500, 1501, 1502, 3500, 7500, 11000,
    250000,
  ];
  const uuid = (n: number) =>
    `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const tiers = PRICES_CENTS.map((p, i) => tier(uuid(i + 1), `Tier ${p}`, p));

  it.each([
    ["tax on the face (NY)", NEW_YORK],
    ["buyer-total tax (TN)", NASHVILLE],
  ] as const)("%s", async (_label, situs) => {
    const { result, row } = await preview({ tiers, situs });
    expect(result.feeMode).toBe("PASS_THROUGH");
    expect(result.ticketBreakdowns).toHaveLength(tiers.length);

    for (const t of tiers) {
      const b = row(t.id);
      // Known tax: this is the branch that also quotes "Buyer pays".
      expect(b.taxEstimateCents).not.toBeNull();
      expect(b.buyerTotalCents).not.toBeNull();

      expect(b.unitPriceCents).toBe(t.priceCents);
      expect(b.eventCreditCents).toBe(b.unitPriceCents);
      // The fee is on the buyer's side of the row only.
      expect(b.buyerTotalCents!).toBeGreaterThanOrEqual(
        b.unitPriceCents + b.platformFeeCents,
      );
      expect(b.eventCreditCents).toBe(
        computeAgreementBasis({
          amountGrossCents: b.unitPriceCents,
          feesPlatformCents: b.platformFeeCents,
          feePolicySnapshot: FULL_PRICE,
        }),
      );
      // And against the charge site, which computes its fee independently of
      // this preview.
      expect(b.eventCreditCents).toBe(basisOfOneTicketOrder(t));
    }
  });

  it("the tax base does not move the credit: NY and TN credit every tier the same", async () => {
    const ny = await preview({ tiers, situs: NEW_YORK });
    const tn = await preview({ tiers, situs: NASHVILLE });

    // The fixture must actually differ on tax, or this compares nothing.
    expect(tn.row(uuid(14)).taxEstimateCents).not.toBe(
      ny.row(uuid(14)).taxEstimateCents,
    );
    for (const t of tiers) {
      expect(tn.row(t.id).eventCreditCents).toBe(ny.row(t.id).eventCreditCents);
    }
  });
});

describe("fee preview — a fee larger than the ticket still credits the ticket price", () => {
  const CHEAP_ID = "99999999-9999-4999-8999-999999999999";

  it("a 25¢ ticket under a 50¢ minimum fee: credit 25", async () => {
    // The buyer pays the 50¢ on top. Before the 2026-10-11 ruling the fee came
    // out of the credit and this floored at 0.
    const cheap = tier(CHEAP_ID, "Quarter", 25);
    const { row } = await preview({ tiers: [cheap], minFeeCents: 50 });
    const b = row(CHEAP_ID);

    expect(b.unitPriceCents).toBe(25);
    expect(b.platformFeeCents).toBe(50);
    expect(b.eventCreditCents).toBe(25);
    expect(b.eventCreditCents).toBe(
      computeAgreementBasis({
        amountGrossCents: 25,
        feesPlatformCents: 50,
        feePolicySnapshot: FULL_PRICE,
      }),
    );
    expect(b.eventCreditCents).toBe(basisOfOneTicketOrder(cheap, 50));
  });
});

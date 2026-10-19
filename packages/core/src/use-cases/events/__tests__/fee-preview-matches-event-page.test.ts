import { describe, expect, it, vi } from "vitest";

import { getCheckoutFeeRates } from "../get-checkout-fee-rates";
import { getEventFeePreview } from "../get-event-fee-preview";

/**
 * The admin builder's "Buyer pays" (`getEventFeePreview`) must be the figure
 * the event page and checkout quote for the same ticket
 * (`getCheckoutFeeRates.perTicketEstimates[].buyerUnitTotalCents`).
 *
 * Live, the builder said $36.83 (service fee + a processing markup, NO tax)
 * for a $35 ticket the event page sold at $40.08, and $114.01 vs $124.18 for
 * VIP. Same fixture, both use cases, every fee mode and tax base.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const GA_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const clock = { now: () => new Date("2026-06-01T00:00:00.000Z") };

type Situs = { countryCode: string; region: string; postalCode: string };
const NEW_YORK: Situs = { countryCode: "US", region: "NY", postalCode: "10001" };
const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };

const tier = (id: string, name: string, priceCents: number) => ({
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
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
});

function makeRepos(situs: Situs, feeMode: "PASS_THROUGH" | "ABSORB") {
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
    minFeeCents: 0,
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
        admissionTaxRateBps: 888,
        placeId: null,
        savedLocationId: null,
        ...situs,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: null,
      })),
      listTicketTypes: vi.fn(async () => [
        tier(GA_ID, "General Admission", 3500),
        tier(VIP_ID, "VIP", 11000),
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
      getById: vi.fn(async (id: string) => (id === "policy-1" ? feePolicy : null)),
      resolveEffective: vi.fn(async () => null),
    },
    places: { getById: vi.fn(async () => null) },
    savedLocations: { getById: vi.fn(async () => null) },
    authz: { getOrgMembership: vi.fn(async () => ({ role: "OWNER" })) },
  } as never;
}

describe("builder 'Buyer pays' === the event page's price", () => {
  it.each([
    ["PASS_THROUGH, tax on the face (NY)", NEW_YORK, "PASS_THROUGH"],
    ["PASS_THROUGH, buyer-total tax (TN)", NASHVILLE, "PASS_THROUGH"],
    ["ABSORB (NY)", NEW_YORK, "ABSORB"],
  ] as const)("%s", async (_label, situs, feeMode) => {
    const repos = makeRepos(situs, feeMode);
    const builder = await getEventFeePreview(
      { repos, clock },
      { actorHumanId: "33333333-3333-4333-8333-333333333333", eventId: EVENT_ID },
    );
    const page = await getCheckoutFeeRates({ repos, clock }, { eventId: EVENT_ID });

    for (const id of [GA_ID, VIP_ID]) {
      const row = builder.ticketBreakdowns.find((b) => b.ticketTypeId === id)!;
      const quoted = page.perTicketEstimates.find((e) => e.ticketTypeId === id)!;
      expect(row.buyerTotalCents).toBe(quoted.buyerUnitTotalCents);
      expect(row.taxEstimateCents).toBe(quoted.taxEstimateCents);
      expect(row.taxEstimateCents).toBeGreaterThan(0);
      if (feeMode === "PASS_THROUGH") {
        expect(row.platformFeeCents).toBe(quoted.platformFeeCents);
        expect(row.processorFeeCents).toBe(quoted.processorFeeCents);
      }
    }
  });
});

describe("builder 'Buyer pays' === the event page's price — NULL admission-tax stamp", () => {
  const PLACE_ID = "44444444-4444-4444-8444-444444444444";

  it("both take the venue's cached rate, so neither leaves tax out", async () => {
    const repos = makeRepos(NEW_YORK, "PASS_THROUGH") as unknown as {
      events: { getById: ReturnType<typeof vi.fn> };
      places: { getById: ReturnType<typeof vi.fn> };
    };
    const stamped = (await repos.events.getById()) as Record<string, unknown>;
    repos.events.getById.mockImplementation(async () => ({
      ...stamped,
      admissionTaxRateBps: null,
      placeId: PLACE_ID,
    }));
    repos.places.getById.mockImplementation(async () => ({
      id: PLACE_ID,
      ...NEW_YORK,
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    }));

    const builder = await getEventFeePreview(
      { repos: repos as never, clock },
      { actorHumanId: "33333333-3333-4333-8333-333333333333", eventId: EVENT_ID },
    );
    const page = await getCheckoutFeeRates(
      { repos: repos as never, clock },
      { eventId: EVENT_ID },
    );

    // Same numbers as the STAMPED-888 fixture above.
    const stampedPage = await getCheckoutFeeRates(
      { repos: makeRepos(NEW_YORK, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID },
    );
    for (const id of [GA_ID, VIP_ID]) {
      const row = builder.ticketBreakdowns.find((b) => b.ticketTypeId === id)!;
      const quoted = page.perTicketEstimates.find((e) => e.ticketTypeId === id)!;
      const stampedRow = stampedPage.perTicketEstimates.find(
        (e) => e.ticketTypeId === id,
      )!;
      expect(row.taxEstimateCents).toBeGreaterThan(0);
      expect(row.buyerTotalCents).toBe(quoted.buyerUnitTotalCents);
      expect(quoted.buyerUnitTotalCents).toBe(stampedRow.buyerUnitTotalCents);
    }
  });
});

describe("builder fee preview — an UNKNOWN tax rate is never previewed as 0 (owner ruling 2026-10-06)", () => {
  const PLACE_ID = "55555555-5555-4555-8555-555555555555";
  const ACTOR = "33333333-3333-4333-8333-333333333333";

  function unstampedAtVenue(placeRate: number | null) {
    const repos = makeRepos(NEW_YORK, "PASS_THROUGH") as unknown as {
      events: { getById: ReturnType<typeof vi.fn> };
      places: {
        getById: ReturnType<typeof vi.fn>;
        fillTaxRateIfUnset?: ReturnType<typeof vi.fn>;
      };
    };
    const place = {
      id: PLACE_ID,
      ...NEW_YORK,
      addressLine1: "1 Penn Plaza",
      city: "New York",
      admissionTaxRateBps: placeRate,
      taxRateSource: placeRate == null ? null : "ziptax",
    };
    repos.events.getById.mockImplementation(async () => ({
      id: EVENT_ID,
      orgId: ORG_ID,
      humanId: null,
      title: "Gallery Walk",
      slug: "gallery-walk",
      status: "PUBLISHED",
      currency: "usd",
      admissionTaxRateBps: null,
      placeId: PLACE_ID,
      savedLocationId: null,
      ...NEW_YORK,
      startsAt: new Date("2026-12-01T20:00:00.000Z"),
      endsAt: null,
    }));
    repos.places.getById.mockImplementation(async () => ({ ...place }));
    repos.places.fillTaxRateIfUnset = vi.fn(
      async (input: { admissionTaxRateBps: number }) => {
        if (place.admissionTaxRateBps != null) return false;
        place.admissionTaxRateBps = input.admissionTaxRateBps;
        return true;
      },
    );
    return { repos, place };
  }

  it("a FAILED lookup previews no tax, no processing fee and no 'Buyer pays' — never a 0% total", async () => {
    const { repos } = unstampedAtVenue(null);
    const { TaxRateLookupError } = await import("@th/ports/tax-rate-lookup");
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", { providerCode: 108 });
    });

    const builder = await getEventFeePreview(
      {
        repos: repos as never,
        clock,
        taxLookup: {
          taxRateLookup: { lookupByPostalCode },
          repos: repos as never,
        },
      },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(builder.ticketBreakdowns).toHaveLength(2);
    for (const row of builder.ticketBreakdowns) {
      expect(row.taxEstimateCents).toBeNull();
      expect(row.buyerTotalCents).toBeNull();
      // PASS_THROUGH grosses the processor fee up over the tax: unknown too.
      expect(row.processorFeeCents).toBeNull();
      // The platform fee does not depend on the tax.
      expect(row.platformFeeCents).toBeGreaterThan(0);
    }
  });

  it("with no lookup and nothing cached, the preview still says nothing rather than 0", async () => {
    const { repos } = unstampedAtVenue(null);

    const builder = await getEventFeePreview(
      { repos: repos as never, clock },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    for (const row of builder.ticketBreakdowns) {
      expect(row.taxEstimateCents).toBeNull();
      expect(row.buyerTotalCents).toBeNull();
    }
  });

  it("a SUCCESSFUL lookup previews the same 'Buyer pays' as the event page at that rate", async () => {
    const { repos, place } = unstampedAtVenue(null);
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 888,
      source: "ziptax",
    }));

    const builder = await getEventFeePreview(
      {
        repos: repos as never,
        clock,
        taxLookup: {
          taxRateLookup: { lookupByPostalCode },
          repos: repos as never,
        },
      },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );
    // Cached on the venue for the next quote.
    expect(place.admissionTaxRateBps).toBe(888);

    const stampedPage = await getCheckoutFeeRates(
      { repos: makeRepos(NEW_YORK, "PASS_THROUGH"), clock },
      { eventId: EVENT_ID },
    );
    for (const id of [GA_ID, VIP_ID]) {
      const row = builder.ticketBreakdowns.find((b) => b.ticketTypeId === id)!;
      const quoted = stampedPage.perTicketEstimates.find(
        (e) => e.ticketTypeId === id,
      )!;
      expect(row.taxEstimateCents).toBeGreaterThan(0);
      expect(row.buyerTotalCents).toBe(quoted.buyerUnitTotalCents);
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";

import {
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "../../orders/_shared/resolve-checkout-tax-rate";
import { estimateCheckoutTax } from "../estimate-checkout-tax";
import { getCheckoutFeeRates } from "../get-checkout-fee-rates";
import { resolveQuoteTaxRate } from "../_shared/resolve-quote-tax-rate";
import {
  QUOTE_TAX_LOOKUP_COOLDOWN_MS,
  createQuoteTaxLookupCooldown,
} from "../_shared/quote-tax-lookup-cooldown";

/**
 * Owner ruling 2026-10-06 (supersedes 2026-10-04): the event page and the
 * checkout fee preview LOOK UP an unknown venue rate by address — once per
 * venue, cached with checkout's compare-and-set — and never show a 0% figure
 * for an unknown rate. A failed lookup refuses the quote (TAX_RATE_UNAVAILABLE:
 * the client shows "Calculating total…"). After the fill, the quote and the
 * charge use the SAME rate.
 *
 * Fixture as `taxable-base-estimates.test.ts`: $25 face, $0.50 flat platform
 * fee, Stripe 2.9% + 30¢, PASS_THROUGH, Nashville (TN, BUYER_TOTAL) at 9.75%
 * → tax 260¢, total 2925¢ (pinned against the charge there).
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const NASHVILLE_BPS = 975;
const TN_CHARGE = { taxCents: 260, totalCents: 2925 };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const clock = { now: () => NOW };

function makeEvent() {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Nashville Show",
    slug: "nashville-show",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    currency: "usd",
    admissionTaxRateBps: null,
    taxRateSource: null,
    instructionalAdmission: false,
    placeId: PLACE_ID,
    savedLocationId: null,
    postalCode: null,
    countryCode: null,
    region: null,
    startsAt: new Date("2026-12-01T20:00:00.000Z"),
    endsAt: new Date("2026-12-01T23:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };
}

const ticketType = {
  id: TT_ID,
  name: "General",
  description: null,
  priceCents: 2500,
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
  platformFixedCents: 50,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
};

/**
 * Repos with an IN-MEMORY Nashville Place whose `fillTaxRateIfUnset` is the
 * real compare-and-set (empty cache AND same postal code / country), so a
 * fill made by the quote is what the next quote and the checkout read.
 */
function makeRepos() {
  const place = {
    id: PLACE_ID,
    addressLine1: "501 Broadway",
    city: "Nashville",
    region: "TN",
    postalCode: "37203",
    countryCode: "US",
    admissionTaxRateBps: null as number | null,
    taxRateSource: null as string | null,
  };
  const repos = {
    place,
    events: {
      getById: vi.fn(async () => makeEvent()),
      listTicketTypes: vi.fn(async () => [ticketType]),
      listUnstampedUpcomingIdsAtTaxLocation: vi.fn(async () => [
        EVENT_ID,
        "sibling-event",
      ]),
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
    places: {
      getById: vi.fn(async () => ({ ...place })),
      fillTaxRateIfUnset: vi.fn(
        async (input: {
          id: string;
          expectedPostalCode: string | null;
          expectedCountryCode: string | null;
          admissionTaxRateBps: number;
          taxRateSource: string;
        }) => {
          if (
            input.id !== place.id ||
            place.admissionTaxRateBps !== null ||
            place.postalCode !== input.expectedPostalCode ||
            place.countryCode !== input.expectedCountryCode
          ) {
            return false;
          }
          place.admissionTaxRateBps = input.admissionTaxRateBps;
          place.taxRateSource = input.taxRateSource;
          return true;
        },
      ),
    },
    savedLocations: { getById: vi.fn(async () => null) },
    searchReindexPending: { mark: vi.fn(async () => undefined) },
    tx: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
        fn(repos),
    ),
  };
  return repos;
}

const rateLimited = () =>
  new TaxRateLookupError("Ziptax rCode 108", {
    providerCode: 108,
    httpStatus: 429,
  });

function taxLookup(
  repos: ReturnType<typeof makeRepos>,
  lookupByPostalCode: (...args: never[]) => unknown,
  reportError = vi.fn(),
) {
  return {
    taxRateLookup: { lookupByPostalCode } as never,
    repos: repos as never,
    reportError,
  };
}

describe("getCheckoutFeeRates — an unknown venue rate is looked up ONCE and cached", () => {
  it("looks the rate up by street address, quotes it, fills the venue cache, and re-indexes the venue's events", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: NASHVILLE_BPS,
      source: "ziptax",
    }));

    const result = await getCheckoutFeeRates(
      {
        repos: repos as never,
        clock,
        taxLookup: taxLookup(repos, lookupByPostalCode),
      },
      { eventId: EVENT_ID },
    );

    expect(result.admissionTaxRateBps).toBe(NASHVILLE_BPS);
    expect(result.perTicketEstimates[0]!.taxEstimateCents).toBe(
      TN_CHARGE.taxCents,
    );
    expect(result.perTicketEstimates[0]!.buyerUnitTotalCents).toBe(
      TN_CHARGE.totalCents,
    );
    expect(lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "37203",
      countryCode: "US",
      street: "501 Broadway",
      city: "Nashville",
      region: "TN",
    });
    // Same compare-and-set checkout uses: empty cache, same address.
    expect(repos.places.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PLACE_ID,
        expectedPostalCode: "37203",
        expectedCountryCode: "US",
        admissionTaxRateBps: NASHVILLE_BPS,
        taxRateSource: "ziptax",
      }),
    );
    expect(repos.place.admissionTaxRateBps).toBe(NASHVILLE_BPS);
    // Sibling reindex (fire-and-forget, after the fill).
    await vi.waitFor(() =>
      expect(repos.searchReindexPending.mark).toHaveBeenCalledTimes(1),
    );
    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "place", placeId: PLACE_ID } }),
    );

    // The next quote reads the cache: no second provider call.
    const again = await getCheckoutFeeRates(
      {
        repos: repos as never,
        clock,
        taxLookup: taxLookup(repos, lookupByPostalCode),
      },
      { eventId: EVENT_ID },
    );
    expect(again.admissionTaxRateBps).toBe(NASHVILLE_BPS);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("a FAILED lookup refuses TAX_RATE_UNAVAILABLE — never a 0% quote — and is reported once", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });
    const reportError = vi.fn();

    await expect(
      getCheckoutFeeRates(
        {
          repos: repos as never,
          clock,
          taxLookup: taxLookup(repos, lookupByPostalCode, reportError),
        },
        { eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: { providerCode: 108 },
    });
    expect(repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("estimateCheckoutTax refuses on a failed lookup too (no 0 'Est. tax')", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });

    await expect(
      estimateCheckoutTax(
        {
          repos: repos as never,
          clock,
          taxLookup: taxLookup(repos, lookupByPostalCode),
        },
        { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 1 }] },
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });
  });

  it("resolveQuoteTaxRate: a failed lookup is UNKNOWN (lookup_failed), not 0", async () => {
    const repos = makeRepos();
    const quote = await resolveQuoteTaxRate(
      {
        repos: repos as never,
        clock,
        lookup: taxLookup(
          repos,
          vi.fn(async () => {
            throw rateLimited();
          }),
        ),
      },
      makeEvent(),
      null,
    );
    expect(quote).toEqual({
      known: false,
      reason: "lookup_failed",
      cacheTarget: { kind: "place", placeId: PLACE_ID },
    });
  });

  it("resolveQuoteTaxRate without a lookup (a listing) says not_looked_up — never calls the provider", async () => {
    const repos = makeRepos();
    const quote = await resolveQuoteTaxRate(
      { repos: repos as never, clock },
      makeEvent(),
      null,
    );
    expect(quote).toMatchObject({ known: false, reason: "not_looked_up" });
  });
});

describe("parity: after the quote's cache fill, the event page quote equals the checkout charge rate", () => {
  it("checkout charges exactly the rate the quote showed, without calling the provider again", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: NASHVILLE_BPS,
      source: "ziptax",
    }));

    const quote = await getCheckoutFeeRates(
      {
        repos: repos as never,
        clock,
        taxLookup: taxLookup(repos, lookupByPostalCode),
      },
      { eventId: EVENT_ID },
    );

    const checkoutDeps = {
      repos: repos as never,
      taxRateLookup: { lookupByPostalCode },
      clock,
      sleep: vi.fn(async () => undefined),
    };
    const prepared = await prepareCheckoutTax(checkoutDeps, EVENT_ID, undefined);
    const charge = await resolveCheckoutTax(
      checkoutDeps,
      repos as never,
      makeEvent() as never,
      undefined,
      newCheckoutTaxAfterCommit(),
      prepared,
    );

    expect(charge.rateBps).toBe(quote.admissionTaxRateBps);
    expect(charge.taxableBase).toBe(quote.taxableBase);
    expect(charge.impositions).toEqual(quote.taxImpositions);
    // The one provider call was the quote's.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
  });
});

describe("quote negative cache: a venue whose lookup just failed is not re-asked on every view", () => {
  it("one provider call per venue per cooldown; the cooled-down quote still refuses (never 0%); asked again after it", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });
    const reportError = vi.fn();
    let nowMs = NOW.getTime();
    const movingClock = { now: () => new Date(nowMs) };
    const cooldown = createQuoteTaxLookupCooldown();
    const deps = () => ({
      repos: repos as never,
      clock: movingClock,
      taxLookup: {
        ...taxLookup(repos, lookupByPostalCode, reportError),
        cooldown,
      },
    });

    await expect(
      getCheckoutFeeRates(deps(), { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });
    nowMs += 10_000;
    await expect(
      getCheckoutFeeRates(deps(), { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });
    // The second view skipped the provider and filed no second report.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);

    nowMs += QUOTE_TAX_LOOKUP_COOLDOWN_MS;
    lookupByPostalCode.mockResolvedValueOnce({
      rateBps: NASHVILLE_BPS,
      source: "ziptax",
    } as never);
    const recovered = await getCheckoutFeeRates(deps(), {
      eventId: EVENT_ID,
    });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(2);
    expect(recovered.admissionTaxRateBps).toBe(NASHVILLE_BPS);
  });

  it("a cooled-down venue's CACHED rate is still quoted (only the provider call is skipped)", async () => {
    const repos = makeRepos();
    const cooldown = createQuoteTaxLookupCooldown();
    cooldown.noteFailure(`place:${PLACE_ID}`, NOW.getTime());
    repos.place.admissionTaxRateBps = NASHVILLE_BPS;
    repos.place.taxRateSource = "ziptax";
    const lookupByPostalCode = vi.fn();

    const quote = await resolveQuoteTaxRate(
      {
        repos: repos as never,
        clock,
        lookup: { ...taxLookup(repos, lookupByPostalCode), cooldown },
      },
      makeEvent(),
      null,
    );
    expect(quote).toEqual({ known: true, rateBps: NASHVILLE_BPS });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("checkout NEVER consults the quote cooldown: it asks the provider itself", async () => {
    const repos = makeRepos();
    const cooldown = createQuoteTaxLookupCooldown();
    // A quote just failed for this venue.
    cooldown.noteFailure(`place:${PLACE_ID}`, NOW.getTime());
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: NASHVILLE_BPS,
      source: "ziptax",
    }));

    const prepared = await prepareCheckoutTax(
      {
        repos: repos as never,
        taxRateLookup: { lookupByPostalCode },
        clock,
      },
      EVENT_ID,
      undefined,
    );
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(prepared.prepared?.stamp?.rateBps).toBe(NASHVILLE_BPS);
  });
});

describe("createQuoteTaxLookupCooldown", () => {
  it("expires after the TTL", () => {
    const c = createQuoteTaxLookupCooldown({ ttlMs: 100 });
    c.noteFailure("a", 1_000);
    expect(c.isCoolingDown("a", 1_050)).toBe(true);
    expect(c.isCoolingDown("a", 1_100)).toBe(false);
    expect(c.isCoolingDown("b", 1_050)).toBe(false);
  });

  it("is bounded: the oldest venue is dropped first", () => {
    const c = createQuoteTaxLookupCooldown({ ttlMs: 10_000, maxEntries: 2 });
    c.noteFailure("a", 1);
    c.noteFailure("b", 2);
    c.noteFailure("c", 3);
    expect(c.isCoolingDown("a", 4)).toBe(false);
    expect(c.isCoolingDown("b", 4)).toBe(true);
    expect(c.isCoolingDown("c", 4)).toBe(true);
  });
});

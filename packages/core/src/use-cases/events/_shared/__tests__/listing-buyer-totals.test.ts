import { describe, expect, it, vi } from "vitest";

import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { EventTicketTypeSummary } from "@th/types";

import {
  computeBuyerTicketPricing,
  estimateBuyerTicketPricingForEvent,
  resolveBuyerFeeContexts,
} from "../estimate-buyer-ticket-pricing";
import {
  loadListingBuyerTotalsByEventId,
  type ListingBuyerTotalEvent,
} from "../listing-buyer-totals";
import { loadPricingByEventId } from "../event-pricing";
import { getCheckoutFeeRates } from "../../get-checkout-fee-rates";
import { resolveTaxImpositions } from "../../../../lib/pricing/tax-impositions";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_C = "org-c";
const PLACE_NASHVILLE = "place-nashville";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const policy = (
  id: string,
  scopeType: FeePolicyRecord["scopeType"],
  scopeId: string | null,
  overrides: Partial<FeePolicyRecord> = {},
): FeePolicyRecord => ({
  id,
  scopeType,
  scopeId,
  status: "ACTIVE",
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 200,
  payoutMinimumCents: 1000,
  connectAccountFeeCents: 0,
  ...overrides,
});

const terms = (
  id: string,
  kind: string,
  feePolicyId: string | null,
  status = "ACTIVE",
): PayoutTermsRecord =>
  ({
    id,
    kind,
    status,
    feeMode: null,
    feePolicyId,
    isDefault: false,
    settlementCurrency: "usd",
    payoutSchedule: "WEEK_OF_EVENT",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as PayoutTermsRecord;

const line = (
  id: string,
  payoutTermsId: string,
  percent: number,
  priority = 0,
): PayoutTermsLineRecord =>
  ({
    id,
    payoutTermsId,
    payeeId: `payee-${id}`,
    ticketTypeId: null,
    percent,
    floorCents: 0,
    capPercent: null,
    priority,
    rounding: "FLOOR",
  }) as unknown as PayoutTermsLineRecord;

const tier = (
  id: string,
  overrides: Partial<EventTicketTypeSummary> = {},
): EventTicketTypeSummary =>
  ({
    id,
    name: id,
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
    ...overrides,
  }) as EventTicketTypeSummary;

const event = (
  id: string,
  overrides: Partial<ListingBuyerTotalEvent> = {},
): ListingBuyerTotalEvent => ({
  id,
  orgId: ORG_A,
  admissionTaxRateBps: 925,
  placeId: null,
  savedLocationId: null,
  postalCode: "37203",
  countryCode: "US",
  region: "TN",
  ...overrides,
});

type StoreData = {
  /** eventId → its terms (primary first). */
  termsByEvent: Record<string, PayoutTermsRecord[]>;
  linesByTerms: Record<string, PayoutTermsLineRecord[]>;
  policies: FeePolicyRecord[];
};

/**
 * ONE in-memory store behind BOTH the single-event reads and the batch reads,
 * so the parity test compares the two resolvers over identical data.
 */
function makeRepos(
  data: StoreData,
  opts: {
    placeFails?: boolean;
    /** The Nashville venue's cached admission-tax rate (null = cache miss). */
    placeRateBps?: number | null;
  } = {},
) {
  const byScope = (scopeType: string, scopeId: string | null) =>
    data.policies.find(
      (p) => p.scopeType === scopeType && p.scopeId === scopeId,
    ) ?? null;
  return {
    payoutTerms: {
      listByEvent: vi.fn(async (eventId: string) => data.termsByEvent[eventId] ?? []),
      listLines: vi.fn(async (termsId: string) => data.linesByTerms[termsId] ?? []),
      listByEventIds: vi.fn(async (ids: readonly string[]) => {
        const m = new Map<string, PayoutTermsRecord[]>();
        for (const id of ids) m.set(id, data.termsByEvent[id] ?? []);
        return m;
      }),
      listLinesByTermsIds: vi.fn(async (ids: readonly string[]) => {
        const m = new Map<string, PayoutTermsLineRecord[]>();
        for (const id of ids) m.set(id, data.linesByTerms[id] ?? []);
        return m;
      }),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) => data.policies.find((p) => p.id === id) ?? null),
      resolveEffective: vi.fn(
        async (input: { scopeType: string; scopeId: string | null }) =>
          byScope(input.scopeType, input.scopeType === "GLOBAL" ? null : input.scopeId),
      ),
      getByIds: vi.fn(async (ids: readonly string[]) => {
        const m = new Map<string, FeePolicyRecord>();
        for (const id of ids) {
          const p = data.policies.find((x) => x.id === id);
          if (p) m.set(id, p);
        }
        return m;
      }),
      resolveEffectiveForScopes: vi.fn(
        async (input: { scopeType: string; scopeIds: readonly string[] }) => {
          const m = new Map<string, FeePolicyRecord>();
          for (const id of input.scopeIds) {
            const p = byScope(input.scopeType, id);
            if (p) m.set(id, p);
          }
          return m;
        },
      ),
    },
    // ONE store behind both the point read (single-event paths, e.g.
    // `getCheckoutFeeRates`) and the batch read (the listing pre-warm).
    places: {
      getById: vi.fn(async (id: string) => {
        if (opts.placeFails) throw new Error("place read failed");
        return placeRow(id);
      }),
      getByIds: vi.fn(async (ids: readonly string[]) => {
        if (opts.placeFails) throw new Error("place read failed");
        const m = new Map<string, NonNullable<ReturnType<typeof placeRow>>>();
        for (const id of ids) {
          const row = placeRow(id);
          if (row) m.set(id, row);
        }
        return m;
      }),
    },
    savedLocations: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => new Map()),
    },
  };

  function placeRow(id: string) {
    const known = id === PLACE_NASHVILLE || id.startsWith("venue-");
    return known
      ? {
          id,
          countryCode: "US",
          region: "TN",
          postalCode: "37203",
          admissionTaxRateBps: opts.placeRateBps ?? null,
          taxRateSource: opts.placeRateBps != null ? "ziptax" : null,
        }
      : null;
  }
}

type FakeRepos = ReturnType<typeof makeRepos>;
// The fakes implement only the methods these paths call.
const asDeps = (repos: FakeRepos) => repos as never;

const GLOBAL = policy("pol-global", "GLOBAL", null);
const baseData = (): StoreData => ({
  termsByEvent: {},
  linesByTerms: {},
  policies: [GLOBAL],
});

/** What the single-event estimator says the min all-in figure is. */
async function singlePathMin(
  repos: FakeRepos,
  ev: ListingBuyerTotalEvent,
  tiers: EventTicketTypeSummary[],
) {
  const estimate = await estimateBuyerTicketPricingForEvent(
    { repos: asDeps(repos), clock: { now: () => NOW } },
    ev,
    tiers,
    {
      taxImpositions: resolveTaxImpositions({
        situs: { countryCode: "US", region: "TN", postalCode: "37203" },
        salesTaxRateBps: ev.admissionTaxRateBps ?? 0,
      }),
    },
  );
  return estimate.minBuyerUnitTotalCents;
}

const load = (
  repos: FakeRepos,
  events: ListingBuyerTotalEvent[],
  tiers: Record<string, EventTicketTypeSummary[]>,
  extra: { reportError?: ReturnType<typeof vi.fn>; logger?: unknown } = {},
) =>
  loadListingBuyerTotalsByEventId(
    {
      repos: asDeps(repos),
      reportError: extra.reportError as never,
      logger: extra.logger as never,
    },
    events,
    new Map(Object.entries(tiers)),
    NOW,
    { useCase: "test" },
  );

// ─────────────────────────────────────────────────────────────────────────────
// loadListingBuyerTotalsByEventId
// ─────────────────────────────────────────────────────────────────────────────

describe("loadListingBuyerTotalsByEventId", () => {
  it("fixed tier: the all-in figure checkout's estimator quotes, above face", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const tiers = [tier("t1")];
    const totals = await load(repos, [ev], { e1: tiers });
    const total = totals.get("e1");
    expect(total).toBe(await singlePathMin(repos, ev, tiers));
    // $25 face + the GLOBAL policy's $0.50-capped platform fee, processing
    // and 9.25% tax: strictly more than face plus the platform fee.
    expect(total).toBeGreaterThan(2500 + 50);
  });

  it("multi-tier: the minimum over the paid tiers", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const cheap = tier("cheap", { priceCents: 1500 });
    const dear = tier("dear", { priceCents: 4000 });
    const totals = await load(repos, [ev], { e1: [dear, cheap] });
    expect(totals.get("e1")).toBe(await singlePathMin(repos, ev, [cheap]));
  });

  it("PWYW is quoted at its floor, all-in", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const pwyw = tier("pwyw", {
      priceCents: 0,
      pricingMode: "ADJUSTABLE",
      minimumCents: 500,
      suggestedCents: 1500,
    });
    const totals = await load(repos, [ev], { e1: [pwyw] });
    expect(totals.get("e1")).toBe(
      await singlePathMin(repos, ev, [tier("x", { priceCents: 500 })]),
    );
    expect(totals.get("e1")).toBeGreaterThan(500);
  });

  it("a floor-0 PWYW tier is free: no paid tier, no total", async () => {
    const repos = makeRepos(baseData());
    const pwyw = tier("pwyw", {
      priceCents: 0,
      pricingMode: "ADJUSTABLE",
      minimumCents: 0,
    });
    const totals = await load(repos, [event("e1")], { e1: [pwyw] });
    expect(totals.get("e1")).toBeNull();
    expect(repos.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });

  it("free + paid: the total is the paid tier's, never the free tier's 0", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const paid = tier("paid");
    const totals = await load(repos, [ev], {
      e1: [tier("free", { priceCents: 0 }), paid],
    });
    expect(totals.get("e1")).toBe(await singlePathMin(repos, ev, [paid]));
  });


  it("venue situs unreadable: null for that event, reported; others still priced", async () => {
    const repos = makeRepos(baseData(), { placeFails: true });
    const reportError = vi.fn();
    const logger = { error: vi.fn() };
    const totals = await load(
      repos,
      [event("at-venue", { placeId: PLACE_NASHVILLE }), event("inline")],
      { "at-venue": [tier("t1")], inline: [tier("t2")] },
      { reportError, logger },
    );
    expect(totals.get("at-venue")).toBeNull();
    expect(totals.get("inline")).toBeGreaterThan(2500);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "test", step: "resolveEventTaxSitus" },
      extra: { table: "places", venueCount: 1 },
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it("an off-sale cheaper tier is excluded (same tier set as summarizePricing)", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const elapsed = tier("early", {
      priceCents: 500,
      salesCloseAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const future = tier("later", {
      priceCents: 800,
      salesOpenAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const general = tier("general", { priceCents: 3000 });
    const totals = await load(repos, [ev], { e1: [elapsed, future, general] });
    expect(totals.get("e1")).toBe(await singlePathMin(repos, ev, [general]));
  });

  it("a fee-context read failure degrades EVERY event to null, reported and logged", async () => {
    const repos = makeRepos(baseData());
    repos.feePolicies.resolveEffective.mockRejectedValueOnce(new Error("db down"));
    const reportError = vi.fn();
    const logger = { error: vi.fn() };
    const totals = await load(
      repos,
      [event("e1"), event("e2")],
      { e1: [tier("t1")], e2: [tier("t2")] },
      { reportError, logger },
    );
    expect([...totals.values()]).toEqual([null, null]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "test", step: "loadListingBuyerTotals" },
      extra: { eventCount: 2 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "events.listing_buyer_totals_failed",
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it("a throwing reporter does not change the degraded result", async () => {
    const repos = makeRepos(baseData());
    repos.feePolicies.resolveEffective.mockRejectedValueOnce(new Error("db down"));
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const totals = await load(repos, [event("e1")], { e1: [tier("t1")] }, {
      reportError,
    });
    expect(totals.get("e1")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The tax rate is the event page's (`getCheckoutFeeRates` → resolveQuoteTaxRateBps)
// ─────────────────────────────────────────────────────────────────────────────

describe("loadListingBuyerTotalsByEventId — same tax rate as the event page", () => {
  const EVENT_UUID = "00000000-0000-4000-8000-0000000000e1";
  const TT_UUID = "00000000-0000-4000-8000-0000000000a1";

  /** The min all-in figure the EVENT PAGE quotes (`getCheckoutFeeRates`). */
  async function eventPageMin(
    repos: FakeRepos,
    ev: ListingBuyerTotalEvent,
    tiers: EventTicketTypeSummary[],
  ) {
    const out = await getCheckoutFeeRates(
      {
        repos: {
          ...repos,
          events: {
            getById: vi.fn(async () => ({ ...ev, status: "PUBLISHED" })),
            listTicketTypes: vi.fn(async () => tiers),
          },
        } as never,
        clock: { now: () => NOW },
      },
      { eventId: ev.id },
    );
    return Math.min(...out.perTicketEstimates.map((e) => e.buyerUnitTotalCents));
  }

  const atVenue = (overrides: Partial<ListingBuyerTotalEvent> = {}) =>
    event(EVENT_UUID, {
      placeId: PLACE_NASHVILLE,
      admissionTaxRateBps: null,
      ...overrides,
    });

  it("unstamped event at a venue with a cached rate: the event page's figure", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: 925 });
    const ev = atVenue();
    const tiers = [tier(TT_UUID)];
    const totals = await load(repos, [ev], { [ev.id]: tiers });
    expect(totals.get(ev.id)).toBe(await eventPageMin(repos, ev, tiers));
    // Taxed: strictly above what the same event would cost at 0%.
    const untaxed = await load(makeRepos(baseData(), { placeRateBps: 0 }), [ev], {
      [ev.id]: tiers,
    });
    expect(totals.get(ev.id)).toBeGreaterThan(untaxed.get(ev.id) as number);
  });

  it("unstamped event with no location: priced at 0%, matching the event page", async () => {
    const repos = makeRepos(baseData());
    const ev = event(EVENT_UUID, {
      admissionTaxRateBps: null,
      postalCode: null,
      countryCode: null,
      region: null,
    });
    const tiers = [tier(TT_UUID)];
    const totals = await load(repos, [ev], { [ev.id]: tiers });
    expect(totals.get(ev.id)).not.toBeNull();
    expect(totals.get(ev.id)).toBe(await eventPageMin(repos, ev, tiers));
  });

  // Owner ruling 2026-10-06 (supersedes 2026-10-04, which taxed this at 0):
  // an unknown rate gets NO all-in figure ("See details"), never a 0% one, and
  // the listing never calls the provider — it queues a background fill.
  it("unstamped, venue cache miss (rate unknown): NULL, not a 0% figure — and the venue is queued for a fill", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: null });
    const request = vi.fn(async () => undefined);
    const ev = atVenue();
    const tiers = [tier(TT_UUID)];
    const totals = await load(
      { ...repos, taxRateFills: { request } } as unknown as FakeRepos,
      [ev],
      { [ev.id]: tiers },
    );
    expect(totals.get(ev.id)).toBeNull();
    expect(request).toHaveBeenCalledWith([
      { kind: "place", placeId: PLACE_NASHVILLE },
    ]);
  });

  it("queues ONE fill per venue however many of its events are on the page", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: null });
    const request = vi.fn(async () => undefined);
    const events = ["a", "b", "c"].map((suffix) =>
      event(`00000000-0000-4000-8000-0000000000${suffix}1`, {
        placeId: suffix === "c" ? "venue-2" : PLACE_NASHVILLE,
        admissionTaxRateBps: null,
      }),
    );
    const tiers = Object.fromEntries(events.map((e) => [e.id, [tier(TT_UUID)]]));
    const totals = await load(
      { ...repos, taxRateFills: { request } } as unknown as FakeRepos,
      events,
      tiers,
    );
    expect([...totals.values()]).toEqual([null, null, null]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      [
        { kind: "place", placeId: PLACE_NASHVILLE },
        { kind: "place", placeId: "venue-2" },
      ],
    ]);
  });

  it("a known rate queues nothing; a failed enqueue is reported and the page still loads", async () => {
    const known = makeRepos(baseData(), { placeRateBps: 925 });
    const request = vi.fn(async () => undefined);
    const ev = atVenue();
    const tiers = [tier(TT_UUID)];
    const knownTotals = await load(
      { ...known, taxRateFills: { request } } as unknown as FakeRepos,
      [ev],
      { [ev.id]: tiers },
    );
    expect(knownTotals.get(ev.id)).toBe(await eventPageMin(known, ev, tiers));
    expect(request).not.toHaveBeenCalled();

    const failing = vi.fn(async () => {
      throw new Error("cloud_tasks_create_failed: 503");
    });
    const reportError = vi.fn();
    const totals = await load(
      {
        ...makeRepos(baseData(), { placeRateBps: null }),
        taxRateFills: { request: failing },
      } as unknown as FakeRepos,
      [ev],
      { [ev.id]: tiers },
      { reportError },
    );
    expect(totals.get(ev.id)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "test", step: "requestTaxRateFills" },
      }),
    );
  });

  it("TN instruction-only exemption: a stale stamped rate is quoted at 0, as on the event page", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: 925 });
    const exempt = atVenue({ admissionTaxRateBps: 925, instructionalAdmission: true });
    const taxed = atVenue({ admissionTaxRateBps: 925, instructionalAdmission: false });
    const tiers = [tier(TT_UUID)];
    const exemptTotal = (await load(repos, [exempt], { [exempt.id]: tiers })).get(
      exempt.id,
    );
    const taxedTotal = (await load(repos, [taxed], { [taxed.id]: tiers })).get(
      taxed.id,
    );
    expect(exemptTotal).toBe(await eventPageMin(repos, exempt, tiers));
    expect(taxedTotal).toBe(await eventPageMin(repos, taxed, tiers));
    expect(exemptTotal).toBeLessThan(taxedTotal as number);
  });

  it("TN instruction-only exemption on the cached venue rate of an unstamped event", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: 925 });
    const ev = atVenue({ instructionalAdmission: true });
    const tiers = [tier(TT_UUID)];
    const totals = await load(repos, [ev], { [ev.id]: tiers });
    expect(totals.get(ev.id)).toBe(await eventPageMin(repos, ev, tiers));
    const zero = await load(makeRepos(baseData(), { placeRateBps: 0 }), [atVenue()], {
      [ev.id]: tiers,
    });
    expect(totals.get(ev.id)).toBe(zero.get(ev.id));
  });

  it("ONE places read for the page, though both the situs and the rate need the venue", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: 925 });
    const events = ["a", "b", "c"].map((id) =>
      event(id, { placeId: PLACE_NASHVILLE, admissionTaxRateBps: null }),
    );
    await load(
      repos,
      events,
      Object.fromEntries(events.map((e) => [e.id, [tier(`t-${e.id}`)]])),
    );
    expect(repos.places.getByIds).toHaveBeenCalledTimes(1);
    expect(repos.places.getById).not.toHaveBeenCalled();
  });

  it("150 venues on one page is still ONE places read (a public endpoint)", async () => {
    const repos = makeRepos(baseData(), { placeRateBps: 925 });
    const events = Array.from({ length: 200 }, (_, i) =>
      event(`ev-${i}`, {
        placeId: `venue-${i % 150}`,
        admissionTaxRateBps: i % 2 === 0 ? null : 925,
      }),
    );
    const totals = await load(
      repos,
      events,
      Object.fromEntries(events.map((e) => [e.id, [tier(`t-${e.id}`)]])),
    );
    expect(repos.places.getByIds).toHaveBeenCalledTimes(1);
    expect(repos.places.getByIds.mock.calls[0]![0]).toHaveLength(150);
    expect(repos.places.getById).not.toHaveBeenCalled();
    expect(repos.savedLocations.getById).not.toHaveBeenCalled();
    // Every event was priced from the pre-read rows.
    expect([...totals.values()].every((t) => typeof t === "number")).toBe(true);
  });

  it("one failed batch read over 150 venues files ONE report, not 150", async () => {
    const repos = makeRepos(baseData(), { placeFails: true });
    const reportError = vi.fn();
    const logger = { error: vi.fn() };
    const events = Array.from({ length: 200 }, (_, i) =>
      event(`ev-${i}`, { placeId: `venue-${i % 150}` }),
    );
    const totals = await load(
      repos,
      events,
      Object.fromEntries(events.map((e) => [e.id, [tier(`t-${e.id}`)]])),
      { reportError, logger },
    );
    expect(repos.places.getByIds).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "test", step: "resolveEventTaxSitus" },
      extra: { table: "places", venueCount: 150 },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // The venues stay unreadable: no guessed base, no point-read retries.
    expect(repos.places.getById).not.toHaveBeenCalled();
    expect([...totals.values()].every((t) => t === null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPricingByEventId — the rollup carries the all-in figure
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPricingByEventId", () => {
  const withTiers = (
    repos: FakeRepos,
    tiers: Array<EventTicketTypeSummary & { eventId: string }>,
  ) => ({
    ...repos,
    events: { listTicketTypesForEventIds: vi.fn(async () => tiers) },
  });

  it("fills lowestBuyerTotalCents beside the face rollup", async () => {
    const repos = makeRepos(baseData());
    const ev = event("e1");
    const result = await loadPricingByEventId(
      { repos: withTiers(repos, [{ ...tier("t1"), eventId: "e1" }]) as never },
      [ev],
      NOW,
      { useCase: "test" },
    );
    expect(result.get("e1")).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: await singlePathMin(repos, ev, [tier("t1")]),
    });
  });

  it("a fee read failure keeps the listing, with null totals and a report", async () => {
    const repos = makeRepos(baseData());
    repos.feePolicies.resolveEffective.mockRejectedValueOnce(new Error("db down"));
    const reportError = vi.fn();
    const result = await loadPricingByEventId(
      {
        repos: withTiers(repos, [{ ...tier("t1"), eventId: "e1" }]) as never,
        reportError,
      },
      [event("e1")],
      NOW,
      { useCase: "test" },
    );
    expect(result.get("e1")).toMatchObject({
      paidTierCount: 1,
      minPaidPriceCents: 2500,
      lowestBuyerTotalCents: null,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveBuyerFeeContexts — parity with the single path, bounded queries
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBuyerFeeContexts", () => {
  /**
   * One event per precedence branch:
   *   pinned-primary   ACTIVE PRIMARY, pinned policy, two lines   → agreement
   *   pinned-split     ACTIVE PRIMARY_SPLIT, pinned policy, line  → agreement
   *   primary-wins     PRIMARY + PRIMARY_SPLIT both ACTIVE        → PRIMARY's
   *   no-lines         pinned but lineless                        → scope walk (EVENT)
   *   missing-policy   pinned to a policy id that does not exist  → scope walk (ORG)
   *   archived         only an ARCHIVED PRIMARY                   → scope walk (GLOBAL)
   *   event-scope      no terms, EVENT policy                     → EVENT
   *   org-scope        no terms, ORG policy                       → ORG
   *   no-org           orgId null                                 → GLOBAL
   */
  const parityData = (): StoreData => {
    const pinned = policy("pol-pinned", "EVENT", "pinned-primary", {
      buyerFeePct: 0.05,
      maxFeeCents: null,
      platformFixedCents: 25,
    });
    const split = policy("pol-split", "ORG", "org-split", { buyerFeePct: 0.02 });
    return {
      termsByEvent: {
        "pinned-primary": [terms("t-pp", "PRIMARY", "pol-pinned")],
        "pinned-split": [terms("t-ps", "PRIMARY_SPLIT", "pol-split")],
        "primary-wins": [
          terms("t-pw-split", "PRIMARY_SPLIT", "pol-split"),
          terms("t-pw", "PRIMARY", "pol-pinned"),
        ],
        "no-lines": [terms("t-nl", "PRIMARY", "pol-pinned")],
        "missing-policy": [terms("t-mp", "PRIMARY", "pol-gone")],
        archived: [terms("t-ar", "PRIMARY", "pol-pinned", "ARCHIVED")],
      },
      linesByTerms: {
        "t-pp": [line("l1", "t-pp", 70), line("l2", "t-pp", 30, 1)],
        "t-ps": [line("l3", "t-ps", 100)],
        "t-pw": [line("l4", "t-pw", 100)],
        "t-pw-split": [line("l5", "t-pw-split", 100)],
        "t-nl": [],
        "t-mp": [line("l6", "t-mp", 100)],
        "t-ar": [line("l7", "t-ar", 100)],
      },
      policies: [
        GLOBAL,
        pinned,
        split,
        policy("pol-ev-nolines", "EVENT", "no-lines", { buyerFeePct: 0.04 }),
        policy("pol-ev", "EVENT", "event-scope", { buyerFeePct: 0.01 }),
        policy("pol-org-b", "ORG", ORG_B, { maxFeeCents: 200 }),
      ],
    };
  };

  const parityEvents: ListingBuyerTotalEvent[] = [
    event("pinned-primary"),
    event("pinned-split"),
    event("primary-wins"),
    event("no-lines"),
    event("missing-policy", { orgId: ORG_B }),
    event("archived", { orgId: ORG_C }),
    event("event-scope"),
    event("org-scope", { orgId: ORG_B }),
    event("no-org", { orgId: null }),
  ];
  const parityTiers = [
    tier("t-a", { priceCents: 150 }),
    tier("t-b", { priceCents: 2500 }),
    tier("t-c", { priceCents: 12_000 }),
    tier("t-pwyw", { priceCents: 0, pricingMode: "ADJUSTABLE", minimumCents: 700 }),
    tier("t-free", { priceCents: 0 }),
  ];

  it("batched and single paths produce identical estimates for every precedence branch", async () => {
    const repos = makeRepos(parityData());
    const taxImpositions = resolveTaxImpositions({
      situs: { countryCode: "US", region: "TN", postalCode: "37203" },
      salesTaxRateBps: 925,
    });
    const contexts = await resolveBuyerFeeContexts(
      asDeps(repos),
      parityEvents,
      NOW,
    );
    for (const ev of parityEvents) {
      const single = await estimateBuyerTicketPricingForEvent(
        { repos: asDeps(repos), clock: { now: () => NOW } },
        ev,
        parityTiers,
        { taxImpositions },
      );
      const batched = computeBuyerTicketPricing(
        contexts.get(ev.id) ?? null,
        ev,
        parityTiers,
        { taxImpositions },
        NOW,
      );
      expect({ id: ev.id, ...batched }).toEqual({ id: ev.id, ...single });
    }
  });

  it("resolves the expected policy per branch", async () => {
    const repos = makeRepos(parityData());
    const contexts = await resolveBuyerFeeContexts(asDeps(repos), parityEvents, NOW);
    const policyOf = (id: string) => contexts.get(id)?.feePolicy.id ?? null;
    expect({
      "pinned-primary": policyOf("pinned-primary"),
      "pinned-split": policyOf("pinned-split"),
      "primary-wins": policyOf("primary-wins"),
      "no-lines": policyOf("no-lines"),
      "missing-policy": policyOf("missing-policy"),
      archived: policyOf("archived"),
      "event-scope": policyOf("event-scope"),
      "org-scope": policyOf("org-scope"),
      "no-org": policyOf("no-org"),
    }).toEqual({
      "pinned-primary": "pol-pinned",
      "pinned-split": "pol-split",
      "primary-wins": "pol-pinned",
      "no-lines": "pol-ev-nolines",
      "missing-policy": "pol-org-b",
      archived: "pol-global",
      "event-scope": "pol-ev",
      "org-scope": "pol-org-b",
      "no-org": "pol-global",
    });
    expect(contexts.get("pinned-primary")?.agreement.id).toBe("t-pp");
    expect(contexts.get("pinned-primary")?.lines.map((l) => l.id)).toEqual([
      "l1",
      "l2",
    ]);
  });

  it("no policy at any scope ⇒ null context ⇒ face + tax (same as the single path)", async () => {
    const repos = makeRepos({ termsByEvent: {}, linesByTerms: {}, policies: [] });
    const contexts = await resolveBuyerFeeContexts(asDeps(repos), [event("e1")], NOW);
    expect(contexts.get("e1")).toBeNull();
  });

  it("issues a fixed number of repo calls: 4 events cost the same as 25", async () => {
    const countCalls = async (n: number) => {
      const data = parityData();
      const events: ListingBuyerTotalEvent[] = [];
      for (let i = 0; i < n; i += 1) {
        const id = `ev-${i}`;
        // Mix every branch in: pinned, lineless, org-scoped, global.
        if (i % 4 === 0) {
          data.termsByEvent[id] = [terms(`t-${i}`, "PRIMARY", "pol-pinned")];
          data.linesByTerms[`t-${i}`] = [line(`l-${i}`, `t-${i}`, 100)];
        } else if (i % 4 === 1) {
          data.termsByEvent[id] = [terms(`t-${i}`, "PRIMARY", "pol-pinned")];
        }
        events.push(event(id, { orgId: i % 4 === 2 ? ORG_B : ORG_A }));
      }
      const repos = makeRepos(data);
      await loadListingBuyerTotalsByEventId(
        { repos: asDeps(repos) },
        events,
        new Map(events.map((e) => [e.id, [tier(`tt-${e.id}`)]])),
        NOW,
        { useCase: "test" },
      );
      const calls = (fns: Record<string, { mock: { calls: unknown[] } }>) =>
        Object.fromEntries(
          Object.entries(fns).map(([k, fn]) => [k, fn.mock.calls.length]),
        );
      return { ...calls(repos.payoutTerms), ...calls(repos.feePolicies) };
    };

    // 1 event alone: the pinned branch, no scope walk.
    expect(await countCalls(1)).toEqual({
      listByEvent: 0,
      listLines: 0,
      listByEventIds: 1,
      listLinesByTermsIds: 1,
      getById: 0,
      resolveEffective: 0,
      getByIds: 1,
      resolveEffectiveForScopes: 0,
    });
    // 4 events cover every branch; 25 must cost exactly the same.
    const few = await countCalls(4);
    const many = await countCalls(25);
    expect(many).toEqual(few);
    expect(many).toEqual({
      listByEvent: 0,
      listLines: 0,
      listByEventIds: 1,
      listLinesByTermsIds: 1,
      getById: 0,
      resolveEffective: 1,
      getByIds: 1,
      resolveEffectiveForScopes: 2,
    });
  });
});

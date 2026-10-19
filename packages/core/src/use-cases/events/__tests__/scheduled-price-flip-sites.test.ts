/**
 * FR-004 — every migrated read site reports the pre-flip price before T and the
 * post-flip price at/after T.
 *
 * ONE file rather than an assertion scattered across fourteen, because the thing
 * being tested is a CROSS-SITE invariant: the spec's acceptance criterion is "a
 * ticket type priced $12 with a schedule of $20 at T sells at $12 at T-1s and
 * $20 at T, through web checkout, POS, embeds, and the public page, with no code
 * path disagreeing." A reviewer can read this file top to bottom and see whether
 * any surface disagrees. Split across fourteen files, "no code path disagreeing"
 * is a claim nobody can check.
 *
 * The money-authoritative sites (checkout, POS, promos) were migrated and
 * covered in Phase 1a; this file covers the quote/preview, listing/display,
 * embed and index sites migrated in Phase 1b.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-004,
 * FR-005, FR-008.
 */
import { describe, expect, it, vi } from "vitest";

import type { EventTicketTypeSummary } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import { estimateBuyerTicketPricingForEvent } from "../_shared/estimate-buyer-ticket-pricing";
import { resolveTaxImpositions } from "../../../lib/pricing/tax-impositions";
import {
  loadPricingByEventId,
  summarizePricing,
} from "../_shared/event-pricing";
import { buildEventSeo } from "../_shared/build-event-seo";
import { getEventFeePreview } from "../get-event-fee-preview";
import { estimateCheckoutTax } from "../estimate-checkout-tax";
import { listEventTicketTypes } from "../list-event-ticket-types";
import { listEventTicketTypesForEdit } from "../list-event-ticket-types-for-edit";
import { ticketTiersForCard } from "../ticket-tiers-for-card";
import { listOrganizerEvents } from "../list-organizer-events";
import { getEmbedEventDetail } from "../../embeds/get-embed-event-detail";
import type { GetEmbedEventDetailDeps } from "../../embeds/get-embed-event-detail";

/** The imposition list an unlocated event with this stamped rate resolves to. */
const faceSales = (salesTaxRateBps: number) =>
  resolveTaxImpositions({ situs: null, salesTaxRateBps });

// ── The schedule under test ──────────────────────────────────────────────────

/** The flip instant, T. */
const T = new Date("2026-10-01T20:00:00.000Z");
/** One second before T — the last moment the early-bird price is live. */
const BEFORE = new Date(T.getTime() - 1_000);
/** Exactly T — the flip is INCLUSIVE at the boundary (door-pricing.ts). */
const AT = new Date(T.getTime());
/** Comfortably after T. */
const AFTER = new Date(T.getTime() + 60 * 60 * 1000);

const EARLY_BIRD_CENTS = 1200;
const FULL_PRICE_CENTS = 2000;

const clockAt = (now: Date) => ({ now: () => now });

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const EMBED_ID = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "https://embedder.example.com";

function scheduledTicketType(
  overrides?: Partial<EventTicketTypeSummary>,
): EventTicketTypeSummary {
  return {
    id: TT_ID,
    name: "Early Bird",
    description: null,
    priceCents: EARLY_BIRD_CENTS,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE",
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: FULL_PRICE_CENTS,
    scheduledPriceAt: T,
    ...overrides,
  } as EventTicketTypeSummary;
}

function baseEvent(overrides?: Record<string, unknown>) {
  return {
    id: EVENT_ID,
    title: "Scheduled Show",
    slug: "scheduled-show",
    status: "PUBLISHED",
    gateType: "NONE",
    orgId: ORG_ID,
    humanId: null,
    // Resolved (0%) rather than null, so the tax-unresolved guard on the card
    // panel doesn't null out buyer totals and hide what we're asserting.
    admissionTaxRateBps: 0,
    startsAt: new Date("2026-12-01T20:00:00.000Z"),
    endsAt: new Date("2026-12-01T23:00:00.000Z"),
    currency: "usd",
    heroImageUrl: null,
    heroImageKey: null,
    addressText: "123 Main",
    locality: "Nashville",
    region: "TN",
    locationMode: "EXACT",
    lat: 36.1,
    lng: -86.8,
    locationRadiusMeters: null,
    placeLayoutId: null,
    attendanceMode: "TICKETED",
    waitlistStatus: "DISABLED",
    waitlistDescription: null,
    ...overrides,
  };
}

/** Minimal repos for the fee-estimator path: no terms → ABSORB, no fees. */
function pricingRepos(ticketTypes: EventTicketTypeSummary[]) {
  return {
    events: {
      getById: vi.fn(async () => baseEvent()),
      listTicketTypes: vi.fn(async () => ticketTypes),
      listTicketTypesForEventIds: vi.fn(async () =>
        ticketTypes.map((tt) => ({ ...tt, eventId: EVENT_ID })),
      ),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
      listLines: vi.fn(async () => []),
    },
    feePolicies: {
      getById: vi.fn(async () => null),
      resolveEffective: vi.fn(async () => null),
    },
    tickets: {
      countIssuedForTicketType: vi.fn(async () => 0),
      // Per-tier availability (lock-free batch read) for the public list.
      ...makeTicketCapacityUsageFake().tickets,
    },
    seats: {
      getSectionById: vi.fn(async () => null),
      listSectionsByEvent: vi.fn(async () => []),
    },
    payees: { getBySubject: vi.fn(async () => null) },
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hub every buyer-facing preview flows through
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateBuyerTicketPricingForEvent (FR-004 hub)", () => {
  const run = async (now: Date) =>
    estimateBuyerTicketPricingForEvent(
      { repos: pricingRepos([scheduledTicketType()]), clock: clockAt(now) },
      baseEvent() as any,
      [scheduledTicketType()],
      // `taxImpositions` is REQUIRED — these cases are about the price flip,
      // not the jurisdiction, so they pass the face-base SALES line.
      { taxImpositions: faceSales(0) },
    );

  it("quotes the pre-flip price before T", async () => {
    const result = await run(BEFORE);
    expect(result.perTicketEstimates[0]?.unitPriceCents).toBe(EARLY_BIRD_CENTS);
    expect(result.minBuyerUnitTotalCents).toBe(EARLY_BIRD_CENTS);
  });

  it("quotes the post-flip price at T (inclusive boundary)", async () => {
    const result = await run(AT);
    expect(result.perTicketEstimates[0]?.unitPriceCents).toBe(FULL_PRICE_CENTS);
  });

  it("quotes the post-flip price after T", async () => {
    const result = await run(AFTER);
    expect(result.perTicketEstimates[0]?.unitPriceCents).toBe(FULL_PRICE_CENTS);
    expect(result.minBuyerUnitTotalCents).toBe(FULL_PRICE_CENTS);
  });

  it("applies tax to the EFFECTIVE price, not the stored one", async () => {
    const withTax = async (now: Date) =>
      estimateBuyerTicketPricingForEvent(
        { repos: pricingRepos([scheduledTicketType()]), clock: clockAt(now) },
        baseEvent({ admissionTaxRateBps: 1000 }) as any, // 10%
        [scheduledTicketType()],
        { taxImpositions: faceSales(1000) },
      );

    expect(
      (await withTax(BEFORE)).perTicketEstimates[0]?.taxEstimateCents,
    ).toBe(120);
    expect((await withTax(AFTER)).perTicketEstimates[0]?.taxEstimateCents).toBe(
      200,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quote / preview
// ─────────────────────────────────────────────────────────────────────────────

describe("getEventFeePreview", () => {
  const run = async (now: Date) => {
    const repos = pricingRepos([scheduledTicketType()]);
    repos.authz = {
      getOrgMembership: vi.fn(async () => ({ role: "OWNER" })),
    };
    return getEventFeePreview(
      { repos, clock: clockAt(now), logger: createTestLogger() },
      {
        actorHumanId: "66666666-6666-4666-8666-666666666666",
        eventId: EVENT_ID,
      },
    );
  };

  it("previews the pre-flip price before T and the post-flip price after", async () => {
    // No fee policy resolves → the preview short-circuits with empty
    // breakdowns, so assert through the resolver-backed path by stubbing a
    // policy in. Keeping the fee math trivial (ABSORB, 0%) isolates the price.
    const withPolicy = async (now: Date) => {
      const repos = pricingRepos([scheduledTicketType()]);
      repos.payoutTerms.listByEvent = vi.fn(async () => [
        {
          id: "terms-1",
          kind: "PRIMARY",
          status: "ACTIVE",
          feePolicyId: "policy-1",
          feeMode: "ABSORB",
        },
      ]);
      repos.payoutTerms.listLines = vi.fn(async () => [
        {
          id: "line-1",
          payeeId: "payee-1",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ]);
      repos.feePolicies.getById = vi.fn(async () => ({
        id: "policy-1",
        version: 1,
        feeMode: "ABSORB",
        processsorFeePct: 0,
        processorFixedCents: 0,
        payoutPct: 0,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
        buyerFeePct: 0,
        maxFeeCents: null,
        minFeeCents: 0,
        platformFixedCents: 0,
      }));
      repos.authz = {
        getOrgMembership: vi.fn(async () => ({ role: "OWNER" })),
      };
      return getEventFeePreview(
        { repos, clock: clockAt(now), logger: createTestLogger() },
        {
          actorHumanId: "66666666-6666-4666-8666-666666666666",
          eventId: EVENT_ID,
        },
      );
    };

    const before = await withPolicy(BEFORE);
    expect(before.ticketBreakdowns[0]?.unitPriceCents).toBe(EARLY_BIRD_CENTS);
    expect(before.ticketBreakdowns[0]?.buyerTotalCents).toBe(EARLY_BIRD_CENTS);

    const after = await withPolicy(AFTER);
    expect(after.ticketBreakdowns[0]?.unitPriceCents).toBe(FULL_PRICE_CENTS);
    expect(after.ticketBreakdowns[0]?.buyerTotalCents).toBe(FULL_PRICE_CENTS);
  });

  void run;
});

describe("estimateCheckoutTax", () => {
  const run = async (now: Date) =>
    estimateCheckoutTax(
      {
        repos: {
          events: {
            getById: vi.fn(async () =>
              baseEvent({ admissionTaxRateBps: 1000 }),
            ),
            listTicketTypes: vi.fn(async () => [scheduledTicketType()]),
          },
        } as any,
        clock: clockAt(now),
      },
      { eventId: EVENT_ID, items: [{ ticketTypeId: TT_ID, qty: 2 }] },
    );

  it("taxes the pre-flip subtotal before T", async () => {
    // 2 × $12.00 = $24.00; 10% = $2.40
    expect((await run(BEFORE)).taxAmountCents).toBe(240);
  });

  it("taxes the post-flip subtotal at/after T", async () => {
    // 2 × $20.00 = $40.00; 10% = $4.00
    expect((await run(AT)).taxAmountCents).toBe(400);
    expect((await run(AFTER)).taxAmountCents).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Listing / display
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventTicketTypes (public ticket list)", () => {
  const run = async (now: Date) =>
    listEventTicketTypes(
      { repos: pricingRepos([scheduledTicketType()]), clock: clockAt(now) },
      { eventId: EVENT_ID },
    );

  it("lists the pre-flip price before T", async () => {
    expect((await run(BEFORE)).ticketTypes[0]?.priceCents).toBe(
      EARLY_BIRD_CENTS,
    );
  });

  it("lists the post-flip price at/after T", async () => {
    expect((await run(AT)).ticketTypes[0]?.priceCents).toBe(FULL_PRICE_CENTS);
    expect((await run(AFTER)).ticketTypes[0]?.priceCents).toBe(
      FULL_PRICE_CENTS,
    );
  });
});

describe("listEventTicketTypesForEdit (admin edit projection)", () => {
  const run = async (now: Date) => {
    const repos = pricingRepos([scheduledTicketType()]);
    repos.authz = {
      getOrgMembership: vi.fn(async () => ({ role: "OWNER" })),
    };
    return listEventTicketTypesForEdit(
      { repos, clock: clockAt(now), logger: createTestLogger() },
      {
        actorHumanId: "66666666-6666-4666-8666-666666666666",
        eventId: EVENT_ID,
      },
    );
  };

  it("keeps `priceCents` as the STORED list price on BOTH sides of T", async () => {
    // The load-bearing exemption: this field is bound to the organizer's Price
    // input and written straight back by updateTicketType. If it ever tracked
    // the flip, the next save would collapse the schedule.
    expect((await run(BEFORE)).ticketTypes[0]?.priceCents).toBe(
      EARLY_BIRD_CENTS,
    );
    expect((await run(AFTER)).ticketTypes[0]?.priceCents).toBe(
      EARLY_BIRD_CENTS,
    );
  });

  it("exposes the resolved price additively as `effectivePriceCents`", async () => {
    expect((await run(BEFORE)).ticketTypes[0]?.effectivePriceCents).toBe(
      EARLY_BIRD_CENTS,
    );
    expect((await run(AFTER)).ticketTypes[0]?.effectivePriceCents).toBe(
      FULL_PRICE_CENTS,
    );
  });

  it("reads the schedule back for the organizer (Q-002)", async () => {
    const result = await run(BEFORE);
    expect(result.ticketTypes[0]?.scheduledPriceCents).toBe(FULL_PRICE_CENTS);
    expect(result.ticketTypes[0]?.scheduledPriceAt).toEqual(T);
  });
});

describe("ticketTiersForCard (card price-reveal panel)", () => {
  const run = async (now: Date) =>
    ticketTiersForCard(
      { repos: pricingRepos([scheduledTicketType()]), clock: clockAt(now) },
      { eventId: EVENT_ID },
    );

  it("shows the pre-flip face value before T", async () => {
    expect((await run(BEFORE)).tiers[0]?.faceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("shows the post-flip face value at/after T", async () => {
    expect((await run(AT)).tiers[0]?.faceCents).toBe(FULL_PRICE_CENTS);
    expect((await run(AFTER)).tiers[0]?.faceCents).toBe(FULL_PRICE_CENTS);
  });
});

describe('summarizePricing / loadPricingByEventId (the "$25+" label on every listing surface)', () => {
  it("rolls up the pre-flip minimum before T", () => {
    expect(summarizePricing([scheduledTicketType()], BEFORE)).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: EARLY_BIRD_CENTS,
    });
  });

  it("rolls up the post-flip minimum at/after T", () => {
    expect(
      summarizePricing([scheduledTicketType()], AT).minPaidPriceCents,
    ).toBe(FULL_PRICE_CENTS);
    expect(
      summarizePricing([scheduledTicketType()], AFTER).minPaidPriceCents,
    ).toBe(FULL_PRICE_CENTS);
  });

  it("moves a tier scheduled to become FREE from paid to free at T", () => {
    const becomesFree = scheduledTicketType({ scheduledPriceCents: 0 });
    expect(summarizePricing([becomesFree], BEFORE)).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: EARLY_BIRD_CENTS,
    });
    expect(summarizePricing([becomesFree], AFTER)).toEqual({
      hasFreeTier: true,
      hasPayWhatYouWantTier: false,
      paidTierCount: 0,
      minPaidPriceCents: null,
    });
  });

  it("ignores non-ACTIVE tiers and gives such an event NO map entry", async () => {
    const draftOnly = scheduledTicketType({ status: "DRAFT" });
    const eventsRepo = {
      listTicketTypesForEventIds: vi.fn(async () => [
        { ...draftOnly, eventId: EVENT_ID },
      ]),
    } as any;
    const map = await loadPricingByEventId(
      { repos: { events: eventsRepo } } as any,
      [{ id: EVENT_ID }] as any,
      AFTER,
      { useCase: "test" },
    );
    expect(map.has(EVENT_ID)).toBe(false);
  });

  it("batches by event and flips each event's minimum at T", async () => {
    const eventsRepo = {
      listTicketTypesForEventIds: vi.fn(async () => [
        { ...scheduledTicketType(), eventId: EVENT_ID },
        {
          ...scheduledTicketType({ id: OTHER_EVENT_ID, priceCents: 500 }),
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          eventId: OTHER_EVENT_ID,
        },
      ]),
    } as any;

    // Stamped 0% and no fee policy anywhere, so the all-in figure equals the
    // face — which lets this pin that the ALL-IN figure flips at T too.
    const listingEvent = (id: string) => ({
      id,
      orgId: null,
      admissionTaxRateBps: 0,
      placeId: null,
      savedLocationId: null,
    });
    const deps = {
      repos: {
        events: eventsRepo,
        places: { getById: vi.fn(async () => null) },
        savedLocations: { getById: vi.fn(async () => null) },
        payoutTerms: { listByEventIds: vi.fn(async () => new Map()) },
        feePolicies: {
          resolveEffective: vi.fn(async () => null),
          resolveEffectiveForScopes: vi.fn(async () => new Map()),
        },
      },
    } as any;
    const events = [listingEvent(EVENT_ID), listingEvent(OTHER_EVENT_ID)];
    const before = await loadPricingByEventId(deps, events, BEFORE, {
      useCase: "test",
    });
    expect(before.get(EVENT_ID)?.minPaidPriceCents).toBe(EARLY_BIRD_CENTS);
    // NFR-001: an unscheduled row is untouched on both sides of T.
    expect(before.get(OTHER_EVENT_ID)?.minPaidPriceCents).toBe(500);
    expect(before.get(EVENT_ID)?.lowestBuyerTotalCents).toBe(EARLY_BIRD_CENTS);

    const after = await loadPricingByEventId(deps, events, AFTER, {
      useCase: "test",
    });
    expect(after.get(EVENT_ID)?.minPaidPriceCents).toBe(FULL_PRICE_CENTS);
    expect(after.get(OTHER_EVENT_ID)?.minPaidPriceCents).toBe(500);
    expect(after.get(EVENT_ID)?.lowestBuyerTotalCents).toBe(FULL_PRICE_CENTS);
  });
});

describe("buildEventSeo (JSON-LD offers.price)", () => {
  const run = (now: Date) =>
    buildEventSeo({
      event: baseEvent() as any,
      ticketTypes: [scheduledTicketType()] as any,
      eventHumans: [],
      now,
    });

  it("advertises the pre-flip price before T", () => {
    expect(run(BEFORE).pricing?.minPriceCents).toBe(EARLY_BIRD_CENTS);
    expect(run(BEFORE).pricing?.maxPriceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("advertises the post-flip price at/after T", () => {
    expect(run(AT).pricing?.minPriceCents).toBe(FULL_PRICE_CENTS);
    expect(run(AFTER).pricing?.minPriceCents).toBe(FULL_PRICE_CENTS);
  });
});

describe('listOrganizerEvents ("More by this organizer" cards)', () => {
  const run = async (now: Date) => {
    const sibling = {
      ...baseEvent({ id: OTHER_EVENT_ID, slug: "sibling-show" }),
      startsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000),
    };
    const gate = makeImageModerationGateFake({});
    const repos = {
      events: {
        getById: vi.fn(async () => baseEvent()),
        listByOwner: vi.fn(async () => ({ items: [sibling] })),
        listTicketTypesForEventIds: vi.fn(async () => [
          { ...scheduledTicketType(), eventId: OTHER_EVENT_ID },
        ]),
      },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "The Org" })),
      },
      imageModerationRecords: gate.imageModerationRecords,
    } as any;

    return listOrganizerEvents(
      { repos, clock: clockAt(now), logger: createTestLogger() },
      { eventId: EVENT_ID },
    );
  };

  it("shows the pre-flip cheapest price before T", async () => {
    expect((await run(BEFORE)).events[0]?.priceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("shows the post-flip cheapest price at/after T", async () => {
    expect((await run(AT)).events[0]?.priceCents).toBe(FULL_PRICE_CENTS);
    expect((await run(AFTER)).events[0]?.priceCents).toBe(FULL_PRICE_CENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Embeds — third-party surfaces must agree with our own
// ─────────────────────────────────────────────────────────────────────────────

describe("getEmbedEventDetail", () => {
  const run = async (now: Date) => {
    const gate = makeImageModerationGateFake({});
    const deps = {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({
            id: EMBED_ID,
            domain: "embedder.example.com",
            subjectType: "event",
            subjectId: EVENT_ID,
            status: "ACTIVE",
            requireAuth: false,
            linkOut: false,
          })),
        },
        events: {
          getById: vi.fn(async () => baseEvent()),
          listTicketTypes: vi.fn(async () => [scheduledTicketType()]),
          getContent: vi.fn(async () => null),
        },
        eventHumans: { listByEvent: vi.fn(async () => []) },
        tags: { getEventTags: vi.fn(async () => []) },
        images: { resolveByIds: vi.fn(async () => []) },
        seats: { listSectionsByEvent: vi.fn(async () => []) },
        seriesOccurrences: {
          findSeriesIdByEventId: vi.fn(async () => null),
          listPublishedDatesBySeriesId: vi.fn(async () => []),
        },
        imageModerationRecords: gate.imageModerationRecords,
        ...makeTicketCapacityUsageFake(),
      } as unknown as GetEmbedEventDetailDeps["repos"],
      publicAppUrl: "http://localhost:3000",
      clock: clockAt(now),
      logger: createTestLogger(),
    } satisfies GetEmbedEventDetailDeps;

    return getEmbedEventDetail(deps, {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: ORIGIN,
    });
  };

  it("serves the pre-flip price before T", async () => {
    expect((await run(BEFORE)).ticketTypes[0]?.priceCents).toBe(
      EARLY_BIRD_CENTS,
    );
  });

  it("serves the post-flip price at/after T", async () => {
    expect((await run(AT)).ticketTypes[0]?.priceCents).toBe(FULL_PRICE_CENTS);
    expect((await run(AFTER)).ticketTypes[0]?.priceCents).toBe(
      FULL_PRICE_CENTS,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NFR-001 — the overwhelming majority of rows have no schedule, forever
// ─────────────────────────────────────────────────────────────────────────────

describe("NFR-001 — an unscheduled row behaves identically at every instant", () => {
  const plain = scheduledTicketType({
    scheduledPriceCents: null,
    scheduledPriceAt: null,
  });

  it("summarizePricing", () => {
    for (const now of [BEFORE, AT, AFTER]) {
      expect(summarizePricing([plain], now).minPaidPriceCents).toBe(
        EARLY_BIRD_CENTS,
      );
    }
  });

  it("the buyer-pricing hub", async () => {
    for (const now of [BEFORE, AT, AFTER]) {
      const result = await estimateBuyerTicketPricingForEvent(
        { repos: pricingRepos([plain]), clock: clockAt(now) },
        baseEvent() as any,
        [plain],
        { taxImpositions: faceSales(0) },
      );
      expect(result.perTicketEstimates[0]?.unitPriceCents).toBe(
        EARLY_BIRD_CENTS,
      );
    }
  });

  it("a HALF-configured row is inert (write boundary rejects it; readers fail safe)", async () => {
    const half = scheduledTicketType({ scheduledPriceAt: null });
    for (const now of [BEFORE, AT, AFTER]) {
      expect(summarizePricing([half], now).minPaidPriceCents).toBe(
        EARLY_BIRD_CENTS,
      );
    }
  });
});

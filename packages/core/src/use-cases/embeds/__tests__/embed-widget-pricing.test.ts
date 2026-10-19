import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type {
  EventSuggestion,
  MultiSearchAutocompleteInput,
} from "@th/ports/search/multi-index.types";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";

import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

/**
 * Pricing pass-through for the widget payload.
 *
 * The widget renders the SHARED event card, which draws a price label from
 * `lowestPriceCents` + `paidTierCount` + `hasFreeTier`. Every one of those
 * already exists on the search index; the whole grid read a "See details"
 * fallback purely because the projection chain dropped them. These tests pin
 * the chain END TO END — real `unifiedSearch` (whose event suggestion schema
 * silently omitted two of the three) → `EmbedEvent` → widget item — so a leg
 * or hop that stops carrying pricing fails HERE rather than as a grid of
 * price-less cards on someone else's website.
 *
 * The 0-vs-null rule is the subtle one and is asserted explicitly: a free tier
 * pins `lowestPriceCents` to 0, and null means "no ACTIVE tiers at all". A
 * projection that treats 0 as "unknown" turns "Free+" into "See details".
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000f0";
const ORG_ID = "00000000-0000-4000-8000-0000000000f1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000f2";
const OWNED_PLACE_ID = "00000000-0000-4000-8000-0000000000f3";

const DOMAIN = "venue.example.com";
const ORIGIN = "https://venue.example.com";
const PUBLIC_APP_URL = "http://localhost:3000";

const soon = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

type Pricing = {
  lowestPriceCents: number | null;
  paidTierCount: number;
  hasFreeTier: boolean;
};

/** The three shapes the index can hand back, named for the label they drive. */
const PAID_MULTI_TIER: Pricing = {
  lowestPriceCents: 2500,
  paidTierCount: 3,
  hasFreeTier: false,
};
const FREE_PLUS_PAID: Pricing = {
  // Index semantics: a free tier pins the low price to 0 even though paid
  // tiers exist. This is the "Free+" card.
  lowestPriceCents: 0,
  paidTierCount: 2,
  hasFreeTier: true,
};
const NO_TIERS: Pricing = {
  lowestPriceCents: null,
  paidTierCount: 0,
  hasFreeTier: false,
};

function toSuggestion(
  id: string,
  title: string,
  pricing: Pricing,
): EventSuggestion {
  return {
    type: "event",
    id: `doc-${id}`,
    eventId: id,
    title,
    subtitle: null,
    helper: null,
    slug: `slug-${id}`,
    startsAt: soon(7),
    endsAt: null,
    city: "Nashville",
    region: "TN",
    location: "123 Main St",
    lat: null,
    lng: null,
    imageUrl: null,
    lowestBuyerTotalCents: null,
    currency: "usd",
    confidence: 1,
    ...pricing,
  };
}

const embedRecord = (
  subjectType: "organization" | "event",
  subjectId: string,
): EmbedRecord => ({
  id: EMBED_ID,
  subjectType,
  subjectId,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: null,
  createdAt: new Date("2026-01-01"),
});

const ownedPlace = { id: OWNED_PLACE_ID, name: "Our Room" } as PlaceRecord;

// ─────────────────────────────────────────────────────────────────────────────
// Organization grid (search-served)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fake search routed the same way `embed-scope.test.ts` does it: a `placeIds`
 * filter means the VENUES leg, anything else the OWN leg. Keeping both legs
 * distinguishable is what lets the tests below prove pricing survives on each
 * one independently — a field mapped in only one leg is the failure mode.
 */
function gridDeps(opts: {
  ownEvents?: EventSuggestion[];
  venueEvents?: EventSuggestion[];
}) {
  const { ownEvents = [], venueEvents = [] } = opts;

  const autocomplete = vi.fn(async (input: MultiSearchAutocompleteInput) => {
    const suggestions = input.filters?.placeIds?.length
      ? venueEvents
      : ownEvents;
    return {
      ok: true as const,
      value: { suggestions, latencyMs: 1 },
    };
  });

  const deps = {
    repos: {
      embeds: {
        getById: vi.fn(async () => embedRecord("organization", ORG_ID)),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: ORG_ID,
          name: "Dev QA Collective",
          slug: "dev-qa-collective",
        })),
      },
      humans: { getById: vi.fn() },
      places: { listOwnedBySubject: vi.fn(async () => [ownedPlace]) },
      events: {
        getById: vi.fn(),
        listTicketTypes: vi.fn(async () => []),
        // The card's gate comes from the event row (the index has none).
        findManyByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, gateType: "NONE" })),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    } as unknown as GetEmbedForWidgetDeps["repos"],
    search: { autocomplete } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: PUBLIC_APP_URL,
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;

  return { deps, autocomplete };
}

const baseInput = { embedId: EMBED_ID, hostOrigin: ORIGIN };

describe("getEmbedForWidget grid — pricing survives the search projection", () => {
  it("carries a paid multi-tier event's pricing verbatim onto the widget item", async () => {
    const { deps } = gridDeps({
      ownEvents: [toSuggestion(EVENT_ID, "Paid Show", PAID_MULTI_TIER)],
    });

    const result = await getEmbedForWidget(deps, baseInput);

    expect(result.events?.[0]).toMatchObject({
      id: EVENT_ID,
      lowestPriceCents: 2500,
      paidTierCount: 3,
      hasFreeTier: false,
    });
  });

  it("preserves lowestPriceCents 0 for a free+paid event (Free+, not 'See details')", async () => {
    const { deps } = gridDeps({
      ownEvents: [toSuggestion(EVENT_ID, "Free Plus", FREE_PLUS_PAID)],
    });

    const result = await getEmbedForWidget(deps, baseInput);

    const item = result.events?.[0];
    // Explicitly `0`, never null/undefined — the whole point of the rule.
    expect(item?.lowestPriceCents).toBe(0);
    expect(item?.hasFreeTier).toBe(true);
    expect(item?.paidTierCount).toBe(2);
  });

  it("passes a tier-less event through as null / 0 / false", async () => {
    const { deps } = gridDeps({
      ownEvents: [toSuggestion(EVENT_ID, "Community Listing", NO_TIERS)],
    });

    const result = await getEmbedForWidget(deps, baseInput);

    expect(result.events?.[0]).toMatchObject({
      lowestPriceCents: null,
      paidTierCount: 0,
      hasFreeTier: false,
    });
  });

  it("carries pricing on the VENUES leg too, not just the own leg", async () => {
    const { deps } = gridDeps({
      venueEvents: [
        toSuggestion("ev-venue", "Someone Else's Show", PAID_MULTI_TIER),
      ],
    });

    const result = await getEmbedForWidget(deps, {
      ...baseInput,
      scope: "venues",
    });

    expect(result.events?.[0]).toMatchObject({
      id: "ev-venue",
      lowestPriceCents: 2500,
      paidTierCount: 3,
      hasFreeTier: false,
    });
  });

  it("carries pricing on BOTH legs of scope 'all'", async () => {
    const { deps } = gridDeps({
      ownEvents: [toSuggestion("ev-own", "Our Show", PAID_MULTI_TIER)],
      venueEvents: [toSuggestion("ev-venue", "Their Show", FREE_PLUS_PAID)],
    });

    const result = await getEmbedForWidget(deps, {
      ...baseInput,
      scope: "all",
    });

    const byId = new Map(result.events?.map((e) => [e.id, e]));
    expect(byId.get("ev-own")).toMatchObject({
      lowestPriceCents: 2500,
      paidTierCount: 3,
      hasFreeTier: false,
    });
    expect(byId.get("ev-venue")).toMatchObject({
      lowestPriceCents: 0,
      paidTierCount: 2,
      hasFreeTier: true,
    });
  });

  it("emits every pricing key on every item (no undefined holes for the card)", async () => {
    const { deps } = gridDeps({
      ownEvents: [
        toSuggestion("ev-a", "A", PAID_MULTI_TIER),
        toSuggestion("ev-b", "B", NO_TIERS),
      ],
    });

    const result = await getEmbedForWidget(deps, baseInput);

    for (const item of result.events ?? []) {
      // `in` rather than a truthiness check: 0/null/false are all valid values,
      // and a MISSING key is the regression this guards.
      expect("lowestPriceCents" in item).toBe(true);
      expect("paidTierCount" in item).toBe(true);
      expect("hasFreeTier" in item).toBe(true);
    }
  });
});

describe("getEmbedForWidget grid — placeLabel is the search suggestion's subtitle", () => {
  const named = (
    id: string,
    subtitle: string | null,
    locationIsExact = true,
  ): EventSuggestion => ({
    ...toSuggestion(id, `Show ${id}`, PAID_MULTI_TIER),
    subtitle,
    locationIsExact,
  });

  it("carries the index's place label beside the address, on the own leg", async () => {
    const { deps } = gridDeps({ ownEvents: [named(EVENT_ID, "The Basement")] });

    const result = await getEmbedForWidget(deps, baseInput);

    expect(result.events?.[0]).toMatchObject({
      id: EVENT_ID,
      placeLabel: "The Basement",
      addressText: "123 Main St",
      locality: "Nashville",
      region: "TN",
    });
  });

  it("carries it on the VENUES leg and on both legs of scope 'all'", async () => {
    const venuesOnly = await getEmbedForWidget(
      gridDeps({ venueEvents: [named("ev-venue", "Our Room")] }).deps,
      { ...baseInput, scope: "venues" },
    );
    expect(venuesOnly.events?.[0]?.placeLabel).toBe("Our Room");

    const all = await getEmbedForWidget(
      gridDeps({
        ownEvents: [named("ev-own", "The Basement")],
        venueEvents: [named("ev-venue", "Our Room")],
      }).deps,
      { ...baseInput, scope: "all" },
    );
    const byId = new Map(all.events?.map((e) => [e.id, e.placeLabel]));
    expect(byId.get("ev-own")).toBe("The Basement");
    expect(byId.get("ev-venue")).toBe("Our Room");
  });

  it("is null when the public location is not exact, though the index names the place", async () => {
    // The index names a confirmed place on a gated or approximate event; a
    // widget on someone else's page keeps printing only the coarse location.
    const { deps } = gridDeps({
      ownEvents: [named(EVENT_ID, "The Shelby House", false)],
    });

    const result = await getEmbedForWidget(deps, baseInput);

    expect(result.events?.[0]?.placeLabel).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Shelby");
  });

  it("is null when the index document predates the exact flag", async () => {
    const { locationIsExact: _dropped, ...legacy } = named(EVENT_ID, "The Basement");

    const result = await getEmbedForWidget(
      gridDeps({ ownEvents: [legacy as EventSuggestion] }).deps,
      baseInput,
    );

    expect(result.events?.[0]?.placeLabel).toBeNull();
  });

  it("is null, never undefined, when the index has no label", async () => {
    const { deps } = gridDeps({ ownEvents: [named(EVENT_ID, null)] });

    const result = await getEmbedForWidget(deps, baseInput);

    const item = result.events?.[0];
    expect(item && "placeLabel" in item).toBe(true);
    expect(item?.placeLabel).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-event subject (DB-served)
// ─────────────────────────────────────────────────────────────────────────────

type TicketTypeFixture = {
  id: string;
  name: string;
  priceCents: number;
  capacity: number;
  status: string;
};

const tier = (
  id: string,
  priceCents: number,
  status = "ACTIVE",
): TicketTypeFixture => ({ id, name: id, priceCents, capacity: 10, status });

function eventSubjectDeps(ticketTypes: TicketTypeFixture[]) {
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embedRecord("event", EVENT_ID)) },
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          title: "Embedded Show",
          slug: "embedded-show",
          startsAt: soon(7),
          endsAt: null,
          currency: "usd",
          heroImageUrl: null,
          heroImageKey: null,
          addressText: "123 Main",
          locality: "Nashville",
          region: "TN",
          orgId: ORG_ID,
          status: "PUBLISHED",
          gateType: "NONE",
        })),
        listTicketTypes: vi.fn(async () => ticketTypes),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    } as unknown as GetEmbedForWidgetDeps["repos"],
    // The single-event path reads the event directly; search is never consulted.
    search: {
      autocomplete: vi.fn(),
    } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: PUBLIC_APP_URL,
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;
}

describe("getEmbedForWidget single event — pricing derived from ACTIVE tiers", () => {
  it("takes the cheapest PAID tier and counts only paid tiers", async () => {
    const result = await getEmbedForWidget(
      eventSubjectDeps([tier("ga", 2500), tier("vip", 7500)]),
      baseInput,
    );

    expect(result.event).toMatchObject({
      lowestPriceCents: 2500,
      paidTierCount: 2,
      hasFreeTier: false,
    });
  });

  it("pins lowestPriceCents to 0 when a free tier exists alongside paid ones", async () => {
    const result = await getEmbedForWidget(
      eventSubjectDeps([tier("rsvp", 0), tier("ga", 2500)]),
      baseInput,
    );

    // Index parity: the grid stores 0 for free+paid, so the single-event card
    // must not read $25 where the grid card reads Free+.
    expect(result.event).toMatchObject({
      lowestPriceCents: 0,
      paidTierCount: 1,
      hasFreeTier: true,
    });
  });

  it("IGNORES non-ACTIVE tiers, matching the ticketTypes list it returns", async () => {
    const result = await getEmbedForWidget(
      eventSubjectDeps([tier("draft", 500, "DRAFT"), tier("ga", 2500)]),
      baseInput,
    );

    // A DRAFT $5 tier must not advertise a $5 event.
    expect(result.event).toMatchObject({
      lowestPriceCents: 2500,
      paidTierCount: 1,
      hasFreeTier: false,
    });
    expect(result.ticketTypes?.map((t) => t.id)).toEqual(["ga"]);
  });

  it("reports no pricing at all when the event has no ACTIVE tiers", async () => {
    const result = await getEmbedForWidget(
      eventSubjectDeps([tier("draft", 500, "DRAFT")]),
      baseInput,
    );

    expect(result.event).toMatchObject({
      lowestPriceCents: null,
      paidTierCount: 0,
      hasFreeTier: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// All-in figure (owner ruling 2026-10-02: listings quote ALL-IN, never face)
// ─────────────────────────────────────────────────────────────────────────────

describe("getEmbedForWidget — lowestBuyerTotalCents", () => {
  it("grid: carries a plausible indexed all-in total", async () => {
    const { deps } = gridDeps({
      ownEvents: [
        {
          ...toSuggestion(EVENT_ID, "Paid Show", PAID_MULTI_TIER),
          lowestBuyerTotalCents: 2862,
        },
      ],
    });
    const result = await getEmbedForWidget(deps, baseInput);
    expect(result.events?.[0]?.lowestBuyerTotalCents).toBe(2862);
  });

  it("grid: drops a stale indexed total (below face) to null", async () => {
    const { deps } = gridDeps({
      ownEvents: [
        {
          ...toSuggestion(EVENT_ID, "Paid Show", PAID_MULTI_TIER),
          lowestBuyerTotalCents: 2000,
        },
      ],
    });
    const result = await getEmbedForWidget(deps, baseInput);
    expect(result.events?.[0]?.lowestBuyerTotalCents).toBeNull();
  });

  const withFeeContext = (
    deps: ReturnType<typeof eventSubjectDeps>,
    admissionTaxRateBps: number | null,
  ) => {
    const repos = deps.repos as unknown as Record<string, unknown> & {
      events: { getById: ReturnType<typeof vi.fn> };
    };
    const getById = repos.events.getById;
    repos.events.getById = vi.fn(async () => ({
      ...(await getById()),
      admissionTaxRateBps,
      placeId: null,
      savedLocationId: null,
    }));
    Object.assign(repos, {
      places: { getById: vi.fn(async () => null) },
      savedLocations: { getById: vi.fn(async () => null) },
      payoutTerms: {
        listByEventIds: vi.fn(async (ids: readonly string[]) =>
          new Map(ids.map((id) => [id, []] as const)),
        ),
        listLinesByTermsIds: vi.fn(async () => new Map()),
      },
      feePolicies: {
        getByIds: vi.fn(async () => new Map()),
        resolveEffectiveForScopes: vi.fn(async () => new Map()),
        resolveEffective: vi.fn(async () => null),
      },
    });
    return deps;
  };

  it("single event: computed live (stamped 0%, no fee policy ⇒ all-in = face)", async () => {
    const result = await getEmbedForWidget(
      withFeeContext(eventSubjectDeps([tier("ga", 2500), tier("vip", 7500)]), 0),
      baseInput,
    );
    expect(result.event?.lowestBuyerTotalCents).toBe(2500);
  });

  it("single event: tax rate never stamped, no location ⇒ quoted at 0% like the event page", async () => {
    const result = await getEmbedForWidget(
      withFeeContext(eventSubjectDeps([tier("ga", 2500)]), null),
      baseInput,
    );
    expect(result.event?.lowestBuyerTotalCents).toBe(2500);
  });

  it("single event: a failed fee read ⇒ null (never the face), reported", async () => {
    const deps = withFeeContext(eventSubjectDeps([tier("ga", 2500)]), 0);
    const reportError = vi.fn();
    (deps.repos as unknown as {
      feePolicies: { resolveEffective: ReturnType<typeof vi.fn> };
    }).feePolicies.resolveEffective = vi.fn(async () => {
      throw new Error("db down");
    });
    const result = await getEmbedForWidget({ ...deps, reportError }, baseInput);
    expect(result.event?.lowestBuyerTotalCents).toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "getEmbedForWidget", step: "loadListingBuyerTotals" },
      extra: { eventCount: 1 },
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  getEmbedCalendarEvents,
  getEmbedCalendarEventsOutputSchema,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import type {
  EventSuggestion,
  MultiSearchAutocompleteInput,
} from "@th/ports/search/multi-index.types";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * FR-003 volume bounds on the PUBLIC, unauthenticated org/human calendar
 * embed (event-calendar-redesign; docs/specs/2026-09-02).
 *
 * The search legs cap EVENTS at `CALENDAR_EVENT_LIMIT` (200) BEFORE
 * expansion; one long residency among 200 events could therefore multiply
 * the response many times over. Pinned here:
 *   - the flattened, chronological result is RE-CAPPED to 200 after
 *     expansion, keeping the earliest items — this is the ONLY volume bound
 *     on these legs;
 *   - a listing's nights are NOT trimmed to a forward `to`: the search legs
 *     admit events with no forward bound, so a listing whose every night
 *     sits past `from + 90d` must keep its nights (trimming would drop the
 *     whole listing while a row-less event on the same night still
 *     rendered);
 *   - the payload parses against the `.strict()` output schema — expansion
 *     adds only `occurrence`, nothing else rides along.
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000e0";
const ORG_ID = "00000000-0000-4000-8000-0000000000e1";
const LISTING_ID = "00000000-0000-4000-8000-0000000000e2";
const DOMAIN = "venue.example.com";
const HOST_ORIGIN = "https://venue.example.com";

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
const uuidFor = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Fixture = {
  id: string;
  title: string;
  startsAt: Date;
  /** The index's place label (`EventSuggestion.subtitle`); default null. */
  subtitle?: string | null;
  /** Omitted = an index document that predates the flag. */
  locationIsExact?: boolean;
};

function toSuggestion(e: Fixture): EventSuggestion {
  return {
    type: "event",
    id: `doc-${e.id}`,
    eventId: e.id,
    title: e.title,
    subtitle: e.subtitle ?? null,
    ...(e.locationIsExact === undefined
      ? {}
      : { locationIsExact: e.locationIsExact }),
    helper: null,
    slug: `slug-${e.id}`,
    startsAt: e.startsAt,
    endsAt: null,
    city: "Nashville",
    region: "TN",
    location: "123 Main St",
    lat: null,
    lng: null,
    imageUrl: null,
    lowestPriceCents: null,
    lowestBuyerTotalCents: null,
    currency: "usd",
    paidTierCount: 0,
    hasFreeTier: false,
    confidence: 1,
  };
}

const embed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "calendar",
  viewToggle: true,
  createdBy: null,
  createdAt: new Date("2026-01-01"),
};

/** A listing with `nights` weekly SCHEDULED rows starting `firstInDays` out. */
function scheduledNights(nights: number, firstInDays: number) {
  return Array.from({ length: nights }, (_, i) => ({
    id: uuidFor(900_000 + i),
    eventId: LISTING_ID,
    ordinal: i + 1,
    startsAt: inDays(firstInDays + i * 7),
    endsAt: null,
    status: "SCHEDULED" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

function makeDeps(opts: {
  ownEvents: Fixture[];
  dates: ReturnType<typeof scheduledNights>;
}) {
  const autocomplete = vi.fn(async (input: MultiSearchAutocompleteInput) => ({
    ok: true as const,
    value: {
      suggestions: opts.ownEvents.slice(0, input.limit ?? 10).map(toSuggestion),
      latencyMs: 1,
    },
  }));
  const listByEventIds = vi.fn(async () => opts.dates);

  const repos = {
    embeds: { getById: vi.fn(async () => embed) },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Dev QA Collective" })),
    },
    humans: { getById: vi.fn(async () => null) },
    places: { listOwnedBySubject: vi.fn(async () => []) },
    events: {
      getById: vi.fn(),
      // FR-001 timezone + FR-023 currency come from the row, not the index.
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, timezone: "America/Chicago", currency: "usd" })),
      ),
      // FR-022/FR-023: no ticket types ⇒ soldOut false, priceLabel null.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
    eventDates: { listByEventIds },
  };

  const deps: GetEmbedCalendarEventsDeps = {
    repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
    search: { autocomplete } as unknown as GetEmbedCalendarEventsDeps["search"],
    clock: { now: () => new Date() },
    publicAppUrl: "http://localhost:3000",
  };
  return { deps, listByEventIds };
}

const input = { embedId: EMBED_ID, hostOrigin: HOST_ORIGIN, scope: "own" as const };

describe("getEmbedCalendarEvents — FR-003 volume bounds (organization subject)", () => {
  it("a 60-night listing cannot push the response past CALENDAR_EVENT_LIMIT; the earliest items are kept", async () => {
    // 199 single events spread over the next ~50 days, plus one listing
    // whose 60 weekly nights start tomorrow. Search returns all 200 events
    // (the pre-expansion cap); expansion would yield 199 + (nights in the
    // window) > 200 without the re-cap.
    const singles: Fixture[] = Array.from({ length: 199 }, (_, i) => ({
      id: uuidFor(i + 1),
      title: `Single ${i + 1}`,
      startsAt: inDays(1 + (i % 50)),
    }));
    const listing: Fixture = { id: LISTING_ID, title: "Residency", startsAt: inDays(1) };
    const { deps } = makeDeps({
      ownEvents: [listing, ...singles],
      dates: scheduledNights(60, 1),
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events.length).toBeLessThanOrEqual(200);
    expect(result.events).toHaveLength(200);
    // Chronological, and the tail that was dropped is the furthest-future
    // one: every kept item starts no later than every dropped one would.
    const times = result.events.map((e) => e.startsAt!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.max(...times)).toBeLessThanOrEqual(inDays(50).getTime() + 1000);
  });

  it("nights past now + 60d are NOT trimmed on the org leg (no forward bound); every night carries absolute index/total", async () => {
    const listing: Fixture = { id: LISTING_ID, title: "Residency", startsAt: inDays(1) };
    const { deps } = makeDeps({
      ownEvents: [listing],
      // 60 weekly nights: day 1, 8, 15, … out to day 414 — all under the cap.
      dates: scheduledNights(60, 1),
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(60);
    expect(result.events.some((e) => e.startsAt!.getTime() > inDays(60).getTime())).toBe(true);
    expect(result.events.map((e) => e.occurrence?.index)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
    expect(result.events.every((e) => e.occurrence?.total === 60)).toBe(true);
  });

  // The regression: today 09-02, forward bound would be 11-01; "Tuesday
  // Trivia" is pinned 11-04 with nine weekly SCHEDULED nights 11-04…12-30.
  // Trimming to `to` dropped every night — and `expandEventDates` emits
  // NOTHING for a listing with rows but none in-window — so the listing
  // vanished from the public widget while a single-date event on 11-04
  // still rendered.
  it("a far-future multi-date listing (every night past now + 60d) survives on the org leg with ALL its nights", async () => {
    const singleId = uuidFor(1);
    const listing: Fixture = { id: LISTING_ID, title: "Tuesday Trivia", startsAt: inDays(63) };
    const single: Fixture = { id: singleId, title: "One-off", startsAt: inDays(63) };
    const { deps } = makeDeps({
      ownEvents: [listing, single],
      dates: scheduledNights(9, 63),
    });

    const result = await getEmbedCalendarEvents(deps, input);

    const nights = result.events.filter((e) => e.id === LISTING_ID);
    expect(nights).toHaveLength(9);
    expect(nights.map((e) => e.occurrence)).toEqual(
      Array.from({ length: 9 }, (_, i) => ({
        index: i + 1,
        total: 9,
        eventDateId: uuidFor(900_000 + i),
      })),
    );
    expect(result.events.filter((e) => e.id === singleId)).toHaveLength(1);
    expect(result.events).toHaveLength(10);
  });

  it("the payload parses against the strict output schema (expansion adds only `occurrence`)", async () => {
    const listing: Fixture = { id: LISTING_ID, title: "Residency", startsAt: inDays(1) };
    const single: Fixture = { id: uuidFor(1), title: "Single", startsAt: inDays(3) };
    const { deps } = makeDeps({ ownEvents: [listing, single], dates: scheduledNights(3, 1) });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(() => getEmbedCalendarEventsOutputSchema.parse(result)).not.toThrow();
    expect(Object.keys(result.events[0]!).sort()).toEqual(
      [
        "checkoutEligible",
        "city",
        "endsAt",
        "id",
        "listingPrice",
        "location",
        "occurrence",
        "placeLabel",
        "priceLabel",
        "region",
        "slug",
        "soldOut",
        "startsAt",
        "status",
        "timezone",
        "title",
      ].sort(),
    );
  });
});

describe("getEmbedCalendarEvents — placeLabel (organization subject)", () => {
  // The calendar view prints the same place line as the list view, so it
  // gets the same `placeLabel` the list does: the index's label, for an
  // exact public location only.
  const at = (
    subtitle: string | null,
    locationIsExact?: boolean,
  ): Fixture => ({
    id: uuidFor(1),
    title: "Show",
    startsAt: inDays(2),
    subtitle,
    locationIsExact,
  });

  it("is the index's label when the public location is exact", async () => {
    const { deps } = makeDeps({ ownEvents: [at("The Basement", true)], dates: [] });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]).toMatchObject({
      placeLabel: "The Basement",
      location: "123 Main St",
      city: "Nashville",
      region: "TN",
    });
  });

  it("is null when the location is not exact, though the index names the place", async () => {
    const { deps } = makeDeps({
      ownEvents: [at("The Shelby House", false)],
      dates: [],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]?.placeLabel).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Shelby");
  });

  it("is null when the index document predates the exact flag", async () => {
    const { deps } = makeDeps({ ownEvents: [at("The Basement")], dates: [] });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]?.placeLabel).toBeNull();
  });

  it("is null, never undefined, when the index has no label", async () => {
    const { deps } = makeDeps({ ownEvents: [at(null, true)], dates: [] });

    const result = await getEmbedCalendarEvents(deps, input);

    const item = result.events[0];
    expect(item && "placeLabel" in item).toBe(true);
    expect(item?.placeLabel).toBeNull();
  });

  it("rides onto every expanded night of a multi-date listing", async () => {
    const listing: Fixture = {
      id: LISTING_ID,
      title: "Residency",
      startsAt: inDays(1),
      subtitle: "The Basement",
      locationIsExact: true,
    };
    const { deps } = makeDeps({ ownEvents: [listing], dates: scheduledNights(3, 1) });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.placeLabel)).toEqual([
      "The Basement",
      "The Basement",
      "The Basement",
    ]);
  });
});

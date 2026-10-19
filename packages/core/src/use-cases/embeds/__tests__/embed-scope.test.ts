import { describe, expect, it, vi } from "vitest";

import {
  getEmbedCalendarEvents,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";
import type {
  EventSuggestion,
  MultiSearchAutocompleteInput,
} from "@th/ports/search/multi-index.types";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * `scope` coverage for the org/human embed read paths — now fully search-served.
 *
 * The two event legs run through `unifiedSearch`:
 * - `own`    — owner-scoped (`orgId` for orgs, `ownerHumanId` for humans).
 * - `venues` — `placeIds` from the subject's OWNED places (authz stays in PG).
 * - `all`    — union of both, deduped by event id.
 *
 * The IMPORTANT guard: the own leg NEVER sets `includeNonPublicEvents`, so a
 * PRIVATE event the subject owns is EXCLUDED (the leak the old `listByOwner`
 * path had is closed). The fake search below models the adapters' fail-closed
 * visibility gate so that contract is exercised end-to-end.
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000e0";
const ORG_ID = "00000000-0000-4000-8000-0000000000e1";
const HUMAN_ID = "00000000-0000-4000-8000-0000000000e2";
const OWNED_PLACE_ID = "00000000-0000-4000-8000-0000000000e3";

const DOMAIN = "venue.example.com";
const MATCHING_ORIGIN = "https://venue.example.com";
const PUBLIC_APP_URL = "http://localhost:3000";

const soon = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

// Test fixture: an event plus the visibility flag the fake search gates on.
type EventFixture = {
  id: string;
  title: string;
  startsAt: Date;
  isPublic: boolean;
};

function makeEvent(
  id: string,
  title: string,
  startsAt: Date,
  isPublic = true,
): EventFixture {
  return { id, title, startsAt, isPublic };
}

function toSuggestion(e: EventFixture): EventSuggestion {
  return {
    type: "event",
    id: `doc-${e.id}`,
    eventId: e.id,
    title: e.title,
    subtitle: null,
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

// Created BY the subject.
const OWN_EVENT = makeEvent("ev-own", "Our Own Show", soon(10));
// Created by SOMEONE ELSE, but happening at a venue the subject owns.
const FOREIGN_VENUE_EVENT = makeEvent(
  "ev-foreign",
  "Someone Else's Show At Our Room",
  soon(5),
);
// Both own-created AND at an owned venue — the dedupe case.
const OVERLAP_EVENT = makeEvent("ev-overlap", "Our Show At Our Room", soon(7));

const ownedPlace = { id: OWNED_PLACE_ID, name: "Our Room" } as PlaceRecord;

function makeEmbed(subjectType: "organization" | "human"): EmbedRecord {
  return {
    id: EMBED_ID,
    subjectType,
    subjectId: subjectType === "organization" ? ORG_ID : HUMAN_ID,
    domain: DOMAIN,
    status: "ACTIVE",
    requireAuth: false,
    linkOut: false,
    defaultView: "list",
    viewToggle: false,
    createdBy: null,
    createdAt: new Date("2026-01-01"),
  };
}

type ReposOpts = {
  subjectType?: "organization" | "human";
  ownEvents?: EventFixture[];
  ownedPlaces?: PlaceRecord[];
  venueEvents?: EventFixture[];
};

function makeDeps(opts: ReposOpts = {}) {
  const {
    subjectType = "organization",
    ownEvents = [OWN_EVENT],
    ownedPlaces = [ownedPlace],
    venueEvents = [FOREIGN_VENUE_EVENT],
  } = opts;

  // Fake search: routes by filter (placeIds ⇒ venue leg; org/human scope ⇒ own
  // leg), HONORS `limit` (so leg-budgeting assertions are meaningful), and —
  // critically — models the adapters' fail-closed visibility gate: PRIVATE
  // events are only returned when `includeNonPublicEvents` is set AND an owner
  // scope is present. The use case never sets that flag, so PRIVATE events are
  // always dropped here.
  const autocomplete = vi.fn(async (input: MultiSearchAutocompleteInput) => {
    const f = input.filters ?? {};
    const limit = input.limit ?? 10;
    const source = f.placeIds?.length ? venueEvents : ownEvents;
    const ownerScoped = Boolean(f.orgId || f.ownerHumanId || f.placeIds?.length);
    const visible = source.filter(
      (e) =>
        e.isPublic || (f.includeNonPublicEvents === true && ownerScoped),
    );
    return {
      ok: true as const,
      value: {
        suggestions: visible.slice(0, limit).map(toSuggestion),
        latencyMs: 1,
      },
    };
  });

  const listOwnedBySubject = vi.fn(async ({ limit }: { limit?: number }) =>
    ownedPlaces.slice(0, limit ?? ownedPlaces.length),
  );

  const repos = {
    embeds: { getById: vi.fn(async () => makeEmbed(subjectType)) },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        name: "Dev QA Collective",
        slug: "dev-qa-collective",
      })),
    },
    humans: {
      getById: vi.fn(async () => ({ id: HUMAN_ID, name: "Ada Lovelace" })),
    },
    places: { listOwnedBySubject },
    events: {
      getById: vi.fn(),
      listTicketTypes: vi.fn(async () => []),
      // FR-001 timezone + FR-023 currency come from the row, not the index.
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, timezone: "America/Chicago", currency: "usd" })),
      ),
      // FR-022/FR-023: no ticket types ⇒ soldOut false, priceLabel null.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
    eventDates: { listByEventIds: vi.fn(async () => []) },
    imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
  };

  return { repos, search: { autocomplete }, autocomplete, listOwnedBySubject };
}

const calendarDeps = (built: ReturnType<typeof makeDeps>): GetEmbedCalendarEventsDeps => ({
  repos: built.repos as unknown as GetEmbedCalendarEventsDeps["repos"],
  search: built.search as unknown as GetEmbedCalendarEventsDeps["search"],
  clock: { now: () => new Date() },
  publicAppUrl: PUBLIC_APP_URL,
});

const widgetDeps = (built: ReturnType<typeof makeDeps>): GetEmbedForWidgetDeps => ({
  repos: built.repos as unknown as GetEmbedForWidgetDeps["repos"],
  search: built.search as unknown as GetEmbedForWidgetDeps["search"],
  publicAppUrl: PUBLIC_APP_URL,
});

const baseInput = { embedId: EMBED_ID, hostOrigin: MATCHING_ORIGIN };

// ── scope: "own" ──────────────────────────────────────────────────────────────

describe("getEmbedCalendarEvents — scope 'own'", () => {
  it("defaults to 'own' when scope is omitted, never touching the venue legs", async () => {
    const built = makeDeps();
    const result = await getEmbedCalendarEvents(calendarDeps(built), baseInput);

    expect(result.events.map((e) => e.id)).toEqual([OWN_EVENT.id]);
    // The venue place lister must not even be queried on the default path.
    expect(built.listOwnedBySubject).not.toHaveBeenCalled();
    // Exactly one search call (the own leg).
    expect(built.autocomplete).toHaveBeenCalledTimes(1);
  });

  it("explicit scope 'own' returns the same result as the default", async () => {
    const a = await getEmbedCalendarEvents(calendarDeps(makeDeps()), baseInput);
    const b = await getEmbedCalendarEvents(calendarDeps(makeDeps()), {
      ...baseInput,
      scope: "own",
    });
    expect(b).toEqual(a);
  });

  it("owner-scopes the own leg to the org and NEVER sets includeNonPublicEvents", async () => {
    const built = makeDeps();
    await getEmbedCalendarEvents(calendarDeps(built), baseInput);

    const call = built.autocomplete.mock.calls[0]![0];
    expect(call.filters).toMatchObject({
      orgId: ORG_ID,
      publishedOnly: true,
      types: ["event"],
    });
    // THE leak guard: the public embed must never opt into non-public events.
    expect(call.filters?.includeNonPublicEvents).toBeUndefined();
    // Browse ordering: the embed asks the query for soonest-first directly.
    expect(call.sort).toBe("date");
    // The calendar's full 200 budget (never a split — that's `all` only).
    expect(call.limit).toBe(200);
  });

  it("EXCLUDES a PRIVATE owned event from the own leg (leak closed)", async () => {
    const privateOwn = makeEvent("ev-private", "Members Only", soon(3), false);
    const built = makeDeps({ ownEvents: [OWN_EVENT, privateOwn] });
    const result = await getEmbedCalendarEvents(calendarDeps(built), baseInput);

    const ids = result.events.map((e) => e.id);
    expect(ids).toContain(OWN_EVENT.id);
    expect(ids).not.toContain(privateOwn.id);
  });

  it("gives the single 'venues' leg the FULL budget (no split)", async () => {
    const built = makeDeps();
    await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "venues",
    });

    expect(built.listOwnedBySubject).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
    const venueCall = built.autocomplete.mock.calls.find(
      (c) => c[0].filters?.placeIds?.length,
    );
    expect(venueCall![0].limit).toBe(200);
  });
});

describe("getEmbedForWidget — scope 'own'", () => {
  it("defaults to 'own' and never touches the venue legs", async () => {
    const built = makeDeps();
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);

    expect(result.events?.map((e) => e.id)).toEqual([OWN_EVENT.id]);
    expect(built.listOwnedBySubject).not.toHaveBeenCalled();
  });

  it("maps the search render payload onto the widget event shape", async () => {
    const built = makeDeps();
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);

    expect(result.events?.[0]).toMatchObject({
      id: OWN_EVENT.id,
      currency: "usd",
      addressText: "123 Main St",
      locality: "Nashville",
      region: "TN",
    });
  });

  it("still returns the legacy `organization` field for org subjects", async () => {
    const built = makeDeps();
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);
    expect(result.organization).toEqual({
      id: ORG_ID,
      name: "Dev QA Collective",
      slug: "dev-qa-collective",
    });
  });

  it("EXCLUDES a PRIVATE owned event from the widget grid (leak closed)", async () => {
    const privateOwn = makeEvent("ev-private-w", "Members Only", soon(3), false);
    const built = makeDeps({ ownEvents: [OWN_EVENT, privateOwn] });
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);

    const ids = result.events?.map((e) => e.id) ?? [];
    expect(ids).toContain(OWN_EVENT.id);
    expect(ids).not.toContain(privateOwn.id);
  });
});

// ── scope: "venues" ──────────────────────────────────────────────────────────

describe("scope 'venues'", () => {
  it("includes ANOTHER creator's published event at an owned venue", async () => {
    const built = makeDeps();
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "venues",
    });

    expect(result.events.map((e) => e.id)).toEqual([FOREIGN_VENUE_EVENT.id]);
    // No own-leg search call (no orgId/ownerHumanId scope).
    const ownCall = built.autocomplete.mock.calls.find(
      (c) => c[0].filters?.orgId || c[0].filters?.ownerHumanId,
    );
    expect(ownCall).toBeUndefined();
  });

  it("resolves owned venues for the subject, capped, and passes their ids to search", async () => {
    const built = makeDeps();
    await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "venues",
    });

    expect(built.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 50,
    });
    const venueCall = built.autocomplete.mock.calls[0]![0];
    expect(venueCall.filters?.placeIds).toEqual([OWNED_PLACE_ID]);
  });

  it("EXCLUDES events when the subject verifiably owns no place", async () => {
    const built = makeDeps({ ownedPlaces: [] });
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "venues",
    });

    expect(result.events).toEqual([]);
    // No places ⇒ never fan out to search at all.
    expect(built.autocomplete).not.toHaveBeenCalled();
  });

  it("works for a human subject and resolves the HUMAN owner type", async () => {
    const built = makeDeps({ subjectType: "human" });
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "venues",
    });

    expect(built.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      limit: 50,
    });
    expect(result.ownerName).toBe("Ada Lovelace");
    expect(result.events.map((e) => e.id)).toEqual([FOREIGN_VENUE_EVENT.id]);
  });

  it("owner-scopes the own leg to ownerHumanId for a human subject", async () => {
    const built = makeDeps({ subjectType: "human" });
    await getEmbedCalendarEvents(calendarDeps(built), baseInput);

    const call = built.autocomplete.mock.calls[0]![0];
    expect(call.filters).toMatchObject({ ownerHumanId: HUMAN_ID });
    expect(call.filters?.orgId).toBeUndefined();
  });
});

// ── scope: "all" ─────────────────────────────────────────────────────────────

describe("scope 'all'", () => {
  it("unions own + venue events", async () => {
    const built = makeDeps();
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "all",
    });

    expect(result.events.map((e) => e.id).sort()).toEqual(
      [OWN_EVENT.id, FOREIGN_VENUE_EVENT.id].sort(),
    );
  });

  it("DEDUPES an event that is both own-created AND at an owned venue", async () => {
    const built = makeDeps({
      ownEvents: [OWN_EVENT, OVERLAP_EVENT],
      venueEvents: [FOREIGN_VENUE_EVENT, OVERLAP_EVENT],
    });
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "all",
    });

    const ids = result.events.map((e) => e.id);
    expect(ids.filter((id) => id === OVERLAP_EVENT.id)).toHaveLength(1);
    expect(ids.sort()).toEqual(
      [OWN_EVENT.id, OVERLAP_EVENT.id, FOREIGN_VENUE_EVENT.id].sort(),
    );
  });

  it("orders the calendar union upcoming-by-date (ascending)", async () => {
    const built = makeDeps({
      ownEvents: [OWN_EVENT], // soon(10)
      venueEvents: [FOREIGN_VENUE_EVENT], // soon(5)
    });
    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "all",
    });

    expect(result.events.map((e) => e.id)).toEqual([
      FOREIGN_VENUE_EVENT.id,
      OWN_EVENT.id,
    ]);
  });

  it("orders the widget union chronologically ascending", async () => {
    const built = makeDeps({
      ownEvents: [OWN_EVENT], // soon(10)
      venueEvents: [FOREIGN_VENUE_EVENT], // soon(5)
    });
    const result = await getEmbedForWidget(widgetDeps(built), {
      ...baseInput,
      scope: "all",
    });

    expect(result.events?.map((e) => e.id)).toEqual([
      FOREIGN_VENUE_EVENT.id,
      OWN_EVENT.id,
    ]);
  });

  it("dedupes on the widget path too", async () => {
    const built = makeDeps({
      ownEvents: [OVERLAP_EVENT],
      venueEvents: [OVERLAP_EVENT],
    });
    const result = await getEmbedForWidget(widgetDeps(built), {
      ...baseInput,
      scope: "all",
    });
    expect(result.events?.map((e) => e.id)).toEqual([OVERLAP_EVENT.id]);
  });
});

// ── scope 'all' — per-leg budgeting ──────────────────────────────────────────

describe("scope 'all' — leg budgeting", () => {
  it("gives BOTH legs the FULL calendar budget (no split — date sort makes the merge fair)", async () => {
    const built = makeDeps();
    await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "all",
    });

    const ownCall = built.autocomplete.mock.calls.find((c) => c[0].filters?.orgId);
    const venueCall = built.autocomplete.mock.calls.find(
      (c) => c[0].filters?.placeIds?.length,
    );
    expect(ownCall![0].limit).toBe(200);
    expect(venueCall![0].limit).toBe(200);
  });

  it("gives BOTH legs the FULL widget budget (no split)", async () => {
    const built = makeDeps();
    await getEmbedForWidget(widgetDeps(built), { ...baseInput, scope: "all" });

    const ownCall = built.autocomplete.mock.calls.find((c) => c[0].filters?.orgId);
    const venueCall = built.autocomplete.mock.calls.find(
      (c) => c[0].filters?.placeIds?.length,
    );
    expect(ownCall![0].limit).toBe(50);
    expect(venueCall![0].limit).toBe(50);
  });

  it("never exceeds the total budget after merging both legs (calendar)", async () => {
    const manyOwn = Array.from({ length: 250 }, (_, i) =>
      makeEvent(`own-${i}`, `Own ${i}`, soon(100 + i)),
    );
    const manyVenue = Array.from({ length: 250 }, (_, i) =>
      makeEvent(`v-${i}`, `V ${i}`, soon(1 + i * 0.01)),
    );
    const built = makeDeps({ ownEvents: manyOwn, venueEvents: manyVenue });

    const result = await getEmbedCalendarEvents(calendarDeps(built), {
      ...baseInput,
      scope: "all",
    });

    expect(result.events).toHaveLength(200);
  });
});

// ── human subject on the widget path ─────────────────────────────────────────

describe("getEmbedForWidget — human subject", () => {
  it("returns a subject-agnostic `owner` and no legacy `organization`", async () => {
    const built = makeDeps({ subjectType: "human" });
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);

    expect(result.owner).toEqual({
      kind: "human",
      id: HUMAN_ID,
      name: "Ada Lovelace",
      slug: null,
    });
    expect(result.organization).toBeUndefined();
  });

  it("populates `owner` for org subjects as well", async () => {
    const built = makeDeps({ subjectType: "organization" });
    const result = await getEmbedForWidget(widgetDeps(built), baseInput);

    expect(result.owner).toEqual({
      kind: "organization",
      id: ORG_ID,
      name: "Dev QA Collective",
      slug: "dev-qa-collective",
    });
  });
});

// ── scope is ignored for subjects where it is meaningless ────────────────────

describe("scope on event subjects", () => {
  it("is accepted and ignored rather than erroring", async () => {
    const eventEmbed: EmbedRecord = {
      ...makeEmbed("organization"),
      subjectType: "event",
      subjectId: "ev-single",
    };
    const singleEvent = {
      id: "ev-single",
      title: "Single",
      slug: "single",
      startsAt: soon(3),
      endsAt: null,
      status: "PUBLISHED",
      addressText: "1 Road",
      locality: "Nashville",
      region: "TN",
      // FR-001: `Event.timezone` is NOT NULL and rides onto the wire; the
      // strict output parse rejects a record without it.
      timezone: "America/Chicago",
    };
    const repos = {
      embeds: { getById: vi.fn(async () => eventEmbed) },
      events: {
        getById: vi.fn(async () => singleEvent),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
      eventDates: { listByEventIds: vi.fn(async () => []) },
    };
    const search = { autocomplete: vi.fn() };

    const result = await getEmbedCalendarEvents(
      {
        repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
        search: search as unknown as GetEmbedCalendarEventsDeps["search"],
        clock: { now: () => new Date() },
        publicAppUrl: PUBLIC_APP_URL,
      },
      { ...baseInput, scope: "venues" },
    );

    expect(result.events.map((e) => e.id)).toEqual(["ev-single"]);
    expect(result.ownerName).toBe("Single");
    // The single-event path reads the event directly — search is not consulted.
    expect(search.autocomplete).not.toHaveBeenCalled();
  });
});

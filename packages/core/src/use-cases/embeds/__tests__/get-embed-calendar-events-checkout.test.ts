import { describe, expect, it, vi } from "vitest";

import {
  getEmbedCalendarEvents,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import type {
  EventSuggestion,
  MultiSearchAutocompleteInput,
} from "@th/ports/search/multi-index.types";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * `checkoutEligible` + `linkOut` coverage for the calendar embed read path.
 *
 * `checkoutEligible` must MIRROR the rule `assertEventAllowedForEmbed`
 * enforces inside `getEmbedEventDetail` / `createEmbedGuestCheckout`
 * (never mark eligible what those would reject):
 * - organization subject → eligible iff the event came from the OWN search
 *   leg (the `orgId: subjectId`-filtered query ⇒ `event.orgId === subjectId`,
 *   the exact org-branch rule). Venue-leg events are conservatively false.
 * - human subject → always false (checkout throws UNSUPPORTED_SUBJECT_TYPE).
 * - event subject → true (the branch only returns the pinned event, which is
 *   the fast path).
 *
 * `linkOut` is surfaced verbatim from the embed record so the widget can send
 * ALL clicks out to ithasfire.com when the organiser opted out of in-iframe
 * checkout.
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000f0";
const ORG_ID = "00000000-0000-4000-8000-0000000000f1";
const HUMAN_ID = "00000000-0000-4000-8000-0000000000f2";
const OWNED_PLACE_ID = "00000000-0000-4000-8000-0000000000f3";

const DOMAIN = "venue.example.com";
const MATCHING_ORIGIN = "https://venue.example.com";
const PUBLIC_APP_URL = "http://localhost:3000";

const soon = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

type EventFixture = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
};

function makeEvent(
  id: string,
  title: string,
  startsAt: Date,
  endsAt: Date | null = null,
): EventFixture {
  return { id, title, startsAt, endsAt };
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
    endsAt: e.endsAt ?? null,
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

// Created BY the subject (own leg).
const OWN_EVENT = makeEvent("ev-own", "Our Own Show", soon(10));
// Created by SOMEONE ELSE at a venue the subject owns (venue leg).
const FOREIGN_VENUE_EVENT = makeEvent(
  "ev-foreign",
  "Someone Else's Show At Our Room",
  soon(5),
);
// Both own-created AND at an owned venue — dedupe keeps the OWN occurrence.
const OVERLAP_EVENT = makeEvent("ev-overlap", "Our Show At Our Room", soon(7));

const ownedPlace = { id: OWNED_PLACE_ID, name: "Our Room" } as PlaceRecord;

type DepsOpts = {
  subjectType?: "organization" | "human";
  linkOut?: boolean;
  defaultView?: string;
  viewToggle?: boolean;
  ownEvents?: EventFixture[];
  venueEvents?: EventFixture[];
  ownedPlaces?: PlaceRecord[];
  /** SCHEDULED EventDate rows returned for the page (FR-003 expansion). */
  dates?: {
    id: string;
    eventId: string;
    startsAt: Date;
    endsAt: Date | null;
  }[];
};

function makeEmbed(opts: DepsOpts): EmbedRecord {
  const subjectType = opts.subjectType ?? "organization";
  return {
    id: EMBED_ID,
    subjectType,
    subjectId: subjectType === "organization" ? ORG_ID : HUMAN_ID,
    domain: DOMAIN,
    status: "ACTIVE",
    requireAuth: false,
    linkOut: opts.linkOut ?? false,
    defaultView: opts.defaultView ?? "list",
    viewToggle: opts.viewToggle ?? false,
    createdBy: null,
    createdAt: new Date("2026-01-01"),
  };
}

function makeDeps(opts: DepsOpts = {}) {
  const {
    ownEvents = [OWN_EVENT],
    venueEvents = [FOREIGN_VENUE_EVENT],
    ownedPlaces = [ownedPlace],
  } = opts;

  // Fake search: routes by filter shape — `placeIds` ⇒ venue leg, owner scope
  // (`orgId` / `ownerHumanId`) ⇒ own leg. Same routing as embed-scope.test.ts.
  const autocomplete = vi.fn(async (input: MultiSearchAutocompleteInput) => {
    const f = input.filters ?? {};
    const limit = input.limit ?? 10;
    const source = f.placeIds?.length ? venueEvents : ownEvents;
    return {
      ok: true as const,
      value: {
        suggestions: source.slice(0, limit).map(toSuggestion),
        latencyMs: 1,
      },
    };
  });

  const repos = {
    embeds: { getById: vi.fn(async () => makeEmbed(opts)) },
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
    places: {
      listOwnedBySubject: vi.fn(async ({ limit }: { limit?: number }) =>
        ownedPlaces.slice(0, limit ?? ownedPlaces.length),
      ),
    },
    events: {
      getById: vi.fn(),
      // FR-001 timezone + FR-023 currency: the search index carries neither;
      // the use case batch-reads the rows. Every fixture here is Chicago/USD.
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          timezone: "America/Chicago",
          currency: "usd",
          gateType: "NONE",
        })),
      ),
      // FR-022/FR-023: no ticket types ⇒ soldOut false, priceLabel null.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
    eventDates: {
      listByEventIds: vi.fn(async () =>
        (opts.dates ?? []).map((d, i) => ({
          ...d,
          ordinal: i + 1,
          status: "SCHEDULED" as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
    },
  };

  const deps: GetEmbedCalendarEventsDeps = {
    repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
    search: { autocomplete } as unknown as GetEmbedCalendarEventsDeps["search"],
    clock: { now: () => new Date() },
    publicAppUrl: PUBLIC_APP_URL,
  };

  return deps;
}

const baseInput = { embedId: EMBED_ID, hostOrigin: MATCHING_ORIGIN };

const eligibilityById = (result: {
  events: { id: string; checkoutEligible: boolean }[];
}) =>
  Object.fromEntries(result.events.map((e) => [e.id, e.checkoutEligible]));

// ── organization subject ─────────────────────────────────────────────────────

describe("checkoutEligible — organization subject", () => {
  it("scope 'own': every event is eligible (own leg ⇒ orgId === subjectId)", async () => {
    const other = makeEvent("ev-own-2", "Second Own Show", soon(12));
    const result = await getEmbedCalendarEvents(
      makeDeps({ ownEvents: [OWN_EVENT, other] }),
      baseInput,
    );

    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.checkoutEligible)).toBe(true);
  });

  it("scope 'venues': venue-leg events are NOT eligible", async () => {
    const result = await getEmbedCalendarEvents(makeDeps(), {
      ...baseInput,
      scope: "venues",
    });

    expect(result.events.map((e) => e.id)).toEqual([FOREIGN_VENUE_EVENT.id]);
    expect(result.events.every((e) => !e.checkoutEligible)).toBe(true);
  });

  it("scope 'all': an event in BOTH legs is eligible (dedupe keeps the own occurrence)", async () => {
    const result = await getEmbedCalendarEvents(
      makeDeps({
        ownEvents: [OWN_EVENT, OVERLAP_EVENT],
        venueEvents: [FOREIGN_VENUE_EVENT, OVERLAP_EVENT],
      }),
      { ...baseInput, scope: "all" },
    );

    expect(eligibilityById(result)).toEqual({
      [OWN_EVENT.id]: true,
      [OVERLAP_EVENT.id]: true,
      [FOREIGN_VENUE_EVENT.id]: false,
    });
  });

  it("scope 'all': adding eligibility does not change membership or date order", async () => {
    const result = await getEmbedCalendarEvents(
      makeDeps({
        ownEvents: [OWN_EVENT, OVERLAP_EVENT], // soon(10), soon(7)
        venueEvents: [FOREIGN_VENUE_EVENT, OVERLAP_EVENT], // soon(5), soon(7)
      }),
      { ...baseInput, scope: "all" },
    );

    // Same soonest-first union embed-scope.test.ts asserts — unchanged.
    expect(result.events.map((e) => e.id)).toEqual([
      FOREIGN_VENUE_EVENT.id,
      OVERLAP_EVENT.id,
      OWN_EVENT.id,
    ]);
  });
});

// ── human subject ────────────────────────────────────────────────────────────

describe("checkoutEligible — human subject", () => {
  it.each(["own", "venues", "all"] as const)(
    "scope '%s': every event is INELIGIBLE (checkout rejects human subjects)",
    async (scope) => {
      const result = await getEmbedCalendarEvents(
        makeDeps({
          subjectType: "human",
          ownEvents: [OWN_EVENT, OVERLAP_EVENT],
          venueEvents: [FOREIGN_VENUE_EVENT, OVERLAP_EVENT],
        }),
        { ...baseInput, scope },
      );

      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events.every((e) => !e.checkoutEligible)).toBe(true);
    },
  );
});

// ── event subject ────────────────────────────────────────────────────────────

describe("checkoutEligible — event subject", () => {
  it("the pinned event is eligible (assertEventAllowedForEmbed fast path)", async () => {
    const eventEmbed: EmbedRecord = {
      ...makeEmbed({}),
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
      timezone: "America/Chicago",
      gateType: "NONE",
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

    const result = await getEmbedCalendarEvents(
      {
        repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
        search: {
          autocomplete: vi.fn(),
        } as unknown as GetEmbedCalendarEventsDeps["search"],
        clock: { now: () => new Date() },
        publicAppUrl: PUBLIC_APP_URL,
      },
      baseInput,
    );

    expect(result.events).toEqual([
      expect.objectContaining({ id: "ev-single", checkoutEligible: true }),
    ]);
  });
});

// ── time clamp ───────────────────────────────────────────────────────────────
// The calendar's 30-day lookback renders PAST events for month context; only
// upcoming-or-ongoing events (`endsAt ?? startsAt` not yet passed) may drive
// the in-iframe checkout. Everything else links out to the canonical page.

describe("checkoutEligible — time clamp", () => {
  const ago = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const hoursFromNow = (h: number) =>
    new Date(Date.now() + h * 60 * 60 * 1000);

  it("an own-leg event that already ENDED is ineligible", async () => {
    const ended = makeEvent("ev-ended", "Last Week's Show", ago(7), ago(6));
    const result = await getEmbedCalendarEvents(
      makeDeps({ ownEvents: [OWN_EVENT, ended] }),
      baseInput,
    );

    expect(eligibilityById(result)).toEqual({
      [OWN_EVENT.id]: true,
      "ev-ended": false,
    });
  });

  it("an own-leg event with no endsAt whose startsAt passed is ineligible", async () => {
    const startedNoEnd = makeEvent("ev-started", "Started, No End", ago(1));
    const result = await getEmbedCalendarEvents(
      makeDeps({ ownEvents: [startedNoEnd] }),
      baseInput,
    );

    expect(result.events).toEqual([
      expect.objectContaining({ id: "ev-started", checkoutEligible: false }),
    ]);
  });

  it("an ONGOING own-leg event (started, endsAt in the future) stays eligible — door sales", async () => {
    const ongoing = makeEvent(
      "ev-ongoing",
      "Happening Right Now",
      hoursFromNow(-2),
      hoursFromNow(3),
    );
    const result = await getEmbedCalendarEvents(
      makeDeps({ ownEvents: [ongoing] }),
      baseInput,
    );

    expect(result.events).toEqual([
      expect.objectContaining({ id: "ev-ongoing", checkoutEligible: true }),
    ]);
  });

  // The clamp runs PER ITEM after FR-003 expansion, from each night's own
  // instant — not from the parent pin cloned onto every night.
  it("a listing with one past night and one future night: past chip ineligible, future chip eligible", async () => {
    const PAST_NIGHT = "dddddddd-0001-4001-8001-dddddddddddd";
    const FUTURE_NIGHT = "dddddddd-0002-4002-8002-dddddddddddd";
    // Pinned on the FUTURE night (the pin mirrors the next upcoming row), so
    // the pre-expansion clamp on the parent would have said "eligible".
    const listing = makeEvent("ev-listing", "Weekly Residency", soon(6));
    const result = await getEmbedCalendarEvents(
      makeDeps({
        ownEvents: [listing],
        dates: [
          { id: PAST_NIGHT, eventId: "ev-listing", startsAt: ago(1), endsAt: null },
          { id: FUTURE_NIGHT, eventId: "ev-listing", startsAt: soon(6), endsAt: null },
        ],
      }),
      baseInput,
    );

    expect(
      result.events.map((e) => [e.occurrence?.eventDateId, e.checkoutEligible]),
    ).toEqual([
      [PAST_NIGHT, false],
      [FUTURE_NIGHT, true],
    ]);
  });

  it("a pinned (event-subject) event that ended is ineligible", async () => {
    const eventEmbed: EmbedRecord = {
      ...makeEmbed({}),
      subjectType: "event",
      subjectId: "ev-past-single",
    };
    const pastEvent = {
      id: "ev-past-single",
      title: "Past Single",
      slug: "past-single",
      startsAt: ago(3),
      endsAt: ago(2),
      status: "PUBLISHED",
      addressText: "1 Road",
      locality: "Nashville",
      region: "TN",
      timezone: "America/Chicago",
      gateType: "NONE",
    };
    const repos = {
      embeds: { getById: vi.fn(async () => eventEmbed) },
      events: {
        getById: vi.fn(async () => pastEvent),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
      eventDates: { listByEventIds: vi.fn(async () => []) },
    };

    const result = await getEmbedCalendarEvents(
      {
        repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
        search: {
          autocomplete: vi.fn(),
        } as unknown as GetEmbedCalendarEventsDeps["search"],
        clock: { now: () => new Date() },
        publicAppUrl: PUBLIC_APP_URL,
      },
      baseInput,
    );

    expect(result.events).toEqual([
      expect.objectContaining({
        id: "ev-past-single",
        checkoutEligible: false,
      }),
    ]);
  });
});

// ── linkOut surfacing ────────────────────────────────────────────────────────

describe("embed.linkOut", () => {
  it.each([true, false])(
    "surfaces linkOut=%s verbatim from the embed record",
    async (linkOut) => {
      const result = await getEmbedCalendarEvents(
        makeDeps({ linkOut }),
        baseInput,
      );
      expect(result.embed.linkOut).toBe(linkOut);
    },
  );
});

// ── gated events (owner ruling 2026-10-12) ───────────────────────────────────

describe("checkoutEligible — a gated event is never eligible", () => {
  // Ineligible, so the calendar's click links out to the event on Ithas Fire
  // instead of opening the in-iframe checkout, which refuses it (EVENT_GATED).
  it("own leg: a PASSWORD or APPLICATION row is ineligible, a NONE row stays eligible, from the ONE row read", async () => {
    const pw = makeEvent("ev-own-pw", "Password Show", soon(6));
    const app = makeEvent("ev-own-app", "Application Show", soon(9));
    const deps = makeDeps({ ownEvents: [OWN_EVENT, pw, app] });
    const gates: Record<string, string> = {
      [pw.id]: "PASSWORD",
      [app.id]: "APPLICATION",
    };
    const findManyByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        timezone: "America/Chicago",
        currency: "usd",
        gateType: gates[id] ?? "NONE",
      })),
    );
    (
      deps.repos as unknown as { events: { findManyByIds: unknown } }
    ).events.findManyByIds = findManyByIds;

    const result = await getEmbedCalendarEvents(deps, baseInput);

    expect(eligibilityById(result)).toEqual({
      [OWN_EVENT.id]: true,
      [pw.id]: false,
      [app.id]: false,
    });
    // No extra query: the gate rides the timezone/currency row read.
    expect(findManyByIds).toHaveBeenCalledTimes(1);
  });

  it("own leg: a hit whose row is gone (index lag) fails closed to ineligible", async () => {
    const deps = makeDeps({ ownEvents: [OWN_EVENT] });
    (
      deps.repos as unknown as { events: { findManyByIds: unknown } }
    ).events.findManyByIds = vi.fn(async () => []);

    const result = await getEmbedCalendarEvents(deps, baseInput);

    expect(eligibilityById(result)).toEqual({ [OWN_EVENT.id]: false });
  });

  it.each(["PASSWORD", "APPLICATION"] as const)(
    "event subject: a %s pinned event is ineligible",
    async (gateType) => {
      const eventEmbed: EmbedRecord = {
        ...makeEmbed({}),
        subjectType: "event",
        subjectId: "ev-gated",
      };
      const repos = {
        embeds: { getById: vi.fn(async () => eventEmbed) },
        events: {
          getById: vi.fn(async () => ({
            id: "ev-gated",
            title: "Members Night",
            slug: "members-night",
            startsAt: soon(3),
            endsAt: null,
            status: "PUBLISHED",
            addressText: "1 Road",
            locality: "Nashville",
            region: "TN",
            timezone: "America/Chicago",
            gateType,
          })),
          listTicketTypesForEventIds: vi.fn(async () => []),
        },
        tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
        eventDates: { listByEventIds: vi.fn(async () => []) },
      };

      const result = await getEmbedCalendarEvents(
        {
          repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
          search: {
            autocomplete: vi.fn(),
          } as unknown as GetEmbedCalendarEventsDeps["search"],
          clock: { now: () => new Date() },
          publicAppUrl: PUBLIC_APP_URL,
        },
        baseInput,
      );

      expect(result.events).toEqual([
        expect.objectContaining({ id: "ev-gated", checkoutEligible: false }),
      ]);
    },
  );
});

import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";
import {
  listEmbedAvailableSeats,
  type ListEmbedAvailableSeatsDeps,
} from "../list-embed-available-seats";
import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";

/**
 * Gated events on the embed (owner ruling 2026-10-12). The widget is a
 * cross-site iframe with no grant cookies and no session, so it can never
 * unlock a PASSWORD or APPLICATION event. Such an event shows as a card
 * (title, date, image) that opens the event on Ithas Fire:
 * - the detail read answers a GATED PREVIEW, and never reads the tiers, body,
 *   people, tags or venue;
 * - the seat map refuses with EVENT_GATED;
 * - list cards stay, carrying `gateType` for the badge.
 * Checkout's refusal lives in `create-embed-guest-checkout.test.ts`.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const EMBED_ID = "00000000-0000-4000-8000-0000000000a0";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000a2";
const PLACE_ID = "00000000-0000-4000-8000-0000000000a3";
const SECTION_ID = "00000000-0000-4000-8000-0000000000a4";
const ORIGIN = "https://embedder.example.com";
const HERO_KEY = "events/hero.jpg";
const HERO_URL = "https://cdn.example.com/events/hero.jpg";

const STARTS_AT = new Date("2026-02-01T02:00:00.000Z");
const ENDS_AT = new Date("2026-02-01T05:00:00.000Z");

type Gate = "NONE" | "PASSWORD" | "APPLICATION";

const eventRow = (gateType: Gate) => ({
  id: EVENT_ID,
  orgId: ORG_ID,
  title: "Members Night",
  slug: "members-night",
  startsAt: STARTS_AT,
  endsAt: ENDS_AT,
  timezone: "America/Chicago",
  currency: "usd",
  heroImageUrl: HERO_URL,
  heroImageKey: HERO_KEY,
  addressText: "123 Main St",
  locality: "Nashville",
  region: "TN",
  locationLabel: "The Back Room",
  lat: 36.1,
  lng: -86.8,
  locationMode: "EXACT",
  locationRadiusMeters: null,
  placeId: PLACE_ID,
  status: "PUBLISHED",
  gateType,
  waitlistStatus: "OPEN",
  waitlistDescription: "Ask at the door for the secret room",
});

const embedRow = (subjectType: "organization" | "event") => ({
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType,
  subjectId: subjectType === "organization" ? ORG_ID : EVENT_ID,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
});

// ── Detail ──────────────────────────────────────────────────────────────────

function detailDeps(
  subjectType: "organization" | "event",
  gateType: Gate,
  heroStatus: "APPROVED" | "PENDING" = "APPROVED",
) {
  const gate = makeImageModerationGateFake({ [HERO_KEY]: heroStatus });
  const repos = {
    embeds: { getById: vi.fn(async () => embedRow(subjectType)) },
    events: {
      getById: vi.fn(async () => eventRow(gateType)),
      listTicketTypes: vi.fn(async () => [
        {
          id: "tt-1",
          name: "Members",
          priceCents: 2500,
          capacity: 50,
          status: "ACTIVE",
        },
      ]),
      getContent: vi.fn(async () => ({
        blocks: [{ type: "text", text: "the door code is 4471" }],
      })),
    },
    eventHumans: {
      listByEvent: vi.fn(async () => [
        {
          id: "eh-1",
          humanId: null,
          externalName: "Secret Headliner",
          externalUrl: null,
          role: "PERFORMER",
          customRoleLabel: null,
          sortOrder: 0,
        },
      ]),
    },
    humans: { getByIds: vi.fn(async () => []) },
    tags: {
      getEventTags: vi.fn(async () => [
        { tag: { id: "t-1", slug: "afterparty", name: "Afterparty" } },
      ]),
    },
    images: { resolveByIds: vi.fn(async () => []) },
    seats: { listSectionsByEvent: vi.fn(async () => []) },
    seriesOccurrences: {
      findSeriesIdByEventId: vi.fn(async () => null),
      listPublishedDatesBySeriesId: vi.fn(async () => []),
    },
    places: { getById: vi.fn(async () => null) },
    imageModerationRecords: gate.imageModerationRecords,
    ...makeTicketCapacityUsageFake(),
  };
  const deps = {
    repos: repos as unknown as GetEmbedEventDetailDeps["repos"],
    publicAppUrl: "http://localhost:3000",
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedEventDetailDeps;
  return { deps, repos };
}

const detailInput = {
  embedId: EMBED_ID,
  eventId: EVENT_ID,
  hostOrigin: ORIGIN,
};

describe("getEmbedEventDetail — gated preview", () => {
  describe.each(["organization", "event"] as const)("%s embed", (subject) => {
    it.each(["PASSWORD", "APPLICATION"] as const)(
      "a %s event answers title, date, hero and slug, and nothing else",
      async (gateType) => {
        const { deps } = detailDeps(subject, gateType);

        const result = await getEmbedEventDetail(deps, detailInput);

        expect(result).toEqual({
          event: {
            id: EVENT_ID,
            title: "Members Night",
            slug: "members-night",
            startsAt: STARTS_AT,
            endsAt: ENDS_AT,
            timezone: "America/Chicago",
            currency: "usd",
            heroImageUrl: HERO_URL,
            // No address, label or pin. Unlike the main-site gate, the zone
            // above is kept on purpose: the city is already public for a
            // gated event (rule 5 of projectPublicEventLocation keeps
            // locality/region), and the card needs the zone for the time.
            addressText: null,
            locality: null,
            region: null,
            locationLabel: null,
            locationCoords: null,
            waitlistStatus: "DISABLED",
            waitlistDescription: null,
            gateType,
          },
          ticketTypes: [],
          salesClosed: false,
          body: null,
          imageMap: {},
          eventHumans: [],
          tags: [],
        });
      },
    );

    it("never reads the tiers, body, people, tags or venue of a gated event", async () => {
      const { deps, repos } = detailDeps(subject, "APPLICATION");

      await getEmbedEventDetail(deps, detailInput);

      expect(repos.events.listTicketTypes).not.toHaveBeenCalled();
      expect(repos.events.getContent).not.toHaveBeenCalled();
      expect(repos.eventHumans.listByEvent).not.toHaveBeenCalled();
      expect(repos.tags.getEventTags).not.toHaveBeenCalled();
      expect(repos.places.getById).not.toHaveBeenCalled();
    });

    it("still runs the hero through the moderation gate", async () => {
      const { deps } = detailDeps(subject, "PASSWORD", "PENDING");

      const result = await getEmbedEventDetail(deps, detailInput);

      expect(result.event.heroImageUrl).toBeNull();
    });

    it("a NONE event keeps the full payload, now labelled gateType NONE", async () => {
      const { deps, repos } = detailDeps(subject, "NONE");

      const result = await getEmbedEventDetail(deps, detailInput);

      expect(result.event.gateType).toBe("NONE");
      expect(result.ticketTypes.map((t) => t.id)).toEqual(["tt-1"]);
      expect(result.body).toEqual({
        blocks: [{ type: "text", text: "the door code is 4471" }],
      });
      expect(result.eventHumans.map((h) => h.name)).toEqual([
        "Secret Headliner",
      ]);
      expect(result.tags.map((t) => t.slug)).toEqual(["afterparty"]);
      expect(result.event.waitlistStatus).toBe("OPEN");
      expect(repos.events.listTicketTypes).toHaveBeenCalledTimes(1);
      expect(repos.places.getById).toHaveBeenCalledWith(PLACE_ID);
    });
  });

  it("a gated event the embed may not show is still EVENT_NOT_FOUND, never EVENT_GATED", async () => {
    const { deps, repos } = detailDeps("organization", "APPLICATION");
    repos.events.getById.mockResolvedValue({
      ...eventRow("APPLICATION"),
      orgId: "00000000-0000-4000-8000-0000000000ff",
    });

    await expect(getEmbedEventDetail(deps, detailInput)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });
});

// ── Seats ───────────────────────────────────────────────────────────────────

function seatDeps(gateType: Gate) {
  const repos = {
    embeds: { getById: vi.fn(async () => embedRow("event")) },
    events: {
      getById: vi.fn(async () => ({ ...eventRow(gateType), placeId: null })),
      listTicketTypes: vi.fn(async () => []),
    },
    seats: {
      getSectionById: vi.fn(async () => ({
        id: SECTION_ID,
        name: "Floor",
        type: "RESERVED",
        capacity: 1,
      })),
      listAvailableBySection: vi.fn(async () => [
        {
          id: "seat-1",
          label: "A1",
          row: "A",
          number: 1,
          status: "AVAILABLE",
          geometry: null,
          priceOverride: null,
        },
      ]),
    },
    seriesOccurrences: {
      findSeriesIdByEventId: vi.fn(async () => null),
      listPublishedDatesBySeriesId: vi.fn(async () => []),
    },
  };
  const deps = {
    repos: repos as unknown as ListEmbedAvailableSeatsDeps["repos"],
    publicAppUrl: "http://localhost:3000",
    clock: testClock,
    logger: createTestLogger(),
  } satisfies ListEmbedAvailableSeatsDeps;
  return { deps, repos };
}

const seatInput = {
  embedId: EMBED_ID,
  eventId: EVENT_ID,
  seatSectionId: SECTION_ID,
  hostOrigin: ORIGIN,
};

describe("listEmbedAvailableSeats — gated events", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "a %s event's seat map is refused with EVENT_GATED before any seat read",
    async (gateType) => {
      const { deps, repos } = seatDeps(gateType);

      await expect(
        listEmbedAvailableSeats(deps, seatInput),
      ).rejects.toMatchObject({ code: "EVENT_GATED" });
      expect(repos.seats.getSectionById).not.toHaveBeenCalled();
      expect(repos.seats.listAvailableBySection).not.toHaveBeenCalled();
    },
  );

  it("a NONE event's seat map is served", async () => {
    const { deps } = seatDeps("NONE");

    const result = await listEmbedAvailableSeats(deps, seatInput);

    expect(result.seats.map((s) => s.id)).toEqual(["seat-1"]);
  });
});

// ── Widget cards ────────────────────────────────────────────────────────────

const suggestion = (id: string, title: string): EventSuggestion => ({
  type: "event",
  id: `doc-${id}`,
  eventId: id,
  title,
  subtitle: null,
  helper: null,
  slug: `slug-${id}`,
  startsAt: new Date("2026-02-01T02:00:00.000Z"),
  endsAt: null,
  city: "Nashville",
  region: "TN",
  location: "Nashville, TN",
  lat: null,
  lng: null,
  imageUrl: null,
  lowestPriceCents: 2500,
  lowestBuyerTotalCents: null,
  currency: "usd",
  paidTierCount: 1,
  hasFreeTier: false,
  hasPayWhatYouWantTier: false,
  confidence: 1,
});

function gridDeps(
  suggestions: EventSuggestion[],
  rows: Array<{ id: string; gateType: Gate }>,
) {
  const findManyByIds = vi.fn(async (ids: string[]) =>
    rows.filter((r) => ids.includes(r.id)),
  );
  const deps = {
    repos: {
      embeds: { getById: vi.fn(async () => embedRow("organization")) },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Org", slug: "org" })),
      },
      humans: { getById: vi.fn() },
      places: { listOwnedBySubject: vi.fn(async () => []) },
      events: { findManyByIds },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    } as unknown as GetEmbedForWidgetDeps["repos"],
    search: {
      autocomplete: vi.fn(async () => ({
        ok: true as const,
        value: { suggestions, latencyMs: 1 },
      })),
    } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: "http://localhost:3000",
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;
  return { deps, findManyByIds };
}

const widgetInput = { embedId: EMBED_ID, hostOrigin: ORIGIN, scope: "own" };

describe("getEmbedForWidget — gated cards", () => {
  it("grid: every card carries its gate from the event row, read in ONE batch", async () => {
    const { deps, findManyByIds } = gridDeps(
      [
        suggestion("ev-open", "Open Night"),
        suggestion("ev-pw", "Password Night"),
        suggestion("ev-app", "Application Night"),
      ],
      [
        { id: "ev-open", gateType: "NONE" },
        { id: "ev-pw", gateType: "PASSWORD" },
        { id: "ev-app", gateType: "APPLICATION" },
      ],
    );

    const result = await getEmbedForWidget(deps, widgetInput);

    expect(result.events?.map((e) => [e.id, e.gateType])).toEqual([
      ["ev-open", "NONE"],
      ["ev-pw", "PASSWORD"],
      ["ev-app", "APPLICATION"],
    ]);
    expect(findManyByIds).toHaveBeenCalledTimes(1);
  });

  it("grid: an indexed event with no row gets no card", async () => {
    const { deps } = gridDeps(
      [suggestion("ev-open", "Open Night"), suggestion("ev-gone", "Gone")],
      [{ id: "ev-open", gateType: "NONE" }],
    );

    const result = await getEmbedForWidget(deps, widgetInput);

    expect(result.events?.map((e) => e.id)).toEqual(["ev-open"]);
  });

  function singleEventDeps(gateType: Gate) {
    return {
      repos: {
        embeds: { getById: vi.fn(async () => embedRow("event")) },
        events: {
          getById: vi.fn(async () => ({
            ...eventRow(gateType),
            placeId: null,
          })),
          listTicketTypes: vi.fn(async () => [
            {
              id: "tt-1",
              name: "Members",
              priceCents: 2500,
              capacity: 50,
              status: "ACTIVE",
            },
          ]),
        },
        imageModerationRecords: {
          resolveByKeys: vi.fn(async () => new Map()),
        },
      } as unknown as GetEmbedForWidgetDeps["repos"],
      search: { autocomplete: vi.fn() } as unknown as GetEmbedForWidgetDeps["search"],
      publicAppUrl: "http://localhost:3000",
      clock: testClock,
      logger: createTestLogger(),
    } satisfies GetEmbedForWidgetDeps;
  }

  it.each(["PASSWORD", "APPLICATION"] as const)(
    "single event: a %s event keeps its card but lists no tiers",
    async (gateType) => {
      const result = await getEmbedForWidget(
        singleEventDeps(gateType),
        widgetInput,
      );

      expect(result.event?.gateType).toBe(gateType);
      expect(result.event?.title).toBe("Members Night");
      expect(result.ticketTypes).toEqual([]);
    },
  );

  it("single event: a NONE event lists its tiers", async () => {
    const result = await getEmbedForWidget(singleEventDeps("NONE"), widgetInput);

    expect(result.event?.gateType).toBe("NONE");
    expect(result.ticketTypes?.map((t) => t.id)).toEqual(["tt-1"]);
  });
});

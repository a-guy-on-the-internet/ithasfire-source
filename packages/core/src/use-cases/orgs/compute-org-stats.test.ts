import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";

import { computeOrgStats } from "./compute-org-stats";

const NOW = new Date("2026-04-19T12:00:00.000Z");
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ORG_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_1 = "33333333-3333-4333-8333-333333333333";
const EVENT_2 = "44444444-4444-4444-8444-444444444444";
const PLACE_1 = "55555555-5555-4555-8555-555555555555";
const PLACE_2 = "66666666-6666-4666-8666-666666666666";
const CATEGORY_1 = "77777777-7777-4777-8777-777777777777";
const CATEGORY_2 = "88888888-8888-4888-8888-888888888888";
const ARTIST_1 = "99999999-9999-4999-8999-999999999999";
const ARTIST_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUYER_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUYER_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const BASE_ORG = {
  id: ORG_ID,
  name: "Indie Nights",
  slug: "indie-nights",
  status: "ACTIVE" as const,
  defaultLocale: null,
  contactEmail: null,
  physicalAddress: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};

function makeDeps() {
  const orgStats = {
    upsert: vi.fn(async (orgId: string, data: any) => ({
      id: orgId,
      orgId,
      ...data,
    })),
    findByOrgId: vi.fn(),
  };

  const eventOne = {
    id: EVENT_1,
    orgId: ORG_ID,
    humanId: null,
    title: "Packed Night",
    status: "COMPLETED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    locationMode: "EXACT" as const,
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2026-04-01T20:00:00.000Z"),
    endsAt: null,
    placeId: PLACE_1,
    savedLocationId: null,
    categoryId: CATEGORY_1,
    addressText: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    waitlistStatus: "DISABLED" as const,
    currency: null,
  };

  const eventTwo = {
    ...eventOne,
    id: EVENT_2,
    title: "Winter Night",
    startsAt: new Date("2025-12-01T20:00:00.000Z"),
    placeId: PLACE_2,
    categoryId: CATEGORY_2,
  };

  const repos = {
    organizations: {
      getById: vi.fn(async (id: string) => (id === ORG_ID ? BASE_ORG : null)),
      listActive: vi.fn(),
    },
    orgStats,
    events: {
      listByOwner: vi.fn(async () => ({
        items: [eventOne, eventTwo],
        total: 2,
        limit: 100,
        offset: 0,
      })),
    },
    orders: {
      listAll: vi.fn(async ({ eventId }: { eventId: string }) => ({
        items:
          eventId === EVENT_1
            ? [
                {
                  id: "ord-1",
                  eventId: EVENT_1,
                  buyerHumanId: BUYER_1,
                  occurredAt: new Date("2026-04-02T00:00:00.000Z"),
                  items: [{ kind: "ticket", qty: 2 }],
                },
                {
                  id: "ord-2",
                  eventId: EVENT_1,
                  buyerHumanId: BUYER_2,
                  occurredAt: new Date("2026-04-03T00:00:00.000Z"),
                  items: [{ kind: "ticket", qty: 1 }],
                },
              ]
            : [
                {
                  id: "ord-3",
                  eventId: EVENT_2,
                  buyerHumanId: BUYER_1,
                  occurredAt: new Date("2025-12-02T00:00:00.000Z"),
                  items: [{ kind: "ticket", qty: 2 }],
                },
              ],
        total: eventId === EVENT_1 ? 2 : 1,
        limit: 1000,
        offset: 0,
      })),
    },
    ticketAttributions: {
      listByEvent: vi.fn(async (eventId: string) =>
        eventId === EVENT_1
          ? [
              {
                id: "att-1",
                eventId: EVENT_1,
                orderId: "ord-1",
                idempotencyKey: "k1",
                attributedToEventHumanId: null,
                attributedToHumanId: ARTIST_1,
                source: "REF_LINK" as const,
                trackingConsent: "GRANTED" as const,
                refRaw: null,
                refEventHumanId: null,
                utmSource: null,
                utmMedium: null,
                utmCampaign: null,
                fanHumanId: BUYER_1,
                fanCity: "Austin",
                fanState: "TX",
                fanCountry: "US",
                checkoutArtistSelection: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [
              {
                id: "att-2",
                eventId: EVENT_2,
                orderId: "ord-3",
                idempotencyKey: "k2",
                attributedToEventHumanId: null,
                attributedToHumanId: ARTIST_1,
                source: "REF_LINK" as const,
                trackingConsent: "GRANTED" as const,
                refRaw: null,
                refEventHumanId: null,
                utmSource: null,
                utmMedium: null,
                utmCampaign: null,
                fanHumanId: BUYER_1,
                fanCity: "Austin",
                fanState: "TX",
                fanCountry: "US",
                checkoutArtistSelection: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: "att-3",
                eventId: EVENT_2,
                orderId: "ord-3",
                idempotencyKey: "k3",
                attributedToEventHumanId: null,
                attributedToHumanId: ARTIST_2,
                source: "CHECKOUT_SELECT" as const,
                trackingConsent: "GRANTED" as const,
                refRaw: null,
                refEventHumanId: null,
                utmSource: null,
                utmMedium: null,
                utmCampaign: null,
                fanHumanId: BUYER_1,
                fanCity: "Austin",
                fanState: "TX",
                fanCountry: "US",
                checkoutArtistSelection: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
      ),
    },
    categories: {
      getById: vi.fn(async (categoryId: string) =>
        categoryId === CATEGORY_1
          ? {
              id: CATEGORY_1,
              slug: "house",
              name: "House",
              active: true,
              sortOrder: 1,
            }
          : {
              id: CATEGORY_2,
              slug: "indie",
              name: "Indie",
              active: true,
              sortOrder: 2,
            },
      ),
    },
    entityPages: {
      getByOwner: vi.fn(async () => ({ id: ORG_PAGE_ID })),
    },
    follows: {
      countByEntity: vi.fn(async () => 11),
    },
  } as unknown as Repos;

  const clock: ClockPort = { now: vi.fn(() => NOW) };

  return { repos, clock, orgStats };
}

describe("computeOrgStats", () => {
  it("aggregates org materialized stats from events, orders, attributions, and follows", async () => {
    const { repos, clock, orgStats } = makeDeps();

    const result = await computeOrgStats(
      {
        repos,
        clock,
      },
      { orgId: ORG_ID },
    );

    expect(result.orgsProcessed).toBe(1);
    expect(orgStats.upsert).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        totalEventsOrganized: 2,
        totalTicketsSold: 5,
        totalVenues: 2,
        avgTicketsPerEvent: 2.5,
        topPlaceIds: [PLACE_1, PLACE_2],
        topArtistHumanIds: [ARTIST_1, ARTIST_2],
        uniqueAttendees: 2,
        repeatAttendees: 1,
        attributionSummary: [
          { eventId: EVENT_1, attributed: 2, walkIn: 1 },
          { eventId: EVENT_2, attributed: 2, walkIn: 0 },
        ],
        topGenres: ["House", "Indie"],
        followerCount: 11,
        last90DayTickets: 3,
        last90DayEvents: 1,
        computedAt: NOW,
      }),
    );
  });

  it("paginates through all event orders for large events", async () => {
    const { repos, clock, orgStats } = makeDeps();

    (repos.orders.listAll as any).mockImplementation(
      async ({ eventId, offset = 0 }: { eventId: string; offset?: number }) => {
        if (eventId !== EVENT_1) {
          return { items: [], total: 0, limit: 1000, offset };
        }

        const total = 1002;
        const remaining = Math.max(0, total - offset);
        const count = Math.min(1000, remaining);

        return {
          items: Array.from({ length: count }, (_, index) => ({
            id: `bulk-${offset + index + 1}`,
            eventId: EVENT_1,
            buyerHumanId: `fan-${offset + index + 1}`,
            occurredAt: new Date("2026-04-02T00:00:00.000Z"),
            items: [{ kind: "ticket", qty: 1 }],
          })),
          total,
          limit: 1000,
          offset,
        };
      },
    );

    await computeOrgStats(
      {
        repos,
        clock,
      },
      { orgId: ORG_ID },
    );

    expect(repos.orders.listAll).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_1, limit: 1000, offset: 0 }),
    );
    expect(repos.orders.listAll).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_1, limit: 1000, offset: 1000 }),
    );
    expect(orgStats.upsert).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        totalTicketsSold: 1002,
        uniqueAttendees: 1002,
        repeatAttendees: 0,
        last90DayTickets: 1002,
      }),
    );
  });

  it("writes a zeroed record when the org has no eligible event activity", async () => {
    const { repos, clock, orgStats } = makeDeps();
    (repos.events.listByOwner as any).mockResolvedValueOnce({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    (repos.entityPages.getByOwner as any).mockResolvedValueOnce(null);

    const result = await computeOrgStats(
      {
        repos,
        clock,
      },
      { orgId: ORG_ID },
    );

    expect(result.orgsProcessed).toBe(1);
    expect(orgStats.upsert).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        totalEventsOrganized: 0,
        totalTicketsSold: 0,
        totalVenues: 0,
        avgTicketsPerEvent: null,
        topPlaceIds: null,
        topArtistHumanIds: null,
        uniqueAttendees: 0,
        repeatAttendees: 0,
        attributionSummary: null,
        topGenres: null,
        followerCount: 0,
        last90DayTickets: 0,
        last90DayEvents: 0,
        computedAt: NOW,
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";

import { computeHumanStats } from "../compute-human-stats";

const NOW = new Date("2026-04-19T12:00:00.000Z");
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_1 = "33333333-3333-4333-8333-333333333333";
const EVENT_2 = "44444444-4444-4444-8444-444444444444";
const ORDER_1 = "55555555-5555-4555-8555-555555555555";
const ORDER_2 = "66666666-6666-4666-8666-666666666666";
const ORDER_3 = "77777777-7777-4777-8777-777777777777";
const PLACE_1 = "88888888-8888-4888-8888-888888888888";
const PLACE_2 = "99999999-9999-4999-8999-999999999999";
const CATEGORY_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CATEGORY_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FAN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAN_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const BASE_HUMAN = {
  id: HUMAN_ID,
  name: "Ada Artist",
  status: "ACTIVE" as const,
  roles: ["USER"],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  jobs: ["MUSICIAN"],
  genreTags: ["indie", "rock"],
  otherJobDescription: null,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};

function makeDeps() {
  const humanStats = {
    upsert: vi.fn(async (humanId: string, data: any) => ({
      id: humanId,
      humanId,
      ...data,
    })),
    findByHumanId: vi.fn(),
  };

  const repos = {
    humans: {
      getById: vi.fn(async (id: string) =>
        id === HUMAN_ID ? BASE_HUMAN : null,
      ),
      listAllWithMemberships: vi.fn(),
    },
    humanStats,
    ticketAttributions: {
      listByAttributedHuman: vi.fn(async () => [
        {
          id: "att-1",
          eventId: EVENT_1,
          orderId: ORDER_1,
          idempotencyKey: "k1",
          attributedToEventHumanId: null,
          attributedToHumanId: HUMAN_ID,
          source: "REF_LINK" as const,
          trackingConsent: "GRANTED" as const,
          refRaw: null,
          refEventHumanId: null,
          utmSource: "instagram",
          utmMedium: null,
          utmCampaign: null,
          fanHumanId: FAN_1,
          fanCity: "Austin",
          fanState: "TX",
          fanCountry: "US",
          checkoutArtistSelection: null,
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          updatedAt: NOW,
        },
        {
          id: "att-2",
          eventId: EVENT_1,
          orderId: ORDER_2,
          idempotencyKey: "k2",
          attributedToEventHumanId: null,
          attributedToHumanId: HUMAN_ID,
          source: "CHECKOUT_SELECT" as const,
          trackingConsent: "GRANTED" as const,
          refRaw: null,
          refEventHumanId: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          fanHumanId: FAN_2,
          fanCity: "Austin",
          fanState: "TX",
          fanCountry: "US",
          checkoutArtistSelection: null,
          createdAt: new Date("2026-04-11T00:00:00.000Z"),
          updatedAt: NOW,
        },
        {
          id: "att-3",
          eventId: EVENT_2,
          orderId: ORDER_3,
          idempotencyKey: "k3",
          attributedToEventHumanId: null,
          attributedToHumanId: HUMAN_ID,
          source: "NONE" as const,
          trackingConsent: "GRANTED" as const,
          refRaw: null,
          refEventHumanId: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          fanHumanId: FAN_1,
          fanCity: "Nashville",
          fanState: "TN",
          fanCountry: "US",
          checkoutArtistSelection: null,
          createdAt: new Date("2025-12-01T00:00:00.000Z"),
          updatedAt: NOW,
        },
      ]),
    },
    orders: {
      getById: vi.fn(async (orderId: string) => ({
        id: orderId,
        items:
          orderId === ORDER_1
            ? [{ kind: "ticket", qty: 2 }]
            : orderId === ORDER_2
              ? [{ kind: "ticket", qty: 1 }]
              : [{ kind: "ticket", qty: 2 }],
      })),
    },
    events: {
      listPublished: vi.fn(async () => ({
        items: [
          {
            id: EVENT_1,
            orgId: null,
            humanId: null,
            title: "Show 1",
            status: "COMPLETED",
            visibility: "PUBLIC",
            gateType: "NONE",
            locationMode: "EXACT",
            locationRadiusMeters: null,
            locationLabel: null,
            addressRevealAt: null,
            addressRevealPreset: null,
            timezone: "America/Chicago",
            startsAt: new Date("2026-04-10T20:00:00.000Z"),
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
            waitlistStatus: "DISABLED",
            currency: null,
          },
          {
            id: EVENT_2,
            orgId: null,
            humanId: null,
            title: "Show 2",
            status: "COMPLETED",
            visibility: "PUBLIC",
            gateType: "NONE",
            locationMode: "EXACT",
            locationRadiusMeters: null,
            locationLabel: null,
            addressRevealAt: null,
            addressRevealPreset: null,
            timezone: "America/Chicago",
            startsAt: new Date("2025-12-01T20:00:00.000Z"),
            endsAt: null,
            placeId: PLACE_2,
            savedLocationId: null,
            categoryId: CATEGORY_2,
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
            waitlistStatus: "DISABLED",
            currency: null,
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      })),
      findManyByIds: vi.fn(async () => [
        {
          id: EVENT_1,
          placeId: PLACE_1,
          categoryId: CATEGORY_1,
          startsAt: new Date("2026-04-10T20:00:00.000Z"),
        },
        {
          id: EVENT_2,
          placeId: PLACE_2,
          categoryId: CATEGORY_2,
          startsAt: new Date("2025-12-01T20:00:00.000Z"),
        },
      ]),
    },
    eventHumans: {
      listByEvent: vi.fn(async (eventId: string) => [
        {
          id: `${eventId}-performer`,
          eventId,
          humanId: HUMAN_ID,
          externalName: null,
          externalUrl: null,
          role: "PERFORMER" as const,
          customRoleLabel: null,
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    },
    places: {
      getById: vi.fn(async (placeId: string) => ({
        id: placeId,
        name: placeId === PLACE_1 ? "East Room" : "Basement",
        slug: null,
        formattedAddress: null,
        addressLine1: null,
        addressLine2: null,
        city: placeId === PLACE_1 ? "Austin" : "Nashville",
        region: placeId === PLACE_1 ? "TX" : "TN",
        postalCode: null,
        countryCode: "US",
        capacity: null,
        lat: null,
        lng: null,
        phone: null,
        website: null,
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        listedInDirectory: true,
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
      })),
    },
    categories: {
      getById: vi.fn(async (categoryId: string) =>
        categoryId === CATEGORY_1
          ? {
              id: CATEGORY_1,
              slug: "indie-rock",
              name: "Indie Rock",
              active: true,
              sortOrder: 1,
            }
          : {
              id: CATEGORY_2,
              slug: "folk",
              name: "Folk",
              active: true,
              sortOrder: 2,
            },
      ),
    },
    entityPages: {
      getByOwner: vi.fn(async () => ({ id: PAGE_ID })),
    },
    follows: {
      countByEntity: vi.fn(async () => 7),
    },
  } as unknown as Repos;

  const clock: ClockPort = { now: vi.fn(() => NOW) };

  return { repos, clock, humanStats };
}

describe("computeHumanStats", () => {
  it("aggregates human materialized stats from attributions, events, and follows", async () => {
    const { repos, clock, humanStats } = makeDeps();

    const result = await computeHumanStats(
      {
        repos,
        clock,
      },
      { humanId: HUMAN_ID },
    );

    expect(result.humansProcessed).toBe(1);
    expect(humanStats.upsert).toHaveBeenCalledWith(
      HUMAN_ID,
      expect.objectContaining({
        totalEventsPerformed: 2,
        totalTicketsAttributed: 5,
        avgDrawPerEvent: 2.5,
        totalConsentedFans: 2,
        repeatFanCount: 1,
        followerCount: 7,
        last90DayTickets: 3,
        last90DayEvents: 1,
        topPlaceIds: [PLACE_1, PLACE_2],
        topGenres: ["Indie Rock", "Folk"],
        topCities: [
          { city: "Austin", state: "TX", country: "US", tickets: 3 },
          { city: "Nashville", state: "TN", country: "US", tickets: 2 },
        ],
        channelBreakdown: [
          { source: "instagram", tickets: 2 },
          { source: "direct", tickets: 2 },
          { source: "checkout_select", tickets: 1 },
        ],
        computedAt: NOW,
      }),
    );
  });

  it("excludes denied and unknown consent rows from consented fan geography", async () => {
    const { repos, clock, humanStats } = makeDeps();

    (
      repos.ticketAttributions.listByAttributedHuman as any
    ).mockResolvedValueOnce([
      {
        id: "att-granted",
        eventId: EVENT_1,
        orderId: ORDER_1,
        idempotencyKey: "kg",
        attributedToEventHumanId: null,
        attributedToHumanId: HUMAN_ID,
        source: "REF_LINK",
        trackingConsent: "GRANTED",
        refRaw: null,
        refEventHumanId: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        fanHumanId: FAN_1,
        fanCity: "Austin",
        fanState: "TX",
        fanCountry: "US",
        checkoutArtistSelection: null,
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
        updatedAt: NOW,
      },
      {
        id: "att-denied",
        eventId: EVENT_1,
        orderId: ORDER_2,
        idempotencyKey: "kd",
        attributedToEventHumanId: null,
        attributedToHumanId: HUMAN_ID,
        source: "REF_LINK",
        trackingConsent: "DENIED",
        refRaw: null,
        refEventHumanId: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        fanHumanId: FAN_2,
        fanCity: "Nashville",
        fanState: "TN",
        fanCountry: "US",
        checkoutArtistSelection: null,
        createdAt: new Date("2026-04-11T00:00:00.000Z"),
        updatedAt: NOW,
      },
      {
        id: "att-unknown",
        eventId: EVENT_2,
        orderId: ORDER_3,
        idempotencyKey: "ku",
        attributedToEventHumanId: null,
        attributedToHumanId: HUMAN_ID,
        source: "NONE",
        trackingConsent: "UNKNOWN",
        refRaw: null,
        refEventHumanId: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        fanHumanId: FAN_2,
        fanCity: "Chicago",
        fanState: "IL",
        fanCountry: "US",
        checkoutArtistSelection: null,
        createdAt: new Date("2025-12-01T00:00:00.000Z"),
        updatedAt: NOW,
      },
    ]);

    await computeHumanStats(
      {
        repos,
        clock,
      },
      { humanId: HUMAN_ID },
    );

    expect(humanStats.upsert).toHaveBeenCalledWith(
      HUMAN_ID,
      expect.objectContaining({
        totalConsentedFans: 1,
        topCities: [{ city: "Austin", state: "TX", country: "US", tickets: 2 }],
      }),
    );
  });

  it("does not count future published events in the draw denominator", async () => {
    const { repos, clock, humanStats } = makeDeps();

    (repos.events.listPublished as any).mockResolvedValueOnce({
      items: [
        {
          id: EVENT_1,
          orgId: null,
          humanId: null,
          title: "Show 1",
          status: "COMPLETED",
          visibility: "PUBLIC",
          gateType: "NONE",
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
          addressRevealAt: null,
          addressRevealPreset: null,
          timezone: "America/Chicago",
          startsAt: new Date("2026-04-10T20:00:00.000Z"),
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
          waitlistStatus: "DISABLED",
          currency: null,
        },
        {
          id: EVENT_2,
          orgId: null,
          humanId: null,
          title: "Show 2",
          status: "COMPLETED",
          visibility: "PUBLIC",
          gateType: "NONE",
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
          addressRevealAt: null,
          addressRevealPreset: null,
          timezone: "America/Chicago",
          startsAt: new Date("2025-12-01T20:00:00.000Z"),
          endsAt: null,
          placeId: PLACE_2,
          savedLocationId: null,
          categoryId: CATEGORY_2,
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
          waitlistStatus: "DISABLED",
          currency: null,
        },
        {
          id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
          orgId: null,
          humanId: null,
          title: "Upcoming Show",
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
          addressRevealAt: null,
          addressRevealPreset: null,
          timezone: "America/Chicago",
          startsAt: new Date("2026-06-10T20:00:00.000Z"),
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
          waitlistStatus: "DISABLED",
          currency: null,
        },
      ],
      total: 3,
      limit: 1000,
      offset: 0,
    });

    (repos.eventHumans.listByEvent as any).mockImplementation(
      async (eventId: string) => [
        {
          id: `${eventId}-performer`,
          eventId,
          humanId: HUMAN_ID,
          externalName: null,
          externalUrl: null,
          role: "PERFORMER",
          customRoleLabel: null,
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    );

    (repos.events.findManyByIds as any).mockResolvedValueOnce([
      {
        id: EVENT_1,
        status: "COMPLETED",
        placeId: PLACE_1,
        categoryId: CATEGORY_1,
        startsAt: new Date("2026-04-10T20:00:00.000Z"),
      },
      {
        id: EVENT_2,
        status: "COMPLETED",
        placeId: PLACE_2,
        categoryId: CATEGORY_2,
        startsAt: new Date("2025-12-01T20:00:00.000Z"),
      },
      {
        id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
        status: "PUBLISHED",
        placeId: PLACE_1,
        categoryId: CATEGORY_1,
        startsAt: new Date("2026-06-10T20:00:00.000Z"),
      },
    ]);

    await computeHumanStats(
      {
        repos,
        clock,
      },
      { humanId: HUMAN_ID },
    );

    expect(humanStats.upsert).toHaveBeenCalledWith(
      HUMAN_ID,
      expect.objectContaining({
        totalEventsPerformed: 2,
        totalTicketsAttributed: 5,
        avgDrawPerEvent: 2.5,
      }),
    );
  });

  it("writes a deterministic zeroed record when there is no activity", async () => {
    const { repos, clock, humanStats } = makeDeps();
    (
      repos.ticketAttributions.listByAttributedHuman as any
    ).mockResolvedValueOnce([]);
    (repos.events.listPublished as any).mockResolvedValueOnce({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
    });
    (repos.entityPages.getByOwner as any).mockResolvedValueOnce(null);

    const result = await computeHumanStats(
      {
        repos,
        clock,
      },
      { humanId: HUMAN_ID },
    );

    expect(result.humansProcessed).toBe(1);
    expect(humanStats.upsert).toHaveBeenCalledWith(
      HUMAN_ID,
      expect.objectContaining({
        totalEventsPerformed: 0,
        totalTicketsAttributed: 0,
        avgDrawPerEvent: null,
        topCities: null,
        topPlaceIds: null,
        topGenres: ["indie", "rock"],
        channelBreakdown: null,
        totalConsentedFans: 0,
        repeatFanCount: 0,
        followerCount: 0,
        last90DayTickets: 0,
        last90DayEvents: 0,
        computedAt: NOW,
      }),
    );
  });
});

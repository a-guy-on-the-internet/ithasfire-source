import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_LINEUP_ROLES } from "../../../lib/event-human-roles";
import { getPublicPage } from "../get-public-page";
import type { GetPublicPageDeps } from "../get-public-page";
import type { PlaceRecord } from "@th/ports/repos/places";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(overrides?: {
  entityPages?: Record<string, any>;
  humans?: Record<string, any>;
  organizations?: Record<string, any>;
  places?: Record<string, any>;
  announcements?: Record<string, any>;
  events?: Record<string, any>;
  eventHumans?: Record<string, any>;
  humanStats?: Record<string, any>;
  placeStats?: Record<string, any>;
  reviewAggregates?: Record<string, any>;
  performerProfiles?: Record<string, any>;
  calendars?: Record<string, any>;
  reportError?: (err: unknown, ctx?: Record<string, unknown>) => void;
}): GetPublicPageDeps {
  return {
    ...(overrides?.reportError ? { reportError: overrides.reportError } : {}),
    repos: {
      entityPages: {
        getBySlug: vi.fn(async () => null),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
        ...overrides?.entityPages,
      } as any,
      humans: {
        getById: vi.fn(async () => null),
        ...overrides?.humans,
      } as any,
      organizations: {
        getById: vi.fn(async () => null),
        ...overrides?.organizations,
      } as any,
      places: {
        getById: vi.fn(async () => null),
        // The PLACE summary's `claimable` hint (resolvePlaceClaimState).
        getVerifiedOwnershipForPlace: vi.fn(async () => null),
        ...overrides?.places,
      } as any,
      placeVerificationRequests: {
        getActiveClaimForPlace: vi.fn(async () => null),
      } as any,
      // Availability-onboarding FR-005: the shared loader folds "has hours"
      // into PLACE acceptance. Default = CONFIGURED so pre-existing
      // expectations stay intact; the unconfigured case is pinned in
      // entity-summary.test.ts.
      calendars: {
        countAvailabilityForPlace: vi.fn(async () => 1),
        ...overrides?.calendars,
      } as any,
      announcements: {
        listByOrg: vi.fn(async () => ({ items: [], total: 0 })),
        listBySender: vi.fn(async () => ({ items: [], total: 0 })),
        listPublicForOrgEntityPage: vi.fn(async () => ({
          items: [],
          total: 0,
        })),
        listPublicForSenderEntityPage: vi.fn(async () => ({
          items: [],
          total: 0,
        })),
        ...overrides?.announcements,
      } as any,
      events: {
        listPublishedByPlace: vi.fn(async () => ({
          items: [],
          pageInfo: {
            total: 0,
            limit: 8,
            offset: 0,
            count: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        })),
        listPublishedByOrg: vi.fn(async () => ({
          items: [],
          pageInfo: {
            total: 0,
            limit: 8,
            offset: 0,
            count: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        })),
        ...overrides?.events,
      } as any,
      eventHumans: {
        listPerformancesByHuman: vi.fn(async () => []),
        ...overrides?.eventHumans,
      } as any,
      humanStats: {
        findByHumanId: vi.fn(async () => null),
        ...overrides?.humanStats,
      } as any,
      placeStats: {
        getByPlaceId: vi.fn(async () => null),
        ...overrides?.placeStats,
      } as any,
      reviewAggregates: {
        getBySubject: vi.fn(async () => null),
        ...overrides?.reviewAggregates,
      } as any,
      performerProfiles: {
        getByOwner: vi.fn(async () => null),
        ...overrides?.performerProfiles,
      } as any,
      // A PLACE page's community attribution (no moderator rows here).
      audit: { listForEntity: vi.fn(async () => []) } as any,
    },
  };
}

const HUMAN_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: "human-1",
  slug: "alice",
  displayName: "Alice",
  bio: "Hello world",
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  allowFollows: true,
  showFollowerCount: false,
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

const ORG_PAGE = {
  ...HUMAN_PAGE,
  id: "page-2",
  ownerType: "ORGANIZATION" as const,
  ownerId: "org-1",
  slug: "acme-events",
};

const PLACE_PAGE = {
  ...HUMAN_PAGE,
  id: "page-3",
  ownerType: "PLACE" as const,
  ownerId: "place-1",
  slug: "the-roxy",
  // A NON-venue category, deliberately: a venue page now always carries the
  // pinned `track_record` (synthesized on the public read when the page
  // predates it — spec FU-004), which would add a block and a PlaceStats read
  // to every suite below that pins an exact block list. None of them is about
  // the door, and the loaders they exercise (venue_stats, audience_stats,
  // location_map, upcoming_events) key on the owner type, not the category.
  // The venue-category behaviour is pinned in "pinned track_record block".
  // CAVEAT: a `placeStats.getByPlaceId` call count asserted on this fixture
  // counts the venue_stats loader ALONE — on a real venue page the door's
  // loader reads the same row too (see the venue-category NFR-002 case).
  category: "place-fixture",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getPublicPage", () => {
  it("returns page + visible blocks + theme for a HUMAN page", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "b1",
            pageId: "page-1",
            kind: "UPCOMING_EVENTS",
            orderIndex: 0,
            data: {},
            visible: true,
          },
          {
            id: "b2",
            pageId: "page-1",
            kind: "SOCIAL_LINKS",
            orderIndex: 1,
            data: {},
            visible: false,
          },
        ]),
        getTheme: vi.fn(async () => ({
          id: "theme-1",
          pageId: "page-1",
          colorPrimary: "#ff0000",
          colorBg: null,
          colorText: null,
          fontKey: null,
          layoutKey: null,
        })),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.page.slug).toBe("alice");
    expect(result.blocks).toHaveLength(1); // only visible blocks
    expect(result.blocks[0]!.kind).toBe("UPCOMING_EVENTS");
    expect(result.theme?.colorPrimary).toBe("#ff0000");
    expect(result.entity).toEqual({
      type: "HUMAN",
      id: "human-1",
      name: "Alice",
      jobs: [],
      genreTags: [],
      otherJobDescription: null,
      acceptsBookingRequests: false,
    });
  });

  it("carries the human's profile identity fields (jobs/genreTags/otherJobDescription) on the entity summary", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
      },
      humans: {
        getById: vi.fn(async () => ({
          id: "human-1",
          name: "Alice",
          jobs: ["MUSICIAN", "OTHER"],
          genreTags: ["indie", "folk"],
          otherJobDescription: "Tour manager",
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.entity).toEqual({
      type: "HUMAN",
      id: "human-1",
      name: "Alice",
      jobs: ["MUSICIAN", "OTHER"],
      genreTags: ["indie", "folk"],
      otherJobDescription: "Tour manager",
      acceptsBookingRequests: false,
    });
  });

  it("drops unknown job values instead of failing the page output parse", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
      },
      humans: {
        getById: vi.fn(async () => ({
          id: "human-1",
          name: "Alice",
          // A future Prisma enum value core doesn't know yet must not 500 the page.
          jobs: ["MUSICIAN", "HOLOGRAM_OPERATOR"],
          genreTags: [],
          otherJobDescription: null,
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.entity).toMatchObject({ jobs: ["MUSICIAN"] });
  });

  it("returns entity summary for an ORGANIZATION page", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ORG_PAGE),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme Events",
          slug: "acme-events",
          trustTier: "VERIFIED",
          trustBadgeLabel: "Verified Promoter",
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "acme-events" });

    expect(result.entity).toEqual({
      type: "ORGANIZATION",
      id: "org-1",
      name: "Acme Events",
      slug: "acme-events",
      trustTier: "VERIFIED",
      trustBadgeLabel: "Verified Promoter",
      acceptsBookingRequests: false,
    });
  });

  it("returns entity summary for a PLACE page", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "The Roxy",
          city: "Los Angeles",
          region: "CA",
          formattedAddress: null,
          lat: 34.09,
          lng: -118.39,
          capacity: 500,
          phone: "+1-310-555-0100",
          website: "https://theroxy.com",
          verificationStatus: "VERIFIED",
          acceptsBookingRequests: true,
          // EXPLICIT: `redactPlaceLocation` fails closed, so a fake that omits
          // this is treated as WITHHELD.
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    // `toEqual` pins the WHOLE summary: a PLACE carries no `slug`. Its
    // addressable slug is the page's own (`PLACE_PAGE.slug`, which this call
    // resolved on); `Place.slug` was a directory key nothing routed on.
    expect(result.entity).toEqual({
      type: "PLACE",
      id: "place-1",
      name: "The Roxy",
      city: "Los Angeles",
      region: "CA",
      formattedAddress: null,
      lat: 34.09,
      lng: -118.39,
      capacity: 500,
      phone: "+1-310-555-0100",
      website: "https://theroxy.com",
      verified: true,
      // No `status` on the fake → not ACTIVE → never claimable.
      claimable: false,
      acceptsBookingRequests: true,
      locationIsExact: true,
      locationHidden: false,
      locationRadiusMeters: null,
      areaLabel: "Los Angeles, CA",
    });
  });

  it("expands organization announcement blocks from announcement records", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ORG_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "announcements-block",
            pageId: "page-2",
            kind: "announcements",
            orderIndex: 0,
            data: { heading: "News", announcements: [{ title: "Manual" }] },
            visible: true,
          },
        ]),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme Events",
          slug: "acme-events",
          trustTier: "UNVERIFIED",
          trustBadgeLabel: null,
        })),
      },
      announcements: {
        listPublicForOrgEntityPage: vi.fn(async () => ({
          total: 1,
          items: [
            {
              id: "announcement-1",
              orgId: "org-1",
              eventId: null,
              subject: "Big news",
              bodyDoc: null,
              bodyHtml:
                '<p>Hello <strong>world</strong></p><script>alert("x")</script>',
              publicOnEntityPage: true,
              audienceType: "ALL_TICKET_HOLDERS",
              audienceRef: null,
              audienceFilter: null,
              excludedContactListId: null,
              recipientCount: null,
              sentAt: new Date("2025-08-01T10:00:00.000Z"),
              sentBy: "human-1",
              createdAt: new Date("2025-07-31T10:00:00.000Z"),
              updatedAt: new Date("2025-08-01T10:00:00.000Z"),
            },
          ],
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "acme-events" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "News",
      dataSource: "announcements",
      announcements: [
        {
          id: "announcement-1",
          title: "Big news",
          bodyHtml: "<p>Hello <strong>world</strong></p>",
          date: "2025-08-01T10:00:00.000Z",
        },
      ],
    });
    expect(
      deps.repos.announcements.listPublicForOrgEntityPage,
    ).toHaveBeenCalledWith({
      orgId: "org-1",
      limit: 10,
      offset: 0,
    });
    expect(deps.repos.announcements.listByOrg).not.toHaveBeenCalled();
  });

  it("expands human announcement blocks from public sender announcement records", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "announcements-block",
            pageId: "page-1",
            kind: "announcements",
            orderIndex: 0,
            data: { heading: "Updates", announcements: [{ title: "Manual" }] },
            visible: true,
          },
        ]),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
      announcements: {
        listPublicForSenderEntityPage: vi.fn(async () => ({
          total: 1,
          items: [
            {
              id: "announcement-1",
              orgId: "org-1",
              eventId: null,
              subject: "Sent update",
              bodyDoc: null,
              bodyHtml: "<p>Details</p>",
              publicOnEntityPage: true,
              audienceType: "ALL_TICKET_HOLDERS",
              audienceRef: null,
              audienceFilter: null,
              excludedContactListId: null,
              recipientCount: null,
              sentAt: new Date("2025-09-01T12:00:00.000Z"),
              sentBy: "human-1",
              createdAt: new Date("2025-09-01T10:00:00.000Z"),
              updatedAt: new Date("2025-09-01T12:00:00.000Z"),
            },
          ],
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Updates",
      dataSource: "announcements",
      announcements: [
        {
          id: "announcement-1",
          title: "Sent update",
          bodyHtml: "<p>Details</p>",
          date: "2025-09-01T12:00:00.000Z",
        },
      ],
    });
    expect(
      deps.repos.announcements.listPublicForSenderEntityPage,
    ).toHaveBeenCalledWith({
      humanId: "human-1",
      limit: 10,
      offset: 0,
    });
    expect(deps.repos.announcements.listBySender).not.toHaveBeenCalled();
  });

  it("expands place location map blocks from place data", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "map-block",
            pageId: "page-3",
            kind: "location_map",
            orderIndex: 0,
            data: { heading: "Find us", address: "Old address" },
            visible: true,
          },
        ]),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "The Roxy",
          slug: "the-roxy",
          city: "Los Angeles",
          region: "CA",
          formattedAddress: "9009 Sunset Blvd, West Hollywood, CA",
          // See the note on the summary fake above: fail-closed means EXACT
          // has to be said out loud.
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
          lat: 34.09,
          lng: -118.39,
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Find us",
      dataSource: "place",
      address: "9009 Sunset Blvd, West Hollywood, CA",
      lat: 34.09,
      lng: -118.39,
    });
  });

  it("populates place upcoming_events blocks from published upcoming events", async () => {
    const listPublishedByPlace = vi.fn(async () => ({
      items: [
        {
          id: "event-1",
          title: "Live Music on Red River",
          slug: "live-music-on-red-river",
          startsAt: new Date("2026-09-01T02:00:00.000Z"),
          status: "PUBLISHED",
        },
      ],
      pageInfo: {
        total: 1,
        limit: 8,
        offset: 0,
        count: 1,
        hasNextPage: false,
        nextOffset: null,
      },
    }));

    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "events-block",
            pageId: "page-3",
            kind: "upcoming_events",
            orderIndex: 0,
            data: { heading: "Shows" },
            visible: true,
          },
        ]),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "Stubb's BBQ",
          slug: "the-roxy",
          city: "Austin",
          region: "TX",
          formattedAddress: null,
          lat: 30.26,
          lng: -97.73,
          orgIdsWithAccess: ["org-venue"],
          humanIdsWithAccess: ["human-owner"],
        })),
      },
      events: { listPublishedByPlace },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Shows",
      dataSource: "place",
      events: [
        {
          id: "event-1",
          title: "Live Music on Red River",
          slug: "live-music-on-red-river",
          date: "2026-09-01T02:00:00.000Z",
          venueName: "Stubb's BBQ",
        },
      ],
    });
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: "place-1",
        status: "upcoming",
        limit: 8,
        offset: 0,
        // Venue-confirmation spec: confirmed-only, keyed on the owner ids.
        venueConfirmedFor: {
          orgIds: ["org-venue"],
          humanIds: ["human-owner"],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  it("leaves upcoming_events empty when the place has no published events", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "events-block",
            pageId: "page-3",
            kind: "upcoming_events",
            orderIndex: 0,
            data: { heading: "Shows" },
            visible: true,
          },
        ]),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "Stubb's BBQ",
          slug: "the-roxy",
          city: "Austin",
          region: "TX",
          formattedAddress: null,
          lat: 30.26,
          lng: -97.73,
          orgIdsWithAccess: [],
          humanIdsWithAccess: [],
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Shows",
      dataSource: "place",
      events: [],
    });
  });

  it("populates an ORG's upcoming_events block from published org events", async () => {
    const listPublishedByOrg = vi.fn(async () => ({
      items: [
        {
          id: "event-9",
          title: "Collective Showcase",
          slug: "collective-showcase",
          startsAt: new Date("2026-10-01T02:00:00.000Z"),
          status: "PUBLISHED",
        },
      ],
      pageInfo: {
        total: 1,
        limit: 8,
        offset: 0,
        count: 1,
        hasNextPage: false,
        nextOffset: null,
      },
    }));

    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ORG_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "events-block",
            pageId: "page-2",
            kind: "upcoming_events",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: true,
          },
        ]),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme Events",
          slug: "acme-events",
          trustTier: "STANDARD",
          trustBadgeLabel: null,
        })),
      },
      events: { listPublishedByOrg },
    });

    const result = await getPublicPage(deps, { slug: "acme-events" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Upcoming",
      dataSource: "org",
      events: [
        {
          id: "event-9",
          title: "Collective Showcase",
          slug: "collective-showcase",
          date: "2026-10-01T02:00:00.000Z",
        },
      ],
    });
    // Org events aren't venue-pinned, so no venueName is injected.
    expect(
      (result.blocks[0]?.data as { events: Array<Record<string, unknown>> })
        .events[0],
    ).not.toHaveProperty("venueName");
    expect(listPublishedByOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        status: "upcoming",
        limit: 8,
        offset: 0,
      }),
    );
  });

  it("leaves an ORG's upcoming_events empty when the org has no published events", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ORG_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "events-block",
            pageId: "page-2",
            kind: "upcoming_events",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: true,
          },
        ]),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme Events",
          slug: "acme-events",
          trustTier: "STANDARD",
          trustBadgeLabel: null,
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "acme-events" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Upcoming",
      dataSource: "org",
      events: [],
    });
  });

  it("injects a HUMAN's upcoming shows into a `shows` block", async () => {
    const listPerformancesByHuman = vi.fn(async () => [
      {
        eventId: "e1",
        title: "Basement Show",
        startsAt: new Date("2026-09-01T02:00:00.000Z"),
        venueName: "The Basement",
        slug: "basement-show",
        // Venue-confirmation spec: the PUBLIC page names the venue only when
        // it vouches — this fixture is stamped for its place.
        placeId: "place-9",
        placeName: "The Basement",
        locationLabel: "Nashville, TN",
        orgId: null,
        humanId: "human-1",
        venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: "place-9",
      },
    ]);
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "shows-block",
            pageId: "page-1",
            kind: "shows",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: true,
          },
        ]),
      },
      humans: { getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })) },
      eventHumans: { listPerformancesByHuman },
      // The stamped fixture's place must EXIST — a gone place cannot vouch.
      places: {
        getById: vi.fn(async (id: string) =>
          id === "place-9" ? { id, name: "The Basement", orgIdsWithAccess: [], humanIdsWithAccess: [] } : null,
        ),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Upcoming",
      dataSource: "shows",
      events: [
        {
          id: "e1",
          title: "Basement Show",
          date: "2026-09-01T02:00:00.000Z",
          venueName: "The Basement",
          slug: "basement-show",
        },
      ],
    });
    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: "human-1", when: "upcoming" }),
    );
  });

  // Public-lineup rule regression (the /humans/admin "No shows" bug): a HOST
  // credit on an upcoming PUBLISHED+PUBLIC event lists the show; a VOLUNTEER
  // credit never does. The mock mirrors the adapter's `role IN (roles)`
  // filter so the assertion exercises the roles the use case actually passes.
  const LINEUP_CREDITS = [
    {
      role: "HOST",
      eventId: "e-host",
      title: "Open Mic Night",
      startsAt: new Date("2026-09-01T02:00:00.000Z"),
      venueName: "The Basement",
      slug: "open-mic-night",
    },
    {
      role: "VOLUNTEER",
      eventId: "e-vol",
      title: "Door Shift",
      startsAt: new Date("2026-09-02T02:00:00.000Z"),
      venueName: null,
      slug: null,
    },
  ] as const;

  function makeRoleFilteringListPerformances() {
    return vi.fn(async ({ roles }: { roles: readonly string[] }) =>
      LINEUP_CREDITS.filter((c) => roles.includes(c.role)).map(
        ({ role: _role, ...performance }) => performance,
      ),
    );
  }

  it("lists a HOST credit in the shows block but never a VOLUNTEER credit (public-lineup rule)", async () => {
    const listPerformancesByHuman = makeRoleFilteringListPerformances();
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "shows-block",
            pageId: "page-1",
            kind: "shows",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: true,
          },
        ]),
      },
      humans: { getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })) },
      eventHumans: { listPerformancesByHuman },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    const events = (result.blocks[0]?.data as { events: Array<{ id: string }> })
      .events;
    expect(events.map((e) => e.id)).toEqual(["e-host"]);
    // The query filter is the public-lineup role set: HOST in, VOLUNTEER out.
    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({ roles: PUBLIC_LINEUP_ROLES }),
    );
    expect(PUBLIC_LINEUP_ROLES).toContain("HOST");
    expect(PUBLIC_LINEUP_ROLES).not.toContain("VOLUNTEER");
  });

  // ── HUMAN upcoming_events derivation ────────────────────────────────────

  const ALICE = { id: "human-1", name: "Alice" };

  const HUMAN_UPCOMING_EVENTS_BLOCK = {
    id: "events-block",
    pageId: "page-1",
    kind: "upcoming_events",
    orderIndex: 0,
    data: {
      heading: "Shows",
      events: [{ id: "static-1", title: "Hand-typed gig", date: "2026-01-01" }],
    },
    visible: true,
  };

  it("derives a HUMAN's upcoming_events from real performances when no shows block is present", async () => {
    const listPerformancesByHuman = vi.fn(async () => [
      {
        eventId: "e1",
        title: "Basement Show",
        startsAt: new Date("2026-09-01T02:00:00.000Z"),
        venueName: "The Basement",
        slug: "basement-show",
        // Venue-confirmation spec: the PUBLIC page names the venue only when
        // it vouches — this fixture is stamped for its place.
        placeId: "place-9",
        placeName: "The Basement",
        locationLabel: "Nashville, TN",
        orgId: null,
        humanId: "human-1",
        venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: "place-9",
      },
      {
        eventId: "e2",
        title: "Rooftop Set",
        startsAt: new Date("2026-09-15T02:00:00.000Z"),
        venueName: null,
      },
    ]);
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [HUMAN_UPCOMING_EVENTS_BLOCK]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      eventHumans: { listPerformancesByHuman },
      // The stamped fixture's place must EXIST — a gone place cannot vouch.
      places: {
        getById: vi.fn(async (id: string) =>
          id === "place-9" ? { id, name: "The Basement", orgIdsWithAccess: [], humanIdsWithAccess: [] } : null,
        ),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Shows",
      dataSource: "shows",
      events: [
        {
          id: "e1",
          title: "Basement Show",
          date: "2026-09-01T02:00:00.000Z",
          venueName: "The Basement",
          slug: "basement-show",
        },
        {
          id: "e2",
          title: "Rooftop Set",
          date: "2026-09-15T02:00:00.000Z",
        },
      ],
    });
    // Same trusted path as the `shows` derivation (public-lineup roles,
    // upcoming).
    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: "human-1",
        when: "upcoming",
        roles: PUBLIC_LINEUP_ROLES,
      }),
    );
    // Null venueName is omitted, matching the ORG derivation's shape.
    expect(
      (result.blocks[0]?.data as { events: Array<Record<string, unknown>> })
        .events[1],
    ).not.toHaveProperty("venueName");
  });

  it("derives upcoming_events from a HOST credit but never a VOLUNTEER credit (public-lineup rule)", async () => {
    const listPerformancesByHuman = makeRoleFilteringListPerformances();
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [HUMAN_UPCOMING_EVENTS_BLOCK]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      eventHumans: { listPerformancesByHuman },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    const events = (result.blocks[0]?.data as { events: Array<{ id: string }> })
      .events;
    expect(events.map((e) => e.id)).toEqual(["e-host"]);
    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({ roles: PUBLIC_LINEUP_ROLES }),
    );
  });

  it("leaves a HUMAN's upcoming_events untouched when a shows block is also present (dedupe rule)", async () => {
    const listPerformancesByHuman = vi.fn(async () => [
      {
        eventId: "e1",
        title: "Basement Show",
        startsAt: new Date("2026-09-01T02:00:00.000Z"),
        venueName: "The Basement",
        slug: "basement-show",
        // Venue-confirmation spec: the PUBLIC page names the venue only when
        // it vouches — this fixture is stamped for its place.
        placeId: "place-9",
        placeName: "The Basement",
        locationLabel: "Nashville, TN",
        orgId: null,
        humanId: "human-1",
        venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: "place-9",
      },
    ]);
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "shows-block",
            pageId: "page-1",
            kind: "shows",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: true,
          },
          { ...HUMAN_UPCOMING_EVENTS_BLOCK, orderIndex: 1 },
        ]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      eventHumans: { listPerformancesByHuman },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    // The shows block derives; upcoming_events keeps its stored static data —
    // HumanEntityLayout zones both into one section, so deriving both would
    // list every event twice.
    expect(result.blocks[0]?.data).toMatchObject({
      dataSource: "shows",
      events: [expect.objectContaining({ id: "e1" })],
    });
    expect(result.blocks[1]?.data).toEqual(HUMAN_UPCOMING_EVENTS_BLOCK.data);
    // Only the shows derivation hit the repo.
    expect(listPerformancesByHuman).toHaveBeenCalledTimes(1);
  });

  it("derives a HUMAN's upcoming_events when the only shows block is HIDDEN (excluded from public expansion)", async () => {
    const listPerformancesByHuman = vi.fn(async () => [
      {
        eventId: "e1",
        title: "Basement Show",
        startsAt: new Date("2026-09-01T02:00:00.000Z"),
        venueName: "The Basement",
        slug: "basement-show",
        // Venue-confirmation spec: the PUBLIC page names the venue only when
        // it vouches — this fixture is stamped for its place.
        placeId: "place-9",
        placeName: "The Basement",
        locationLabel: "Nashville, TN",
        orgId: null,
        humanId: "human-1",
        venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: "place-9",
      },
    ]);
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "shows-block",
            pageId: "page-1",
            kind: "shows",
            orderIndex: 0,
            data: { heading: "Upcoming" },
            visible: false, // hidden → never rendered publicly
          },
          { ...HUMAN_UPCOMING_EVENTS_BLOCK, orderIndex: 1 },
        ]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      eventHumans: { listPerformancesByHuman },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    // Only the visible upcoming_events block survives, and it derives — the
    // hidden shows block can't double-list because it never renders publicly.
    expect(result.blocks.map((b) => b.kind)).toEqual(["upcoming_events"]);
    expect(result.blocks[0]?.data).toMatchObject({
      dataSource: "shows",
      events: [expect.objectContaining({ id: "e1" })],
    });
  });

  it("preserves a HUMAN's static upcoming_events when there are zero upcoming performances", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [HUMAN_UPCOMING_EVENTS_BLOCK]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      // eventHumans.listPerformancesByHuman -> [] by default
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    // The owner-curated static list must not be wiped to empty.
    expect(result.blocks[0]?.data).toEqual(HUMAN_UPCOMING_EVENTS_BLOCK.data);
    expect(deps.repos.eventHumans.listPerformancesByHuman).toHaveBeenCalledTimes(
      1,
    );
  });

  it("caps a HUMAN's derived upcoming_events at the shared limit (8)", async () => {
    const listPerformancesByHuman = vi.fn(async () =>
      Array.from({ length: 12 }, (_, i) => ({
        eventId: `e${i}`,
        title: `Show ${i}`,
        startsAt: new Date(`2026-09-${String(i + 1).padStart(2, "0")}T02:00:00.000Z`),
        venueName: null,
      })),
    );
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [HUMAN_UPCOMING_EVENTS_BLOCK]),
      },
      humans: { getById: vi.fn(async () => ALICE) },
      eventHumans: { listPerformancesByHuman },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(
      (result.blocks[0]?.data as { events: unknown[] }).events,
    ).toHaveLength(8);
  });

  it("injects stats into a visible `stats` block ONLY when eligible, whitelisted", async () => {
    const eligibleStats = {
      id: "s1",
      humanId: "human-1",
      totalEventsPerformed: 5,
      totalTicketsAttributed: 100,
      avgDrawPerEvent: 20,
      topCities: [{ city: "Nashville", country: "US", tickets: 50 }],
      topPlaceIds: ["p1"],
      topGenres: ["indie"],
      channelBreakdown: [{ source: "ref_link", tickets: 33 }],
      totalConsentedFans: 10,
      repeatFanCount: 4,
      followerCount: 99,
      last90DayTickets: 20,
      last90DayEvents: 1,
      computedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "stats-block",
            pageId: "page-1",
            kind: "stats",
            orderIndex: 0,
            data: { heading: "By the numbers" },
            visible: true,
          },
        ]),
      },
      humans: { getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })) },
      humanStats: { findByHumanId: vi.fn(async () => eligibleStats) },
    });

    const result = await getPublicPage(deps, { slug: "alice" });
    const data = result.blocks[0]?.data as Record<string, any>;

    expect(data.dataSource).toBe("stats");
    expect(data.eligible).toBe(true);
    expect(data.computedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(data.metrics.refLinkTickets).toBe(33);
    // Whitelist enforced — never leaks fan-location / channel breakdown / follows.
    expect(data.metrics).not.toHaveProperty("topCities");
    expect(data).not.toHaveProperty("topCities");
    expect(data.metrics).not.toHaveProperty("channelBreakdown");
    expect(data.metrics).not.toHaveProperty("followerCount");
  });

  it("OMITS a visible-but-ineligible stats block from public output entirely (FR-003)", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "about-block",
            pageId: "page-1",
            kind: "about",
            orderIndex: 0,
            data: { content: "Hi" },
            visible: true,
          },
          {
            id: "stats-block",
            pageId: "page-1",
            kind: "stats",
            orderIndex: 1,
            // Attacker-persisted fake numbers + a forged eligible flag. The
            // block is visible, but the artist is under-threshold, so it must
            // NOT appear on the public page at all.
            data: {
              heading: "Numbers",
              eligible: true,
              computedAt: "2020-01-01T00:00:00.000Z",
              metrics: { avgDrawPerEvent: 9999, refLinkTickets: 9999 },
            },
            visible: true,
          },
        ]),
      },
      humans: { getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })) },
      humanStats: {
        findByHumanId: vi.fn(async () => ({
          id: "s1",
          humanId: "human-1",
          totalEventsPerformed: 2,
          totalTicketsAttributed: 10,
          avgDrawPerEvent: 5,
          topCities: null,
          topPlaceIds: null,
          topGenres: null,
          channelBreakdown: null,
          totalConsentedFans: 0,
          repeatFanCount: 0,
          followerCount: 0,
          last90DayTickets: 0,
          last90DayEvents: 0,
          computedAt: new Date("2026-07-01T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    // The stats block is gone entirely; the sibling block still renders.
    expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
    expect(result.blocks.some((b) => b.kind === "stats")).toBe(false);
  });

  // ── venue_stats block (booking-review-data-weave FR-004/FR-005) ─────────

  // A FULL `PlaceRecord`, every boolean spelled out. A partial fixture is
  // how a gate on some OTHER flag (`x !== false` against an undefined field)
  // stays green — the class of miss the NFR-002 block below exists to close.
  const ROXY_PLACE: PlaceRecord = {
    id: "place-1",
    name: "The Roxy",
    formattedAddress: null,
    addressLine1: null,
    addressLine2: null,
    city: "Los Angeles",
    region: "CA",
    postalCode: null,
    countryCode: "US",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: null,
    websiteSource: "UNKNOWN",
    capacity: null,
    lat: 34.09,
    lng: -118.39,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    listedInDirectory: true,
    acceptsBookingRequests: true,
    acceptsCommunityListings: false,
    // FR-005: owner has published the attendee aggregate (default is false).
    attendeeReviewsPublic: true,
    // venue-track-record-and-review-switch FR-003: performer reviews ON (the
    // column default). EXPLICIT, because the loader fails closed — a fake
    // that omits this publishes no venue_stats.
    communityReviewsEnabled: true,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  const VENUE_STATS_BLOCK = {
    id: "venue-stats-block",
    pageId: "page-3",
    kind: "venue_stats",
    orderIndex: 0,
    data: { heading: "What performers say" },
    visible: true,
  };

  const PUBLISHABLE_SNAPSHOT = {
    version: 1,
    headline: {
      reviewCountBand: "7",
      wouldPlayAgainPct: 85,
      soundScore: 4.5,
      bookerScore: 4,
    },
    payout: {
      sampleSizeBand: "5",
      medianCents: 15000,
      minCents: 5000,
      maxCents: 30000,
      methodPcts: { guarantee: 60, doorSplit: 40 },
    },
  };

  function makeVenueStatsDeps(overrides?: {
    placeStats?: Record<string, any>;
    entityPages?: Record<string, any>;
    reportError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  }) {
    return makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
        ...overrides?.entityPages,
      },
      places: { getById: vi.fn(async () => ROXY_PLACE) },
      ...(overrides?.placeStats ? { placeStats: overrides.placeStats } : {}),
      ...(overrides?.reportError
        ? { reportError: overrides.reportError }
        : {}),
    });
  }

  it("injects the anonymization-policy snapshot into a visible venue_stats block with the trusted marker", async () => {
    const deps = makeVenueStatsDeps({
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          placeId: "place-1",
          publicSnapshot: PUBLISHABLE_SNAPSHOT,
          publicSnapshotAt: new Date("2026-07-06T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.data).toEqual({
      heading: "What performers say",
      dataSource: "venue_stats",
      snapshot: PUBLISHABLE_SNAPSHOT,
      snapshotAt: "2026-07-06T00:00:00.000Z",
    });
    expect(deps.repos.placeStats.getByPlaceId).toHaveBeenCalledWith("place-1");
  });

  it("discards owner-injected fake stats — data is fully server-rebuilt except heading", async () => {
    const deps = makeVenueStatsDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            ...VENUE_STATS_BLOCK,
            // Attacker/owner-persisted forgery: a fake trusted marker plus
            // fabricated snapshot content. Only `heading` may survive.
            data: {
              heading: "Totally real numbers",
              dataSource: "venue_stats",
              snapshot: {
                version: 1,
                headline: { reviewCountBand: "50+", wouldPlayAgainPct: 100 },
              },
              snapshotAt: "2020-01-01T00:00:00.000Z",
              extraKey: "nope",
            },
          },
        ]),
      },
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          placeId: "place-1",
          publicSnapshot: PUBLISHABLE_SNAPSHOT,
          publicSnapshotAt: new Date("2026-07-06T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    // The real snapshot wins; forged keys are gone entirely.
    expect(result.blocks[0]?.data).toEqual({
      heading: "Totally real numbers",
      dataSource: "venue_stats",
      snapshot: PUBLISHABLE_SNAPSHOT,
      snapshotAt: "2026-07-06T00:00:00.000Z",
    });
  });

  it("OMITS the venue_stats block when the snapshot is below-threshold ({version:1}, no headline)", async () => {
    const deps = makeVenueStatsDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "about-block",
            pageId: "page-3",
            kind: "about",
            orderIndex: 0,
            data: { content: "A venue" },
            visible: true,
          },
          VENUE_STATS_BLOCK,
        ]),
      },
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          placeId: "place-1",
          publicSnapshot: { version: 1 },
          publicSnapshotAt: new Date("2026-07-06T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
  });

  it("OMITS the venue_stats block when no PlaceStats row / snapshot exists", async () => {
    const deps = makeVenueStatsDeps(); // placeStats.getByPlaceId -> null

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks).toEqual([]);
  });

  it("fails CLOSED on an invalid snapshot, reports it, and keeps the page render succeeding", async () => {
    const reportError = vi.fn();
    const deps = makeVenueStatsDeps({
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          placeId: "place-1",
          // Corrupt: wrong version + junk keys — fails placePublicSnapshotSchema.
          publicSnapshot: { version: 99, headline: { reviewCount: 12 } },
          publicSnapshotAt: new Date("2026-07-06T00:00:00.000Z"),
        })),
      },
      reportError,
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    // Page renders; the block is gone; the swallow is reported (Sentry convention).
    expect(result.page.slug).toBe("the-roxy");
    expect(result.blocks).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: { useCase: "getPublicPage", step: "venueStatsSnapshot" },
        extra: { placeId: "place-1" },
      }),
    );
  });

  it("a throwing reporter never breaks the page render", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const deps = makeVenueStatsDeps({
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          placeId: "place-1",
          publicSnapshot: { corrupt: true },
          publicSnapshotAt: null,
        })),
      },
      reportError,
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks).toEqual([]);
    expect(reportError).toHaveBeenCalled();
  });

  it("drops a stray venue_stats block on a non-PLACE page without touching placeStats", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "about-block",
            pageId: "page-1",
            kind: "about",
            orderIndex: 0,
            data: { content: "Hi" },
            visible: true,
          },
          { ...VENUE_STATS_BLOCK, pageId: "page-1" },
        ]),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
    expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
  });

  // ── audience_stats block (attendee-reviews FR-005) ──────────────────────

  const AUDIENCE_STATS_BLOCK = {
    id: "audience-stats-block",
    pageId: "page-3",
    kind: "audience_stats",
    orderIndex: 0,
    data: { heading: "What attendees say" },
    visible: true,
  };

  const PUBLISHABLE_AUDIENCE_SNAPSHOT = {
    version: 1,
    summary: {
      reviewCountBand: "7",
      overallScore: 4.5,
      recommendPct: 85,
      soundQualityScore: 4,
    },
  };

  function makeAudienceStatsDeps(overrides?: {
    reviewAggregates?: Record<string, any>;
    entityPages?: Record<string, any>;
    reportError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  }) {
    return makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [AUDIENCE_STATS_BLOCK]),
        ...overrides?.entityPages,
      },
      places: { getById: vi.fn(async () => ROXY_PLACE) },
      ...(overrides?.reviewAggregates
        ? { reviewAggregates: overrides.reviewAggregates }
        : {}),
      ...(overrides?.reportError
        ? { reportError: overrides.reportError }
        : {}),
    });
  }

  it("injects the ReviewAggregate(PLACE) snapshot into a visible audience_stats block with the trusted marker", async () => {
    const deps = makeAudienceStatsDeps({
      reviewAggregates: {
        getBySubject: vi.fn(async () => ({
          subjectType: "PLACE",
          subjectId: "place-1",
          snapshot: PUBLISHABLE_AUDIENCE_SNAPSHOT,
          computedAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.data).toEqual({
      heading: "What attendees say",
      dataSource: "audience_stats",
      snapshot: PUBLISHABLE_AUDIENCE_SNAPSHOT,
      snapshotAt: "2026-07-16T00:00:00.000Z",
    });
    expect(deps.repos.reviewAggregates.getBySubject).toHaveBeenCalledWith({
      subjectType: "PLACE",
      subjectId: "place-1",
    });
  });

  it("OMITS the audience_stats block when attendeeReviewsPublic is false (FR-005), without reading the aggregate", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [AUDIENCE_STATS_BLOCK]),
      },
      places: {
        getById: vi.fn(async () => ({
          ...ROXY_PLACE,
          attendeeReviewsPublic: false,
        })),
      },
      reviewAggregates: {
        getBySubject: vi.fn(async () => ({
          subjectType: "PLACE",
          subjectId: "place-1",
          snapshot: PUBLISHABLE_AUDIENCE_SNAPSHOT,
          computedAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    // The block is dropped entirely; the gate short-circuits BEFORE the read.
    expect(result.blocks).toEqual([]);
    expect(deps.repos.reviewAggregates.getBySubject).not.toHaveBeenCalled();
  });

  it("does NOT gate the performer venue_stats block on attendeeReviewsPublic (FR-007)", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
      },
      places: {
        getById: vi.fn(async () => ({
          ...ROXY_PLACE,
          // Attendee aggregate is PRIVATE — performer surface stays public.
          attendeeReviewsPublic: false,
        })),
      },
      placeStats: {
        getByPlaceId: vi.fn(async () => ({
          publicSnapshot: PUBLISHABLE_SNAPSHOT,
          publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["venue_stats"]);
    expect(deps.repos.placeStats.getByPlaceId).toHaveBeenCalled();
  });

  // ── NFR-002 (venue-track-record-and-review-switch): the PROPERTY, not a
  // field name. The 2026-07-23 test here pinned "venue_stats is not gated on
  // attendeeReviewsPublic" and stayed green while FR-007 was reversed through
  // a SECOND flag. So: venue_stats is present iff `communityReviewsEnabled`
  // is true, across every value of `attendeeReviewsPublic`; and
  // audience_stats tracks `attendeeReviewsPublic` alone, untouched by the
  // performer switch (FR-001). Both blocks are visible and both have a
  // publishable snapshot, so presence is decided by the flags and nothing else.
  describe("venue_stats is present iff communityReviewsEnabled, independent of attendeeReviewsPublic (NFR-002)", () => {
    const COMBOS = [
      { communityReviewsEnabled: true, attendeeReviewsPublic: true },
      { communityReviewsEnabled: true, attendeeReviewsPublic: false },
      { communityReviewsEnabled: false, attendeeReviewsPublic: true },
      { communityReviewsEnabled: false, attendeeReviewsPublic: false },
    ] as const;

    // Detail-only aggregate (no ungated `publicHeadline`), so audience_stats
    // renders only when the venue opted in — the flag decides, not the data.
    const DETAIL_ONLY_AUDIENCE_SNAPSHOT = {
      version: 1,
      summary: {
        reviewCountBand: "7",
        overallScore: 4.5,
        recommendPct: 85,
        soundQualityScore: 4,
      },
    };

    const PLACE_AUDIENCE_STATS_BLOCK = {
      id: "audience-stats-block",
      pageId: "page-3",
      kind: "audience_stats",
      orderIndex: 1,
      data: { heading: "What attendees say" },
      visible: true,
    };

    for (const combo of COMBOS) {
      it(`communityReviewsEnabled=${combo.communityReviewsEnabled}, attendeeReviewsPublic=${combo.attendeeReviewsPublic}`, async () => {
        const deps = makeDeps({
          entityPages: {
            getBySlug: vi.fn(async () => PLACE_PAGE),
            listBlocks: vi.fn(async () => [
              VENUE_STATS_BLOCK,
              PLACE_AUDIENCE_STATS_BLOCK,
            ]),
          },
          places: {
            getById: vi.fn(async () => ({ ...ROXY_PLACE, ...combo })),
          },
          placeStats: {
            getByPlaceId: vi.fn(async () => ({
              publicSnapshot: PUBLISHABLE_SNAPSHOT,
              publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
            })),
          },
          reviewAggregates: {
            getBySubject: vi.fn(async () => ({
              subjectType: "PLACE",
              subjectId: "place-1",
              snapshot: DETAIL_ONLY_AUDIENCE_SNAPSHOT,
              computedAt: new Date("2026-07-16T00:00:00.000Z"),
            })),
          },
        });

        const result = await getPublicPage(deps, { slug: "the-roxy" });
        const kinds = result.blocks.map((b) => b.kind);

        expect(kinds.includes("venue_stats")).toBe(
          combo.communityReviewsEnabled,
        );
        expect(kinds.includes("audience_stats")).toBe(
          combo.attendeeReviewsPublic,
        );
        // "Loader skipped" (FR-003) — off means the venue_stats loader is
        // skipped, not merely dropped after the fact. (On this non-venue
        // fixture nothing else reads PlaceStats; the venue-category case
        // below counts the door's read too.)
        expect(deps.repos.placeStats.getByPlaceId).toHaveBeenCalledTimes(
          combo.communityReviewsEnabled ? 1 : 0,
        );
      });
    }

    // On a REAL venue page the pinned track_record (stored or synthesized,
    // FU-004) reads the same PlaceStats row, so "loader skipped" is one read
    // fewer, not zero reads.
    for (const on of [true, false]) {
      it(`venue category, communityReviewsEnabled=${on}: PlaceStats is read ${on ? 2 : 1}× — the door always, venue_stats only when on`, async () => {
        const deps = makeDeps({
          entityPages: {
            getBySlug: vi.fn(async () => ({ ...PLACE_PAGE, category: "venue" })),
            listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
          },
          places: {
            getById: vi.fn(async () => ({
              ...ROXY_PLACE,
              communityReviewsEnabled: on,
            })),
          },
          placeStats: {
            getByPlaceId: vi.fn(async () => ({
              publicSnapshot: PUBLISHABLE_SNAPSHOT,
              publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
            })),
          },
        });

        const result = await getPublicPage(deps, { slug: "the-roxy" });
        const kinds = result.blocks.map((b) => b.kind);

        expect(kinds.includes("track_record")).toBe(true);
        expect(kinds.includes("venue_stats")).toBe(on);
        expect(deps.repos.placeStats.getByPlaceId).toHaveBeenCalledTimes(
          on ? 2 : 1,
        );
      });
    }

    // Every OTHER place boolean, flipped one at a time with the switch ON:
    // none of them may hide venue_stats. This is what makes the block a
    // property test rather than a two-flag table.
    //
    // Derived from the fixture at runtime, not listed by hand: a boolean added
    // to `PlaceRecord` later is covered the moment the fixture (a FULL record)
    // gains it, without anyone remembering this list.
    const OTHER_PLACE_BOOLEANS = (
      Object.keys(ROXY_PLACE) as (keyof PlaceRecord)[]
    ).filter(
      (key) =>
        typeof ROXY_PLACE[key] === "boolean" &&
        key !== "communityReviewsEnabled",
    );

    it("the derived boolean list is non-empty and excludes the switch itself", () => {
      expect(OTHER_PLACE_BOOLEANS.length).toBeGreaterThan(0);
      expect(OTHER_PLACE_BOOLEANS).not.toContain("communityReviewsEnabled");
    });

    for (const flag of OTHER_PLACE_BOOLEANS) {
      it(`switch ON: flipping ${flag} to ${!ROXY_PLACE[flag]} leaves venue_stats present`, async () => {
        const deps = makeDeps({
          entityPages: {
            getBySlug: vi.fn(async () => PLACE_PAGE),
            listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
          },
          places: {
            getById: vi.fn(async () => ({
              ...ROXY_PLACE,
              communityReviewsEnabled: true,
              [flag]: !ROXY_PLACE[flag],
            })),
          },
          placeStats: {
            getByPlaceId: vi.fn(async () => ({
              publicSnapshot: PUBLISHABLE_SNAPSHOT,
              publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
            })),
          },
        });

        const result = await getPublicPage(deps, { slug: "the-roxy" });

        expect(result.blocks.map((b) => b.kind)).toEqual(["venue_stats"]);
      });
    }

    // The non-boolean sibling that R3 ties to the switch's CREATE-time default:
    // once the switch is on, a withheld address must not hide the block either.
    for (const locationMode of ["EXACT", "OBSCURED"] as const) {
      it(`switch ON: locationMode ${locationMode} leaves venue_stats present`, async () => {
        const deps = makeDeps({
          entityPages: {
            getBySlug: vi.fn(async () => PLACE_PAGE),
            listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
          },
          places: {
            getById: vi.fn(async () => ({
              ...ROXY_PLACE,
              communityReviewsEnabled: true,
              locationMode,
            })),
          },
          placeStats: {
            getByPlaceId: vi.fn(async () => ({
              publicSnapshot: PUBLISHABLE_SNAPSHOT,
              publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
            })),
          },
        });

        const result = await getPublicPage(deps, { slug: "the-roxy" });

        expect(result.blocks.map((b) => b.kind)).toEqual(["venue_stats"]);
      });
    }

    it("defence in depth (a shape the adapter cannot produce): a summary missing the switch publishes no venue_stats", async () => {
      const { communityReviewsEnabled: _omitted, ...placeWithoutSwitch } =
        ROXY_PLACE;
      const deps = makeDeps({
        entityPages: {
          getBySlug: vi.fn(async () => PLACE_PAGE),
          listBlocks: vi.fn(async () => [VENUE_STATS_BLOCK]),
        },
        places: { getById: vi.fn(async () => placeWithoutSwitch) },
        placeStats: {
          getByPlaceId: vi.fn(async () => ({
            publicSnapshot: PUBLISHABLE_SNAPSHOT,
            publicSnapshotAt: new Date("2026-07-16T00:00:00.000Z"),
          })),
        },
      });

      const result = await getPublicPage(deps, { slug: "the-roxy" });

      expect(result.blocks.map((b) => b.kind)).toEqual([]);
      expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
    });
  });

  it("discards owner-injected fake audience stats — data is fully server-rebuilt except heading", async () => {
    const deps = makeAudienceStatsDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            ...AUDIENCE_STATS_BLOCK,
            data: {
              heading: "Totally real numbers",
              dataSource: "audience_stats",
              snapshot: {
                version: 1,
                summary: { reviewCountBand: "50+", overallScore: 5 },
              },
              snapshotAt: "2020-01-01T00:00:00.000Z",
              extraKey: "nope",
            },
          },
        ]),
      },
      reviewAggregates: {
        getBySubject: vi.fn(async () => ({
          subjectType: "PLACE",
          subjectId: "place-1",
          snapshot: PUBLISHABLE_AUDIENCE_SNAPSHOT,
          computedAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks[0]?.data).toEqual({
      heading: "Totally real numbers",
      dataSource: "audience_stats",
      snapshot: PUBLISHABLE_AUDIENCE_SNAPSHOT,
      snapshotAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("OMITS the audience_stats block when the aggregate is below-threshold ({version:1}, no summary)", async () => {
    const deps = makeAudienceStatsDeps({
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "about-block",
            pageId: "page-3",
            kind: "about",
            orderIndex: 0,
            data: { content: "A venue" },
            visible: true,
          },
          AUDIENCE_STATS_BLOCK,
        ]),
      },
      reviewAggregates: {
        getBySubject: vi.fn(async () => ({
          subjectType: "PLACE",
          subjectId: "place-1",
          snapshot: { version: 1 },
          computedAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
  });

  it("OMITS the audience_stats block when no aggregate exists", async () => {
    const deps = makeAudienceStatsDeps(); // getBySubject -> null

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.blocks).toEqual([]);
  });

  it("fails CLOSED on an invalid audience snapshot, reports it, page still renders", async () => {
    const reportError = vi.fn();
    const deps = makeAudienceStatsDeps({
      reviewAggregates: {
        getBySubject: vi.fn(async () => ({
          subjectType: "PLACE",
          subjectId: "place-1",
          // Corrupt: junk that fails attendeeReviewSnapshotSchema.
          snapshot: { version: 99, summary: { bogus: 1 } },
          computedAt: new Date("2026-07-16T00:00:00.000Z"),
        })),
      },
      reportError,
    });

    const result = await getPublicPage(deps, { slug: "the-roxy" });

    expect(result.page.slug).toBe("the-roxy");
    expect(result.blocks).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: { useCase: "getPublicPage", step: "audienceStatsSnapshot" },
        extra: { placeId: "place-1" },
      }),
    );
  });

  it("drops a stray audience_stats block on a non-PLACE page without touching reviewAggregates", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "about-block",
            pageId: "page-1",
            kind: "about",
            orderIndex: 0,
            data: { content: "Hi" },
            visible: true,
          },
          { ...AUDIENCE_STATS_BLOCK, pageId: "page-1" },
        ]),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
    expect(deps.repos.reviewAggregates.getBySubject).not.toHaveBeenCalled();
  });

  // ── Member-gated sections (recurring-memberships) ───────────────────────

  it("NEVER returns non-main-section blocks — member content must not enter the public/cacheable payload", async () => {
    // This output feeds the anonymously-cached /p/[slug] payload (ISR HTML +
    // RSC flight), so a `section == "memberships"` block leaking here is
    // member-only content served to every anonymous viewer. Member blocks are
    // served ONLY by the authed listMemberBlocks use case.
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ORG_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "b-main",
            pageId: "page-2",
            kind: "about",
            orderIndex: 0,
            data: { content: "public copy" },
            visible: true,
            section: "main",
          },
          {
            id: "b-members",
            pageId: "page-2",
            kind: "links",
            orderIndex: 1,
            // A members-only Discord invite is exactly the payload class this
            // pin protects.
            data: { content: "MEMBER_ONLY_DISCORD_INVITE" },
            visible: true, // visible is NOT sufficient — section gates it
            section: "memberships",
          },
        ]),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme Events",
          slug: "acme-events",
          trustTier: "STANDARD",
          trustBadgeLabel: null,
        })),
      },
    });

    const result = await getPublicPage(deps, { slug: "acme-events" });

    expect(result.blocks.map((b) => b.id)).toEqual(["b-main"]);
    // Belt and braces: the member-only content appears NOWHERE in the payload.
    expect(JSON.stringify(result)).not.toContain("MEMBER_ONLY_DISCORD_INVITE");
  });

  it("blocks without a section (legacy rows) still serve as main", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "b-legacy",
            pageId: "page-1",
            kind: "about",
            orderIndex: 0,
            data: { content: "Hi" },
            visible: true,
            // no `section` — pre-memberships row; must normalise to "main"
          },
        ]),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks.map((b) => b.id)).toEqual(["b-legacy"]);
  });

  it("throws not_found for a non-existent slug", async () => {
    const deps = makeDeps();

    await expect(
      getPublicPage(deps, { slug: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("throws not_found for a PRIVATE page", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ({
          ...HUMAN_PAGE,
          visibility: "PRIVATE",
        })),
      },
    });

    await expect(getPublicPage(deps, { slug: "alice" })).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("allows UNLISTED pages to be served (they just aren't discoverable)", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => ({
          ...HUMAN_PAGE,
          visibility: "UNLISTED",
        })),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });
    expect(result.page.visibility).toBe("UNLISTED");
  });

  it("throws not_found when owning entity is missing", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
      },
      // humans.getById returns null by default
    });

    await expect(getPublicPage(deps, { slug: "alice" })).rejects.toMatchObject({ code: "OWNER_NOT_FOUND" });
  });

  it("throws invalid_input for empty slug", async () => {
    const deps = makeDeps();

    await expect(getPublicPage(deps, { slug: "" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("throws invalid_input when slug is missing", async () => {
    const deps = makeDeps();

    await expect(getPublicPage(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  // ── Slug history redirect ──────────────────────────────────────────────

  it("redirects when slug matches a historical slug", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async (slug: string) =>
          slug === "alice-new" ? HUMAN_PAGE : null,
        ),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => "alice-new"),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice-old" });

    expect(result.redirect).toBe(true);
    expect(result.page.slug).toBe("alice");
    expect(deps.repos.entityPages.resolveSlugHistory).toHaveBeenCalledWith(
      "alice-old",
    );
  });

  it("does not set redirect for a current slug", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.redirect).toBeUndefined();
    // resolveSlugHistory should not have been called because getBySlug returned a result.
    expect(deps.repos.entityPages.resolveSlugHistory).not.toHaveBeenCalled();
  });

  it("throws not_found when both slug lookup and history miss", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => null),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
      },
    });

    await expect(
      getPublicPage(deps, { slug: "totally-unknown" }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation on the PUBLIC human page (security review M1): the venue
// is named only when it vouches for the show; otherwise the coarse location
// label, else nothing. `shows` and `upcoming_events` derive the same way.
// ─────────────────────────────────────────────────────────────────────────────

describe("getPublicPage — HUMAN shows name the venue only when venue-confirmed", () => {
  const perf = (overrides: Record<string, unknown>) => ({
    eventId: "e1",
    title: "Basement Show",
    startsAt: new Date("2026-09-01T02:00:00.000Z"),
    venueName: "The Basement",
    slug: "basement-show",
    placeId: "place-9",
    placeName: "The Basement",
    locationLabel: "Nashville, TN",
    orgId: null,
    humanId: "human-1",
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    ...overrides,
  });
  const showsBlock = {
    id: "shows-block",
    pageId: "page-1",
    kind: "shows",
    orderIndex: 0,
    data: { heading: "Upcoming" },
    visible: true,
  };
  const upcomingBlock = {
    id: "events-block",
    pageId: "page-1",
    kind: "upcoming_events",
    orderIndex: 0,
    data: { heading: "Shows", events: [] },
    visible: true,
  };
  function run(performance: Record<string, unknown>, block: typeof showsBlock | typeof upcomingBlock, placeOwners?: { orgIdsWithAccess: string[]; humanIdsWithAccess: string[] }) {
    const getPlaceById = vi.fn(async (id: string) =>
      id === "place-9" ? { id, name: "The Basement", ...(placeOwners ?? { orgIdsWithAccess: [], humanIdsWithAccess: [] }) } : null,
    );
    const deps = makeDeps({
      entityPages: { getBySlug: vi.fn(async () => HUMAN_PAGE), listBlocks: vi.fn(async () => [block]) },
      humans: { getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })) },
      eventHumans: { listPerformancesByHuman: vi.fn(async () => [performance]) },
      places: { getById: getPlaceById },
    });
    return { deps, getPlaceById };
  }

  it("UNCONFIRMED: the location label replaces the venue name (shows block: null-able; upcoming_events: label)", async () => {
    const shows = run(perf({}), showsBlock);
    const s = await getPublicPage(shows.deps, { slug: "alice" });
    expect((s.blocks[0]?.data as { events: Array<{ venueName: string | null }> }).events[0]?.venueName).toBe("Nashville, TN");
    expect(shows.getPlaceById).toHaveBeenCalledTimes(1);

    const up = run(perf({}), upcomingBlock);
    const u = await getPublicPage(up.deps, { slug: "alice" });
    expect((u.blocks[0]?.data as { events: Array<{ venueName?: string }> }).events[0]?.venueName).toBe("Nashville, TN");
  });

  it("UNCONFIRMED with no location label: no venue name at all", async () => {
    const up = run(perf({ locationLabel: null }), upcomingBlock);
    const u = await getPublicPage(up.deps, { slug: "alice" });
    expect((u.blocks[0]?.data as { events: Array<Record<string, unknown>> }).events[0]).not.toHaveProperty("venueName");
    const shows = run(perf({ locationLabel: null }), showsBlock);
    const s = await getPublicPage(shows.deps, { slug: "alice" });
    expect((s.blocks[0]?.data as { events: Array<{ venueName: string | null }> }).events[0]?.venueName).toBeNull();
  });

  it("STAMPED for its place: the venue is named; WITHDRAWN or stamped for another place: label only", async () => {
    const stamped = run(perf({ venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"), venueConfirmedPlaceId: "place-9" }), showsBlock);
    expect((await getPublicPage(stamped.deps, { slug: "alice" })).blocks[0]?.data).toMatchObject({ events: [{ venueName: "The Basement" }] });
    const withdrawn = run(
      perf({ venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"), venueConfirmedPlaceId: "place-9", venueConfirmationWithdrawnAt: new Date("2026-08-02T00:00:00.000Z") }),
      showsBlock,
    );
    expect((await getPublicPage(withdrawn.deps, { slug: "alice" })).blocks[0]?.data).toMatchObject({ events: [{ venueName: "Nashville, TN" }] });
    const moved = run(perf({ venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"), venueConfirmedPlaceId: "place-8" }), showsBlock);
    expect((await getPublicPage(moved.deps, { slug: "alice" })).blocks[0]?.data).toMatchObject({ events: [{ venueName: "Nashville, TN" }] });
  });

  it("VENUE-OWNED (the performer owns the place): named without a stamp", async () => {
    const owned = run(perf({}), upcomingBlock, { orgIdsWithAccess: [], humanIdsWithAccess: ["human-1"] });
    expect((await getPublicPage(owned.deps, { slug: "alice" })).blocks[0]?.data).toMatchObject({ events: [{ venueName: "The Basement" }] });
  });
});

// ── track_record block (venue-track-record-and-review-switch FR-011, NFR-003,
//    NFR-004, rulings R4 / R6 / R9) ───────────────────────────────────────────

describe("getPublicPage — pinned track_record block", () => {
  // `listPlaceLineupHistory` parses `placeId` as a UUID; the page's ownerId is
  // what reaches it, so the fixture is a real one.
  const PLACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const NOW = new Date("2026-09-24T18:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  const TRACK_PAGE = {
    ...HUMAN_PAGE,
    id: "page-4",
    ownerType: "PLACE" as const,
    ownerId: PLACE_ID,
    slug: "fishbowl-house",
  };

  // A FULL record (every boolean spelled out), in Los Angeles so "this year"
  // is the VENUE's calendar year, not UTC's.
  const FISHBOWL: PlaceRecord = {
    id: PLACE_ID,
    name: "Fishbowl House",
    formattedAddress: null,
    addressLine1: null,
    addressLine2: null,
    city: "Los Angeles",
    region: "CA",
    postalCode: null,
    countryCode: "US",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Los_Angeles",
    websiteSource: "UNKNOWN",
    capacity: null,
    lat: 34.09,
    lng: -118.39,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: null,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    listedInDirectory: true,
    acceptsBookingRequests: true,
    acceptsCommunityListings: false,
    attendeeReviewsPublic: false,
    // R3: withheld address → performer reviews OFF. The track record does not
    // care; it is pinned and switch-less.
    communityReviewsEnabled: false,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  // Stored data carries FORGED keys alongside the one editable field: the
  // loader must take `heading` and nothing else.
  const TRACK_RECORD_BLOCK = {
    id: "track-record-block",
    pageId: "page-4",
    kind: "track_record",
    orderIndex: 0,
    data: {
      heading: "What's happened here",
      showsHosted: 9999,
      dataSource: "track_record",
      recentActs: [{ name: "Forged", profileUrl: null, timesPlayed: 50 }],
      checkedInAvg: 250,
    },
    visible: true,
  };

  // The stored PlaceStats row: track-record columns PLUS the attendance
  // figures the block must never carry.
  const STATS_ROW = {
    placeId: PLACE_ID,
    showsHosted: 12,
    firstShowAt: new Date("2023-03-01T05:00:00.000Z"),
    lastShowAt: new Date("2026-09-18T05:00:00.000Z"),
    scannedEventCount: 9,
    checkedInTotal: 630,
    checkedInAvg: 70,
    publicSnapshot: null,
    publicSnapshotAt: null,
  };

  // Four weekly shows (each ends 22:00 LA = 05:00Z next day) and one that
  // ended 2026-01-01T02:00Z — i.e. 18:00 on 31 Dec 2025 in Los Angeles, so it
  // is LAST year for the venue even though it is 2026 in UTC.
  const WEEKLY_ENDS = [
    "2026-09-18T05:00:00.000Z",
    "2026-09-11T05:00:00.000Z",
    "2026-09-04T05:00:00.000Z",
    "2026-08-28T05:00:00.000Z",
  ];
  const NYE_END = "2026-01-01T02:00:00.000Z";
  const PAST_EVENTS = [...WEEKLY_ENDS, NYE_END].map((iso, i) => ({
    id: `event-${i}`,
    title: `Show ${i}`,
    startsAt: new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000),
    endsAt: new Date(iso),
  }));

  // Acts as the adapter returns them since FU-006 — already grouped in SQL:
  // one act linked with a page, playing twice; one unlinked act playing once.
  const ACTS_PAGE = {
    acts: [
      {
        humanId: "human-sundowners",
        externalName: null,
        name: "The Sundowners",
        profileSlug: "the-sundowners",
        timesPlayed: 2,
        lastPlayedAt: new Date("2026-09-18T02:00:00.000Z"),
      },
      {
        humanId: null,
        externalName: "DJ Fog",
        name: "DJ Fog",
        profileSlug: null,
        timesPlayed: 1,
        lastPlayedAt: new Date("2026-09-11T02:00:00.000Z"),
      },
    ],
    totalActs: 2,
  };
  // The linked act's opaque key: `h:` + 12 hex of SHA-256(placeId:humanId)
  // — venue-scoped, and the raw id never reaches the payload.
  const SUNDOWNERS_KEY = `h:${createHash("sha256")
    .update(`${PLACE_ID}:human-sundowners`)
    .digest("hex")
    .slice(0, 12)}`;

  function makeTrackRecordDeps(overrides?: {
    place?: PlaceRecord | null;
    stats?: Record<string, unknown> | null;
    events?: typeof PAST_EVENTS;
    listActsByPlace?: (...args: any[]) => Promise<unknown>;
    blocks?: unknown[];
    reportError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  }) {
    const events = overrides?.events ?? PAST_EVENTS;
    return makeDeps({
      ...(overrides?.reportError ? { reportError: overrides.reportError } : {}),
      entityPages: {
        getBySlug: vi.fn(async () => TRACK_PAGE),
        listBlocks: vi.fn(async () => overrides?.blocks ?? [TRACK_RECORD_BLOCK]),
      },
      places: {
        getById: vi.fn(async () =>
          overrides && "place" in overrides ? overrides.place : FISHBOWL,
        ),
      },
      placeStats: {
        getByPlaceId: vi.fn(async () =>
          overrides && "stats" in overrides ? overrides.stats : STATS_ROW,
        ),
      },
      events: {
        listPublishedByPlace: vi.fn(async () => ({
          items: events,
          pageInfo: {
            total: events.length,
            limit: 100,
            offset: 0,
            count: events.length,
            hasNextPage: false,
            nextOffset: null,
          },
        })),
      },
      eventHumans: {
        listActsByPlace:
          overrides?.listActsByPlace ?? vi.fn(async () => ACTS_PAGE),
      },
    });
  }

  const ZERO_SHAPE = {
    dataSource: "track_record",
    showsHosted: 0,
    showsThisYear: 0,
    firstShowAt: null,
    yearsRunning: null,
    lastShowAt: null,
    cadence: null,
    cadenceSince: null,
    recentActs: [],
    allActsCount: 0,
    // FU-001: the venue's zone for the renderers; null on the zero shape
    // taken before the place row is read.
    timeZone: null,
  };

  const FR_011_KEYS = [
    "dataSource",
    "heading",
    "showsHosted",
    "showsThisYear",
    "firstShowAt",
    "yearsRunning",
    "lastShowAt",
    "cadence",
    "cadenceSince",
    "recentActs",
    "allActsCount",
    "timeZone",
  ].sort();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("populated: the serialised payload has EXACTLY the FR-011 keys and nothing attendance-shaped (NFR-004, R4)", async () => {
    const deps = makeTrackRecordDeps();

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["track_record"]);
    const data = result.blocks[0]!.data as Record<string, unknown>;

    // Key set, by name — a new attendance field would fail this line.
    expect(Object.keys(data).sort()).toEqual(FR_011_KEYS);
    // And by shape — nothing named like a count of people anywhere in the
    // JSON the page would ship, including nested acts.
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/checkedIn|attendance|scanned|avgAttendance/i);
    expect(json).not.toContain("Forged");
    expect(json).not.toContain("9999");

    expect(data).toEqual({
      dataSource: "track_record",
      heading: "What's happened here",
      showsHosted: 12,
      // Four of the five ended in 2026 in Los Angeles; the NYE show is 2025.
      showsThisYear: 4,
      firstShowAt: "2023-03-01T05:00:00.000Z",
      // 2023-03-01 → 2026-09-24 = 3.56 calendar years, floored to a half.
      yearsRunning: 3.5,
      lastShowAt: "2026-09-18T05:00:00.000Z",
      cadence: "weekly",
      cadenceSince: "2026-08-28T05:00:00.000Z",
      recentActs: [
        {
          key: SUNDOWNERS_KEY,
          name: "The Sundowners",
          profileUrl: "/humans/the-sundowners",
          timesPlayed: 2,
        },
        { key: "n:dj fog", name: "DJ Fog", profileUrl: null, timesPlayed: 1 },
      ],
      allActsCount: 2,
      // FU-001: the place's own zone, so both surfaces format the same day.
      timeZone: FISHBOWL.timezone,
    });
    // Each act carries exactly the public fields — the opaque key plus the
    // three display fields (no `lastPlayedAt`, no raw id).
    for (const act of data.recentActs as Record<string, unknown>[]) {
      expect(Object.keys(act).sort()).toEqual([
        "key",
        "name",
        "profileUrl",
        "timesPlayed",
      ]);
    }
    expect(json).not.toContain("human-sundowners");
  });

  it("reads the trailing 400-day window of ENDED, venue-confirmed shows on the endsAt basis", async () => {
    const deps = makeTrackRecordDeps();

    await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledTimes(1);
    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        status: "past",
        to: NOW,
        from: new Date(NOW.getTime() - 400 * DAY_MS),
        // The adapter clamps to maxLimit 100; ask for exactly that.
        limit: 100,
        offset: 0,
        venueConfirmedFor: expect.anything(),
        // R10: a show `completeEvent` closed out still happened.
        statuses: ["PUBLISHED", "COMPLETED"],
      }),
    );
    // The lineup read is bound to the same `now` and the same confirmation
    // filter — one clock, one predicate, for the whole block.
    expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        now: NOW,
        venueConfirmedFor: expect.anything(),
        // FU-006: the page's recent line is 8 acts — the limit is pushed
        // into the query, so a long history is never read in full here.
        limit: 8,
      }),
    );
  });

  it("showsThisYear never exceeds the stored showsHosted (live count vs 15-minute-stale column)", async () => {
    // Four shows ended this year but the stored total says three: the job
    // has not caught up with the latest night yet.
    const deps = makeTrackRecordDeps({
      stats: { ...STATS_ROW, showsHosted: 3 },
    });

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(result.blocks[0]!.data).toMatchObject({ showsHosted: 3, showsThisYear: 3 });
  });

  it("showsThisYear is the VENUE's calendar year: the same rows count 5 in a UTC place", async () => {
    const deps = makeTrackRecordDeps({
      place: { ...FISHBOWL, timezone: null },
    });

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(result.blocks[0]!.data).toMatchObject({ showsThisYear: 5 });
  });

  it("zero shape when there is no PlaceStats row: the block is PRESENT, never omitted, and no further reads run", async () => {
    const deps = makeTrackRecordDeps({ stats: null });

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(result.blocks.map((b) => b.kind)).toEqual(["track_record"]);
    expect(result.blocks[0]!.data).toEqual({
      heading: "What's happened here",
      ...ZERO_SHAPE,
      // The place row is read before the stats check, so even the zero
      // shape formats in the venue's zone (FU-001).
      timeZone: FISHBOWL.timezone,
    });
    expect(deps.repos.events.listPublishedByPlace).not.toHaveBeenCalled();
    expect(deps.repos.eventHumans.listActsByPlace).not.toHaveBeenCalled();
  });

  it("no stats row → the zero shape still carries the PLACE's zone, read before the stats check", async () => {
    const deps = makeTrackRecordDeps({ stats: null });
    const result = await getPublicPage(deps, { slug: "fishbowl-house" });
    expect((result.blocks[0]!.data as { timeZone: unknown }).timeZone).toBe(
      "America/Los_Angeles",
    );
    // The place read happened even though the stats row was absent.
    expect(deps.repos.places.getById).toHaveBeenCalledWith(PLACE_ID);
    expect(deps.repos.placeStats.getByPlaceId).toHaveBeenCalledWith(PLACE_ID);
  });

  it("zero shape when showsHosted is 0 — and when the column is missing from an older row", async () => {
    for (const stats of [
      { ...STATS_ROW, showsHosted: 0, firstShowAt: null, lastShowAt: null },
      { publicSnapshot: null, publicSnapshotAt: null },
    ]) {
      const deps = makeTrackRecordDeps({ stats });
      const result = await getPublicPage(deps, { slug: "fishbowl-house" });
      expect(result.blocks[0]!.data).toEqual({
        heading: "What's happened here",
        ...ZERO_SHAPE,
        timeZone: FISHBOWL.timezone,
      });
    }
  });

  it("no stored heading → no heading key (nothing else from stored data survives)", async () => {
    const deps = makeTrackRecordDeps({
      blocks: [{ ...TRACK_RECORD_BLOCK, data: { showsHosted: 9999 } }],
    });

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    const data = result.blocks[0]!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("heading");
    expect(data.showsHosted).toBe(12);
  });

  it("no switch gates it: communityReviewsEnabled false / attendeeReviewsPublic false still serve the full block", async () => {
    const deps = makeTrackRecordDeps({
      place: {
        ...FISHBOWL,
        communityReviewsEnabled: false,
        attendeeReviewsPublic: false,
      },
    });

    const result = await getPublicPage(deps, { slug: "fishbowl-house" });

    expect(result.blocks[0]!.data).toMatchObject({ showsHosted: 12, cadence: "weekly" });
  });

  it("a track_record block on a non-PLACE page is dropped, never echoed from stored data", async () => {
    const deps = makeDeps({
      entityPages: {
        getBySlug: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [
          { ...TRACK_RECORD_BLOCK, pageId: "page-1" },
        ]),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
    });

    const result = await getPublicPage(deps, { slug: "alice" });

    expect(result.blocks).toEqual([]);
    expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
  });

  describe("the lineup arm is the ONE swallow on this path (NFR-003)", () => {
    it("a failed lineup read degrades to an empty acts line, keeps the door figures, and is REPORTED", async () => {
      const boom = new Error("listActsByPlace is not a function");
      const reportError = vi.fn();
      const deps = makeTrackRecordDeps({
        listActsByPlace: vi.fn(async () => {
          throw boom;
        }),
        reportError,
      });

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks[0]!.data).toMatchObject({
        showsHosted: 12,
        showsThisYear: 4,
        cadence: "weekly",
        recentActs: [],
        allActsCount: 0,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(boom, {
        tags: { useCase: "getPublicPage", step: "trackRecordLineup" },
        extra: { placeId: PLACE_ID },
      });
    });

    it("an ARCHIVED place is an input condition, not a failure: lineup read skipped, empty acts line, NOTHING reported", async () => {
      const reportError = vi.fn();
      const deps = makeTrackRecordDeps({
        place: { ...FISHBOWL, status: "ARCHIVED" },
        reportError,
      });

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks[0]!.data).toMatchObject({
        showsHosted: 12,
        recentActs: [],
        allActsCount: 0,
      });
      expect(deps.repos.eventHumans.listActsByPlace).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a throwing reporter never changes behaviour", async () => {
      const deps = makeTrackRecordDeps({
        listActsByPlace: vi.fn(async () => {
          throw new Error("adapter down");
        }),
        reportError: vi.fn(() => {
          throw new Error("sentry down too");
        }),
      });

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks[0]!.data).toMatchObject({ showsHosted: 12, recentActs: [] });
    });

    it("a failed PlaceStats read THROWS like the sibling loaders (no fallback, nothing reported)", async () => {
      const reportError = vi.fn();
      const deps = makeTrackRecordDeps({ reportError });
      deps.repos.placeStats.getByPlaceId = vi.fn(async () => {
        throw new Error("db down");
      }) as any;

      await expect(
        getPublicPage(deps, { slug: "fishbowl-house" }),
      ).rejects.toThrow("db down");
      expect(reportError).not.toHaveBeenCalled();
    });

    it("a failed events read THROWS too", async () => {
      const deps = makeTrackRecordDeps();
      deps.repos.events.listPublishedByPlace = vi.fn(async () => {
        throw new Error("events down");
      }) as any;

      await expect(
        getPublicPage(deps, { slug: "fishbowl-house" }),
      ).rejects.toThrow("events down");
    });
  });

  // ── FU-004: a venue page seeded before template revision 4 (every unclaimed
  //    venue — its owner never opens the editor that seeds) gets the block
  //    SYNTHESIZED on the public read, filled exactly like a stored one.
  describe("synthesized on venue pages that predate it (FU-004)", () => {
    const block = (kind: string, orderIndex: number) => ({
      id: `${kind}-block`,
      pageId: "page-4",
      kind,
      orderIndex,
      data: {},
      visible: true,
    });
    // A revision-1 venue page: bare "venue" marker, no stored category.
    const REV1_PAGE = {
      ...TRACK_PAGE,
      category: null,
      templateAppliedCategories: ["venue"],
    };

    function makeRev1Deps(blocks: unknown[], page: unknown = REV1_PAGE) {
      const deps = makeTrackRecordDeps({ blocks });
      deps.repos.entityPages.getBySlug = vi.fn(async () => page) as any;
      return deps;
    }

    it("unclaimed rev-1 venue page → exactly ONE track_record, directly after photos, with the door's data", async () => {
      const deps = makeRev1Deps([
        block("about", 0),
        block("capacity_info", 1),
        block("photos", 2),
        block("booking_info", 3),
      ]);

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks.map((b) => b.kind)).toEqual([
        "about",
        "capacity_info",
        "photos",
        "track_record",
        "booking_info",
      ]);
      const synthetic = result.blocks[3]!;
      expect(synthetic).toMatchObject({
        id: "synthetic:track_record:page-4",
        pageId: "page-4",
        visible: true,
        section: "main",
        // Half a step after photos, so a sort by orderIndex agrees.
        orderIndex: 2.5,
      });
      // Filled by the SAME loader as a stored block — full figures, acts,
      // and no heading (a synthetic block has no stored data).
      expect(synthetic.data).toEqual({
        dataSource: "track_record",
        showsHosted: 12,
        showsThisYear: 4,
        firstShowAt: "2023-03-01T05:00:00.000Z",
        yearsRunning: 3.5,
        lastShowAt: "2026-09-18T05:00:00.000Z",
        cadence: "weekly",
        cadenceSince: "2026-08-28T05:00:00.000Z",
        recentActs: [
          {
            key: SUNDOWNERS_KEY,
            name: "The Sundowners",
            profileUrl: "/humans/the-sundowners",
            timesPlayed: 2,
          },
          { key: "n:dj fog", name: "DJ Fog", profileUrl: null, timesPlayed: 1 },
        ],
        allActsCount: 2,
        timeZone: FISHBOWL.timezone,
      });
      expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledTimes(1);
    });

    it("no photos → directly BEFORE venue_stats (not at the end)", async () => {
      const deps = makeRev1Deps([
        block("about", 0),
        block("venue_stats", 1),
        block("booking_info", 2),
      ]);

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      // venue_stats itself is omitted (FISHBOWL has performer reviews off),
      // but the synthetic block took its slot, ahead of booking_info.
      expect(result.blocks.map((b) => b.kind)).toEqual([
        "about",
        "track_record",
        "booking_info",
      ]);
      expect(result.blocks[1]!.orderIndex).toBe(0.5);
    });

    it("neither photos nor venue_stats → last; a venue page with NO blocks still gets it", async () => {
      const deps = makeRev1Deps([block("about", 0), block("booking_info", 4)]);
      const result = await getPublicPage(deps, { slug: "fishbowl-house" });
      expect(result.blocks.map((b) => b.kind)).toEqual([
        "about",
        "booking_info",
        "track_record",
      ]);
      expect(result.blocks[2]!.orderIndex).toBe(5);

      const empty = makeRev1Deps([]);
      const emptyResult = await getPublicPage(empty, { slug: "fishbowl-house" });
      expect(emptyResult.blocks.map((b) => [b.kind, b.orderIndex])).toEqual([
        ["track_record", 0],
      ]);
      expect(emptyResult.blocks[0]!.data).toMatchObject({ showsHosted: 12 });
    });

    it("a STORED track_record always wins: no synthetic one, the stored block keeps its place and heading", async () => {
      // Rev-4 seeding appends it at the end; the owner never moved it.
      const deps = makeRev1Deps(
        [
          block("about", 0),
          block("photos", 1),
          block("booking_info", 2),
          { ...TRACK_RECORD_BLOCK, orderIndex: 3 },
        ],
        { ...REV1_PAGE, category: "venue", templateAppliedCategories: ["venue@4"] },
      );

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks.map((b) => b.id)).toEqual([
        "about-block",
        "photos-block",
        "booking_info-block",
        "track-record-block",
      ]);
      expect(result.blocks.filter((b) => b.kind === "track_record")).toHaveLength(1);
      expect(result.blocks[3]!.data).toMatchObject({
        heading: "What's happened here",
        showsHosted: 12,
      });
    });

    it("a HUMAN page never gets one (and the place loaders never run)", async () => {
      const deps = makeDeps({
        entityPages: {
          getBySlug: vi.fn(async () => HUMAN_PAGE),
          listBlocks: vi.fn(async () => [
            { ...block("photos", 0), pageId: "page-1" },
          ]),
        },
        humans: {
          getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
        },
      });

      const result = await getPublicPage(deps, { slug: "alice" });

      expect(result.blocks.map((b) => b.kind)).toEqual(["photos"]);
      expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
    });

    it("a PLACE page under a non-venue category never gets one", async () => {
      const deps = makeRev1Deps([block("about", 0), block("photos", 1)], {
        ...REV1_PAGE,
        category: "gallery",
      });

      const result = await getPublicPage(deps, { slug: "fishbowl-house" });

      expect(result.blocks.map((b) => b.kind)).toEqual(["about", "photos"]);
      expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
    });
  });
});

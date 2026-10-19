import { describe, expect, it, vi } from "vitest";

import { getMyPage } from "../get-my-page";
import type { GetMyPageDeps } from "../get-my-page";

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTOR_ID = "human-1";

const HUMAN_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: ACTOR_ID,
  slug: "alice",
  displayName: "Alice",
  bio: "Hello world",
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  // Pre-mark every default category as already-seeded AT ITS CURRENT REVISION
  // so the lazy-seed path in getMyPage is a no-op for these baseline tests
  // (dedicated seeding tests set up empty templateAppliedCategories explicitly
  // below). Bump the marker here whenever a template's revision advances.
  category: "generic" as string | null,
  templateAppliedCategories: ["generic", "performer", "musician", "venue@2"],
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

const VISIBLE_BLOCK = {
  id: "b1",
  pageId: "page-1",
  kind: "about",
  orderIndex: 0,
  data: {},
  visible: true,
};

const HIDDEN_BLOCK = {
  id: "b2",
  pageId: "page-1",
  kind: "links",
  orderIndex: 1,
  data: {},
  visible: false,
};

/** Default owner row behind the HUMAN fixtures (shared entity loader). */
const HUMAN_ENTITY = {
  id: ACTOR_ID,
  name: "Alice",
  jobs: ["MUSICIAN"],
  genreTags: ["indie"],
  otherJobDescription: null,
};

function makeDeps(
  overrides?: Partial<{
    entityPages: Record<string, any>;
    announcements: Record<string, any>;
    humans: Record<string, any>;
    organizations: Record<string, any>;
    places: Record<string, any>;
    performerProfiles: Record<string, any>;
    calendars: Record<string, any>;
    eventHumans: Record<string, any>;
    humanStats: Record<string, any>;
    authzError: Error | null;
    canManagePlaceResult: { allowed: boolean };
  }>,
): GetMyPageDeps {
  return {
    repos: {
      entityPages: {
        getByOwner: vi.fn(async () => HUMAN_PAGE),
        getById: vi.fn(async () => HUMAN_PAGE),
        listBlocks: vi.fn(async () => [VISIBLE_BLOCK, HIDDEN_BLOCK]),
        getTheme: vi.fn(async () => null),
        applyTemplateSeed: vi.fn(async () => []),
        ...overrides?.entityPages,
      } as any,
      authz: {} as any,
      announcements: {
        listByOrg: vi.fn(async () => ({ items: [], total: 0 })),
        listBySender: vi.fn(async () => ({ items: [], total: 0 })),
        ...overrides?.announcements,
      } as any,
      humans: {
        getById: vi.fn(async () => HUMAN_ENTITY),
        ...overrides?.humans,
      } as any,
      organizations: {
        getById: vi.fn(async () => null),
        ...overrides?.organizations,
      } as any,
      places: {
        getById: vi.fn(async () => null),
        ...overrides?.places,
      } as any,
      // Availability-onboarding FR-005 (see get-public-page.test.ts): default
      // CONFIGURED so PLACE expectations here keep describing a venue with
      // hours; parity for the unconfigured venue lives in entity-summary.test.
      calendars: {
        countAvailabilityForPlace: vi.fn(async () => 1),
        ...overrides?.calendars,
      } as any,
      performerProfiles: {
        getByOwner: vi.fn(async () => null),
        ...overrides?.performerProfiles,
      } as any,
      eventHumans: {
        listPerformancesByHuman: vi.fn(async () => []),
        ...overrides?.eventHumans,
      } as any,
      humanStats: {
        findByHumanId: vi.fn(async () => null),
        ...overrides?.humanStats,
      } as any,
    },
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: overrides?.authzError
        ? vi.fn(async () => {
            throw overrides.authzError;
          })
        : vi.fn(async () => {}),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(
        async () => overrides?.canManagePlaceResult ?? { allowed: true },
      ),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getMyPage", () => {
  it("returns page with ALL blocks (including hidden) for the owner", async () => {
    const deps = makeDeps();

    const result = await getMyPage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
    });

    expect(result.page.slug).toBe("alice");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[1]!.visible).toBe(false);
  });

  it("throws forbidden when human tries to view another human's page", async () => {
    const deps = makeDeps();

    await expect(
      getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: "other-human",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when page does not exist", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => null),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
      },
    });

    await expect(
      getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("authorizes ORGANIZATION pages with the resolved domain actor human id", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => ({
          ...HUMAN_PAGE,
          ownerType: "ORGANIZATION",
          ownerId: "org-1",
        })),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
      },
    });

    await getMyPage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
    });

    expect(deps.authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        orgId: "org-1",
      }),
    );
  });

  it("calls canManagePlace for PLACE pages", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => ({
          ...HUMAN_PAGE,
          ownerType: "PLACE",
          ownerId: "place-1",
        })),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
      },
    });

    await getMyPage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    expect(deps.authz.canManagePlace).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        placeId: "place-1",
      }),
    );
  });

  it("throws forbidden when PLACE access is denied", async () => {
    const deps = makeDeps({ canManagePlaceResult: { allowed: false } });

    await expect(
      getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(deps.repos.entityPages.getByOwner).not.toHaveBeenCalled();
  });

  it("throws invalid_input for missing actorHumanId", async () => {
    const deps = makeDeps();

    await expect(
      getMyPage(deps, {
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("expands human announcement blocks from sender announcements", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => HUMAN_PAGE),
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
        getTheme: vi.fn(async () => null),
      },
      announcements: {
        listBySender: vi.fn(async () => ({
          total: 1,
          items: [
            {
              id: "announcement-1",
              orgId: "org-1",
              eventId: null,
              subject: "Sent update",
              bodyDoc: null,
              bodyHtml: "<p>Details</p>",
              publicOnEntityPage: false,
              audienceType: "ALL_TICKET_HOLDERS",
              audienceRef: null,
              audienceFilter: null,
              excludedContactListId: null,
              recipientCount: null,
              sentAt: null,
              sentBy: ACTOR_ID,
              createdAt: new Date("2025-09-01T12:00:00.000Z"),
              updatedAt: new Date("2025-09-01T12:00:00.000Z"),
            },
          ],
        })),
      },
    });

    const result = await getMyPage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
    });

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
    expect(deps.repos.announcements.listBySender).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      limit: 10,
      offset: 0,
    });
  });

  it("expands place location map blocks from place data in the editor", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => ({
          ...HUMAN_PAGE,
          ownerType: "PLACE",
          ownerId: "place-1",
        })),
        listBlocks: vi.fn(async () => [
          {
            id: "map-block",
            pageId: "page-1",
            kind: "location_map",
            orderIndex: 0,
            data: { heading: "Visit", address: "Manual" },
            visible: true,
          },
        ]),
        getTheme: vi.fn(async () => null),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "The Roxy",
          slug: "the-roxy",
          city: "Los Angeles",
          region: "CA",
          formattedAddress: "9009 Sunset Blvd, West Hollywood, CA",
          lat: 34.09,
          lng: -118.39,
          // EXPLICIT: `redactPlaceLocation` fails closed, so a fake that omits
          // this is treated as WITHHELD.
          locationMode: "EXACT",
          locationRadiusMeters: null,
          locationLabel: null,
        })),
      },
    });

    const result = await getMyPage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    expect(result.blocks[0]?.data).toMatchObject({
      heading: "Visit",
      dataSource: "place",
      address: "9009 Sunset Blvd, West Hollywood, CA",
      lat: 34.09,
      lng: -118.39,
    });
  });

  // ── Musician EPK derived-block injection ───────────────────────────────────

  describe("musician EPK derived blocks", () => {
    it("injects upcoming shows + ALWAYS injects stats (eligible:false for a thin human)", async () => {
      const listPerformancesByHuman = vi.fn(async () => [
        {
          eventId: "e1",
          title: "First Gig",
          startsAt: new Date("2026-09-01T02:00:00.000Z"),
          venueName: "The Basement",
          slug: "first-gig",
        },
      ]);
      const findByHumanId = vi.fn(async () => null); // never computed → thin
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [
            {
              id: "shows-block",
              pageId: "page-1",
              kind: "shows",
              orderIndex: 0,
              data: { heading: "Shows" },
              visible: true,
            },
            {
              id: "stats-block",
              pageId: "page-1",
              kind: "stats",
              orderIndex: 1,
              data: { heading: "Stats" },
              visible: false,
            },
          ]),
        },
        eventHumans: { listPerformancesByHuman },
        humanStats: { findByHumanId },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      const shows = result.blocks.find((b) => b.kind === "shows");
      expect(shows?.data).toMatchObject({
        dataSource: "shows",
        events: [{ id: "e1", title: "First Gig", venueName: "The Basement" }],
      });

      const stats = result.blocks.find((b) => b.kind === "stats");
      // Owner editor sees the ineligible state even though the block is hidden.
      expect(stats?.data).toMatchObject({
        dataSource: "stats",
        eligible: false,
        computedAt: null,
      });
      expect((stats?.data as any).metrics.totalEventsPerformed).toBe(0);
      expect(findByHumanId).toHaveBeenCalledWith(ACTOR_ID);
    });

    it("does not query performance/stats repos when no EPK blocks are present", async () => {
      const listPerformancesByHuman = vi.fn(async () => []);
      const findByHumanId = vi.fn(async () => null);
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [VISIBLE_BLOCK]),
        },
        eventHumans: { listPerformancesByHuman },
        humanStats: { findByHumanId },
      });

      await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(listPerformancesByHuman).not.toHaveBeenCalled();
      expect(findByHumanId).not.toHaveBeenCalled();
    });

    const UPCOMING_EVENTS_BLOCK = {
      id: "events-block",
      pageId: "page-1",
      kind: "upcoming_events",
      orderIndex: 0,
      data: {
        heading: "Shows",
        events: [
          { id: "static-1", title: "Hand-typed gig", date: "2026-01-01" },
        ],
      },
      visible: true,
    };

    it("derives upcoming_events from performances in the editor preview when no shows block exists (mirrors public)", async () => {
      const listPerformancesByHuman = vi.fn(async () => [
        {
          eventId: "e1",
          title: "Basement Show",
          startsAt: new Date("2026-09-01T02:00:00.000Z"),
          venueName: "The Basement",
          slug: "basement-show",
          // Venue-confirmation spec: the derivation mirrors the PUBLIC rule
          // (venue named only when it vouches) — stamped for its place.
          placeId: "place-9",
          placeName: "The Basement",
          locationLabel: "Nashville, TN",
          orgId: null,
          humanId: ACTOR_ID,
          venueConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
          venueConfirmationWithdrawnAt: null,
          venueConfirmedPlaceId: "place-9",
        },
      ]);
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [UPCOMING_EVENTS_BLOCK]),
        },
        eventHumans: { listPerformancesByHuman },
        // The stamped fixture's place must EXIST — a gone place cannot vouch.
        places: {
          getById: vi.fn(async (id: string) =>
            id === "place-9" ? { id, name: "The Basement", orgIdsWithAccess: [], humanIdsWithAccess: [] } : null,
          ),
        },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

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
        ],
      });
      expect(listPerformancesByHuman).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: ACTOR_ID, when: "upcoming" }),
      );
    });

    it("leaves upcoming_events untouched in the editor when a shows block is also present (dedupe rule)", async () => {
      const listPerformancesByHuman = vi.fn(async () => [
        {
          eventId: "e1",
          title: "Basement Show",
          startsAt: new Date("2026-09-01T02:00:00.000Z"),
          venueName: "The Basement",
          slug: "basement-show",
        },
      ]);
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [
            {
              id: "shows-block",
              pageId: "page-1",
              kind: "shows",
              orderIndex: 0,
              data: { heading: "Upcoming" },
              visible: true,
            },
            { ...UPCOMING_EVENTS_BLOCK, orderIndex: 1 },
          ]),
        },
        eventHumans: { listPerformancesByHuman },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      const upcoming = result.blocks.find((b) => b.kind === "upcoming_events");
      expect(upcoming?.data).toEqual(UPCOMING_EVENTS_BLOCK.data);
      // Only the shows derivation hit the repo.
      expect(listPerformancesByHuman).toHaveBeenCalledTimes(1);
    });

    it("suppresses upcoming_events derivation in the editor even when the shows block is HIDDEN (editor renders hidden blocks)", async () => {
      const listPerformancesByHuman = vi.fn(async () => [
        {
          eventId: "e1",
          title: "Basement Show",
          startsAt: new Date("2026-09-01T02:00:00.000Z"),
          venueName: "The Basement",
          slug: "basement-show",
        },
      ]);
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [
            {
              id: "shows-block",
              pageId: "page-1",
              kind: "shows",
              orderIndex: 0,
              data: { heading: "Upcoming" },
              visible: false, // hidden, but the editor still displays it
            },
            { ...UPCOMING_EVENTS_BLOCK, orderIndex: 1 },
          ]),
        },
        eventHumans: { listPerformancesByHuman },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      // The hidden shows block derives (editor shows it); upcoming_events
      // keeps its static data so the editor doesn't double-list events.
      const shows = result.blocks.find((b) => b.kind === "shows");
      expect(shows?.data).toMatchObject({
        dataSource: "shows",
        events: [expect.objectContaining({ id: "e1" })],
      });
      const upcoming = result.blocks.find((b) => b.kind === "upcoming_events");
      expect(upcoming?.data).toEqual(UPCOMING_EVENTS_BLOCK.data);
      expect(listPerformancesByHuman).toHaveBeenCalledTimes(1);
    });

    it("preserves static upcoming_events in the editor when there are zero upcoming performances", async () => {
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [UPCOMING_EVENTS_BLOCK]),
        },
        // eventHumans.listPerformancesByHuman -> [] by default
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(result.blocks[0]?.data).toEqual(UPCOMING_EVENTS_BLOCK.data);
    });
  });

  // ── Lazy template seeding (FR-004) ─────────────────────────────────────────

  describe("lazy template seeding", () => {
    /**
     * Wires an in-memory entityPages repo whose applyTemplateSeed models the
     * adapter contract (atomic per-category guard + additive append-by-kind),
     * so getMyPage's post-seed listBlocks reflects the seeded blocks.
     */
    function makeSeedingDeps(opts: {
      page: any;
      initialBlocks?: any[];
      performerEnabled?: boolean;
    }): GetMyPageDeps {
      let blocks = [...(opts.initialBlocks ?? [])];
      let applied = [...opts.page.templateAppliedCategories];
      const page = { ...opts.page };
      let counter = 0;

      const applyTemplateSeed = vi.fn(
        async ({ category, blocks: candidates }: any) => {
          if (applied.includes(category)) return [];
          applied = [...applied, category];
          page.templateAppliedCategories = applied;
          const present = new Set(blocks.map((b: any) => b.kind));
          let nextIndex = blocks.reduce(
            (max: number, b: any) => Math.max(max, b.orderIndex + 1),
            0,
          );
          const created: any[] = [];
          for (const c of candidates) {
            if (present.has(c.kind)) continue;
            present.add(c.kind);
            const row = {
              id: `seeded-${counter++}`,
              pageId: page.id,
              kind: c.kind,
              orderIndex: nextIndex++,
              data: c.data ?? {},
              visible: c.visible ?? true,
            };
            blocks.push(row);
            created.push(row);
          }
          return created;
        },
      );

      const profile = opts.performerEnabled
        ? { enabledAt: new Date("2025-01-01"), disabledAt: null }
        : null;

      return makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => page),
          getById: vi.fn(async () => page),
          listBlocks: vi.fn(async () => [...blocks]),
          getTheme: vi.fn(async () => null),
          applyTemplateSeed,
        },
        performerProfiles: {
          getByOwner: vi.fn(async () => profile),
        },
      });
    }

    it("seeds the performer template (working-act tier) for a performer with an empty page on first load", async () => {
      const deps = makeSeedingDeps({
        page: {
          ...HUMAN_PAGE,
          templateAppliedCategories: [],
          category: null,
        },
        initialBlocks: [],
        performerEnabled: true,
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(result.blocks.map((b) => b.kind)).toEqual([
        "about",
        "music",
        "video",
        "photos",
        "genre_tags",
        "upcoming_events",
        "booking_info",
        "links",
      ]);
      expect(deps.repos.performerProfiles.getByOwner).toHaveBeenCalledWith({
        ownerType: "human",
        ownerId: ACTOR_ID,
      });
    });

    it("appends only the missing kinds and leaves an existing manual block untouched", async () => {
      const manual = {
        id: "manual-about",
        pageId: "page-1",
        kind: "about",
        orderIndex: 0,
        data: { heading: "Mine", content: "hand written" },
        visible: true,
      };
      const deps = makeSeedingDeps({
        page: {
          ...HUMAN_PAGE,
          templateAppliedCategories: [],
          category: null,
        },
        initialBlocks: [manual],
        performerEnabled: true,
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      // Manual "about" preserved verbatim, still first.
      expect(result.blocks[0]).toMatchObject({
        id: "manual-about",
        kind: "about",
        data: { heading: "Mine", content: "hand written" },
      });
      // "about" not duplicated.
      expect(result.blocks.filter((b) => b.kind === "about")).toHaveLength(1);
      // Missing kinds appended after the manual block (orderIndex 1+).
      expect(result.blocks.map((b) => b.kind)).toContain("music");
    });

    it("does not duplicate blocks when getMyPage is re-run", async () => {
      const deps = makeSeedingDeps({
        page: {
          ...HUMAN_PAGE,
          templateAppliedCategories: [],
          category: null,
        },
        initialBlocks: [],
        performerEnabled: true,
      });

      const first = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });
      const second = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(second.blocks.map((b) => b.kind)).toEqual(
        first.blocks.map((b) => b.kind),
      );
      // applyTemplateSeed only ran on the first load (2nd short-circuits on the
      // already-applied category).
      expect(deps.repos.entityPages.applyTemplateSeed).toHaveBeenCalledTimes(1);
    });

    function makeThrowingSeedDeps(
      reportError?: GetMyPageDeps["reportError"],
    ): { deps: GetMyPageDeps; seedError: Error } {
      const page = {
        ...HUMAN_PAGE,
        templateAppliedCategories: [],
        category: null,
      };
      const seedError = new Error("db exploded during seed");
      const base = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => page),
          getById: vi.fn(async () => page),
          listBlocks: vi.fn(async () => [VISIBLE_BLOCK]),
          getTheme: vi.fn(async () => null),
          applyTemplateSeed: vi.fn(async () => {
            throw seedError;
          }),
        },
        performerProfiles: {
          getByOwner: vi.fn(async () => ({
            enabledAt: new Date("2025-01-01"),
            disabledAt: null,
          })),
        },
      });
      return { deps: { ...base, reportError }, seedError };
    }

    it("does not fail the read when seeding throws, and reports to Sentry", async () => {
      const reportError = vi.fn();
      const { deps, seedError } = makeThrowingSeedDeps(reportError);

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      // Read still succeeds and returns the pre-seed blocks.
      expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
      // The swallowed seed failure is surfaced to the error tracker (a
      // logger.warn alone is NOT captured by Sentry).
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(seedError, {
        tags: { useCase: "getMyPage", step: "templateSeed" },
        extra: { pageId: "page-1", ownerType: "HUMAN" },
      });
    });

    it("a throwing reporter never breaks the read", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = makeThrowingSeedDeps(reportError);

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(result.blocks.map((b) => b.kind)).toEqual(["about"]);
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not report when seeding succeeds", async () => {
      const reportError = vi.fn();
      const base = makeSeedingDeps({
        page: {
          ...HUMAN_PAGE,
          templateAppliedCategories: [],
          category: null,
        },
        initialBlocks: [],
        performerEnabled: true,
      });

      await getMyPage(
        { ...base, reportError },
        { actorHumanId: ACTOR_ID, ownerType: "HUMAN", ownerId: ACTOR_ID },
      );

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  // ── Entity summary (editor preview parity with the public page) ───────────
  //
  // The editor renders the SAME block components as /p/[slug], and those branch
  // on `entity` — `entity.type === "PLACE"` picks the venue booking CTA over
  // the artist one, `placeAcceptsBookingRequests` (verified && accepting) gates
  // the request-to-book buttons. When getMyPage returned no entity the web
  // editor fabricated one with null geo, no `verified` and no
  // `acceptsBookingRequests`, so a VERIFIED booking-accepting venue previewed
  // as "not a venue". These tests pin the real fields.
  describe("entity summary", () => {
    const VERIFIED_PLACE = {
      id: "place-1",
      name: "The Roxy",
      formattedAddress: "9009 Sunset Blvd, West Hollywood, CA",
      city: "West Hollywood",
      region: "CA",
      lat: 34.09,
      lng: -118.39,
      capacity: 500,
      phone: "+13102782222",
      website: "https://theroxy.com",
      acceptsBookingRequests: true,
      verificationStatus: "VERIFIED",
      attendeeReviewsPublic: true,
      // See above: fail-closed means EXACT has to be said out loud.
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
    };

    const makePlaceDeps = (place: unknown) =>
      makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => ({
            ...HUMAN_PAGE,
            ownerType: "PLACE",
            ownerId: "place-1",
          })),
          listBlocks: vi.fn(async () => []),
          getTheme: vi.fn(async () => null),
        },
        places: { getById: vi.fn(async () => place) },
      });

    it("returns the real PLACE entity: verified, booking-accepting, with geo", async () => {
      const deps = makePlaceDeps(VERIFIED_PLACE);

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      });

      // Exactly the fields the fabricated preview entity was nulling out.
      expect(result.entity).toMatchObject({
        type: "PLACE",
        id: "place-1",
        name: "The Roxy",
        city: "West Hollywood",
        region: "CA",
        lat: 34.09,
        lng: -118.39,
        capacity: 500,
        phone: "+13102782222",
        website: "https://theroxy.com",
        acceptsBookingRequests: true,
        verified: true,
      });
    });

    it("derives verified=false from a non-VERIFIED status without leaking the raw status", async () => {
      const deps = makePlaceDeps({
        ...VERIFIED_PLACE,
        verificationStatus: "PENDING",
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      });

      expect(result.entity).toMatchObject({ verified: false });
      expect(result.entity).not.toHaveProperty("verificationStatus");
    });

    it("strips the server-internal attendeeReviewsPublic flag from the payload", async () => {
      const deps = makePlaceDeps(VERIFIED_PLACE);

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      });

      expect(result.entity).not.toHaveProperty("attendeeReviewsPublic");
    });

    it("returns a coherent ORGANIZATION entity, including the FR-009 booking gate", async () => {
      const deps = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => ({
            ...HUMAN_PAGE,
            ownerType: "ORGANIZATION",
            ownerId: "org-1",
          })),
          listBlocks: vi.fn(async () => []),
          getTheme: vi.fn(async () => null),
        },
        organizations: {
          getById: vi.fn(async () => ({
            id: "org-1",
            name: "Acme Events",
            slug: "acme-events",
            trustTier: "TRUSTED",
            trustBadgeLabel: "Trusted organizer",
          })),
        },
        performerProfiles: {
          getByOwner: vi.fn(async () => ({
            enabledAt: new Date("2025-01-01"),
            disabledAt: null,
            acceptsBookingRequests: true,
          })),
        },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
      });

      expect(result.entity).toEqual({
        type: "ORGANIZATION",
        id: "org-1",
        name: "Acme Events",
        slug: "acme-events",
        trustTier: "TRUSTED",
        trustBadgeLabel: "Trusted organizer",
        acceptsBookingRequests: true,
      });
      expect(deps.repos.performerProfiles.getByOwner).toHaveBeenCalledWith({
        ownerType: "organization",
        ownerId: "org-1",
      });
    });

    it("returns a coherent HUMAN entity with jobs and genre tags", async () => {
      const deps = makeDeps({
        performerProfiles: {
          getByOwner: vi.fn(async () => ({
            enabledAt: new Date("2025-01-01"),
            disabledAt: null,
            acceptsBookingRequests: true,
          })),
        },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
      });

      expect(result.entity).toEqual({
        type: "HUMAN",
        id: ACTOR_ID,
        name: "Alice",
        jobs: ["MUSICIAN"],
        genreTags: ["indie"],
        otherJobDescription: null,
        acceptsBookingRequests: true,
      });
    });

    it("degrades to entity:null (not a throw) when the owner row is missing", async () => {
      // The owner passed authz but their entity row is gone — a data-integrity
      // anomaly they cannot fix must not brick the editor. Contrast with
      // getPublicPage, which 404s the same state.
      const deps = makePlaceDeps(null);

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      });

      expect(result.entity).toBeNull();
      expect(result.page.id).toBe("page-1");
    });

    it("feeds location_map from the loaded entity without a second places read", async () => {
      const getById = vi.fn(async () => VERIFIED_PLACE);
      const deps = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => ({
            ...HUMAN_PAGE,
            ownerType: "PLACE",
            ownerId: "place-1",
          })),
          listBlocks: vi.fn(async () => [
            {
              id: "map-block",
              pageId: "page-1",
              kind: "location_map",
              orderIndex: 0,
              data: { heading: "Visit" },
              visible: true,
            },
          ]),
          getTheme: vi.fn(async () => null),
        },
        places: { getById },
      });

      const result = await getMyPage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
      });

      expect(result.blocks[0]?.data).toMatchObject({
        dataSource: "place",
        address: "9009 Sunset Blvd, West Hollywood, CA",
        lat: 34.09,
        lng: -118.39,
      });
      // One read total: the entity load. The derivation reuses it.
      expect(getById).toHaveBeenCalledTimes(1);
    });
  });
});

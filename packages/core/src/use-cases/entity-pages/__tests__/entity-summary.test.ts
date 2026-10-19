import { describe, expect, it, vi } from "vitest";

import { getMyPage } from "../get-my-page";
import type { GetMyPageDeps } from "../get-my-page";
import { getPublicPage } from "../get-public-page";
import type { GetPublicPageDeps } from "../get-public-page";
import { loadEntitySummary } from "../entity-summary";

// ─────────────────────────────────────────────────────────────────────────────
// PARITY: the editor's entity IS the public page's entity.
//
// This is the anti-fork guard. The editor renders the same block components as
// /p/[slug], and those components branch on the entity — so the moment the two
// surfaces answer "what is this entity" differently, the live preview starts
// lying (the symptom that motivated the shared loader: a VERIFIED,
// booking-accepting venue previewing with the ARTIST booking CTA and disabled
// request-to-book buttons). Each case below drives BOTH use cases over the
// SAME repo rows and asserts the two entities are deep-equal. A future change
// that shapes the entity in only one path fails here.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "human-1";

const BASE_PAGE = {
  id: "page-1",
  slug: "the-roxy",
  displayName: "The Roxy",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  allowFollows: true,
  showFollowerCount: false,
  category: "venue" as string | null,
  // Every default category pre-marked at its current revision so getMyPage's
  // lazy template seed is a no-op here (seeding is covered in get-my-page.test).
  templateAppliedCategories: ["generic", "performer", "musician", "venue@2"],
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

const PLACE_ROW = {
  id: "place-1",
  name: "The Roxy",
  slug: "the-roxy",
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
  // A public club that publishes its address. EXPLICIT, because
  // `redactPlaceLocation` fails closed: a fake that omits this is WITHHELD,
  // which is the direction a security default has to point.
  locationMode: "EXACT" as const,
  locationRadiusMeters: null,
  locationLabel: null,
};

const ORG_ROW = {
  id: "org-1",
  name: "Acme Events",
  slug: "acme-events",
  trustTier: "TRUSTED",
  trustBadgeLabel: "Trusted organizer",
};

const HUMAN_ROW = {
  id: ACTOR_ID,
  name: "Alice",
  jobs: ["MUSICIAN"],
  genreTags: ["indie"],
  otherJobDescription: null,
};

const ENABLED_PERFORMER_PROFILE = {
  enabledAt: new Date("2025-01-01"),
  disabledAt: null,
  acceptsBookingRequests: true,
};

type OwnerRows = {
  human?: unknown;
  organization?: unknown;
  place?: unknown;
  performerProfile?: unknown;
  /** Availability-onboarding FR-005: rows the PLACE branch counts. Default = configured. */
  availabilityRowCount?: number;
  /** Claim-state reads behind the PLACE `claimable` hint. Default = none. */
  verifiedOwnership?: unknown;
  activeClaim?: unknown;
};

function ownerRepos(rows: OwnerRows) {
  return {
    humans: { getById: vi.fn(async () => rows.human ?? null) } as any,
    organizations: {
      getById: vi.fn(async () => rows.organization ?? null),
    } as any,
    places: {
      getById: vi.fn(async () => rows.place ?? null),
      getVerifiedOwnershipForPlace: vi.fn(
        async () => rows.verifiedOwnership ?? null,
      ),
    } as any,
    placeVerificationRequests: {
      getActiveClaimForPlace: vi.fn(async () => rows.activeClaim ?? null),
    } as any,
    performerProfiles: {
      getByOwner: vi.fn(async () => rows.performerProfile ?? null),
    } as any,
    calendars: {
      countAvailabilityForPlace: vi.fn(
        async () => rows.availabilityRowCount ?? 1,
      ),
    } as any,
  };
}

function makePublicDeps(
  page: Record<string, unknown>,
  rows: OwnerRows,
): GetPublicPageDeps {
  const emptyPage = {
    items: [],
    pageInfo: {
      total: 0,
      limit: 8,
      offset: 0,
      count: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  };
  return {
    repos: {
      entityPages: {
        getBySlug: vi.fn(async () => page),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
      } as any,
      announcements: {
        listPublicForOrgEntityPage: vi.fn(async () => ({ items: [], total: 0 })),
        listPublicForSenderEntityPage: vi.fn(async () => ({
          items: [],
          total: 0,
        })),
      } as any,
      events: {
        listPublishedByPlace: vi.fn(async () => emptyPage),
        listPublishedByOrg: vi.fn(async () => emptyPage),
      } as any,
      eventHumans: { listPerformancesByHuman: vi.fn(async () => []) } as any,
      humanStats: { findByHumanId: vi.fn(async () => null) } as any,
      placeStats: { getByPlaceId: vi.fn(async () => null) } as any,
      reviewAggregates: { getBySubject: vi.fn(async () => null) } as any,
      // A PLACE page's community attribution (no moderator rows here).
      audit: { listForEntity: vi.fn(async () => []) } as any,
      ...ownerRepos(rows),
    },
  };
}

function makeEditorDeps(
  page: Record<string, unknown>,
  rows: OwnerRows,
): GetMyPageDeps {
  return {
    repos: {
      entityPages: {
        getByOwner: vi.fn(async () => page),
        listBlocks: vi.fn(async () => []),
        getTheme: vi.fn(async () => null),
        applyTemplateSeed: vi.fn(async () => []),
      } as any,
      authz: {} as any,
      announcements: {
        listByOrg: vi.fn(async () => ({ items: [], total: 0 })),
        listBySender: vi.fn(async () => ({ items: [], total: 0 })),
      } as any,
      eventHumans: { listPerformancesByHuman: vi.fn(async () => []) } as any,
      humanStats: { findByHumanId: vi.fn(async () => null) } as any,
      ...ownerRepos(rows),
    },
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(async () => {}),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(async () => ({ allowed: true })),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
  };
}

describe("entity summary parity: getMyPage vs getPublicPage", () => {
  const cases = [
    {
      label: "VERIFIED, booking-accepting PLACE",
      page: { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" },
      rows: { place: PLACE_ROW } satisfies OwnerRows,
      ownerType: "PLACE" as const,
      ownerId: "place-1",
    },
    {
      label: "claimable (ACTIVE, unverified, unowned) PLACE",
      page: { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" },
      rows: {
        place: {
          ...PLACE_ROW,
          status: "ACTIVE",
          verificationStatus: "UNVERIFIED",
        },
      } satisfies OwnerRows,
      ownerType: "PLACE" as const,
      ownerId: "place-1",
    },
    {
      label: "performer-enabled ORGANIZATION",
      page: {
        ...BASE_PAGE,
        ownerType: "ORGANIZATION" as const,
        ownerId: "org-1",
      },
      rows: {
        organization: ORG_ROW,
        performerProfile: ENABLED_PERFORMER_PROFILE,
      } satisfies OwnerRows,
      ownerType: "ORGANIZATION" as const,
      ownerId: "org-1",
    },
    {
      label: "performer-enabled HUMAN",
      page: { ...BASE_PAGE, ownerType: "HUMAN" as const, ownerId: ACTOR_ID },
      rows: {
        human: HUMAN_ROW,
        performerProfile: ENABLED_PERFORMER_PROFILE,
      } satisfies OwnerRows,
      ownerType: "HUMAN" as const,
      ownerId: ACTOR_ID,
    },
  ];

  for (const testCase of cases) {
    it(`serves an identical entity for a ${testCase.label}`, async () => {
      const publicResult = await getPublicPage(
        makePublicDeps(testCase.page, testCase.rows),
        { slug: testCase.page.slug },
      );
      const editorResult = await getMyPage(
        makeEditorDeps(testCase.page, testCase.rows),
        {
          actorHumanId: ACTOR_ID,
          ownerType: testCase.ownerType,
          ownerId: testCase.ownerId,
        },
      );

      expect(editorResult.entity).toEqual(publicResult.entity);
    });
  }

  it("agrees that a VERIFIED, opted-in venue accepts booking requests", async () => {
    // The exact assertion the editor preview used to get wrong: both surfaces
    // must satisfy `placeAcceptsBookingRequests` (verified && accepting), which
    // is what gates the venue booking CTA and the request-to-book buttons.
    const page = { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" };
    const rows = { place: PLACE_ROW };

    const publicResult = await getPublicPage(makePublicDeps(page, rows), {
      slug: page.slug,
    });
    const editorResult = await getMyPage(makeEditorDeps(page, rows), {
      actorHumanId: ACTOR_ID,
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    for (const entity of [publicResult.entity, editorResult.entity]) {
      expect(entity).toMatchObject({
        type: "PLACE",
        verified: true,
        acceptsBookingRequests: true,
        city: "West Hollywood",
        region: "CA",
        lat: 34.09,
        lng: -118.39,
        website: "https://theroxy.com",
      });
    }
  });

  it("agrees an UNCONFIGURED venue (zero availability rows) does NOT accept requests", async () => {
    // Availability-onboarding FR-005: hours-less venues are publicly "not
    // taking requests right now". Folded in the SHARED loader, so the editor
    // preview and the public page make the same call — and both match the
    // create mutations' `booking_requests_unconfigured` refusal.
    const page = { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" };
    const rows = { place: PLACE_ROW, availabilityRowCount: 0 };

    const publicResult = await getPublicPage(makePublicDeps(page, rows), {
      slug: page.slug,
    });
    const editorResult = await getMyPage(makeEditorDeps(page, rows), {
      actorHumanId: ACTOR_ID,
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    for (const entity of [publicResult.entity, editorResult.entity]) {
      expect(entity).toMatchObject({
        type: "PLACE",
        verified: true,
        // The toggle is ON in the row — the projection still reads false.
        acceptsBookingRequests: false,
      });
    }
  });

  it("diverges ONLY on the missing-owner policy: public 404s, editor returns null", async () => {
    const page = { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" };
    const rows = {}; // no place row

    await expect(
      getPublicPage(makePublicDeps(page, rows), { slug: page.slug }),
    ).rejects.toMatchObject({ code: "OWNER_NOT_FOUND" });

    const editorResult = await getMyPage(makeEditorDeps(page, rows), {
      actorHumanId: ACTOR_ID,
      ownerType: "PLACE",
      ownerId: "place-1",
    });
    expect(editorResult.entity).toBeNull();
  });
});

describe("loadEntitySummary", () => {
  it("throws for an unrecognised owner type (code defect, not a missing row)", async () => {
    await expect(
      loadEntitySummary(
        { repos: ownerRepos({}) as any },
        "SPACESHIP",
        "whatever",
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_OWNER_TYPE" });
  });

  it("returns null — never throws — when the owner row is absent", async () => {
    const deps = { repos: ownerRepos({}) as any };
    await expect(loadEntitySummary(deps, "HUMAN", "h")).resolves.toBeNull();
    await expect(
      loadEntitySummary(deps, "ORGANIZATION", "o"),
    ).resolves.toBeNull();
    await expect(loadEntitySummary(deps, "PLACE", "p")).resolves.toBeNull();
  });

  it("propagates a repo failure instead of masking it as a missing row", async () => {
    const boom = new Error("db down");
    const deps = {
      repos: {
        ...ownerRepos({}),
        places: {
          getById: vi.fn(async () => {
            throw boom;
          }),
        } as any,
      },
    };

    await expect(loadEntitySummary(deps, "PLACE", "place-1")).rejects.toBe(boom);
  });
});

// A withheld venue's PHONE is withheld with its address: a home venue's number
// is very often a personal line, and a reverse lookup returns the street.
describe("loadEntitySummary — PLACE phone follows the address", () => {
  it("publishes the phone of a venue that publishes its address", async () => {
    const summary = await loadEntitySummary(
      { repos: ownerRepos({ place: PLACE_ROW }) as any },
      "PLACE",
      "place-1",
    );
    expect(summary).toMatchObject({ type: "PLACE", phone: "+13102782222" });
  });

  it.each([
    ["an obscuring circle", 800],
    ["fully hidden", null],
  ])("nulls the phone of a withheld venue (%s)", async (_label, radius) => {
    const summary = await loadEntitySummary(
      {
        repos: ownerRepos({
          place: {
            ...PLACE_ROW,
            locationMode: "OBSCURED",
            locationRadiusMeters: radius,
          },
        }) as any,
      },
      "PLACE",
      "place-1",
    );
    expect(summary).toMatchObject({ type: "PLACE", phone: null });
    expect(JSON.stringify(summary)).not.toContain("3102782222");
    // Website is a public URL, not a location proxy — it stays.
    expect(summary).toMatchObject({ website: "https://theroxy.com" });
  });

  it("a row with NO mode (fail-closed default) is withheld — phone included", async () => {
    const { locationMode: _omit, ...noMode } = PLACE_ROW;
    const summary = await loadEntitySummary(
      { repos: ownerRepos({ place: noMode }) as any },
      "PLACE",
      "place-1",
    );
    expect(summary).toMatchObject({ phone: null });
  });
});

// ── The `claimable` hint ────────────────────────────────────────────────────
// The hero "Claim this place" chip renders from this flag until the client
// eligibility query answers, so it must say exactly what that query will say.
// `!verified` did not: an UNVERIFIED place with a verified owner, a PENDING
// place and a place with a claim in review all read as claimable and the chip
// flashed in and out.
describe("loadEntitySummary — PLACE claimable follows getPlaceClaimEligibility", () => {
  const ACTIVE_UNVERIFIED = {
    ...PLACE_ROW,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
  };

  const load = async (rows: OwnerRows) =>
    loadEntitySummary({ repos: ownerRepos(rows) as any }, "PLACE", "place-1");

  it("is true for an ACTIVE, unverified place with no owner and no claim", async () => {
    expect(await load({ place: ACTIVE_UNVERIFIED })).toMatchObject({
      claimable: true,
      verified: false,
    });
  });

  it("is true for a REJECTED place (a fresh claim is allowed)", async () => {
    expect(
      await load({
        place: { ...ACTIVE_UNVERIFIED, verificationStatus: "REJECTED" },
      }),
    ).toMatchObject({ claimable: true });
  });

  it.each<[string, OwnerRows]>([
    [
      "VERIFIED",
      { place: { ...ACTIVE_UNVERIFIED, verificationStatus: "VERIFIED" } },
    ],
    [
      "UNVERIFIED with a verified owner",
      {
        place: ACTIVE_UNVERIFIED,
        verifiedOwnership: { id: "own-1", ownerType: "HUMAN", ownerId: "h" },
      },
    ],
    [
      "PENDING status",
      { place: { ...ACTIVE_UNVERIFIED, verificationStatus: "PENDING" } },
    ],
    [
      "a claim in review",
      { place: ACTIVE_UNVERIFIED, activeClaim: { id: "req-1" } },
    ],
    ["ARCHIVED", { place: { ...ACTIVE_UNVERIFIED, status: "ARCHIVED" } }],
    ["SUSPENDED", { place: { ...ACTIVE_UNVERIFIED, status: "SUSPENDED" } }],
  ])("is false for %s", async (_label, rows) => {
    expect(await load(rows)).toMatchObject({ claimable: false });
  });

  it("survives the public schema parse and reaches the page payload", async () => {
    const result = await getPublicPage(
      makePublicDeps(
        { ...BASE_PAGE, ownerType: "PLACE" as const, ownerId: "place-1" },
        { place: ACTIVE_UNVERIFIED }),
      { slug: "the-roxy" },
    );
    expect(result.entity).toMatchObject({ type: "PLACE", claimable: true });
  });

  it("propagates a claim-state read failure instead of guessing", async () => {
    const boom = new Error("db down");
    const repos = ownerRepos({ place: ACTIVE_UNVERIFIED });
    repos.placeVerificationRequests.getActiveClaimForPlace = vi.fn(
      async () => {
        throw boom;
      },
    );
    await expect(
      loadEntitySummary({ repos } as any, "PLACE", "place-1"),
    ).rejects.toBe(boom);
  });
});

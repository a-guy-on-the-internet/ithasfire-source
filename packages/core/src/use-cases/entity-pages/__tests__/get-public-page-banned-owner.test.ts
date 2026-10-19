import { describe, expect, it, vi } from "vitest";

import { getPublicPage } from "../get-public-page";
import type { GetPublicPageDeps } from "../get-public-page";

// Ban that sticks (2026-09-29): a banned owner's public page answers exactly
// like a missing page. `ownerBanned` is DERIVED by the entity-pages adapter at
// read time (`getBySlug`); nothing is stored, so the same page comes back the
// moment the flag reads false again (reactivation).

const PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: "human-1",
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  allowFollows: true,
  showFollowerCount: false,
  category: null,
  templateAppliedCategories: [],
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-01"),
};

const EMPTY_PAGE_INFO = {
  total: 0,
  limit: 8,
  offset: 0,
  count: 0,
  hasNextPage: false,
  nextOffset: null,
};

function makeDeps(page: Record<string, unknown>) {
  const listPublishedByPlace = vi.fn(async () => ({
    items: [],
    pageInfo: EMPTY_PAGE_INFO,
  }));
  const deps = {
    repos: {
      entityPages: {
        getBySlug: vi.fn(async () => page),
        listBlocks: vi.fn(async () => [
          {
            id: "b1",
            pageId: page.id,
            kind: "upcoming_events",
            orderIndex: 0,
            data: {},
            visible: true,
            section: "main",
          },
        ]),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
      },
      humans: {
        getById: vi.fn(async () => ({ id: "human-1", name: "Alice" })),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: "org-1",
          name: "Acme",
          slug: "acme",
        })),
      },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "The Room",
          orgIdsWithAccess: [],
          humanIdsWithAccess: [],
          acceptsCommunityListings: false,
        })),
      },
      calendars: { countAvailabilityForPlace: vi.fn(async () => 1) },
      announcements: {},
      events: {
        listPublishedByPlace,
        listPublishedByOrg: vi.fn(async () => ({
          items: [],
          pageInfo: EMPTY_PAGE_INFO,
        })),
      },
      eventHumans: { listPerformancesByHuman: vi.fn(async () => []) },
      humanStats: { findByHumanId: vi.fn(async () => null) },
      placeStats: { getByPlaceId: vi.fn(async () => null) },
      reviewAggregates: { getBySubject: vi.fn(async () => null) },
      performerProfiles: { getByOwner: vi.fn(async () => null) },
      // A PLACE page's community attribution (no moderator rows here).
      audit: { listForEntity: vi.fn(async () => []) },
    },
  } as unknown as GetPublicPageDeps;
  return { deps, listPublishedByPlace };
}

describe("getPublicPage — banned owners", () => {
  it.each([
    ["a BANNED human's page", { ...PAGE }],
    [
      "the page of an org whose every OWNER is banned",
      { ...PAGE, ownerType: "ORGANIZATION", ownerId: "org-1", slug: "acme" },
    ],
  ])("404s %s like a missing page", async (_label, page) => {
    const { deps } = makeDeps({ ...page, ownerBanned: true });
    await expect(
      getPublicPage(deps, { slug: page.slug }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
    // Nothing about the page is loaded once it is known to be withheld.
    expect(deps.repos.entityPages.listBlocks).not.toHaveBeenCalled();
  });

  it("serves the same page once the owner is reactivated (flag reads false)", async () => {
    const { deps } = makeDeps({ ...PAGE, ownerBanned: false });
    const result = await getPublicPage(deps, { slug: "alice" });
    expect(result.page.slug).toBe("alice");
    // The derived flag is not part of the public payload.
    expect(result.page).not.toHaveProperty("ownerBanned");
  });

  it("a venue page asks for its upcoming events WITHOUT banned owners' events", async () => {
    const { deps, listPublishedByPlace } = makeDeps({
      ...PAGE,
      ownerType: "PLACE",
      ownerId: "place-1",
      slug: "the-room",
      ownerBanned: false,
    });
    await getPublicPage(deps, { slug: "the-room" });
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "upcoming",
        excludeBannedOwners: true,
      }),
    );
  });
});

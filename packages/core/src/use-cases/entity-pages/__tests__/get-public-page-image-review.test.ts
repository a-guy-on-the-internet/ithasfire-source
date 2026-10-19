/**
 * getPublicPage runs the page image review gate (moderator place page spec
 * R5): a community moderator's image that is not yet APPROVED is absent from
 * the public payload (and so from the OG tags built from it); an approved one
 * and an owner upload with no record are served. One batched lookup.
 */

import { describe, expect, it, vi } from "vitest";

import { getPublicPage } from "../get-public-page";
import type { GetPublicPageDeps } from "../get-public-page";

const CDN = "https://cdn.example";
const PREFIX = "entity-pages/place/place-1/2026-10-16/";
const APPROVED = `${PREFIX}${"a".repeat(32)}.jpg`;
const PENDING = `${PREFIX}${"b".repeat(32)}.jpg`;
const OWNER_UPLOAD = `${PREFIX}${"c".repeat(32)}.jpg`;

const PLACE_PAGE = {
  id: "page-1",
  ownerType: "PLACE" as const,
  ownerId: "place-1",
  slug: "the-room",
  displayName: null,
  bio: null,
  avatarUrl: `${CDN}/${PENDING}`,
  bannerUrl: `${CDN}/${OWNER_UPLOAD}`,
  visibility: "PUBLIC" as const,
  allowFollows: true,
  showFollowerCount: false,
  category: "venue",
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

function makeDeps() {
  const resolveByKeys = vi.fn(async (keys: string[]) => {
    const statuses: Record<string, string> = {
      [APPROVED]: "APPROVED",
      [PENDING]: "PENDING",
    };
    return new Map(
      keys.filter((k) => statuses[k]).map((k) => [k, { status: statuses[k] }]),
    );
  });
  const deps = {
    repos: {
      entityPages: {
        getBySlug: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => [
          {
            id: "b-photos",
            pageId: "page-1",
            kind: "photos",
            orderIndex: 0,
            data: {
              photos: [
                { url: `${CDN}/${APPROVED}`, alt: "bar" },
                { url: `${CDN}/${PENDING}`, alt: "stage" },
              ],
            },
            visible: true,
            section: "main",
          },
        ]),
        getTheme: vi.fn(async () => null),
        resolveSlugHistory: vi.fn(async () => null),
      },
      humans: { getById: vi.fn(async () => null) },
      organizations: { getById: vi.fn(async () => null) },
      places: {
        getById: vi.fn(async () => ({
          id: "place-1",
          name: "The Room",
          orgIdsWithAccess: [],
          humanIdsWithAccess: [],
          acceptsCommunityListings: false,
        })),
        getVerifiedOwnershipForPlace: vi.fn(async () => null),
      },
      placeVerificationRequests: {
        getActiveClaimForPlace: vi.fn(async () => null),
      },
      calendars: { countAvailabilityForPlace: vi.fn(async () => 1) },
      announcements: {},
      events: {
        listPublishedByPlace: vi.fn(async () => ({
          items: [],
          pageInfo: EMPTY_PAGE_INFO,
        })),
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
      audit: { listForEntity: vi.fn(async () => []) },
      imageModerationRecords: { resolveByKeys },
    },
  } as unknown as GetPublicPageDeps;
  return { deps, resolveByKeys };
}

describe("getPublicPage — image review gate", () => {
  it("serves approved and record-less images, and leaves a pending one out", async () => {
    const { deps, resolveByKeys } = makeDeps();
    const result = await getPublicPage(deps, { slug: "the-room" });

    expect(resolveByKeys).toHaveBeenCalledTimes(1);
    expect(result.page.avatarUrl).toBeNull();
    expect(result.page.bannerUrl).toBe(`${CDN}/${OWNER_UPLOAD}`);
    const photos = result.blocks.find((b) => b.id === "b-photos");
    expect(photos?.data).toEqual({
      photos: [{ url: `${CDN}/${APPROVED}`, alt: "bar" }],
    });
    expect(JSON.stringify(result)).not.toContain(PENDING);
  });
});

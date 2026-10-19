/**
 * getPublicPage's `communityAttribution` (moderator place page spec,
 * docs/specs/2026-10-14/moderator-place-page.spec.yaml, FR-006, D6 / D7):
 * DERIVED from the page's audit rows on every read, PLACE pages only.
 */

import { describe, expect, it, vi } from "vitest";

import {
  COMMUNITY_SEED_TEMPLATE_OP,
  ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
} from "../community-handover-state";
import { ENTITY_PAGE_COMMUNITY_UPDATED_ACTION } from "../entity-page-access";
import { getPublicPage } from "../get-public-page";
import type { GetPublicPageDeps } from "../get-public-page";

const T1 = new Date("2026-10-14T10:00:00.000Z");
const T2 = new Date("2026-10-14T11:00:00.000Z");
const T3 = new Date("2026-10-14T12:00:00.000Z");

const PLACE_PAGE = {
  id: "page-1",
  ownerType: "PLACE" as const,
  ownerId: "place-1",
  slug: "the-room",
  displayName: null,
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
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

type Row = { entityId: string; action: string; at: Date; op?: string };

function makeDeps(page: Record<string, unknown>, rows: Row[]) {
  const listForEntity = vi.fn(
    async (input: {
      entity: string;
      entityId: string;
      actions: readonly string[];
      after?: Date | null;
      limit: number;
    }) =>
      rows
        .filter(
          (row) =>
            input.entity === "entity_page" &&
            row.entityId === input.entityId &&
            input.actions.includes(row.action) &&
            (!input.after || row.at > input.after),
        )
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, input.limit)
        .map((row, index) => ({
          id: `audit-${index}`,
          entity: "entity_page",
          entityId: row.entityId,
          action: row.action,
          data: row.op ? { op: row.op } : {},
          actorHumanId: "human-moderator",
          at: row.at,
        })),
  );
  const deps = {
    repos: {
      entityPages: {
        getBySlug: vi.fn(async () => page),
        listBlocks: vi.fn(async () => []),
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
          trustTier: "STANDARD",
          trustBadgeLabel: "",
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
      audit: { listForEntity },
    },
  } as unknown as GetPublicPageDeps;
  return { deps, listForEntity };
}

const updated = (at: Date, entityId = "page-1"): Row => ({
  entityId,
  action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
  at,
});
const handover = (at: Date): Row => ({
  entityId: "page-1",
  action: ENTITY_PAGE_COMMUNITY_HANDOVER_ACTION,
  at,
});

describe("getPublicPage — community attribution", () => {
  it("is present after a moderator write, dated by the newest", async () => {
    const { deps } = makeDeps(PLACE_PAGE, [updated(T1), updated(T2)]);
    const result = await getPublicPage(deps, { slug: "the-room" });
    expect(result.communityAttribution).toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: T2.toISOString(),
    });
  });

  it("is null after the owner's handover", async () => {
    const { deps } = makeDeps(PLACE_PAGE, [updated(T1), handover(T2)]);
    const result = await getPublicPage(deps, { slug: "the-room" });
    expect(result.communityAttribution).toBeNull();
  });

  it("is present again after a moderator write later than the handover", async () => {
    const { deps } = makeDeps(PLACE_PAGE, [
      updated(T1),
      handover(T2),
      updated(T3),
    ]);
    const result = await getPublicPage(deps, { slug: "the-room" });
    expect(result.communityAttribution).toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt: T3.toISOString(),
    });
  });

  it("ignores template-seed rows: seed-only is null, seed after a write keeps the write's date", async () => {
    const seed = { ...updated(T2), op: COMMUNITY_SEED_TEMPLATE_OP };
    const only = makeDeps(PLACE_PAGE, [seed]);
    expect(
      (await getPublicPage(only.deps, { slug: "the-room" })).communityAttribution,
    ).toBeNull();
    const both = makeDeps(PLACE_PAGE, [updated(T1), seed]);
    expect(
      (await getPublicPage(both.deps, { slug: "the-room" })).communityAttribution,
    ).toEqual({ maintainedByCommunity: true, lastUpdatedAt: T1.toISOString() });
    const afterHandover = makeDeps(PLACE_PAGE, [
      updated(T1),
      handover(T2),
      { ...updated(T3), op: COMMUNITY_SEED_TEMPLATE_OP },
    ]);
    expect(
      (await getPublicPage(afterHandover.deps, { slug: "the-room" }))
        .communityAttribution,
    ).toBeNull();
  });

  it("is null for a page nobody but its owner wrote (and ignores other pages' rows)", async () => {
    const { deps } = makeDeps(PLACE_PAGE, [updated(T1, "page-other")]);
    const result = await getPublicPage(deps, { slug: "the-room" });
    expect(result.communityAttribution).toBeNull();
  });

  it.each([
    ["HUMAN", { ownerType: "HUMAN", ownerId: "human-1", slug: "alice" }],
    [
      "ORGANIZATION",
      { ownerType: "ORGANIZATION", ownerId: "org-1", slug: "acme" },
    ],
  ])("is null for a %s page without reading the audit log", async (_t, owner) => {
    const { deps, listForEntity } = makeDeps({ ...PLACE_PAGE, ...owner }, [
      updated(T1),
    ]);
    const result = await getPublicPage(deps, { slug: owner.slug });
    expect(result.communityAttribution).toBeNull();
    expect(listForEntity).not.toHaveBeenCalled();
  });

  it("a failed audit read fails the render (never shown as the place's own)", async () => {
    const { deps, listForEntity } = makeDeps(PLACE_PAGE, []);
    listForEntity.mockRejectedValueOnce(new Error("db down"));
    await expect(getPublicPage(deps, { slug: "the-room" })).rejects.toThrow(
      "db down",
    );
  });
});

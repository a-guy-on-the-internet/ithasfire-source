import { describe, expect, it, vi } from "vitest";

import { listFeaturedAdminItems } from "../list-featured-admin-items";
import type { ListFeaturedAdminItemsDeps } from "../list-featured-admin-items";
import type { FeaturedItemRecord } from "@th/types/repos/featured-items";

const NOW = new Date("2026-04-12T12:00:00Z");

function makeFeaturedItem(
  overrides: Partial<FeaturedItemRecord> = {},
): FeaturedItemRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    itemType: "EVENT",
    itemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Featured Event",
    subtitle: null,
    heroImageUrl: null,
    ctaUrl: null,
    ctaLabel: null,
    sortOrder: 0,
    active: true,
    curatedByHumanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    curatedAt: NOW,
    curatedUntil: null,
    notes: null,
    ...overrides,
  };
}

function buildDeps(result: {
  items: FeaturedItemRecord[];
  total: number;
}): ListFeaturedAdminItemsDeps {
  return {
    repos: {
      featuredItems: {
        listAll: vi.fn(async () => result),
      },
    } as unknown as ListFeaturedAdminItemsDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    },
  };
}

describe("listFeaturedAdminItems", () => {
  it("returns inactive and expired items for staff management", async () => {
    const deps = buildDeps({
      items: [
        makeFeaturedItem({ active: false }),
        makeFeaturedItem({
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          curatedUntil: new Date("2026-04-01T00:00:00Z"),
        }),
      ],
      total: 2,
    });

    const result = await listFeaturedAdminItems(deps, {
      actorHumanId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.active).toBe(false);
    expect(result.items[1]?.curatedUntil?.toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(deps.repos.featuredItems.listAll).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
    });
  });
});

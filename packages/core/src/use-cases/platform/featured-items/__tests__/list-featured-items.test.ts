import { describe, expect, it, vi } from "vitest";

import { listFeaturedItems } from "../list-featured-items";
import type { ListFeaturedItemsDeps } from "../list-featured-items";
import type { FeaturedItemRecord } from "@th/types/repos/featured-items";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

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

function buildDeps(
  items: FeaturedItemRecord[] = [],
  banned: { humanIds: string[]; orgIds: string[] } = {
    humanIds: [],
    orgIds: [],
  },
): ListFeaturedItemsDeps {
  return {
    repos: {
      bans: {
        findBannedOwners: vi.fn(
          async (input: { humanIds: string[]; orgIds: string[] }) => ({
            humanIds: input.humanIds.filter((id) =>
              banned.humanIds.includes(id),
            ),
            orgIds: input.orgIds.filter((id) => banned.orgIds.includes(id)),
          }),
        ),
      },
      featuredItems: {
        listActive: vi.fn(async () => items),
      },
      events: {
        getById: vi.fn(async () => ({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          status: "PUBLISHED",
          visibility: "PUBLIC",
          slug: "featured-event",
        })),
      },
      entityPages: {
        getByOwner: vi.fn(async () => ({
          id: "page-1",
          ownerType: "HUMAN",
          ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          slug: "featured-owner",
          displayName: "Featured Owner",
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
          visibility: "PUBLIC",
          createdAt: NOW,
          updatedAt: NOW,
        })),
      },
    } as unknown as ListFeaturedItemsDeps["repos"],
    clock: { now: () => NOW },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listFeaturedItems", () => {
  it("returns active items", async () => {
    const items = [
      makeFeaturedItem(),
      makeFeaturedItem({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        itemType: "PLACE",
      }),
    ];
    const deps = buildDeps(items);

    const result = await listFeaturedItems(deps, { limit: 20 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).not.toHaveProperty("curatedByHumanId");
    expect(result.items[0]).not.toHaveProperty("notes");
    expect(deps.repos.featuredItems.listActive).toHaveBeenCalledWith({
      now: NOW,
      limit: 20,
      itemType: null,
    });
  });

  it("respects itemType filter", async () => {
    const deps = buildDeps([makeFeaturedItem({ itemType: "HUMAN" })]);

    const result = await listFeaturedItems(deps, {
      limit: 10,
      itemType: "HUMAN",
    });

    expect(result.items).toHaveLength(1);
    expect(deps.repos.featuredItems.listActive).toHaveBeenCalledWith({
      now: NOW,
      limit: 10,
      itemType: "HUMAN",
    });
  });

  it("strips unsafe hero and CTA URLs from public output", async () => {
    const deps = buildDeps([
      makeFeaturedItem({
        heroImageUrl: "https://cdn.example.com/hero.jpg",
        ctaUrl: "javascript:alert(1)",
      }),
    ]);

    const result = await listFeaturedItems(deps, { limit: 5 });

    expect(result.items[0]?.heroImageUrl).toBeNull();
    expect(result.items[0]?.ctaUrl).toBeNull();
  });

  it("hides non-public featured targets from public output", async () => {
    const deps = buildDeps([makeFeaturedItem({ itemType: "HUMAN" })]);
    (
      deps.repos.entityPages.getByOwner as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "page-1",
      ownerType: "HUMAN",
      ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      slug: "featured-owner",
      displayName: "Featured Owner",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PRIVATE",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await listFeaturedItems(deps, { limit: 5 });

    expect(result.items).toHaveLength(0);
  });

  it("respects limit", async () => {
    const deps = buildDeps([]);

    await listFeaturedItems(deps, { limit: 5 });

    expect(deps.repos.featuredItems.listActive).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("defaults limit to 20", async () => {
    const deps = buildDeps([]);

    await listFeaturedItems(deps, {});

    expect(deps.repos.featuredItems.listActive).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("rejects invalid input", async () => {
    const deps = buildDeps([]);

    await expect(listFeaturedItems(deps, { limit: -1 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  // Ban that sticks (review round 1): featured HUMAN / ORG cards for a
  // withheld owner drop off the rail; everything else stays.
  it("drops featured HUMAN and ORGANIZATION cards whose owner is withheld", async () => {
    const bannedHuman = makeFeaturedItem({
      id: "11111111-1111-4111-8111-111111111111",
      itemType: "HUMAN",
      itemId: "a1111111-1111-4111-8111-111111111111",
    });
    const bannedOrg = makeFeaturedItem({
      id: "22222222-2222-4222-8222-222222222222",
      itemType: "ORGANIZATION",
      itemId: "a2222222-2222-4222-8222-222222222222",
    });
    const liveOrg = makeFeaturedItem({
      id: "33333333-3333-4333-8333-333333333333",
      itemType: "ORGANIZATION",
      itemId: "a3333333-3333-4333-8333-333333333333",
    });
    const event = makeFeaturedItem();
    const deps = buildDeps([bannedHuman, bannedOrg, liveOrg, event], {
      humanIds: [bannedHuman.itemId],
      orgIds: [bannedOrg.itemId],
    });

    const result = await listFeaturedItems(deps, {});

    expect(result.items.map((i) => i.id)).toEqual([liveOrg.id, event.id]);
    expect(deps.repos.bans.findBannedOwners).toHaveBeenCalledWith({
      humanIds: [bannedHuman.itemId],
      orgIds: [bannedOrg.itemId, liveOrg.itemId],
    });
  });

  it("drops a featured EVENT whose owner is banned (standing requested)", async () => {
    const deps = buildDeps([makeFeaturedItem()]);
    (deps.repos.events.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "PUBLISHED",
      visibility: "PUBLIC",
      slug: "featured-event",
      ownerBanned: true,
    });
    const result = await listFeaturedItems(deps, {});
    expect(result.items).toEqual([]);
    expect(deps.repos.events.getById).toHaveBeenCalledWith(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      { withOwnerStanding: true },
    );
  });
});

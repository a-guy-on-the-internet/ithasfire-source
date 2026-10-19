import { describe, expect, it, vi } from "vitest";

import { upsertFeaturedItem } from "../upsert-featured-item";
import type { UpsertFeaturedItemDeps } from "../upsert-featured-item";
import type { FeaturedItemRecord } from "@th/types/repos/featured-items";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-12T12:00:00Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

function makeFeaturedItem(
  overrides: Partial<FeaturedItemRecord> = {},
): FeaturedItemRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    itemType: "EVENT",
    itemId: ITEM_ID,
    title: "Some Event",
    subtitle: null,
    heroImageUrl: null,
    ctaUrl: null,
    ctaLabel: null,
    sortOrder: 0,
    active: true,
    curatedByHumanId: ACTOR_ID,
    curatedAt: NOW,
    curatedUntil: null,
    notes: null,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    allowed?: boolean;
    upsertResult?: FeaturedItemRecord;
    eventExists?: boolean;
    eventPublic?: boolean;
    pageVisibility?: "PUBLIC" | "PRIVATE" | "UNLISTED" | null;
  } = {},
): UpsertFeaturedItemDeps {
  const allowed = overrides.allowed ?? true;
  const upsertResult = overrides.upsertResult ?? makeFeaturedItem();
  const eventExists = overrides.eventExists ?? true;
  const eventPublic = overrides.eventPublic ?? true;
  const pageVisibility =
    overrides.pageVisibility === undefined
      ? "PUBLIC"
      : overrides.pageVisibility;

  const featuredItems = {
    upsert: vi.fn(async () => upsertResult),
  };
  const audit = {
    log: vi.fn(),
  };

  return {
    repos: {
      featuredItems,
      audit,
      events: {
        getById: vi.fn(async () => {
          if (!eventExists) return null;
          return {
            id: ITEM_ID,
            status: eventPublic ? "PUBLISHED" : "DRAFT",
            visibility: eventPublic ? "PUBLIC" : "PRIVATE",
            slug: eventPublic ? "featured-event" : null,
          };
        }),
      },
      humans: {
        getById: vi.fn(async () => ({ id: ITEM_ID, status: "ACTIVE" })),
      },
      organizations: {
        getById: vi.fn(async () => ({
          id: ITEM_ID,
          status: "ACTIVE",
          slug: "featured-org",
        })),
      },
      places: {
        getById: vi.fn(async () => ({
          id: ITEM_ID,
          status: "ACTIVE",
          listedInDirectory: true,
          slug: "featured-place",
        })),
      },
      entityPages: {
        getByOwner: vi.fn(async () => {
          if (pageVisibility === null) return null;
          return {
            id: "page-1",
            ownerType: "HUMAN",
            ownerId: ITEM_ID,
            slug: "featured-human",
            displayName: "Featured Human",
            bio: null,
            avatarUrl: null,
            bannerUrl: null,
            visibility: pageVisibility,
            createdAt: NOW,
            updatedAt: NOW,
          };
        }),
      },
      tx: vi.fn(async (fn: any) => fn({ featuredItems, audit })),
    } as unknown as UpsertFeaturedItemDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as UpsertFeaturedItemDeps["authz"],
    clock: { now: () => NOW },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertFeaturedItem", () => {
  it("creates a featured item (happy path)", async () => {
    const deps = buildDeps();

    const result = await upsertFeaturedItem(deps, {
      actorHumanId: ACTOR_ID,
      itemType: "EVENT",
      itemId: ITEM_ID,
      title: "Some Event",
    });

    expect(result.item.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result.item.itemType).toBe("EVENT");
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect((deps.repos as any).featuredItems.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: "EVENT",
        itemId: ITEM_ID,
        curatedByHumanId: ACTOR_ID,
        curatedAt: NOW,
      }),
    );
    expect((deps.repos as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "FeaturedItem",
        action: "featured_item.upsert",
      }),
    );
  });

  it("updates an existing featured item", async () => {
    const updated = makeFeaturedItem({ title: "Updated Title", sortOrder: 5 });
    const deps = buildDeps({ upsertResult: updated });

    const result = await upsertFeaturedItem(deps, {
      actorHumanId: ACTOR_ID,
      itemType: "EVENT",
      itemId: ITEM_ID,
      title: "Updated Title",
      sortOrder: 5,
    });

    expect(result.item.title).toBe("Updated Title");
    expect(result.item.sortOrder).toBe(5);
  });

  it("throws forbidden for non-staff actors", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "EVENT",
        itemId: ITEM_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("rejects invalid itemId", async () => {
    const deps = buildDeps();

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "EVENT",
        itemId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects external hero images and CTA links", async () => {
    const deps = buildDeps();

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "EVENT",
        itemId: ITEM_ID,
        heroImageUrl: "https://cdn.example.com/hero.jpg",
        ctaUrl: "https://example.com/offsite",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects missing featured targets", async () => {
    const deps = buildDeps({ eventExists: false });

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "EVENT",
        itemId: ITEM_ID,
        title: "Some Event",
      }),
    ).rejects.toMatchObject({ code: "FEATURED_ITEM_TARGET_NOT_FOUND" });
  });

  it("rejects non-event targets without a public page", async () => {
    const deps = buildDeps({ pageVisibility: null });

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "HUMAN",
        itemId: ITEM_ID,
        title: "Featured Human",
      }),
    ).rejects.toMatchObject({ code: "FEATURED_ITEM_TARGET_NOT_PUBLIC" });
  });

  it("rejects unlisted non-event targets", async () => {
    const deps = buildDeps({ pageVisibility: "UNLISTED" });

    await expect(
      upsertFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "HUMAN",
        itemId: ITEM_ID,
        title: "Featured Human",
      }),
    ).rejects.toMatchObject({ code: "FEATURED_ITEM_TARGET_NOT_PUBLIC" });
  });
});

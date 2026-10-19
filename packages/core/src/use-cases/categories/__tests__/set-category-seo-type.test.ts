import { describe, expect, it, vi } from "vitest";

import { setCategorySeoType } from "../set-category-seo-type";
import type { SetCategorySeoTypeDeps } from "../set-category-seo-type";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FIXED_NOW = new Date("2026-07-15T12:00:00Z");

function makeCategoryFixture(
  overrides: Partial<{
    id: string;
    slug: string;
    name: string;
    active: boolean;
    sortOrder: number;
    seoType: string;
  }> = {},
) {
  return {
    id: overrides.id ?? CATEGORY_ID,
    slug: overrides.slug ?? "music",
    name: overrides.name ?? "Music",
    active: overrides.active ?? true,
    sortOrder: overrides.sortOrder ?? 1,
    seoType: overrides.seoType ?? "Event",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function buildDeps(
  overrides: {
    allowed?: boolean;
    existing?: ReturnType<typeof makeCategoryFixture> | null;
    updated?: ReturnType<typeof makeCategoryFixture> | null;
  } = {},
): SetCategorySeoTypeDeps {
  const allowed = overrides.allowed ?? true;
  const existing =
    overrides.existing !== undefined
      ? overrides.existing
      : makeCategoryFixture();
  const updated =
    overrides.updated !== undefined
      ? overrides.updated
      : makeCategoryFixture({ seoType: "MusicEvent" });

  const categories = {
    getById: vi.fn(async () => existing),
    setSeoType: vi.fn(async () => updated),
  };

  const audit = { log: vi.fn() };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ categories, audit }),
  );

  return {
    repos: {
      categories,
      audit,
      tx,
    } as unknown as SetCategorySeoTypeDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as SetCategorySeoTypeDeps["authz"],
    clock: {
      now: () => FIXED_NOW,
    } as unknown as SetCategorySeoTypeDeps["clock"],
  };
}

describe("setCategorySeoType", () => {
  it("sets the seoType and writes an audit log entry", async () => {
    const deps = buildDeps();

    const result = await setCategorySeoType(deps, {
      actorHumanId: ACTOR_ID,
      categoryId: CATEGORY_ID,
      seoType: "MusicEvent",
    });

    expect(result).toEqual({
      category: {
        id: CATEGORY_ID,
        slug: "music",
        name: "Music",
        names: { en: "Music" },
        seoType: "MusicEvent",
      },
    });

    expect(deps.repos.categories.setSeoType).toHaveBeenCalledWith(
      CATEGORY_ID,
      "MusicEvent",
    );
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "category",
        entityId: CATEGORY_ID,
        action: "category.seo_type_set",
        at: FIXED_NOW,
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          slug: "music",
          previousSeoType: "Event",
          seoType: "MusicEvent",
        }),
      }),
    );
  });

  it("rejects a seoType outside the allowlist at the boundary", async () => {
    const deps = buildDeps();

    await expect(
      setCategorySeoType(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
        seoType: "MovieEvent",
      }),
    ).rejects.toBeDefined();

    expect(deps.repos.categories.setSeoType).not.toHaveBeenCalled();
  });

  it("throws forbidden when actor lacks ADMIN / DEVELOPER role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      setCategorySeoType(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
        seoType: "MusicEvent",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(deps.repos.categories.setSeoType).not.toHaveBeenCalled();
  });

  it("throws not_found when the category does not exist", async () => {
    const deps = buildDeps({ existing: null });

    await expect(
      setCategorySeoType(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
        seoType: "MusicEvent",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(deps.repos.categories.setSeoType).not.toHaveBeenCalled();
  });

  it("throws not_found when the row vanished mid-transaction", async () => {
    const deps = buildDeps({ updated: null });

    await expect(
      setCategorySeoType(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
        seoType: "MusicEvent",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });
});

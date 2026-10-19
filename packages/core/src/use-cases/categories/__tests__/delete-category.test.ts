import { describe, expect, it, vi } from "vitest";

import { deleteCategory } from "../delete-category";
import type { DeleteCategoryDeps } from "../delete-category";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FIXED_NOW = new Date("2026-05-20T12:00:00Z");

function makeCategoryFixture(
  overrides: Partial<{
    id: string;
    slug: string;
    name: string;
    active: boolean;
    sortOrder: number;
  }> = {},
) {
  return {
    id: overrides.id ?? CATEGORY_ID,
    slug: overrides.slug ?? "live-music",
    name: overrides.name ?? "Live Music",
    active: overrides.active ?? true,
    sortOrder: overrides.sortOrder ?? 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function buildDeps(
  overrides: {
    allowed?: boolean;
    existing?: ReturnType<typeof makeCategoryFixture> | null;
    deleteResult?: boolean;
  } = {},
): DeleteCategoryDeps {
  const allowed = overrides.allowed ?? true;
  const existing =
    overrides.existing !== undefined
      ? overrides.existing
      : makeCategoryFixture();
  const deleteResult = overrides.deleteResult ?? true;

  const categories = {
    getById: vi.fn(async () => existing),
    deleteById: vi.fn(async () => deleteResult),
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
    } as unknown as DeleteCategoryDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as DeleteCategoryDeps["authz"],
    clock: {
      now: () => FIXED_NOW,
    } as unknown as DeleteCategoryDeps["clock"],
  };
}

describe("deleteCategory", () => {
  it("deletes a category and writes an audit log entry", async () => {
    const deps = buildDeps();

    const result = await deleteCategory(deps, {
      actorHumanId: ACTOR_ID,
      categoryId: CATEGORY_ID,
    });

    expect(result).toEqual({
      deleted: {
        id: CATEGORY_ID,
        slug: "live-music",
        name: "Live Music",
      },
    });

    expect(deps.repos.categories.deleteById).toHaveBeenCalledWith(CATEGORY_ID);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "category",
        entityId: CATEGORY_ID,
        action: "category.deleted",
        at: FIXED_NOW,
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          slug: "live-music",
          name: "Live Music",
        }),
      }),
    );
  });

  it("throws forbidden when actor lacks ADMIN / DEVELOPER role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      deleteCategory(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(deps.repos.categories.deleteById).not.toHaveBeenCalled();
  });

  it("throws not_found when the category does not exist", async () => {
    const deps = buildDeps({ existing: null });

    await expect(
      deleteCategory(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(deps.repos.categories.deleteById).not.toHaveBeenCalled();
  });

  it("throws not_found when the row vanished mid-transaction", async () => {
    const deps = buildDeps({ deleteResult: false });

    await expect(
      deleteCategory(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: CATEGORY_ID,
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("rejects invalid input shapes", async () => {
    const deps = buildDeps();

    await expect(
      deleteCategory(deps, {
        actorHumanId: ACTOR_ID,
        categoryId: "not-a-uuid",
      }),
    ).rejects.toBeDefined();
  });
});

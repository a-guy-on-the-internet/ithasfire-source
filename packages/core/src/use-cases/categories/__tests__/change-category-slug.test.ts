import { describe, expect, it, vi } from "vitest";

import type { CategorySlugRecord } from "@th/ports/repos/categories";

import { changeCategorySlug } from "../change-category-slug";
import {
  ACTOR_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  UNKNOWN_ID,
  buildCategoryDeps,
  currentEnRows,
  expectReposUntouched,
  threeCategories,
  type StaffRole,
} from "./category-lifecycle-harness";

const OLD = new Date("2026-09-01T00:00:00Z");

const slugRow = (
  categoryId: string,
  locale: "en" | "es",
  slug: string,
  isCurrent: boolean,
): CategorySlugRecord => ({
  categoryId,
  locale,
  slug,
  isCurrent,
  createdAt: OLD,
});

const change = (
  built: ReturnType<typeof buildCategoryDeps>,
  input: Record<string, unknown>,
) => changeCategorySlug(built.deps, { actorHumanId: ACTOR_ID, ...input });

const rowsOf = (
  built: ReturnType<typeof buildCategoryDeps>,
  categoryId: string,
  locale: "en" | "es",
) =>
  built.slugs
    .filter((r) => r.categoryId === categoryId && r.locale === locale)
    .map((r) => [r.slug, r.isCurrent]);

describe("changeCategorySlug", () => {
  describe("who may change a URL", () => {
    it.each<StaffRole>(["ADMIN", "DEVELOPER"])(
      "lets a platform %s change it",
      async (role) => {
        const built = buildCategoryDeps({ actorRoles: [role] });
        const result = await change(built, {
          categoryId: JAZZ_ID,
          locale: "en",
          newSlug: "jazz-nights",
        });
        expect(result.currentSlug).toBe("jazz-nights");
        expect(built.hasStaffRole).toHaveBeenCalledWith({
          actorHumanId: ACTOR_ID,
          requiredRoles: ["ADMIN", "DEVELOPER"],
        });
      },
    );

    it.each<[string, StaffRole[]]>([
      ["a REVIEWER", ["REVIEWER"]],
      ["a signed-in human with no staff role", []],
    ])("refuses %s before any read", async (_label, actorRoles) => {
      const built = buildCategoryDeps({ actorRoles });
      await expect(
        change(built, { categoryId: JAZZ_ID, locale: "en", newSlug: "x-y" }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expectReposUntouched(built);
    });
  });

  it.each(["a", "has space", "Ünïcode", "x".repeat(41), "-lead", "a--b"])(
    "refuses the malformed slug %j with INVALID_CATEGORY_SLUG before any read",
    async (newSlug) => {
      const built = buildCategoryDeps();
      await expect(
        change(built, { categoryId: JAZZ_ID, locale: "en", newSlug }),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY_SLUG" });
      expectReposUntouched(built);
    },
  );

  it("refuses an unsupported locale at the boundary", async () => {
    const built = buildCategoryDeps();
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "fr", newSlug: "jazz" }),
    ).rejects.toBeTruthy();
    expectReposUntouched(built);
  });

  it("answers CATEGORY_NOT_FOUND for an unknown id", async () => {
    const built = buildCategoryDeps();
    await expect(
      change(built, {
        categoryId: UNKNOWN_ID,
        locale: "en",
        newSlug: "jazz-x",
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("changes the en slug: keeps the old row, moves Category.slug, audits, marks reindex, in one tx under the lock", async () => {
    const built = buildCategoryDeps({
      publishedEventIds: { [JAZZ_ID]: ["ev-1", "ev-2"] },
    });

    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "en",
      newSlug: "  Jazz-Nights ",
    });

    expect(result).toEqual({
      categoryId: JAZZ_ID,
      locale: "en",
      currentSlug: "jazz-nights",
      oldSlugs: ["jazz"],
    });
    expect(rowsOf(built, JAZZ_ID, "en")).toEqual([
      ["jazz", false],
      ["jazz-nights", true],
    ]);
    expect(built.rows.find((r) => r.id === JAZZ_ID)!.slug).toBe("jazz-nights");
    expect(built.tx).toHaveBeenCalledTimes(1);
    expect(
      built.categories.lockNaming.mock.invocationCallOrder[0],
    ).toBeLessThan(built.categories.getById.mock.invocationCallOrder[0]!);
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: JAZZ_ID,
      action: "category.slug_changed",
      data: {
        actorHumanId: ACTOR_ID,
        locale: "en",
        previousSlug: "jazz",
        slug: "jazz-nights",
      },
      at: FIXED_NOW,
    });
    expect(built.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("changes the es slug without marking events for reindex", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(JAZZ_ID, "es", "jazz", true)],
      publishedEventIds: { [JAZZ_ID]: ["ev-1"] },
    });

    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "es",
      newSlug: "noches-de-jazz",
    });

    expect(result).toEqual({
      categoryId: JAZZ_ID,
      locale: "es",
      currentSlug: "noches-de-jazz",
      oldSlugs: ["jazz"],
    });
    // English untouched.
    expect(built.rows.find((r) => r.id === JAZZ_ID)!.slug).toBe("jazz");
    expect(rowsOf(built, JAZZ_ID, "en")).toEqual([["jazz", true]]);
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "category.slug_changed",
        data: expect.objectContaining({
          locale: "es",
          previousSlug: "jazz",
          slug: "noches-de-jazz",
        }),
      }),
    );
    expect(built.categories.listPublishedEventIds).not.toHaveBeenCalled();
    expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("refuses a slug another category holds as its current slug", async () => {
    const built = buildCategoryDeps();
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "en", newSlug: "music" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
    expect(rowsOf(built, JAZZ_ID, "en")).toEqual([["jazz", true]]);
    expect(built.audit.log).not.toHaveBeenCalled();
    expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("refuses a slug another category holds as an OLD slug (it still 308s there)", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(MUSIC_ID, "en", "tunes", false)],
    });
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "en", newSlug: "tunes" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("refuses an en slug that is another category's es slug (one category per slug string)", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(MUSIC_ID, "es", "musica", true)],
    });
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "en", newSlug: "musica" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
    expect(built.rows.find((r) => r.id === JAZZ_ID)!.slug).toBe("jazz");
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("refuses an es slug that is another category's en slug, current or old", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(MUSIC_ID, "en", "tunes", false)],
    });
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "es", newSlug: "music" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "es", newSlug: "tunes" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
    expect(rowsOf(built, JAZZ_ID, "es")).toEqual([]);
  });

  it("allows an es slug equal to the category's own en slug", async () => {
    const built = buildCategoryDeps();
    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "es",
      newSlug: "jazz",
    });
    expect(result.currentSlug).toBe("jazz");
    expect(rowsOf(built, JAZZ_ID, "es")).toEqual([["jazz", true]]);
  });

  describe("reportError when the en row cannot be recorded", () => {
    // Jazz has no en row; its Category.slug `jazz` is Music's old slug.
    function conflictWorld() {
      const rows = threeCategories();
      return buildCategoryDeps({
        categories: rows,
        slugs: [
          ...currentEnRows(rows).filter((r) => r.categoryId !== JAZZ_ID),
          slugRow(MUSIC_ID, "en", "jazz", false),
        ],
      });
    }

    it("reports the conflict and still changes the slug", async () => {
      const built = conflictWorld();
      const reportError = vi.fn();

      const result = await changeCategorySlug(
        { ...built.deps, reportError },
        {
          actorHumanId: ACTOR_ID,
          categoryId: JAZZ_ID,
          locale: "es",
          newSlug: "noches-de-jazz",
        },
      );

      expect(result.currentSlug).toBe("noches-de-jazz");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "category_en_slug_conflict" }),
        {
          tags: { useCase: "changeCategorySlug" },
          extra: { categoryId: JAZZ_ID, slug: "jazz" },
        },
      );
    });

    it("a throwing reporter does not change the outcome", async () => {
      const built = conflictWorld();
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });

      const result = await changeCategorySlug(
        { ...built.deps, reportError },
        {
          actorHumanId: ACTOR_ID,
          categoryId: JAZZ_ID,
          locale: "es",
          newSlug: "noches-de-jazz",
        },
      );

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(result.currentSlug).toBe("noches-de-jazz");
    });

    it("does not report without a conflict", async () => {
      const built = buildCategoryDeps();
      const reportError = vi.fn();
      await changeCategorySlug(
        { ...built.deps, reportError },
        {
          actorHumanId: ACTOR_ID,
          categoryId: JAZZ_ID,
          locale: "en",
          newSlug: "jazz-x",
        },
      );
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("allows changing back to its own old slug without a new row", async () => {
    const rows = threeCategories();
    rows[1] = { ...rows[1]!, slug: "jazz-nights" };
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(JAZZ_ID, "en", "jazz", false)],
    });

    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "en",
      newSlug: "jazz",
    });

    expect(result.currentSlug).toBe("jazz");
    expect(result.oldSlugs).toEqual(["jazz-nights"]);
    expect(built.slugs.filter((r) => r.categoryId === JAZZ_ID)).toHaveLength(2);
    expect(built.rows.find((r) => r.id === JAZZ_ID)!.slug).toBe("jazz");
  });

  it("is a no-op when the slug is already current: no write, no audit, no reindex", async () => {
    const built = buildCategoryDeps({
      publishedEventIds: { [JAZZ_ID]: ["ev-1"] },
    });

    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "en",
      newSlug: "jazz",
    });

    expect(result).toEqual({
      categoryId: JAZZ_ID,
      locale: "en",
      currentSlug: "jazz",
      oldSlugs: [],
    });
    expect(built.categories.setCurrentSlug).not.toHaveBeenCalled();
    expect(built.audit.log).not.toHaveBeenCalled();
    expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("records a missing en row first, so the old URL keeps redirecting", async () => {
    const rows = threeCategories();
    // Jazz was written by the old API: Category.slug `jazz`, no en row.
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows).filter((r) => r.categoryId !== JAZZ_ID),
    });

    const result = await change(built, {
      categoryId: JAZZ_ID,
      locale: "en",
      newSlug: "jazz-nights",
    });

    expect(result.oldSlugs).toEqual(["jazz"]);
    expect(rowsOf(built, JAZZ_ID, "en")).toEqual([
      ["jazz", false],
      ["jazz-nights", true],
    ]);
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          previousSlug: "jazz",
          ensuredSlugs: [{ locale: "en", slug: "jazz" }],
        }),
      }),
    );
  });

  it("maps a unique violation from a racing writer to CATEGORY_SLUG_TAKEN", async () => {
    const built = buildCategoryDeps();
    built.categories.setCurrentSlug.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    await expect(
      change(built, { categoryId: JAZZ_ID, locale: "en", newSlug: "jazz-x" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_TAKEN" });
  });
});

import { describe, expect, it } from "vitest";

import { renameCategory } from "../rename-category";
import {
  ACTOR_ID,
  COMEDY_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  UNKNOWN_ID,
  buildCategoryDeps,
  categoryRow,
  expectNothingWritten,
  expectReposUntouched,
  threeCategories,
  type StaffRole,
} from "./category-lifecycle-harness";

const rename = (
  built: ReturnType<typeof buildCategoryDeps>,
  input: Record<string, unknown>,
) => renameCategory(built.deps, { actorHumanId: ACTOR_ID, ...input });

describe("renameCategory", () => {
  describe("who may rename", () => {
    it.each<StaffRole>(["ADMIN", "DEVELOPER"])(
      "lets a platform %s rename a category",
      async (role) => {
        const built = buildCategoryDeps({ actorRoles: [role] });

        const result = await rename(built, {
          categoryId: JAZZ_ID,
          name: "Jazz & Blues",
        });

        expect(result.category.name).toBe("Jazz & Blues");
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
        rename(built, { categoryId: JAZZ_ID, name: "Jazz & Blues" }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });

      expectReposUntouched(built);
      expect(built.rows.find((row) => row.id === JAZZ_ID)?.name).toBe("Jazz");
    });

    it("checks the role before it validates the name", async () => {
      const built = buildCategoryDeps({ actorRoles: [] });

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "@@@@" }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    });
  });

  it("renames, keeps the slug, and writes one audit row", async () => {
    const built = buildCategoryDeps();

    const result = await rename(built, {
      categoryId: JAZZ_ID,
      name: "  Jazz   &  Blues ",
    });

    expect(result).toEqual({
      category: {
        id: JAZZ_ID,
        slug: "jazz",
        name: "Jazz & Blues",
        names: { en: "Jazz & Blues" },
        seoType: "Event",
        active: true,
        sortOrder: 2,
      },
    });
    expect(built.categories.rename).toHaveBeenCalledTimes(1);
    expect(built.categories.rename).toHaveBeenCalledWith(
      JAZZ_ID,
      "Jazz & Blues",
    );
    expect(built.rows.find((row) => row.id === JAZZ_ID)).toMatchObject({
      slug: "jazz",
      name: "Jazz & Blues",
    });
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: JAZZ_ID,
      action: "category.renamed",
      data: {
        actorHumanId: ACTOR_ID,
        slug: "jazz",
        previousName: "Jazz",
        name: "Jazz & Blues",
      },
      at: FIXED_NOW,
    });
  });

  it("answers CATEGORY_NOT_FOUND for an id that does not exist", async () => {
    const built = buildCategoryDeps();

    await expect(
      rename(built, { categoryId: UNKNOWN_ID, name: "Folk" }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expectNothingWritten(built);
  });

  it("answers CATEGORY_NOT_FOUND when the row is deleted before the write", async () => {
    const built = buildCategoryDeps({ deletedBeforeWrite: [JAZZ_ID] });

    await expect(
      rename(built, { categoryId: JAZZ_ID, name: "Folk" }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(built.audit.log).not.toHaveBeenCalled();
  });

  describe("search reindex", () => {
    it("marks every published event in the category after a real rename", async () => {
      const built = buildCategoryDeps({
        publishedEventIds: { [JAZZ_ID]: ["ev-1", "ev-2"] },
      });

      await rename(built, { categoryId: JAZZ_ID, name: "Jazz & Blues" });

      expect(built.categories.listPublishedEventIds).toHaveBeenCalledWith(
        JAZZ_ID,
      );
      expect(built.searchReindexPending.mark).toHaveBeenCalledTimes(1);
      expect(built.searchReindexPending.mark).toHaveBeenCalledWith(
        [
          { entityType: "event", entityId: "ev-1" },
          { entityType: "event", entityId: "ev-2" },
        ],
        FIXED_NOW,
      );
    });

    it("marks nothing when the category has no published events", async () => {
      const built = buildCategoryDeps();

      await rename(built, { categoryId: JAZZ_ID, name: "Jazz & Blues" });

      expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
    });

    it("marks nothing on a refused rename", async () => {
      const built = buildCategoryDeps({
        publishedEventIds: { [JAZZ_ID]: ["ev-1"] },
      });

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "music" }),
      ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS" });

      expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
    });
  });

  describe("no-op", () => {
    it("succeeds without a write or an audit row when the name is unchanged", async () => {
      const built = buildCategoryDeps();

      const result = await rename(built, { categoryId: JAZZ_ID, name: "Jazz" });

      expect(result.category).toMatchObject({ id: JAZZ_ID, name: "Jazz" });
      expectNothingWritten(built);
    });

    it("treats a name that normalises to the current one as unchanged", async () => {
      const built = buildCategoryDeps();

      await rename(built, { categoryId: JAZZ_ID, name: "  Jazz  " });

      expectNothingWritten(built);
    });
  });

  describe("collisions", () => {
    it("refuses a name another category carries, whatever the case", async () => {
      const built = buildCategoryDeps({
        categories: [
          categoryRow({ slug: "live-shows", name: "Music" }),
          categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
        ],
      });

      // "MUSIC" derives slug `music`, which nobody holds, so only the name
      // rule can refuse this.
      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "MUSIC" }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "name" },
      });

      expectNothingWritten(built);
    });

    it("leaves the category itself out of the name check: a case-only change is allowed", async () => {
      const built = buildCategoryDeps({
        categories: [
          categoryRow({ slug: "live-music", name: "live music" }),
          categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
        ],
      });

      const result = await rename(built, {
        categoryId: MUSIC_ID,
        name: "Live Music",
      });

      expect(result.category).toMatchObject({
        id: MUSIC_ID,
        slug: "live-music",
        name: "Live Music",
      });
      expect(built.categories.rename).toHaveBeenCalledWith(
        MUSIC_ID,
        "Live Music",
      );
      expect(built.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "category.renamed",
          data: expect.objectContaining({
            previousName: "live music",
            name: "Live Music",
          }),
        }),
      );
    });

    it("refuses a name whose slug another category holds under a different name", async () => {
      const built = buildCategoryDeps({
        categories: [
          // Slug `music`, but renamed since: no NAME collides with "Music".
          categoryRow({ slug: "music", name: "Concerts" }),
          categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
        ],
      });

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "Music" }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "slug" },
      });

      expectNothingWritten(built);
      expect(built.rows.find((row) => row.id === JAZZ_ID)?.name).toBe("Jazz");
    });

    it("refuses a name whose slug is the one another category's CURRENT name derives", async () => {
      const built = buildCategoryDeps({
        categories: [
          // Renamed earlier: slug `music` stayed, nothing stores `live-shows`.
          categoryRow({ slug: "music", name: "Live Shows" }),
          categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
        ],
      });

      // Not the same name ("live-shows" vs "live shows"), and nobody's stored
      // slug: only the derived-slug rule can refuse it.
      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "Live-Shows" }),
      ).rejects.toMatchObject({
        code: "CATEGORY_ALREADY_EXISTS",
        meta: { field: "name" },
      });

      expectNothingWritten(built);
    });

    it("takes the naming lock once, before it reads the category or the list", async () => {
      const built = buildCategoryDeps();

      await rename(built, { categoryId: JAZZ_ID, name: "Improvised Music" });

      expect(built.categories.lockNaming).toHaveBeenCalledTimes(1);
      const lockOrder = built.categories.lockNaming.mock.invocationCallOrder[0]!;
      expect(lockOrder).toBeLessThan(
        built.categories.getById.mock.invocationCallOrder[0]!,
      );
      expect(lockOrder).toBeLessThan(
        built.categories.listAll.mock.invocationCallOrder[0]!,
      );
      expect(lockOrder).toBeLessThan(
        built.categories.rename.mock.invocationCallOrder[0]!,
      );
    });

    it("allows a new name whose derived slug differs from the category's own, when nobody holds it", async () => {
      const built = buildCategoryDeps();

      const result = await rename(built, {
        categoryId: JAZZ_ID,
        name: "Improvised Music",
      });

      expect(result.category).toMatchObject({
        slug: "jazz",
        name: "Improvised Music",
      });
    });

    it("maps a unique violation from the name index to CATEGORY_ALREADY_EXISTS", async () => {
      const p2002 = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      const built = buildCategoryDeps({ renameError: p2002 });

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "Folk" }),
      ).rejects.toMatchObject({ code: "CATEGORY_ALREADY_EXISTS", cause: p2002 });

      expect(built.audit.log).not.toHaveBeenCalled();
    });

    it("rethrows any other write failure unchanged", async () => {
      const boom = new Error("connection reset");
      const built = buildCategoryDeps({ renameError: boom });

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "Folk" }),
      ).rejects.toBe(boom);
    });
  });

  describe("input", () => {
    it.each([
      ["a link", "www.example.com"],
      ["a handle", "@jazzclub"],
      ["one repeated character", "aaaaaaaaaa"],
      ["a name with no latin letters or digits to slug", "音楽"],
    ])("refuses %s", async (_label, name) => {
      const built = buildCategoryDeps();

      await expect(
        rename(built, { categoryId: JAZZ_ID, name }),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });

      expectReposUntouched(built);
    });

    it("refuses an unknown key (strict schema)", async () => {
      const built = buildCategoryDeps();

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "Folk", slug: "folk" }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expectReposUntouched(built);
    });

    it("refuses a name over 80 characters", async () => {
      const built = buildCategoryDeps();

      await expect(
        rename(built, { categoryId: JAZZ_ID, name: "ab ".repeat(30) }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expectReposUntouched(built);
    });
  });

  it("renames an inactive category too", async () => {
    const built = buildCategoryDeps({ categories: threeCategories() });

    const result = await rename(built, {
      categoryId: COMEDY_ID,
      name: "Stand-up",
    });

    expect(result.category).toMatchObject({
      id: COMEDY_ID,
      name: "Stand-up",
      active: false,
    });
  });
});

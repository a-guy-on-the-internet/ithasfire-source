import { describe, expect, it } from "vitest";

import { listAllCategories } from "../list-all-categories";
import {
  ACTOR_ID,
  COMEDY_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  buildCategoryDeps,
  categoryRow,
  expectReposUntouched,
  type StaffRole,
} from "./category-lifecycle-harness";

const listAll = (
  built: ReturnType<typeof buildCategoryDeps>,
  extra: Record<string, unknown> = {},
) => listAllCategories(built.deps, { actorHumanId: ACTOR_ID, ...extra });

describe("listAllCategories", () => {
  it.each<StaffRole>(["ADMIN", "REVIEWER", "DEVELOPER"])(
    "lets a platform %s read the full list",
    async (role) => {
      const built = buildCategoryDeps({ actorRoles: [role] });

      const result = await listAll(built);

      expect(result.categories).toHaveLength(3);
      expect(built.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN", "REVIEWER", "DEVELOPER"],
      });
    },
  );

  it.each<[string, StaffRole[]]>([
    ["a SUPPORT agent", ["SUPPORT"]],
    ["a signed-in human with no staff role", []],
  ])("refuses %s before any read", async (_label, actorRoles) => {
    const built = buildCategoryDeps({ actorRoles });

    await expect(listAll(built)).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expectReposUntouched(built);
  });

  it("returns inactive categories with the full record shape and no timestamps", async () => {
    const built = buildCategoryDeps();

    const result = await listAll(built);

    expect(result).toEqual({
      categories: [
        {
          id: MUSIC_ID,
          slug: "music",
          urls: [{ locale: "en", slug: "music", isCurrent: true }],
          name: "Music",
          names: { en: "Music" },
          seoType: "Event",
          active: true,
          sortOrder: 1,
        },
        {
          id: JAZZ_ID,
          slug: "jazz",
          urls: [{ locale: "en", slug: "jazz", isCurrent: true }],
          name: "Jazz",
          names: { en: "Jazz" },
          seoType: "Event",
          active: true,
          sortOrder: 2,
        },
        {
          id: COMEDY_ID,
          slug: "comedy",
          urls: [{ locale: "en", slug: "comedy", isCurrent: true }],
          name: "Comedy",
          names: { en: "Comedy" },
          seoType: "Event",
          active: false,
          sortOrder: 3,
        },
      ],
    });
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("lists each category's slug rows from one read, current first, then by locale and slug", async () => {
    const at = (n: number) => new Date(FIXED_NOW.getTime() + n * 1000);
    const built = buildCategoryDeps({
      slugs: [
        { categoryId: MUSIC_ID, locale: "en", slug: "music", isCurrent: true, createdAt: at(0) },
        { categoryId: MUSIC_ID, locale: "es", slug: "musica", isCurrent: true, createdAt: at(1) },
        { categoryId: MUSIC_ID, locale: "es", slug: "sonido", isCurrent: false, createdAt: at(0) },
        { categoryId: JAZZ_ID, locale: "en", slug: "jazz", isCurrent: true, createdAt: at(0) },
      ],
    });

    const result = await listAll(built);

    const byId = Object.fromEntries(result.categories.map((c) => [c.id, c.urls]));
    expect(byId[MUSIC_ID]).toEqual([
      { locale: "en", slug: "music", isCurrent: true },
      { locale: "es", slug: "musica", isCurrent: true },
      { locale: "es", slug: "sonido", isCurrent: false },
    ]);
    expect(byId[JAZZ_ID]).toEqual([{ locale: "en", slug: "jazz", isCurrent: true }]);
    // A category with no rows (not yet backfilled) has none.
    expect(byId[COMEDY_ID]).toEqual([]);
    expect(built.categories.listAllSlugs).toHaveBeenCalledTimes(1);
    expect(built.categories.listSlugs).not.toHaveBeenCalled();
  });

  it("orders by sortOrder, then by name for a tie, whatever order the repo returns", async () => {
    const built = buildCategoryDeps();
    built.categories.listAll.mockResolvedValueOnce([
      categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 0 }),
      categoryRow({ id: MUSIC_ID, slug: "music", name: "Music", sortOrder: 5 }),
      categoryRow({
        id: COMEDY_ID,
        slug: "comedy",
        name: "Comedy",
        sortOrder: 0,
      }),
    ]);

    const result = await listAll(built);

    expect(result.categories.map((c) => c.name)).toEqual([
      "Comedy",
      "Jazz",
      "Music",
    ]);
  });

  it("refuses an unknown key (strict schema)", async () => {
    const built = buildCategoryDeps();

    await expect(
      listAll(built, { includeDeleted: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expectReposUntouched(built);
  });
});

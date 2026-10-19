import { describe, expect, it, vi } from "vitest";

import { setCategoryTranslations } from "../set-category-translations";
import {
  ACTOR_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  UNKNOWN_ID,
  buildCategoryDeps,
  categoryRow,
  currentEnRows,
  expectNothingWritten,
  expectReposUntouched,
  threeCategories,
  type StaffRole,
} from "./category-lifecycle-harness";

const setTranslations = (
  built: ReturnType<typeof buildCategoryDeps>,
  input: Record<string, unknown>,
) => setCategoryTranslations(built.deps, { actorHumanId: ACTOR_ID, ...input });

/** Music (es "Música"), Jazz, Comedy (inactive). */
function withMusica() {
  const rows = threeCategories();
  rows[0] = categoryRow({ nameTranslations: { es: "Música" } });
  return rows;
}

describe("setCategoryTranslations", () => {
  describe("who may set translations", () => {
    it.each<StaffRole>(["ADMIN", "DEVELOPER"])(
      "lets a platform %s set them",
      async (role) => {
        const built = buildCategoryDeps({ actorRoles: [role] });

        const result = await setTranslations(built, {
          categoryId: JAZZ_ID,
          translations: { es: "Jazz latino" },
        });

        expect(result.category.names).toEqual({
          en: "Jazz",
          es: "Jazz latino",
        });
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
        setTranslations(built, {
          categoryId: JAZZ_ID,
          translations: { es: "Jazz latino" },
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });

      expectReposUntouched(built);
      expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
    });
  });

  it("sets es, keeps name and slug, audits once, and marks the category's events for reindex", async () => {
    const built = buildCategoryDeps({
      publishedEventIds: { [MUSIC_ID]: ["ev-1", "ev-2"] },
    });

    const result = await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: { es: "  Música  " },
    });

    expect(result).toEqual({
      category: {
        id: MUSIC_ID,
        slug: "music",
        name: "Music",
        names: { en: "Music", es: "Música" },
        seoType: "Event",
        active: true,
        sortOrder: 1,
      },
    });
    expect(built.categories.lockNaming).toHaveBeenCalledTimes(1);
    expect(built.categories.setNameTranslations).toHaveBeenCalledWith(
      MUSIC_ID,
      { es: "Música" },
    );
    expect(built.rows.find((r) => r.id === MUSIC_ID)).toMatchObject({
      name: "Music",
      slug: "music",
      nameTranslations: { es: "Música" },
    });
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: MUSIC_ID,
      action: "category.translations_set",
      data: {
        actorHumanId: ACTOR_ID,
        slug: "music",
        previousNameTranslations: {},
        nameTranslations: { es: "Música" },
        // The first Spanish name made the es slug (spanish-seo FR-008).
        ensuredSlugs: [{ locale: "es", slug: "musica" }],
      },
      at: FIXED_NOW,
    });
    expect(built.categories.listPublishedEventIds).toHaveBeenCalledWith(
      MUSIC_ID,
    );
    expect(built.searchReindexPending.mark).toHaveBeenCalledWith(
      [
        { entityType: "event", entityId: "ev-1" },
        { entityType: "event", entityId: "ev-2" },
      ],
      FIXED_NOW,
    );
  });

  describe("the es slug (spanish-seo FR-008, R14, R20)", () => {
    const esRows = (built: ReturnType<typeof buildCategoryDeps>) =>
      built.slugs
        .filter((r) => r.categoryId === MUSIC_ID && r.locale === "es")
        .map((r) => [r.slug, r.isCurrent]);

    it("creates the es slug the first time an es name is set", async () => {
      const built = buildCategoryDeps();

      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música en vivo" },
      });

      expect(esRows(built)).toEqual([["musica-en-vivo", true]]);
    });

    it("does not move the es slug when the es name changes", async () => {
      const built = buildCategoryDeps();
      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música" },
      });

      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música en directo" },
      });

      expect(esRows(built)).toEqual([["musica", true]]);
      expect(built.audit.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            ensuredSlugs: expect.anything(),
          }),
        }),
      );
    });

    it("keeps the es slug reserved and current when the es name is cleared", async () => {
      const built = buildCategoryDeps();
      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música" },
      });

      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: null },
      });

      expect(
        built.rows.find((r) => r.id === MUSIC_ID)!.nameTranslations,
      ).toEqual({});
      expect(esRows(built)).toEqual([["musica", true]]);
    });

    it("takes -2 when another category holds the derived slug as its en slug", async () => {
      // Jazz's en slug is `musica`; Music's es name "Música" must not take it.
      const rows = threeCategories();
      rows[1] = { ...rows[1]!, slug: "musica" };
      const built = buildCategoryDeps({ categories: rows });

      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música" },
      });

      expect(esRows(built)).toEqual([["musica-2", true]]);
    });

    describe("reportError when the en row cannot be recorded", () => {
      // Music has no en row; its Category.slug `music` is Jazz's old slug.
      function conflictWorld() {
        const rows = threeCategories();
        return buildCategoryDeps({
          categories: rows,
          slugs: [
            ...currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
            {
              categoryId: JAZZ_ID,
              locale: "en",
              slug: "music",
              isCurrent: false,
              createdAt: FIXED_NOW,
            },
          ],
        });
      }

      it("reports it and still saves the names", async () => {
        const built = conflictWorld();
        const reportError = vi.fn();

        const result = await setCategoryTranslations(
          { ...built.deps, reportError },
          {
            actorHumanId: ACTOR_ID,
            categoryId: MUSIC_ID,
            translations: { es: "Música" },
          },
        );

        expect(result.category.names.es).toBe("Música");
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "category_en_slug_conflict" }),
          {
            tags: { useCase: "setCategoryTranslations" },
            extra: { categoryId: MUSIC_ID, slug: "music" },
          },
        );
      });

      it("a throwing reporter does not change the outcome", async () => {
        const built = conflictWorld();
        const reportError = vi.fn(() => {
          throw new Error("sentry down");
        });

        const result = await setCategoryTranslations(
          { ...built.deps, reportError },
          {
            actorHumanId: ACTOR_ID,
            categoryId: MUSIC_ID,
            translations: { es: "Música" },
          },
        );

        expect(reportError).toHaveBeenCalledTimes(1);
        expect(result.category.names.es).toBe("Música");
        expect(esRows(built)).toEqual([["musica", true]]);
      });

      it("does not report without a conflict", async () => {
        const built = buildCategoryDeps();
        const reportError = vi.fn();
        await setCategoryTranslations(
          { ...built.deps, reportError },
          {
            actorHumanId: ACTOR_ID,
            categoryId: MUSIC_ID,
            translations: { es: "Música" },
          },
        );
        expect(reportError).not.toHaveBeenCalled();
      });
    });

    it("takes -2 when another category holds the derived es slug", async () => {
      const rows = threeCategories();
      const built = buildCategoryDeps({
        categories: rows,
        slugs: [
          ...currentEnRows(rows),
          {
            categoryId: JAZZ_ID,
            locale: "es",
            slug: "musica",
            isCurrent: false,
            createdAt: FIXED_NOW,
          },
        ],
      });

      await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Música" },
      });

      expect(esRows(built)).toEqual([["musica-2", true]]);
    });
  });

  it("takes the naming lock before it reads", async () => {
    const built = buildCategoryDeps();

    await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: { es: "Música" },
    });

    const lockOrder =
      built.categories.lockNaming.mock.invocationCallOrder[0] ?? Infinity;
    expect(lockOrder).toBeLessThan(
      built.categories.getById.mock.invocationCallOrder[0] ?? -Infinity,
    );
    expect(lockOrder).toBeLessThan(
      built.categories.listAll.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });

  it("changes an existing es name", async () => {
    const built = buildCategoryDeps({ categories: withMusica() });

    const result = await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: { es: "Música en vivo" },
    });

    expect(result.category.names.es).toBe("Música en vivo");
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          previousNameTranslations: { es: "Música" },
          nameTranslations: { es: "Música en vivo" },
        }),
      }),
    );
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["blank space", "   "],
  ])("clears es when sent %s", async (_label, value) => {
    const built = buildCategoryDeps({
      categories: withMusica(),
      publishedEventIds: { [MUSIC_ID]: ["ev-1"] },
    });

    const result = await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: { es: value },
    });

    expect(result.category.names).toEqual({ en: "Music" });
    expect(built.categories.setNameTranslations).toHaveBeenCalledWith(
      MUSIC_ID,
      {},
    );
    expect(built.audit.log).toHaveBeenCalledTimes(1);
    expect(built.searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });

  it("leaves es alone when the key is absent (no change, nothing written)", async () => {
    const built = buildCategoryDeps({ categories: withMusica() });

    const result = await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: {},
    });

    expect(result.category.names).toEqual({ en: "Music", es: "Música" });
    expectNothingWritten(built);
  });

  it("writes nothing when the name is the one it already has", async () => {
    const built = buildCategoryDeps({ categories: withMusica() });

    const result = await setTranslations(built, {
      categoryId: MUSIC_ID,
      translations: { es: "Música" },
    });

    expect(result.category.names.es).toBe("Música");
    expectNothingWritten(built);
  });

  it("writes nothing when clearing a translation that is not set", async () => {
    const built = buildCategoryDeps();

    await setTranslations(built, {
      categoryId: JAZZ_ID,
      translations: { es: null },
    });

    expectNothingWritten(built);
  });

  describe("uniqueness within the language", () => {
    it.each([
      ["the same name", "Música"],
      ["the same name in another case", "MÚSICA"],
    ])(
      "refuses %s as another category's es name",
      async (_label, name) => {
        const built = buildCategoryDeps({ categories: withMusica() });

        await expect(
          setTranslations(built, {
            categoryId: JAZZ_ID,
            translations: { es: name },
          }),
        ).rejects.toMatchObject({
          code: "CATEGORY_ALREADY_EXISTS",
          meta: { field: "nameTranslations", locale: "es" },
        });

        expectNothingWritten(built);
      },
    );

    it("lets a category change the case of its own es name", async () => {
      const built = buildCategoryDeps({ categories: withMusica() });

      const result = await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "MÚSICA" },
      });

      expect(result.category.names.es).toBe("MÚSICA");
    });

    it("does not compare against English names (unique within es only)", async () => {
      const built = buildCategoryDeps();

      // "Jazz" is Jazz's English name; Music may still be "Jazz" in es.
      const result = await setTranslations(built, {
        categoryId: MUSIC_ID,
        translations: { es: "Jazz" },
      });

      expect(result.category.names).toEqual({ en: "Music", es: "Jazz" });
    });
  });

  it.each([
    ["a link", "ver https://x.com"],
    ["a character outside the allowed set", "Jazz / Blues"],
    ["one letter", "J"],
  ])("refuses %s as a translated name", async (_label, name) => {
    const built = buildCategoryDeps();

    await expect(
      setTranslations(built, {
        categoryId: JAZZ_ID,
        translations: { es: name },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CATEGORY_REQUEST_NAME" });

    expectNothingWritten(built);
  });

  it("refuses a locale it does not translate into", async () => {
    const built = buildCategoryDeps();

    await expect(
      setTranslations(built, {
        categoryId: JAZZ_ID,
        translations: { fr: "Jazz" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expectReposUntouched(built);
  });

  it("answers CATEGORY_NOT_FOUND for an unknown id", async () => {
    const built = buildCategoryDeps();

    await expect(
      setTranslations(built, {
        categoryId: UNKNOWN_ID,
        translations: { es: "Algo" },
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expectNothingWritten(built);
  });

  it("answers CATEGORY_NOT_FOUND when the row is deleted before the write", async () => {
    const built = buildCategoryDeps({ deletedBeforeWrite: [JAZZ_ID] });

    await expect(
      setTranslations(built, {
        categoryId: JAZZ_ID,
        translations: { es: "Jazz latino" },
      }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });

    expect(built.audit.log).not.toHaveBeenCalled();
    expect(built.searchReindexPending.mark).not.toHaveBeenCalled();
  });
});

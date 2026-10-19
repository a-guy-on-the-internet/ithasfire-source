import { describe, expect, it, vi } from "vitest";

import type { CategorySlugRecord } from "@th/ports/repos/categories";

import {
  ensureAllCategorySlugs,
  ensureCategorySlugs,
} from "../ensure-category-slugs";
import {
  COMEDY_ID,
  FIXED_NOW,
  JAZZ_ID,
  MUSIC_ID,
  buildCategoryDeps,
  categoryRow,
  currentEnRows,
  threeCategories,
} from "./category-lifecycle-harness";

const AT = new Date("2026-10-02T00:00:00Z");

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
  createdAt: AT,
});

const ofCategory = (
  slugs: CategorySlugRecord[],
  categoryId: string,
  locale?: "en" | "es",
) =>
  slugs
    .filter(
      (r) => r.categoryId === categoryId && (!locale || r.locale === locale),
    )
    .map((r) => [r.locale, r.slug, r.isCurrent]);

/** Run the helper the way callers do: in a tx, under the naming lock. */
async function ensure(
  built: ReturnType<typeof buildCategoryDeps>,
  categoryId: string,
) {
  const row = built.rows.find((r) => r.id === categoryId)!;
  return ensureCategorySlugs({ categories: built.categories } as never, row);
}

describe("ensureCategorySlugs", () => {
  it("records a missing current en row from Category.slug", async () => {
    const rows = threeCategories();
    // Music was written by the old API after the backfill: no en row.
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result.enConflict).toBe(false);
    expect(result.written.map((r) => [r.locale, r.slug])).toEqual([
      ["en", "music"],
    ]);
    expect(ofCategory(built.slugs, MUSIC_ID)).toEqual([["en", "music", true]]);
  });

  it("flips its own old en row back when that is its Category.slug", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        ...currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
        slugRow(MUSIC_ID, "en", "music", false),
      ],
    });

    await ensure(built, MUSIC_ID);

    expect(ofCategory(built.slugs, MUSIC_ID)).toEqual([["en", "music", true]]);
  });

  it("reports an en conflict and writes nothing for en when another category holds it", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        ...currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
        // Jazz once was `music`.
        slugRow(JAZZ_ID, "en", "music", false),
      ],
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result).toEqual({ written: [], enConflict: true });
    expect(ofCategory(built.slugs, MUSIC_ID)).toEqual([]);
  });

  it("creates the es slug from the es name, accents stripped", async () => {
    const built = buildCategoryDeps({
      categories: [categoryRow({ nameTranslations: { es: "Música en vivo" } })],
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result.written.map((r) => [r.locale, r.slug])).toEqual([
      ["es", "musica-en-vivo"],
    ]);
    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "musica-en-vivo", true],
    ]);
  });

  it("appends -2, -3 while another category holds the es slug", async () => {
    const rows = [
      categoryRow({ nameTranslations: { es: "Música" } }),
      categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
      categoryRow({
        id: COMEDY_ID,
        slug: "comedy",
        name: "Comedy",
        sortOrder: 3,
      }),
    ];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        ...currentEnRows(rows),
        slugRow(JAZZ_ID, "es", "musica", true),
        // An OLD row reserves its slug too.
        slugRow(COMEDY_ID, "es", "musica-2", false),
      ],
    });

    await ensure(built, MUSIC_ID);

    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "musica-3", true],
    ]);
  });

  it("suffixes when another category holds the derived es slug in ANOTHER locale", async () => {
    // "Tango" (en `tango`) and "Argentine Tango" given the es name "Tango":
    // /es/…/tango must stay Tango's (its /es/ page lives at its en slug).
    const rows = [
      categoryRow({ id: JAZZ_ID, slug: "tango", name: "Tango" }),
      categoryRow({
        slug: "argentine-tango",
        name: "Argentine Tango",
        nameTranslations: { es: "Tango" },
      }),
    ];
    const built = buildCategoryDeps({ categories: rows });

    await ensure(built, MUSIC_ID);

    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "tango-2", true],
    ]);
  });

  it("lets a category's es slug equal its own en slug", async () => {
    const built = buildCategoryDeps({
      categories: [categoryRow({ nameTranslations: { es: "Music" } })],
    });

    await ensure(built, MUSIC_ID);

    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "music", true],
    ]);
  });

  it("reports an en conflict when another category holds Category.slug in another locale", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        ...currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
        slugRow(JAZZ_ID, "es", "music", true),
      ],
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result.enConflict).toBe(true);
    expect(ofCategory(built.slugs, MUSIC_ID)).toEqual([]);
  });

  it("cuts a long es slug at a hyphen to the 40-character limit", async () => {
    const built = buildCategoryDeps({
      categories: [
        categoryRow({
          nameTranslations: {
            es: "Conciertos de música clásica contemporánea experimental",
          },
        }),
      ],
    });

    const result = await ensure(built, MUSIC_ID);

    const slug = result.written[0]!.slug;
    expect(slug).toBe("conciertos-de-musica-clasica");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it("leaves existing es rows alone after a rename (R14)", async () => {
    const rows = [categoryRow({ nameTranslations: { es: "Música nueva" } })];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(MUSIC_ID, "es", "musica", true)],
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result.written).toEqual([]);
    expect(built.categories.setCurrentSlug).not.toHaveBeenCalled();
    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "musica", true],
    ]);
  });

  it("keeps the es slug reserved and current when the es name is cleared (R20)", async () => {
    const rows = [categoryRow({ nameTranslations: {} })];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [...currentEnRows(rows), slugRow(MUSIC_ID, "es", "musica", true)],
    });

    const result = await ensure(built, MUSIC_ID);

    expect(result.written).toEqual([]);
    expect(ofCategory(built.slugs, MUSIC_ID, "es")).toEqual([
      ["es", "musica", true],
    ]);
  });

  it("writes nothing for a category with no es name", async () => {
    const built = buildCategoryDeps();

    const result = await ensure(built, JAZZ_ID);

    expect(result).toEqual({ written: [], enConflict: false });
    expect(built.categories.setCurrentSlug).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run writes nothing", async () => {
    const rows = [categoryRow({ nameTranslations: { es: "Música" } })];
    const built = buildCategoryDeps({ categories: rows, slugs: [] });

    const first = await ensure(built, MUSIC_ID);
    const second = await ensure(built, MUSIC_ID);

    expect(first.written).toHaveLength(2);
    expect(second.written).toEqual([]);
    expect(ofCategory(built.slugs, MUSIC_ID)).toEqual([
      ["en", "music", true],
      ["es", "musica", true],
    ]);
  });
});

describe("ensureAllCategorySlugs", () => {
  it("repairs every category, one tx each under the naming lock, and audits the changes", async () => {
    const rows = threeCategories();
    rows[1] = { ...rows[1]!, nameTranslations: { es: "Jazz latino" } };
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows).filter((r) => r.categoryId !== COMEDY_ID),
    });

    const result = await ensureAllCategorySlugs({
      repos: built.deps.repos,
      clock: built.deps.clock,
    });

    expect(result).toEqual({
      categories: 3,
      enWritten: 1,
      esWritten: 1,
      enConflicts: [],
      written: [
        { categoryId: JAZZ_ID, locale: "es", slug: "jazz-latino" },
        { categoryId: COMEDY_ID, locale: "en", slug: "comedy" },
      ],
    });
    expect(built.tx).toHaveBeenCalledTimes(3);
    expect(built.categories.lockNaming).toHaveBeenCalledTimes(3);
    expect(built.audit.log).toHaveBeenCalledTimes(2);
    expect(built.audit.log).toHaveBeenCalledWith({
      entity: "category",
      entityId: JAZZ_ID,
      action: "category.slugs_ensured",
      data: {
        actorHumanId: null,
        slugs: [{ locale: "es", slug: "jazz-latino" }],
      },
      at: FIXED_NOW,
    });
    expect(built.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: COMEDY_ID,
        data: { actorHumanId: null, slugs: [{ locale: "en", slug: "comedy" }] },
      }),
    );

    // A second run finds nothing to do.
    built.audit.log.mockClear();
    const again = await ensureAllCategorySlugs({
      repos: built.deps.repos,
      clock: built.deps.clock,
    });
    expect(again).toMatchObject({ enWritten: 0, esWritten: 0 });
    expect(built.audit.log).not.toHaveBeenCalled();
  });

  it("dryRun runs everything in one transaction that ends in a rollback, and reports what it computed", async () => {
    const rows = [
      categoryRow({ nameTranslations: { es: "Jazz" } }),
      categoryRow({
        id: JAZZ_ID,
        slug: "jazz",
        name: "Jazz",
        sortOrder: 2,
        nameTranslations: { es: "Jazz" },
      }),
    ];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows),
    });
    const reportError = vi.fn();
    // Watch what the transaction callback does: a real transaction rolls
    // back when it throws.
    const realTx = built.tx.getMockImplementation()!;
    let thrown: unknown;
    built.tx.mockImplementationOnce(async (fn) => {
      try {
        return await realTx(fn);
      } catch (err) {
        thrown = err;
        throw err;
      }
    });

    const result = await ensureAllCategorySlugs(
      {
        repos: built.deps.repos,
        clock: built.deps.clock,
        reportError,
      },
      { dryRun: true },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor.name).toBe("DryRunRollback");
    // The whole-run transaction asks for more than the default time.
    expect(built.tx.mock.calls[0]![1]).toEqual({ timeout: 120_000 });

    // Both want "jazz" in es. The first (Music) is refused it, because the
    // Jazz category holds "jazz" in en, and gets "jazz-2"; Jazz takes its own.
    expect(result.written).toEqual([
      { categoryId: MUSIC_ID, locale: "es", slug: "jazz-2" },
      { categoryId: JAZZ_ID, locale: "es", slug: "jazz" },
    ]);
    expect(result.esWritten).toBe(2);
    expect(built.tx).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("dryRun rethrows a real failure instead of swallowing it as the rollback", async () => {
    const rows = [categoryRow({ nameTranslations: { es: "Jazz" } })];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows),
    });
    built.categories.setCurrentSlug.mockRejectedValueOnce(new Error("db down"));

    await expect(
      ensureAllCategorySlugs(
        { repos: built.deps.repos, clock: built.deps.clock },
        { dryRun: true },
      ),
    ).rejects.toThrow("db down");
  });

  it("dryRun does not send an en conflict to reportError", async () => {
    const rows = [
      categoryRow(),
      categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
    ];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        slugRow(JAZZ_ID, "en", "jazz", true),
        slugRow(JAZZ_ID, "en", "music", false),
      ],
    });
    const reportError = vi.fn();

    const result = await ensureAllCategorySlugs(
      { repos: built.deps.repos, clock: built.deps.clock, reportError },
      { dryRun: true },
    );

    expect(result.enConflicts).toEqual([MUSIC_ID]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lists an en conflict and goes on with the others", async () => {
    const rows = [
      categoryRow(),
      categoryRow({
        id: JAZZ_ID,
        slug: "jazz",
        name: "Jazz",
        sortOrder: 2,
        nameTranslations: { es: "Jazz" },
      }),
    ];
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        slugRow(JAZZ_ID, "en", "jazz", true),
        slugRow(JAZZ_ID, "en", "music", false),
      ],
    });
    const errors: unknown[] = [];
    const logger = {
      error: (...args: unknown[]) => errors.push(args),
      info: () => undefined,
    };

    const result = await ensureAllCategorySlugs({
      repos: built.deps.repos,
      clock: built.deps.clock,
      logger: logger as never,
    });

    expect(result.enConflicts).toEqual([MUSIC_ID]);
    expect(result.esWritten).toBe(1);
    expect(errors).toEqual([
      ["categories.ensure_slugs.en_conflict", { categoryId: MUSIC_ID }],
    ]);
  });

  describe("reportError on an en conflict", () => {
    function conflictWorld() {
      const rows = [
        categoryRow(),
        categoryRow({ id: JAZZ_ID, slug: "jazz", name: "Jazz", sortOrder: 2 }),
      ];
      return buildCategoryDeps({
        categories: rows,
        slugs: [
          slugRow(JAZZ_ID, "en", "jazz", true),
          slugRow(JAZZ_ID, "en", "music", false),
        ],
      });
    }

    it("reports the conflict with the use case tag and the category", async () => {
      const built = conflictWorld();
      const reportError = vi.fn();

      await ensureAllCategorySlugs({
        repos: built.deps.repos,
        clock: built.deps.clock,
        reportError,
      });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "category_en_slug_conflict" }),
        {
          tags: { useCase: "ensureAllCategorySlugs" },
          extra: { categoryId: MUSIC_ID, slug: "music" },
        },
      );
    });

    it("does not report when there is no conflict", async () => {
      const built = buildCategoryDeps();
      const reportError = vi.fn();

      await ensureAllCategorySlugs({
        repos: built.deps.repos,
        clock: built.deps.clock,
        reportError,
      });

      expect(reportError).not.toHaveBeenCalled();
    });

    it("a throwing reporter does not change the result", async () => {
      const built = conflictWorld();
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });

      const result = await ensureAllCategorySlugs({
        repos: built.deps.repos,
        clock: built.deps.clock,
        reportError,
      });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(result.enConflicts).toEqual([MUSIC_ID]);
    });
  });
});

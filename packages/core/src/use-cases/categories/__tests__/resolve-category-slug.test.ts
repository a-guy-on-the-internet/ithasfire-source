import { describe, expect, it } from "vitest";

import type { CategorySlugRecord } from "@th/ports/repos/categories";

import { resolveCategorySlug } from "../resolve-category-slug";
import {
  JAZZ_ID,
  MUSIC_ID,
  buildCategoryDeps,
  currentEnRows,
  threeCategories,
} from "./category-lifecycle-harness";

const OLD = new Date("2026-09-01T00:00:00Z");
const NEW = new Date("2026-10-05T00:00:00Z");

const slugRow = (
  categoryId: string,
  locale: "en" | "es",
  slug: string,
  isCurrent: boolean,
  createdAt = isCurrent ? NEW : OLD,
): CategorySlugRecord => ({ categoryId, locale, slug, isCurrent, createdAt });

/**
 * Music: en `live-music` (current), `music` (old); es `musica` (current),
 *        `musica-vieja` (old).
 * Jazz:  en `jazz`, no es row (never had a Spanish name).
 * Comedy: en `comedy`.
 */
function world(extra: CategorySlugRecord[] = []) {
  const rows = threeCategories();
  rows[0] = { ...rows[0]!, slug: "live-music" };
  return buildCategoryDeps({
    categories: rows,
    slugs: [
      ...currentEnRows(rows),
      slugRow(MUSIC_ID, "en", "music", false),
      slugRow(MUSIC_ID, "es", "musica", true),
      slugRow(MUSIC_ID, "es", "musica-vieja", false),
      ...extra,
    ],
  });
}

const resolve = (
  built: ReturnType<typeof buildCategoryDeps>,
  locale: string,
  slug: string,
) => resolveCategorySlug(built.deps, { locale, slug });

describe("resolveCategorySlug", () => {
  it("renders a current slug in its own language", async () => {
    const built = world();
    await expect(resolve(built, "en", "live-music")).resolves.toEqual({
      kind: "render",
      categoryId: MUSIC_ID,
      locale: "en",
      slug: "live-music",
    });
    await expect(resolve(built, "es", "musica")).resolves.toEqual({
      kind: "render",
      categoryId: MUSIC_ID,
      locale: "es",
      slug: "musica",
    });
  });

  it("redirects an old slug to the current one in the same language", async () => {
    const built = world();
    await expect(resolve(built, "en", "music")).resolves.toEqual({
      kind: "redirect",
      locale: "en",
      slug: "live-music",
    });
    await expect(resolve(built, "es", "musica-vieja")).resolves.toEqual({
      kind: "redirect",
      locale: "es",
      slug: "musica",
    });
  });

  it("redirects a slug of the other language to this language's page when one category matches", async () => {
    const built = world();
    // English words under /es/ move to the Spanish path (R16).
    await expect(resolve(built, "es", "live-music")).resolves.toEqual({
      kind: "redirect",
      locale: "es",
      slug: "musica",
    });
    await expect(resolve(built, "es", "music")).resolves.toEqual({
      kind: "redirect",
      locale: "es",
      slug: "musica",
    });
    await expect(resolve(built, "en", "musica")).resolves.toEqual({
      kind: "redirect",
      locale: "en",
      slug: "live-music",
    });
  });

  it("is not found when the other-language slug names two categories", async () => {
    // es miss on `salsa`: Jazz holds it as an old en row, and Music (written
    // before CategorySlug, no en row) holds it as Category.slug.
    const rows = threeCategories();
    rows[0] = { ...rows[0]!, slug: "salsa" };
    const built = buildCategoryDeps({
      categories: rows,
      slugs: [
        ...currentEnRows(rows).filter((r) => r.categoryId !== MUSIC_ID),
        slugRow(JAZZ_ID, "en", "salsa", false),
      ],
    });

    await expect(resolve(built, "es", "salsa")).resolves.toEqual({
      kind: "notFound",
    });
  });

  it("answers in the URL's language first even when the other language names another category", async () => {
    // (es, salsa) is Jazz's current es slug; (en, salsa) is Music's old one.
    const built = world([
      slugRow(JAZZ_ID, "es", "salsa", true),
      slugRow(MUSIC_ID, "en", "salsa", false),
    ]);

    await expect(resolve(built, "es", "salsa")).resolves.toMatchObject({
      kind: "render",
      categoryId: JAZZ_ID,
    });
    await expect(resolve(built, "en", "salsa")).resolves.toEqual({
      kind: "redirect",
      locale: "en",
      slug: "live-music",
    });
  });

  it("is not found for a slug nobody holds", async () => {
    await expect(resolve(world(), "en", "polka")).resolves.toEqual({
      kind: "notFound",
    });
    await expect(resolve(world(), "es", "polka")).resolves.toEqual({
      kind: "notFound",
    });
  });

  it("renders /es/ at the current en slug for a category with no es slug", async () => {
    const built = world();
    await expect(resolve(built, "es", "jazz")).resolves.toEqual({
      kind: "render",
      categoryId: JAZZ_ID,
      locale: "es",
      slug: "jazz",
    });
  });

  it("redirects an old en slug under /es/ to the current en slug when there is no es slug", async () => {
    const built = world([slugRow(JAZZ_ID, "en", "jazz-old", false)]);
    await expect(resolve(built, "es", "jazz-old")).resolves.toEqual({
      kind: "redirect",
      locale: "es",
      slug: "jazz",
    });
  });

  it("normalises case and surrounding space before the lookup", async () => {
    const built = world();
    await expect(resolve(built, "en", "  Live-MUSIC ")).resolves.toEqual({
      kind: "render",
      categoryId: MUSIC_ID,
      locale: "en",
      slug: "live-music",
    });
    expect(built.categories.findSlug).toHaveBeenCalledWith("en", "live-music");
  });

  it.each(["", "a", "no spaces", "x".repeat(41), "../etc", "música"])(
    "is not found for a malformed slug %j without a query",
    async (slug) => {
      const built = world();
      await expect(resolve(built, "en", slug)).resolves.toEqual({
        kind: "notFound",
      });
      expect(built.categories.findSlug).not.toHaveBeenCalled();
      expect(built.categories.findSlugsBySlug).not.toHaveBeenCalled();
    },
  );

  it("refuses a locale it does not serve", async () => {
    await expect(resolve(world(), "fr", "jazz")).rejects.toBeTruthy();
  });

  it("renders a category written before CategorySlug at its Category.slug", async () => {
    const rows = threeCategories();
    const built = buildCategoryDeps({
      categories: rows,
      slugs: currentEnRows(rows).filter((r) => r.categoryId !== JAZZ_ID),
    });
    await expect(resolve(built, "en", "jazz")).resolves.toEqual({
      kind: "render",
      categoryId: JAZZ_ID,
      locale: "en",
      slug: "jazz",
    });
    await expect(resolve(built, "es", "jazz")).resolves.toMatchObject({
      kind: "render",
      categoryId: JAZZ_ID,
    });
  });

  it("does not check active: an inactive category's slug still resolves", async () => {
    // Comedy is inactive in threeCategories(); the page decides (it 404s).
    await expect(resolve(world(), "en", "comedy")).resolves.toMatchObject({
      kind: "render",
    });
  });
});

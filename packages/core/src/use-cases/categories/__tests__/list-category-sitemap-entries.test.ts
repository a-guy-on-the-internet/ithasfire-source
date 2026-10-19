import { describe, expect, it, vi } from "vitest";

import type {
  CategoryListItem,
  CategorySlugRecord,
} from "@th/ports/repos/categories";

import { listCategorySitemapEntries } from "../list-category-sitemap-entries";

const NOW = new Date("2026-10-13T12:00:00.000Z");

const item = (
  slug: string,
  active = true,
  nameTranslations: CategoryListItem["nameTranslations"] = {},
): CategoryListItem => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  active,
  sortOrder: 0,
  seoType: "Event",
  nameTranslations,
});

const esRow = (slug: string, categorySlug: string): CategorySlugRecord => ({
  categoryId: `cat-${categorySlug}`,
  locale: "es",
  slug,
  isCurrent: true,
  createdAt: NOW,
});

function buildDeps(
  withUpcoming: CategoryListItem[],
  currentEsSlugs: CategorySlugRecord[] = [],
) {
  const categories = {
    listActive: vi.fn(async () => [item("music"), item("test"), item("comedy")]),
    listActiveWithUpcomingEvents: vi.fn(async () => withUpcoming),
    listCurrentSlugs: vi.fn(async () => currentEsSlugs),
  };
  const logger = { info: vi.fn() };
  return {
    deps: { repos: { categories }, logger } as unknown as Parameters<
      typeof listCategorySitemapEntries
    >[0],
    categories,
    logger,
  };
}

describe("listCategorySitemapEntries", () => {
  it("lists only categories the repo reports as having an upcoming listed event", async () => {
    // `test` is active but has nothing upcoming, so the repo leaves it out;
    // the plain active list must not be what feeds the sitemap.
    const built = buildDeps([item("music"), item("comedy")]);

    const result = await listCategorySitemapEntries(built.deps, { now: NOW });

    expect(result).toEqual([
      { slug: "music", esSlug: null },
      { slug: "comedy", esSlug: null },
    ]);
    expect(built.categories.listActiveWithUpcomingEvents).toHaveBeenCalledWith({
      now: NOW,
    });
    expect(built.categories.listActive).not.toHaveBeenCalled();
  });

  it("returns nothing when no category has an upcoming event", async () => {
    const built = buildDeps([]);

    await expect(
      listCategorySitemapEntries(built.deps, { now: NOW }),
    ).resolves.toEqual([]);
    expect(built.logger.info).toHaveBeenCalledWith(
      "categories.list_sitemap_entries",
      { count: 0 },
    );
  });

  it("drops an inactive row even if the repo returns one", async () => {
    const built = buildDeps([item("music"), item("retired", false)]);

    const result = await listCategorySitemapEntries(built.deps, { now: NOW });

    expect(result).toEqual([{ slug: "music", esSlug: null }]);
  });

  describe("esSlug (spanish-seo R9, R20)", () => {
    it("carries the current es slug of a category with an es name", async () => {
      const built = buildDeps(
        [item("music", true, { es: "Música" }), item("jazz")],
        [esRow("musica", "music")],
      );

      const result = await listCategorySitemapEntries(built.deps, { now: NOW });

      expect(result).toEqual([
        { slug: "music", esSlug: "musica" },
        { slug: "jazz", esSlug: null },
      ]);
      expect(built.categories.listCurrentSlugs).toHaveBeenCalledWith("es");
    });

    it("gives no es entry when the es name was cleared, even though the slug is still reserved", async () => {
      const built = buildDeps([item("music")], [esRow("musica", "music")]);

      const result = await listCategorySitemapEntries(built.deps, { now: NOW });

      expect(result).toEqual([{ slug: "music", esSlug: null }]);
    });

    it("gives no es entry when an es name has no es slug yet (before the backfill)", async () => {
      const built = buildDeps([item("music", true, { es: "Música" })], []);

      const result = await listCategorySitemapEntries(built.deps, { now: NOW });

      expect(result).toEqual([{ slug: "music", esSlug: null }]);
    });

    it("keeps the gated-only and empty filter for es too: a category the repo leaves out has no entry", async () => {
      const built = buildDeps([], [esRow("musica", "music")]);

      await expect(
        listCategorySitemapEntries(built.deps, { now: NOW }),
      ).resolves.toEqual([]);
    });
  });

  it("defaults the clock to the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const built = buildDeps([item("music")]);

      await listCategorySitemapEntries(built.deps);

      expect(
        built.categories.listActiveWithUpcomingEvents,
      ).toHaveBeenCalledWith({ now: NOW });
    } finally {
      vi.useRealTimers();
    }
  });
});

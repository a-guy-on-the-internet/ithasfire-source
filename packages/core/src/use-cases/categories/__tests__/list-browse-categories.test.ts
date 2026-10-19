import { describe, expect, it, vi } from "vitest";

import type { CategoryListItem } from "@th/ports/repos/categories";

import { listBrowseCategories } from "../list-browse-categories";

const NOW = new Date("2026-10-14T12:00:00.000Z");

const item = (
  slug: string,
  sortOrder: number,
  active = true,
): CategoryListItem => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  active,
  sortOrder,
  seoType: "Event",
});

function buildDeps(
  withListed: CategoryListItem[] | Error,
  esSlugs: Array<{ categoryId: string; slug: string }> = [],
) {
  const categories = {
    listCurrentSlugs: vi.fn(async (locale: string) =>
      locale === "es"
        ? esSlugs.map((r) => ({
            ...r,
            locale: "es" as const,
            isCurrent: true,
            createdAt: NOW,
          }))
        : [],
    ),
    listActive: vi.fn(async () => [item("music", 1), item("open-mics", 9)]),
    listActiveWithUpcomingEvents: vi.fn(async () => []),
    listActiveWithListedEvents: vi.fn(async () => {
      if (withListed instanceof Error) throw withListed;
      return withListed;
    }),
  };
  const logger = { info: vi.fn() };
  const clock = { now: vi.fn(() => NOW) };
  return {
    deps: { repos: { categories }, logger, clock } as unknown as Parameters<
      typeof listBrowseCategories
    >[0],
    categories,
    logger,
    clock,
  };
}

describe("listBrowseCategories", () => {
  it("offers only the categories whose page lists something, read with the clock's now", async () => {
    // Production shape: `music` (sortOrder 1) is active but empty, so the
    // repo leaves it out; `open-mics` (sortOrder 9) has events.
    const built = buildDeps([item("open-mics", 9)]);

    const result = await listBrowseCategories(built.deps);

    expect(result.map((c) => c.slug)).toEqual(["open-mics"]);
    expect(built.categories.listActiveWithListedEvents).toHaveBeenCalledWith({
      now: NOW,
    });
    // Neither the plain active list nor the sitemap's indexable rule.
    expect(built.categories.listActive).not.toHaveBeenCalled();
    expect(built.categories.listActiveWithUpcomingEvents).not.toHaveBeenCalled();
    expect(built.logger.info).toHaveBeenCalledWith("categories.list_browse", {
      count: 1,
    });
  });

  it("returns them in sortOrder", async () => {
    const built = buildDeps([item("c", 7), item("a", 2), item("b", 4)]);

    const result = await listBrowseCategories(built.deps);

    expect(result.map((c) => c.slug)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing when no category has anything listed", async () => {
    const built = buildDeps([]);

    await expect(listBrowseCategories(built.deps)).resolves.toEqual([]);
  });

  it("drops an inactive row even if the repo returns one", async () => {
    const built = buildDeps([item("music", 1), item("retired", 2, false)]);

    const result = await listBrowseCategories(built.deps);

    expect(result.map((c) => c.slug)).toEqual(["music"]);
  });

  it("defaults to the system clock without one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const built = buildDeps([]);
      const { clock: _clock, ...withoutClock } = built.deps;

      await listBrowseCategories(withoutClock);

      expect(
        built.categories.listActiveWithListedEvents,
      ).toHaveBeenCalledWith({ now: NOW });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries each category's current slug per language, read in one call per language", async () => {
    // `open-mics` has a Spanish slug; `music` has none, so its /es/ page
    // lives at the English slug and `slugs` carries only `en`.
    const built = buildDeps(
      [item("music", 1), item("open-mics", 9)],
      [{ categoryId: "cat-open-mics", slug: "micros-abiertos" }],
    );

    const result = await listBrowseCategories(built.deps);

    expect(result.map((c) => c.slugs)).toEqual([
      { en: "music" },
      { en: "open-mics", es: "micros-abiertos" },
    ]);
    // `slug` stays the English slug for existing callers.
    expect(result.map((c) => c.slug)).toEqual(["music", "open-mics"]);
    expect(built.categories.listCurrentSlugs).toHaveBeenCalledTimes(1);
    expect(built.categories.listCurrentSlugs).toHaveBeenCalledWith("es");
  });

  it("lets a slug read failure propagate: no list without its links", async () => {
    const built = buildDeps([item("music", 1)]);
    built.categories.listCurrentSlugs.mockRejectedValueOnce(
      new Error("slugs down"),
    );

    await expect(listBrowseCategories(built.deps)).rejects.toThrow(
      "slugs down",
    );
  });

  it("lets a repo failure propagate rather than offering a fallback list", async () => {
    const built = buildDeps(new Error("db down"));

    await expect(listBrowseCategories(built.deps)).rejects.toThrow("db down");
  });
});

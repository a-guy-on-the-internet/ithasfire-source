import { describe, expect, it, vi } from "vitest";

import type { CategoryListItem } from "@th/ports/repos/categories";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";

import { listCategories } from "../list-categories";

const item = (
  slug: string,
  sortOrder: number,
  nameTranslations?: { es?: string },
): CategoryListItem => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  active: true,
  sortOrder,
  seoType: "Event",
  nameTranslations: nameTranslations ?? {},
});

function buildDeps(
  active: CategoryListItem[],
  esSlugs: Array<{ categoryId: string; slug: string }>,
) {
  const categories = {
    listActive: vi.fn(async () => active),
    listCurrentSlugs: vi.fn(async (locale: string) =>
      locale === "es"
        ? esSlugs.map((r) => ({
            ...r,
            locale: "es" as const,
            isCurrent: true,
            createdAt: new Date(0),
          }))
        : [],
    ),
  };
  return {
    deps: { repos: { categories } } as unknown as Parameters<
      typeof listCategories
    >[0],
    categories,
  };
}

describe("listCategories", () => {
  it("returns active categories in sortOrder with names and current slugs per language", async () => {
    const built = buildDeps(
      [item("open-mics", 9), item("music", 1, { es: "Música" })],
      [
        { categoryId: "cat-music", slug: "musica" },
        // A slug row for a category not in the active list is ignored.
        { categoryId: "cat-retired", slug: "retirada" },
      ],
    );

    const result = await listCategories(built.deps);

    expect(result.map((c) => c.slug)).toEqual(["music", "open-mics"]);
    expect(result.map((c) => c.names)).toEqual([
      { en: "music", es: "Música" },
      { en: "open-mics" },
    ]);
    expect(result.map((c) => c.slugs)).toEqual([
      { en: "music", es: "musica" },
      { en: "open-mics" },
    ]);
    // One read per non-English language, not one per category.
    expect(built.categories.listCurrentSlugs).toHaveBeenCalledTimes(1);
    expect(built.categories.listCurrentSlugs).toHaveBeenCalledWith("es");
  });

  it("caches the whole answer, slugs included, under one key", async () => {
    const built = buildDeps(
      [item("music", 1)],
      [{ categoryId: "cat-music", slug: "musica" }],
    );
    const store = new Map<string, unknown>();
    const cache: ReadThroughCachePort = {
      getOrLoad: vi.fn(async <T>(key: string, load: () => Promise<T>) => {
        if (!store.has(key)) store.set(key, await load());
        return store.get(key) as T;
      }),
      clear: vi.fn(),
    };

    const first = await listCategories({ ...built.deps, cache });
    const second = await listCategories({ ...built.deps, cache });

    expect(second).toBe(first);
    expect(first[0]!.slugs).toEqual({ en: "music", es: "musica" });
    expect(built.categories.listActive).toHaveBeenCalledTimes(1);
    expect(built.categories.listCurrentSlugs).toHaveBeenCalledTimes(1);
  });

  it("lets a slug read failure propagate rather than caching a list without links", async () => {
    const built = buildDeps([item("music", 1)], []);
    built.categories.listCurrentSlugs.mockRejectedValueOnce(
      new Error("slugs down"),
    );

    await expect(listCategories(built.deps)).rejects.toThrow("slugs down");
  });
});

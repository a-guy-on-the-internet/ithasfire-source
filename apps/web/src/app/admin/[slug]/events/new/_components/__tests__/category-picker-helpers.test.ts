import { describe, expect, it } from "vitest";

import {
  filterCategoryOptions,
  optionHasName,
  optionMatchesQuery,
  queryIsCommittedSelection,
  resolveHydratedCategory,
} from "../category-picker-helpers";

const CATEGORIES = [
  { slug: "music", name: "Music" },
  { slug: "comedy", name: "Comedy" },
  { slug: "theater", name: "Theater" },
  { slug: "film", name: "Film" },
  { slug: "food-drink", name: "Food & Drink" },
];

describe("optionMatchesQuery", () => {
  it("matches on name substring, case-insensitively", () => {
    expect(optionMatchesQuery(CATEGORIES[0]!, "mus")).toBe(true);
    expect(optionMatchesQuery(CATEGORIES[0]!, "MUS")).toBe(true);
    expect(optionMatchesQuery(CATEGORIES[0]!, "comedy")).toBe(false);
  });

  it("matches on slug substring", () => {
    expect(optionMatchesQuery(CATEGORIES[4]!, "food-dr")).toBe(true);
  });

  it("matches everything on an empty/whitespace query", () => {
    expect(optionMatchesQuery(CATEGORIES[1]!, "")).toBe(true);
    expect(optionMatchesQuery(CATEGORIES[1]!, "   ")).toBe(true);
  });
});

describe("queryIsCommittedSelection", () => {
  it("is true when the query exactly equals the selection name", () => {
    expect(queryIsCommittedSelection("Music", "Music")).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(queryIsCommittedSelection("  music ", "Music")).toBe(true);
  });

  it("is false once the user edits the text", () => {
    expect(queryIsCommittedSelection("Musi", "Music")).toBe(false);
    expect(queryIsCommittedSelection("Musics", "Music")).toBe(false);
  });

  it("is false with no committed selection", () => {
    expect(queryIsCommittedSelection("Music", null)).toBe(false);
    expect(queryIsCommittedSelection("Music", undefined)).toBe(false);
  });
});

describe("filterCategoryOptions", () => {
  it("shows the FULL list when the query is the hydrated selection's name (refresh-collapse bug)", () => {
    // After a page refresh, hydration copies the selected category's name
    // into the query. Opening the dropdown must show every category, not
    // just the already-selected row.
    const result = filterCategoryOptions({
      categories: CATEGORIES,
      query: "Music",
      selectedName: "Music",
    });
    expect(result).toEqual(CATEGORIES);
  });

  it("filters once the user edits the text away from the selection name", () => {
    const result = filterCategoryOptions({
      categories: CATEGORIES,
      query: "com",
      selectedName: "Music",
    });
    expect(result).toEqual([{ slug: "comedy", name: "Comedy" }]);
  });

  it("filters when the query names a DIFFERENT category in full", () => {
    const result = filterCategoryOptions({
      categories: CATEGORIES,
      query: "Comedy",
      selectedName: "Music",
    });
    expect(result).toEqual([{ slug: "comedy", name: "Comedy" }]);
  });

  it("shows the full list for an empty query (no selection yet)", () => {
    const result = filterCategoryOptions({
      categories: CATEGORIES,
      query: "",
      selectedName: null,
    });
    expect(result).toEqual(CATEGORIES);
  });

  it("still filters normally when there is no committed selection", () => {
    const result = filterCategoryOptions({
      categories: CATEGORIES,
      query: "the",
      selectedName: null,
    });
    expect(result).toEqual([{ slug: "theater", name: "Theater" }]);
  });

  it("caps actively-filtered results at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      slug: `genre-${i}`,
      name: `Genre ${i}`,
    }));
    const result = filterCategoryOptions({
      categories: many,
      query: "genre",
      selectedName: null,
      limit: 12,
    });
    expect(result).toHaveLength(12);
  });

  it("does NOT cap the unfiltered committed-selection view", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      slug: `genre-${i}`,
      name: `Genre ${i}`,
    }));
    const result = filterCategoryOptions({
      categories: many,
      query: "Genre 3",
      selectedName: "Genre 3",
    });
    expect(result).toHaveLength(20);
  });
});

describe("resolveHydratedCategory", () => {
  const ACTIVE = [
    { id: "id-music", slug: "music", name: "Music" },
    { id: "id-comedy", slug: "comedy", name: "Comedy" },
  ];

  it("prefers the active-list entry when the categoryId is active", () => {
    expect(
      resolveHydratedCategory({
        categoryId: "id-music",
        // Server join is present too — the active entry must still win.
        serverCategory: { id: "id-music", slug: "music", name: "Music" },
        activeCategories: ACTIVE,
      }),
    ).toEqual({ slug: "music", name: "Music" });
  });

  it("falls back to the server-joined category when it is INACTIVE (blank-field bug)", () => {
    // categories.list omits deactivated rows, so the ONLY name source is the
    // getEventForEdit join. Previously this case hydrated a blank input.
    expect(
      resolveHydratedCategory({
        categoryId: "id-vaudeville",
        serverCategory: {
          id: "id-vaudeville",
          slug: "vaudeville",
          name: "Vaudeville",
        },
        activeCategories: ACTIVE,
      }),
    ).toEqual({ slug: "vaudeville", name: "Vaudeville" });
  });

  it("reads an INACTIVE category's name in the organiser's language", () => {
    // The active list is already localised; the server join is the only
    // source for a deactivated category, so it must carry `names` too.
    const vaudeville = {
      id: "id-vaudeville",
      slug: "vaudeville",
      name: "Music",
      names: { en: "Music", es: "Música" },
    };
    expect(
      resolveHydratedCategory({
        categoryId: "id-vaudeville",
        serverCategory: vaudeville,
        activeCategories: ACTIVE,
        locale: "es",
      }),
    ).toEqual({ slug: "vaudeville", name: "Música" });
    // English reader, and a language with no translation: the English name.
    expect(
      resolveHydratedCategory({
        categoryId: "id-vaudeville",
        serverCategory: vaudeville,
        activeCategories: ACTIVE,
        locale: "en",
      }),
    ).toEqual({ slug: "vaudeville", name: "Music" });
    expect(
      resolveHydratedCategory({
        categoryId: "id-vaudeville",
        serverCategory: { ...vaudeville, names: { en: "Music" } },
        activeCategories: ACTIVE,
        locale: "es",
      }),
    ).toEqual({ slug: "vaudeville", name: "Music" });
  });

  it("ignores a stale server join that doesn't match the saved categoryId", () => {
    expect(
      resolveHydratedCategory({
        categoryId: "id-vaudeville",
        serverCategory: { id: "id-other", slug: "other", name: "Other" },
        activeCategories: ACTIVE,
      }),
    ).toBeNull();
  });

  it("returns null when the event has no category", () => {
    expect(
      resolveHydratedCategory({
        categoryId: null,
        serverCategory: null,
        activeCategories: ACTIVE,
      }),
    ).toBeNull();
  });

  it("returns null when the category was hard-deleted (join came back null)", () => {
    expect(
      resolveHydratedCategory({
        categoryId: "id-deleted",
        serverCategory: null,
        activeCategories: ACTIVE,
      }),
    ).toBeNull();
  });
});

describe("names in more than one language (category-translations FR-009)", () => {
  // As the picker holds it for an English reader: `name` is the display
  // name, `names` every language.
  const music = {
    slug: "music",
    name: "Music",
    names: { en: "Music", es: "Música" },
  };
  // The same category for a Spanish reader.
  const musica = { ...music, name: "Música" };

  it("matches a name in any language, not only the one shown", () => {
    expect(optionMatchesQuery(music, "músi")).toBe(true);
    expect(optionMatchesQuery(musica, "mus")).toBe(true);
    expect(optionMatchesQuery(music, "teatro")).toBe(false);
  });

  it("filters by a Spanish name for an English reader", () => {
    expect(
      filterCategoryOptions({
        categories: [music, { slug: "comedy", name: "Comedy" }],
        query: "música",
      }).map((c) => c.slug),
    ).toEqual(["music"]);
  });

  it("knows an exact name in either language", () => {
    expect(optionHasName(music, "MÚSICA")).toBe(true);
    expect(optionHasName(musica, "music ")).toBe(true);
    expect(optionHasName(music, "Musica")).toBe(false);
    expect(optionHasName({ slug: "film", name: "Film" }, "film")).toBe(true);
  });
});

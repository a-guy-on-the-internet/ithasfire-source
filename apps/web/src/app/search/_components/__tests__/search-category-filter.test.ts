import { describe, expect, it } from "vitest";

import {
  MAX_CATEGORY_SLUGS,
  MAX_CATEGORY_SLUG_LENGTH,
  categoryFilterInput,
  pruneCategorySelection,
  shownCategorySlugs,
  unavailableCategoryNoticeKind,
} from "../search-category-filter";
import { parseSearchParams } from "../search-url";

describe("categoryFilterInput", () => {
  it("sends a ?category= URL as categorySlugs and never as a tag", () => {
    const { categories } = parseSearchParams(
      new URLSearchParams("category=music,comedy"),
    );

    const input = categoryFilterInput({
      eventsInScope: true,
      selectedCategories: categories,
    });

    expect(input).toEqual({ categorySlugs: ["music", "comedy"] });
    expect(input).not.toHaveProperty("tags");
  });

  it("sends an unknown or inactive slug as given: the server decides", () => {
    expect(
      categoryFilterInput({
        eventsInScope: true,
        selectedCategories: ["zz-no-such-category"],
      }),
    ).toEqual({ categorySlugs: ["zz-no-such-category"] });
  });

  it("adds nothing when no category is selected", () => {
    expect(
      categoryFilterInput({ eventsInScope: true, selectedCategories: [] }),
    ).toEqual({});
  });

  it("adds nothing outside an event scope", () => {
    expect(
      categoryFilterInput({
        eventsInScope: false,
        selectedCategories: ["music"],
      }),
    ).toEqual({});
  });

  it("drops a slug the procedure would reject for length", () => {
    const tooLong = "x".repeat(MAX_CATEGORY_SLUG_LENGTH + 1);
    const longest = "y".repeat(MAX_CATEGORY_SLUG_LENGTH);

    expect(
      categoryFilterInput({
        eventsInScope: true,
        selectedCategories: [tooLong, "music", longest],
      }),
    ).toEqual({ categorySlugs: ["music", longest] });
    expect(
      categoryFilterInput({
        eventsInScope: true,
        selectedCategories: [tooLong],
      }),
    ).toEqual({});
  });

  it("caps the list at the procedure's maximum", () => {
    const many = Array.from(
      { length: MAX_CATEGORY_SLUGS + 5 },
      (_, i) => `c-${i}`,
    );

    const { categorySlugs } = categoryFilterInput({
      eventsInScope: true,
      selectedCategories: many,
    });

    expect(categorySlugs).toEqual(many.slice(0, MAX_CATEGORY_SLUGS));
  });
});

describe("shownCategorySlugs", () => {
  it("keeps every selected slug while the active list has not loaded", () => {
    expect(shownCategorySlugs(["music", "nightlife"], null)).toEqual([
      "music",
      "nightlife",
    ]);
  });

  it("hides a slug that is not an active category once the list has loaded", () => {
    expect(
      shownCategorySlugs(["nightlife", "music"], ["music", "comedy"]),
    ).toEqual(["music"]);
  });

  it("shows nothing when the only selected category is inactive or unknown", () => {
    expect(shownCategorySlugs(["nightlife"], ["music"])).toEqual([]);
    expect(shownCategorySlugs(["nightlife"], [])).toEqual([]);
  });
});

describe("pruneCategorySelection", () => {
  it("has nothing to do while the active list has not loaded or failed to load", () => {
    expect(pruneCategorySelection(["zz-no-such-category"], null)).toBeNull();
    expect(pruneCategorySelection([], null)).toBeNull();
  });

  it("has nothing to do when every selected slug is active", () => {
    expect(pruneCategorySelection(["music"], ["music", "comedy"])).toBeNull();
    expect(pruneCategorySelection([], ["music"])).toBeNull();
  });

  it("splits a selection into the active slugs it keeps and the ones it drops", () => {
    expect(
      pruneCategorySelection(
        ["zz-no-such-category", "music", "nightlife", "comedy"],
        ["comedy", "music"],
      ),
    ).toEqual({
      kept: ["music", "comedy"],
      dropped: ["zz-no-such-category", "nightlife"],
    });
  });

  it("drops the whole selection when the loaded list is empty", () => {
    expect(pruneCategorySelection(["music"], [])).toEqual({
      kept: [],
      dropped: ["music"],
    });
  });

  it("is settled after one pass: pruning what it kept finds nothing more", () => {
    const active = ["music"];
    const first = pruneCategorySelection(["gone", "music"], active);

    expect(first).not.toBeNull();
    expect(pruneCategorySelection(first?.kept ?? [], active)).toBeNull();
  });
});

describe("unavailableCategoryNoticeKind", () => {
  it("is 'all' when the prune left no category selected", () => {
    expect(unavailableCategoryNoticeKind([])).toBe("all");
  });

  it("is 'some' when other categories remain selected", () => {
    expect(unavailableCategoryNoticeKind(["music"])).toBe("some");
  });
});

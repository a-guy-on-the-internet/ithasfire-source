import { describe, expect, it } from "vitest";

import {
  categoryDisplayName,
  categoryNameCandidates,
  withCategoryDisplayNames,
} from "../category-display-name";

const music = {
  name: "Music",
  names: { en: "Music", es: "Música" },
};

describe("categoryDisplayName", () => {
  it("shows the name in the viewer's language when it has one", () => {
    expect(categoryDisplayName(music, "es")).toBe("Música");
    expect(categoryDisplayName(music, "en")).toBe("Music");
  });

  it("falls back to English when the language has no name", () => {
    expect(
      categoryDisplayName({ name: "Trivia", names: { en: "Trivia" } }, "es"),
    ).toBe("Trivia");
    // A blank translation is no translation.
    expect(
      categoryDisplayName(
        { name: "Trivia", names: { en: "Trivia", es: "  " } },
        "es",
      ),
    ).toBe("Trivia");
  });

  it("falls back to `name` when the API sends no `names` (deploy window)", () => {
    expect(categoryDisplayName({ name: "Comedy" }, "es")).toBe("Comedy");
    expect(categoryDisplayName({ name: "Comedy", names: null }, "es")).toBe(
      "Comedy",
    );
  });

  it("uses English for an unknown or missing locale", () => {
    expect(categoryDisplayName(music, "fr")).toBe("Music");
    expect(categoryDisplayName(music, undefined)).toBe("Music");
  });
});

describe("withCategoryDisplayNames", () => {
  it("swaps each name and keeps rows that did not change", () => {
    const trivia = { id: "2", name: "Trivia", names: { en: "Trivia" } };
    const [first, second] = withCategoryDisplayNames(
      [{ id: "1", ...music }, trivia],
      "es",
    );
    expect(first).toEqual({ id: "1", name: "Música", names: music.names });
    expect(second).toBe(trivia);
  });
});

describe("categoryNameCandidates", () => {
  it("lists every name once, the display name first", () => {
    expect(categoryNameCandidates({ ...music, name: "Música" })).toEqual([
      "Música",
      "Music",
    ]);
    expect(categoryNameCandidates({ name: "Comedy" })).toEqual(["Comedy"]);
  });
});

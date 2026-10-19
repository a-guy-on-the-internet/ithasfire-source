import { describe, expect, it } from "vitest";

// Source file, not the package: @th/types cannot depend on @th/locale (it
// pulls in React), and this constants file imports nothing.
import { SUPPORTED_LOCALES } from "../../../locale/src/constants";
import {
  CATEGORY_NAME_LOCALES,
  CATEGORY_TRANSLATION_LOCALES,
  categoryNames,
  parseCategoryNameTranslations,
} from "../category-names";

describe("category name locales", () => {
  it("match the UI's supported locales", () => {
    expect([...CATEGORY_NAME_LOCALES].sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it("translate into every UI locale except English", () => {
    expect([...CATEGORY_TRANSLATION_LOCALES].sort()).toEqual(
      CATEGORY_NAME_LOCALES.filter((l) => l !== "en").sort(),
    );
  });
});

describe("parseCategoryNameTranslations", () => {
  it("keeps supported locales with a non-empty string", () => {
    expect(parseCategoryNameTranslations({ es: "Música" })).toEqual({
      es: "Música",
    });
  });

  it.each([
    ["null", null],
    ["an array", ["Música"]],
    ["a string", "Música"],
    ["an empty object", {}],
    ["a blank value", { es: "  " }],
    ["a non-string value", { es: 3 }],
    ["an unsupported locale", { fr: "Musique" }],
    ["English in the map", { en: "Music" }],
  ])("reads %s as no translations", (_label, raw) => {
    expect(parseCategoryNameTranslations(raw)).toEqual({});
  });
});

describe("categoryNames", () => {
  it("puts the English name under en beside the translations", () => {
    expect(
      categoryNames({ name: "Music", nameTranslations: { es: "Música" } }),
    ).toEqual({ en: "Music", es: "Música" });
  });

  it("gives just en when there are none", () => {
    expect(categoryNames({ name: "Music" })).toEqual({ en: "Music" });
  });
});

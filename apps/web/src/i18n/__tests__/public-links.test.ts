/**
 * Internal links on public pages (Spanish SEO FR-006, R7): a page's links to
 * the five twin families follow the page's URL language, a category without a
 * slug in that language falls back to its English slug, and every decision is
 * made from the URL, never the viewer's preference.
 */
import { describe, expect, it } from "vitest";

import {
  categoryLinkSlugs,
  linkLocaleForPath,
  publicLinkPath,
} from "../public-paths";

describe("linkLocaleForPath", () => {
  it("is Spanish under /es, an unknown /es path included", () => {
    expect(linkLocaleForPath("/es")).toBe("es");
    expect(linkLocaleForPath("/es/")).toBe("es");
    expect(linkLocaleForPath("/es/acerca-de")).toBe("es");
    expect(linkLocaleForPath("/es/eventos/categoria/musica/nashville-tn")).toBe(
      "es",
    );
    expect(linkLocaleForPath("/es/no-such-page")).toBe("es");
  });

  it("is English everywhere else: English twins, twinless and app pages", () => {
    for (const path of [
      "/",
      "/about",
      "/events/category/music",
      "/events/some-show",
      "/places/the-basement",
      "/search",
      "/account",
      // Lookalikes are not the prefix.
      "/espanol",
      "/es-mx/x",
    ]) {
      expect(linkLocaleForPath(path)).toBe("en");
    }
  });

  it("is English with no pathname (outside the router)", () => {
    expect(linkLocaleForPath(null)).toBe("en");
    expect(linkLocaleForPath(undefined)).toBe("en");
    expect(linkLocaleForPath("")).toBe("en");
  });
});

describe("publicLinkPath", () => {
  const withEs = { en: "open-mics", es: "micros-abiertos" };
  const enOnly = { en: "trivia" };

  it("builds the static families in the page's language", () => {
    expect(publicLinkPath("en", { kind: "home" })).toBe("/");
    expect(publicLinkPath("es", { kind: "home" })).toBe("/es");
    expect(publicLinkPath("en", { kind: "about" })).toBe("/about");
    expect(publicLinkPath("es", { kind: "about" })).toBe("/es/acerca-de");
    expect(publicLinkPath("en", { kind: "contact" })).toBe("/contact");
    expect(publicLinkPath("es", { kind: "contact" })).toBe("/es/contacto");
  });

  it("picks the category slug for the page's language", () => {
    expect(publicLinkPath("en", { kind: "category", slugs: withEs })).toBe(
      "/events/category/open-mics",
    );
    expect(publicLinkPath("es", { kind: "category", slugs: withEs })).toBe(
      "/es/eventos/categoria/micros-abiertos",
    );
    expect(
      publicLinkPath("es", {
        kind: "cityCategory",
        slugs: withEs,
        city: "nashville-tn",
      }),
    ).toBe("/es/eventos/categoria/micros-abiertos/nashville-tn");
  });

  it("falls back to the English slug under /es when the category has no Spanish one", () => {
    expect(publicLinkPath("es", { kind: "category", slugs: enOnly })).toBe(
      "/es/eventos/categoria/trivia",
    );
    expect(
      publicLinkPath("es", {
        kind: "cityCategory",
        slugs: enOnly,
        city: "nashville-tn",
      }),
    ).toBe("/es/eventos/categoria/trivia/nashville-tn");
  });
});

describe("categoryLinkSlugs", () => {
  it("reads slugs from a list row", () => {
    expect(
      categoryLinkSlugs({
        slug: "music",
        slugs: { en: "music", es: "musica" },
      }),
    ).toEqual({ en: "music", es: "musica" });
  });

  it("falls back to the English slug when the API sent no slugs", () => {
    expect(categoryLinkSlugs({ slug: "music" })).toEqual({ en: "music" });
    expect(categoryLinkSlugs({ slug: "music", slugs: null })).toEqual({
      en: "music",
    });
  });

  it("drops empty and unsupported entries", () => {
    expect(
      categoryLinkSlugs({
        slug: "music",
        slugs: { en: "", es: "", fr: "musique" },
      }),
    ).toEqual({ en: "music" });
  });
});

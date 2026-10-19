/**
 * The one public-path helper (Spanish SEO FR-006, R12, R13). Every R1 family
 * round-trips in both languages; app pages are never English-first (the spec
 * risk "narrowing the server pick must not flip app pages"); lookalike paths
 * never match.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_PUBLIC_LOCALE } from "@th/types/seo/public-paths";

import { DEFAULT_LOCALE } from "../config";

import {
  englishFirstPath,
  isTwinlessEnglishFirstPath,
  parseMisworded,
  parsePublicPath,
  PREFIXED_LOCALES,
  publicPath,
  urlLocaleForPath,
  type PublicPage,
} from "../public-paths";

const pairs: Array<{ page: PublicPage; en: string; es: string }> = [
  { page: { kind: "home" }, en: "/", es: "/es" },
  {
    page: { kind: "category", slug: "open-mics" },
    en: "/events/category/open-mics",
    es: "/es/eventos/categoria/open-mics",
  },
  {
    page: { kind: "cityCategory", slug: "musica", city: "nashville-tn" },
    en: "/events/category/musica/nashville-tn",
    es: "/es/eventos/categoria/musica/nashville-tn",
  },
  { page: { kind: "about" }, en: "/about", es: "/es/acerca-de" },
  { page: { kind: "contact" }, en: "/contact", es: "/es/contacto" },
];

describe("PREFIXED_LOCALES", () => {
  it("is every supported locale but the default (no /en/ URLs)", () => {
    expect(PREFIXED_LOCALES).toEqual(["es"]);
  });
});

describe("publicPath / parsePublicPath", () => {
  it.each(pairs)("builds and parses $en ↔ $es", ({ page, en, es }) => {
    expect(publicPath("en", page)).toBe(en);
    expect(publicPath("es", page)).toBe(es);
    expect(parsePublicPath(en)).toEqual({ locale: "en", page });
    expect(parsePublicPath(es)).toEqual({ locale: "es", page });
  });

  it("tolerates one trailing slash", () => {
    expect(parsePublicPath("/es/")).toEqual({
      locale: "es",
      page: { kind: "home" },
    });
    expect(parsePublicPath("/about/")).toEqual({
      locale: "en",
      page: { kind: "about" },
    });
  });

  it.each([
    "/en",
    "/en/about",
    "/esports",
    "/es-foo",
    "/aboutus",
    "/about/team",
    "/contact-us",
    "/events",
    "/events/category",
    "/events/category/music/nashville-tn/extra",
    "/events/categoryx/music",
    "/events/us/nashville/show",
    "/eventos/categoria/musica",
    "/es/eventos",
    "/es/eventos/categoria",
    "/es/about",
    "/es/events/category/music",
    "/es/es",
    "//about",
    "/search",
    "/places/the-basement",
  ])("does not parse %s as an R1 page in its own words", (path) => {
    expect(parsePublicPath(path)).toBeNull();
  });

  it("rejects a malformed escape instead of throwing", () => {
    expect(parsePublicPath("/events/category/%E0%A4%A")).toBeNull();
  });
});

describe("parseMisworded (R16: English words under /es/)", () => {
  it.each([
    ["/es/about", "/es/acerca-de", { kind: "about" }],
    ["/es/contact", "/es/contacto", { kind: "contact" }],
    [
      "/es/events/category/music",
      "/es/eventos/categoria/music",
      { kind: "category", slug: "music" },
    ],
    [
      "/es/events/category/music/nashville-tn",
      "/es/eventos/categoria/music/nashville-tn",
      { kind: "cityCategory", slug: "music", city: "nashville-tn" },
    ],
  ] as const)("%s → %s", (from, to, page) => {
    expect(parseMisworded(from)).toEqual({ locale: "es", page, path: to });
  });

  it.each([
    "/es",
    "/es/acerca-de",
    "/es/eventos/categoria/musica",
    "/about",
    "/events/category/music",
    "/es/eventos/category/music",
    "/es/whatever",
    "/esports/about",
  ])("leaves %s alone", (path) => {
    expect(parseMisworded(path)).toBeNull();
  });
});

describe("englishFirstPath (R5, R22)", () => {
  it.each([
    "/",
    "/events/category/music",
    "/events/category/music/nashville-tn",
    "/about",
    "/contact",
    "/events/us/nashville/some-show",
    "/events/next.js-meetup",
    "/events/checkout-collective/us/nashville/gig",
    "/places/the-basement",
    "/places/id/abc",
    "/orgs/some-org",
    "/humans/someone",
    "/p/some-page",
    "/p/some-page/acts",
    "/privacy",
    "/terms",
    "/acceptable-use",
    "/cookie-policy",
  ])("%s is English from the first byte", (path) => {
    expect(englishFirstPath(path)).toBe(true);
    expect(urlLocaleForPath(path)).toBe("en");
  });

  it.each([
    "/search",
    "/help",
    "/help/getting-started",
    "/account/settings",
    "/admin/some-org",
    "/platform/categories",
    "/moderate",
    "/my-tickets",
    "/events/checkout/some-show",
    "/events/checkout",
    "/events/resale/abc",
    "/sign-in",
    "/embed/abc",
    "/aboutus",
    "/places-to-go",
    "/orgsx",
    "/pages",
    "/esports",
  ])("%s keeps the viewer's language", (path) => {
    expect(englishFirstPath(path)).toBe(false);
    expect(urlLocaleForPath(path)).toBeNull();
  });

  it.each([
    "/es",
    "/es/eventos/categoria/musica",
    "/es/acerca-de",
    "/es/about",
    "/es/not-a-page",
  ])("%s is not English-first; its URL says Spanish", (path) => {
    expect(englishFirstPath(path)).toBe(false);
    expect(urlLocaleForPath(path)).toBe("es");
  });

  it("tells twinless pages from R1 pages", () => {
    expect(isTwinlessEnglishFirstPath("/events/us/nashville/show")).toBe(true);
    expect(isTwinlessEnglishFirstPath("/places/x")).toBe(true);
    expect(isTwinlessEnglishFirstPath("/events/category/music")).toBe(false);
    expect(isTwinlessEnglishFirstPath("/")).toBe(false);
    expect(isTwinlessEnglishFirstPath("/search")).toBe(false);
  });
});

describe("builder locale defaults", () => {
  it("shares the default locale with @th/types", () => {
    expect(DEFAULT_PUBLIC_LOCALE).toBe(DEFAULT_LOCALE);
  });
});

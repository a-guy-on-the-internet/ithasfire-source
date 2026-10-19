/**
 * The server picks the first-paint language. Before the `th-locale` cookie it
 * read only Accept-Language, so someone who chose Español on an English
 * browser got an English first paint that flipped after hydration, and the
 * server-rendered Help Center never followed the choice at all.
 */
import { describe, expect, it } from "vitest";

import { routeContextForPath } from "@/lib/route-context";

import {
  pickServerLocale,
  resolveLocale,
  resolveLocaleFromHeader,
} from "../resolve-locale";

describe("resolveLocale", () => {
  it("lets a supported cookie beat Accept-Language", () => {
    expect(
      resolveLocale({ cookie: "es", acceptLanguage: "en-US,en;q=0.9" }),
    ).toBe("es");
    expect(
      resolveLocale({ cookie: "en", acceptLanguage: "es-MX,es;q=0.9" }),
    ).toBe("en");
  });

  it("ignores an unsupported or garbage cookie and falls back to the header", () => {
    // The header resolves to "en", so a near-miss "es" cookie that was wrongly
    // trusted would show up as "es".
    for (const cookie of ["fr", "ES", "es-MX", "", "<script>", " es", "es "]) {
      expect(resolveLocale({ cookie, acceptLanguage: "en-US,en;q=0.9" })).toBe(
        "en",
      );
    }
  });

  it("uses Accept-Language when there is no cookie", () => {
    expect(
      resolveLocale({ cookie: undefined, acceptLanguage: "fr-FR,es;q=0.8" }),
    ).toBe("es");
    expect(resolveLocale({ cookie: null, acceptLanguage: "en-GB" })).toBe(
      "en",
    );
  });

  it("falls back to the default with neither", () => {
    expect(resolveLocale({ cookie: undefined, acceptLanguage: null })).toBe(
      "en",
    );
    expect(resolveLocale({ cookie: "xx", acceptLanguage: "de-DE" })).toBe(
      "en",
    );
  });
});

describe("resolveLocaleFromHeader", () => {
  it("returns the first supported language in preference order", () => {
    expect(resolveLocaleFromHeader("de-DE,es;q=0.9,en;q=0.8")).toBe("es");
    expect(resolveLocaleFromHeader(null)).toBe("en");
  });
});

/**
 * Spanish SEO FR-002 and the spec risk "narrowing must not flip app pages":
 * public pages take the URL's language whatever the cookie and header say;
 * every other route keeps cookie > Accept-Language > default. Driven from the
 * path through routeContextForPath, the same function middleware uses.
 */
describe("pickServerLocale", () => {
  const spanishReader = { cookie: "es", acceptLanguage: "es-MX,es;q=0.9" };
  const englishReader = { cookie: "en", acceptLanguage: "en-US,en;q=0.9" };
  const pick = (
    path: string,
    reader: { cookie: string | undefined; acceptLanguage: string | null },
  ) => pickServerLocale({ routeContext: routeContextForPath(path), ...reader });

  it.each([
    "/",
    "/events/category/music",
    "/events/category/music/nashville-tn",
    "/about",
    "/contact",
    "/events/us/nashville/some-show",
    "/places/the-basement",
    "/orgs/some-org",
    "/p/some-page",
  ])("renders English-first page %s in English for a Spanish reader", (path) => {
    expect(pick(path, spanishReader)).toBe("en");
    expect(pick(path, { cookie: undefined, acceptLanguage: "es" })).toBe("en");
  });

  it.each([
    "/es",
    "/es/eventos/categoria/musica",
    "/es/eventos/categoria/musica/nashville-tn",
    "/es/acerca-de",
    "/es/contacto",
  ])("renders %s in Spanish for an English reader", (path) => {
    expect(pick(path, englishReader)).toBe("es");
    expect(pick(path, { cookie: undefined, acceptLanguage: null })).toBe("es");
  });

  it.each([
    "/search",
    "/account/settings",
    "/admin/some-org",
    "/platform/categories",
    "/help/getting-started",
    "/events/checkout/some-show",
    "/events/resale/abc",
    "/my-tickets",
    "/embed/abc",
  ])("keeps the cookie > Accept-Language pick on %s", (path) => {
    expect(pick(path, spanishReader)).toBe("es");
    expect(pick(path, englishReader)).toBe("en");
    expect(pick(path, { cookie: undefined, acceptLanguage: "es" })).toBe("es");
    expect(pick(path, { cookie: undefined, acceptLanguage: null })).toBe("en");
  });

  it("falls back to the viewer's pick when the context is absent", () => {
    expect(
      pickServerLocale({ routeContext: null, ...spanishReader }),
    ).toBe("es");
  });
});

/**
 * Client language rules on public pages (Spanish SEO R5, R6, R22, FR-003):
 * the URL wins on /es/, English R1 pages never flip in place, twinless public
 * pages follow an explicit choice only, app pages are unchanged; the move
 * needs an explicit choice and an indexable twin.
 */
import { describe, expect, it } from "vitest";

import {
  clientLocaleForPath,
  currentPageTwins,
  pathLanguage,
  twinMoveTarget,
  type PublicTwinSet,
} from "../client-locale";

const EN = "/events/category/music";
const ES = "/es/eventos/categoria/musica";
const twins: PublicTwinSet = {
  en: { path: EN, indexable: true },
  es: { path: ES, indexable: true },
};
const noindexEs: PublicTwinSet = {
  en: { path: EN, indexable: true },
  es: { path: "/es/eventos/categoria/music", indexable: false },
};

describe("pathLanguage", () => {
  it.each([
    ["/es", { kind: "url", locale: "es" }],
    [ES, { kind: "url", locale: "es" }],
    ["/es/about", { kind: "url", locale: "es" }],
    ["/", { kind: "twinned" }],
    [EN, { kind: "twinned" }],
    ["/contact", { kind: "twinned" }],
    ["/events/us/nashville/show", { kind: "twinless" }],
    ["/places/x", { kind: "twinless" }],
    ["/orgs/x", { kind: "twinless" }],
    ["/search", { kind: "app" }],
    ["/events/checkout/x", { kind: "app" }],
  ] as const)("%s → %o", (path, expected) => {
    expect(pathLanguage(path)).toEqual(expected);
  });
});

describe("clientLocaleForPath", () => {
  const all = [
    { explicit: undefined, navigatorLocale: undefined },
    { explicit: "en", navigatorLocale: "es" },
    { explicit: "es", navigatorLocale: "en" },
    { explicit: undefined, navigatorLocale: "es" },
  ] as const;

  it.each(all)("/es/ pages stay Spanish (%o)", (reader) => {
    expect(clientLocaleForPath(ES, reader)).toBe("es");
  });

  it.each(all)("English R1 pages stay English (%o)", (reader) => {
    expect(clientLocaleForPath(EN, reader)).toBe("en");
    expect(clientLocaleForPath("/", reader)).toBe("en");
  });

  it("twinless pages follow an explicit choice only (R22)", () => {
    const event = "/events/us/nashville/show";
    expect(
      clientLocaleForPath(event, { explicit: "es", navigatorLocale: "en" }),
    ).toBe("es");
    expect(
      clientLocaleForPath(event, {
        explicit: undefined,
        navigatorLocale: "es",
      }),
    ).toBe("en");
  });

  it("app pages keep explicit > navigator > default", () => {
    expect(
      clientLocaleForPath("/search", { explicit: "en", navigatorLocale: "es" }),
    ).toBe("en");
    expect(
      clientLocaleForPath("/search", {
        explicit: undefined,
        navigatorLocale: "es",
      }),
    ).toBe("es");
    expect(
      clientLocaleForPath("/search", {
        explicit: undefined,
        navigatorLocale: undefined,
      }),
    ).toBe("en");
  });
});

describe("currentPageTwins", () => {
  it("returns the set only when it belongs to the page in view", () => {
    expect(currentPageTwins(twins, EN)).toBe(twins);
    expect(currentPageTwins(twins, ES)).toBe(twins);
    expect(currentPageTwins(twins, "/events/category/film")).toBeNull();
    expect(currentPageTwins(twins, "/search")).toBeNull();
    expect(currentPageTwins(null, EN)).toBeNull();
  });
});

describe("twinMoveTarget (FR-003)", () => {
  it("moves an explicit Spanish chooser to the indexable twin", () => {
    expect(twinMoveTarget({ pathname: EN, twins, explicit: "es" })).toBe(ES);
  });

  it.each([
    ["no choice", { pathname: EN, twins, explicit: undefined }],
    ["chose English", { pathname: EN, twins, explicit: "en" }],
    ["noindex twin", { pathname: EN, twins: noindexEs, explicit: "es" }],
    ["no twins", { pathname: EN, twins: null, explicit: "es" }],
    ["already on /es/", { pathname: ES, twins, explicit: "es" }],
    ["stale set", { pathname: "/about", twins, explicit: "es" }],
  ] as const)("does not move: %s", (_label, input) => {
    expect(twinMoveTarget(input)).toBeNull();
  });
});

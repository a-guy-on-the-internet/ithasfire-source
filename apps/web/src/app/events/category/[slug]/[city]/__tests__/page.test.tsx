// @vitest-environment node
// node: the pages read the server-only catalog translator (i18n/server-translator.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route shell for `/events/category/[slug]/[city]`. Pins: a non-canonical
 * city segment (region-less, mixed case) PERMANENT-redirects to the canonical
 * one; the canonical segment renders without a redirect (no loop); a city
 * whose matches span several regions keeps its region-less segment; unknown
 * and empty combos 404 before any redirect.
 */

class NotFoundSignal extends Error {}
class PermanentRedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`permanent-redirect:${to}`);
  }
}

const mocks = vi.hoisted(() => ({
  loadGeoCategoryEvents: vi.fn(),
  resolveCategoryRoute: vi.fn(),
}));

vi.mock("@/server/categories", () => ({
  resolveCategoryRoute: mocks.resolveCategoryRoute,
}));

vi.mock("@/i18n", () => ({
  PublicTwins: () => null,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
  permanentRedirect: (to: string) => {
    throw new PermanentRedirectSignal(to);
  },
}));

vi.mock("@/server/events", () => ({
  loadGeoCategoryEvents: mocks.loadGeoCategoryEvents,
}));

vi.mock("@/config/site", () => ({
  buildCanonicalUrl: (path: string) => `https://ithasfire.com${path}`,
  getSiteName: () => "Ithas Fire",
  getSiteUrl: () => "https://ithasfire.com",
}));

vi.mock("@/components/seo/BreadcrumbJsonLd", () => ({
  BreadcrumbJsonLd: () => null,
}));
vi.mock("@/components/seo/EventListJsonLd", () => ({
  EventListJsonLd: () => null,
}));
vi.mock("../_components/GeoCategoryPage", () => ({
  GeoCategoryPage: () => null,
}));

import type { ReactElement } from "react";

import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { PublicTwins } from "@/i18n";

import GeoCategoryRoute, { generateMetadata } from "../page";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    events: [{ id: "e1", slug: "us/tn/open-mic--abc", title: "Open Mic" }],
    total: 1,
    indexableTotal: 1,
    categoryName: "Open Mics",
    cityLabel: "Nashville",
    regionCode: "tn",
    ...overrides,
  };
}

function render(city: string, slug = "open-mics") {
  return GeoCategoryRoute({ params: Promise.resolve({ slug, city }) });
}

beforeEach(() => {
  mocks.loadGeoCategoryEvents.mockReset();
  mocks.resolveCategoryRoute.mockReset();
  // The URL slug is the English page slug; the Spanish page is `<slug>-es`.
  mocks.resolveCategoryRoute.mockImplementation(
    async (_locale: string, slug: string) => ({
      kind: "render",
      slugs: { en: slug, es: `${slug}-es` },
    }),
  );
});

describe("/events/category/[slug]/[city]", () => {
  it("308s a region-less segment to the region the use case resolved", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(payload());

    await expect(render("nashville")).rejects.toMatchObject({
      to: "/events/category/open-mics/nashville-tn",
    });
  });

  it("308s a mixed-case segment to its lowercase canonical", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(payload());

    await expect(render("Nashville-TN")).rejects.toMatchObject({
      to: "/events/category/open-mics/nashville-tn",
    });
  });

  it("renders the canonical segment without redirecting (no loop)", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(payload());

    await expect(render("nashville-tn")).resolves.toBeTruthy();
    expect(mocks.loadGeoCategoryEvents).toHaveBeenCalledWith(
      "open-mics",
      "nashville-tn",
    );
  });

  it("keeps the region-less segment when the city spans several regions", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      payload({ cityLabel: "Portland", regionCode: null, total: 2 }),
    );

    await expect(render("portland")).resolves.toBeTruthy();
  });

  it("404s an unknown category before any redirect", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(null);

    await expect(render("nashville", "no-such-category")).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });

  it("404s an empty combo before any redirect", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      payload({ events: [], total: 0 }),
    );

    await expect(render("nashville")).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("points the canonical link at the region form", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(payload());

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "open-mics", city: "nashville" }),
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://ithasfire.com/events/category/open-mics/nashville-tn",
    );
  });
});

describe("/events/category/[slug]/[city] robots (owner ruling 2026-10-13)", () => {
  const metadataFor = async (overrides: Record<string, unknown>) => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(payload(overrides));
    return generateMetadata({
      params: Promise.resolve({ slug: "open-mics", city: "nashville-tn" }),
    });
  };
  const threeEvents = [
    { id: "e1", slug: "us/tn/a--1", title: "A" },
    { id: "e2", slug: "us/tn/b--2", title: "B" },
    { id: "e3", slug: "us/tn/c--3", title: "C", gateType: "PASSWORD" },
  ];

  it("is noindex, follow when gated events lift the listed count over the threshold", async () => {
    // 3 listed, 1 gated: 2 ungated, below MIN_EVENTS_PER_GEO_CATEGORY_PAGE.
    const metadata = await metadataFor({
      events: threeEvents,
      total: 3,
      indexableTotal: 2,
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    // The description still counts every listed event.
    expect(metadata.description).toContain("Discover 3 upcoming");
  });

  it("indexes when the ungated events alone reach the threshold", async () => {
    const metadata = await metadataFor({
      events: threeEvents,
      total: 4,
      indexableTotal: 3,
    });

    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("still renders a page whose events are all gated (listing unchanged)", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      payload({
        events: threeEvents.map((e) => ({ ...e, gateType: "PASSWORD" })),
        total: 3,
        indexableTotal: 0,
      }),
    );

    await expect(render("nashville-tn")).resolves.toBeTruthy();
  });
});

describe("/events/category/[slug]/[city] ItemList", () => {
  it("leaves gated events out of the ItemList (their pages are noindex)", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      payload({
        events: [
          { id: "e1", slug: "us/tn/open--a", title: "Open Mic" },
          {
            id: "e2",
            slug: "us/tn/pw--b",
            title: "Password Show",
            gateType: "PASSWORD",
          },
          {
            id: "e3",
            slug: "us/tn/app--c",
            title: "Apply Show",
            gateType: "APPLICATION",
          },
          { id: "e4", slug: null, title: "Slugless" },
        ],
        total: 4,
        indexableTotal: 2,
      }),
    );

    const tree = (await render("nashville-tn")) as ReactElement;
    const children = (tree.props as { children: ReactElement[] }).children;
    const itemList = [children]
      .flat()
      .find((c) => c && c.type === EventListJsonLd) as
      | ReactElement<{ items: Array<{ url: string; name: string }> }>
      | undefined;

    expect(itemList?.props.items).toEqual([
      {
        url: "https://ithasfire.com/events/us/tn/open--a",
        name: "Open Mic",
      },
    ]);
  });
});

describe("/events/category/[slug]/[city] language twins (spanish-seo)", () => {
  const fourEvents = [1, 2, 3, 4].map((i) => ({
    id: `e${i}`,
    slug: `us/tn/e--${i}`,
    title: `E${i}`,
  }));
  const indexable = (names: Record<string, string>) =>
    payload({ events: fourEvents, total: 4, indexableTotal: 4, names });

  it("lists en, es and x-default when both twins are indexable", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      indexable({ en: "Open Mics", es: "Micrófonos abiertos" }),
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "open-mics", city: "nashville" }),
    });

    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics/nashville-tn",
      languages: {
        en: "https://ithasfire.com/events/category/open-mics/nashville-tn",
        es: "https://ithasfire.com/es/eventos/categoria/open-mics-es/nashville-tn",
        "x-default":
          "https://ithasfire.com/events/category/open-mics/nashville-tn",
      },
    });
    expect(metadata.title).toBe("Open Mics in Nashville");
    expect(metadata.description).toBe(
      "Discover 4 upcoming open mics events in Nashville \u2014 find dates, places, and how to attend.",
    );
  });

  it("lists no alternates when the category has no Spanish name (R9)", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      indexable({ en: "Open Mics" }),
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "open-mics", city: "nashville-tn" }),
    });

    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics/nashville-tn",
    });
  });

  it("lists no alternates on a thin page", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      payload({ names: { en: "Open Mics", es: "Micrófonos abiertos" } }),
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "open-mics", city: "nashville-tn" }),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics/nashville-tn",
    });
  });

  it("308s an old or Spanish slug to the English page, keeping the city", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "redirect",
      slug: "music",
    });

    await expect(render("Nashville", "musica")).rejects.toMatchObject({
      to: "/events/category/music/Nashville",
    });
    expect(mocks.loadGeoCategoryEvents).not.toHaveBeenCalled();
  });

  it("404s a slug no category has", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({ kind: "notFound" });

    await expect(render("nashville-tn", "nope")).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });

  it("registers both twins at the canonical city segment", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      indexable({ en: "Open Mics", es: "Micrófonos abiertos" }),
    );

    const tree = (await render("nashville-tn")) as ReactElement;
    const children = (tree.props as { children: ReactElement[] }).children;
    const twins = [children]
      .flat()
      .find((c) => c && c.type === PublicTwins) as
      | ReactElement<{ twins: unknown }>
      | undefined;

    expect(twins?.props.twins).toEqual({
      en: { path: "/events/category/open-mics/nashville-tn", indexable: true },
      es: {
        path: "/es/eventos/categoria/open-mics-es/nashville-tn",
        indexable: true,
      },
    });
  });
});

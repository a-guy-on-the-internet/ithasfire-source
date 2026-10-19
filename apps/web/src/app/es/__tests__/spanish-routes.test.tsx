// @vitest-environment node
// node: the pages read the server-only catalog translator (i18n/server-translator.ts).
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Spanish twins (spanish-seo FR-001, FR-005, FR-010, R9, R16). Pins: each
 * /es/ route renders the English page's loader and components with Spanish
 * metadata, a self-canonical and reciprocal hreflang only when both twins are
 * indexable; slugs resolve in Spanish first and 308 within /es/; an unknown or
 * INACTIVE category 404s; English path words under /es/ 308 to Spanish ones.
 */

class NotFoundSignal extends Error {}
class PermanentRedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`permanent-redirect:${to}`);
  }
}

const mocks = vi.hoisted(() => ({
  resolveCategoryRoute: vi.fn(),
  loadCategoryPageEvents: vi.fn(),
  loadGeoCategoryEvents: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
  permanentRedirect: (to: string) => {
    throw new PermanentRedirectSignal(to);
  },
}));
vi.mock("@/server/categories", () => ({
  resolveCategoryRoute: mocks.resolveCategoryRoute,
}));
vi.mock("@/server/events", () => ({
  loadCategoryPageEvents: mocks.loadCategoryPageEvents,
  loadGeoCategoryEvents: mocks.loadGeoCategoryEvents,
}));
vi.mock("@/server/home-discovery", () => ({
  prefetchHomeDiscovery: async () => ({}),
  hydrateHomeDiscovery: () => {},
  HOME_SSR_COUNTRY: "US",
}));
vi.mock("@/config/site", () => ({
  buildCanonicalUrl: (path: string) => `https://ithasfire.com${path}`,
  getSiteName: () => "Ithas Fire",
  getSiteUrl: () => "https://ithasfire.com",
}));
vi.mock("@/i18n", () => ({ PublicTwins: () => null }));
vi.mock("@/components/seo/BreadcrumbJsonLd", () => ({
  BreadcrumbJsonLd: () => null,
}));
vi.mock("@/components/seo/EventListJsonLd", () => ({
  EventListJsonLd: () => null,
}));
vi.mock("@/components/seo/WebSiteJsonLd", () => ({
  WebSiteJsonLd: () => null,
}));
vi.mock("@/app/events/category/[slug]/_components/CategoryPage", () => ({
  CategoryPage: () => null,
}));
vi.mock(
  "@/app/events/category/[slug]/[city]/_components/GeoCategoryPage",
  () => ({
    GeoCategoryPage: () => null,
  }),
);
vi.mock("@/app/_components/HomeGatedLayout", () => ({
  HomeGatedLayout: () => null,
}));
vi.mock("@/app/about/_components/AboutContent", () => ({
  AboutContent: () => null,
}));
vi.mock("@/app/contact/_components/ContactContent", () => ({
  ContactContent: () => null,
}));

import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { WebSiteJsonLd } from "@/components/seo/WebSiteJsonLd";
import { PublicTwins } from "@/i18n";
import { CategoryPage } from "@/app/events/category/[slug]/_components/CategoryPage";
import { GeoCategoryPage } from "@/app/events/category/[slug]/[city]/_components/GeoCategoryPage";

import SpanishCategoryRoute, {
  generateMetadata as categoryMetadata,
} from "../eventos/categoria/[slug]/page";
import SpanishGeoRoute, {
  generateMetadata as geoMetadata,
} from "../eventos/categoria/[slug]/[city]/page";
import SpanishHome, { generateMetadata as homeMetadata } from "../page";
import SpanishAbout, { metadata as aboutMetadata } from "../acerca-de/page";
import SpanishContact, { metadata as contactMetadata } from "../contacto/page";
import { generateMetadata as englishHomeMetadata } from "../../page";
import { metadata as englishAboutMetadata } from "../../about/page";
import { metadata as englishContactMetadata } from "../../contact/page";
import SpanishFallbackRoute from "../[...rest]/page";

const SITE = "https://ithasfire.com";

/** Render a function component element one level (it takes no props here). */
const expand = (el: ReactElement): ReactElement =>
  (el.type as () => ReactElement)();

/** The fragment's children, found by component. */
function childOf(tree: ReactElement, type: unknown) {
  const children = (tree.props as { children: ReactElement[] }).children;
  return [children].flat().find((c) => c && c.type === type) as
    | ReactElement<Record<string, unknown>>
    | undefined;
}

const NAMES = { en: "Open Mics", es: "Micrófonos abiertos" };

function categoryLoad(overrides: Record<string, unknown> = {}) {
  return {
    status: "found" as const,
    categoryName: "Open Mics",
    categoryNames: NAMES,
    total: 1,
    indexableTotal: 1,
    seed: {
      search: null,
      db: {
        events: [{ id: "e1", slug: "us/tn/open-mic--a", title: "Open Mic" }],
        total: 1,
        indexableTotal: 1,
      },
      fetchedAt: "2026-10-17T12:00:00.000Z",
    },
    ...overrides,
  };
}

const fourEvents = [1, 2, 3, 4].map((i) => ({
  id: `e${i}`,
  slug: `us/tn/e--${i}`,
  title: `E${i}`,
}));

function geoPayload(overrides: Record<string, unknown> = {}) {
  return {
    events: fourEvents,
    total: 4,
    indexableTotal: 4,
    categoryName: "Open Mics",
    names: NAMES,
    cityLabel: "Nashville",
    regionCode: "tn",
    ...overrides,
  };
}

const categoryParams = (slug = "microfonos-abiertos") => ({
  params: Promise.resolve({ slug }),
});
const geoParams = (city = "nashville-tn", slug = "microfonos-abiertos") => ({
  params: Promise.resolve({ slug, city }),
});

beforeEach(() => {
  mocks.resolveCategoryRoute.mockReset();
  mocks.loadCategoryPageEvents.mockReset();
  mocks.loadGeoCategoryEvents.mockReset();
  mocks.resolveCategoryRoute.mockResolvedValue({
    kind: "render",
    slugs: { es: "microfonos-abiertos", en: "open-mics" },
  });
});

describe("/es/eventos/categoria/[slug]", () => {
  it("has Spanish metadata, a self-canonical and reciprocal hreflang", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(categoryLoad());

    const meta = await categoryMetadata(categoryParams());

    expect(mocks.resolveCategoryRoute).toHaveBeenCalledWith(
      "es",
      "microfonos-abiertos",
    );
    // The events load by the English slug.
    expect(mocks.loadCategoryPageEvents).toHaveBeenCalledWith("open-mics");
    expect(meta.title).toBe("Micrófonos abiertos");
    expect(meta.description).toBe(
      "Encuentra eventos de micrófonos abiertos cerca de ti.",
    );
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
      languages: {
        en: `${SITE}/events/category/open-mics`,
        es: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
        "x-default": `${SITE}/events/category/open-mics`,
      },
    });
    expect(meta.openGraph).toMatchObject({
      url: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
      title: "Micrófonos abiertos • Ithas Fire",
      description: "Encuentra eventos de micrófonos abiertos cerca de ti.",
    });
    expect(meta.twitter).toMatchObject({
      title: "Micrófonos abiertos • Ithas Fire",
    });
  });

  it("renders the English page's component by the English slug, JSON-LD in Spanish", async () => {
    const load = categoryLoad();
    mocks.loadCategoryPageEvents.mockResolvedValue(load);

    const tree = (await SpanishCategoryRoute(categoryParams())) as ReactElement;

    expect(childOf(tree, CategoryPage)?.props).toMatchObject({
      categorySlug: "open-mics",
      initialCategoryNames: NAMES,
      seed: load.seed,
    });
    expect(childOf(tree, EventListJsonLd)?.props).toEqual({
      items: [{ url: `${SITE}/events/us/tn/open-mic--a`, name: "Open Mic" }],
      inLanguage: "es",
    });
    expect(childOf(tree, BreadcrumbJsonLd)?.props).toEqual({
      items: [
        { name: "Inicio", url: `${SITE}/es` },
        { name: "Eventos", url: `${SITE}/search` },
        { name: "Micrófonos abiertos" },
      ],
      inLanguage: "es",
    });
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics", indexable: true },
      es: {
        path: "/es/eventos/categoria/microfonos-abiertos",
        indexable: true,
      },
    });
  });

  it("is noindex with no hreflang when the category has no Spanish name (R9)", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "render",
      slugs: { es: "open-mics", en: "open-mics" },
    });
    mocks.loadCategoryPageEvents.mockResolvedValue(
      categoryLoad({ categoryNames: { en: "Open Mics" } }),
    );

    const meta = await categoryMetadata(categoryParams("open-mics"));
    const tree = (await SpanishCategoryRoute(
      categoryParams("open-mics"),
    )) as ReactElement;

    // Still renders, with the English name.
    expect(meta.title).toBe("Open Mics");
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/open-mics`,
    });
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics", indexable: true },
      es: { path: "/es/eventos/categoria/open-mics", indexable: false },
    });
  });

  it("is noindex with no hreflang on a thin page", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      categoryLoad({ indexableTotal: 0 }),
    );

    const meta = await categoryMetadata(categoryParams());

    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
    });
  });

  it("308s an old Spanish slug to the current one", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "redirect",
      slug: "microfonos-abiertos",
    });

    await expect(
      SpanishCategoryRoute(categoryParams("micros")),
    ).rejects.toMatchObject({
      to: "/es/eventos/categoria/microfonos-abiertos",
    });
    await expect(
      categoryMetadata(categoryParams("micros")),
    ).rejects.toMatchObject({
      to: "/es/eventos/categoria/microfonos-abiertos",
    });
    expect(mocks.loadCategoryPageEvents).not.toHaveBeenCalled();
  });

  it("308s an English slug under /es/ to the Spanish page", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "redirect",
      slug: "musica",
    });

    await expect(
      SpanishCategoryRoute(categoryParams("music")),
    ).rejects.toMatchObject({ to: "/es/eventos/categoria/musica" });
    expect(mocks.resolveCategoryRoute).toHaveBeenCalledWith("es", "music");
  });

  it("404s a slug no category has", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({ kind: "notFound" });

    await expect(
      SpanishCategoryRoute(categoryParams("nope")),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    const meta = await categoryMetadata(categoryParams("nope"));
    expect(meta).toEqual({
      title: "No encontrado",
      robots: { index: false, follow: false },
    });
  });

  it("404s an INACTIVE category (the resolver does not check active)", async () => {
    // The resolver renders it; the English-slug loader says not-found.
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "not-found" });

    await expect(SpanishCategoryRoute(categoryParams())).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    const meta = await categoryMetadata(categoryParams());
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("is noindex with no hreflang when the category names are unknown (list read failed)", async () => {
    const load = categoryLoad();
    delete (load as { categoryNames?: unknown }).categoryNames;
    mocks.loadCategoryPageEvents.mockResolvedValue(load);

    const meta = await categoryMetadata(categoryParams());
    const tree = (await SpanishCategoryRoute(categoryParams())) as ReactElement;

    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
    });
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics", indexable: true },
      es: {
        path: "/es/eventos/categoria/microfonos-abiertos",
        indexable: false,
      },
    });
  });

  it("throws the resolver's own error when it is down (nothing to load by)", async () => {
    const boom = new Error("api down");
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "unavailable",
      error: boom,
    });

    await expect(SpanishCategoryRoute(categoryParams())).rejects.toBe(boom);
    expect(mocks.loadCategoryPageEvents).not.toHaveBeenCalled();
  });
});

describe("/es/eventos/categoria/[slug]/[city]", () => {
  it("has Spanish metadata, a self-canonical and reciprocal hreflang", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(geoPayload());

    const meta = await geoMetadata(geoParams());

    expect(mocks.loadGeoCategoryEvents).toHaveBeenCalledWith(
      "open-mics",
      "nashville-tn",
    );
    expect(meta.title).toBe("Micrófonos abiertos en Nashville");
    expect(meta.description).toBe(
      "Descubre 4 eventos de micrófonos abiertos en Nashville: fechas, lugares y cómo asistir.",
    );
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos/nashville-tn`,
      languages: {
        en: `${SITE}/events/category/open-mics/nashville-tn`,
        es: `${SITE}/es/eventos/categoria/microfonos-abiertos/nashville-tn`,
        "x-default": `${SITE}/events/category/open-mics/nashville-tn`,
      },
    });
  });

  it("is noindex with no hreflang when the category has no Spanish name (R9)", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      geoPayload({ names: { en: "Open Mics" } }),
    );

    const meta = await geoMetadata(geoParams());

    expect(meta.title).toBe("Open Mics en Nashville");
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos/nashville-tn`,
    });
  });

  it("is noindex with no hreflang on a thin page", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(
      geoPayload({
        total: 1,
        indexableTotal: 1,
        events: fourEvents.slice(0, 1),
      }),
    );

    const meta = await geoMetadata(geoParams());

    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.description).toBe(
      "Descubre un evento de micrófonos abiertos en Nashville: fecha, lugar y cómo asistir.",
    );
    expect(meta.alternates).toEqual({
      canonical: `${SITE}/es/eventos/categoria/microfonos-abiertos/nashville-tn`,
    });
  });

  it("renders with Spanish crumbs pointing at /es/ pages", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(geoPayload());

    const tree = (await SpanishGeoRoute(geoParams())) as ReactElement;

    expect(childOf(tree, GeoCategoryPage)?.props).toMatchObject({
      categoryNames: NAMES,
      cityLabel: "Nashville",
    });
    expect(childOf(tree, BreadcrumbJsonLd)?.props).toEqual({
      items: [
        { name: "Inicio", url: `${SITE}/es` },
        { name: "Eventos", url: `${SITE}/search` },
        {
          name: "Micrófonos abiertos",
          url: `${SITE}/es/eventos/categoria/microfonos-abiertos`,
        },
        { name: "Nashville" },
      ],
      inLanguage: "es",
    });
    expect(childOf(tree, EventListJsonLd)?.props.inLanguage).toBe("es");
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics/nashville-tn", indexable: true },
      es: {
        path: "/es/eventos/categoria/microfonos-abiertos/nashville-tn",
        indexable: true,
      },
    });
  });

  it("308s a non-canonical city segment within /es/", async () => {
    mocks.loadGeoCategoryEvents.mockResolvedValue(geoPayload());

    await expect(SpanishGeoRoute(geoParams("nashville"))).rejects.toMatchObject(
      {
        to: "/es/eventos/categoria/microfonos-abiertos/nashville-tn",
      },
    );
  });

  it("308s an English slug to the Spanish page, keeping the city segment", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "redirect",
      slug: "microfonos-abiertos",
    });

    await expect(
      SpanishGeoRoute(geoParams("nashville", "open-mics")),
    ).rejects.toMatchObject({
      to: "/es/eventos/categoria/microfonos-abiertos/nashville",
    });
  });

  it("404s an unknown slug and an INACTIVE category", async () => {
    mocks.resolveCategoryRoute.mockResolvedValueOnce({ kind: "notFound" });
    await expect(SpanishGeoRoute(geoParams())).rejects.toBeInstanceOf(
      NotFoundSignal,
    );

    // Inactive: the resolver renders, the English-slug loader says null.
    mocks.loadGeoCategoryEvents.mockResolvedValue(null);
    await expect(SpanishGeoRoute(geoParams())).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });
});

describe("/es, /es/acerca-de, /es/contacto", () => {
  it("home: Spanish description, self-canonical, reciprocal hreflang", async () => {
    const es = homeMetadata();
    const en = englishHomeMetadata();

    expect(es.description).toBe(
      "Descubre, promociona y vende entradas para eventos inolvidables.",
    );
    expect(es.title).toBeUndefined();
    expect(es.openGraph).toMatchObject({
      url: `${SITE}/es`,
      description: "Hecho para comunidades.",
    });
    const languages = {
      en: `${SITE}/`,
      es: `${SITE}/es`,
      "x-default": `${SITE}/`,
    };
    expect(es.alternates).toEqual({ canonical: `${SITE}/es`, languages });
    expect(en.alternates).toEqual({ canonical: `${SITE}/`, languages });
    expect(en.description).toBe(
      "Discover, promote, and sell tickets for unforgettable events.",
    );

    const tree = (await SpanishHome()) as ReactElement;
    expect(childOf(tree, WebSiteJsonLd)?.props).toEqual({ inLanguage: "es" });
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/", indexable: true },
      es: { path: "/es", indexable: true },
    });
  });

  it("about: Spanish title and description, reciprocal hreflang", () => {
    expect(aboutMetadata.title).toBe("Acerca de");
    expect(aboutMetadata.description).toBe(
      "Conoce Ithas Fire y nuestra misión.",
    );
    const languages = {
      en: `${SITE}/about`,
      es: `${SITE}/es/acerca-de`,
      "x-default": `${SITE}/about`,
    };
    expect(aboutMetadata.alternates).toEqual({
      canonical: `${SITE}/es/acerca-de`,
      languages,
    });
    expect(englishAboutMetadata.title).toBe("About");
    expect(englishAboutMetadata.alternates).toEqual({
      canonical: `${SITE}/about`,
      languages,
    });
    expect(aboutMetadata.openGraph).toMatchObject({
      title: "Acerca de • Ithas Fire",
    });

    // The route renders the shared body; render that one level down.
    const tree = expand(SpanishAbout() as ReactElement);
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/about", indexable: true },
      es: { path: "/es/acerca-de", indexable: true },
    });
  });

  it("contact: Spanish title and description, reciprocal hreflang", () => {
    expect(contactMetadata.title).toBe("Contacto");
    expect(contactMetadata.description).toBe(
      "Ponte en contacto con el equipo de Ithas Fire.",
    );
    const languages = {
      en: `${SITE}/contact`,
      es: `${SITE}/es/contacto`,
      "x-default": `${SITE}/contact`,
    };
    expect(contactMetadata.alternates).toEqual({
      canonical: `${SITE}/es/contacto`,
      languages,
    });
    expect(englishContactMetadata.alternates).toEqual({
      canonical: `${SITE}/contact`,
      languages,
    });

    // The route renders the shared body; render that one level down.
    const tree = expand(SpanishContact() as ReactElement);
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/contact", indexable: true },
      es: { path: "/es/contacto", indexable: true },
    });
  });
});

describe("/es/[...rest] (English path words under /es/, R16)", () => {
  const visit = (...rest: string[]) =>
    SpanishFallbackRoute({ params: Promise.resolve({ rest }) });

  it.each([
    [["events", "category", "music"], "/es/eventos/categoria/music"],
    [
      ["events", "category", "music", "nashville-tn"],
      "/es/eventos/categoria/music/nashville-tn",
    ],
    [["about"], "/es/acerca-de"],
    [["contact"], "/es/contacto"],
  ])("308s %j to %s", async (rest, to) => {
    await expect(visit(...rest)).rejects.toMatchObject({ to });
  });

  it.each([
    [["nope"]],
    [["eventos"]],
    [["events", "category"]],
    [["events", "category", "music", "nashville-tn", "extra"]],
  ])("404s %j", async (rest) => {
    await expect(visit(...rest)).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

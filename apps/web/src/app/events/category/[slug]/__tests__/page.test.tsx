// @vitest-environment node
// node: the pages read the server-only catalog translator (i18n/server-translator.ts).
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route shell for `/events/category/[slug]`. Pins: the first page is read on
 * the server and handed to the client component as its seed; the ItemList
 * comes from the DB page and skips gated events; an empty category is
 * `noindex, follow` with its title unchanged; an unknown category 404s; a
 * failed read claims nothing and falls back to the client fetch.
 */

class NotFoundSignal extends Error {}

class PermanentRedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`permanent-redirect:${to}`);
  }
}

const mocks = vi.hoisted(() => ({
  loadCategoryPageEvents: vi.fn(),
  resolveCategoryRoute: vi.fn(),
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

vi.mock("@/i18n", () => ({
  PublicTwins: () => null,
}));

vi.mock("@/server/events", () => ({
  loadCategoryPageEvents: mocks.loadCategoryPageEvents,
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
vi.mock("../_components/CategoryPage", () => ({
  CategoryPage: () => null,
}));

import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { EventListJsonLd } from "@/components/seo/EventListJsonLd";
import { PublicTwins } from "@/i18n";
import { CategoryPage } from "../_components/CategoryPage";
import CategoryRoute, { generateMetadata } from "../page";

const dbEvent = (id: string, slug: string | null, title: string) => ({
  id,
  slug,
  title,
  date: "Sat, Oct 17, 8:00 PM",
  venue: "The Blue Room",
  priceLabel: "See details",
});

function found(overrides: Record<string, unknown> = {}) {
  return {
    status: "found" as const,
    categoryName: "Open Mics",
    total: 2,
    indexableTotal: 2,
    seed: {
      search: null,
      db: {
        events: [
          dbEvent("e1", "us/mn/open-mic--a", "First Open Mic"),
          dbEvent("e2", null, "Slugless"),
        ],
        total: 2,
        indexableTotal: 2,
      },
      fetchedAt: "2026-10-13T12:00:00.000Z",
    },
    ...overrides,
  };
}

const params = (slug = "open-mics") => ({ params: Promise.resolve({ slug }) });

/** The fragment's children, found by component. */
function childOf(tree: ReactElement, type: unknown) {
  const children = (tree.props as { children: ReactElement[] }).children;
  return [children].flat().find((c) => c && c.type === type) as
    | ReactElement<Record<string, unknown>>
    | undefined;
}

beforeEach(() => {
  mocks.loadCategoryPageEvents.mockReset();
  mocks.resolveCategoryRoute.mockReset();
  // The URL slug is the English page slug; the Spanish page is `<slug>-es`.
  mocks.resolveCategoryRoute.mockImplementation(
    async (_locale: string, slug: string) => ({
      kind: "render",
      slugs: { en: slug, es: `${slug}-es` },
    }),
  );
});

describe("/events/category/[slug] metadata", () => {
  it("indexes a category with upcoming events (no robots override)", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(found());

    const meta = await generateMetadata(params());

    expect(meta.title).toBe("Open Mics");
    expect(meta.robots).toBeUndefined();
  });

  it("titles the page with the category's display name, no \"Events\" suffix", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({ categoryName: "Improv Jams" }),
    );

    const meta = await generateMetadata(params("improv-jams-slug"));

    expect(meta.title).toBe("Improv Jams");
    expect(meta.description).toBe("Find upcoming improv jams near you.");
    expect(meta.openGraph?.title).toBe("Improv Jams \u2022 Ithas Fire");
    expect(meta.twitter?.title).toBe("Improv Jams \u2022 Ithas Fire");
  });

  it("treats a name equal to the slug (category list failed) as unknown", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({ categoryName: "open-mics" }),
    );

    const meta = await generateMetadata(params("open-mics"));
    expect(meta.title).toBe("Open Mics");
    expect(meta.description).toBe("Find upcoming open mics near you.");

    const tree = (await CategoryRoute(params("open-mics"))) as ReactElement;
    expect(childOf(tree, CategoryPage)?.props.initialCategoryName).toBe(
      "Open Mics",
    );
  });

  it("falls back to the title-cased slug when the name is unavailable", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "unavailable" });

    const meta = await generateMetadata(params("food-drink"));

    expect(meta.title).toBe("Food Drink");
    expect(meta.description).toBe("Find upcoming food drink near you.");
  });

  it("is noindex, follow when the category has no upcoming events, title unchanged", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({ total: 0, indexableTotal: 0 }),
    );

    const meta = await generateMetadata(params());

    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.title).toBe("Open Mics");
  });

  it("is noindex, follow when every upcoming event is gated (owner ruling 2026-10-13)", async () => {
    // Two gated events list on the page, none is ungated.
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({ total: 2, indexableTotal: 0 }),
    );

    const meta = await generateMetadata(params());

    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it("indexes when one upcoming event is ungated among gated ones", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({ total: 3, indexableTotal: 1 }),
    );

    const meta = await generateMetadata(params());

    expect(meta.robots).toBeUndefined();
  });

  it("claims nothing when the read failed", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "unavailable" });

    const meta = await generateMetadata(params());

    expect(meta.robots).toBeUndefined();
    expect(meta.title).toBe("Open Mics");
  });

  it("keeps an unknown category out of the index", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "not-found" });

    const meta = await generateMetadata(params("nope"));

    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe("/events/category/[slug] page", () => {
  it("hands the server read to the client component as its seed", async () => {
    const load = found();
    mocks.loadCategoryPageEvents.mockResolvedValue(load);

    const tree = (await CategoryRoute(params())) as ReactElement;

    const client = childOf(tree, CategoryPage);
    expect(client?.props).toEqual({
      categorySlug: "open-mics",
      initialCategoryName: "Open Mics",
      seed: load.seed,
    });
  });

  it("emits an ItemList of the DB events that have a slug", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(found());

    const tree = (await CategoryRoute(params())) as ReactElement;

    expect(childOf(tree, EventListJsonLd)?.props.items).toEqual([
      {
        url: "https://ithasfire.com/events/us/mn/open-mic--a",
        name: "First Open Mic",
      },
    ]);
    expect(childOf(tree, BreadcrumbJsonLd)?.props.items).toEqual([
      { name: "Home", url: "https://ithasfire.com" },
      { name: "Events", url: "https://ithasfire.com/search" },
      { name: "Open Mics" },
    ]);
  });

  it("leaves gated events out of the ItemList (their pages are noindex)", async () => {
    const base = found();
    mocks.loadCategoryPageEvents.mockResolvedValue({
      ...base,
      seed: {
        ...base.seed,
        db: {
          events: [
            { ...dbEvent("e3", "us/mn/pw--c", "Password Show"), gateType: "PASSWORD" },
            dbEvent("e1", "us/mn/open-mic--a", "First Open Mic"),
            { ...dbEvent("e4", "us/mn/app--d", "Apply Show"), gateType: "APPLICATION" },
          ],
          total: 3,
        },
      },
    });

    const tree = (await CategoryRoute(params())) as ReactElement;

    expect(
      (childOf(tree, EventListJsonLd)?.props.items as Array<{ name: string }>).map(
        (i) => i.name,
      ),
    ).toEqual(["First Open Mic"]);
  });

  it("builds the ItemList from the DB page even when search answered", async () => {
    // Search documents carry no gateType, so they cannot be the source.
    const base = found();
    mocks.loadCategoryPageEvents.mockResolvedValue({
      ...base,
      seed: {
        ...base.seed,
        search: {
          events: [dbEvent("e9", "us/mn/search-only--z", "Search Only")],
          latencyMs: 3,
        },
      },
    });

    const tree = (await CategoryRoute(params())) as ReactElement;

    expect(
      (childOf(tree, EventListJsonLd)?.props.items as Array<{ name: string }>).map(
        (i) => i.name,
      ),
    ).toEqual(["First Open Mic"]);
  });

  it("404s an unknown or inactive category", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "not-found" });

    await expect(CategoryRoute(params("nope"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });

  it("falls back to the client-only render when the read failed", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue({ status: "unavailable" });

    const tree = (await CategoryRoute(params())) as ReactElement;

    // No seed, but the heading still reads the title-cased slug, as the
    // metadata title does, rather than the raw "open-mics".
    expect(childOf(tree, CategoryPage)?.props).toEqual({
      categorySlug: "open-mics",
      initialCategoryName: "Open Mics",
    });
  });
});

describe("/events/category/[slug] language twins (spanish-seo)", () => {
  const withNames = (names: Record<string, string>) =>
    found({ categoryNames: names });

  it("lists en, es and x-default when the Spanish twin is indexable", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      withNames({ en: "Open Mics", es: "Micrófonos abiertos" }),
    );

    const meta = await generateMetadata(params());

    expect(meta.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics",
      languages: {
        en: "https://ithasfire.com/events/category/open-mics",
        es: "https://ithasfire.com/es/eventos/categoria/open-mics-es",
        "x-default": "https://ithasfire.com/events/category/open-mics",
      },
    });
    expect(meta.robots).toBeUndefined();
  });

  it("lists no alternates when the category has no Spanish name (R9)", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      withNames({ en: "Open Mics" }),
    );

    const meta = await generateMetadata(params());

    expect(meta.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics",
    });
    expect(meta.robots).toBeUndefined();
  });

  it("lists no alternates on a thin page", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      found({
        categoryNames: { en: "Open Mics", es: "Micrófonos abiertos" },
        indexableTotal: 0,
      }),
    );

    const meta = await generateMetadata(params());

    expect(meta.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics",
    });
  });

  it("registers both twins with their indexability", async () => {
    mocks.loadCategoryPageEvents.mockResolvedValue(
      withNames({ en: "Open Mics" }),
    );

    const tree = (await CategoryRoute(params())) as ReactElement;

    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics", indexable: true },
      es: { path: "/es/eventos/categoria/open-mics-es", indexable: false },
    });
  });

  it("308s an old or Spanish slug to the English page", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "redirect",
      slug: "music",
    });

    await expect(CategoryRoute(params("musica"))).rejects.toMatchObject({
      to: "/events/category/music",
    });
    expect(mocks.resolveCategoryRoute).toHaveBeenCalledWith("en", "musica");
    expect(mocks.loadCategoryPageEvents).not.toHaveBeenCalled();
  });

  it("404s a slug no category has, without loading", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({ kind: "notFound" });

    await expect(CategoryRoute(params("nope"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    const meta = await generateMetadata(params("nope"));
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(mocks.loadCategoryPageEvents).not.toHaveBeenCalled();
  });

  it("keeps rendering on the URL slug when the resolver is down, claiming no twin", async () => {
    mocks.resolveCategoryRoute.mockResolvedValue({
      kind: "unavailable",
      error: new Error("api down"),
    });
    mocks.loadCategoryPageEvents.mockResolvedValue(
      withNames({ en: "Open Mics", es: "Micrófonos abiertos" }),
    );

    const meta = await generateMetadata(params());
    const tree = (await CategoryRoute(params())) as ReactElement;

    expect(mocks.loadCategoryPageEvents).toHaveBeenCalledWith("open-mics");
    expect(meta.alternates).toEqual({
      canonical: "https://ithasfire.com/events/category/open-mics",
    });
    expect(childOf(tree, PublicTwins)?.props.twins).toEqual({
      en: { path: "/events/category/open-mics", indexable: true },
    });
  });
});

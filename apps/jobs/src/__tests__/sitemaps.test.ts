/**
 * Sitemap generation job — place URL correctness.
 *
 * The published sitemap is crawler-facing, so a URL in it that 404s is an
 * active SEO liability rather than a harmless gap. This job used to emit
 * `/p/{placeId}` — a RAW UUID — while the route resolves only on
 * `EntityPage.slug` and has no uuid fallback (it calls `notFound()`). Every
 * single place URL in the published sitemap therefore 404'd.
 *
 * These tests pin three things:
 *   · the emitted path is `/places/<pageSlug>` — the SAME variant every
 *     internal link uses (event venue badge, Spotlight, search results), not
 *     the `/p/` twin, which self-canonicalises separately and would split the
 *     signal across two indexable URLs per venue;
 *   · it is never a UUID;
 *   · places with no PUBLISHABLE page (missing, PRIVATE, or UNLISTED) are
 *     excluded rather than published.
 */
import { spawnSync } from "node:child_process";
import { describe, it, expect, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { makeCategoriesRepo } from "@th/adapters/db/prisma/categories";
import { makeEventsRepo } from "@th/adapters/db/prisma/events";
import { UNGATED_EVENT_SQL } from "@th/adapters/db/prisma/public-listed-event-where";

import { sitemapsGenerate } from "../jobs/sitemaps";

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const PLACE_WITH_PAGE = "00000000-0000-4000-8000-00000000b001";
const PLACE_WITHOUT_PAGE = "00000000-0000-4000-8000-00000000b002";

type SitemapRow = {
  placeId: string;
  pageSlug: string | null;
  pageVisibility: "PUBLIC" | "PRIVATE" | "UNLISTED" | null;
  updatedAt: Date | null;
};

/** A publishable row: has a page, and that page is PUBLIC. */
const publishable = (
  placeId: string,
  pageSlug: string,
  updatedAt: Date | null = null,
): SitemapRow => ({ placeId, pageSlug, pageVisibility: "PUBLIC", updatedAt });

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  seoType: string;
};

const category = (slug: string): CategoryRow => ({
  id: `cat-${slug}`,
  slug,
  name: slug,
  active: true,
  sortOrder: 0,
  seoType: "Event",
});

const JOB_NOW = new Date("2026-02-01T00:00:00.000Z");

function buildContext(
  places: SitemapRow[],
  categories: {
    /** Every active category, empty or not. */
    active?: CategoryRow[];
    /** The active categories with >=1 upcoming listed event. */
    withUpcoming?: CategoryRow[];
  } = {},
  extra: {
    /** Current Spanish slugs, by category id. */
    esSlugs?: Array<{ categoryId: string; slug: string }>;
    events?: Array<{ slug: string; updatedAt: Date | null }>;
    combos?: Array<{
      categorySlug: string;
      locality: string;
      regionCode: string;
      latestUpdatedAt: Date | null;
    }>;
  } = {},
) {
  const uploads: Array<{ key: string; xml: string }> = [];
  const reportError = vi.fn();

  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  };

  const fileStorage = {
    putObject: vi.fn(
      async ({ key, content }: { key: string; content: Buffer }) => {
        uploads.push({ key, xml: content.toString("utf-8") });
        return { url: `https://cdn.example/${key}` };
      },
    ),
  };

  const repos = {
    events: {
      // No events / categories / collections: this suite is about places, and
      // an empty section is simply skipped by the uploader.
      listPublishedForSitemap: vi.fn(async () => extra.events ?? []),
      enumerateGeoCategoryCombos: vi.fn(async () => extra.combos ?? []),
    },
    places: {
      listForSitemap: vi.fn(async () => places),
    },
    categories: {
      listActive: vi.fn(async () => categories.active ?? []),
      listActiveWithUpcomingEvents: vi.fn(
        async () => categories.withUpcoming ?? [],
      ),
      listCurrentSlugs: vi.fn(async () => extra.esSlugs ?? []),
    },
  };

  return {
    uploads,
    reportError,
    repos,
    ctx: {
      repos: repos as never,
      payments: {} as never,
      clock: { now: () => JOB_NOW },
      logger: logger as never,
      idempotency: {} as never,
      fileStorage: fileStorage as never,
      searchIndex: {} as never,
      multiSearch: null,
      reportError,
      enqueue: vi.fn(),
    } as never,
  };
}

const placesXml = (uploads: Array<{ key: string; xml: string }>) =>
  uploads.find((u) => u.key.includes("sitemap-places"))?.xml ?? null;

describe("sitemaps.generate — place URLs", () => {
  it("emits /p/<pageSlug>, never a raw UUID", async () => {
    const { ctx, uploads } = buildContext([
      publishable(
        PLACE_WITH_PAGE,
        "the-basement-east-a1b2c3d4",
        new Date("2026-01-15T12:00:00.000Z"),
      ),
    ]);

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { placeCount: number };

    const xml = placesXml(uploads);
    expect(xml).toContain(
      "<loc>https://ithasfire.com/places/the-basement-east-a1b2c3d4</loc>",
    );
    // The `/p/` twin must NOT be what gets advertised — nothing links it.
    expect(xml).not.toContain("<loc>https://ithasfire.com/p/");
    // The exact regression: a UUID anywhere in the places sitemap means the
    // job is back to emitting an id that `/p/[slug]` cannot resolve.
    expect(xml).not.toMatch(UUID_RE);
    expect(xml).toContain("<lastmod>2026-01-15T12:00:00.000Z</lastmod>");
    expect(result.placeCount).toBe(1);
  });

  it("excludes places with no entity page instead of publishing a known 404", async () => {
    const { ctx, uploads } = buildContext([
      publishable(PLACE_WITH_PAGE, "the-basement-east-a1b2c3d4"),
      // Bulk-imported venue: a Place row, no EntityPage, so no public URL.
      {
        placeId: PLACE_WITHOUT_PAGE,
        pageSlug: null,
        pageVisibility: null,
        updatedAt: null,
      },
    ]);

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { placeCount: number };

    const xml = placesXml(uploads);
    expect(xml).toContain("/places/the-basement-east-a1b2c3d4");
    expect(xml).not.toContain(PLACE_WITHOUT_PAGE);
    expect(xml!.match(/<loc>/g)).toHaveLength(1);
    expect(result.placeCount).toBe(1);
  });

  it("emits no places section at all when every place lacks an entity page", async () => {
    const { ctx, uploads } = buildContext([
      {
        placeId: PLACE_WITHOUT_PAGE,
        pageSlug: null,
        pageVisibility: null,
        updatedAt: null,
      },
    ]);

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { placeCount: number };

    expect(placesXml(uploads)).toBeNull();
    expect(result.placeCount).toBe(0);
  });
  // The `[BLOCKING]` case, end to end through the real job: a venue whose page
  // is PRIVATE or UNLISTED keeps its slug in the database, so nothing but the
  // visibility check stops that slug reaching Googlebot. PRIVATE would be a
  // guaranteed 404; UNLISTED would break the promise made to the owner in the
  // page editor ("it stays out of search and browse").
  it.each(["PRIVATE", "UNLISTED"] as const)(
    "never publishes a %s venue page, even though the slug exists",
    async (pageVisibility) => {
      const { ctx, uploads } = buildContext([
        publishable(PLACE_WITH_PAGE, "public-venue-a1b2c3d4"),
        {
          placeId: PLACE_WITHOUT_PAGE,
          pageSlug: "hidden-venue-9f8e7d6c",
          pageVisibility,
          updatedAt: null,
        },
      ]);

      const result = (await sitemapsGenerate.handler({
        input: { baseUrl: "https://ithasfire.com" },
        ctx,
      } as never)) as { placeCount: number };

      const xml = placesXml(uploads);
      expect(xml).toContain("/places/public-venue-a1b2c3d4");
      expect(xml).not.toContain("hidden-venue-9f8e7d6c");
      expect(xml!.match(/<loc>/g)).toHaveLength(1);
      expect(result.placeCount).toBe(1);
    },
  );

  it("escalates to Sentry when every eligible place is unpublishable", async () => {
    const { ctx, uploads, reportError } = buildContext([
      {
        placeId: PLACE_WITH_PAGE,
        pageSlug: "hidden-venue-9f8e7d6c",
        pageVisibility: "UNLISTED",
        updatedAt: null,
      },
      {
        placeId: PLACE_WITHOUT_PAGE,
        pageSlug: null,
        pageVisibility: null,
        updatedAt: null,
      },
    ]);

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { success: boolean; placeCount: number };

    // The section vanishes silently from the sitemap index — which is exactly
    // why it has to be loud somewhere else.
    expect(placesXml(uploads)).toBeNull();
    expect(result.placeCount).toBe(0);
    expect(result.success).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "listPlaceSitemapEntries", step: "structuralGap" },
    });
  });
});

describe("sitemaps.generate — category URLs", () => {
  const categoriesXml = (uploads: Array<{ key: string; xml: string }>) =>
    uploads.find((u) => u.key.includes("sitemap-categories"))?.xml ?? null;

  it("advertises only categories with an upcoming listed event", async () => {
    // `test` is active but empty (the prod leak); it must not be advertised.
    const { ctx, uploads, repos } = buildContext([], {
      active: [category("open-mics"), category("test")],
      withUpcoming: [category("open-mics")],
    });

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { categoryCount: number };

    const xml = categoriesXml(uploads);
    expect(xml).toContain(
      "<loc>https://ithasfire.com/events/category/open-mics</loc>",
    );
    expect(xml).not.toContain("/events/category/test<");
    expect(result.categoryCount).toBe(1);
    expect(
      repos.categories.listActiveWithUpcomingEvents,
    ).toHaveBeenCalledWith({ now: JOB_NOW });
    expect(repos.categories.listActive).not.toHaveBeenCalled();
  });

  it("emits no categories section when no category has an upcoming event", async () => {
    const { ctx, uploads } = buildContext([], {
      active: [category("test")],
      withUpcoming: [],
    });

    const result = (await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never)) as { categoryCount: number };

    expect(categoriesXml(uploads)).toBeNull();
    expect(result.categoryCount).toBe(0);
  });
});

/**
 * Gated events (PASSWORD / APPLICATION) list normally, but their own pages are
 * noindex, so they do not make a category or geo×category page indexable and
 * stay out of the event sitemap (owner ruling 2026-10-13).
 *
 * The job runs on the REAL Prisma repos here, over an in-memory Prisma that
 * evaluates the `where` / SQL the repos build. For the raw-SQL geo combos it
 * only checks whether the repo's query CONTAINS the ungated clause
 * (`UNGATED_EVENT_SQL`), not what that clause means to Postgres. The
 * real-Postgres proof of the meaning is
 * `indexable-listed-events.integration.test.ts` in adapters.
 */
describe("sitemaps.generate — gated events are not advertised", () => {
  type FakeEvent = {
    id: string;
    categoryId: string;
    slug: string;
    locality: string;
    regionCode: string;
    gateType: "NONE" | "PASSWORD" | "APPLICATION";
  };

  const UPCOMING = new Date(JOB_NOW.getTime() + 7 * 24 * 3600 * 1000);
  const UPDATED = new Date("2026-01-15T00:00:00.000Z");

  const CATEGORIES = [
    { ...category("open-mics"), id: "cat-open-mics" },
    { ...category("secret-shows"), id: "cat-secret-shows" },
  ];

  const EVENTS: FakeEvent[] = [
    // open-mics in Nashville: 3 listed, 1 gated → 2 ungated, below 3.
    ...(["NONE", "NONE", "PASSWORD"] as const).map((gateType, i) => ({
      id: `om-${i}`,
      categoryId: "cat-open-mics",
      slug: `open-mic-${i}`,
      locality: "Nashville",
      regionCode: "TN",
      gateType,
    })),
    // open-mics in Memphis: 3 ungated → advertised.
    ...[0, 1, 2].map((i) => ({
      id: `mem-${i}`,
      categoryId: "cat-open-mics",
      slug: `memphis-mic-${i}`,
      locality: "Memphis",
      regionCode: "TN",
      gateType: "NONE" as const,
    })),
    // secret-shows: every upcoming event gated.
    ...(["PASSWORD", "APPLICATION", "PASSWORD"] as const).map(
      (gateType, i) => ({
        id: `ss-${i}`,
        categoryId: "cat-secret-shows",
        slug: `secret-show-${i}`,
        locality: "Austin",
        regionCode: "TX",
        gateType,
      }),
    ),
  ];

  /** True when `event` satisfies the scalar rules of a Prisma event where. */
  const matchesEventWhere = (
    event: FakeEvent,
    where: Record<string, unknown>,
  ): boolean => {
    if (where.status !== undefined && where.status !== "PUBLISHED") return false;
    if (where.visibility !== undefined && where.visibility !== "PUBLIC") {
      return false;
    }
    if (where.gateType !== undefined && where.gateType !== event.gateType) {
      return false;
    }
    const startsAt = where.startsAt as { gte?: Date } | undefined;
    if (startsAt?.gte && UPCOMING < startsAt.gte) return false;
    return true;
  };

  function realReposContext() {
    const sqlText = (call: unknown[]): string => {
      const [first, ...values] = call;
      if (Array.isArray(first)) {
        return Prisma.sql(first as unknown as TemplateStringsArray, ...values)
          .sql;
      }
      return (first as { sql: string }).sql;
    };

    const prisma = {
      $queryRaw: vi.fn(async (...call: unknown[]) => {
        const sql = sqlText(call);
        if (!sql.includes("GROUP BY")) return []; // withheld owners: none
        // The geo×category combos: group by category + city, threshold on
        // the HAVING count, counting only what the WHERE lets through.
        const minCount = (call.find(
          (v, i) => i > 0 && typeof v === "number",
        ) ?? 0) as number;
        const counted = EVENTS.filter(
          (e) => !sql.includes(UNGATED_EVENT_SQL.sql) || e.gateType === "NONE",
        );
        const groups = new Map<string, FakeEvent[]>();
        for (const e of counted) {
          const key = `${e.categoryId}|${e.locality}|${e.regionCode}`;
          groups.set(key, [...(groups.get(key) ?? []), e]);
        }
        return [...groups.values()]
          .filter((g) => g.length >= minCount)
          .map((g) => ({
            categorySlug: g[0]!.categoryId.replace(/^cat-/, ""),
            categoryName: g[0]!.categoryId,
            categoryNameTranslations: {},
            locality: g[0]!.locality,
            regionCode: g[0]!.regionCode.toLowerCase(),
            count: g.length,
            latestUpdatedAt: UPDATED,
          }));
      }),
      category: {
        findMany: vi.fn(
          async (args: {
            where: { events?: { some: Record<string, unknown> } };
          }) =>
            CATEGORIES.filter((c) =>
              EVENTS.some(
                (e) =>
                  e.categoryId === c.id &&
                  matchesEventWhere(e, args.where.events?.some ?? {}),
              ),
            ),
        ),
      },
      // No Spanish slugs: the category entries carry `esSlug: null`.
      categorySlug: { findMany: vi.fn(async () => []) },
      event: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
          EVENTS.filter((e) => matchesEventWhere(e, args.where)).map((e) => ({
            slug: e.slug,
            updatedAt: UPDATED,
          })),
        ),
      },
    };

    const context = buildContext([]);
    Object.assign(context.repos, {
      categories: makeCategoriesRepo(prisma as never),
      events: makeEventsRepo(prisma as never),
    });
    return context;
  }

  const xmlOf = (
    uploads: Array<{ key: string; xml: string }>,
    section: string,
  ) => uploads.find((u) => u.key.includes(`sitemap-${section}`))?.xml ?? null;

  it("leaves out a category whose only upcoming events are gated", async () => {
    const { ctx, uploads } = realReposContext();

    await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never);

    const xml = xmlOf(uploads, "categories");
    expect(xml).toContain(
      "<loc>https://ithasfire.com/events/category/open-mics</loc>",
    );
    expect(xml).not.toContain("/events/category/secret-shows");
  });

  it("leaves out a geo×category combo of 3 events when 1 is gated", async () => {
    const { ctx, uploads } = realReposContext();

    await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never);

    // Nashville open mics: 3 listed, 2 ungated (< 3). Austin secret shows:
    // 3 listed, 0 ungated. Memphis open mics: 3 ungated, the only one in.
    const xml = xmlOf(uploads, "collections");
    expect(xml).toContain(
      "<loc>https://ithasfire.com/events/category/open-mics/memphis-tn</loc>",
    );
    expect(xml).not.toContain("nashville");
    expect(xml).not.toContain("austin");
  });

  it("leaves gated events out of the event sitemap", async () => {
    const { ctx, uploads } = realReposContext();

    await sitemapsGenerate.handler({
      input: { baseUrl: "https://ithasfire.com" },
      ctx,
    } as never);

    const xml = xmlOf(uploads, "events") ?? "";
    expect(xml).toContain("open-mic-0");
    expect(xml).toContain("open-mic-1");
    expect(xml).not.toContain("open-mic-2");
    expect(xml).not.toContain("secret-show");
  });
});

/**
 * Spanish twins (spanish-seo R8, R9, FR-006, FR-011): the sitemap lists both
 * URLs of an indexable pair, each with the full reciprocal hreflang set, and
 * leaves every twinless URL exactly as it was.
 */
describe("sitemaps.generate — Spanish twins", () => {
  const BASE = "https://ithasfire.com";
  const XHTML_NS = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"';

  const withEs = (slug: string, es: string): CategoryRow =>
    ({
      ...category(slug),
      nameTranslations: { es },
    }) as CategoryRow;

  const run = async (
    categories: Parameters<typeof buildContext>[1],
    extra: Parameters<typeof buildContext>[2] = {},
    places: SitemapRow[] = [],
  ) => {
    const built = buildContext(places, categories, extra);
    await sitemapsGenerate.handler({
      input: { baseUrl: BASE },
      ctx: built.ctx,
    } as never);
    const file = (name: string) =>
      built.uploads.find((u) => u.key === `sitemaps/sitemap-${name}.xml`)?.xml;
    return { ...built, file };
  };

  /** The three alternates a pair member must carry. */
  const altSet = (en: string, es: string) =>
    [
      `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>`,
      `<xhtml:link rel="alternate" hreflang="es" href="${es}"/>`,
      `<xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>`,
    ].join("\n    ");

  /** The `<url>` block whose `<loc>` is `loc`. */
  const urlBlock = (xml: string, loc: string): string => {
    const block = xml
      .split("  <url>\n")
      .find((b) => b.startsWith(`    <loc>${loc}</loc>`));
    if (!block) throw new Error(`no <url> for ${loc}`);
    return block;
  };

  it("lists both category URLs with the full reciprocal set", async () => {
    const open = withEs("open-mics", "micro-abierto");
    const { file } = await run(
      { withUpcoming: [open] },
      { esSlugs: [{ categoryId: open.id, slug: "micro-abierto" }] },
    );
    const xml = file("categories")!;
    const en = `${BASE}/events/category/open-mics`;
    const es = `${BASE}/es/eventos/categoria/micro-abierto`;

    expect(xml).toContain(XHTML_NS);
    const set = altSet(en, es);
    expect(urlBlock(xml, en)).toContain(set);
    expect(urlBlock(xml, es)).toContain(set);
    expect(xml.match(/<loc>/g)).toHaveLength(2);
    expect(xml.match(/<xhtml:link /g)).toHaveLength(6);
  });

  it("lists no Spanish entry when the category has no Spanish slug or name", async () => {
    const noSlug = withEs("open-mics", "micro-abierto");
    // Name cleared: the es slug stays reserved but the page is noindex (R9).
    const noName = { ...category("poetry"), nameTranslations: { es: " " } };
    const { file } = await run(
      { withUpcoming: [noSlug, noName as CategoryRow] },
      { esSlugs: [{ categoryId: "cat-poetry", slug: "poesia" }] },
    );
    const xml = file("categories")!;

    expect(xml).not.toContain(XHTML_NS);
    expect(xml).not.toContain("xhtml:link");
    expect(xml).not.toContain("/es/");
    expect(xml.match(/<loc>/g)).toHaveLength(2);
  });

  it("pairs the home, about and contact pages, and leaves the rest alone", async () => {
    const { file } = await run({});
    const xml = file("static")!;

    expect(xml).toContain(XHTML_NS);
    for (const [en, es] of [
      ["/", "/es"],
      ["/about", "/es/acerca-de"],
      ["/contact", "/es/contacto"],
    ] as const) {
      const enUrl = `${BASE}${en}`;
      const esUrl = `${BASE}${es}`;
      expect(urlBlock(xml, enUrl)).toContain(altSet(enUrl, esUrl));
      expect(urlBlock(xml, esUrl)).toContain(altSet(enUrl, esUrl));
    }
    for (const path of ["/search", "/help", "/terms", "/privacy"]) {
      expect(urlBlock(xml, `${BASE}${path}`)).not.toContain("xhtml:link");
    }
    expect(xml.match(/<loc>/g)).toHaveLength(11);
  });

  it("pairs a city page only when its category has a Spanish twin", async () => {
    const open = withEs("open-mics", "micro-abierto");
    const plain = category("poetry");
    const combo = (categorySlug: string) => ({
      categorySlug,
      locality: "Nashville",
      regionCode: "tn",
      latestUpdatedAt: null,
    });
    const { file } = await run(
      { withUpcoming: [open, plain] },
      {
        esSlugs: [{ categoryId: open.id, slug: "micro-abierto" }],
        combos: [combo("open-mics"), combo("poetry")],
      },
    );
    const xml = file("collections")!;
    const en = `${BASE}/events/category/open-mics/nashville-tn`;
    const es = `${BASE}/es/eventos/categoria/micro-abierto/nashville-tn`;

    expect(urlBlock(xml, en)).toContain(altSet(en, es));
    expect(urlBlock(xml, es)).toContain(altSet(en, es));
    expect(
      urlBlock(xml, `${BASE}/events/category/poetry/nashville-tn`),
    ).not.toContain("xhtml:link");
    expect(xml.match(/<loc>/g)).toHaveLength(3);
  });

  // Skipped where xmllint is not installed. It runs on dev machines with
  // libxml2 (macOS ships it); whether CI has it is unconfirmed (ci.yml runs the
  // jobs tests on ubuntu-latest and installs no libxml2-utils). Well-formedness
  // only: the sitemap XSD is not vendored, so schema validation is not run.
  const hasXmllint = spawnSync("xmllint", ["--version"]).error === undefined;
  it.skipIf(!hasXmllint)(
    "generates well-formed XML for a category file and the static file",
    async () => {
      const open = withEs("open-mics", "micro-abierto");
      const { file } = await run(
        { withUpcoming: [open] },
        { esSlugs: [{ categoryId: open.id, slug: "micro-abierto" }] },
      );
      for (const name of ["categories", "static"]) {
        const lint = spawnSync("xmllint", ["--noout", "-"], {
          input: file(name)!,
          encoding: "utf-8",
        });
        expect(lint.stderr).toBe("");
        expect(lint.status).toBe(0);
      }
    },
  );

  it("keeps both alternate sets intact when a pair splits across files", async () => {
    // One unpaired category first shifts the pairs by one, so the last pair
    // straddles the 45,000-URL boundary: 1 + 2 * 22,500 = 45,001 entries.
    const pairs = Array.from({ length: 22_500 }, (_, i) =>
      withEs(`c${i}`, `n${i}`),
    );
    const lone = category("lone");
    const { file } = await run(
      { withUpcoming: [lone, ...pairs] },
      {
        esSlugs: pairs.map((c, i) => ({ categoryId: c.id, slug: `n${i}` })),
      },
    );
    const first = file("categories-1")!;
    const second = file("categories-2")!;
    const en = `${BASE}/events/category/c22499`;
    const es = `${BASE}/es/eventos/categoria/n22499`;

    expect(file("categories")).toBeUndefined();
    expect(urlBlock(first, en)).toContain(altSet(en, es));
    expect(urlBlock(second, es)).toContain(altSet(en, es));
    expect(second).toContain(XHTML_NS);
    expect(first.match(/<loc>/g)).toHaveLength(45_000);
    expect(second.match(/<loc>/g)).toHaveLength(1);
  });

  it("leaves event and place entries untouched", async () => {
    const built = await run(
      {},
      { events: [{ slug: "jam-night", updatedAt: null }] },
      [publishable(PLACE_WITH_PAGE, "the-basement-east-a1b2c3d4")],
    );
    for (const name of ["events", "places"]) {
      const xml = built.file(name)!;
      expect(xml).not.toContain("xhtml");
      expect(xml).not.toContain("/es/");
      expect(xml).toContain(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      );
    }
    expect(built.file("events")).toContain(`<loc>${BASE}/events/jam-night</loc>`);
  });
});

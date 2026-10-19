/**
 * Sitemap generation job
 *
 * Nightly cron that builds a sitemap-index plus per-entity sub-sitemaps and
 * uploads them to R2 (public). The CDN fronts the bucket so crawlers fetch
 * pre-rendered XML from the edge instead of waking the web app + DB on every
 * request.
 *
 * Output layout (under the configured public bucket):
 *   sitemaps/sitemap.xml             (index)
 *   sitemaps/sitemap-static.xml
 *   sitemaps/sitemap-events.xml
 *   sitemaps/sitemap-places.xml
 *   sitemaps/sitemap-categories.xml
 *   sitemaps/sitemap-collections.xml   (geo×category landing pages)
 */
import { z } from "zod";
import { eventPublicPath } from "@th/core/lib/public-urls";
import { publicPath, type PublicPage } from "@th/types/seo/public-paths";

import { listEventSitemapEntries } from "@th/core/use-cases/events/list-event-sitemap-entries";
import { listGeoCategorySitemapEntries } from "@th/core/use-cases/events/list-geo-category-sitemap-entries";
import { listPlaceSitemapEntries } from "@th/core/use-cases/places/list-place-sitemap-entries";
import { listCategorySitemapEntries } from "@th/core/use-cases/categories/list-category-sitemap-entries";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

const STATIC_PATHS: Array<{
  path: string;
  /** Set when the page has a Spanish twin: both URLs are listed (R8). */
  twin?: PublicPage;
  changefreq: string;
  priority: string;
}> = [
  { path: "/", twin: { kind: "home" }, changefreq: "daily", priority: "1.0" },
  { path: "/search", changefreq: "weekly", priority: "0.7" },
  {
    path: "/about",
    twin: { kind: "about" },
    changefreq: "monthly",
    priority: "0.5",
  },
  {
    path: "/contact",
    twin: { kind: "contact" },
    changefreq: "monthly",
    priority: "0.5",
  },
  { path: "/help", changefreq: "weekly", priority: "0.6" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/cookie-policy", changefreq: "yearly", priority: "0.3" },
];

const SITEMAP_KEY_PREFIX = "sitemaps";
const URLS_PER_SITEMAP = 45_000;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

type UrlEntry = {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
  /** hreflang alternates, self included; present only on indexable twin pairs. */
  alternates?: Array<{ hreflang: string; href: string }>;
};

const XHTML_NS = "http://www.w3.org/1999/xhtml";

const buildUrlsetXml = (urls: UrlEntry[]): string => {
  const hasAlternates = urls.some((u) => u.alternates?.length);
  const body = urls
    .map((u) => {
      const parts = [`    <loc>${escapeXml(u.loc)}</loc>`];
      for (const alt of u.alternates ?? [])
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`,
        );
      if (u.lastmod)
        parts.push(`    <lastmod>${escapeXml(u.lastmod)}</lastmod>`);
      if (u.changefreq)
        parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority) parts.push(`    <priority>${u.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasAlternates ? ` xmlns:xhtml="${XHTML_NS}"` : ""}>\n${body}\n</urlset>\n`;
};

const buildIndexXml = (
  entries: Array<{ loc: string; lastmod: string }>,
): string => {
  const body = entries
    .map(
      (e) =>
        `  <sitemap>\n    <loc>${escapeXml(e.loc)}</loc>\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>\n  </sitemap>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  if (items.length <= size) return items.length > 0 ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

const joinUrl = (base: string, path: string): string => {
  const trimmedBase = base.replace(/\/+$/, "");
  const prefix = path.startsWith("/") ? "" : "/";
  return `${trimmedBase}${prefix}${path}`;
};

type UrlMeta = Pick<UrlEntry, "lastmod" | "changefreq" | "priority">;

/**
 * The URL entries of one R1 page: the English one alone, or the English and
 * Spanish pair when `esPage` is set. Each entry carries the full reciprocal
 * set (en, es, x-default = en), so the two never disagree with the web pages,
 * which emit hreflang only when both twins are indexable.
 */
const twinEntries = (
  baseUrl: string,
  enPage: PublicPage,
  esPage: PublicPage | null,
  meta: UrlMeta,
): UrlEntry[] => {
  const enLoc = joinUrl(baseUrl, publicPath("en", enPage));
  if (!esPage) return [{ loc: enLoc, ...meta }];
  const esLoc = joinUrl(baseUrl, publicPath("es", esPage));
  const alternates = [
    { hreflang: "en", href: enLoc },
    { hreflang: "es", href: esLoc },
    { hreflang: "x-default", href: enLoc },
  ];
  return [
    { loc: enLoc, ...meta, alternates },
    { loc: esLoc, ...meta, alternates },
  ];
};

export const sitemapsGenerate = defineScheduledTask({
  name: "sitemaps.generate",
  description:
    "Generate sitemap XML files for SEO and upload them to the public CDN bucket.",
  notify: true,
  input: z.object({
    trigger: z.object({ reason: z.string() }).optional(),
    baseUrl: z.string().url(),
    eventLimit: z.number().int().min(1).max(50_000).optional(),
    placeLimit: z.number().int().min(1).max(50_000).optional(),
  }),
  schedule: getSchedule("sitemaps.generate"),
  handler: async ({ input, ctx }) => {
    const startedAt = Date.now();
    ctx.logger.info("sitemaps.generate.start", { baseUrl: input.baseUrl });

    try {
      const [eventEntries, placeEntries, categoryEntries, collectionEntries] =
        await Promise.all([
          listEventSitemapEntries(
            { repos: ctx.repos, logger: ctx.logger },
            { limit: input.eventLimit ?? 50000 },
          ),
          listPlaceSitemapEntries(
            {
              repos: ctx.repos,
              logger: ctx.logger,
              // A place with no publishable entity page is DROPPED, not
              // failed — so a structural gap (bulk-imported venues that never
              // got a page) silently shrinks or empties `sitemap-places.xml`.
              // The use case escalates that to Sentry through here.
              reportError: ctx.reportError,
            },
            { limit: input.placeLimit ?? 50000 },
          ),
          // Only categories whose page lists >=1 upcoming PUBLISHED, PUBLIC,
          // ungated event. A category page without one is `noindex` (web
          // route metadata; gated events list but do not count, owner ruling
          // 2026-10-13), so advertising it would send crawlers to a page they
          // must drop — and it is how a prod `test` category leaked into the
          // sitemap.
          listCategorySitemapEntries(
            { repos: ctx.repos, logger: ctx.logger },
            { now: ctx.clock.now() },
          ),
          listGeoCategorySitemapEntries(
            { repos: ctx.repos, logger: ctx.logger },
            {},
          ),
        ]);

      const nowIso = new Date().toISOString();

      const staticUrls: UrlEntry[] = STATIC_PATHS.flatMap((p) => {
        const meta = {
          lastmod: nowIso,
          changefreq: p.changefreq,
          priority: p.priority,
        };
        // Home, about and contact twins are always indexable.
        return p.twin
          ? twinEntries(input.baseUrl, p.twin, p.twin, meta)
          : [{ loc: joinUrl(input.baseUrl, p.path), ...meta }];
      });

      const eventUrls: UrlEntry[] = eventEntries.flatMap((e) => {
        // One definition of an event's public path (multi-segment slugs are
        // per-segment escaped there, never percent-encoded whole). A slugless
        // event has no public page, so it is omitted rather than emitted as a
        // bare base URL.
        const path = eventPublicPath(e.slug);
        if (!path) return [];
        return [
          {
            loc: joinUrl(input.baseUrl, path),
            // Omit lastmod when we have no real timestamp; falling back to "now"
            // would tell crawlers every URL changed on every nightly run.
            ...(e.updatedAt ? { lastmod: e.updatedAt } : {}),
            changefreq: "daily",
            priority: "0.8",
          },
        ];
      });

      // `/places/[slug]`, NOT `/p/[slug]`.
      //
      // A PLACE entity page renders on BOTH routes and each self-canonicalises
      // to itself (`/p/[slug]/page.tsx` vs `/places/[slug]/page.tsx`; the
      // `/places` route only redirects NON-place entities away). Meanwhile
      // every internal link in the product points at `/places/` — the event
      // page's venue badge, Spotlight, and the search results page. Advertising
      // the `/p/` variant to crawlers would publish up to 50k URLs on the
      // variant nothing links, against a link graph pointing at the other:
      // two indexable URLs per venue with split signals. That was inert only
      // while every entry here 404'd.
      //
      // Neither route has a uuid fallback — both call `notFound()` — which is
      // why emitting `/p/{placeId}` used to 404 every place URL in the sitemap.
      // The use case already drops places with no PUBLISHABLE page, so every
      // entry has a real slug; the guard is belt-and-braces against that
      // changing.
      const placeUrls: UrlEntry[] = placeEntries.flatMap((p) => {
        if (!p.pageSlug) return [];
        return [
          {
            loc: joinUrl(input.baseUrl, `/places/${p.pageSlug}`),
            ...(p.updatedAt ? { lastmod: p.updatedAt } : {}),
            changefreq: "weekly",
            priority: "0.6",
          },
        ];
      });

      // A Spanish twin exists only for a category with a Spanish name and a
      // current Spanish slug (`esSlug`); without one the English URL is listed
      // alone, as the web page lists no hreflang either (R9).
      const esSlugByCategory = new Map(
        categoryEntries.map((c) => [c.slug, c.esSlug] as const),
      );

      const categoryUrls: UrlEntry[] = categoryEntries.flatMap((c) =>
        twinEntries(
          input.baseUrl,
          { kind: "category", slug: c.slug },
          c.esSlug ? { kind: "category", slug: c.esSlug } : null,
          { lastmod: nowIso, changefreq: "weekly", priority: "0.5" },
        ),
      );

      const collectionUrls: UrlEntry[] = collectionEntries.flatMap((e) => {
        const esSlug = esSlugByCategory.get(e.categorySlug);
        return twinEntries(
          input.baseUrl,
          { kind: "cityCategory", slug: e.categorySlug, city: e.citySegment },
          esSlug
            ? { kind: "cityCategory", slug: esSlug, city: e.citySegment }
            : null,
          {
            // Omit lastmod when we have no real timestamp (mirrors eventUrls).
            ...(e.latestUpdatedAt ? { lastmod: e.latestUpdatedAt } : {}),
            changefreq: "weekly",
            priority: "0.6",
          },
        );
      });

      type Section = { name: string; urls: UrlEntry[] };
      const sections: Section[] = [
        { name: "static", urls: staticUrls },
        { name: "events", urls: eventUrls },
        { name: "places", urls: placeUrls },
        { name: "categories", urls: categoryUrls },
        { name: "collections", urls: collectionUrls },
      ];

      const uploads: Array<{ key: string; xml: string }> = [];
      const indexEntries: Array<{ loc: string; lastmod: string }> = [];

      for (const section of sections) {
        if (section.urls.length === 0) continue;

        const groups = chunk(section.urls, URLS_PER_SITEMAP);
        for (const [idx, group] of groups.entries()) {
          const filename =
            groups.length === 1
              ? `sitemap-${section.name}.xml`
              : `sitemap-${section.name}-${idx + 1}.xml`;
          const key = `${SITEMAP_KEY_PREFIX}/${filename}`;
          uploads.push({ key, xml: buildUrlsetXml(group) });
        }
      }

      let totalBytes = 0;
      for (const upload of uploads) {
        const buffer = Buffer.from(upload.xml, "utf-8");
        totalBytes += buffer.byteLength;
        const { url } = await ctx.fileStorage.putObject({
          key: upload.key,
          content: buffer,
          options: {
            contentType: "application/xml; charset=utf-8",
            public: true,
            metadata: {
              "th-sitemap": "1",
              "th-generated-at": nowIso,
            },
          },
        });
        indexEntries.push({ loc: url, lastmod: nowIso });
        ctx.logger.info("sitemaps.generate.uploaded", {
          key: upload.key,
          url,
          bytes: buffer.byteLength,
        });
      }

      const indexXml = buildIndexXml(indexEntries);
      const indexBuffer = Buffer.from(indexXml, "utf-8");
      totalBytes += indexBuffer.byteLength;
      const { url: indexUrl } = await ctx.fileStorage.putObject({
        key: `${SITEMAP_KEY_PREFIX}/sitemap.xml`,
        content: indexBuffer,
        options: {
          contentType: "application/xml; charset=utf-8",
          public: true,
          metadata: {
            "th-sitemap": "index",
            "th-generated-at": nowIso,
          },
        },
      });

      const totalUrls =
        staticUrls.length +
        eventUrls.length +
        placeUrls.length +
        categoryUrls.length +
        collectionUrls.length;
      const durationMs = Date.now() - startedAt;

      ctx.logger.info("sitemaps.generate.completed", {
        indexUrl,
        files: uploads.length + 1,
        totalUrls,
        totalBytes,
        durationMs,
      });

      return {
        success: true,
        indexUrl,
        files: uploads.length + 1,
        totalUrls,
        eventCount: eventUrls.length,
        placeCount: placeUrls.length,
        categoryCount: categoryUrls.length,
        collectionCount: collectionUrls.length,
        staticCount: staticUrls.length,
        totalBytes,
        durationMs,
      };
    } catch (error) {
      ctx.logger.error("sitemaps.generate.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // THROW, never return `{ success: false }`: app.ts answers 200 for any
      // returned value, so only a throw makes the run fail and show. No
      // `ctx.reportError` here: the run route's catch reports what it catches.
      throw error;
    }
  },
});

export const sitemapJobs = [sitemapsGenerate];

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

import { listEventSitemapEntries } from "@th/core/use-cases/events/list-event-sitemap-entries";
import { listGeoCategorySitemapEntries } from "@th/core/use-cases/events/list-geo-category-sitemap-entries";
import { listPlaceSitemapEntries } from "@th/core/use-cases/places/list-place-sitemap-entries";
import { listCategorySitemapEntries } from "@th/core/use-cases/categories/list-category-sitemap-entries";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

const STATIC_PATHS: Array<{
  path: string;
  changefreq: string;
  priority: string;
}> = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/search", changefreq: "weekly", priority: "0.7" },
  { path: "/about", changefreq: "monthly", priority: "0.5" },
  { path: "/contact", changefreq: "monthly", priority: "0.5" },
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
};

const buildUrlsetXml = (urls: UrlEntry[]): string => {
  const body = urls
    .map((u) => {
      const parts = [`    <loc>${escapeXml(u.loc)}</loc>`];
      if (u.lastmod)
        parts.push(`    <lastmod>${escapeXml(u.lastmod)}</lastmod>`);
      if (u.changefreq)
        parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority) parts.push(`    <priority>${u.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
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
            { repos: ctx.repos, logger: ctx.logger },
            { limit: input.placeLimit ?? 50000 },
          ),
          listCategorySitemapEntries({ repos: ctx.repos, logger: ctx.logger }),
          listGeoCategorySitemapEntries(
            { repos: ctx.repos, logger: ctx.logger },
            {},
          ),
        ]);

      const nowIso = new Date().toISOString();

      const staticUrls: UrlEntry[] = STATIC_PATHS.map((p) => ({
        loc: joinUrl(input.baseUrl, p.path),
        lastmod: nowIso,
        changefreq: p.changefreq,
        priority: p.priority,
      }));

      const eventUrls: UrlEntry[] = eventEntries.map((e) => ({
        loc: joinUrl(input.baseUrl, `/events/${e.slug}`),
        // Omit lastmod when we have no real timestamp; falling back to "now"
        // would tell crawlers every URL changed on every nightly run.
        ...(e.updatedAt ? { lastmod: e.updatedAt } : {}),
        changefreq: "daily",
        priority: "0.8",
      }));

      const placeUrls: UrlEntry[] = placeEntries.map((p) => ({
        loc: joinUrl(input.baseUrl, `/p/${p.placeId}`),
        ...(p.updatedAt ? { lastmod: p.updatedAt } : {}),
        changefreq: "weekly",
        priority: "0.6",
      }));

      const categoryUrls: UrlEntry[] = categoryEntries.map((c) => ({
        loc: joinUrl(input.baseUrl, `/events/category/${c.slug}`),
        lastmod: nowIso,
        changefreq: "weekly",
        priority: "0.5",
      }));

      const collectionUrls: UrlEntry[] = collectionEntries.map((e) => ({
        loc: joinUrl(
          input.baseUrl,
          `/events/category/${e.categorySlug}/${e.citySegment}`,
        ),
        // Omit lastmod when we have no real timestamp (mirrors eventUrls).
        ...(e.latestUpdatedAt ? { lastmod: e.latestUpdatedAt } : {}),
        changefreq: "weekly",
        priority: "0.6",
      }));

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
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const sitemapJobs = [sitemapsGenerate];

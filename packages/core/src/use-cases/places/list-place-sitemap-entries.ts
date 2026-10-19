import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { crawlablePageSlug } from "../../lib/entity-page-visibility";
import { parseInput } from "../../lib/io";

export const listPlaceSitemapEntriesInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50000).optional(),
  })
  .strict();

export const listPlaceSitemapEntriesOutputSchema = z.array(
  z.object({
    placeId: z.string(),
    /**
     * The place's `EntityPage.slug` — the ONLY identifier `/p/[slug]` resolves
     * on. NON-NULLABLE here on purpose: a place without a PUBLISHABLE entity
     * page has no crawlable URL, and this use case DROPS it rather than
     * publish a guaranteed 404 (or a page whose owner opted out of discovery).
     *
     * Never `Place.slug`. That is a multi-segment directory key
     * (`us/tn/x--a1b2c3d4e5`) that no route resolves.
     */
    pageSlug: z.string().min(1),
    updatedAt: z.string().nullable().optional(),
  }),
);

export type ListPlaceSitemapEntriesInput = z.infer<
  typeof listPlaceSitemapEntriesInputSchema
>;
export type ListPlaceSitemapEntriesOutput = z.infer<
  typeof listPlaceSitemapEntriesOutputSchema
>;

export type ListPlaceSitemapEntriesDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /**
   * Deliberate-degradation reporter (ReporterPort convention, CLAUDE.md).
   * This use case never throws on a missing entity page — it silently drops
   * the row — so when the drop becomes STRUCTURAL (every place, or most of
   * them) the places sitemap shrinks or vanishes with nothing to notice it.
   * `logger.info`/`warn` are NOT captured by Sentry; this is.
   */
  reportError?: ReporterPort;
};

/**
 * Fraction of eligible places that may lack a publishable page before the gap
 * is treated as structural rather than incidental. Set high because a healthy
 * database is expected to be near-zero here: `upsertPlace` auto-provisions an
 * EntityPage on create, so a large share missing one means a bulk-import path
 * (`bulkCreate`, which does NOT provision a page) has outgrown the create path.
 */
const STRUCTURAL_GAP_RATIO = 0.5;

/**
 * Minimum eligible places before the RATIO arm can fire. Without a floor,
 * "1 of 1 places has no page" is a 100% gap and would page someone every night
 * in a small or brand-new environment — the fastest way to teach a team to
 * ignore this alert. The zero-published arm below has NO floor on purpose: an
 * empty places sitemap is worth saying regardless of size.
 */
const STRUCTURAL_GAP_MIN_SAMPLE = 10;

export async function listPlaceSitemapEntries(
  deps: ListPlaceSitemapEntriesDeps,
  rawInput: unknown,
): Promise<ListPlaceSitemapEntriesOutput> {
  const input = parseInput(listPlaceSitemapEntriesInputSchema, rawInput);

  const records = await deps.repos.places.listForSitemap({
    limit: input.limit ?? 50000,
  });

  // A place is publishable only when its entity page EXISTS and is PUBLIC.
  // The sitemap is the crawler-discovery surface, so it is the strictest of
  // the link gates (`crawlablePageSlug`, lib/entity-page-visibility):
  //   · no page      → `/p/{slug}` cannot be built at all;
  //   · PRIVATE page → the route 404s, so publishing it hands crawlers a dead
  //     URL — an active SEO liability, not a harmless gap;
  //   · UNLISTED     → renders, but the owner was told "it stays out of search
  //     and browse" when they chose it. This surface IS that.
  // Dropped places stay reachable at `/places/id/{placeId}`, which is a
  // different route keyed on the Place, so nothing hidden leaks. We do not
  // advertise that fallback to crawlers — it is not the canonical URL.
  const entries: Array<{ placeId: string; pageSlug: string; updatedAt: Date | null }> =
    [];
  let skippedNoPage = 0;
  let skippedNotPublic = 0;

  for (const record of records) {
    const slug = crawlablePageSlug(
      record.pageSlug && record.pageVisibility
        ? { slug: record.pageSlug, visibility: record.pageVisibility }
        : null,
    );
    if (slug) {
      entries.push({
        placeId: record.placeId,
        pageSlug: slug,
        updatedAt: record.updatedAt,
      });
    } else if (!record.pageSlug) {
      skippedNoPage += 1;
    } else {
      skippedNotPublic += 1;
    }
  }

  const skipped = skippedNoPage + skippedNotPublic;

  deps.logger?.info("places.list_sitemap_entries", {
    count: entries.length,
    // Non-zero means venues are publicly undiscoverable, not that the sitemap
    // is broken — surfaced so the gap is measurable rather than silent.
    skippedWithoutPage: skippedNoPage,
    skippedNotPublic,
  });

  // Escalate a STRUCTURAL gap. `sitemaps.ts` skips an empty section entirely,
  // so without this `sitemap-places.xml` can disappear from the sitemap index
  // and nothing anywhere says so. The likely cause is real and already in the
  // codebase: `bulkCreate` writes Place rows with no EntityPage, while
  // `upsertPlace` only auto-provisions one on create — so an unknown share of
  // imported venues have no page and never will without a backfill.
  const structural =
    records.length > 0 &&
    (entries.length === 0 ||
      (records.length >= STRUCTURAL_GAP_MIN_SAMPLE &&
        skipped / records.length >= STRUCTURAL_GAP_RATIO));

  if (structural) {
    const message =
      entries.length === 0
        ? "places sitemap is EMPTY: no eligible place has a publishable entity page"
        : "places sitemap is missing most of its eligible places";
    const meta = {
      eligible: records.length,
      published: entries.length,
      skippedWithoutPage: skippedNoPage,
      skippedNotPublic,
    };
    deps.logger?.error("places.list_sitemap_entries_structural_gap", meta);
    try {
      deps.reportError?.(new Error(message), {
        tags: {
          useCase: "listPlaceSitemapEntries",
          step: "structuralGap",
        },
        extra: meta,
      });
    } catch {
      // Best-effort: a throwing reporter must never change the sitemap.
    }
  }

  return listPlaceSitemapEntriesOutputSchema.parse(
    entries.map((r) => ({
      placeId: r.placeId,
      pageSlug: r.pageSlug,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    })),
  );
}

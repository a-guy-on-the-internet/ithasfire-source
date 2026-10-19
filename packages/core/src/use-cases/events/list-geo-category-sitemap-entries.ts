import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  MIN_EVENTS_PER_GEO_CATEGORY_PAGE,
  buildCitySegment,
} from "./_shared/geo-category";

export const listGeoCategorySitemapEntriesInputSchema = z
  .object({
    minCount: z
      .number()
      .int()
      .min(1)
      .default(MIN_EVENTS_PER_GEO_CATEGORY_PAGE),
  })
  .strict();

export const listGeoCategorySitemapEntriesOutputSchema = z.array(
  z.object({
    categorySlug: z.string(),
    citySegment: z.string(),
    latestUpdatedAt: z.string().nullable(),
  }),
);

export type ListGeoCategorySitemapEntriesInput = z.infer<
  typeof listGeoCategorySitemapEntriesInputSchema
>;
export type ListGeoCategorySitemapEntriesOutput = z.infer<
  typeof listGeoCategorySitemapEntriesOutputSchema
>;

export type ListGeoCategorySitemapEntriesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Thin sitemap projection of the geo×category combos. Returns just the pieces
 * the sitemap job needs to build a URL + lastmod; the job owns the final URL
 * shape. Community/ownerless listings are included (repo enforces PUBLISHED +
 * PUBLIC + upcoming, not ownership). Only ungated events count toward
 * `minCount` (owner ruling 2026-10-13), as in the page's robots rule
 * (`listEventsByCategoryAndCity(...).indexableTotal`), whose match set
 * contains the combo's group, so every emitted URL is an indexable page. The
 * reverse does not hold: a page can be indexable without being listed here.
 */
export async function listGeoCategorySitemapEntries(
  deps: ListGeoCategorySitemapEntriesDeps,
  rawInput: unknown,
): Promise<ListGeoCategorySitemapEntriesOutput> {
  const input = parseInput(listGeoCategorySitemapEntriesInputSchema, rawInput);

  const combos = await deps.repos.events.enumerateGeoCategoryCombos({
    minCount: input.minCount,
    startsAfter: new Date(),
  });

  deps.logger?.info("events.list_geo_category_sitemap_entries", {
    minCount: input.minCount,
    count: combos.length,
  });

  return listGeoCategorySitemapEntriesOutputSchema.parse(
    combos.map((combo) => ({
      categorySlug: combo.categorySlug,
      citySegment: buildCitySegment(combo.locality, combo.regionCode),
      latestUpdatedAt: combo.latestUpdatedAt
        ? combo.latestUpdatedAt.toISOString()
        : null,
    })),
  );
}

import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { categoryNamesSchema } from "../categories/_shared/category-output";
import { categoryNames } from "@th/types";
import {
  MIN_EVENTS_PER_GEO_CATEGORY_PAGE,
  buildCitySegment,
} from "./_shared/geo-category";

export const listGeoCategoryCombosInputSchema = z
  .object({
    minCount: z
      .number()
      .int()
      .min(1)
      .default(MIN_EVENTS_PER_GEO_CATEGORY_PAGE),
  })
  .strict();

const geoCategoryComboSchema = z
  .object({
    categorySlug: z.string(),
    categoryName: z.string(),
    names: categoryNamesSchema,
    city: z.string(),
    regionCode: z.string().nullable(),
    citySegment: z.string(),
    count: z.number().int().min(0),
    latestUpdatedAt: z.string().nullable(),
  })
  .strict();

export const listGeoCategoryCombosOutputSchema = z.array(geoCategoryComboSchema);

export type ListGeoCategoryCombosInput = z.infer<
  typeof listGeoCategoryCombosInputSchema
>;
export type ListGeoCategoryCombosOutput = z.infer<
  typeof listGeoCategoryCombosOutputSchema
>;

export type ListGeoCategoryCombosDeps = {
  repos: Pick<Repos, "events">;
  logger?: LoggerPort;
};

/**
 * Enumerate geo×category combinations with enough upcoming events to warrant a
 * dedicated SEO landing page. Community/ownerless listings are included (the
 * repo enforces PUBLISHED + PUBLIC + upcoming, not ownership); gated events
 * do not count (owner ruling 2026-10-13). Each combo
 * carries its canonical `citySegment` so callers can build page URLs.
 */
export async function listGeoCategoryCombos(
  deps: ListGeoCategoryCombosDeps,
  rawInput: unknown,
): Promise<ListGeoCategoryCombosOutput> {
  const input = parseInput(listGeoCategoryCombosInputSchema, rawInput);

  const combos = await deps.repos.events.enumerateGeoCategoryCombos({
    minCount: input.minCount,
    startsAfter: new Date(),
  });

  deps.logger?.info("events.list_geo_category_combos", {
    minCount: input.minCount,
    count: combos.length,
  });

  return listGeoCategoryCombosOutputSchema.parse(
    combos.map((combo) => ({
      categorySlug: combo.categorySlug,
      categoryName: combo.categoryName,
      names: categoryNames({
        name: combo.categoryName,
        nameTranslations: combo.categoryNameTranslations,
      }),
      city: combo.locality,
      regionCode: combo.regionCode,
      citySegment: buildCitySegment(combo.locality, combo.regionCode),
      count: combo.count,
      latestUpdatedAt: combo.latestUpdatedAt
        ? combo.latestUpdatedAt.toISOString()
        : null,
    })),
  );
}

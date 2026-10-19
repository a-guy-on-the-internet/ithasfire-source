import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { PlaceSuggestion } from "@th/ports/search/multi-index.types";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const listPlacesForDirectoryInputSchema = z
  .object({
    /** Search query — sent to Meilisearch for full-text matching. Requires ≥ 2 chars. */
    query: z.string().trim().min(2).max(100).optional(),
  })
  .strict()
  .optional()
  .default({});

export const listPlacesForDirectoryOutputSchema = z
  .object({
    places: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        countryCode: z.string().nullable(),
      }),
    ),
  })
  .strict();

export type ListPlacesForDirectoryInput = z.infer<
  typeof listPlacesForDirectoryInputSchema
>;
export type ListPlacesForDirectoryOutput = z.infer<
  typeof listPlacesForDirectoryOutputSchema
>;

export type ListPlacesForDirectoryDeps = {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. Fired when the search backend fails.
   * The use case still throws a typed `transient` error afterwards; reporting
   * here surfaces the underlying backend failure (which the thrown 4xx-ish
   * transient code would otherwise hide) to operators. Never affects control flow.
   */
  reportError?: ReporterPort;
};

export async function listPlacesForDirectory(
  deps: ListPlacesForDirectoryDeps,
  _rawInput?: unknown,
): Promise<ListPlacesForDirectoryOutput> {
  const input = parseInput(listPlacesForDirectoryInputSchema, _rawInput);

  // Require at least 2 chars to avoid broad searches.
  if (!input.query || input.query.length < 2) {
    return { places: [] };
  }

  const result = await deps.search.autocomplete({
    query: input.query,
    limit: 20,
    filters: {
      types: ["place"],
      listedInDirectoryOnly: true,
    },
  });

  if (!result.ok) {
    deps.logger?.warn("list_places_for_directory.search_failed", {
      error: result.error.message,
      query: input.query,
    });
    try {
      deps.reportError?.(result.error, {
        tags: { useCase: "listPlacesForDirectory" },
        extra: { query: input.query },
      });
    } catch {
      // Reporting is best-effort — the typed `transient` throw below is the
      // real control flow; a throwing reporter must not pre-empt it.
    }
    throw { code: "transient", message: result.error.message } as const;
  }

  return {
    places: result.value.suggestions
      .filter((s): s is PlaceSuggestion => s.type === "place")
      .map((p) => ({
        id: p.placeId,
        name: p.title,
        city: p.city ?? null,
        region: null, // PlaceSuggestion doesn't carry region; callers only use city
        countryCode: null,
      })),
  };
}

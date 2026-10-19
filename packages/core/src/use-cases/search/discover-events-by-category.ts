import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { parseInput } from "../../lib/io";
import { publicBrowseEventDefaults } from "./_shared/public-browse-defaults";
import {
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_KM,
  MAX_LIMIT,
  MAX_RADIUS_KM,
  eventResultSchema,
  mapEventSuggestions,
} from "./discover-events.shared";

// ─────────────────────────────────────────────────────────────────────────────
// Discover Events by Category (Meilisearch-backed)
// ─────────────────────────────────────────────────────────────────────────────

export const discoverEventsByCategoryInputSchema = z
  .object({
    /** Category slug to filter by (indexed as a tag in Meilisearch). */
    categorySlug: z.string().min(1),
    /** Optional geo filter to scope results near the user. */
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().min(1).max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict()
  .refine(
    (data) => {
      const hasGeo = data.lat !== undefined || data.lng !== undefined;
      if (hasGeo) {
        return data.lat !== undefined && data.lng !== undefined;
      }
      return true;
    },
    {
      message: "If geo filtering is used, both lat and lng must be provided",
    },
  );

export const discoverEventsByCategoryOutputSchema = z
  .object({
    events: z.array(eventResultSchema),
    latencyMs: z.number(),
  })
  .strict();

export type DiscoverEventsByCategoryInput = z.infer<
  typeof discoverEventsByCategoryInputSchema
>;
export type DiscoverEventsByCategoryOutput = z.infer<
  typeof discoverEventsByCategoryOutputSchema
>;

export type DiscoverEventsByCategoryDeps = {
  search: MultiSearchQueryPort;
  /** Read for the category's `active` flag; the search index does not carry it. */
  repos: Pick<Repos, "categories">;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. Fired when the search backend fails
   * and the result is swallowed (empty list returned). Never affects output.
   */
  reportError?: ReporterPort;
};

/**
 * Discover published events matching a category slug.
 *
 * Routes through Meilisearch using the `tags` filter — category slugs are
 * indexed as tags during the search-index build step. Optionally applies a
 * geo radius so results are ranked by proximity when the user's coordinates
 * are available.
 *
 * `Category.active` is read HERE, not at index time: the slug tag on an event
 * document says which category the event is in (the full rebuild and the
 * incremental path both write it whatever `active` is), and this reader
 * decides whether that category is browsable. So deactivating or reactivating
 * a category takes effect on the next request, with no reindex. A missing or
 * inactive category throws `CATEGORY_NOT_FOUND`, the same answer
 * `listEventsByCategory` gives for it.
 */
export async function discoverEventsByCategory(
  deps: DiscoverEventsByCategoryDeps,
  rawInput: unknown,
): Promise<DiscoverEventsByCategoryOutput> {
  const input = parseInput(discoverEventsByCategoryInputSchema, rawInput);

  const category = await deps.repos.categories.getBySlug(input.categorySlug);
  if (!category || !category.active) {
    throw fail("CATEGORY_NOT_FOUND");
  }

  const filters: Parameters<
    MultiSearchQueryPort["autocomplete"]
  >[0]["filters"] = {
    ...publicBrowseEventDefaults(),
    tags: [input.categorySlug],
  };

  if (input.lat !== undefined && input.lng !== undefined) {
    filters.geo = {
      lat: input.lat,
      lng: input.lng,
      radiusKm: input.radiusKm,
    };
  }

  const result = await deps.search.autocomplete({
    query: "",
    limit: input.limit,
    // Category browse — order by soonest-first (nearer breaks ties when geo set).
    sort: "date",
    filters,
  });

  if (!result.ok) {
    deps.logger?.warn("discover_events_by_category.search_failed", {
      error: result.error.message,
      categorySlug: input.categorySlug,
      hasGeo: !!filters.geo,
    });
    try {
      deps.reportError?.(result.error, {
        tags: { useCase: "discoverEventsByCategory" },
        extra: { categorySlug: input.categorySlug, hasGeo: !!filters.geo },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful empty-list fallback into a thrown error.
    }
    return { events: [], latencyMs: 0 };
  }

  deps.logger?.info("discover_events_by_category.completed", {
    categorySlug: input.categorySlug,
    hasGeo: !!filters.geo,
    limit: input.limit,
    resultCount: result.value.suggestions.length,
    latencyMs: result.value.latencyMs,
  });

  const events = mapEventSuggestions(
    result.value.suggestions.filter(
      (s): s is EventSuggestion => s.type === "event",
    ),
  );

  return discoverEventsByCategoryOutputSchema.parse({
    events,
    latencyMs: result.value.latencyMs,
  });
}

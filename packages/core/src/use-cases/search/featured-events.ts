import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { ReadThroughCachePort } from "@th/ports/read-through-cache";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { parseInput } from "../../lib/io";
import { publicBrowseEventDefaults } from "./_shared/public-browse-defaults";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RADIUS_KM,
  eventResultSchema,
  mapEventSuggestions,
} from "./discover-events.shared";

// ─────────────────────────────────────────────────────────────────────────────
// Featured Events
// ─────────────────────────────────────────────────────────────────────────────

export const featuredEventsInputSchema = z
  .object({
    /** Optional geo filter to scope featured events to a region */
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().min(1).max(MAX_RADIUS_KM).optional(),
    /** Optional region code filter (e.g., "US-TX") */
    regionCode: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict()
  .refine(
    (data) => {
      const hasGeo =
        data.lat !== undefined ||
        data.lng !== undefined ||
        data.radiusKm !== undefined;
      if (hasGeo) {
        return (
          data.lat !== undefined &&
          data.lng !== undefined &&
          data.radiusKm !== undefined
        );
      }
      return true;
    },
    {
      message:
        "If geo filtering is used, lat, lng, and radiusKm must all be provided",
    },
  );

export const featuredEventsOutputSchema = z
  .object({
    events: z.array(eventResultSchema),
    latencyMs: z.number(),
  })
  .strict();

export type FeaturedEventsInput = z.infer<typeof featuredEventsInputSchema>;
export type FeaturedEventsOutput = z.infer<typeof featuredEventsOutputSchema>;

export type FeaturedEventsDeps = {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. Fired when the search backend fails
   * and the result is swallowed (empty list returned), so the failure stops
   * being invisible to operators. Never affects the returned value.
   */
  reportError?: ReporterPort;
  /**
   * Optional whole-result cache. Hand one in ONLY for requests whose answer
   * cannot depend on the caller — the transport passes it for anonymous
   * requests only. Geo-filtered requests and malformed region codes are never
   * cached: they would only churn the homepage entry out.
   *
   * A search failure is not cached. It reaches the cache as a throw, so the
   * cache can serve its last good answer (and report) instead of the empty
   * list; with nothing to fall back on, the empty-list swallow below runs as
   * it does without a cache.
   */
  cache?: ReadThroughCachePort;
};

/**
 * A region or country code: "US", "TN", "US-TN", "ny-nyc". Anything else is
 * served uncached so arbitrary input cannot fill the shared cache.
 */
const REGION_CODE = /^[A-Za-z]{2}(?:-[A-Za-z0-9]{1,8})?$/;

/**
 * Internal signal: the search backend answered with an error Result. Thrown
 * inside the load so a cache never stores it, then swallowed below.
 */
class FeaturedSearchFailed extends Error {
  constructor(readonly searchError: Error) {
    super(searchError.message);
    this.name = "FeaturedSearchFailed";
  }
}

/**
 * Find featured events sorted by popularity score.
 * Optionally filter by geographic region.
 */
export async function featuredEvents(
  deps: FeaturedEventsDeps,
  rawInput: unknown,
): Promise<FeaturedEventsOutput> {
  const input = parseInput(featuredEventsInputSchema, rawInput);

  const filters: Parameters<
    MultiSearchQueryPort["autocomplete"]
  >[0]["filters"] = publicBrowseEventDefaults();

  if (
    input.lat !== undefined &&
    input.lng !== undefined &&
    input.radiusKm !== undefined
  ) {
    filters.geo = {
      lat: input.lat,
      lng: input.lng,
      radiusKm: input.radiusKm,
    };
  }

  if (input.regionCode) {
    filters.regionCodes = [input.regionCode];
  }

  const load = async (): Promise<FeaturedEventsOutput> => {
    const result = await deps.search.autocomplete({
      query: "",
      limit: input.limit,
      // Browse surface — order by soonest-first (nearer breaks ties when geo set).
      sort: "date",
      filters,
    });
    if (!result.ok) throw new FeaturedSearchFailed(result.error);

    deps.logger?.info("featured_events.completed", {
      regionCode: input.regionCode,
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

    return featuredEventsOutputSchema.parse({
      events,
      latencyMs: result.value.latencyMs,
    });
  };

  // "" and absent both mean "no region filter" (the `if (input.regionCode)`
  // above), so they share a key. Case is NOT folded: the index compares
  // region codes exactly, so "tn" and "TN" are different answers.
  const regionKey = input.regionCode ? input.regionCode : null;
  const cacheable =
    deps.cache !== undefined &&
    !filters.geo &&
    (regionKey === null || REGION_CODE.test(regionKey));

  try {
    if (cacheable && deps.cache) {
      return await deps.cache.getOrLoad(
        `search.featuredEvents:${JSON.stringify([regionKey, input.limit])}`,
        load,
      );
    }
    return await load();
  } catch (err) {
    if (!(err instanceof FeaturedSearchFailed)) throw err;
    deps.logger?.warn("featured_events.search_failed", {
      error: err.searchError.message,
      regionCode: input.regionCode,
      hasGeo: !!filters.geo,
    });
    try {
      deps.reportError?.(err.searchError, {
        tags: { useCase: "featuredEvents" },
        extra: { regionCode: input.regionCode, hasGeo: !!filters.geo },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful empty-list fallback into a thrown error.
    }
    return { events: [], latencyMs: 0 };
  }
}

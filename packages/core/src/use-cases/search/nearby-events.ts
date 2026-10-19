import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
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
// Nearby Events
// ─────────────────────────────────────────────────────────────────────────────

export const nearbyEventsInputSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusKm: z.number().min(1).max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const nearbyEventsOutputSchema = z
  .object({
    events: z.array(eventResultSchema),
    latencyMs: z.number(),
  })
  .strict();

export type NearbyEventsInput = z.infer<typeof nearbyEventsInputSchema>;
export type NearbyEventsOutput = z.infer<typeof nearbyEventsOutputSchema>;

export type NearbyEventsDeps = {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. Fired when the search backend fails
   * and the result is swallowed (empty list returned). Never affects output.
   */
  reportError?: ReporterPort;
};

/**
 * Find events near a geographic coordinate.
 * Results are sorted by distance (closest first).
 */
export async function nearbyEvents(
  deps: NearbyEventsDeps,
  rawInput: unknown,
): Promise<NearbyEventsOutput> {
  const input = parseInput(nearbyEventsInputSchema, rawInput);

  const result = await deps.search.autocomplete({
    query: "",
    limit: input.limit,
    // "Near me" — nearest-first, soonest breaks same-distance ties.
    sort: "distance",
    filters: {
      ...publicBrowseEventDefaults(),
      geo: {
        lat: input.lat,
        lng: input.lng,
        radiusKm: input.radiusKm,
      },
    },
  });

  if (!result.ok) {
    deps.logger?.warn("nearby_events.search_failed", {
      error: result.error.message,
      lat: input.lat,
      lng: input.lng,
      radiusKm: input.radiusKm,
    });
    try {
      deps.reportError?.(result.error, {
        tags: { useCase: "nearbyEvents" },
        extra: { lat: input.lat, lng: input.lng, radiusKm: input.radiusKm },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful empty-list fallback into a thrown error.
    }
    return { events: [], latencyMs: 0 };
  }

  deps.logger?.info("nearby_events.completed", {
    lat: input.lat,
    lng: input.lng,
    radiusKm: input.radiusKm,
    limit: input.limit,
    resultCount: result.value.suggestions.length,
    latencyMs: result.value.latencyMs,
  });

  const events = mapEventSuggestions(
    result.value.suggestions.filter(
      (s): s is EventSuggestion => s.type === "event",
    ),
  );

  return nearbyEventsOutputSchema.parse({
    events,
    latencyMs: result.value.latencyMs,
  });
}

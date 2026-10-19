import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { parseInput } from "../../lib/io";
import { publicBrowseEventDefaults } from "./_shared/public-browse-defaults";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  eventResultSchema,
  mapEventSuggestions,
} from "./discover-events.shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tiered Popular Events (with geo fallback)
// ─────────────────────────────────────────────────────────────────────────────

/** Geo tier configuration for progressive fallback */
const GEO_TIERS = [
  { name: "local", radiusKm: 25 },
  { name: "regional", radiusKm: 150 },
  { name: "country", radiusKm: null },
  { name: "global", radiusKm: null },
] as const;

type GeoTierName = (typeof GEO_TIERS)[number]["name"];

export const tieredPopularEventsInputSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /** Optional region code for country-level fallback (e.g., "US", "US-TX") */
    regionCode: z.string().optional(),
    /** Minimum events needed before returning (will try next tier if under) */
    minResults: z.number().int().min(1).max(20).default(6),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const tieredPopularEventsOutputSchema = z
  .object({
    events: z.array(eventResultSchema),
    /** Which geo tier the results came from */
    tier: z.enum(["local", "regional", "country", "global"]),
    latencyMs: z.number(),
  })
  .strict();

export type TieredPopularEventsInput = z.infer<
  typeof tieredPopularEventsInputSchema
>;
export type TieredPopularEventsOutput = z.infer<
  typeof tieredPopularEventsOutputSchema
>;

export type TieredPopularEventsDeps = {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  /**
   * Reports a failing tier. The loop swallows it and tries the next tier (or
   * returns an empty section), so without this a backend or schema-drift
   * failure never reaches Sentry: `logger.warn` is not captured.
   */
  reportError?: ReporterPort;
};

/**
 * Find popular events with automatic geo fallback.
 * Tries local → regional → country → global until minResults is met.
 */
export async function tieredPopularEvents(
  deps: TieredPopularEventsDeps,
  rawInput: unknown,
): Promise<TieredPopularEventsOutput> {
  const input = parseInput(tieredPopularEventsInputSchema, rawInput);
  const startTime = Date.now();

  for (const tier of GEO_TIERS) {
    const filters: Parameters<
      MultiSearchQueryPort["autocomplete"]
    >[0]["filters"] = publicBrowseEventDefaults();

    if (tier.name === "local" || tier.name === "regional") {
      filters.geo = {
        lat: input.lat,
        lng: input.lng,
        radiusKm: tier.radiusKm!,
      };
    } else if (tier.name === "country" && input.regionCode) {
      const countryCode = input.regionCode.split("-")[0] ?? input.regionCode;
      filters.regionCodes = [countryCode];
    }

    const result = await deps.search.autocomplete({
      query: "",
      limit: input.limit,
      // Browse rail — soonest-first, nearer breaks ties (geo tiers supply coords).
      sort: "date",
      filters,
    });

    if (!result.ok) {
      deps.logger?.warn("tiered_popular_events.tier_failed", {
        tier: tier.name,
        error: result.error.message,
      });
      try {
        deps.reportError?.(result.error, {
          tags: { useCase: "tieredPopularEvents", tier: tier.name },
          extra: { regionCode: input.regionCode, limit: input.limit },
        });
      } catch {
        // Reporting is best-effort: a throwing reporter must never turn the
        // tier fallback into a thrown error.
      }
      continue;
    }

    const events = mapEventSuggestions(
      result.value.suggestions.filter(
        (s): s is EventSuggestion => s.type === "event",
      ),
    );

    if (events.length >= input.minResults || tier.name === "global") {
      const latencyMs = Date.now() - startTime;

      deps.logger?.info("tiered_popular_events.completed", {
        tier: tier.name,
        lat: input.lat,
        lng: input.lng,
        regionCode: input.regionCode,
        resultCount: events.length,
        minResults: input.minResults,
        latencyMs,
      });

      return tieredPopularEventsOutputSchema.parse({
        events,
        tier: tier.name,
        latencyMs,
      });
    }

    deps.logger?.log("debug", "tiered_popular_events.tier_insufficient", {
      tier: tier.name,
      resultCount: events.length,
      minResults: input.minResults,
    });
  }

  return tieredPopularEventsOutputSchema.parse({
    events: [],
    tier: "global" as GeoTierName,
    latencyMs: Date.now() - startTime,
  });
}

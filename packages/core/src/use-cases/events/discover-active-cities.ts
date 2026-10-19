import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ActiveCityRecord, Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

const DEFAULT_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const discoverActiveCitiesInputSchema = z
  .object({
    /** Restrict to cities within this country code (case-insensitive match). */
    countryCode: z.string().trim().min(2).max(8).optional(),
  })
  .strict();

const activeCitySchema = z.object({
  city: z.string(),
  regionCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  /** Centroid of the city's upcoming public events (null when none carry coords). */
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});

export const discoverActiveCitiesOutputSchema = z
  .object({
    cities: z.array(activeCitySchema),
  })
  .strict();

export type DiscoverActiveCitiesInput = z.infer<
  typeof discoverActiveCitiesInputSchema
>;
export type DiscoverActiveCitiesOutput = z.infer<
  typeof discoverActiveCitiesOutputSchema
>;

export type DiscoverActiveCitiesDeps = {
  repos: Pick<Repos, "events">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const toCity = (record: ActiveCityRecord) => ({
  city: record.city,
  regionCode: record.regionCode ?? null,
  countryCode: record.countryCode ?? null,
  eventCount: record.eventCount,
  lat: record.lat ?? null,
  lng: record.lng ?? null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distinct cities that currently have upcoming published, public events,
 * ordered most-active first. Powers the home-page "city by city" marquee.
 *
 * Read-only aggregate over the `Event` table (the source of truth) — the
 * aggregation lives in the adapter, gated on `visibility = 'PUBLIC'`; this use
 * case validates input, calls the repo, and maps to the output schema. No
 * catch-and-fallback (a throw rides the tRPC backstop).
 */
export async function discoverActiveCities(
  deps: DiscoverActiveCitiesDeps,
  rawInput: unknown,
): Promise<DiscoverActiveCitiesOutput> {
  const input = parseInput(discoverActiveCitiesInputSchema, rawInput);

  // Only upcoming events count — `startsAfter: now` is the floor.
  const startsAfter = new Date();

  const records = await deps.repos.events.discoverActiveCities({
    startsAfter,
    countryCode: input.countryCode,
    limit: DEFAULT_LIMIT,
  });

  deps.logger?.info("events.discover_active_cities", {
    countryCode: input.countryCode,
    resultCount: records.length,
  });

  return discoverActiveCitiesOutputSchema.parse({
    cities: records.map(toCity),
  });
}

import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { toPublicHeadlineSummary } from "./anonymization-policy";

// ---------------------------------------------------------------------------
// getTrustedVenuesNearPlace (place-review-anonymization FR-001/FR-003)
//
// Public "trusted venues near you" incentive list. Served EXCLUSIVELY from
// PlaceStats.publicSnapshot through the anonymization policy: only places
// with a published headline slice appear, and the emitted figures are the
// snapshot's coarsened band + 5%-stepped percentage. Never reads the live
// stats columns — those refresh every 30 minutes and would let a venue owner
// catch an n→n+1 transition and recover a fresh review by subtraction.
// ---------------------------------------------------------------------------

export const getTrustedVenuesNearPlaceInputSchema = z
  .object({
    placeId: z.string().uuid(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const getTrustedVenuesNearPlaceOutputSchema = z
  .object({
    venues: z.array(
      z.object({
        placeId: z.string(),
        name: z.string(),
        /** Coarsened count band from the snapshot ("3".."19", "20+", "50+"). */
        reviewCountBand: z.string(),
        /** 5%-stepped would-play-again share (0–100) from the snapshot. */
        wouldPlayAgainPct: z.number().nullable(),
      }),
    ),
    city: z.string().nullable(),
  })
  .strict();

export type GetTrustedVenuesNearPlaceInput = z.infer<
  typeof getTrustedVenuesNearPlaceInputSchema
>;
export type GetTrustedVenuesNearPlaceOutput = z.infer<
  typeof getTrustedVenuesNearPlaceOutputSchema
>;

export type GetTrustedVenuesNearPlaceDeps = {
  repos: Pick<Repos, "places" | "placeStats">;
  logger?: LoggerPort;
};

export async function getTrustedVenuesNearPlace(
  deps: GetTrustedVenuesNearPlaceDeps,
  rawInput: unknown,
): Promise<GetTrustedVenuesNearPlaceOutput> {
  const input = parseInput(getTrustedVenuesNearPlaceInputSchema, rawInput);

  // Look up the reviewed place to get its city
  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  if (!place.city) {
    return { venues: [], city: null };
  }

  // Candidates carry the raw stored snapshot; headline-less ones (below the
  // k-threshold, or invalid) are excluded below, so overscan a bounded
  // multiple to keep the list filled.
  const candidates = await deps.repos.placeStats.listPublishedSnapshotsByCity({
    city: place.city,
    region: place.region ?? undefined,
    excludePlaceId: input.placeId,
    limit: Math.min(input.limit * 5, 100),
  });
  // FR-003: a place with performer reviews switched off is never among the
  // candidates. That filter is UNCONDITIONAL inside the read (port contract),
  // not an option this caller could forget — a post-filter here would also
  // skew the overscan.

  const venues = candidates
    .flatMap((candidate) => {
      // Policy chokepoint: parses + coarse-shapes; null → exclude (a place
      // without a published headline must not even be listed).
      const headline = toPublicHeadlineSummary(candidate.publicSnapshot);
      if (headline === null) return [];
      return [
        {
          placeId: candidate.placeId,
          name: candidate.placeName,
          ...headline,
        },
      ];
    })
    // Rank off the COARSENED snapshot values only (never live columns).
    .sort(
      (a, b) =>
        (b.wouldPlayAgainPct ?? -1) - (a.wouldPlayAgainPct ?? -1) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, input.limit);

  return { venues, city: place.city };
}

import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { placePublicSnapshotSchema } from "./anonymization-policy";

// ---------------------------------------------------------------------------
// getPlacePublicStats (place-review-anonymization FR-002)
//
// Serves PlaceStats.publicSnapshot VERBATIM, or null when no snapshot has
// been published yet. Never computes from live review rows — freshness is
// deliberately bounded by the weekly recompute job so a venue watching its
// page can't correlate a stats change with a specific recent gig.
// ---------------------------------------------------------------------------

export const getPlacePublicStatsInputSchema = z
  .object({
    placeId: z.string().uuid(),
  })
  .strict();

export const getPlacePublicStatsOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    /** The anonymized public snapshot, or null when none is published. */
    snapshot: placePublicSnapshotSchema.nullable(),
    /** When the snapshot was computed ("updated periodically" copy source). */
    snapshotAt: z.date().nullable(),
  })
  .strict();

export type GetPlacePublicStatsInput = z.infer<
  typeof getPlacePublicStatsInputSchema
>;
export type GetPlacePublicStatsOutput = z.infer<
  typeof getPlacePublicStatsOutputSchema
>;

export type GetPlacePublicStatsDeps = {
  repos: Pick<Repos, "placeStats" | "places">;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for the corrupt-snapshot swallow branch. */
  reportError?: ReporterPort;
};

export async function getPlacePublicStats(
  deps: GetPlacePublicStatsDeps,
  rawInput: unknown,
): Promise<GetPlacePublicStatsOutput> {
  const input = parseInput(getPlacePublicStatsInputSchema, rawInput);

  // Performer-review switch (venue-track-record-and-review-switch FR-003, R1):
  // a place that turned performer reviews off serves NO public performer
  // surface, this one included — same `snapshot: null` shape as "nothing
  // published yet", so no caller can tell the two apart. A missing place is
  // closed too; this public read never threw for one and still does not.
  const place = await deps.repos.places.getById(input.placeId);
  if (place?.communityReviewsEnabled !== true) {
    return { placeId: input.placeId, snapshot: null, snapshotAt: null };
  }

  const stats = await deps.repos.placeStats.getByPlaceId(input.placeId);
  if (!stats || stats.publicSnapshot == null) {
    return { placeId: input.placeId, snapshot: null, snapshotAt: null };
  }

  // Validate the stored JSON against the policy shape before serving. On a
  // mismatch (corrupt row, incompatible old version) fail CLOSED for
  // anonymity: serve nothing rather than raw numbers — and make the swallow
  // visible to operators.
  const parsed = placePublicSnapshotSchema.safeParse(stats.publicSnapshot);
  if (!parsed.success) {
    deps.logger?.error("place-reviews.public-snapshot.invalid", {
      placeId: input.placeId,
      issues: parsed.error.issues,
    });
    try {
      deps.reportError?.(parsed.error, {
        tags: { useCase: "getPlacePublicStats", placeId: input.placeId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return { placeId: input.placeId, snapshot: null, snapshotAt: null };
  }

  return {
    placeId: input.placeId,
    snapshot: parsed.data,
    snapshotAt: stats.publicSnapshotAt,
  };
}

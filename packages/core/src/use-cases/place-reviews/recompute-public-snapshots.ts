import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  buildPublicSnapshot,
  computeSnapshotAggregates,
  isReviewPubliclyIncludable,
  placePublicSnapshotSchema,
} from "./anonymization-policy";

// ---------------------------------------------------------------------------
// recomputePublicSnapshots (place-review-anonymization FR-002, FR-005)
//
// Weekly full sweep over the UNION of (places with visible reviews) ∪
// (places already carrying a published snapshot): rebuild the coarsened
// public snapshot via the anonymization policy and persist it on
// PlaceStats.publicSnapshot/publicSnapshotAt. The second half of the union
// matters when moderation hides a place's last visible review — recomputing
// it yields the empty { version: 1 } snapshot, so the old published one
// can't keep serving forever. PLATFORM-sourced reviews inside the 14-day
// post-event embargo are excluded. Idempotent — re-running against
// unchanged data writes the same snapshot.
//
// Failure posture (NFR-002): a failure on one place reports via ReporterPort,
// KEEPS that place's stale snapshot (fail-closed for anonymity, degraded for
// freshness — never fall back to live stats), and continues the sweep.
// ---------------------------------------------------------------------------

export const recomputePublicSnapshotsInputSchema = z
  .object({
    /** Page size for the place-id sweep (the sweep itself is always full). */
    batchSize: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .optional()
  .default({ batchSize: 100 });

export type RecomputePublicSnapshotsInput = z.infer<
  typeof recomputePublicSnapshotsInputSchema
>;

export type RecomputePublicSnapshotsDeps = {
  repos: Pick<Repos, "placeReviews" | "placeStats" | "events">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-place failures (NFR-002). */
  reportError?: ReporterPort;
};

export type RecomputePublicSnapshotsOutput = {
  placesRecomputed: number;
  placesFailed: number;
};

export async function recomputePublicSnapshots(
  deps: RecomputePublicSnapshotsDeps,
  rawInput?: unknown,
): Promise<RecomputePublicSnapshotsOutput> {
  const input = parseInput(recomputePublicSnapshotsInputSchema, rawInput ?? {});
  const now = deps.clock.now();

  let placesRecomputed = 0;
  let placesFailed = 0;

  // Memoized per-run so multi-review events resolve once. Missing events
  // memoize as null (fall back to gigDate in the eligibility check).
  const eventEndCache = new Map<string, Date | null>();
  async function eventEndsAt(eventId: string): Promise<Date | null> {
    if (eventEndCache.has(eventId)) return eventEndCache.get(eventId)!;
    const event = await deps.repos.events.getById(eventId);
    const endsAt = event ? (event.endsAt ?? event.startsAt) : null;
    eventEndCache.set(eventId, endsAt);
    return endsAt;
  }

  async function recomputePlace(placeId: string): Promise<void> {
    try {
      // Same visibility filter as the live-stats pipeline (non-hidden,
      // non-flagged); the policy's embargo predicate then drops PLATFORM
      // reviews younger than 14 days post-event.
      const reviews = await deps.repos.placeReviews.listForStats(placeId);

      const eligible: typeof reviews = [];
      for (const review of reviews) {
        const endsAt =
          review.source === "PLATFORM" && review.eventId !== null
            ? await eventEndsAt(review.eventId)
            : null;
        if (
          isReviewPubliclyIncludable(
            {
              source: review.source,
              eventEndsAt: endsAt,
              gigDate: review.gigDate,
            },
            now,
          )
        ) {
          eligible.push(review);
        }
      }

      const snapshot = buildPublicSnapshot(
        computeSnapshotAggregates(eligible),
      );
      // Write-time validation: a snapshot that doesn't match the policy
      // shape fails HERE (per-place failure + Sentry via the catch below)
      // instead of a week later when getPlacePublicStats refuses to serve it.
      placePublicSnapshotSchema.parse(snapshot);
      await deps.repos.placeStats.setPublicSnapshot({
        placeId,
        snapshot,
        computedAt: now,
      });
      placesRecomputed += 1;
    } catch (err) {
      // Deliberate swallow: keep the stale snapshot serving and continue
      // with the other places. Must stay visible in Sentry (NFR-002).
      placesFailed += 1;
      deps.logger?.error("place-reviews.recompute-public-snapshots.failed", {
        err,
        placeId,
      });
      try {
        deps.reportError?.(err, {
          tags: { useCase: "recomputePublicSnapshots", placeId },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  const processed = new Set<string>();

  // Phase 1: every place with at least one visible review.
  // No short-page early break: the DB may legitimately return a short page
  // mid-sweep, and the ascending cursor already guarantees progress — so
  // loop until an EMPTY page, otherwise later places would silently never
  // get a snapshot.
  let afterPlaceId: string | undefined;
  while (true) {
    const placeIds = await deps.repos.placeReviews.listPlaceIdsWithVisibleReviews(
      { limit: input.batchSize, afterPlaceId },
    );
    if (placeIds.length === 0) break;
    afterPlaceId = placeIds[placeIds.length - 1]!;

    for (const placeId of placeIds) {
      processed.add(placeId);
      await recomputePlace(placeId);
    }
  }

  // Phase 2 (union): places already carrying a published snapshot but not
  // seen above — i.e. all their reviews got hidden/flagged since the last
  // sweep. Recomputing them yields the empty { version: 1 } snapshot, so
  // moderation actually retracts public aggregates. (Writes never remove a
  // row from this cursor's result set — the snapshot stays non-null — so
  // pagination is stable against our own updates.)
  afterPlaceId = undefined;
  while (true) {
    const placeIds = await deps.repos.placeStats.listPlaceIdsWithPublishedSnapshot(
      { limit: input.batchSize, afterPlaceId },
    );
    if (placeIds.length === 0) break;
    afterPlaceId = placeIds[placeIds.length - 1]!;

    for (const placeId of placeIds) {
      if (processed.has(placeId)) continue;
      processed.add(placeId);
      await recomputePlace(placeId);
    }
  }

  return { placesRecomputed, placesFailed };
}

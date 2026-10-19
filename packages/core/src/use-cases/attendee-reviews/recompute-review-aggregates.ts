import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { ReviewAggregateSubjectType } from "@th/ports/repos/review-aggregates";

import { parseInput } from "../../lib/io";
import {
  attendeeReviewSnapshotSchema,
  buildAttendeeReviewSnapshot,
} from "./aggregation-policy";

// ---------------------------------------------------------------------------
// recomputeReviewAggregates (attendee-reviews FR-004, NFR-003)
//
// Weekly full recompute of the ReviewAggregate snapshots for ALL FOUR subject
// types. One attendee review rolls up to its event, its venue (placeId), its
// organizer/owner (ownerId) and its series (seriesId) — so a single review
// contributes to up to four aggregates, each rebuilt independently here from
// the NON-HIDDEN reviews that share the denormalized target.
//
// For every subject type the sweep runs two phases (mirrors the place-review
// recompute):
//   1. every subject with at least one non-hidden review → rebuild snapshot.
//   2. UNION: every subject already carrying a published aggregate but NOT seen
//      in phase 1 — i.e. all its reviews got hidden since the last sweep.
//      Recomputing yields the empty `{ version: 1 }` snapshot so moderation
//      actually retracts public aggregates instead of serving a stale one.
//
// Idempotent — re-running against unchanged data writes the same snapshots.
// Snapshot delay is the anonymity mechanism (FR-003/FR-004): a fresh review
// changes nothing public until the next recompute.
//
// Failure posture (NFR-003): a failure on one subject reports via ReporterPort,
// KEEPS that subject's stale snapshot (fail-closed for anonymity, degraded for
// freshness), and continues the sweep.
// ---------------------------------------------------------------------------

export const recomputeReviewAggregatesInputSchema = z
  .object({
    /** Page size for each subject-id sweep (the sweep itself is always full). */
    batchSize: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .optional()
  .default({ batchSize: 100 });

export type RecomputeReviewAggregatesInput = z.infer<
  typeof recomputeReviewAggregatesInputSchema
>;

export type RecomputeReviewAggregatesDeps = {
  repos: Pick<Repos, "attendeeReviews" | "reviewAggregates">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for swallowed per-subject failures (NFR-003). */
  reportError?: ReporterPort;
};

export type RecomputeReviewAggregatesOutput = {
  subjectsRecomputed: number;
  subjectsFailed: number;
};

const SUBJECT_TYPES: readonly ReviewAggregateSubjectType[] = [
  "EVENT",
  "PLACE",
  "OWNER",
  "SERIES",
];

export async function recomputeReviewAggregates(
  deps: RecomputeReviewAggregatesDeps,
  rawInput?: unknown,
): Promise<RecomputeReviewAggregatesOutput> {
  const input = parseInput(recomputeReviewAggregatesInputSchema, rawInput ?? {});
  const now = deps.clock.now();

  let subjectsRecomputed = 0;
  let subjectsFailed = 0;

  async function recomputeSubject(
    subjectType: ReviewAggregateSubjectType,
    subjectId: string,
  ): Promise<void> {
    try {
      const rows = await deps.repos.attendeeReviews.listAggRowsForSubject({
        subjectType,
        subjectId,
      });
      // Verified/community split + per-source suppression lives in the policy
      // (FR-010); PLACE rows carry both sources, EVENT/OWNER/SERIES only verified.
      const snapshot = buildAttendeeReviewSnapshot(rows);
      // Write-time validation: a snapshot that doesn't match the policy shape
      // fails HERE (per-subject failure + Sentry via the catch) instead of a
      // week later when a public read refuses to serve it.
      attendeeReviewSnapshotSchema.parse(snapshot);
      await deps.repos.reviewAggregates.setSnapshot({
        subjectType,
        subjectId,
        snapshot,
        computedAt: now,
      });
      subjectsRecomputed += 1;
    } catch (err) {
      // Deliberate swallow: keep the stale snapshot serving and continue with
      // the other subjects. Must stay visible in Sentry (NFR-003).
      subjectsFailed += 1;
      deps.logger?.error("attendee-reviews.recompute-review-aggregates.failed", {
        err,
        subjectType,
        subjectId,
      });
      try {
        deps.reportError?.(err, {
          tags: {
            useCase: "recomputeReviewAggregates",
            subjectType,
          },
          extra: { subjectId },
        });
      } catch {
        // A throwing reporter must never change behaviour.
      }
    }
  }

  for (const subjectType of SUBJECT_TYPES) {
    const processed = new Set<string>();

    // Phase 1: every subject with at least one non-hidden review. No
    // short-page early break — the ascending cursor guarantees progress, so
    // loop until an EMPTY page (a short mid-sweep page is legitimate).
    let afterSubjectId: string | undefined;
    while (true) {
      const subjectIds =
        await deps.repos.attendeeReviews.listSubjectIdsWithReviews({
          subjectType,
          limit: input.batchSize,
          afterSubjectId,
        });
      if (subjectIds.length === 0) break;
      afterSubjectId = subjectIds[subjectIds.length - 1]!;

      for (const subjectId of subjectIds) {
        processed.add(subjectId);
        await recomputeSubject(subjectType, subjectId);
      }
    }

    // Phase 2 (union): subjects already carrying an aggregate but not seen
    // above — all their reviews got hidden since the last sweep. Recomputing
    // yields the empty `{ version: 1 }` snapshot, retracting public aggregates.
    afterSubjectId = undefined;
    while (true) {
      const subjectIds =
        await deps.repos.reviewAggregates.listSubjectIdsWithAggregate({
          subjectType,
          limit: input.batchSize,
          afterSubjectId,
        });
      if (subjectIds.length === 0) break;
      afterSubjectId = subjectIds[subjectIds.length - 1]!;

      for (const subjectId of subjectIds) {
        if (processed.has(subjectId)) continue;
        processed.add(subjectId);
        await recomputeSubject(subjectType, subjectId);
      }
    }
  }

  return { subjectsRecomputed, subjectsFailed };
}

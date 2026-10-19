import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { attendeeReviewSnapshotSchema } from "./aggregation-policy";

// ---------------------------------------------------------------------------
// getReviewAggregate (attendee-reviews FR-004/FR-005)
//
// Serves a ReviewAggregate snapshot VERBATIM, or null when none is published.
// NEVER computes from live AttendeeReview rows — freshness is deliberately
// bounded by the weekly recompute job so an organizer/venue watching their page
// can't correlate a public change with a specific recent attendee (FR-003).
//
// PUBLIC read: returns ONLY the coarsened, suppression-gated aggregate — never
// a per-review rating, text, or reviewer identity (FR-002). A subject below the
// reviewer threshold serves `snapshot: null` (the stored `{ version: 1 }` has
// no `summary`), fail-closed.
//
// PLACE opt-in gate (venue-rating-block-and-owner-optin FR-005): the attendee
// venue aggregate is PRIVATE by default. When `Place.attendeeReviewsPublic` is
// false the PLACE subject serves nothing publicly — defense in depth at READ
// time, so flipping the toggle takes effect instantly without waiting for the
// weekly recompute to suppress the snapshot. EVENT/OWNER/SERIES subjects are
// NEVER gated by this flag (FR-007: performer/organizer surfaces are untouched).
// ---------------------------------------------------------------------------

export const reviewAggregateSubjectTypeSchema = z.enum([
  "EVENT",
  "PLACE",
  "OWNER",
  "SERIES",
]);

export const getReviewAggregateInputSchema = z
  .object({
    subjectType: reviewAggregateSubjectTypeSchema,
    subjectId: z.string().uuid(),
  })
  .strict();

export const getReviewAggregateOutputSchema = z
  .object({
    subjectType: reviewAggregateSubjectTypeSchema,
    subjectId: z.string().uuid(),
    /**
     * The anonymized public snapshot with a published `summary`, or null when
     * none is published OR the subject is below threshold (empty summary).
     * Renderers can trust `snapshot.summary` to be present when non-null.
     */
    snapshot: attendeeReviewSnapshotSchema.nullable(),
    /** When the snapshot was computed, or null when none is published. */
    computedAt: z.date().nullable(),
  })
  .strict();

export type GetReviewAggregateInput = z.infer<
  typeof getReviewAggregateInputSchema
>;
export type GetReviewAggregateOutput = z.infer<
  typeof getReviewAggregateOutputSchema
>;

export type GetReviewAggregateDeps = {
  repos: Pick<Repos, "reviewAggregates" | "places">;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for the corrupt-snapshot swallow branch. */
  reportError?: ReporterPort;
};

export async function getReviewAggregate(
  deps: GetReviewAggregateDeps,
  rawInput: unknown,
): Promise<GetReviewAggregateOutput> {
  const input = parseInput(getReviewAggregateInputSchema, rawInput);

  const nothing: GetReviewAggregateOutput = {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    snapshot: null,
    computedAt: null,
  };

  // PLACE opt-in gate (FR-005): the attendee venue aggregate is only public
  // when the owner has flipped Place.attendeeReviewsPublic. Fail closed on a
  // missing place. This gate is PLACE-only — EVENT/OWNER/SERIES never read it
  // (FR-007), so performer/organizer aggregates are unaffected.
  if (input.subjectType === "PLACE") {
    const place = await deps.repos.places.getById(input.subjectId);
    if (!place || !place.attendeeReviewsPublic) return nothing;
  }

  const row = await deps.repos.reviewAggregates.getBySubject({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });
  if (!row || row.snapshot == null) return nothing;

  // Validate the stored JSON against the policy shape before serving. On a
  // mismatch (corrupt row, incompatible old version) fail CLOSED for anonymity:
  // serve nothing rather than raw numbers — and make the swallow visible.
  const parsed = attendeeReviewSnapshotSchema.safeParse(row.snapshot);
  if (!parsed.success) {
    deps.logger?.error("attendee-reviews.review-aggregate.invalid", {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      issues: parsed.error.issues,
    });
    try {
      deps.reportError?.(parsed.error, {
        tags: {
          useCase: "getReviewAggregate",
          subjectType: input.subjectType,
        },
        extra: { subjectId: input.subjectId },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return nothing;
  }

  // Below-threshold `{ version: 1 }` (no verified summary AND no community
  // line) = nothing to show — publish null, not an empty shell. A community-only
  // snapshot (verified below k, community above) still serves — the community
  // line is provenance-labelled downstream (FR-010/FR-011).
  if (parsed.data.summary === undefined && parsed.data.community === undefined) {
    return nothing;
  }

  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    snapshot: parsed.data,
    computedAt: row.computedAt,
  };
}

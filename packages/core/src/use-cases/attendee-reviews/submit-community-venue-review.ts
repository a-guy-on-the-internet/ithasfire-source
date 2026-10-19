import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { ATTENDEE_REVIEW_TEXT_MAX_CHARS } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// submitCommunityVenueReview (venue-rating-block-and-owner-optin FR-009)
//
// The UNVERIFIED, venue-direct COMMUNITY review that solves the attendee
// cold-start problem — a young venue with no platform ticket history can still
// collect customer feedback. Mirrors PlaceReview's anonymous seed pattern on the
// AttendeeReview pipeline:
//   - source = COMMUNITY, eventId = null (anchors to placeId only, no rollup),
//   - humanId for a signed-in submitter, else anonymousName + anonymousEmail.
//
// FULLY OPEN for v1 (FR-009): no scanned-ticket check, no email confirmation, no
// approval queue. The ONLY throttle is a per-email + per-IP rate limit applied
// at the transport (FR-013) — never a submission gate for a real person. Later
// gates (magic-link confirm, approval queue) layer on the COMMUNITY tag with no
// schema change (FR-012).
//
// Segregation (FR-010): these rows are provenance-tagged COMMUNITY so the
// recompute + owner reads count them SEPARATELY from verified attendee reviews —
// community volume never inflates the "verified" headline.
// ─────────────────────────────────────────────────────────────────────────────

const rating = z.number().int().min(1).max(5);

const COMMUNITY_NAME_MAX_CHARS = 120;
const COMMUNITY_EMAIL_MAX_CHARS = 320;

/**
 * The base object shape (no cross-field refinement) — exported so the transport
 * can `.omit({ humanId: true })` for the client-facing input (humanId is
 * server-injected from the session).
 */
export const submitCommunityVenueReviewBaseSchema = z
  .object({
    placeId: z.string().uuid(),
    /** Server-injected from the session when signed in; absent for guests. */
    humanId: z.string().uuid().optional(),
    /** Guest name (mirrors PlaceReview.anonymousName). Sanitized before length. */
    anonymousName: plainTextRequired(COMMUNITY_NAME_MAX_CHARS).optional(),
    /** Guest email — REQUIRED-but-unverified (FR-013). */
    anonymousEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(COMMUNITY_EMAIL_MAX_CHARS)
      .optional(),
    overallRating: rating,
    soundQuality: rating.optional(),
    venueComfort: rating.optional(),
    organization: rating.optional(),
    valueForMoney: rating.optional(),
    /** Feedback for the venue owner. Sanitized BEFORE the length check. */
    text: plainTextMultilineOptional(ATTENDEE_REVIEW_TEXT_MAX_CHARS).optional(),
  })
  .strict();

/**
 * A guest (no signed-in human) MUST supply name + email — the email is the seam
 * a later magic-link confirm upgrades (FR-012/FR-013).
 */
const requireGuestIdentity = (
  val: { humanId?: string; anonymousName?: string; anonymousEmail?: string },
  ctx: z.RefinementCtx,
) => {
  if (!val.humanId) {
    if (!val.anonymousName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anonymousName"],
        message: "Name is required",
      });
    }
    if (!val.anonymousEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anonymousEmail"],
        message: "Email is required",
      });
    }
  }
};

export const submitCommunityVenueReviewInputSchema =
  submitCommunityVenueReviewBaseSchema.superRefine(requireGuestIdentity);

export type SubmitCommunityVenueReviewInput = z.infer<
  typeof submitCommunityVenueReviewInputSchema
>;

export const submitCommunityVenueReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
  })
  .strict();

export type SubmitCommunityVenueReviewOutput = z.infer<
  typeof submitCommunityVenueReviewOutputSchema
>;

export type SubmitCommunityVenueReviewDeps = {
  repos: Pick<Repos, "tx" | "places" | "attendeeReviews" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function submitCommunityVenueReview(
  deps: SubmitCommunityVenueReviewDeps,
  rawInput: unknown,
): Promise<SubmitCommunityVenueReviewOutput> {
  const input = parseInput(submitCommunityVenueReviewInputSchema, rawInput);
  const now = deps.clock.now();

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Don't accept community feedback for a SUSPENDED/ARCHIVED venue — a
  // non-active place is not a live review target (mirrors the write-guard in
  // generate-events-from-series).
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE");
  }

  // Signed-in submitters bind to their humanId (and drop any guest identity);
  // guests carry name/email. Normalize an all-whitespace comment to NULL.
  const humanId = input.humanId ?? null;
  const anonymousName = humanId ? null : (input.anonymousName ?? null);
  const anonymousEmail = humanId ? null : (input.anonymousEmail ?? null);
  const text =
    input.text !== undefined && input.text.length > 0 ? input.text : null;

  return deps.repos.tx(async (tx) => {
    const review = await tx.attendeeReviews.createCommunityReview({
      placeId: input.placeId,
      humanId,
      anonymousName,
      anonymousEmail,
      overallRating: input.overallRating,
      soundQuality: input.soundQuality ?? null,
      venueComfort: input.venueComfort ?? null,
      organization: input.organization ?? null,
      valueForMoney: input.valueForMoney ?? null,
      text,
    });

    await tx.audit.log({
      entity: "attendee_review",
      entityId: review.id,
      action: "attendee_review.community_submitted",
      // Trail proves a COMMUNITY review landed on this place — no rating values
      // and no text (content stays scoped to the owner surface, FR-006/FR-011).
      data: {
        placeId: input.placeId,
        source: "COMMUNITY",
        signedIn: humanId !== null,
        hasText: text !== null,
      },
      at: now,
    });

    return { reviewId: review.id };
  });
}

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextOptional } from "../../lib/sanitize-plain-text";

// ---------------------------------------------------------------------------
// flagPlaceReviewFeedback (venue-rating-block-and-owner-optin FR-014)
//
// The PLACE-scoped sibling of flag-event-feedback. A COMMUNITY attendee review
// has no event (FR-009), so the EVENT-owner-scoped flag path can't authorize it
// — the venue owner needs a PLACE-scoped way to report a review sitting on THEIR
// venue. Sets the existing `flagged`/`flagReason` moderation columns; platform
// staff then hide or dismiss (via hide-attendee-review).
//
// Auth: Place ownership only (mirrors get-place-attendee-feedback /
// set-place-attendee-reviews-public — direct human owner or a member of an
// owning org). The review MUST already belong to this place: a mismatch is
// rejected as REVIEW_NOT_FOUND so an owner can never flag another venue's
// review (and can't probe whether a foreign review id exists).
// ---------------------------------------------------------------------------

export const flagPlaceReviewFeedbackInputSchema = z
  .object({
    placeId: z.string().uuid(),
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    /** Optional owner note for staff. Sanitized before the length check. */
    reason: plainTextOptional(500).optional(),
  })
  .strict();

export type FlagPlaceReviewFeedbackInput = z.infer<
  typeof flagPlaceReviewFeedbackInputSchema
>;

export const flagPlaceReviewFeedbackOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    flagged: z.literal(true),
  })
  .strict();

export type FlagPlaceReviewFeedbackOutput = z.infer<
  typeof flagPlaceReviewFeedbackOutputSchema
>;

export type FlagPlaceReviewFeedbackDeps = {
  repos: Pick<Repos, "places" | "authz" | "attendeeReviews" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function flagPlaceReviewFeedback(
  deps: FlagPlaceReviewFeedbackDeps,
  rawInput: unknown,
): Promise<FlagPlaceReviewFeedbackOutput> {
  const input = parseInput(flagPlaceReviewFeedbackInputSchema, rawInput);
  const now = deps.clock.now();

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership: direct human owner, or ANY org membership — no role filter.
  // Matches `getPlaceAttendeeFeedback`, and is broader than
  // `setPlaceAttendeeReviewsPublic`, which now requires ORG_ADMIN_ROLES.
  //
  // Unlike that read, this is a WRITE still on plain membership: a SCANNER or
  // VIEWER can flag a review for moderation. That is a DECISION, not a pending
  // follow-up. Flagging REQUESTS moderation rather than publishing a state the
  // venue speaks for, and the person who notices an abusive review is often
  // the one working the door — narrowing this to ORG_ADMIN_ROLES (as
  // `setPlaceAttendeeReviewsPublic` was) would take the report button away
  // from exactly those people.
  //
  // The risk the broad bar buys is a member SPAMMING the moderation queue, and
  // the control for that is throughput, not role: `attendeeReviews
  // .flagPlaceFeedback` carries two rate limits (per actor+review, and per
  // actor+place over an hour) in
  // `packages/transport/trpc/src/routers/attendee-reviews.ts`. Any new
  // transport that reaches this use case owes the same pair.
  const isDirectHumanOwner = place.humanIdsWithAccess.includes(
    input.actorHumanId,
  );

  let isOrgOwner = false;
  if (!isDirectHumanOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectHumanOwner && !isOrgOwner) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  const review = await deps.repos.attendeeReviews.getById(input.reviewId);
  // No cross-place flagging: the review must sit on THIS place. A missing row
  // OR one anchored to a different place is REVIEW_NOT_FOUND — never reveal a
  // foreign review to an owner probing ids.
  if (!review || review.placeId !== input.placeId) {
    throw fail("REVIEW_NOT_FOUND");
  }

  const reason =
    input.reason !== undefined && input.reason.length > 0
      ? input.reason
      : null;

  await deps.repos.attendeeReviews.setFlagged({
    reviewId: input.reviewId,
    flagged: true,
    flagReason: reason,
  });

  await deps.repos.audit.log({
    entity: "attendee_review",
    entityId: input.reviewId,
    action: "attendee_review.flagged",
    // No text/rating in the trail — WHO reported WHEN + on which place, not the
    // content (FR-006/FR-011).
    data: {
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
      source: review.source,
      hasReason: reason !== null,
    },
    at: now,
  });

  return { reviewId: input.reviewId, flagged: true };
}

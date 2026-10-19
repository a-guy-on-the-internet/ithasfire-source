import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

// ---------------------------------------------------------------------------
// hideAttendeeReview (attendee-reviews FR-009 — staff moderation minimum)
//
// Platform-staff hide of an abusive attendee review (typically actioned from a
// flagged row). A hidden review drops out of every aggregate at the next
// recompute (the recompute lists NON-HIDDEN reviews only, and its phase-2 union
// retracts a now-empty subject's public snapshot). Audit-logged; mirrors
// hide-place-review.
// ---------------------------------------------------------------------------

export const hideAttendeeReviewInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const hideAttendeeReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    hidden: z.literal(true),
  })
  .strict();

export type HideAttendeeReviewInput = z.infer<
  typeof hideAttendeeReviewInputSchema
>;
export type HideAttendeeReviewOutput = z.infer<
  typeof hideAttendeeReviewOutputSchema
>;

export type HideAttendeeReviewDeps = {
  repos: Pick<Repos, "attendeeReviews" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function hideAttendeeReview(
  deps: HideAttendeeReviewDeps,
  rawInput: unknown,
): Promise<HideAttendeeReviewOutput> {
  const input = parseInput(hideAttendeeReviewInputSchema, rawInput);
  const now = deps.clock.now();

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
    errorCode: "STAFF_ONLY",
  });

  const review = await deps.repos.attendeeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  if (!review.hidden) {
    await deps.repos.attendeeReviews.setHidden({
      reviewId: input.reviewId,
      hidden: true,
    });
  }

  await deps.repos.audit.log({
    entity: "attendee_review",
    entityId: input.reviewId,
    action: "attendee_review.hidden",
    data: {
      actorHumanId: input.actorHumanId,
      eventId: review.eventId,
    },
    at: now,
  });

  return { reviewId: input.reviewId, hidden: true };
}

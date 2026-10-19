import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

// ---------------------------------------------------------------------------
// resolveAttendeeReviewIdentity (attendee-reviews FR-002 / FR-009)
//
// The ONE place a reviewer's identity is revealed — platform staff only, for
// abuse handling, and ALWAYS audit-logged (FR-002). Organizers never see this;
// their feedback surface is unattributed. Mirrors the place-review staff-read
// identity-resolution pattern: the audit row proves WHICH staffer resolved
// WHICH review WHEN.
// ---------------------------------------------------------------------------

export const resolveAttendeeReviewIdentityInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const resolveAttendeeReviewIdentityOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    // Nullable since FR-009: a COMMUNITY review has no eventId, and a guest
    // COMMUNITY submitter has no humanId (their identity is anonymousEmail).
    humanId: z.string().uuid().nullable(),
    eventId: z.string().uuid().nullable(),
  })
  .strict();

export type ResolveAttendeeReviewIdentityInput = z.infer<
  typeof resolveAttendeeReviewIdentityInputSchema
>;
export type ResolveAttendeeReviewIdentityOutput = z.infer<
  typeof resolveAttendeeReviewIdentityOutputSchema
>;

export type ResolveAttendeeReviewIdentityDeps = {
  repos: Pick<Repos, "attendeeReviews" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function resolveAttendeeReviewIdentity(
  deps: ResolveAttendeeReviewIdentityDeps,
  rawInput: unknown,
): Promise<ResolveAttendeeReviewIdentityOutput> {
  const input = parseInput(resolveAttendeeReviewIdentityInputSchema, rawInput);
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

  // Identity resolution is itself the sensitive action — log it BEFORE
  // returning so the disclosure is always recorded (FR-002).
  await deps.repos.audit.log({
    entity: "attendee_review",
    entityId: input.reviewId,
    action: "attendee_review.identity_resolved",
    data: {
      actorHumanId: input.actorHumanId,
      eventId: review.eventId,
      resolvedHumanId: review.humanId,
    },
    at: now,
  });

  return {
    reviewId: input.reviewId,
    humanId: review.humanId,
    eventId: review.eventId,
  };
}

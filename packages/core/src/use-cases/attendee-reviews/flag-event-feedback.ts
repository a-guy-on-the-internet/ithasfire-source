import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";

// ---------------------------------------------------------------------------
// flagEventFeedback (attendee-reviews FR-007 report action / FR-009)
//
// The per-comment "report abuse" action on the organizer feedback surface:
// flags an attendee review to the platform-staff moderation queue. Owner-scoped
// — only someone with EDIT access to the event that owns the review may report
// it. Sets `flagged`/`flagReason`; staff then hide or dismiss (FR-009). Does
// not reveal reviewer identity to the organizer (FR-002).
// ---------------------------------------------------------------------------

export const flagEventFeedbackInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    /** Optional organizer note for staff. Sanitized before the length check. */
    reason: plainTextOptional(500).optional(),
  })
  .strict();

export type FlagEventFeedbackInput = z.infer<
  typeof flagEventFeedbackInputSchema
>;

export const flagEventFeedbackOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    flagged: z.literal(true),
  })
  .strict();

export type FlagEventFeedbackOutput = z.infer<
  typeof flagEventFeedbackOutputSchema
>;

export type FlagEventFeedbackDeps = {
  repos: Pick<Repos, "events" | "attendeeReviews" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function flagEventFeedback(
  deps: FlagEventFeedbackDeps,
  rawInput: unknown,
): Promise<FlagEventFeedbackOutput> {
  const input = parseInput(flagEventFeedbackInputSchema, rawInput);
  const now = deps.clock.now();

  const review = await deps.repos.attendeeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  // This is the EVENT-owner-scoped flag path. A COMMUNITY review has no event
  // (FR-009); flagging one is the venue owner's PLACE-scoped action (FR-014),
  // out of scope here — reject rather than mis-authorize.
  if (!review.eventId) {
    throw fail("EVENT_NOT_FOUND");
  }

  const event = await deps.repos.events.getById(review.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Authorize the event owner (same gate as listEventFeedback).
  if (event.orgId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "ORGANIZATION",
      ownerId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else if (event.humanId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "HUMAN",
      ownerId: event.humanId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else {
    throw fail("NOT_RESOURCE_OWNER");
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
    // No text/rating in the trail — WHO reported WHEN, not the content (FR-002).
    data: {
      actorHumanId: input.actorHumanId,
      eventId: review.eventId,
      hasReason: reason !== null,
    },
    at: now,
  });

  return { reviewId: input.reviewId, flagged: true };
}

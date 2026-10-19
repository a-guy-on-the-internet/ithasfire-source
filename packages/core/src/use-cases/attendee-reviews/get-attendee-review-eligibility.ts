import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ATTENDEE_REVIEW_WINDOW_MS } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// getAttendeeReviewEligibility (attendee-reviews FR-002 submit side, NFR-002)
//
// Structured eligibility read that drives the my-tickets "Rate this show"
// CTA and the review-form gate. Returns a reason instead of throwing so
// callers can render per-event states without error handling; the submit
// use case re-enforces every check server-side with typed errors — this
// query is a UX convenience, never the enforcement point.
// ─────────────────────────────────────────────────────────────────────────────

export const getAttendeeReviewEligibilityInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export type GetAttendeeReviewEligibilityInput = z.infer<
  typeof getAttendeeReviewEligibilityInputSchema
>;

export const attendeeReviewIneligibilityReasonSchema = z.enum([
  "event_not_found",
  "event_cancelled",
  "event_not_ended",
  "window_closed",
  "no_scanned_ticket",
  "already_reviewed",
]);

export type AttendeeReviewIneligibilityReason = z.infer<
  typeof attendeeReviewIneligibilityReasonSchema
>;

export const getAttendeeReviewEligibilityOutputSchema = z
  .object({
    eligible: z.boolean(),
    /** Why not, when `eligible` is false. Null when eligible. */
    reason: attendeeReviewIneligibilityReasonSchema.nullable(),
    /**
     * When the submission window closes (event end + 30d). Null only when
     * the event couldn't be resolved.
     */
    windowClosesAt: z.date().nullable(),
  })
  .strict();

export type GetAttendeeReviewEligibilityOutput = z.infer<
  typeof getAttendeeReviewEligibilityOutputSchema
>;

export type GetAttendeeReviewEligibilityDeps = {
  repos: Pick<Repos, "events" | "attendeeReviews">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function getAttendeeReviewEligibility(
  deps: GetAttendeeReviewEligibilityDeps,
  rawInput: unknown,
): Promise<GetAttendeeReviewEligibilityOutput> {
  const input = parseInput(getAttendeeReviewEligibilityInputSchema, rawInput);
  const now = deps.clock.now();

  const ineligible = (
    reason: AttendeeReviewIneligibilityReason,
    windowClosesAt: Date | null = null,
  ): GetAttendeeReviewEligibilityOutput => ({
    eligible: false,
    reason,
    windowClosesAt,
  });

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    return ineligible("event_not_found");
  }

  // Event end: endsAt is required at the DB layer but typed nullable on
  // EventRecord — fall back to startsAt (same convention as
  // recompute-public-snapshots).
  const endsAt = event.endsAt ?? event.startsAt;
  const windowClosesAt = new Date(endsAt.getTime() + ATTENDEE_REVIEW_WINDOW_MS);

  if (event.status === "CANCELLED" || event.status === "ARCHIVED") {
    return ineligible("event_cancelled", windowClosesAt);
  }

  if (now.getTime() < endsAt.getTime()) {
    return ineligible("event_not_ended", windowClosesAt);
  }

  if (now.getTime() > windowClosesAt.getTime()) {
    return ineligible("window_closed", windowClosesAt);
  }

  const hasScannedTicket =
    await deps.repos.attendeeReviews.hasScannedTicket({
      eventId: input.eventId,
      humanId: input.actorHumanId,
    });
  if (!hasScannedTicket) {
    return ineligible("no_scanned_ticket", windowClosesAt);
  }

  const existing = await deps.repos.attendeeReviews.findByEventAndHuman({
    eventId: input.eventId,
    humanId: input.actorHumanId,
  });
  if (existing) {
    return ineligible("already_reviewed", windowClosesAt);
  }

  return { eligible: true, reason: null, windowClosesAt };
}

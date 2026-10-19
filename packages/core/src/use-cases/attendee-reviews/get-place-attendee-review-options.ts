import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ATTENDEE_REVIEW_WINDOW_MS } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// getPlaceAttendeeReviewOptions (venue-rating-block-and-owner-optin FR-003)
//
// Drives the ATTENDEE fork of the rate_venue modal: for a SIGNED-IN viewer,
// which events at THIS place are they eligible to leave a VERIFIED review for
// (the upsell above the always-available community floor). Reuses the same
// per-event eligibility rules as get-attendee-review-eligibility, place-scoped:
// the adapter returns candidates (scanned ticket, not already reviewed,
// non-cancelled) and this use case applies the ended + 30-day-window filter.
//
// NEVER throws just because there are none — an empty list is the common case
// and must not block the community floor (FR-003). Returns a UX convenience
// only; submit-attendee-review re-enforces every rule server-side.
// ─────────────────────────────────────────────────────────────────────────────

export const getPlaceAttendeeReviewOptionsInputSchema = z
  .object({
    placeId: z.string().uuid(),
    viewerHumanId: z.string().uuid(),
  })
  .strict();

export type GetPlaceAttendeeReviewOptionsInput = z.infer<
  typeof getPlaceAttendeeReviewOptionsInputSchema
>;

export const getPlaceAttendeeReviewOptionsOutputSchema = z
  .object({
    eligibleEvents: z.array(
      z
        .object({
          eventId: z.string().uuid(),
          title: z.string(),
          /** Event start — for the "which show?" picker label. */
          date: z.date(),
        })
        .strict(),
    ),
  })
  .strict();

export type GetPlaceAttendeeReviewOptionsOutput = z.infer<
  typeof getPlaceAttendeeReviewOptionsOutputSchema
>;

export type GetPlaceAttendeeReviewOptionsDeps = {
  repos: Pick<Repos, "attendeeReviews">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function getPlaceAttendeeReviewOptions(
  deps: GetPlaceAttendeeReviewOptionsDeps,
  rawInput: unknown,
): Promise<GetPlaceAttendeeReviewOptionsOutput> {
  const input = parseInput(getPlaceAttendeeReviewOptionsInputSchema, rawInput);
  const now = deps.clock.now().getTime();

  const candidates =
    await deps.repos.attendeeReviews.listReviewableEventCandidatesForPlace({
      placeId: input.placeId,
      humanId: input.viewerHumanId,
    });

  const eligibleEvents = candidates
    .filter((event) => {
      // endsAt is required at the DB layer but typed nullable — fall back to
      // startsAt (same convention as get-attendee-review-eligibility).
      const endsAt = (event.endsAt ?? event.startsAt).getTime();
      const windowClosesAt = endsAt + ATTENDEE_REVIEW_WINDOW_MS;
      // Only ENDED events still inside the 30-day window are reviewable.
      return now >= endsAt && now <= windowClosesAt;
    })
    .map((event) => ({
      eventId: event.eventId,
      title: event.title,
      date: event.startsAt,
    }));

  return { eligibleEvents };
}

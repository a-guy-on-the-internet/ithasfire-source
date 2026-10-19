import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  ATTENDEE_REVIEW_TEXT_MAX_CHARS,
  ATTENDEE_REVIEW_WINDOW_MS,
} from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// submitAttendeeReview (attendee-reviews FR-001, FR-002 submit side, NFR-002)
//
// Verified scanned-ticket-only post-event review. EVERY eligibility rule is
// enforced here server-side — never trusted from the client:
//   1. event exists and isn't cancelled/archived,
//   2. event has ended,
//   3. within the 30-day submission window,
//   4. the actor owns a SCANNED ticket for the event,
//   5. no existing review (pre-check + unique-index backstop in the adapter).
// Aggregation targets (placeId, ownerType/ownerId, seriesId) are stamped
// from the EVENT ROW at submit time — never from input. Facet scores are
// only ever surfaced publicly through suppressed aggregates (a later loop);
// `text` is PRIVATE to the organizer, unattributed (FR-002).
// ─────────────────────────────────────────────────────────────────────────────

const rating = z.number().int().min(1).max(5);

export const submitAttendeeReviewInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    overallRating: rating,
    soundQuality: rating.optional(),
    venueComfort: rating.optional(),
    organization: rating.optional(),
    valueForMoney: rating.optional(),
    /** PRIVATE organizer-facing comment. Sanitized BEFORE the length check. */
    text: plainTextMultilineOptional(ATTENDEE_REVIEW_TEXT_MAX_CHARS).optional(),
  })
  .strict();

export type SubmitAttendeeReviewInput = z.infer<
  typeof submitAttendeeReviewInputSchema
>;

export const submitAttendeeReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
  })
  .strict();

export type SubmitAttendeeReviewOutput = z.infer<
  typeof submitAttendeeReviewOutputSchema
>;

export type SubmitAttendeeReviewDeps = {
  repos: Pick<
    Repos,
    "tx" | "events" | "attendeeReviews" | "seriesOccurrences" | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function submitAttendeeReview(
  deps: SubmitAttendeeReviewDeps,
  rawInput: unknown,
): Promise<SubmitAttendeeReviewOutput> {
  const input = parseInput(submitAttendeeReviewInputSchema, rawInput);
  const now = deps.clock.now();

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (event.status === "CANCELLED" || event.status === "ARCHIVED") {
    // A cancelled show has nothing to review; ARCHIVED events are off every
    // surface. (EVENT_ALREADY_CANCELLED is the closest canonical code and
    // covers both here — meta carries the actual status.)
    throw fail("EVENT_ALREADY_CANCELLED", {
      meta: { status: event.status },
    });
  }

  const endsAt = event.endsAt ?? event.startsAt;
  if (now.getTime() < endsAt.getTime()) {
    throw fail("ATTENDEE_REVIEW_EVENT_NOT_ENDED", {
      meta: { endsAt: endsAt.toISOString() },
    });
  }

  const windowClosesAt = new Date(endsAt.getTime() + ATTENDEE_REVIEW_WINDOW_MS);
  if (now.getTime() > windowClosesAt.getTime()) {
    throw fail("ATTENDEE_REVIEW_WINDOW_CLOSED", {
      meta: { windowClosedAt: windowClosesAt.toISOString() },
    });
  }

  // Verified attendance (FR-001, NFR-002): a SCANNED ticket owned by the
  // actor — never a client claim.
  const hasScannedTicket = await deps.repos.attendeeReviews.hasScannedTicket({
    eventId: input.eventId,
    humanId: input.actorHumanId,
  });
  if (!hasScannedTicket) {
    throw fail("TICKET_NOT_SCANNED");
  }

  // Friendly pre-check; the (eventId, humanId) unique index is the race
  // backstop (adapter maps P2002 to the same code).
  const existing = await deps.repos.attendeeReviews.findByEventAndHuman({
    eventId: input.eventId,
    humanId: input.actorHumanId,
  });
  if (existing) {
    throw fail("ATTENDEE_REVIEW_ALREADY_SUBMITTED");
  }

  // Denormalized aggregation targets, stamped from the EVENT ROW (FR-001):
  // owner pair is all-or-nothing; orgs win over a direct human owner when
  // both are somehow set (org events are the canonical owned shape).
  const ownerType = event.orgId
    ? "organization"
    : event.humanId
      ? "human"
      : null;
  const ownerId = event.orgId ?? event.humanId ?? null;

  const series = await deps.repos.seriesOccurrences.findSeriesIdByEventId(
    input.eventId,
  );

  // Normalize an all-whitespace comment (sanitized to "") away to NULL.
  const text =
    input.text !== undefined && input.text.length > 0 ? input.text : null;

  return deps.repos.tx(async (tx) => {
    const review = await tx.attendeeReviews.create({
      eventId: input.eventId,
      humanId: input.actorHumanId,
      overallRating: input.overallRating,
      soundQuality: input.soundQuality ?? null,
      venueComfort: input.venueComfort ?? null,
      organization: input.organization ?? null,
      valueForMoney: input.valueForMoney ?? null,
      text,
      placeId: event.placeId ?? null,
      ownerType,
      ownerId,
      seriesId: series?.seriesId ?? null,
    });

    await tx.audit.log({
      entity: "attendee_review",
      entityId: review.id,
      action: "attendee_review.submitted",
      // No rating values and no text in the audit trail — the trail proves
      // WHO submitted WHEN, not what they said (FR-002 keeps content scoped
      // to the organizer surface).
      data: {
        eventId: input.eventId,
        humanId: input.actorHumanId,
        placeId: event.placeId ?? null,
        ownerType,
        ownerId,
        seriesId: series?.seriesId ?? null,
        hasText: text !== null,
      },
      at: now,
    });

    return { reviewId: review.id };
  });
}

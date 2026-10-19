import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { eventRsvpRecordSchema } from "@th/schema";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";

/**
 * FR-004 (community-managed-event-listings spec): a signed-in user says
 * "I'm going" to a PUBLISHED RSVP event. Idempotent per (eventId, humanId) —
 * the repo upsert returns the existing row on re-RSVP. NO public going-count
 * exists anywhere; the only read surfaces are the user's own state
 * (existsForUser) and their own list (list-my-rsvps).
 *
 * Gating:
 *  - missing event                → EVENT_NOT_FOUND
 *  - not PUBLISHED                → EVENT_NOT_PUBLISHED (404 category,
 *    mirroring getPublicEventBody)
 *  - already ended                → EVENT_ALREADY_ENDED (409): a past event
 *    can still be PUBLISHED, but you can't newly RSVP to something that's
 *    over. "Ended" = endsAt if set, else startsAt, vs the clock. Cancelling
 *    an RSVP stays UNGATED — a user must always be able to withdraw.
 *  - attendanceMode !== RSVP      → EVENT_NOT_COMMUNITY (the Step-2 code
 *    registered for RSVP gating: RSVP attendance only exists on COMMUNITY
 *    listings in v1, so "not community" is the truthful description of a
 *    ticketed target)
 *
 * No audit log: RSVPs are high-volume personal state (like saves/follows),
 * not moderated content or money movement. Single idempotent row write —
 * no repos.tx needed.
 *
 * Confirmation: a NEWLY-created RSVP (upsert `created: true`) enqueues one
 * RsvpNotice outbox row; the jobs-service drain
 * (dispatch-rsvp-notifications) later sends the in-app + email confirmation.
 * The enqueue is deliberately a BEST-EFFORT sequential write, NOT part of a
 * transaction — the upsert's P2002-reconcile forbids running inside
 * `repos.tx` (see the adapter docstring) — so an enqueue failure is logged
 * and swallowed: a missed confirmation beats a failed RSVP. An idempotent
 * re-RSVP (`created: false`) never enqueues, so re-pressing the button can't
 * duplicate the confirmation.
 */

export const rsvpToEventInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const rsvpToEventOutputSchema = z
  .object({
    rsvp: eventRsvpRecordSchema,
  })
  .strict();

export type RsvpToEventInput = z.infer<typeof rsvpToEventInputSchema>;
export type RsvpToEventOutput = z.infer<typeof rsvpToEventOutputSchema>;

export type RsvpToEventDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function rsvpToEvent(
  deps: RsvpToEventDeps,
  rawInput: unknown,
): Promise<RsvpToEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "rsvpToEvent" });

  const execute = async (): Promise<RsvpToEventOutput> => {
    const input = parseInput(rsvpToEventInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId, {
      withOwnerStanding: true,
    });
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    // A banned owner's event is hidden (ban-that-sticks): same answer as an
    // unpublished one.
    if (event.status !== "PUBLISHED" || event.ownerBanned === true) {
      throw fail("EVENT_NOT_PUBLISHED", { category: "NOT_FOUND" });
    }
    // Ended = endsAt if the event carries one, else its startsAt. A
    // past-but-still-PUBLISHED event must not accept new RSVPs.
    const endedAt = event.endsAt ?? event.startsAt;
    if (endedAt.getTime() <= deps.clock.now().getTime()) {
      throw fail("EVENT_ALREADY_ENDED");
    }
    if (event.attendanceMode !== "RSVP") {
      throw fail("EVENT_NOT_COMMUNITY");
    }

    const upserted = await deps.repos.eventRsvps.upsert({
      eventId: event.id,
      humanId: input.actorHumanId,
    });

    // Defense-in-depth: the repo contract guarantees a real row (never
    // undefined) even under a concurrent RSVP/cancel race, but if that ever
    // regresses we surface a typed INTERNAL — never a raw Zod issue array.
    if (!upserted?.record) {
      throw fail("INTERNAL");
    }

    // Enqueue the confirmation outbox row ONLY for a fresh RSVP. Best-effort:
    // the user's RSVP already succeeded, so an enqueue failure must never
    // fail the call — log it and move on (missed confirmation < failed RSVP).
    if (upserted.created) {
      try {
        await deps.repos.rsvpNotices.create({
          eventId: event.id,
          humanId: input.actorHumanId,
        });
      } catch (error) {
        scopedLogger?.error("rsvpToEvent.confirmation_enqueue_failed", {
          eventId: event.id,
          humanId: input.actorHumanId,
          error: describeError(error),
        });
      }
    }

    return rsvpToEventOutputSchema.parse({ rsvp: upserted.record });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("rsvpToEvent", execute);
  }

  return execute();
}

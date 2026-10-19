import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { eventDateRsvpRecordSchema } from "@th/schema";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";

/**
 * Per-date RSVP for a recurring community listing (recurring-dates spec,
 * slice 2). A signed-in user says "I'm going" to ONE occurrence
 * (`EventDate`) of an RSVP event. Idempotent per (eventDateId, humanId) — the
 * repo upsert returns the existing row on re-RSVP. Mirrors
 * {@link rsvpToEvent}'s auth/gating, adding the per-date checks.
 *
 * NO public going-count exists anywhere (FR-004): the only read surfaces are
 * the viewer's OWN state (existsForUser / listDateIdsForHuman via
 * `listEventDates`).
 *
 * Gating (in resolution order):
 *  - missing date                 → EVENT_DATE_NOT_FOUND (404)
 *  - missing parent event         → EVENT_NOT_FOUND (delete race; 404)
 *  - event not PUBLISHED / PUBLIC → EVENT_NOT_PUBLISHED (404 category,
 *    mirroring getPublicEventBody — a non-public listing is hidden, not 409)
 *  - attendanceMode !== RSVP      → EVENT_NOT_COMMUNITY
 *  - date not SCHEDULED           → EVENT_DATE_NOT_RSVPABLE (a moderator
 *    called-off date can't take new RSVPs)
 *  - date already started         → EVENT_DATE_IN_PAST
 *
 * No audit log: RSVPs are high-volume personal state (like saves/follows),
 * not moderated content or money movement. Single idempotent row write —
 * no repos.tx needed.
 *
 * Confirmation: a NEWLY-created per-date RSVP (upsert `created: true`)
 * enqueues one RsvpNotice outbox row carrying the DATE id; the jobs-service
 * drain (dispatch-rsvp-notifications) later sends the in-app + email
 * confirmation with the DATE's start/end times. The enqueue is deliberately a
 * BEST-EFFORT sequential write, NOT part of a transaction — the upsert's
 * P2002-reconcile forbids running inside `repos.tx` (see the adapter
 * docstring) — so an enqueue failure is logged and swallowed: a missed
 * confirmation beats a failed RSVP. An idempotent re-RSVP (`created: false`)
 * never enqueues, so re-pressing the button can't duplicate the confirmation.
 */

export const rsvpToEventDateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventDateId: z.uuid(),
  })
  .strict();

export const rsvpToEventDateOutputSchema = z
  .object({
    rsvp: eventDateRsvpRecordSchema,
  })
  .strict();

export type RsvpToEventDateInput = z.infer<typeof rsvpToEventDateInputSchema>;
export type RsvpToEventDateOutput = z.infer<typeof rsvpToEventDateOutputSchema>;

export type RsvpToEventDateDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function rsvpToEventDate(
  deps: RsvpToEventDateDeps,
  rawInput: unknown,
): Promise<RsvpToEventDateOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "rsvpToEventDate" });

  const execute = async (): Promise<RsvpToEventDateOutput> => {
    const input = parseInput(rsvpToEventDateInputSchema, rawInput);

    const date = await deps.repos.eventDates.getById(input.eventDateId);
    if (!date) {
      throw fail("EVENT_DATE_NOT_FOUND");
    }

    const event = await deps.repos.events.getById(date.eventId, {
      withOwnerStanding: true,
    });
    if (!event) {
      // The date FK cascades with the event, so a missing parent is a delete
      // race — surface it as a not-found rather than a 500.
      throw fail("EVENT_NOT_FOUND");
    }
    // A banned owner's event is hidden (ban-that-sticks): same answer as an
    // unpublished one.
    if (
      event.status !== "PUBLISHED" ||
      event.visibility !== "PUBLIC" ||
      event.ownerBanned === true
    ) {
      throw fail("EVENT_NOT_PUBLISHED", { category: "NOT_FOUND" });
    }
    if (event.attendanceMode !== "RSVP") {
      throw fail("EVENT_NOT_COMMUNITY");
    }

    if (date.status !== "SCHEDULED") {
      throw fail("EVENT_DATE_NOT_RSVPABLE");
    }
    if (date.startsAt.getTime() < deps.clock.now().getTime()) {
      throw fail("EVENT_DATE_IN_PAST");
    }

    const upserted = await deps.repos.eventDateRsvps.upsert({
      eventDateId: date.id,
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
          eventDateId: date.id,
          humanId: input.actorHumanId,
        });
      } catch (error) {
        scopedLogger?.error("rsvpToEventDate.confirmation_enqueue_failed", {
          eventId: event.id,
          eventDateId: date.id,
          humanId: input.actorHumanId,
          error: describeError(error),
        });
      }
    }

    return rsvpToEventDateOutputSchema.parse({ rsvp: upserted.record });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("rsvpToEventDate", execute);
  }

  return execute();
}

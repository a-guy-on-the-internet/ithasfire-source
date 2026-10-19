import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  eventAttendanceModeSchema,
  eventStatusSchema,
  eventStewardshipSchema,
} from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import { settleHeldDatesForEvent } from "../booking-holds/settle-held-dates-for-published-event";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";
import {
  applyRecurrenceForEvent,
  recurrenceScheduleSchema,
} from "./_shared/community-recurrence";

/**
 * Update (or set) the recurrence schedule on an EXISTING community listing
 * (recurring-dates spec, slice 3). A verified community moderator (or platform
 * ADMIN) replaces the listing's `recurrenceSchedule`; the use-case re-expands
 * the schedule into `EventDate` rows via {@link applyRecurrenceForEvent} and
 * re-pins `Event.startsAt`/`endsAt` to the first upcoming occurrence so the
 * recurring listing stays a single upcoming card for discovery/sorting/SEO.
 *
 * The `bulkReplaceForEvent` reconciliation preserves RSVP'd dropped dates
 * (CANCELLED, not deleted) so a schedule edit never silently destroys
 * attendees' intent — see the EventDatesRepo port doc.
 *
 * AND IT TELLS THEM. Preserving the RSVP was only ever half the job: for a
 * while this path could call off a dozen nights people were planning to attend
 * and send nobody a word, while the one-night `cancelEventDate` mailed everyone.
 * The bulk path now enqueues the SAME `DATE_CANCELLED` notices through the same
 * outbox, in the same transaction as the status flips — `applyRecurrenceForEvent`
 * owns the fan-out and this use case opts into it with `droppedRsvpDates:
 * "notify"`. A night that drops off with NO RSVPs is hard-deleted and notifies
 * nobody, because there is nobody to notify.
 *
 * Scope notes:
 *  - CLEARING recurrence (reverting to a single-date listing) is DEFERRED:
 *    a schedule is REQUIRED here. There is no unambiguous single date to
 *    revert to (the Event.startsAt is currently the first occurrence, and the
 *    materialised future dates may carry RSVPs), so "clear recurrence" needs
 *    its own product decision + flow.
 *  - Recurrence editing is MODERATOR-ONLY for now. Wiring recurrence changes
 *    into the community edit-SUGGESTION flow (members proposing schedule
 *    changes) is DEFERRED — `recurrenceSchedule` is not a whitelisted
 *    suggestion field.
 */

export const updateCommunityRecurrenceInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /**
     * REQUIRED — the new schedule. Clearing recurrence (→ null) is deferred
     * (see the use-case doc), so this may not be null/omitted.
     */
    recurrenceSchedule: recurrenceScheduleSchema,
  })
  .strict();

export const updateCommunityRecurrenceOutputSchema = z
  .object({
    event: z
      .object({
        id: z.uuid(),
        title: z.string(),
        slug: z.string().nullable(),
        shortId: z.string().nullable(),
        status: eventStatusSchema,
        attendanceMode: eventAttendanceModeSchema,
        stewardship: eventStewardshipSchema,
        startsAt: z.date(),
        endsAt: z.date().nullable(),
        timezone: z.string(),
      })
      .strict(),
    /** Number of SCHEDULED occurrences after reconciliation. */
    scheduledCount: z.number().int().nonnegative(),
    /**
     * Booking-hold notifications this edit owes (FR-018: a PUBLISHED listing
     * gained SCHEDULED dates on a calendar). Always empty while community
     * listings carry no calendar. Server-side only.
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents + routing hint stay
 * server-side. Built from the omitted `.shape` (not `.omit()` on the strict
 * object) so `.parse(liveResult)` STRIPS the two keys instead of refusing the
 * result with `unrecognized_keys` the first time a listing actually owes one.
 */
export const updateCommunityRecurrenceWireOutputSchema = z.object(
  updateCommunityRecurrenceOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type UpdateCommunityRecurrenceInput = z.infer<
  typeof updateCommunityRecurrenceInputSchema
>;
export type UpdateCommunityRecurrenceOutput = z.infer<
  typeof updateCommunityRecurrenceOutputSchema
>;

export type UpdateCommunityRecurrenceDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /**
   * Optional: best-effort incremental search-index update after the edit. The
   * re-pin moves `Event.startsAt` (a discovery sort key), so we refresh the
   * row on success. No-ops when omitted (`reindexAfterMutation` short-circuits
   * without a `search` dep and the nightly full-reindex still reconciles).
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /** Reports a swallowed post-commit reindex failure (ReporterPort convention). */
  reportError?: ReporterPort;
};

export async function updateCommunityRecurrence(
  deps: UpdateCommunityRecurrenceDeps,
  rawInput: unknown,
): Promise<UpdateCommunityRecurrenceOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "updateCommunityRecurrence",
  });

  const execute = async (): Promise<UpdateCommunityRecurrenceOutput> => {
    const input = parseInput(updateCommunityRecurrenceInputSchema, rawInput);

    // Same actor gate as create (FR-005): COMMUNITY_MODERATOR or platform ADMIN.
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    const txResult = await deps.repos.tx(async (tx) => {
      // Lock order: the listing row before any of its nights (see
      // cancel-event-date.ts). The rule edit rewrites nights and then the
      // row; locking the row first keeps it from deadlocking with a call-off.
      await tx.events.lockRows({ ids: [input.eventId], mode: "update" });
      const existing = await tx.events.getById(input.eventId);
      if (!existing) {
        throw fail("EVENT_NOT_FOUND");
      }
      // Recurrence is a COMMUNITY-listing capability. Reject org-owned /
      // personal events with the shared community guard error.
      if (existing.stewardship !== "COMMUNITY") {
        throw fail("EVENT_NOT_COMMUNITY");
      }
      // A listing that is over takes no new rule. The take-down, archive or
      // completion called off every remaining night with ONE notice per
      // person; a new rule would expand fresh SCHEDULED nights onto a
      // listing whose page says it is cancelled, gone or ended. Same codes
      // as `restoreEventDate`.
      if (existing.status === "CANCELLED") {
        throw fail("EVENT_ALREADY_CANCELLED");
      }
      if (existing.status === "ARCHIVED") {
        throw fail("EVENT_ARCHIVED");
      }
      if (existing.status === "COMPLETED") {
        throw fail("EVENT_ALREADY_COMPLETED");
      }

      const now = deps.clock.now();

      // Expand the new schedule → EventDate rows (RSVP'd dropped dates are
      // CANCELLED, not deleted, and everyone holding one is mailed — see
      // `droppedRsvpDates` below). Zero future dates → typed
      // RECURRENCE_HAS_NO_UPCOMING_DATES (bubbles up, rolls back).
      const recurrence = await applyRecurrenceForEvent(tx, {
        eventId: existing.id,
        schedule: input.recurrenceSchedule,
        timezone: existing.timezone,
        // Duration template: the listing's current startsAt/endsAt. endsAt is
        // non-null for community listings; fall back to a zero-duration base
        // if a legacy row lacks it.
        baseStartsAt: existing.startsAt,
        baseEndsAt: existing.endsAt ?? existing.startsAt,
        now,
        // A HUMAN is changing the rule, and the confirm dialog in front of this
        // call promises that a date which drops off is called off and everyone
        // who RSVP'd is emailed. This is where that promise is kept: one
        // `DATE_CANCELLED` notice per live RSVP per dropped night, enqueued in
        // THIS transaction alongside the status flips. Bulk drops owe exactly
        // what `cancelEventDate` owes for one night.
        droppedRsvpDates: "notify",
      });

      // Persist the new schedule JSON AND re-pin startsAt/endsAt to the first
      // upcoming occurrence in a single write (applyRecurrenceForEvent never
      // reads Event.recurrenceSchedule, so ordering is safe).
      const updated = await tx.events.applyCommunityEdit({
        eventId: existing.id,
        fields: {
          startsAt: recurrence.firstStartsAt,
          endsAt: recurrence.firstEndsAt,
        },
        recurrenceSchedule: input.recurrenceSchedule,
      });

      // FR-018: a PUBLISHED listing gaining dates takes them from any holds on
      // its calendar (no-op without a calendar). Inside this tx, so an open
      // challenge refuses the edit with nothing committed.
      const heldDates =
        existing.status === "PUBLISHED"
          ? await settleHeldDatesForEvent(tx, {
              event: updated,
              now,
              actorHumanId: input.actorHumanId,
              // Ownerless listing (EVENT_NOT_COMMUNITY above): the moderator
              // is held to the venue-staff bar.
              owner: { kind: "community" },
            })
          : null;

      await tx.audit.log({
        entity: "event",
        entityId: existing.id,
        action: "community_listing.recurrence_updated",
        data: {
          actorHumanId: input.actorHumanId,
          startsAt: updated.startsAt.toISOString(),
          endsAt: updated.endsAt?.toISOString() ?? null,
          scheduledCount: recurrence.scheduledCount,
          kind: input.recurrenceSchedule.kind,
          // The call-off side of the edit. Server-side only: FR-004 forbids a
          // public going-count and `notifiedCount` is a sum of them, so it
          // lands in the audit row and the log line, never on the wire.
          cancelledCount: recurrence.cancelledDateIds.length,
          notifiedCount: recurrence.notifiedCount,
        },
        at: now,
      });

      await markForSearchReindex(
        tx,
        [{ kind: "event", id: existing.id }],
        now,
      );

      return {
        event: updated,
        scheduledCount: recurrence.scheduledCount,
        heldDates,
        cancelledCount: recurrence.cancelledDateIds.length,
        notifiedCount: recurrence.notifiedCount,
      };
    });
    const { event, scheduledCount, heldDates, cancelledCount, notifiedCount } =
      txResult;

    // Best-effort incremental search-index update AFTER commit (never index a
    // row that rolled back). No-ops when `search` is absent.
    reindexAfterMutation(
      {
        repos: deps.repos,
        search: deps.search,
        clock: deps.clock,
        logger: deps.logger,
        ...(deps.reportError ? { reportError: deps.reportError } : {}),
      },
      "updateCommunityRecurrence",
      { kind: "event", id: event.id },
    );

    scopedLogger?.info("updateCommunityRecurrence.completed", {
      eventId: event.id,
      scheduledCount,
      cancelledCount,
      notifiedCount,
    });

    return updateCommunityRecurrenceOutputSchema.parse({
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        shortId: event.shortId,
        status: event.status,
        attendanceMode: event.attendanceMode,
        stewardship: event.stewardship,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
      },
      scheduledCount,
      ...(heldDates && heldDates.intents.length > 0
        ? {
            notificationIntents: heldDates.intents,
            staffRecipientHint: heldDates.staffRecipientHint,
          }
        : {}),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateCommunityRecurrence", execute);
  }

  return execute();
}

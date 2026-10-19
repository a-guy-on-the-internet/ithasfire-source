import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";
import { repinEventStartsAt } from "./_shared/repin-event-starts-at";

/**
 * Put a called-off night back on.
 *
 * A night called off by mistake — wrong date picked, venue reopened, host
 * recovered — must have a way home, and it does precisely because
 * {@link cancelEventDate} never deletes the row or its per-date RSVPs. The
 * people who said they were coming are still attached to the date, so
 * restoring it restores their RSVPs with it rather than asking a room full of
 * people to press the button again.
 *
 * Same gate as the call-off: COMMUNITY_MODERATOR or platform ADMIN, with the
 * step-up 2FA requirement enforced at the transport.
 *
 * IDEMPOTENT, by the same guarded compare-and-set: restoring an
 * already-SCHEDULED date succeeds and changes nothing.
 *
 * TWO THINGS THE RESTORE OWES, both in the restoring transaction:
 *  1. **Retract the undelivered half of the call-off.** The call-off enqueued
 *     one "that night is off" notice per RSVP; any still sitting undispatched
 *     in the outbox would go out on the next drain tick FOR A NIGHT THAT IS
 *     BACK ON. They are deleted. Already-dispatched ones are left alone —
 *     those were genuinely sent, and the retention purge owns them. (A person
 *     who got the cancellation and is not told about the restore is a real
 *     gap; it is a NOTIFICATION to design, not a reason to let a wrong one
 *     send. Deliberately out of scope here.)
 *  2. **Re-pin `Event.startsAt`.** Restoring a night EARLIER than the current
 *     pin moves the listing's next date back to it, and discovery reads that
 *     pin. A listing drained to `now` by the call-off (nothing else upcoming)
 *     comes back to a real future instant here — which is what puts it back in
 *     front of people.
 *
 * REFUSED. A date whose `startsAt` is already past: restoring a night that has
 * been and gone would put a listing back into discovery for a date nobody can
 * attend, and would make the schedule claim a night happened that did not.
 *
 * REFUSED. A night on a listing that has been taken down: CANCELLED
 * (`EVENT_ALREADY_CANCELLED`) or ARCHIVED (`EVENT_ARCHIVED`). Taking a
 * community listing down calls off every remaining night and gives each
 * person ONE "the listing is cancelled" notice, hung on their earliest night
 * (`callOffRemainingDates`). Restoring that night would delete the person's
 * only notice through step 1 above, for a night on a listing that is still
 * gone. A DRAFT listing is NOT refused: `cancelEventDate` can call off a
 * draft's night, so the draft's night must be able to come back.
 */

export const restoreEventDateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventDateId: z.uuid(),
  })
  .strict();

export const restoreEventDateOutputSchema = z
  .object({
    eventDateId: z.uuid(),
    eventId: z.uuid(),
    status: z.literal("SCHEDULED"),
    /** `false` when the date was already SCHEDULED — succeeded, changed nothing. */
    changed: z.boolean(),
    eventStartsAt: z.date(),
    startsAtRepinned: z.boolean(),
    /**
     * Undelivered "that night is off" notices retracted from the outbox.
     * SERVER-SIDE ONLY (see {@link restoreEventDateWireOutputSchema}): it is a
     * lower bound on the same going-count `cancelEventDate.notifiedCount` is,
     * and FR-004 keeps that off the wire.
     */
    pendingNoticesRetracted: z.number().int().nonnegative(),
  })
  .strict();

/** Wire shape: the retracted-notice count stays server-side. */
export const restoreEventDateWireOutputSchema = z.object(
  restoreEventDateOutputSchema.omit({ pendingNoticesRetracted: true }).shape,
);

export type RestoreEventDateInput = z.infer<typeof restoreEventDateInputSchema>;
export type RestoreEventDateOutput = z.infer<
  typeof restoreEventDateOutputSchema
>;

export type RestoreEventDateDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /** Best-effort incremental search-index update — the re-pin moves a sort key. */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /** ReporterPort convention — threaded into the post-commit reindex's swallows. */
  reportError?: ReporterPort;
};

export async function restoreEventDate(
  deps: RestoreEventDateDeps,
  rawInput: unknown,
): Promise<RestoreEventDateOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "restoreEventDate" });

  const execute = async (): Promise<RestoreEventDateOutput> => {
    const input = parseInput(restoreEventDateInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    const now = deps.clock.now();

    const result = await deps.repos.tx(async (tx) => {
      // Read before the lock below, so `date.status` may be stale; the
      // guarded markStatusIf is what decides.
      const date = await tx.eventDates.getById(input.eventDateId);
      if (!date) {
        throw fail("EVENT_DATE_NOT_FOUND");
      }

      // The listing row locked BEFORE it is read and its status checked.
      // Taking a listing down (cancel / archive / complete) holds this row
      // FOR UPDATE while it calls every remaining night off and hangs each
      // person's ONE notice on their earliest night. Unlocked, a restore that
      // read PUBLISHED just before that commit would CAS the anchor night
      // back to SCHEDULED and delete the notice that speaks for all of them.
      // Locked, it waits for the take-down and then reads the status it left.
      // FOR UPDATE, not FOR SHARE: the re-pin below UPDATEs this row, and two
      // restores each holding FOR SHARE and upgrading would deadlock.
      await tx.events.lockRows({ ids: [date.eventId], mode: "update" });
      const event = await tx.events.getById(date.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (event.stewardship !== "COMMUNITY") {
        throw fail("EVENT_NOT_COMMUNITY");
      }
      if (event.status === "CANCELLED") {
        throw fail("EVENT_ALREADY_CANCELLED");
      }
      if (event.status === "ARCHIVED") {
        throw fail("EVENT_ARCHIVED");
      }
      // Completing a listing calls off its remaining nights with ONE notice
      // per person, anchored on their earliest night: restoring that night
      // would retract the notice that speaks for all of them, and would
      // re-pin a finished listing onto a night nobody can RSVP to.
      if (event.status === "COMPLETED") {
        throw fail("EVENT_ALREADY_COMPLETED");
      }
      if (date.startsAt.getTime() < now.getTime()) {
        throw fail("EVENT_DATE_IN_PAST");
      }

      if (date.status === "SCHEDULED") {
        return {
          eventId: event.id,
          changed: false,
          eventStartsAt: event.startsAt,
          startsAtRepinned: false,
          pendingNoticesRetracted: 0,
        };
      }

      const { updated } = await tx.eventDates.markStatusIf({
        id: date.id,
        expectStatus: "CANCELLED",
        status: "SCHEDULED",
      });
      if (!updated) {
        // A concurrent restore won. It owns the retraction, the re-pin and the
        // audit row; we return the same successful, idempotent answer.
        return {
          eventId: event.id,
          changed: false,
          eventStartsAt: event.startsAt,
          startsAtRepinned: false,
          pendingNoticesRetracted: 0,
        };
      }

      // Never mail "that night is off" for a night that is back on.
      const pendingNoticesRetracted =
        await tx.rsvpNotices.deletePendingDateCancelledForDate(date.id);

      // A restored night may be the listing's next one again.
      const repin = await repinEventStartsAt(tx, { event, now });
      // The listing's document carries the pinned `startsAt`.
      if (repin.moved) {
        await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
      }

      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "community_listing.date_restored",
        data: {
          actorHumanId: input.actorHumanId,
          eventDateId: date.id,
          dateStartsAt: date.startsAt.toISOString(),
          pendingNoticesRetracted,
          startsAtRepinned: repin.moved,
          eventStartsAt: repin.startsAt.toISOString(),
        },
        at: now,
      });

      return {
        eventId: event.id,
        changed: true,
        eventStartsAt: repin.startsAt,
        startsAtRepinned: repin.moved,
        pendingNoticesRetracted,
      };
    });

    if (result.startsAtRepinned) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          ...(deps.reportError ? { reportError: deps.reportError } : {}),
        },
        "restoreEventDate",
        { kind: "event", id: result.eventId },
      );
    }

    scopedLogger?.info("restoreEventDate.completed", {
      eventDateId: input.eventDateId,
      eventId: result.eventId,
      changed: result.changed,
      pendingNoticesRetracted: result.pendingNoticesRetracted,
      startsAtRepinned: result.startsAtRepinned,
    });

    return restoreEventDateOutputSchema.parse({
      eventDateId: input.eventDateId,
      eventId: result.eventId,
      status: "SCHEDULED",
      changed: result.changed,
      eventStartsAt: result.eventStartsAt,
      startsAtRepinned: result.startsAtRepinned,
      pendingNoticesRetracted: result.pendingNoticesRetracted,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("restoreEventDate", execute);
  }

  return execute();
}

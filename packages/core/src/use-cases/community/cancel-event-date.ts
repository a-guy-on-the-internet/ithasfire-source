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
 * Call ONE night of a recurring community listing off.
 *
 * THE GAP THIS FILLS. A weekly open mic skips a week — a holiday, a closed
 * venue, a sick host — and until now nobody could say so. `EventDateStatus`
 * had CANCELLED, but every writer of it meant something else: a whole-event
 * cancel, a ticketed-series cancel, a volunteer shift, or the reconcile pass
 * preserving an RSVP'd date a rule change dropped. A moderator's only levers
 * were cancelling the entire listing or rewriting the rule — which reconciles
 * the WHOLE schedule to kill one night.
 *
 * WHAT IT DOES NOT DO. It never deletes the row, and it never deletes the
 * date's RSVPs. That is not caution, it is the point: the preserved RSVPs are
 * both who gets told the night is off and what makes {@link restoreEventDate}
 * possible. `bulkReplaceForEvent` was already written this way — it preserves
 * a cancelled date AND its `EventDateRsvps` when it has at least one RSVP —
 * and that is the affordance you build when you intend to tell someone.
 *
 * GATE. COMMUNITY_MODERATOR or platform ADMIN, the same actor gate
 * `updateCommunityRecurrence` enforces. The transport adds the step-up 2FA
 * requirement, because this control is meant to sit on the PUBLIC event page,
 * which has no `/moderate` edge gate in front of it.
 *
 * IDEMPOTENT. Cancelling an already-cancelled date is a no-op that succeeds —
 * a moderator double-pressing, or two moderators pressing at once, is not an
 * error condition. The flip is a guarded compare-and-set
 * (`markStatusIf(expectStatus: "SCHEDULED")`), so exactly one caller ever
 * observes the transition and everything the transition owes — the
 * notification fan-out, the re-pin, the audit row — hangs off that one
 * observation, inside one transaction.
 *
 * THREE THINGS HAPPEN IN THE WINNING TRANSACTION:
 *  1. the flip;
 *  2. one `RsvpNotice` per LIVE per-date RSVP, kind `DATE_CANCELLED`. A
 *     transactional outbox, unlike the confirmation enqueue (which cannot be,
 *     because the RSVP upsert is forbidden from running inside `repos.tx`) —
 *     so "everyone who was coming gets told exactly once" is a property of the
 *     transaction, not of a unique index;
 *  3. the `Event.startsAt` re-pin — see {@link repinEventStartsAt} for why a
 *     stale pin means discovery advertising the night that is off.
 *
 * REFUSED. A date whose `startsAt` is already past: there is nobody left to
 * tell and nothing left to call off, and allowing it would let a moderator
 * rewrite history that attendees already lived through.
 */

export const cancelEventDateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventDateId: z.uuid(),
  })
  .strict();

export const cancelEventDateOutputSchema = z
  .object({
    eventDateId: z.uuid(),
    eventId: z.uuid(),
    status: z.literal("CANCELLED"),
    /**
     * `false` when the date was ALREADY cancelled — the call succeeded and
     * changed nothing, and nothing was sent. Lets a caller tell "I called this
     * off" from "someone beat me to it" without turning the second press into
     * an error.
     */
    changed: z.boolean(),
    /**
     * `Event.startsAt` after the re-pin, and whether the re-pin moved it. The
     * pin only moves when the cancelled night WAS the next one.
     */
    eventStartsAt: z.date(),
    startsAtRepinned: z.boolean(),
    /**
     * Whether the listing now has NO upcoming SCHEDULED occurrence. Server-side
     * signal for logs/tests; the PAGE tells the two zero-dates states apart via
     * `listEventDates`' `truncated`, not via this.
     */
    drained: z.boolean(),
    /**
     * How many people were told. SERVER-SIDE ONLY — see
     * {@link cancelEventDateWireOutputSchema}. FR-004 forbids a public
     * going-count, and a cancelled date's live-RSVP count IS a going-count; the
     * fact that a moderator is asking does not change what the number is. It
     * exists here for the audit row, the log line and the tests.
     */
    notifiedCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What the transport puts on the wire: the recipient count stays server-side.
 * Built from the omitted `.shape` rather than `.omit()` on the strict object so
 * `.parse(liveResult)` STRIPS the key instead of refusing the result with
 * `unrecognized_keys`.
 */
export const cancelEventDateWireOutputSchema = z.object(
  cancelEventDateOutputSchema.omit({ notifiedCount: true }).shape,
);

export type CancelEventDateInput = z.infer<typeof cancelEventDateInputSchema>;
export type CancelEventDateOutput = z.infer<typeof cancelEventDateOutputSchema>;

export type CancelEventDateDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /**
   * Best-effort incremental search-index update after the call-off. The re-pin
   * moves `Event.startsAt` (a discovery sort key), so the row is refreshed on
   * success. No-ops when omitted.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /**
   * ReporterPort convention. The ONLY swallow in here is the post-commit
   * re-index (below), which `reindexAfterMutation` owns; this is threaded so
   * that swallow stays visible rather than silent.
   */
  reportError?: ReporterPort;
};

export async function cancelEventDate(
  deps: CancelEventDateDeps,
  rawInput: unknown,
): Promise<CancelEventDateOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelEventDate" });

  const execute = async (): Promise<CancelEventDateOutput> => {
    const input = parseInput(cancelEventDateInputSchema, rawInput);

    // Same actor gate as createListing / updateRecurrence (FR-005).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    const now = deps.clock.now();

    const result = await deps.repos.tx(async (tx) => {
      const date = await tx.eventDates.getById(input.eventDateId);
      if (!date) {
        throw fail("EVENT_DATE_NOT_FOUND");
      }

      // Lock order: the listing row before any of its nights. Every writer of
      // nights locks Event FOR UPDATE first: this call-off, restoreEventDate,
      // the cancel / archive / complete take-downs, updateCommunityRecurrence
      // and refreshRecurringEventDates (createCommunityListing inserts the row
      // in its own tx). This call-off re-pins Event after the flip, so taking
      // the night first would invert that order and deadlock with them.
      await tx.events.lockRows({ ids: [date.eventId], mode: "update" });
      const event = await tx.events.getById(date.eventId);
      if (!event) {
        // The date FK cascades with the event, so a missing parent is a
        // delete race — a 404, not a 500.
        throw fail("EVENT_NOT_FOUND");
      }
      // Call-offs are a COMMUNITY-listing capability, exactly like recurrence.
      // An org-owned or personal event's dates are the organizer's to manage.
      if (event.stewardship !== "COMMUNITY") {
        throw fail("EVENT_NOT_COMMUNITY");
      }
      // A night that already happened cannot be called off after the fact.
      if (date.startsAt.getTime() < now.getTime()) {
        throw fail("EVENT_DATE_IN_PAST");
      }

      // Already off → succeed, change nothing, send nothing. The guarded
      // write below is the real gate; this is the friendly early exit that
      // keeps a second press from re-notifying everyone.
      if (date.status === "CANCELLED") {
        return {
          eventId: event.id,
          changed: false,
          eventStartsAt: event.startsAt,
          startsAtRepinned: false,
          // A listing whose only remaining night is this already-cancelled
          // one is still drained; answer from the data, not from the flip.
          drained:
            (
              await tx.eventDates.listByEvent({
                eventId: event.id,
                from: now,
                statuses: ["SCHEDULED"],
                limit: 1,
              })
            ).length === 0,
          notifiedCount: 0,
        };
      }

      // Guarded compare-and-set. A concurrent moderator (or a retried request)
      // that already flipped this row loses here and gets `updated: false`,
      // which means it must NOT also fan out notifications.
      const { updated } = await tx.eventDates.markStatusIf({
        id: date.id,
        expectStatus: "SCHEDULED",
        status: "CANCELLED",
      });
      if (!updated) {
        // Someone else's transaction won between the read and this write.
        // Their transaction owns the fan-out, the re-pin and the audit row —
        // ours returns the same successful, idempotent answer.
        return {
          eventId: event.id,
          changed: false,
          eventStartsAt: event.startsAt,
          startsAtRepinned: false,
          drained:
            (
              await tx.eventDates.listByEvent({
                eventId: event.id,
                from: now,
                statuses: ["SCHEDULED"],
                limit: 1,
              })
            ).length === 0,
          notifiedCount: 0,
        };
      }

      // Everyone holding a live RSVP on this night. Read AFTER the flip and
      // inside the same transaction, so the recipient set and the transition
      // are one atomic decision. See the port doc for why this read exists and
      // why nothing derived from it may reach the wire.
      const humanIds = await tx.eventDateRsvps.listHumanIdsForDate(date.id);
      const notifiedCount = await tx.rsvpNotices.createDateCancelled({
        eventId: event.id,
        eventDateId: date.id,
        humanIds,
      });

      // Discovery must not keep advertising a night that is off.
      const repin = await repinEventStartsAt(tx, { event, now });
      // The listing's document carries the pinned `startsAt`.
      if (repin.moved) {
        await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
      }

      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "community_listing.date_cancelled",
        data: {
          actorHumanId: input.actorHumanId,
          eventDateId: date.id,
          dateStartsAt: date.startsAt.toISOString(),
          notifiedCount,
          startsAtRepinned: repin.moved,
          eventStartsAt: repin.startsAt.toISOString(),
          drained: repin.drained,
        },
        at: now,
      });

      return {
        eventId: event.id,
        changed: true,
        eventStartsAt: repin.startsAt,
        startsAtRepinned: repin.moved,
        drained: repin.drained,
        notifiedCount,
      };
    });

    // Best-effort incremental search-index update AFTER commit (never index a
    // row that rolled back). Only worth doing when the pin actually moved.
    if (result.startsAtRepinned) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          ...(deps.reportError ? { reportError: deps.reportError } : {}),
        },
        "cancelEventDate",
        { kind: "event", id: result.eventId },
      );
    }

    scopedLogger?.info("cancelEventDate.completed", {
      eventDateId: input.eventDateId,
      eventId: result.eventId,
      changed: result.changed,
      notifiedCount: result.notifiedCount,
      startsAtRepinned: result.startsAtRepinned,
      drained: result.drained,
    });

    return cancelEventDateOutputSchema.parse({
      eventDateId: input.eventDateId,
      eventId: result.eventId,
      status: "CANCELLED",
      changed: result.changed,
      eventStartsAt: result.eventStartsAt,
      startsAtRepinned: result.startsAtRepinned,
      drained: result.drained,
      notifiedCount: result.notifiedCount,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelEventDate", execute);
  }

  return execute();
}

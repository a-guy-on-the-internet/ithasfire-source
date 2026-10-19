import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  heldDatesOwnerOf,
  settleHeldDatesForEvent,
} from "../booking-holds/settle-held-dates-for-published-event";
import {
  applyRecurrenceForEvent,
  recurrenceScheduleSchema,
} from "./_shared/community-recurrence";

/**
 * Rolling-window maintenance for recurring community listings (recurring-dates
 * spec, slice 5a). Backs the scheduled `community.refresh-recurring-dates` job.
 *
 * A recurring listing is ONE `Event` with a `recurrenceSchedule` (RRULE /
 * FIXED_DATES) plus N materialised `EventDate` rows, and `Event.startsAt` is
 * pinned to the first UPCOMING occurrence. Without maintenance, as dates pass:
 *   (a) `Event.startsAt` goes stale/past → the listing DROPS OUT of every
 *       discovery + geo×category SEO query (all filter `startsAt >= now`); and
 *   (b) the far edge of the [now, now + window] RRULE window is never topped up.
 * This use-case re-runs {@link applyRecurrenceForEvent} for each recurring
 * listing, which re-expands the schedule (top-up) and returns the first
 * upcoming occurrence so we can re-pin `Event.startsAt`/`endsAt`.
 *
 * Robustness contract:
 *  - **Per-event transaction + error isolation.** Each event is processed in
 *    its OWN `repos.tx`; a failure on one listing (bad/corrupt stored schedule,
 *    a schedule that now yields zero upcoming dates, a transient DB error) is
 *    caught, counted, logged, and the run continues. One bad listing can NEVER
 *    fail the batch.
 *  - **Exhausted schedules.** A schedule whose occurrences have all elapsed
 *    (no dates in [now, now + window]) surfaces as
 *    `RECURRENCE_HAS_NO_UPCOMING_DATES` from `applyRecurrenceForEvent`. We do
 *    NOT throw — we count it under `skippedNoUpcoming`, leave `Event.startsAt`
 *    at its last value (the listing drops out of discovery naturally, which is
 *    acceptable), and move on.
 *  - **Held dates (booking-holds FR-018).** A PUBLISHED listing on a calendar
 *    takes the dates it gains. An OPEN challenge on one of them refuses that
 *    take (`HOLD_LINE_HAS_OPEN_CHALLENGE`); the re-pin for that event is
 *    skipped THIS run, counted under `skippedOpenChallenge`, and retried by
 *    the next run once the challenge is answered — never a `failed`, so a
 *    long-open challenge cannot wedge the job on the same event every day.
 *  - **Never notifies anyone.** The moderator rule-change path
 *    (`updateCommunityRecurrence`) mails everyone holding an RSVP on a night
 *    its edit drops. This job takes the opposite policy — `droppedRsvpDates:
 *    "refuse"` — so a routine top-up can never become a mass email sent by a
 *    scheduler. A listing that WOULD drop an RSVP'd night is rolled back,
 *    counted under `skippedRsvpDrop`, and reported; nothing is cancelled and
 *    nothing is enqueued.
 *  - **Idempotent.** `bulkReplaceForEvent` is idempotent, and we only re-pin
 *    (write `applyCommunityEdit` + audit) when the computed first-upcoming
 *    instant actually differs from the stored `startsAt`/`endsAt`. Running the
 *    job twice back-to-back is therefore a no-op beyond the (idempotent)
 *    occurrence reconciliation.
 *
 * Scope: only PUBLISHED events carrying a `recurrenceSchedule` are visited
 * (via `events.listRecurringEventIds`). Single-date events and ticketed
 * `EventSeries` are never touched.
 */

export const refreshRecurringEventDatesInputSchema = z
  .object({
    /** Page size for the id-cursor enumeration of recurring listings. */
    limit: z.number().int().min(1).max(500).default(100),
    /**
     * Hard cap on how many events a single run processes. Bounds a run's
     * duration/cost even as the recurring corpus grows; the next scheduled
     * run resumes coverage.
     */
    maxEvents: z.number().int().min(1).max(50_000).default(5_000),
  })
  .strict();

export type RefreshRecurringEventDatesInput = z.infer<
  typeof refreshRecurringEventDatesInputSchema
>;

export interface RefreshRecurringEventDatesSummary {
  /** Events visited (loaded + attempted). */
  processed: number;
  /** Events whose `startsAt`/`endsAt` pin was moved (re-pinned + audited). */
  updated: number;
  /** Events whose schedule yielded zero upcoming dates (left as-is). */
  skippedNoUpcoming: number;
  /**
   * Events whose re-pin was refused by an OPEN hold challenge on a date they
   * would gain (left as-is this run; retried next run).
   */
  skippedOpenChallenge: number;
  /**
   * Events whose re-expansion would have called off dates people had RSVP'd
   * to. Refused and rolled back — see the `droppedRsvpDates: "refuse"` comment
   * at the call site. Expected to be ZERO; any non-zero value is a listing
   * whose stored schedule or timezone no longer agrees with its materialised
   * dates, and each one is reported to the error reporter by name.
   */
  skippedRsvpDrop: number;
  /** Events that errored (per-event isolation — counted, not thrown). */
  failed: number;
}

export type RefreshRecurringEventDatesDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort error reporter (ReporterPort convention). This job has no
   * notify channel, so hold notifications a re-pin owes are reported here
   * rather than dropped silently.
   */
  reportError?: ReporterPort;
};

export async function refreshRecurringEventDates(
  deps: RefreshRecurringEventDatesDeps,
  rawInput: unknown,
): Promise<RefreshRecurringEventDatesSummary> {
  const input = parseInput(refreshRecurringEventDatesInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "refreshRecurringEventDates" });
  const now = deps.clock.now();

  let processed = 0;
  let updated = 0;
  let skippedNoUpcoming = 0;
  let skippedOpenChallenge = 0;
  let skippedRsvpDrop = 0;
  let failed = 0;

  let cursor: string | undefined;

  while (processed < input.maxEvents) {
    const remaining = input.maxEvents - processed;
    const pageLimit = Math.min(input.limit, remaining);

    const { ids, nextCursor } = await deps.repos.events.listRecurringEventIds({
      limit: pageLimit,
      ...(cursor ? { cursor } : {}),
    });

    if (ids.length === 0) break;

    for (const eventId of ids) {
      processed += 1;
      try {
        const outcome = await deps.repos.tx(async (tx) => {
          // Lock order: the listing row before any of its nights (see
          // cancel-event-date.ts), so the top-up never deadlocks with a
          // call-off or restore on the same listing.
          await tx.events.lockRows({ ids: [eventId], mode: "update" });
          const event = await tx.events.getById(eventId);
          // Vanished between enumerate + process, or the schedule was cleared
          // concurrently — nothing to maintain, no-op.
          if (!event || !event.recurrenceSchedule) {
            return "unchanged" as const;
          }

          // Re-validate the stored schedule (write-path persists exactly this
          // shape). A corrupt/legacy row throws here and is isolated below.
          const schedule = recurrenceScheduleSchema.parse(
            event.recurrenceSchedule,
          );

          // Re-expand within [now, now + window] (tops up the far edge via the
          // idempotent bulkReplaceForEvent) and compute the first upcoming
          // occurrence. Throws RECURRENCE_HAS_NO_UPCOMING_DATES when exhausted.
          const recurrence = await applyRecurrenceForEvent(tx, {
            eventId: event.id,
            schedule,
            timezone: event.timezone,
            // Duration template: the listing's current startsAt/endsAt.
            baseStartsAt: event.startsAt,
            baseEndsAt: event.endsAt ?? event.startsAt,
            now,
            // NOBODY IS AT THE KEYBOARD. A rolling top-up that found itself
            // calling off nights people have RSVP'd to would be a cron job
            // mailing attendees at 3am on nobody's decision, so it refuses
            // instead: RECURRENCE_DROP_WOULD_CANCEL_RSVPS rolls this event's
            // transaction back, cancels nothing, sends nothing, and is counted
            // + reported below for a human to look at.
            //
            // In the steady state it cannot fire. The expansion is
            // deterministic in (schedule, timezone), the window only ever moves
            // FORWARD, and the drop filter ignores past and already-CANCELLED
            // rows — so re-expanding from a later `now` yields a superset of
            // the surviving future set. A drop means an input moved underneath
            // the materialised rows (the event's timezone was edited, the
            // stored schedule was rewritten out from under them, a row is
            // corrupt), which is exactly the case that wants a human.
            droppedRsvpDates: "refuse",
          });

          // Only re-pin when the first-upcoming instant actually moved — keeps
          // the job idempotent and avoids audit-log churn on stable runs.
          const startsMoved =
            recurrence.firstStartsAt.getTime() !== event.startsAt.getTime();
          const endsMoved =
            (recurrence.firstEndsAt?.getTime() ?? null) !==
            (event.endsAt?.getTime() ?? null);

          if (!startsMoved && !endsMoved) {
            return "unchanged" as const;
          }

          const repinned = await tx.events.applyCommunityEdit({
            eventId: event.id,
            fields: {
              startsAt: recurrence.firstStartsAt,
              endsAt: recurrence.firstEndsAt,
            },
          });

          // FR-018: a PUBLISHED listing gaining dates takes them from any
          // holds on its calendar. A no-op while community listings carry no
          // calendar; this job has no notify channel, so intents it would owe
          // are logged AND reported (ReporterPort → Sentry) rather than
          // dropped silently. An open challenge throws out of this tx and is
          // counted as a skip below.
          if (repinned.status === "PUBLISHED") {
            const heldDates = await settleHeldDatesForEvent(tx, {
              event: repinned,
              now,
              // Machine-caused: the job runs as the platform, not a human;
              // the owner is unused without an actor.
              actorHumanId: null,
              owner: heldDatesOwnerOf(repinned),
            });
            if (heldDates.intents.length > 0) {
              const context = {
                eventId: event.id,
                intentCount: heldDates.intents.length,
                kinds: heldDates.intents.map((i) => i.kind),
              };
              logger?.error(
                "refresh_recurring_event_dates.hold_intents_unsent",
                context,
              );
              try {
                deps.reportError?.(
                  new Error("refresh_recurring_event_dates.hold_intents_unsent"),
                  {
                    tags: { area: "booking_holds", step: "refresh_recurring_dates" },
                    extra: context,
                  },
                );
              } catch {
                // A throwing reporter must never fail the re-pin.
              }
            }
          }

          await tx.audit.log({
            entity: "event",
            entityId: event.id,
            action: "community_listing.recurrence_refreshed",
            data: {
              startsAt: recurrence.firstStartsAt.toISOString(),
              endsAt: recurrence.firstEndsAt.toISOString(),
              scheduledCount: recurrence.scheduledCount,
            },
            at: now,
          });

          // The listing's search document carries the pinned start: mark it
          // so the (edit-triggered) drain refreshes it instead of the next
          // nightly run — which fires BEFORE this job and would leave the old
          // pin for a whole day.
          if (repinned.status === "PUBLISHED") {
            await markForSearchReindex(
              tx,
              [{ kind: "event", id: event.id }],
              now,
            );
          }

          return "updated" as const;
        });

        if (outcome === "updated") updated += 1;
      } catch (err) {
        // Exhausted schedule (all dates elapsed) → skip, don't fail. Leave
        // Event.startsAt at its last value; the listing drops from discovery
        // naturally.
        if (isAppError(err) && err.code === "RECURRENCE_HAS_NO_UPCOMING_DATES") {
          skippedNoUpcoming += 1;
          logger?.info("refreshRecurringEventDates.exhausted", { eventId });
          continue;
        }
        // An OPEN hold challenge on a date the re-pin would take → skip this
        // run (the tx rolled back, the pin is untouched); the next run picks
        // it up once the challenge is answered or lapses.
        if (isAppError(err) && err.code === "HOLD_LINE_HAS_OPEN_CHALLENGE") {
          skippedOpenChallenge += 1;
          logger?.info("refreshRecurringEventDates.openChallenge", {
            eventId,
            meta: err.meta ?? null,
          });
          continue;
        }
        // The re-expansion would have called off RSVP'd nights. The tx rolled
        // back, so nothing was cancelled and nothing was enqueued; the listing
        // keeps its current dates and pin. Deliberately NOT a `failed` — it is
        // a data-drift signal, not a crash — but it IS reported, because a
        // schedule that no longer agrees with its own materialised dates will
        // sit here every single run until somebody looks.
        if (isAppError(err) && err.code === "RECURRENCE_DROP_WOULD_CANCEL_RSVPS") {
          skippedRsvpDrop += 1;
          const context = { eventId, meta: err.meta ?? null };
          logger?.error("refreshRecurringEventDates.rsvpDropRefused", context);
          try {
            deps.reportError?.(err, {
              tags: {
                area: "community_recurrence",
                step: "refresh_recurring_dates",
              },
              extra: context,
            });
          } catch {
            // A throwing reporter must never turn a skip into a batch failure.
          }
          continue;
        }
        // Any other failure is isolated to this event — count + log + report +
        // continue. Reported because the batch still returns normally, so the
        // run shows as a success, and a listing that fails here for a standing
        // reason (a corrupt stored schedule) fails on every run and drops out
        // of discovery as its pin goes stale. `logger.error` does not reach
        // Sentry from the jobs service.
        failed += 1;
        logger?.error("refreshRecurringEventDates.eventFailed", {
          eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          deps.reportError?.(err, {
            tags: {
              area: "community_recurrence",
              step: "refresh_recurring_dates",
            },
            extra: { eventId },
          });
        } catch {
          // A throwing reporter must never turn one listing's failure into a
          // batch failure.
        }
        continue;
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  logger?.info("refreshRecurringEventDates.completed", {
    processed,
    updated,
    skippedNoUpcoming,
    skippedOpenChallenge,
    skippedRsvpDrop,
    failed,
  });

  return {
    processed,
    updated,
    skippedNoUpcoming,
    skippedOpenChallenge,
    skippedRsvpDrop,
    failed,
  };
}

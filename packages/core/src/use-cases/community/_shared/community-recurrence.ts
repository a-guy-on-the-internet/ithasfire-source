import type { TxRepos } from "@th/ports/repos";
import type { EventSeriesSchedule } from "@th/types";
import {
  RECURRENCE_MAX_OCCURRENCES,
  RECURRENCE_WINDOW_MONTHS,
} from "@th/types";
import { fail } from "@th/errors";
import { DateTime } from "luxon";
import { z } from "zod";

import { expandRecurrenceDates } from "../../events/_shared/expand-recurrence";

/**
 * The materialisation window and the per-pass occurrence cap are defined ONCE,
 * in `@th/types` beside `EventDateRecord`, because the browser-side reconcile
 * preview (`apps/web`, no `@th/core` dependency) has to mirror this write path
 * number for number. Re-exported here so the community use cases keep one
 * import site.
 */
export { RECURRENCE_MAX_OCCURRENCES, RECURRENCE_WINDOW_MONTHS };

const isoDateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid_datetime");

/**
 * Zod contract for a community `recurrenceSchedule`. A trimmed reuse of the
 * ticketed-series schedule shape so the persisted JSON is a valid
 * `EventSeriesSchedule` (ONE schedule format across the codebase):
 *  - RRULE  → `rrule` (required) + `dtstart` (required); no `dates`.
 *  - FIXED_DATES → `dates` (required, ≥1); no `rrule`/`dtstart`/`until`.
 * `windowStart`/`windowEnd`/`maxOccurrencesPerExpand` are intentionally NOT
 * accepted from the client — the use-case pins the window to
 * [now, now + {@link RECURRENCE_WINDOW_MONTHS}] and caps at
 * {@link RECURRENCE_MAX_OCCURRENCES}.
 */
export const recurrenceScheduleSchema = z
  .object({
    kind: z.enum(["RRULE", "FIXED_DATES"]),
    rrule: z.string().trim().min(1).max(500).optional(),
    dtstart: isoDateTimeSchema.optional(),
    until: isoDateTimeSchema.optional(),
    dates: z.array(isoDateTimeSchema).min(1).max(366).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "RRULE") {
      if (!value.rrule) {
        ctx.addIssue({ code: "custom", path: ["rrule"], message: "rrule_required" });
      }
      if (!value.dtstart) {
        ctx.addIssue({
          code: "custom",
          path: ["dtstart"],
          message: "dtstart_required",
        });
      }
      if (value.dates) {
        ctx.addIssue({
          code: "custom",
          path: ["dates"],
          message: "dates_not_allowed",
        });
      }
    } else {
      if (!value.dates || value.dates.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["dates"],
          message: "dates_required",
        });
      }
      for (const forbidden of ["rrule", "dtstart", "until"] as const) {
        if (value[forbidden]) {
          ctx.addIssue({
            code: "custom",
            path: [forbidden],
            message: `${forbidden}_not_allowed`,
          });
        }
      }
    }
  });

export type RecurrenceScheduleInput = z.infer<typeof recurrenceScheduleSchema>;

export interface ApplyRecurrenceResult {
  /** Persisted schedule JSON (a valid `EventSeriesSchedule`). */
  schedule: EventSeriesSchedule;
  /** First upcoming occurrence — the Event's `startsAt` mirrors this. */
  firstStartsAt: Date;
  /** End of the first occurrence (startsAt + base duration). */
  firstEndsAt: Date;
  /** Number of SCHEDULED occurrences after reconciliation. */
  scheduledCount: number;
  /**
   * Future SCHEDULED occurrences THIS call flipped to CANCELLED because the
   * new expansion dropped them and somebody had RSVP'd. Always empty under
   * `droppedRsvpDates: "refuse"` (that mode throws instead).
   */
  cancelledDateIds: string[];
  /**
   * `DATE_CANCELLED` outbox rows enqueued for those occurrences — one per
   * person per night. SERVER-SIDE ONLY: FR-004 forbids a public going-count
   * and this is a sum of going-counts, so it is for the audit row, the log
   * line and the tests. Do not put it on a wire schema.
   */
  notifiedCount: number;
}

/**
 * What to do when re-expanding a schedule would call off nights people have
 * RSVP'd to. REQUIRED and explicit on every call, rather than inferred from
 * who is calling, because the two answers differ by who is at the keyboard and
 * that is not something a shared helper can read off its arguments.
 *
 *  - `"notify"` — cancel them and enqueue one `DATE_CANCELLED` notice per live
 *    RSVP per night, in THIS transaction. For a HUMAN rule change: a moderator
 *    pressed a button whose confirm dialog promises exactly this mail.
 *  - `"refuse"` — throw `RECURRENCE_DROP_WOULD_CANCEL_RSVPS` and roll the
 *    transaction back, cancelling nothing and sending nothing. For MACHINE
 *    callers. A routine rolling top-up must never cancel an RSVP'd night: in
 *    the steady state it cannot (a deterministic rule re-expanded from a later
 *    `now` yields a superset of the surviving future set), so a drop means the
 *    inputs moved underneath the materialised rows — an event timezone edit, a
 *    rewritten stored schedule, a corrupt row. That is a case for a human, not
 *    for a cron job mailing every attendee at 3am.
 *
 * Note the refusal is scoped to RSVP-BEARING drops. A dropped night nobody
 * booked is hard-deleted by the reconciliation and never reaches this
 * decision — there is nobody to tell and nothing to preserve.
 */
export type DroppedRsvpDatePolicy = "notify" | "refuse";

/**
 * Expand a validated recurrence schedule into EventDate rows and reconcile the
 * stored set (`bulkReplaceForEvent`). Returns the first upcoming occurrence so
 * the caller can pin `Event.startsAt`/`endsAt` to it — keeping the recurring
 * listing a single upcoming card for discovery/sorting/SEO. Throws
 * `RECURRENCE_HAS_NO_UPCOMING_DATES` when the schedule yields nothing in the
 * [now, now + window] range.
 *
 * `baseStartsAt`/`baseEndsAt` define the per-occurrence duration (endsAt =
 * startsAt + (baseEndsAt − baseStartsAt)).
 *
 * THE CALL-OFF FAN-OUT LIVES HERE, not in the adapter and not in each use
 * case. The reconciliation is the only step that knows which nights got called
 * off, and a `DATE_CANCELLED` notice is a domain decision, not a persistence
 * detail — so the adapter reports the cancelled ids and this core helper reads
 * the recipients and writes the outbox rows. Putting it here (rather than in
 * `updateCommunityRecurrence`) means the choice cannot be forgotten: every
 * caller of the expansion path must state a {@link DroppedRsvpDatePolicy}, and
 * "I never thought about it" is not one of the options.
 *
 * It is a real transactional outbox, exactly like `cancelEventDate`'s: it runs
 * inside the caller's `tx`, so the notices commit with the status flips or not
 * at all. Exactly-once comes from the adapter's guarded update — only the
 * transaction that observed SCHEDULED -> CANCELLED gets the id back, so a
 * retry, a re-run, or a racing moderator sends nothing a second time.
 */
export async function applyRecurrenceForEvent(
  tx: TxRepos,
  params: {
    eventId: string;
    schedule: RecurrenceScheduleInput;
    timezone: string;
    baseStartsAt: Date;
    baseEndsAt: Date;
    now: Date;
    /** REQUIRED — see {@link DroppedRsvpDatePolicy}. */
    droppedRsvpDates: DroppedRsvpDatePolicy;
  },
): Promise<ApplyRecurrenceResult> {
  const {
    eventId,
    schedule,
    timezone,
    baseStartsAt,
    baseEndsAt,
    now,
    droppedRsvpDates,
  } = params;

  const windowEnd = DateTime.fromJSDate(now)
    .plus({ months: RECURRENCE_WINDOW_MONTHS })
    .toJSDate();
  const durationMs = Math.max(0, baseEndsAt.getTime() - baseStartsAt.getTime());

  const expanded = expandRecurrenceDates(schedule as EventSeriesSchedule, {
    windowStart: now,
    windowEnd,
    max: RECURRENCE_MAX_OCCURRENCES,
    timezone,
    durationMs: durationMs > 0 ? durationMs : null,
  });

  if (expanded.length === 0) {
    throw fail("RECURRENCE_HAS_NO_UPCOMING_DATES");
  }

  const { scheduled: rows, cancelledDateIds } =
    await tx.eventDates.bulkReplaceForEvent({
      eventId,
      now,
      dates: expanded.map((d) => ({ startsAt: d.startsAt, endsAt: d.endsAt })),
    });

  // Nights this expansion called off because someone had RSVP'd. Empty on the
  // overwhelming majority of calls (a create, a steady-state top-up, a re-run).
  let notifiedCount = 0;
  if (cancelledDateIds.length > 0) {
    if (droppedRsvpDates === "refuse") {
      // Roll the whole reconciliation back: the cancels un-happen, no notice
      // is written, and the caller decides what to do about it. Meta carries
      // the ids so the report names the listing's affected nights.
      throw fail("RECURRENCE_DROP_WOULD_CANCEL_RSVPS", {
        meta: { eventId, cancelledDateIds },
      });
    }

    // One read + one bulk insert per cancelled night, bounded by
    // RECURRENCE_MAX_OCCURRENCES. Do NOT assume this loop is short: adding a
    // weekday to a weekly rule doubles the occurrence density, which strands
    // roughly half the existing year past the 60-occurrence cap, so a single
    // edit can legitimately call off ~20 nights. It is still a rare, human,
    // once-per-listing action, and reusing the per-date read `cancelEventDate`
    // already uses keeps ONE fan-out mechanism rather than a second, subtly
    // different one. Batch it here first if the tx ever gets long.
    for (const eventDateId of cancelledDateIds) {
      const humanIds = await tx.eventDateRsvps.listHumanIdsForDate(eventDateId);
      if (humanIds.length === 0) continue;
      notifiedCount += await tx.rsvpNotices.createDateCancelled({
        eventId,
        eventDateId,
        humanIds,
      });
    }
  }

  // Pin the Event to the first UPCOMING occurrence (startsAt >= now), NOT
  // rows[0]. `bulkReplaceForEvent` returns ALL SCHEDULED rows with no future
  // filter, so once past SCHEDULED rows exist (slice 5's rolling job reuses
  // this path), rows[0] could be a PAST date — pinning Event.startsAt to the
  // past would silently drop the listing out of every `startsAt >= now`
  // discovery query. Prefer the returned rows (post-reconciliation truth) and
  // fall back to the expanded dates (already >= windowStart == now).
  const upcoming =
    rows.find((r) => r.startsAt.getTime() >= now.getTime()) ??
    expanded.find((d) => d.startsAt.getTime() >= now.getTime()) ??
    expanded[0]!;
  const firstStartsAt = upcoming.startsAt;
  const firstEndsAt =
    upcoming.endsAt ??
    new Date(firstStartsAt.getTime() + Math.max(durationMs, 0));

  return {
    schedule: schedule as EventSeriesSchedule,
    firstStartsAt,
    firstEndsAt,
    scheduledCount: rows.length,
    cancelledDateIds,
    notifiedCount,
  };
}

import { DateTime } from "luxon";

/**
 * The payout schedule for an agreement. Maps to the Prisma enum.
 */
export type PayoutSchedule =
  | "ASAP"
  | "WEEK_OF_EVENT"
  | "ONE_WEEK_AFTER"
  | "TWO_WEEKS_AFTER"
  | "FOUR_WEEKS_AFTER";

/**
 * Timezone for all payout calculations: Central Standard Time.
 *
 * Exported so the business-day / availability-floor helpers in this folder
 * anchor to the same zone rather than re-declaring it.
 */
export const PAYOUT_TZ = "America/Chicago";

/**
 * The WEEK_OF_EVENT roll-forward threshold, in whole calendar days between the
 * event end and the Sunday of the event's week.
 *
 * The comparison is STRICTLY LESS THAN: a Sunday that is fewer than 2 days
 * after the event rolls to the following Sunday. Concretely —
 *
 *   Mon (6 days) … Thu (3) … FRI (2)  -> same-week Sunday, no roll
 *   SAT (1), SUN (0)                  -> FOLLOWING Sunday
 *
 * So Saturday and Sunday events roll; Friday events do not. This subsumes the
 * old "event is itself on a Sunday" special case — a Sunday event is 0 days
 * from its own Sunday, so it rolls for the same reason a Saturday event does.
 *
 * Friday is the deliberate boundary, not an oversight. Its same-week Sunday is
 * still inside Stripe's availability window, but the availability floor
 * (`settlement-availability.ts`) moves that maturity to the Tuesday — a
 * two-day cost instead of the seven days a roll would charge the organiser.
 *
 * (The organiser-facing copy phrases this as "within 2 days", which reads
 * inclusive and would roll Friday too. The copy is the one that needs to
 * change; this constant is the ruled behaviour. Do not "fix" it here.)
 */
const WEEK_OF_EVENT_MIN_LEAD_DAYS = 2;

/**
 * Computes the scheduled payout date for a settlement based on the event end time
 * and the agreement's payout schedule.
 *
 * All payouts are scheduled for midnight CST on the computed date.
 *
 * Schedule rules:
 * - ASAP: The day after the event ends, at midnight CST
 * - WEEK_OF_EVENT: The Sunday of the week the event occurs, or the NEXT Sunday
 *   when that Sunday is STRICTLY fewer than 2 calendar days after the event
 *   ends — i.e. Saturday and Sunday events roll, Friday events do not
 * - ONE_WEEK_AFTER: The Sunday following the event week
 * - TWO_WEEKS_AFTER: Two Sundays after the event week
 * - FOUR_WEEKS_AFTER: Four Sundays after the event week (~1 month)
 *
 * NOTE: this is the SCHEDULE only. Callers that mint ledger credits must clamp
 * the result with `applyAvailabilityFloor` so a payout is never scheduled
 * before the money can be available in the platform's Stripe balance.
 *
 * @param eventEndsAt - The event's end date/time
 * @param schedule - The payout schedule from the agreement
 * @returns The scheduled payout date at midnight CST
 */
export function computePayoutDate(
  eventEndsAt: Date,
  schedule: PayoutSchedule,
): Date {
  // Convert to Luxon DateTime in CST
  const eventEnd = DateTime.fromJSDate(eventEndsAt, { zone: PAYOUT_TZ });

  let payoutDate: DateTime;

  switch (schedule) {
    case "ASAP": {
      // Next day at midnight CST
      payoutDate = eventEnd.plus({ days: 1 }).startOf("day");
      break;
    }

    case "WEEK_OF_EVENT": {
      // Sunday of the week the event occurs. In Luxon weekday 1 = Monday and
      // 7 = Sunday, so the Sunday of the event's week is (7 - weekday) days
      // out: Monday → 6, Friday → 2, Saturday → 1, Sunday → 0.
      const daysToSunday = 7 - eventEnd.weekday;
      // Strictly fewer than 2 days is too close to be a meaningful settlement
      // window → roll to the following Sunday. That is Saturday (1 day) and
      // Sunday (0 days) only; Friday is exactly 2 and keeps its own Sunday.
      const rollForward = daysToSunday < WEEK_OF_EVENT_MIN_LEAD_DAYS;
      payoutDate = eventEnd
        .plus({ days: daysToSunday + (rollForward ? 7 : 0) })
        .startOf("day");
      break;
    }

    case "ONE_WEEK_AFTER": {
      // Sunday of the week after the event
      const eventDayOfWeek = eventEnd.weekday;
      const daysToSunday = 7 - eventDayOfWeek;
      // Go to the Sunday of this week, then add 1 week
      payoutDate = eventEnd
        .plus({ days: daysToSunday })
        .plus({ weeks: 1 })
        .startOf("day");
      break;
    }

    case "TWO_WEEKS_AFTER": {
      // Sunday two weeks after the event week
      const eventDayOfWeek = eventEnd.weekday;
      const daysToSunday = 7 - eventDayOfWeek;
      payoutDate = eventEnd
        .plus({ days: daysToSunday })
        .plus({ weeks: 2 })
        .startOf("day");
      break;
    }

    case "FOUR_WEEKS_AFTER": {
      // Sunday four weeks after the event week (~1 month)
      const eventDayOfWeek = eventEnd.weekday;
      const daysToSunday = 7 - eventDayOfWeek;
      payoutDate = eventEnd
        .plus({ days: daysToSunday })
        .plus({ weeks: 4 })
        .startOf("day");
      break;
    }

    default: {
      const _exhaustive: never = schedule;
      throw new Error(`Unknown payout schedule: ${_exhaustive}`);
    }
  }

  return payoutDate.toJSDate();
}

/**
 * Returns the "effective Sunday" for a given date. Used for settlement bucketing.
 * If the date is a Sunday, returns that date. Otherwise, returns the next Sunday.
 *
 * This is useful for grouping multiple events' settlements into weekly batches.
 */
export function getEffectiveSunday(date: Date): Date {
  const dt = DateTime.fromJSDate(date, { zone: PAYOUT_TZ });
  const dayOfWeek = dt.weekday; // 1 = Monday, 7 = Sunday

  if (dayOfWeek === 7) {
    return dt.startOf("day").toJSDate();
  }

  return dt
    .plus({ days: 7 - dayOfWeek })
    .startOf("day")
    .toJSDate();
}

/**
 * Returns true if the given payout date is due (i.e., the date has passed).
 * Used by the payout processor job to determine which settlements to process.
 *
 * @param scheduledPayoutDate - The scheduled payout date
 * @param now - The current time (defaults to now)
 */
export function isPayoutDue(
  scheduledPayoutDate: Date,
  now: Date = new Date(),
): boolean {
  return scheduledPayoutDate <= now;
}

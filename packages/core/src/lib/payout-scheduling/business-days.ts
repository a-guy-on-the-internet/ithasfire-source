import { DateTime } from "luxon";

import { PAYOUT_TZ } from "./compute-payout-date";

/**
 * Business-day arithmetic for payout scheduling, in the payout timezone
 * (`America/Chicago`).
 *
 * "Business day" here means Monday–Friday, matching how Stripe describes its
 * balance availability window ("funds are available N business days after the
 * charge"). A charge on a Saturday or Sunday has the FOLLOWING Monday as
 * day 0, so a Saturday charge is available on the Wednesday.
 *
 * DELIBERATELY NOT MODELLED: US federal banking holidays. We have no holiday
 * calendar in this repo, and a hand-maintained one that drifts would be worse
 * than a known, bounded gap. A holiday inside the window can therefore push
 * REAL availability up to one banking day beyond what these helpers estimate.
 *
 * DO NOT read that gap as harmless because the batch retries. The
 * `balance_insufficient` handling in `run-batch` is a per-currency CIRCUIT
 * BREAKER, not a per-item retry: the first shortfall in a currency arms it and
 * every remaining item in that currency is failed for the night without being
 * attempted. A re-attempt inside Stripe's ~24h idempotency window also replays
 * the cached rejection, since Stripe caches error responses too. So the blast
 * radius of ONE premature credit is a whole night's payouts in that currency.
 * The retry path is a backstop against a surprise, not a licence to be
 * approximate here.
 */

/** Luxon weekday numbers: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday. */
const LAST_WEEKDAY = 5;

/**
 * Upper bound on `addBusinessDays`' count. The implementation walks one
 * calendar day per iteration, so an unbounded caller (this is exported from
 * the package barrel) could spin for hours on a fat-fingered `1e9`. Ten years
 * of business days is far past any payout schedule this repo has.
 */
const MAX_BUSINESS_DAYS = 2600;

/**
 * True when the given instant falls on a Monday–Friday in `America/Chicago`.
 *
 * Throws on an Invalid Date rather than reporting `false`, so it fails the
 * same way `addBusinessDays` does on the same input — a silent `false` would
 * read as "it's the weekend" and be acted on.
 */
export function isBusinessDay(date: Date): boolean {
  const dt = DateTime.fromJSDate(date, { zone: PAYOUT_TZ });
  if (!dt.isValid) {
    throw new Error(
      `isBusinessDay: invalid date (${dt.invalidReason ?? String(date)})`,
    );
  }
  return dt.weekday <= LAST_WEEKDAY;
}

/**
 * Adds `businessDays` Monday–Friday days to `from`, returning midnight
 * `America/Chicago` on the resulting day.
 *
 * Day 0 is `from`'s own day when that is a weekday, and the next Monday when
 * `from` lands on a weekend — i.e. a weekend charge does not start counting
 * until the banking week reopens. `addBusinessDays(saturday, 0)` therefore
 * returns the following Monday, not the Saturday.
 *
 * All arithmetic goes through Luxon's zone-aware `plus({ days })` +
 * `startOf("day")` rather than epoch-millisecond math, so the two annual
 * `America/Chicago` DST transitions (23h and 25h "days") land on the right
 * calendar date.
 *
 * @param from - The reference instant (for the settlement floor: the charge).
 * @param businessDays - A whole number of business days, 0..MAX_BUSINESS_DAYS.
 * @returns Midnight `America/Chicago` on the resulting business day.
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new Error(
      `addBusinessDays: businessDays must be a non-negative integer, got ${businessDays}`,
    );
  }
  if (businessDays > MAX_BUSINESS_DAYS) {
    throw new Error(
      `addBusinessDays: businessDays must be <= ${MAX_BUSINESS_DAYS}, got ${businessDays}`,
    );
  }

  let cursor = DateTime.fromJSDate(from, { zone: PAYOUT_TZ }).startOf("day");
  // An Invalid Date makes every `weekday` NaN, and NaN fails BOTH loop
  // conditions below — the weekday-count loop would then never decrement and
  // spin forever. Fail loudly instead. (Caught the hard way: a test fixture
  // with an unpadded day, `new Date("2026-03-9T…")`, hung the runner.)
  if (!cursor.isValid) {
    throw new Error(
      `addBusinessDays: invalid date (${cursor.invalidReason ?? String(from)})`,
    );
  }

  // Weekend charges: roll to the next Monday, which becomes day 0.
  while (cursor.weekday > LAST_WEEKDAY) {
    cursor = cursor.plus({ days: 1 }).startOf("day");
  }

  let remaining = businessDays;
  while (remaining > 0) {
    cursor = cursor.plus({ days: 1 }).startOf("day");
    if (cursor.weekday <= LAST_WEEKDAY) remaining -= 1;
  }

  return cursor.toJSDate();
}

/**
 * Canonical "how many hours does this volunteer signup count for" rule.
 *
 * This lives in `@th/types` — the LOWEST layer — deliberately, for the same
 * reason `money.ts` does: `@th/adapters` depends on `@th/types` but NOT on
 * `@th/core` (it is a devDependency there), so this is the only module the
 * Prisma repo and the use cases can both reach. `@th/core/lib/volunteer-hours`
 * re-exports it so core callers have a conventional import path.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 *   credited hours = the `hoursWorked` admin override when set,
 *                    else the SHIFT's scheduled duration (endsAt − startsAt),
 *                    else null.
 *
 * Stated canonically at `packages/core/src/use-cases/volunteering/
 * org-volunteer-hours.ts`: "`hoursWorked` override when set, else the shift's
 * scheduled duration, all statuses included — so the org totals always
 * reconcile against the sum of per-event CSVs."
 *
 * NULL IS NOT ZERO. A null result means "no hours are known for this row"
 * (no override and nothing to derive from), which is why `SUM` skips it in
 * the aggregate. A UI that renders null as 0 is stating that a volunteer
 * worked no hours — the bug this helper was extracted to stop: a CHECKED_IN
 * 4-hour shift with a null override rendered as "0 HOURS THIS YEAR" on
 * /my-volunteering while the organizer's export said 4.
 *
 * ── Rounding ──────────────────────────────────────────────────────────────
 *
 * 2dp, applied PER ROW before any summation. That ordering is load-bearing:
 * rounding before SUM is what keeps an org total equal to the sum of the
 * per-event export rows. Do not "improve" it by summing raw durations.
 *
 * ── Other implementations that must move together ─────────────────────────
 *
 * The aggregate path (`aggregateHoursByVolunteer`) expresses the identical
 * rule in raw SQL, because Prisma `groupBy` cannot express the COALESCE.
 * It cannot call this function. If you change the rule here, change the
 * `COALESCE(vs."hoursWorked", ROUND(EXTRACT(EPOCH …)/3600, 2))` in
 * `packages/adapters/src/db/prisma/volunteering.ts` in the same commit.
 */

const MS_PER_HOUR = 3_600_000;

/** 2dp, the rounding every hours surface applies per row. */
const round2 = (hours: number): number => Number(hours.toFixed(2));

/**
 * A shift's scheduled duration in hours, rounded to 2dp. Null when either
 * bound is missing — a shiftless signup has no schedule to derive from.
 */
export function scheduledHoursBetween(
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
): number | null {
  if (!startsAt || !endsAt) return null;
  return round2((endsAt.getTime() - startsAt.getTime()) / MS_PER_HOUR);
}

/**
 * Hours to credit a signup: the admin override when set, else the scheduled
 * duration of the window passed in, else null.
 *
 * CALLER CONTRACT — the window you pass MUST be a SHIFT window. On an
 * ask-path signup the only window available is the ASK's, which can legally
 * span months (a standing "help out this season" ask); deriving hours from
 * that would credit a volunteer with thousands of hours. Ask-path callers
 * must pass the override alone and accept null. See `mapCommitment` in the
 * volunteering Prisma repo for the enforced carve-out.
 */
export function creditedHours(
  overrideHours: number | null | undefined,
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
): number | null {
  // `?? ` not `||` — a legitimate 0-hour override must win over the
  // scheduled duration, not fall through to it.
  return overrideHours ?? scheduledHoursBetween(startsAt, endsAt);
}

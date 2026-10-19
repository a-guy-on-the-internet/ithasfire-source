import { DateTime } from "luxon";

/**
 * Zone assumed when a scheduled job declares no `timezone`.
 *
 * `Etc/UTC` is chosen deliberately (not "the server's local zone"): it is
 * already what `jobScheduleInfo` reports as the schedule's `timezone`, and it
 * is what Cloud Scheduler assumes for a job whose manifest entry omits one. A
 * server-local fallback is exactly the bug this module exists to fix — the
 * answer must depend on the SCHEDULE, never on which machine rendered it.
 */
export const DEFAULT_CRON_TZ = "Etc/UTC";

/**
 * Render a zone for humans. `Etc/UTC` reads better as plain "UTC"; every other
 * IANA id is shown verbatim (`America/Chicago`).
 *
 * Deliberately NOT an abbreviation (CST/CDT): an abbreviation flips twice a
 * year, which would silently rewrite a piece of static schedule metadata and
 * make the staff console look like the schedule changed when it did not.
 */
function zoneLabel(timezone: string): string {
  return timezone === "Etc/UTC" || timezone === "UTC" ? "UTC" : timezone;
}

/**
 * The three cron shapes this module understands. Everything else is refused
 * by BOTH `describeCron` (raw string) and `nextCronRun` (`null`) — the two
 * share this parser precisely so they can never disagree about what is
 * supported.
 */
type SupportedCron =
  | { kind: "every-n-minutes"; interval: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "hourly"; minute: number };

/** A plain, non-negative integer field — no list, range, step, name or `?`. */
const PLAIN_INT = /^\d{1,2}$/;
/** `*\/N` — the ONLY step form accepted, and only on the minute field. */
const MINUTE_STEP = /^\*\/(\d{1,2})$/;

/**
 * Classify a cron expression as one of the three exact supported shapes, or
 * `null`.
 *
 * Deliberately strict. The manifest validator accepts full cron syntax
 * (lists, ranges, steps on any field, month restrictions), and Cloud
 * Scheduler will run those — but this module cannot project them, and a
 * parser built on `startsWith("*\/")` + `parseInt` produced a confident WRONG
 * instant rather than admitting that: `0 0 * 1 *` (January only) projected
 * "tomorrow" in September, `0 0,12 * * *` projected midnight only,
 * `0 8-18 * * *` projected 08:00 only, `*\/15 9-17 * * *` projected every
 * 15 minutes all day. So: month, day-of-month and day-of-week must each be a
 * bare `*`; minute is a plain 0–59 or `*\/N` with N a divisor of 60; hour is
 * a plain 0–23 or a bare `*`. Anything else — `,` `-` `/` elsewhere, `MON`,
 * `JAN`, `?`, `L`, `#`, an out-of-range value — is refused.
 *
 * N must DIVIDE 60. Cron restarts the step at :00 of every hour, so `*\/7`
 * fires at :00 :07 … :56 and then :00 again — not :03. The projection below
 * is "next multiple of N, carried into the next hour", which is only the same
 * thing when 60 is a multiple of N; for `*\/7` from :56 it said 19:03 where
 * cron fires 19:00, and for `*\/45` from :46 it said 19:30 against 19:00.
 * Refusing non-divisors keeps every projected instant one cron would fire.
 *
 * `*\/60` is refused too. Cloud Scheduler treats it as "every hour at :00",
 * but it is a spelling of `0 * * * *`, and admitting N ≥ 60 would mean
 * deciding what `*\/90` means; a manifest author who wants hourly writes
 * `0 * * * *`. Refusing keeps the rule "N is a minute count" honest.
 */
function parseSupportedCron(cron: string): SupportedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Any restriction on month, day-of-month or day-of-week is a shape this
  // module has never understood — including the weekly `0 7 * * 1` that once
  // took the daily branch and reported TOMORROW for a job that runs MONDAY.
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;

  const stepMatch = MINUTE_STEP.exec(min);
  if (stepMatch) {
    if (hour !== "*") return null;
    const interval = Number(stepMatch[1]);
    if (interval < 1 || interval > 59) return null;
    // See the docblock: the step restarts at :00 each hour, so only a divisor
    // of 60 has "next multiple of N" as its next firing.
    if (60 % interval !== 0) return null;
    return { kind: "every-n-minutes", interval };
  }

  if (!PLAIN_INT.test(min)) return null;
  const minute = Number(min);
  if (minute > 59) return null;

  if (hour === "*") return { kind: "hourly", minute };

  if (!PLAIN_INT.test(hour)) return null;
  const h = Number(hour);
  if (h > 23) return null;
  return { kind: "daily", hour: h, minute };
}

/**
 * Human-readable label for a cron expression.
 *
 * Describes exactly the three shapes `nextCronRun` can project (see
 * `parseSupportedCron`) and falls through to the raw cron string for anything
 * else, so the staff console never shows a friendly description next to an
 * em-dash next-run — or, worse, a friendly description that is wrong
 * (`0 0,12 * * *` used to render "Daily at 0,12:00").
 *
 * When `timezone` is supplied it is appended to the descriptions that name a
 * WALL-CLOCK time of day — the only ones whose meaning depends on a zone.
 * "Every 15 minutes" and "At minute 30 of every hour" are zone-independent, so
 * tacking a zone onto them would be noise, not clarity.
 */
export function describeCron(cron: string, timezone?: string): string {
  const parsed = parseSupportedCron(cron);
  if (!parsed) return cron;
  switch (parsed.kind) {
    case "every-n-minutes":
      return `Every ${parsed.interval} minutes`;
    case "hourly":
      return `At minute ${parsed.minute} of every hour`;
    case "daily": {
      const at = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
      return timezone
        ? `Daily at ${at} ${zoneLabel(timezone)}`
        : `Daily at ${at}`;
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Compute the next occurrence of a cron expression, in the schedule's own
 * timezone, as an ISO-8601 instant (`…Z`).
 *
 * Exactly three shapes are supported (`parseSupportedCron` is the single
 * source of truth, shared with `describeCron`):
 *
 *   - `*\/N * * * *` — every N minutes, N a divisor of 60 (1 ≤ N ≤ 59)
 *   - `M H * * *`    — daily at H:M in `timezone`, 0 ≤ M ≤ 59, 0 ≤ H ≤ 23
 *   - `M * * * *`    — hourly at minute M, 0 ≤ M ≤ 59
 *
 * Everything else returns `null`: any month / day-of-month / day-of-week
 * restriction, any list (`0,12`), range (`8-18`), step outside the leading
 * `*\/N` on the minute field, a step that does not divide 60, name (`MON`,
 * `JAN`), `?`, `L`, `#`, an out-of-range value, a malformed expression, an
 * unknown zone id, or an invalid `now`. `/platform/jobs` renders `null` as an
 * em dash and the settlements batch clock renders it as an "unprojectable"
 * warning beside the raw cron, so an unsupported shape reads "unknown" rather
 * than stating something false. Widening support is a feature; refusing to
 * lie is part of correctness.
 *
 * The zone is the point. Cloud Scheduler fires `0 0 * * *` /
 * `America/Chicago` at midnight CENTRAL, which is 05:00Z in summer and 06:00Z
 * in winter. The previous implementation did `new Date().setHours(...)`, i.e.
 * it computed in the SERVER's local zone — UTC on Cloud Run — and reported the
 * settlement batch five hours early. luxon does the zone arithmetic so DST is
 * handled by the tz database rather than by a hardcoded offset that would be
 * right for half the year.
 *
 * DST fall-back (a wall-clock time that occurs twice in one day): the daily
 * branch resolves to the FIRST occurrence and, once past it, rolls to the next
 * day — the second occurrence is not projected. This is the current
 * behaviour, pinned in the tests; whether Cloud Scheduler fires the repeated
 * hour once or twice has not been verified against it.
 *
 * No try/catch: luxon returns an invalid DateTime rather than throwing (nothing
 * in this repo flips `Settings.throwOnInvalid`), and every other step is
 * string/integer work on a `string` argument — there is no reachable throw to
 * convert into `null`.
 *
 * @param now Injectable clock. Tests MUST pass it: luxon's implicit "now" is
 *   clock-dependent, so a test that omits it passes or fails with the wall
 *   clock and the machine's TZ.
 */
export function nextCronRun(
  cron: string,
  timezone?: string,
  now: Date = new Date(),
): string | null {
  const parsed = parseSupportedCron(cron);
  if (!parsed) return null;

  const zone = timezone ?? DEFAULT_CRON_TZ;
  const nowZ = DateTime.fromJSDate(now, { zone });
  // Unknown/garbage zone id (or an invalid `now`) — no honest answer to give.
  if (!nowZ.isValid) return null;

  switch (parsed.kind) {
    case "every-n-minutes": {
      const { interval } = parsed;
      const currentMin = nowZ.minute;
      // Next multiple of N strictly after the current minute. Because N
      // divides 60 (enforced by the parser), `nextMin` is at most 60, so the
      // only carry is into :00 of the next hour — which is exactly where cron
      // restarts the step. `nextMin > currentMin` always, so the result is
      // strictly in the future; no "bump if not past" check is needed.
      const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
      const next = nowZ
        .set({ second: 0, millisecond: 0 })
        .plus({ minutes: nextMin - currentMin });
      return toInstant(next);
    }
    case "daily": {
      let next = nowZ.set({
        hour: parsed.hour,
        minute: parsed.minute,
        second: 0,
        millisecond: 0,
      });
      // Defensive: hour/minute are range-checked upstream so `set` should
      // never yield an invalid DateTime, but an invalid value must degrade
      // to the documented `null`, never to a bogus instant.
      if (!next.isValid) return null;
      // `plus({ days: 1 })` is CALENDAR-aware in luxon, so across a DST
      // boundary the next run keeps the same wall-clock time (and changes
      // UTC offset) — which is what Cloud Scheduler does.
      if (next <= nowZ) next = next.plus({ days: 1 });
      return toInstant(next);
    }
    case "hourly": {
      let next = nowZ.set({
        minute: parsed.minute,
        second: 0,
        millisecond: 0,
      });
      if (!next.isValid) return null;
      if (next <= nowZ) next = next.plus({ hours: 1 });
      return toInstant(next);
    }
  }
}

/**
 * Serialize as a UTC instant, matching the old `Date#toISOString()` output
 * shape exactly (`2026-09-15T05:00:00.000Z`). `/platform/jobs` renders it
 * with `toLocaleString()`; the settlements batch clock feeds it to the
 * `<DateTime>` component. Both parse an ISO instant, so the shape is the
 * contract.
 */
function toInstant(dt: DateTime): string | null {
  return dt.toUTC().toISO({ suppressMilliseconds: false });
}

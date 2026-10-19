import { describe, expect, it } from "vitest";

import manifestJson from "../../jobs.manifest.json";
import {
  DEFAULT_CRON_TZ,
  describeCron,
  nextCronRun,
} from "../lib/cron-schedule";
import { getSchedule } from "../lib/manifest";

/**
 * Every "now" in this file is an EXPLICIT instant and every expectation is an
 * explicit instant string. Nothing here reads the wall clock.
 *
 * That is deliberate: luxon's `DateTime.now()` / `fromObject` / `fromISO`
 * inherit the process clock AND `process.env.TZ`, so a test that builds "now"
 * implicitly passes or fails depending on the machine it runs on — which is
 * precisely the class of bug this module was fixing. Bracket instead: inject
 * the clock, assert against a hand-computed instant.
 */

/** 2026-09-14 13:00 America/Chicago — CDT, i.e. UTC−5. */
const SUMMER_NOW = new Date("2026-09-14T18:00:00.000Z");
/** 2026-01-15 12:00 America/Chicago — CST, i.e. UTC−6. */
const WINTER_NOW = new Date("2026-01-15T18:00:00.000Z");

const CHICAGO = "America/Chicago";

describe("nextCronRun — timezone correctness", () => {
  it("resolves a daily cron against the SCHEDULE's zone, not the server's", () => {
    // Midnight America/Chicago on 2026-09-15 is 05:00Z (CDT).
    expect(nextCronRun("0 0 * * *", CHICAGO, SUMMER_NOW)).toBe(
      "2026-09-15T05:00:00.000Z",
    );
  });

  it("does NOT return midnight UTC for a midnight-Central schedule", () => {
    // The old implementation (`new Date().setHours(0, 0, 0, 0)`) returned this
    // on Cloud Run, where the server zone is UTC — five hours early, rendered
    // to staff as 7:00 PM CT.
    expect(nextCronRun("0 0 * * *", CHICAGO, SUMMER_NOW)).not.toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("applies CDT in summer and CST in winter (DST, not a fixed offset)", () => {
    const summer = nextCronRun("0 0 * * *", CHICAGO, SUMMER_NOW);
    const winter = nextCronRun("0 0 * * *", CHICAGO, WINTER_NOW);

    expect(summer).toBe("2026-09-15T05:00:00.000Z"); // UTC−5
    expect(winter).toBe("2026-01-16T06:00:00.000Z"); // UTC−6

    // Same wall-clock time (00:00 Central), different UTC hour — a hardcoded
    // offset could not produce both.
    expect(new Date(summer!).getUTCHours()).toBe(5);
    expect(new Date(winter!).getUTCHours()).toBe(6);
  });

  it("handles the spring-forward gap without inventing an impossible instant", () => {
    // 2026-03-08 is the US spring-forward Sunday: 01:59:59 CST is followed by
    // 03:00:00 CDT, so 02:30 Central never happens that day. Standing at 06:00
    // CST the day before, the next `30 2 * * *` run resolves FORWARD across the
    // gap to 03:30 CDT = 08:30Z — a real instant, fired once. A fixed −6 offset
    // would have produced 08:30Z by accident here and 05:00Z-vs-06:00Z errors
    // everywhere else.
    const beforeDst = new Date("2026-03-07T12:00:00.000Z"); // 06:00 CST
    expect(nextCronRun("30 2 * * *", CHICAGO, beforeDst)).toBe(
      "2026-03-08T08:30:00.000Z",
    );
  });

  it("is correct for the real capability-sync schedule (20 22 * * * Central)", () => {
    // 22:20 CDT on 2026-09-14 = 03:20Z on 2026-09-15.
    expect(nextCronRun("20 22 * * *", CHICAGO, SUMMER_NOW)).toBe(
      "2026-09-15T03:20:00.000Z",
    );
  });

  it("rolls to tomorrow when today's slot has already passed", () => {
    // 19:00 Central on 2026-09-14 — past the 14:00 slot.
    const evening = new Date("2026-09-15T00:00:00.000Z");
    expect(nextCronRun("0 14 * * *", CHICAGO, evening)).toBe(
      "2026-09-15T19:00:00.000Z",
    );
  });

  it("returns the same instant regardless of the process timezone", () => {
    // The actual regression guard: server zone must not enter the answer. The
    // suite is ALSO run end-to-end under TZ=UTC and TZ=America/New_York; this
    // asserts it in-process so a single run cannot miss it.
    const original = process.env.TZ;
    try {
      const results = ["UTC", "America/New_York", "Asia/Tokyo"].map((tz) => {
        process.env.TZ = tz;
        return [
          nextCronRun("0 0 * * *", CHICAGO, SUMMER_NOW),
          nextCronRun("20 22 * * *", CHICAGO, SUMMER_NOW),
          nextCronRun("*/15 * * * *", "Etc/UTC", SUMMER_NOW),
          nextCronRun("10 * * * *", "Etc/UTC", SUMMER_NOW),
        ].join("|");
      });
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(
        [
          "2026-09-15T05:00:00.000Z",
          "2026-09-15T03:20:00.000Z",
          "2026-09-14T18:15:00.000Z",
          "2026-09-14T18:10:00.000Z",
        ].join("|"),
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("nextCronRun — the real settlements.run-batch schedule", () => {
  it("reports midnight Central, five hours later than the old server-local answer", () => {
    // Pinned against the manifest on purpose: this is the entry the
    // /platform/settlements "next payout batch" clock reads. If the batch is
    // ever rescheduled, update BOTH the schedule assertion and the instant —
    // do not delete the test.
    const schedule = getSchedule("settlements.run-batch");
    expect(schedule).toEqual({ cron: "0 0 * * *", timezone: CHICAGO });

    const next = nextCronRun(schedule.cron, schedule.timezone, SUMMER_NOW);
    expect(next).toBe("2026-09-15T05:00:00.000Z");

    // The old behaviour, reproduced exactly, for the record: server-local
    // midnight on a UTC box.
    const serverLocalMidnightUtc = "2026-09-15T00:00:00.000Z";
    expect(
      new Date(next!).getTime() - new Date(serverLocalMidnightUtc).getTime(),
    ).toBe(5 * 60 * 60 * 1000);
  });
});

describe("nextCronRun — zone-independent branches are unchanged", () => {
  it("*/N minutes: next multiple of N", () => {
    expect(
      nextCronRun("*/15 * * * *", "Etc/UTC", new Date("2026-09-14T18:07:30Z")),
    ).toBe("2026-09-14T18:15:00.000Z");
  });

  it("*/N minutes: strictly in the future when sitting exactly on a boundary", () => {
    expect(
      nextCronRun("*/15 * * * *", "Etc/UTC", new Date("2026-09-14T18:15:00Z")),
    ).toBe("2026-09-14T18:30:00.000Z");
  });

  it("*/N minutes: carries into the next hour", () => {
    expect(
      nextCronRun("*/15 * * * *", "Etc/UTC", new Date("2026-09-14T18:52:00Z")),
    ).toBe("2026-09-14T19:00:00.000Z");
    expect(
      nextCronRun("*/2 * * * *", "Etc/UTC", new Date("2026-09-14T18:59:10Z")),
    ).toBe("2026-09-14T19:00:00.000Z");
  });

  it("*/N minutes: unaffected by the schedule's zone", () => {
    expect(
      nextCronRun("*/15 * * * *", CHICAGO, new Date("2026-09-14T18:07:30Z")),
    ).toBe("2026-09-14T18:15:00.000Z");
  });

  it("hourly at minute M", () => {
    expect(
      nextCronRun("10 * * * *", "Etc/UTC", new Date("2026-09-14T18:07:00Z")),
    ).toBe("2026-09-14T18:10:00.000Z");
    expect(
      nextCronRun("10 * * * *", "Etc/UTC", new Date("2026-09-14T18:20:00Z")),
    ).toBe("2026-09-14T19:10:00.000Z");
  });

  it("*/N minutes: a divisor of 60 that no manifest entry uses still projects", () => {
    // `*/20` is not in jobs.manifest.json; it is here to show the divisor
    // rule admits every divisor, not just the three the manifest happens to
    // use. From :46 the next multiple is :60, i.e. :00 of the next hour —
    // exactly where cron restarts the step.
    expect(
      nextCronRun("*/20 * * * *", "Etc/UTC", new Date("2026-09-14T18:46:00Z")),
    ).toBe("2026-09-14T19:00:00.000Z");
    expect(
      nextCronRun("*/20 * * * *", "Etc/UTC", new Date("2026-09-14T18:10:00Z")),
    ).toBe("2026-09-14T18:20:00.000Z");
  });

  it("tolerates tabs, runs of spaces and surrounding whitespace", () => {
    // Field splitting is `trim().split(/\s+/)`, the same tolerance cron
    // itself has. A tab-separated manifest entry must project like its
    // single-spaced twin.
    expect(nextCronRun("0\t0  * * *\n", CHICAGO, SUMMER_NOW)).toBe(
      nextCronRun("0 0 * * *", CHICAGO, SUMMER_NOW),
    );
    expect(nextCronRun("0\t0  * * *\n", CHICAGO, SUMMER_NOW)).toBe(
      "2026-09-15T05:00:00.000Z",
    );
  });
});

describe("nextCronRun — unsupported shapes still return null", () => {
  it.each([
    ["not a cron", "hello"],
    ["four fields", "0 0 * *"],
    ["six fields", "0 0 * * * *"],
    ["non-numeric fields", "x y * * *"],
    ["every-N-hours", "0 */6 * * *"],
    ["zero step interval", "*/0 * * * *"],
    // The shapes below were each projected CONFIDENTLY WRONG before the
    // parser became exact: the month field was ignored and minute/hour went
    // through `parseInt`, which reads `0,12` as 0 and `8-18` as 8. The
    // manifest validator accepts all of them, so the first such entry would
    // have shown a false next-run on /platform/jobs.
    ["month-restricted (was: tomorrow, in September)", "0 0 * 1 *"],
    ["hour list (was: midnight only)", "0 0,12 * * *"],
    ["hour range (was: 08:00 only)", "0 8-18 * * *"],
    ["step minute + hour range (was: all day)", "*/15 9-17 * * *"],
    ["named day-of-week", "0 0 * * MON"],
    ["question-mark day-of-month", "0 0 ? * *"],
    ["minute out of range", "60 0 * * *"],
    ["hour out of range", "0 24 * * *"],
    // `*/60` is a valid Cloud Scheduler spelling of "every hour at :00", but
    // it is refused here on purpose: N is a MINUTE count (1–59) and admitting
    // 60 would beg the question of `*/90`. The hourly shape is `0 * * * *`.
    ["step of 60 minutes (write `0 * * * *`)", "*/60 * * * *"],
    // Cron restarts the step at :00 every hour, so `*/7` fires :00 :07 … :56
    // then :00 — the "next multiple of N, carry into the next hour" arithmetic
    // gave 19:03 from 18:56 (cron: 19:00) and, for `*/45`, 19:30 from 18:46
    // (cron: 19:00). Only divisors of 60 have a next-multiple that is also the
    // next firing, so anything else is refused rather than projected wrong.
    ["step that does not divide 60 (was: 19:03 from 18:56)", "*/7 * * * *"],
    ["step that does not divide 60 (was: 19:30 from 18:46)", "*/45 * * * *"],
    ["minute list", "0,30 * * * *"],
    ["step on the hour with a step minute", "*/15 */2 * * *"],
    ["every minute (bare `*` minute is not a supported shape)", "* * * * *"],
  ])("%s → null", (_label, cron) => {
    expect(nextCronRun(cron, CHICAGO, SUMMER_NOW)).toBeNull();
  });

  it("returns null rather than guessing when the zone id is unknown", () => {
    expect(
      nextCronRun("0 0 * * *", "Mars/Olympus_Mons", SUMMER_NOW),
    ).toBeNull();
  });

  it("refuses an out-of-range hour instead of rolling it over", () => {
    // Previously pinned as `2026-09-18T08:00:00.000Z`: luxon's
    // `set({ hour: 99 })` rolled forward exactly as `Date#setHours(99)` had,
    // and the pin existed only to prove the zone fix changed nothing else.
    // That was never a defensible answer — no scheduler accepts hour 99, so a
    // projection for it is a fabricated instant. Fields are now range-checked
    // before any date arithmetic runs, and the documented `null` wins.
    expect(nextCronRun("0 99 * * *", CHICAGO, SUMMER_NOW)).toBeNull();
  });
});

describe("nextCronRun — omitted timezone", () => {
  it("falls back to Etc/UTC, never to the server zone", () => {
    // Explicit choice (documented on DEFAULT_CRON_TZ): an absent timezone means
    // UTC, matching what `jobScheduleInfo` already reports and what Cloud
    // Scheduler assumes.
    expect(DEFAULT_CRON_TZ).toBe("Etc/UTC");
    expect(nextCronRun("0 0 * * *", undefined, SUMMER_NOW)).toBe(
      nextCronRun("0 0 * * *", "Etc/UTC", SUMMER_NOW),
    );
    expect(nextCronRun("0 0 * * *", undefined, SUMMER_NOW)).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });
});

describe("nextCronRun — DST fall-back (pinned current behaviour)", () => {
  // 2026-11-01 is the US fall-back Sunday in America/Chicago: the clocks go
  // 01:59:59 CDT → 01:00:00 CST, so every wall-clock time in [01:00, 02:00)
  // happens TWICE that day. 01:30 Central is first 06:30Z (CDT, −5) and then
  // 07:30Z (CST, −6).
  //
  // These assertions pin what the function does TODAY. They are NOT a claim
  // about Cloud Scheduler: whether it fires a `30 1 * * *` job once or twice
  // during the repeated hour has not been verified against it. The pin exists
  // so that if this behaviour ever changes, it changes deliberately — with
  // that verification in hand — rather than as a side effect of some other
  // edit to the date arithmetic.

  it("daily: resolves to the FIRST occurrence of the repeated wall-clock time", () => {
    // Standing at 07:00 CDT on Oct 31, next 01:30 Central is the CDT one.
    expect(
      nextCronRun("30 1 * * *", CHICAGO, new Date("2026-10-31T12:00:00.000Z")),
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("daily: once past the first occurrence, SKIPS the second and rolls to the next day", () => {
    // 06:31Z is 01:31 CDT — one minute after the first 01:30, an hour before
    // the second. Current behaviour: `set({hour:1, minute:30})` lands on the
    // first occurrence (already past), and `plus({days:1})` jumps clean over
    // the second one to 01:30 CST on Nov 2 = 07:30Z.
    expect(
      nextCronRun("30 1 * * *", CHICAGO, new Date("2026-11-01T06:31:00.000Z")),
    ).toBe("2026-11-02T07:30:00.000Z");
  });

  it("hourly: projects into BOTH copies of the repeated hour", () => {
    // Hourly arithmetic is `plus({hours:1})` on an instant, so the second
    // 01:30 (07:30Z) is a real next run from inside the first copy of the
    // hour, and 02:30 CST (08:30Z) follows from inside the second copy.
    expect(
      nextCronRun("30 * * * *", CHICAGO, new Date("2026-11-01T06:31:00.000Z")),
    ).toBe("2026-11-01T07:30:00.000Z");
    expect(
      nextCronRun("30 * * * *", CHICAGO, new Date("2026-11-01T07:31:00.000Z")),
    ).toBe("2026-11-01T08:30:00.000Z");
  });
});

describe("describeCron", () => {
  it("names the timezone on wall-clock descriptions", () => {
    expect(describeCron("0 0 * * *", CHICAGO)).toBe(
      "Daily at 00:00 America/Chicago",
    );
    expect(describeCron("20 22 * * *", CHICAGO)).toBe(
      "Daily at 22:20 America/Chicago",
    );
  });

  it("renders Etc/UTC as plain UTC", () => {
    expect(describeCron("0 4 * * *", "Etc/UTC")).toBe("Daily at 04:00 UTC");
  });

  it("keeps the un-zoned wording when no timezone is supplied", () => {
    expect(describeCron("0 0 * * *")).toBe("Daily at 00:00");
  });

  it("leaves zone-independent descriptions alone", () => {
    expect(describeCron("*/15 * * * *", CHICAGO)).toBe("Every 15 minutes");
    expect(describeCron("30 * * * *", CHICAGO)).toBe(
      "At minute 30 of every hour",
    );
  });

  it("falls through to the raw string for step-hour shapes", () => {
    // Both of these used to be described — `* */6 * * *` as "Every 6 hours at
    // minute *" and `0 */6 * * *` as "Daily at */6:00 America/Chicago" (the
    // daily branch matched first because the hour was merely "not `*`"). The
    // second was a pinned quirk; the first read as a real description of a
    // shape `nextCronRun` returns `null` for. `describeCron` now shares
    // `nextCronRun`'s exact parser, so anything the projector refuses is
    // rendered raw rather than given a friendly — and possibly wrong — label.
    expect(describeCron("* */6 * * *", CHICAGO)).toBe("* */6 * * *");
    expect(describeCron("0 */6 * * *", CHICAGO)).toBe("0 */6 * * *");
  });

  it("returns the raw expression for shapes it cannot describe", () => {
    expect(describeCron("0 7 * * 1", CHICAGO)).toBe("0 7 * * 1");
    expect(describeCron("hello", CHICAGO)).toBe("hello");
  });

  it("agrees with nextCronRun: never describes a shape the projector refuses", () => {
    // `0 0,12 * * *` would have rendered "Daily at 0,12:00 America/Chicago";
    // `0 0 * 1 *` would have rendered "Daily at 00:00 …" for a January-only
    // job. A description with an em-dash next-run beside it is a contradiction
    // on the staff console; a description that is itself wrong is worse.
    for (const cron of [
      "0 0 * 1 *",
      "0 0,12 * * *",
      "0 8-18 * * *",
      "*/15 9-17 * * *",
      "0 0 * * MON",
      "0 0 ? * *",
      "60 0 * * *",
      "0 24 * * *",
      "*/60 * * * *",
      "*/7 * * * *",
      "*/45 * * * *",
      "0 99 * * *",
    ]) {
      expect(nextCronRun(cron, CHICAGO, SUMMER_NOW)).toBeNull();
      expect(describeCron(cron, CHICAGO)).toBe(cron);
    }
  });

  it("still describes every supported shape, including zero-padded fields", () => {
    expect(describeCron("5 9 * * *", CHICAGO)).toBe(
      "Daily at 09:05 America/Chicago",
    );
    expect(describeCron("05 09 * * *", CHICAGO)).toBe(
      "Daily at 09:05 America/Chicago",
    );
    expect(describeCron("*/2 * * * *")).toBe("Every 2 minutes");
    expect(describeCron("0 * * * *")).toBe("At minute 0 of every hour");
  });
});

// ── Day-restricted schedules ───────────────────────────────────────────────
//
// `describeCron` has always refused these (falling through to the raw cron
// string). `nextCronRun` did not: it ignored dom/dow entirely, so a weekly job
// took the DAILY branch and reported tomorrow. The two now agree, and the
// answer for an unsupported shape is `null` — which /platform/jobs renders as
// an em dash and the settlements batch clock renders as an "unprojectable"
// warning beside the raw cron (`BatchClock.tsx`).

describe("nextCronRun — day-of-week / day-of-month restricted", () => {
  // Monday 2026-09-14T18:00Z. The real manifest entries.
  const MON = new Date("2026-09-14T18:00:00.000Z");

  it("returns null for a weekly cron instead of reporting TOMORROW", () => {
    // Was: 2026-09-15T07:00:00.000Z (a Tuesday) for a job that runs Mondays.
    expect(nextCronRun("0 7 * * 1", "Etc/UTC", MON)).toBeNull();
    expect(nextCronRun("0 6 * * 1", "Etc/UTC", MON)).toBeNull();
    expect(nextCronRun("0 16 * * 4", "Etc/UTC", MON)).toBeNull();
  });

  it("returns null for a day-of-month cron", () => {
    expect(nextCronRun("0 3 1 * *", "Etc/UTC", MON)).toBeNull();
  });

  it("refuses day-restricted */N and hourly shapes too", () => {
    // Every 5 minutes, but only on Mondays — still not a shape we can project.
    expect(nextCronRun("*/5 * * * 1", "Etc/UTC", MON)).toBeNull();
    expect(nextCronRun("30 * * * 1", "Etc/UTC", MON)).toBeNull();
  });

  it("still projects every UNRESTRICTED shape — the guard is not a blanket refusal", () => {
    expect(nextCronRun("0 0 * * *", CHICAGO, MON)).toBe(
      "2026-09-15T05:00:00.000Z",
    );
    expect(nextCronRun("*/15 * * * *", "Etc/UTC", MON)).toBe(
      "2026-09-14T18:15:00.000Z",
    );
    expect(nextCronRun("30 * * * *", "Etc/UTC", MON)).toBe(
      "2026-09-14T18:30:00.000Z",
    );
  });

  it("every scheduled job in the REAL manifest either projects or is day-restricted", () => {
    // Guards the actual consequence: no manifest entry may silently lose its
    // next-run because the guard was drawn too wide.
    const nulls: string[] = [];
    for (const [name, entry] of Object.entries(manifestJson.scheduled)) {
      const next = nextCronRun(entry.cron, entry.timezone, MON);
      if (next === null) nulls.push(`${name} (${entry.cron})`);
    }
    // Exactly the three weekly jobs, and nothing else.
    expect(nulls.sort()).toEqual([
      "attendee-review-digests.send (0 16 * * 4)",
      "attendee-reviews.recompute-aggregates (0 7 * * 1)",
      "places.recompute-public-snapshots (0 6 * * 1)",
    ]);
  });
});

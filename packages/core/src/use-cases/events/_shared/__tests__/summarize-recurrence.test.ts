import type { EventSeriesSchedule } from "@th/types";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { expandRecurrenceDates } from "../expand-recurrence";
import { summarizeRecurrence } from "../summarize-recurrence";

/**
 * Every case here runs in a NON-UTC zone on purpose (standing ruling: RRULE is
 * evaluated on a LOCAL basis, and a UTC-only test hides the off-by-a-day class
 * of bug outright — an 8pm Chicago Wednesday is already Thursday in UTC).
 */
const ZONE = "America/Chicago";
const OPTS = { timezone: ZONE };

/** Wall-clock label in ZONE, so an assertion reads as the organizer sees it. */
function localLabel(instant: Date): string {
  return DateTime.fromJSDate(instant)
    .setZone(ZONE)
    .toFormat("EEE yyyy-MM-dd HH:mm");
}

/** A Wednesday 20:00 in Chicago — 01:00 the NEXT day in UTC. */
const WEDNESDAY_8PM = "2026-09-09T20:00:00-05:00";

function rrule(
  rule: string,
  overrides: Partial<EventSeriesSchedule> = {},
): EventSeriesSchedule {
  return {
    kind: "RRULE",
    rrule: rule,
    dtstart: WEDNESDAY_8PM,
    ...overrides,
  };
}

describe("summarizeRecurrence", () => {
  it("summarises a weekly single-BYDAY rule (the weekly open mic)", () => {
    const summary = summarizeRecurrence(rrule("FREQ=WEEKLY;BYDAY=WE"), OPTS);

    expect(summary).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byday: ["WE"],
      until: null,
    });
  });

  it("states the weekday the EXPANSION actually lands on, not the UTC one", () => {
    // The guard against re-introducing a UTC basis: dtstart is Wed 20:00
    // Chicago, which is Thu 01:00Z. The summary must say WE and the expansion
    // must agree, in local time.
    const schedule = rrule("FREQ=WEEKLY;BYDAY=WE");

    const summary = summarizeRecurrence(schedule, OPTS);
    const dates = expandRecurrenceDates(schedule, {
      windowStart: new Date("2026-09-09T00:00:00.000Z"),
      // Sep 30 20:00 Chicago is Oct 1 01:00Z, so the UTC bound has to sit
      // past midnight to include the last local-September Wednesday.
      windowEnd: new Date("2026-10-01T06:00:00.000Z"),
      max: 10,
      timezone: ZONE,
    });

    expect(summary?.byday).toEqual(["WE"]);
    expect(dates.map((d) => localLabel(d.startsAt))).toEqual([
      "Wed 2026-09-09 20:00",
      "Wed 2026-09-16 20:00",
      "Wed 2026-09-23 20:00",
      "Wed 2026-09-30 20:00",
    ]);
    // ...and in UTC those are Thursdays, which is exactly the trap.
    expect(dates[0]!.startsAt.toISOString()).toBe("2026-09-10T01:00:00.000Z");
  });

  it("carries an interval > 1 (every other week)", () => {
    expect(
      summarizeRecurrence(rrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE"), OPTS),
    ).toEqual({ freq: "WEEKLY", interval: 2, byday: ["WE"], until: null });
  });

  it("orders multiple BYDAY codes Monday-first and de-duplicates", () => {
    expect(
      summarizeRecurrence(rrule("FREQ=WEEKLY;BYDAY=SU,WE,MO,WE"), OPTS)?.byday,
    ).toEqual(["MO", "WE", "SU"]);
  });

  it("summarises a monthly rule, dropping the BYSETPOS ordinal", () => {
    // The web builder emits its "nth weekday of the month" preset as
    // BYDAY + BYSETPOS. The contract has no ordinal slot, so the ordinal is
    // lost and the sentence stays vague (MONTHLY on a Wednesday) rather than
    // wrong by a week.
    expect(
      summarizeRecurrence(rrule("FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2"), OPTS),
    ).toEqual({ freq: "MONTHLY", interval: 1, byday: ["WE"], until: null });
  });

  it("summarises a monthly BYMONTHDAY rule with no weekday constraint", () => {
    expect(
      summarizeRecurrence(rrule("FREQ=MONTHLY;BYMONTHDAY=15"), OPTS),
    ).toEqual({ freq: "MONTHLY", interval: 1, byday: [], until: null });
  });

  it("summarises a daily rule", () => {
    expect(summarizeRecurrence(rrule("FREQ=DAILY"), OPTS)).toEqual({
      freq: "DAILY",
      interval: 1,
      byday: [],
      until: null,
    });
  });

  it("keeps the weekday of an nth-prefixed BYDAY token (2WE)", () => {
    expect(summarizeRecurrence(rrule("FREQ=MONTHLY;BYDAY=2WE"), OPTS)).toEqual({
      freq: "MONTHLY",
      interval: 1,
      byday: ["WE"],
      until: null,
    });
  });

  describe("UNTIL", () => {
    it("reads the bound beside the rule as a LOCAL wall clock", () => {
      const summary = summarizeRecurrence(
        rrule("FREQ=WEEKLY;BYDAY=WE", { until: "2026-12-30T23:59:00" }),
        OPTS,
      );

      // 23:59 local on Dec 30 in Chicago (CST, -06:00) = 05:59Z on Dec 31.
      expect(summary?.until?.toISOString()).toBe("2026-12-31T05:59:00.000Z");
      expect(localLabel(summary!.until!)).toBe("Wed 2026-12-30 23:59");
    });

    it("reads an UNTIL carried inside the rule string", () => {
      const summary = summarizeRecurrence(
        rrule("FREQ=WEEKLY;BYDAY=WE;UNTIL=20261230T235900Z"),
        OPTS,
      );

      expect(localLabel(summary!.until!)).toBe("Wed 2026-12-30 23:59");
    });

    it("prefers schedule.until over the rule's own UNTIL, as expansion does", () => {
      // expandRecurrenceDates overwrites ruleOptions.until with schedule.until,
      // so the page must state the same bound the dates were enumerated against.
      const summary = summarizeRecurrence(
        rrule("FREQ=WEEKLY;BYDAY=WE;UNTIL=20270630T235900Z", {
          until: "2026-12-30T23:59:00",
        }),
        OPTS,
      );

      expect(localLabel(summary!.until!)).toBe("Wed 2026-12-30 23:59");
    });

    it("falls through to the rule's UNTIL when schedule.until is unparseable, as expansion does", () => {
      // The precedence has to mirror expansion on the FAILURE path too:
      // `expandRecurrenceDates` only overwrites the rule's UNTIL when the
      // floating conversion SUCCEEDS, so a garbage bound beside the rule leaves
      // the rule's own `UNTIL=` in force and the dates stop there. Committing to
      // the `schedule.until` branch on truthiness alone dropped the bound and
      // the page then claimed an open-ended series.
      const schedule = rrule("FREQ=WEEKLY;BYDAY=WE;UNTIL=20261230T235900Z", {
        until: "not a date at all",
      });

      const summary = summarizeRecurrence(schedule, OPTS);
      const dates = expandRecurrenceDates(schedule, {
        windowStart: new Date("2026-09-09T00:00:00.000Z"),
        windowEnd: new Date("2027-06-01T00:00:00.000Z"),
        max: 100,
        timezone: ZONE,
      });

      expect(localLabel(summary!.until!)).toBe("Wed 2026-12-30 23:59");
      // ...and that is exactly where the enumerated dates stop.
      expect(localLabel(dates[dates.length - 1]!.startsAt)).toBe(
        "Wed 2026-12-30 20:00",
      );
    });

    it("reports null for a COUNT-bounded rule (no UNTIL to state)", () => {
      expect(
        summarizeRecurrence(rrule("FREQ=WEEKLY;BYDAY=WE;COUNT=12"), OPTS)?.until,
      ).toBeNull();
    });
  });

  describe("refuses to summarise (null), never throws", () => {
    const cases: Array<[string, unknown]> = [
      ["a null schedule", null],
      ["an undefined schedule", undefined],
      ["a FIXED_DATES schedule", { kind: "FIXED_DATES", dates: [WEDNESDAY_8PM] }],
      ["an RRULE kind with no rule string", { kind: "RRULE", dtstart: WEDNESDAY_8PM }],
      ["an empty rule string", rrule("")],
      ["a rule with no FREQ", rrule("BYDAY=WE")],
      ["an unknown FREQ", rrule("FREQ=NONSENSE;BYDAY=WE")],
      ["a frequency outside the subset (YEARLY)", rrule("FREQ=YEARLY")],
      ["a sub-daily frequency (HOURLY)", rrule("FREQ=HOURLY")],
      ["an unknown RRULE property", rrule("FREQ=WEEKLY;NOPE=1")],
      // `rrule`'s parser turns an unrecognised 2-letter day into `undefined`
      // rather than throwing, so without an explicit check this would have
      // summarised as a bare "every week" and silently dropped the day.
      ["an unrecognised BYDAY token", rrule("FREQ=WEEKLY;BYDAY=XX")],
      // Out of contract: a cadence line has one slot for the frequency and one
      // for the days, and DAILY occupies the first without the second being
      // renderable — so a Mon/Wed/Fri rule came out as "Every day", claiming 7
      // nights a week for an event that runs 3. The web builder refuses the
      // combination too (`recurrence-helpers.ts`), so nothing legitimate emits it.
      ["a DAILY rule with BYDAY", rrule("FREQ=DAILY;BYDAY=MO,WE,FR")],
      ["a DAILY rule with a single BYDAY", rrule("FREQ=DAILY;BYDAY=WE")],
      [
        "a DAILY rule with BYDAY and an interval",
        rrule("FREQ=DAILY;INTERVAL=2;BYDAY=MO,WE,FR"),
      ],
      ["a malformed nth BYDAY token", rrule("FREQ=WEEKLY;BYDAY=99XYZ")],
      ["free-form garbage", rrule("not a rule at all")],
      ["a non-object schedule", "FREQ=WEEKLY" as unknown],
      ["a numeric schedule", 42 as unknown],
      ["an array schedule", [] as unknown],
    ];

    for (const [label, schedule] of cases) {
      it(`returns null for ${label}`, () => {
        expect(
          summarizeRecurrence(schedule as EventSeriesSchedule | null, OPTS),
        ).toBeNull();
      });
    }

  });

  it("still states the cadence under an unknown timezone, with UNTIL dropped", () => {
    // The cadence itself is zone-free, so it survives. A bound is NOT: an
    // unresolvable zone collapses UNTIL to null rather than leaking an
    // Invalid Date into the page.
    expect(
      summarizeRecurrence(rrule("FREQ=WEEKLY;BYDAY=WE"), {
        timezone: "Mars/Olympus_Mons",
      }),
    ).toEqual({ freq: "WEEKLY", interval: 1, byday: ["WE"], until: null });
    expect(
      summarizeRecurrence(
        rrule("FREQ=WEEKLY;BYDAY=WE", { until: "2026-12-30T23:59:00" }),
        { timezone: "Mars/Olympus_Mons" },
      )?.until,
    ).toBeNull();
  });

  describe("degenerate INTERVAL values fall back to 1", () => {
    for (const rule of [
      "FREQ=WEEKLY;INTERVAL=0;BYDAY=WE",
      // A comma list parses to an ARRAY, and a non-integer to a STRING —
      // `rrule`'s parser hands both straight through without complaint.
      "FREQ=WEEKLY;INTERVAL=1,2;BYDAY=WE",
      "FREQ=WEEKLY;INTERVAL=2.7;BYDAY=WE",
      "FREQ=WEEKLY;INTERVAL=-3;BYDAY=WE",
    ]) {
      it(`treats "${rule}" as every week`, () => {
        expect(summarizeRecurrence(rrule(rule), OPTS)?.interval).toBe(1);
      });
    }
  });
});

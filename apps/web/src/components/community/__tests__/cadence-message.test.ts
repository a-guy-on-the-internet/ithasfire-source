import { describe, expect, it } from "vitest";

import { cadenceMessage } from "../cadence-message";

const TIMEZONE = "America/Chicago";
const at = (iso: string) => ({ startsAt: new Date(iso) });

/** Three consecutive Wednesdays, 8:00 PM Central. */
const WEDNESDAYS = [
  at("2026-09-17T01:00:00.000Z"),
  at("2026-09-24T01:00:00.000Z"),
  at("2026-10-01T01:00:00.000Z"),
];

const call = (
  recurrence: Parameters<typeof cadenceMessage>[0]["recurrence"],
  dates = WEDNESDAYS,
) =>
  cadenceMessage({
    recurrence,
    dates,
    time: "8:00 PM",
    timezone: TIMEZONE,
    locale: "en-US",
  });

describe("cadenceMessage", () => {
  it("names the weekday from the LISTING's zone, not the runtime's", () => {
    // 2026-09-17T01:00Z is Thursday in UTC and Wednesday in Chicago. Reading
    // the weekday off the instant would print the wrong day on a UTC runner.
    expect(call({ freq: "WEEKLY", interval: 1, byday: ["WE"] })).toEqual({
      key: "rsvp.cadenceEveryWeek",
      values: { days: "Wednesday", time: "8:00 PM" },
    });
  });

  it("carries the interval on an every-other-week rule", () => {
    expect(call({ freq: "WEEKLY", interval: 2, byday: ["WE"] })).toEqual({
      key: "rsvp.cadenceEveryNWeeks",
      values: { interval: 2, days: "Wednesday", time: "8:00 PM" },
    });
  });

  it("DROPS the day list it cannot fill rather than half-stating it", () => {
    // A MO,WE,FR rule with only Wednesdays still upcoming would otherwise read
    // "Every Wednesday" — confidently wrong about a three-day rule. The
    // day-less sentence keeps the time, which is the half that is still true.
    expect(call({ freq: "WEEKLY", interval: 1, byday: ["MO", "WE", "FR"] })).toEqual(
      { key: "rsvp.cadenceEveryWeekNoDays", values: { time: "8:00 PM" } },
    );
  });

  it("orders a multi-day list by WEEK position, not by which day is next", () => {
    expect(
      call({ freq: "WEEKLY", interval: 1, byday: ["WE", "TH"] }, [
        // THURSDAY first: 2026-09-18T01:00Z is Sep 17, 8:00 PM in Chicago.
        at("2026-09-18T01:00:00.000Z"),
        // then Wednesday: 2026-09-17T01:00Z is Sep 16, 8:00 PM in Chicago.
        at("2026-09-17T01:00:00.000Z"),
      ]),
    ).toEqual({
      key: "rsvp.cadenceEveryWeek",
      // The list is read off the OCCURRENCES (Thu then Wed in this order) and
      // sorted Monday-first, so the sentence reads "Wednesday and Thursday".
      values: { days: "Wednesday and Thursday", time: "8:00 PM" },
    });
  });

  it("states daily and monthly cadences without a day list", () => {
    expect(call({ freq: "DAILY", interval: 1, byday: [] })).toEqual({
      key: "rsvp.cadenceEveryDay",
      values: { time: "8:00 PM" },
    });
    expect(call({ freq: "MONTHLY", interval: 3, byday: ["WE"] })).toEqual({
      key: "rsvp.cadenceEveryNMonths",
      values: { interval: 3, time: "8:00 PM" },
    });
  });

  it("says nothing at all rather than guessing a cadence from the gaps", () => {
    expect(call(null)).toBeNull();
    expect(call({ freq: "WEEKLY", interval: 1, byday: ["WE"] }, [])).toBeNull();
  });
});

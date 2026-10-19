import { describe, expect, it } from "vitest";

import {
  buildRrule,
  nthWeekdayOfMonth,
  toIcalUtc,
  weekdayOf,
} from "../build-rrule";

// 2026-01-06T19:00 is a Tuesday; the first Tuesday of the month.
const TUESDAY = new Date(Date.UTC(2026, 0, 6, 19, 0, 0));
// 2026-01-20T19:00 is the third Tuesday.
const THIRD_TUESDAY = new Date(Date.UTC(2026, 0, 20, 19, 0, 0));
// End-of-day 2026-12-31.
const UNTIL = new Date(Date.UTC(2026, 11, 31, 23, 59, 0));

describe("weekdayOf", () => {
  it("maps a UTC calendar day to its RRULE weekday", () => {
    expect(weekdayOf(TUESDAY)).toBe("TU");
    expect(weekdayOf(new Date(Date.UTC(2026, 0, 4)))).toBe("SU");
    expect(weekdayOf(new Date(Date.UTC(2026, 0, 10)))).toBe("SA");
  });
});

describe("nthWeekdayOfMonth", () => {
  it("returns the 1-based ordinal within the month", () => {
    expect(nthWeekdayOfMonth(TUESDAY)).toBe(1);
    expect(nthWeekdayOfMonth(THIRD_TUESDAY)).toBe(3);
  });
});

describe("toIcalUtc", () => {
  it("formats a UTC instant as YYYYMMDDTHHMMSSZ", () => {
    expect(toIcalUtc(UNTIL)).toBe("20261231T235900Z");
    expect(toIcalUtc(new Date(Date.UTC(2026, 6, 1, 5, 3, 9)))).toBe(
      "20260701T050309Z",
    );
  });
});

describe("buildRrule", () => {
  it("weekly, single explicit day", () => {
    expect(
      buildRrule({ freq: "WEEKLY", interval: 1, byWeekday: ["TU"], startsAt: TUESDAY }),
    ).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
  });

  it("weekly defaults BYDAY to the weekday of startsAt when none picked", () => {
    expect(buildRrule({ freq: "WEEKLY", startsAt: TUESDAY })).toBe(
      "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU",
    );
  });

  it("weekly, multiple days emitted Monday-first regardless of input order", () => {
    expect(
      buildRrule({
        freq: "WEEKLY",
        interval: 1,
        byWeekday: ["FR", "MO", "WE"],
        startsAt: TUESDAY,
      }),
    ).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR");
  });

  it("weekly, interval > 1", () => {
    expect(
      buildRrule({ freq: "WEEKLY", interval: 2, byWeekday: ["TU"], startsAt: TUESDAY }),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
  });

  it("monthly on the same day-of-month (default mode)", () => {
    expect(buildRrule({ freq: "MONTHLY", interval: 1, startsAt: TUESDAY })).toBe(
      "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=6",
    );
  });

  it("monthly on the Nth weekday", () => {
    expect(
      buildRrule({
        freq: "MONTHLY",
        interval: 1,
        monthlyMode: "NTH_WEEKDAY",
        startsAt: THIRD_TUESDAY,
      }),
    ).toBe("FREQ=MONTHLY;INTERVAL=1;BYDAY=3TU");
  });

  it("monthly, interval > 1", () => {
    expect(
      buildRrule({ freq: "MONTHLY", interval: 3, startsAt: TUESDAY }),
    ).toBe("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=6");
  });

  it("appends UNTIL as iCal UTC when a bound is supplied", () => {
    expect(
      buildRrule({
        freq: "WEEKLY",
        interval: 1,
        byWeekday: ["TU"],
        startsAt: TUESDAY,
        until: UNTIL,
      }),
    ).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20261231T235900Z");
  });

  it("coerces interval < 1 and fractional intervals to a floor of 1", () => {
    expect(
      buildRrule({ freq: "WEEKLY", interval: 0, byWeekday: ["TU"], startsAt: TUESDAY }),
    ).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
    expect(
      buildRrule({ freq: "WEEKLY", interval: 2.9, byWeekday: ["TU"], startsAt: TUESDAY }),
    ).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
  });
});

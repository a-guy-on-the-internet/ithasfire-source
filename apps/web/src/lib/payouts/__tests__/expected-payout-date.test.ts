import { describe, expect, it } from "vitest";
import { computePayoutDate } from "@th/core/lib/payout-scheduling/compute-payout-date";
import type { PayoutSchedule } from "@th/types";

import { PAYOUT_DATE_FORMAT, expectedPayoutDate } from "../expected-payout-date";

/** The Central calendar day, independent of the runner's time zone. */
const centralDay = (date: Date | null) =>
  date ? new Intl.DateTimeFormat("en-US", PAYOUT_DATE_FORMAT).format(date) : null;

// Wednesday 2026-10-07 and Saturday 2026-10-10, both ending 11pm Central
// (CDT, UTC-5) — so the end is already the NEXT day in UTC, which is
// exactly where a naive `new Date(start) + N days` drifted.
const WEDNESDAY = {
  startsAt: "2026-10-08T01:00:00.000Z", // Wed 8pm CT
  endsAt: "2026-10-08T04:00:00.000Z", // Wed 11pm CT
};
const SATURDAY = {
  startsAt: "2026-10-11T01:00:00.000Z", // Sat 8pm CT
  endsAt: "2026-10-11T04:00:00.000Z", // Sat 11pm CT
};

const CASES: Array<[PayoutSchedule, string, string]> = [
  // schedule, Wednesday event, Saturday event
  ["ASAP", "Thu, Oct 8, 2026", "Sun, Oct 11, 2026"],
  // Wednesday keeps its own Sunday; Saturday is 1 day from it and rolls.
  ["WEEK_OF_EVENT", "Sun, Oct 11, 2026", "Sun, Oct 18, 2026"],
  ["ONE_WEEK_AFTER", "Sun, Oct 18, 2026", "Sun, Oct 18, 2026"],
  ["TWO_WEEKS_AFTER", "Sun, Oct 25, 2026", "Sun, Oct 25, 2026"],
  // Across the DST change (Nov 1): still Sunday at midnight Central.
  ["FOUR_WEEKS_AFTER", "Sun, Nov 8, 2026", "Sun, Nov 8, 2026"],
];

describe("expectedPayoutDate", () => {
  it.each(CASES)("%s: Wednesday → %s, Saturday → %s", (schedule, wed, sat) => {
    const wedDate = expectedPayoutDate(schedule, WEDNESDAY);
    const satDate = expectedPayoutDate(schedule, SATURDAY);
    // Exactly what core's batch rule returns, not a copy of it…
    expect(wedDate).toEqual(computePayoutDate(new Date(WEDNESDAY.endsAt), schedule));
    expect(satDate).toEqual(computePayoutDate(new Date(SATURDAY.endsAt), schedule));
    // …and the Central calendar day an organiser should see.
    expect(centralDay(wedDate)).toBe(wed);
    expect(centralDay(satDate)).toBe(sat);
  });

  it("uses the event's end, falling back to its start like the credit writer", () => {
    // Starts Saturday 11pm, ends Sunday 1am: ASAP is the day after the END.
    const lateShow = {
      startsAt: "2026-10-11T04:00:00.000Z",
      endsAt: "2026-10-11T06:00:00.000Z",
    };
    expect(centralDay(expectedPayoutDate("ASAP", lateShow))).toBe(
      "Mon, Oct 12, 2026",
    );
    expect(
      centralDay(expectedPayoutDate("ASAP", { startsAt: lateShow.startsAt })),
    ).toBe("Sun, Oct 11, 2026");
  });

  it("no date, or an unparseable one, gives null", () => {
    expect(expectedPayoutDate("ASAP", {})).toBeNull();
    expect(expectedPayoutDate("ASAP", { startsAt: "not a date" })).toBeNull();
  });
});

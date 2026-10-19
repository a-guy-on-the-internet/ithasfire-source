import { describe, expect, it } from "vitest";

import {
  computePayoutDate,
  getEffectiveSunday,
  isPayoutDue,
} from "./compute-payout-date";

describe("computePayoutDate", () => {
  // Using dates that are clearly in specific days of the week
  // Wednesday, January 15, 2025 at 8:00 PM CST
  const wednesdayEvent = new Date("2025-01-15T20:00:00-06:00");
  // Sunday, January 19, 2025 at 8:00 PM CST
  const sundayEvent = new Date("2025-01-19T20:00:00-06:00");
  // Saturday, January 18, 2025 at 8:00 PM CST
  const saturdayEvent = new Date("2025-01-18T20:00:00-06:00");

  describe("ASAP", () => {
    it("returns the next day at midnight CST", () => {
      const result = computePayoutDate(wednesdayEvent, "ASAP");
      // Should be Thursday, January 16, 2025 at midnight CST
      expect(result.toISOString()).toBe("2025-01-16T06:00:00.000Z"); // midnight CST = 6 AM UTC
    });

    it("handles late-night events correctly", () => {
      // Event ends at 11:30 PM CST
      const lateEvent = new Date("2025-01-15T23:30:00-06:00");
      const result = computePayoutDate(lateEvent, "ASAP");
      expect(result.toISOString()).toBe("2025-01-16T06:00:00.000Z");
    });
  });

  describe("WEEK_OF_EVENT", () => {
    // The rule: the Sunday of the event's week, UNLESS that Sunday is
    // STRICTLY fewer than 2 calendar days after the event ends, in which case
    // it rolls to the following Sunday. Strictly, so only Saturday (1 day) and
    // Sunday (0 days) roll — Friday is exactly 2 and keeps its own Sunday.
    // This subsumes the old "event is itself on a Sunday" special case.
    //
    // The organiser-facing copy says "within 2 days", which reads inclusive
    // and would also roll Friday. The copy is what needs to change; the
    // behaviour below is the ruled one.
    it("returns Sunday of the same week for mid-week events", () => {
      const result = computePayoutDate(wednesdayEvent, "WEEK_OF_EVENT");
      // Wednesday Jan 15 -> Sunday Jan 19, midnight CST
      expect(result.toISOString()).toBe("2025-01-19T06:00:00.000Z");
    });

    it("returns NEXT Sunday for Sunday events", () => {
      const result = computePayoutDate(sundayEvent, "WEEK_OF_EVENT");
      // Sunday Jan 19 -> Sunday Jan 26, midnight CST
      expect(result.toISOString()).toBe("2025-01-26T06:00:00.000Z");
    });

    it("returns NEXT Sunday for Saturday events", () => {
      // CHANGED (was: same-week Sunday). A Saturday event's own Sunday is one
      // day away (1 < 2) — the settlement window does not meaningfully exist,
      // and the money is still `pending` in Stripe. Roll a week.
      const result = computePayoutDate(saturdayEvent, "WEEK_OF_EVENT");
      // Saturday Jan 18 -> Sunday Jan 26, midnight CST
      expect(result.toISOString()).toBe("2025-01-26T06:00:00.000Z");
    });

    it("keeps the same-week Sunday for Friday events (exactly 2 days does NOT roll)", () => {
      // Friday Jan 17 -> Sunday Jan 19. The comparison is `< 2`, and Friday is
      // exactly 2, so it does not roll and the organiser is not charged an
      // extra week. The Stripe availability floor covers the shortfall by
      // moving maturity to the Tuesday instead.
      const fridayEvent = new Date("2025-01-17T20:00:00-06:00");
      const result = computePayoutDate(fridayEvent, "WEEK_OF_EVENT");
      expect(result.toISOString()).toBe("2025-01-19T06:00:00.000Z");
    });

    it("resolves every weekday, Monday through Sunday", () => {
      // Mon 2025-01-13 … Sun 2025-01-19, each at 20:00 CST. Sundays are
      // 2025-01-19 and 2025-01-26 (midnight CST = 06:00Z).
      const thisSunday = "2025-01-19T06:00:00.000Z";
      const nextSunday = "2025-01-26T06:00:00.000Z";
      const cases: [day: string, weekday: string, expected: string][] = [
        ["13", "Monday", thisSunday],
        ["14", "Tuesday", thisSunday],
        ["15", "Wednesday", thisSunday],
        ["16", "Thursday", thisSunday],
        ["17", "Friday", thisSunday],
        ["18", "Saturday", nextSunday],
        ["19", "Sunday", nextSunday],
      ];
      for (const [day, weekday, expected] of cases) {
        const event = new Date(`2025-01-${day}T20:00:00-06:00`);
        expect(
          computePayoutDate(event, "WEEK_OF_EVENT").toISOString(),
          `${weekday} 2025-01-${day}`,
        ).toBe(expected);
      }
    });

    it("uses the event's America/Chicago weekday, not UTC", () => {
      // Sat 2025-01-18 23:00 CST is Sun 2025-01-19 05:00 UTC. Read as UTC it
      // would be a Sunday event; read in Central it is Saturday. Both roll to
      // Jan 26 here, so pin the Friday-night case where the two differ:
      // Fri 2025-01-17 23:00 CST = Sat 2025-01-18 05:00 UTC.
      const fridayNight = new Date("2025-01-18T05:00:00.000Z");
      expect(computePayoutDate(fridayNight, "WEEK_OF_EVENT").toISOString()).toBe(
        "2025-01-19T06:00:00.000Z",
      );
    });
  });

  describe("ONE_WEEK_AFTER", () => {
    it("returns Sunday one week after the event week", () => {
      const result = computePayoutDate(wednesdayEvent, "ONE_WEEK_AFTER");
      // Wednesday Jan 15 -> Sunday Jan 19 + 1 week = Sunday Jan 26
      expect(result.toISOString()).toBe("2025-01-26T06:00:00.000Z");
    });

    it("handles Sunday events correctly", () => {
      const result = computePayoutDate(sundayEvent, "ONE_WEEK_AFTER");
      // Sunday Jan 19 -> Sunday Jan 19 + 1 week = Sunday Jan 26
      expect(result.toISOString()).toBe("2025-01-26T06:00:00.000Z");
    });
  });

  describe("TWO_WEEKS_AFTER", () => {
    it("returns Sunday two weeks after the event week", () => {
      const result = computePayoutDate(wednesdayEvent, "TWO_WEEKS_AFTER");
      // Wednesday Jan 15 -> Sunday Jan 19 + 2 weeks = Sunday Feb 2
      expect(result.toISOString()).toBe("2025-02-02T06:00:00.000Z");
    });
  });

  describe("FOUR_WEEKS_AFTER", () => {
    it("returns Sunday four weeks after the event week (~1 month)", () => {
      const result = computePayoutDate(wednesdayEvent, "FOUR_WEEKS_AFTER");
      // Wednesday Jan 15 -> Sunday Jan 19 + 4 weeks = Sunday Feb 16
      expect(result.toISOString()).toBe("2025-02-16T06:00:00.000Z");
    });
  });
});

describe("getEffectiveSunday", () => {
  it("returns the same date if already Sunday", () => {
    const sunday = new Date("2025-01-19T12:00:00-06:00");
    const result = getEffectiveSunday(sunday);
    expect(result.toISOString()).toBe("2025-01-19T06:00:00.000Z");
  });

  it("returns next Sunday for weekday", () => {
    const wednesday = new Date("2025-01-15T12:00:00-06:00");
    const result = getEffectiveSunday(wednesday);
    expect(result.toISOString()).toBe("2025-01-19T06:00:00.000Z");
  });

  it("returns next Sunday for Saturday", () => {
    const saturday = new Date("2025-01-18T12:00:00-06:00");
    const result = getEffectiveSunday(saturday);
    expect(result.toISOString()).toBe("2025-01-19T06:00:00.000Z");
  });
});

describe("isPayoutDue", () => {
  it("returns true when payout date has passed", () => {
    const payoutDate = new Date("2025-01-19T06:00:00.000Z");
    const now = new Date("2025-01-20T12:00:00.000Z");
    expect(isPayoutDue(payoutDate, now)).toBe(true);
  });

  it("returns true when payout date equals now", () => {
    const payoutDate = new Date("2025-01-19T06:00:00.000Z");
    expect(isPayoutDue(payoutDate, payoutDate)).toBe(true);
  });

  it("returns false when payout date is in the future", () => {
    const payoutDate = new Date("2025-01-19T06:00:00.000Z");
    const now = new Date("2025-01-18T12:00:00.000Z");
    expect(isPayoutDue(payoutDate, now)).toBe(false);
  });
});

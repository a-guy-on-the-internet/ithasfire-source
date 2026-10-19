import { describe, expect, it } from "vitest";

import { addBusinessDays, isBusinessDay } from "./business-days";

/**
 * All expectations are pinned to absolute UTC instants, not re-derived from
 * the helper, so a change in the arithmetic has to be typed out to pass.
 *
 * America/Chicago offsets in play: CST = UTC-6 (midnight → 06:00Z),
 * CDT = UTC-5 (midnight → 05:00Z).
 */

describe("isBusinessDay", () => {
  it("is true Monday through Friday in America/Chicago", () => {
    // 2026-03-16 Mon … 2026-03-20 Fri
    for (const day of ["16", "17", "18", "19", "20"]) {
      expect(
        isBusinessDay(new Date(`2026-03-${day}T12:00:00-05:00`)),
      ).toBe(true);
    }
  });

  it("is false on Saturday and Sunday", () => {
    expect(isBusinessDay(new Date("2026-03-14T12:00:00-05:00"))).toBe(false);
    expect(isBusinessDay(new Date("2026-03-15T12:00:00-05:00"))).toBe(false);
  });

  it("judges the day in America/Chicago, not UTC", () => {
    // Fri 2026-03-13 23:00 CDT is Sat 2026-03-14 04:00 UTC. Central wins.
    expect(isBusinessDay(new Date("2026-03-14T04:00:00.000Z"))).toBe(true);
  });

  it("throws on an Invalid Date rather than reporting 'not a business day'", () => {
    // A silent `false` would read as "it's the weekend" and get acted on.
    // Match `addBusinessDays`, which throws on the same input.
    expect(() => isBusinessDay(new Date("nope"))).toThrow(/invalid date/i);
  });
});

describe("addBusinessDays", () => {
  describe("across a weekend (the Stripe day-0 rule)", () => {
    it("Friday night charge + 2 business days lands on Tuesday", () => {
      // Fri 2026-03-13 21:30 CDT. Day 0 = Friday → Mon, Tue.
      const result = addBusinessDays(
        new Date("2026-03-13T21:30:00-05:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-03-17T05:00:00.000Z");
    });

    it("Saturday night charge + 2 business days lands on Wednesday", () => {
      // Stripe: a weekend charge does not start counting until Monday, so
      // Monday is day 0 and the money is available Wednesday.
      const result = addBusinessDays(
        new Date("2026-03-14T23:00:00-05:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-03-18T05:00:00.000Z");
    });

    it("Sunday charge + 2 business days also lands on Wednesday", () => {
      const result = addBusinessDays(
        new Date("2026-03-15T14:00:00-05:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-03-18T05:00:00.000Z");
    });

    it("Thursday charge + 2 business days skips the weekend to Monday", () => {
      const result = addBusinessDays(
        new Date("2026-03-19T10:00:00-05:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-03-23T05:00:00.000Z");
    });

    it("counts business days, not calendar days (Fri + 4 = Thu, not Tue)", () => {
      const result = addBusinessDays(
        new Date("2026-03-13T21:30:00-05:00"),
        4,
      );
      expect(result.toISOString()).toBe("2026-03-19T05:00:00.000Z");
    });

    it("ACH from a Saturday charge (+4) lands on Friday", () => {
      const result = addBusinessDays(
        new Date("2026-03-14T23:00:00-05:00"),
        4,
      );
      expect(result.toISOString()).toBe("2026-03-20T05:00:00.000Z");
    });
  });

  describe("zero business days", () => {
    it("normalizes a weekday charge to midnight of that same day", () => {
      const result = addBusinessDays(
        new Date("2026-03-18T22:45:00-05:00"),
        0,
      );
      expect(result.toISOString()).toBe("2026-03-18T05:00:00.000Z");
    });

    it("rolls a weekend charge forward to the Monday (its day 0)", () => {
      const result = addBusinessDays(
        new Date("2026-03-14T23:00:00-05:00"),
        0,
      );
      expect(result.toISOString()).toBe("2026-03-16T05:00:00.000Z");
    });
  });

  describe("DST transitions in America/Chicago", () => {
    it("spans spring-forward (Sun 2026-03-08) without drifting a day", () => {
      // Fri 2026-03-06 (CST, UTC-6) + 2 business days = Mon, Tue →
      // Tue 2026-03-10, by which time Chicago is on CDT (UTC-5).
      // Epoch-millisecond arithmetic would land at 2026-03-10T06:00Z —
      // 01:00 local, the wrong instant for "midnight".
      const result = addBusinessDays(
        new Date("2026-03-06T20:00:00-06:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-03-10T05:00:00.000Z");
    });

    it("spans fall-back (Sun 2026-11-01) without drifting a day", () => {
      // Fri 2026-10-30 (CDT, UTC-5) + 2 business days = Mon, Tue →
      // Tue 2026-11-03, by which time Chicago is back on CST (UTC-6).
      const result = addBusinessDays(
        new Date("2026-10-30T20:00:00-05:00"),
        2,
      );
      expect(result.toISOString()).toBe("2026-11-03T06:00:00.000Z");
    });

    it("keeps every step at local midnight across spring-forward", () => {
      // Charge Wed 2026-03-04 (CST) + 3 business days walks Thu, Fri, Mon —
      // straight through the transition — and must land Mon 2026-03-09 CDT.
      const result = addBusinessDays(
        new Date("2026-03-04T12:00:00-06:00"),
        3,
      );
      expect(result.toISOString()).toBe("2026-03-09T05:00:00.000Z");
    });
  });

  describe("input guard", () => {
    it("rejects a negative count", () => {
      expect(() => addBusinessDays(new Date(), -1)).toThrow(
        /non-negative integer/,
      );
    });

    it("rejects a fractional count", () => {
      expect(() => addBusinessDays(new Date(), 1.5)).toThrow(
        /non-negative integer/,
      );
    });

    it("rejects an Invalid Date instead of looping forever", () => {
      // NaN weekdays fail both loop conditions, so the counting loop would
      // never terminate. This guard is load-bearing, not cosmetic.
      expect(() => addBusinessDays(new Date("nope"), 2)).toThrow(
        /invalid date/i,
      );
    });

    it("rejects an absurd count instead of spinning for hours", () => {
      // The loop walks one calendar day per iteration and this is exported
      // from the package barrel, so an unbounded count is a hang.
      expect(() => addBusinessDays(new Date("2026-03-16T10:00:00-05:00"), 1e9))
        .toThrow(/must be <= /);
    });

    it("still accepts a count at the cap", () => {
      // 2600 business days ≈ 10 years; must not be off-by-one at the boundary.
      expect(() =>
        addBusinessDays(new Date("2026-03-16T10:00:00-05:00"), 2600),
      ).not.toThrow();
    });
  });
});

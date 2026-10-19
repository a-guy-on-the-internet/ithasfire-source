import { describe, expect, it } from "vitest";

import { computePayoutDate } from "./compute-payout-date";
import {
  SETTLEMENT_FLOOR_BUSINESS_DAYS,
  applyAvailabilityFloor,
  computeAvailabilityFloor,
} from "./settlement-availability";

describe("SETTLEMENT_FLOOR_BUSINESS_DAYS", () => {
  it("is 2 business days", () => {
    expect(SETTLEMENT_FLOOR_BUSINESS_DAYS).toBe(2);
  });
});

describe("computeAvailabilityFloor", () => {
  it("a Saturday-night mint is available Wednesday", () => {
    // Sat 2026-03-14 23:00 CDT → Monday is day 0 → Wed 2026-03-18 midnight CT.
    expect(
      computeAvailabilityFloor(
        new Date("2026-03-14T23:00:00-05:00"),
      ).toISOString(),
    ).toBe("2026-03-18T05:00:00.000Z");
  });

  it("spans the spring-forward DST transition", () => {
    // Fri 2026-03-06 (CST) + 2 business days = Tue 2026-03-10 (CDT).
    expect(
      computeAvailabilityFloor(
        new Date("2026-03-06T21:00:00-06:00"),
      ).toISOString(),
    ).toBe("2026-03-10T05:00:00.000Z");
  });

  it("spans the fall-back DST transition", () => {
    // Fri 2026-10-30 (CDT) + 2 business days = Tue 2026-11-03 (CST).
    expect(
      computeAvailabilityFloor(
        new Date("2026-10-30T21:00:00-05:00"),
      ).toISOString(),
    ).toBe("2026-11-03T06:00:00.000Z");
  });
});

describe("applyAvailabilityFloor", () => {
  describe("advance sale — the floor must be a no-op", () => {
    it("leaves an ASAP schedule three weeks out untouched", () => {
      // Ticket sold Mon 2026-02-23; event Wed 2026-03-11 → ASAP matures
      // Thu 2026-03-12. The floor is Wed 2026-02-25 — far behind it.
      const chargedAt = new Date("2026-02-23T15:00:00-06:00");
      const scheduled = computePayoutDate(
        new Date("2026-03-11T20:00:00-05:00"),
        "ASAP",
      );
      expect(scheduled.toISOString()).toBe("2026-03-12T05:00:00.000Z");

      const result = applyAvailabilityFloor(scheduled, chargedAt);
      expect(result).toBe(scheduled); // identity: not even a new Date
      expect(result.toISOString()).toBe("2026-03-12T05:00:00.000Z");
    });
  });

  describe("door sale — the floor must move it", () => {
    it("Saturday-night door sale on ASAP moves from Sunday to Wednesday", () => {
      // Event ends Sat 2026-03-14 23:00 CDT; the buyer paid at the door, so
      // the charge is the same instant. ASAP schedules Sun 2026-03-15 — the
      // Monday batch would try to transfer money still sitting in `pending`.
      const doorSaleAt = new Date("2026-03-14T23:00:00-05:00");
      const scheduled = computePayoutDate(doorSaleAt, "ASAP");
      expect(scheduled.toISOString()).toBe("2026-03-15T05:00:00.000Z");

      const result = applyAvailabilityFloor(scheduled, doorSaleAt);
      expect(result.toISOString()).toBe("2026-03-18T05:00:00.000Z");
      expect(result.getTime()).toBeGreaterThan(scheduled.getTime());
    });

    it("Friday-night door sale on WEEK_OF_EVENT moves from Sunday to Tuesday", () => {
      // Fri 2026-03-13 event: the WEEK_OF_EVENT Sunday is exactly 2 days out
      // so the schedule does NOT roll a week — the floor covers it instead,
      // at a two-day cost rather than a seven-day one.
      const doorSaleAt = new Date("2026-03-13T22:00:00-05:00");
      const scheduled = computePayoutDate(doorSaleAt, "WEEK_OF_EVENT");
      expect(scheduled.toISOString()).toBe("2026-03-15T05:00:00.000Z");

      expect(applyAvailabilityFloor(scheduled, doorSaleAt).toISOString()).toBe(
        "2026-03-17T05:00:00.000Z",
      );
    });
  });

  it("is exactly max(): equal instants return the schedule", () => {
    const chargedAt = new Date("2026-03-16T10:00:00-05:00"); // Mon
    const floor = computeAvailabilityFloor(chargedAt); // Wed 03-18
    expect(
      applyAvailabilityFloor(new Date(floor.getTime()), chargedAt).toISOString(),
    ).toBe(floor.toISOString());
  });

  it("never returns anything earlier than the floor, for any weekday charge", () => {
    // Property sweep over a full week of charges against an already-past
    // schedule: the result is always at or after the floor.
    //
    // Mon 2026-03-09 … Sun 2026-03-15. Days are zero-padded: an unpadded
    // "2026-03-9" is an Invalid Date, which used to hang `addBusinessDays`.
    const scheduled = new Date("2020-01-01T00:00:00.000Z");
    for (const day of ["09", "10", "11", "12", "13", "14", "15"]) {
      const chargedAt = new Date(`2026-03-${day}T18:00:00-05:00`);
      expect(Number.isNaN(chargedAt.getTime())).toBe(false);
      const floor = computeAvailabilityFloor(chargedAt);
      const result = applyAvailabilityFloor(scheduled, chargedAt);
      expect(result.getTime()).toBe(floor.getTime());
      expect(result.getTime()).toBeGreaterThan(chargedAt.getTime());
    }
  });

  it("throws on an invalid scheduled date rather than silently returning the floor", () => {
    // NaN >= floor is false, so an unguarded max() would hand back a
    // plausible-looking date instead of failing.
    expect(() =>
      applyAvailabilityFloor(new Date("nope"), new Date("2026-03-16T10:00:00-05:00")),
    ).toThrow(/scheduledPayoutDate is invalid/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultChallengeDeadline,
  fromDateTimeLocalValue,
  holdCountdown,
  holdDateFromPreferred,
  holdPositionKey,
  isChallengeDeadlineTooLate,
  isChallengeDeadlineValid,
  isExtendDeadlineValid,
  liveHolds,
  MAX_CHALLENGE_WINDOW_MS,
  maxChallengeDeadline,
  toDateTimeLocalValue,
  type BookingHoldSummary,
} from "../booking-holds";

const NOW = new Date("2026-10-12T12:00:00.000Z");

const hold = (over: Partial<BookingHoldSummary> = {}): BookingHoldSummary => ({
  id: "h1",
  calendarId: "c1",
  date: "2026-10-13",
  position: 1,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  ...over,
});

describe("liveHolds", () => {
  it("keeps ACTIVE and non-lapsed CHALLENGED, drops the rest", () => {
    const rows = [
      hold({ id: "a", status: "RELEASED" }),
      hold({ id: "b", status: "CHALLENGED", respondBy: NOW, lapsed: true }),
      hold({ id: "c", status: "CONFIRMED" }),
      hold({ id: "d", status: "CHALLENGED", respondBy: NOW }),
      hold({ id: "e" }),
    ];
    expect(liveHolds(rows).map((h) => h.id)).toEqual(["d", "e"]);
  });

  it("orders by date, then by position within the date", () => {
    const rows = [
      hold({ id: "late", date: "2026-11-01", position: 1 }),
      hold({ id: "second", date: "2026-10-13", position: 2 }),
      hold({ id: "first", date: "2026-10-13", position: 1 }),
    ];
    expect(liveHolds(rows).map((h) => h.id)).toEqual(["first", "second", "late"]);
  });
});

describe("holdPositionKey", () => {
  it("names 1st/2nd/3rd, then the generic key", () => {
    expect(holdPositionKey(1)).toBe("admin.bkHoldPosition1");
    expect(holdPositionKey(2)).toBe("admin.bkHoldPosition2");
    expect(holdPositionKey(3)).toBe("admin.bkHoldPosition3");
    expect(holdPositionKey(4)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(11)).toBe("admin.bkHoldPositionNth");
  });

  it("picks the CLDR ordinal category past 3 — 21st, 22nd, 23rd, 24th, never 21th", () => {
    expect(holdPositionKey(21)).toBe("admin.bkHoldPositionNthOne");
    expect(holdPositionKey(22)).toBe("admin.bkHoldPositionNthTwo");
    expect(holdPositionKey(23)).toBe("admin.bkHoldPositionNthFew");
    expect(holdPositionKey(24)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(12)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(13)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(101)).toBe("admin.bkHoldPositionNthOne");
    expect(holdPositionKey(111)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(112)).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(113)).toBe("admin.bkHoldPositionNth");
  });

  it("Spanish has one ordinal form, so every position past 3 is the generic key", () => {
    expect(holdPositionKey(21, "es")).toBe("admin.bkHoldPositionNth");
    expect(holdPositionKey(22, "es")).toBe("admin.bkHoldPositionNth");
  });

  it("an unknown locale tag falls back to the generic key rather than throwing", () => {
    expect(holdPositionKey(21, "not-a-locale-!!")).toBe("admin.bkHoldPositionNth");
  });
});

describe("holdCountdown", () => {
  it("is null unless the hold is challenged with a deadline", () => {
    expect(holdCountdown(hold(), NOW)).toBeNull();
    expect(holdCountdown(hold({ status: "CHALLENGED", respondBy: null }), NOW)).toBeNull();
  });

  it("trusts the server's lapsed projection over local arithmetic", () => {
    const future = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(
      holdCountdown(hold({ status: "CHALLENGED", respondBy: future, lapsed: true }), NOW),
    ).toEqual({ kind: "lapsed" });
  });

  it("reports whole hours above an hour, minutes below, lapsed at zero", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(holdCountdown(hold({ status: "CHALLENGED", respondBy: at(23.5 * 3_600_000) }), NOW))
      .toEqual({ kind: "hours", hours: 23 });
    expect(holdCountdown(hold({ status: "CHALLENGED", respondBy: at(59 * 60_000) }), NOW))
      .toEqual({ kind: "minutes", minutes: 59 });
    expect(holdCountdown(hold({ status: "CHALLENGED", respondBy: at(0) }), NOW))
      .toEqual({ kind: "lapsed" });
    expect(holdCountdown(hold({ status: "CHALLENGED", respondBy: at(-1) }), NOW))
      .toEqual({ kind: "lapsed" });
  });
});

describe("challenge deadline", () => {
  it("defaults to now + 24h and floors at now + 1h", () => {
    expect(defaultChallengeDeadline(NOW).getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    expect(isChallengeDeadlineValid(new Date(NOW.getTime() + 3_600_000), NOW)).toBe(true);
    expect(isChallengeDeadlineValid(new Date(NOW.getTime() + 3_599_000), NOW)).toBe(false);
    expect(isChallengeDeadlineValid(new Date(NaN), NOW)).toBe(false);
  });

  it("caps a challenge's deadline at 30 days out; an extend has no ceiling", () => {
    const thirtyDays = NOW.getTime() + MAX_CHALLENGE_WINDOW_MS;
    expect(MAX_CHALLENGE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(isChallengeDeadlineValid(new Date(thirtyDays), NOW)).toBe(true);
    expect(isChallengeDeadlineValid(new Date(thirtyDays + 1000), NOW)).toBe(false);
    expect(isChallengeDeadlineTooLate(new Date(thirtyDays + 1000), NOW)).toBe(true);
    expect(isChallengeDeadlineTooLate(new Date(thirtyDays), NOW)).toBe(false);
    expect(maxChallengeDeadline(NOW).getTime()).toBe(thirtyDays);
    expect(isExtendDeadlineValid(new Date(thirtyDays + 365 * 86_400_000), NOW)).toBe(true);
    expect(isExtendDeadlineValid(new Date(NOW.getTime() + 3_599_000), NOW)).toBe(false);
  });

  it("round-trips a datetime-local value in the viewer's zone", () => {
    const local = new Date(2026, 9, 13, 18, 30);
    const value = toDateTimeLocalValue(local);
    expect(value).toBe("2026-10-13T18:30");
    expect(fromDateTimeLocalValue(value)?.getTime()).toBe(local.getTime());
    expect(fromDateTimeLocalValue("garbage")).toBeNull();
    expect(fromDateTimeLocalValue("2026-13-45T99:99")).toBeNull();
  });
});

describe("holdDateFromPreferred", () => {
  it("drops the wall clock and rejects anything that is not a date", () => {
    expect(holdDateFromPreferred("2026-10-13")).toBe("2026-10-13");
    expect(holdDateFromPreferred("2026-10-13T21:00")).toBe("2026-10-13");
    expect(holdDateFromPreferred("next friday")).toBeNull();
    expect(holdDateFromPreferred("")).toBeNull();
  });
});

// The Challenge form shows and reads its deadline in the VIEWER's zone, the
// same zone the strip's "Reply by …" label formats in. Pinned in a non-UTC zone
// so a UTC runner cannot hide an offset bug, and across both 2026 DST edges.
describe("challenge deadline in a non-UTC zone (America/Chicago)", () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Chicago";
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("is really running in Chicago (guards the rest of this block)", () => {
    expect(new Date("2026-01-15T12:00:00.000Z").getTimezoneOffset()).toBe(360);
    expect(new Date("2026-07-15T12:00:00.000Z").getTimezoneOffset()).toBe(300);
  });

  it("shows and reads back the wall clock, not UTC, across a UTC date line", () => {
    // 19:30 CDT on Sep 30 is 00:30 UTC on Oct 1.
    const instant = new Date("2026-10-01T00:30:00.000Z");
    expect(toDateTimeLocalValue(instant)).toBe("2026-09-30T19:30");
    expect(fromDateTimeLocalValue("2026-09-30T19:30")?.toISOString()).toBe(
      "2026-10-01T00:30:00.000Z",
    );
  });

  it("fall back: the repeated 01:30 reads as its FIRST occurrence (CDT)", () => {
    const cdt = new Date("2026-11-01T06:30:00.000Z");
    const cst = new Date("2026-11-01T07:30:00.000Z");
    expect(toDateTimeLocalValue(cdt)).toBe("2026-11-01T01:30");
    expect(toDateTimeLocalValue(cst)).toBe("2026-11-01T01:30");
    expect(fromDateTimeLocalValue("2026-11-01T01:30")?.toISOString()).toBe(cdt.toISOString());
  });

  it("spring forward: the skipped 02:30 resolves forward to 03:30 CDT, never null", () => {
    const read = fromDateTimeLocalValue("2026-03-08T02:30");
    expect(read?.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    expect(toDateTimeLocalValue(read!)).toBe("2026-03-08T03:30");
  });

  it("the default deadline round-trips to the minute over a DST change", () => {
    // Opened 18:05:42 CDT the evening before fall-back; +24h crosses it.
    const opened = new Date("2026-10-31T23:05:42.000Z");
    const value = toDateTimeLocalValue(defaultChallengeDeadline(opened));
    expect(value).toBe("2026-11-01T17:05");
    expect(fromDateTimeLocalValue(value)?.toISOString()).toBe("2026-11-01T23:05:00.000Z");
  });
});

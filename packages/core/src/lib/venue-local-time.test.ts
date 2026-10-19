import { describe, expect, it } from "vitest";

import {
  DEFAULT_VENUE_TIMEZONE,
  addLocalDays,
  isValidTimeZone,
  localDateRange,
  localDayOfWeek,
  resolveTimeZone,
  toLocalParts,
} from "./venue-local-time";

describe("toLocalParts", () => {
  it("keeps a late show on the night it actually happened", () => {
    // 9pm in Austin on 22 Aug is already 23 Aug in UTC. Bucketing by the UTC
    // date would mark the wrong night as booked.
    const instant = new Date("2026-08-23T02:00:00.000Z");
    expect(toLocalParts(instant, "America/Chicago")).toEqual({
      date: "2026-08-22",
      minutes: 21 * 60,
    });
  });

  it("reads midnight as 00:00 of that date, never 24:00", () => {
    const instant = new Date("2026-08-22T05:00:00.000Z"); // 00:00 CDT
    expect(toLocalParts(instant, "America/Chicago")).toEqual({
      date: "2026-08-22",
      minutes: 0,
    });
  });

  it("follows the zone, not the server", () => {
    const instant = new Date("2026-08-22T02:00:00.000Z");
    expect(toLocalParts(instant, "UTC").date).toBe("2026-08-22");
    expect(toLocalParts(instant, "America/Los_Angeles").date).toBe("2026-08-21");
  });

  it("handles a winter instant on the other side of DST", () => {
    // 8pm CST on 5 Jan is 02:00 UTC the next day.
    const instant = new Date("2026-01-06T02:00:00.000Z");
    expect(toLocalParts(instant, "America/Chicago")).toEqual({
      date: "2026-01-05",
      minutes: 20 * 60,
    });
  });
});

describe("resolveTimeZone", () => {
  it("falls back for null, empty and nonsense zones", () => {
    expect(resolveTimeZone(null)).toBe(DEFAULT_VENUE_TIMEZONE);
    expect(resolveTimeZone("")).toBe(DEFAULT_VENUE_TIMEZONE);
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_VENUE_TIMEZONE);
  });

  it("keeps a real zone", () => {
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("recognises valid zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Nowhere/Nothing")).toBe(false);
  });
});

describe("addLocalDays / localDateRange", () => {
  it("steps across a month boundary", () => {
    expect(addLocalDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addLocalDays("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("survives a spring-forward date without losing a day", () => {
    // 8 Mar 2026 is the US DST switch; a naive local-midnight + 24h lands back
    // on the same date.
    expect(addLocalDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("builds an inclusive range", () => {
    expect(localDateRange("2026-08-30", 4)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("localDayOfWeek", () => {
  it("returns 0 for Sunday through 6 for Saturday", () => {
    expect(localDayOfWeek("2026-08-16")).toBe(0); // Sunday
    expect(localDayOfWeek("2026-08-17")).toBe(1);
    expect(localDayOfWeek("2026-08-22")).toBe(6); // Saturday
  });
});

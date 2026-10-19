import { describe, expect, it } from "vitest";

import { dayKey, zonedInstant } from "../helpers";
import { cellPrefillWallClock, sameRange, visibleRangeFor } from "../range";

const TZ = "America/Chicago";
const at = (m: number, d: number, h: number, min = 0) => zonedInstant(2026, m, d, h, min, TZ);

describe("visibleRangeFor", () => {
  it("month: the 42-cell grid span in the paint zone", () => {
    const { from, to } = visibleRangeFor("month", at(9, 15, 12), TZ);
    // September 2026 starts on a Tuesday → grid opens Sunday Aug 30.
    expect(dayKey(from, TZ)).toBe("2026-08-30");
    expect(from).toEqual(at(8, 30, 0));
    // 42 cells → the day after Sat Oct 10, exclusive.
    expect(to).toEqual(at(10, 11, 0));
  });

  it("week: Sunday 00:00 through the following Sunday 00:00", () => {
    const { from, to } = visibleRangeFor("week", at(9, 2, 12), TZ);
    expect(from).toEqual(at(8, 30, 0));
    expect(to).toEqual(at(9, 6, 0));
  });

  it("agenda: the anchor's day through the page end's day", () => {
    const { from, to } = visibleRangeFor("agenda", at(9, 2, 15), TZ, at(10, 2, 9));
    expect(from).toEqual(at(9, 2, 0));
    expect(to).toEqual(at(10, 3, 0));
  });

  it("agenda defaults to a 30-day page", () => {
    const { to } = visibleRangeFor("agenda", at(9, 2, 15), TZ);
    expect(dayKey(to, TZ)).toBe("2026-10-03");
  });

  it("sameRange compares instants", () => {
    const a = visibleRangeFor("week", at(9, 2, 12), TZ);
    const b = visibleRangeFor("week", at(9, 4, 8), TZ);
    expect(sameRange(a, b)).toBe(true);
    expect(sameRange(null, b)).toBe(false);
    expect(sameRange(a, visibleRangeFor("week", at(9, 9, 12), TZ))).toBe(false);
  });
});

describe("cellPrefillWallClock", () => {
  it("reads the wall clock in the PAINT zone, not the runner's", () => {
    expect(cellPrefillWallClock(at(9, 5, 20, 30), TZ, { dateOnly: false })).toBe(
      "2026-09-05T20:30",
    );
    // The same instant painted in Tokyo is the next morning there.
    expect(cellPrefillWallClock(at(9, 5, 20, 30), "Asia/Tokyo", { dateOnly: false })).toBe(
      "2026-09-06T10:30",
    );
  });

  it("date-only cells take the calendar default or the evening fallback", () => {
    expect(
      cellPrefillWallClock(at(9, 5, 0), TZ, { dateOnly: true, defaultStartTime: "21:15" }),
    ).toBe("2026-09-05T21:15");
    expect(cellPrefillWallClock(at(9, 5, 0), TZ, { dateOnly: true })).toBe("2026-09-05T19:00");
    expect(
      cellPrefillWallClock(at(9, 5, 0), TZ, { dateOnly: true, defaultStartTime: "9pm" }),
    ).toBe("2026-09-05T19:00");
  });
});

import { describe, expect, it } from "vitest";

import { isoDateToLocal } from "../booking-requests";

/**
 * Regression cover for the crash this helper shipped: `preferredDates` entries
 * are `YYYY-MM-DD` OR `YYYY-MM-DDTHH:MM` (`bookingPreferredDateSchema`), and
 * the timed form used to become `"…T21:00T00:00:00"` → Invalid Date → a
 * `RangeError: Invalid time value` out of `Intl` on every surface that lists
 * them.
 */
describe("isoDateToLocal", () => {
  it("parses a date-only entry at LOCAL midnight (no UTC day shift)", () => {
    const d = isoDateToLocal("2026-11-13");
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10); // November
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(0);
  });

  it("parses a TIMED entry to the same local midnight instead of Invalid Date", () => {
    const d = isoDateToLocal("2026-11-13T21:00");
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.getTime()).toBe(isoDateToLocal("2026-11-13").getTime());
    // The formatting call sites all use `dateStyle` only — this is the thing
    // that used to throw.
    expect(() =>
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d),
    ).not.toThrow();
  });

  it("still yields an Invalid Date for an unparseable entry", () => {
    expect(Number.isNaN(isoDateToLocal("not-a-date").getTime())).toBe(true);
  });
});

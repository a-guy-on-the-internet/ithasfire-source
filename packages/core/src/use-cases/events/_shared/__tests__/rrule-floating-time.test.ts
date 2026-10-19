import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dateTimeToFloating,
  floatingToInstant,
  instantToFloating,
  wallTimeToFloating,
} from "../rrule-floating-time";

/**
 * Direct unit coverage of the floating-wall-clock conversions. These are also
 * exercised end-to-end through `expand-recurrence.test.ts`, but the DST
 * tie-breaks are the whole reason this module exists, so they are pinned here
 * without routing through the `rrule` package.
 */

/** A floating Date carrying the given wall clock in its UTC fields. */
const floating = (
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));

const CHICAGO = "America/Chicago";
const SYDNEY = "Australia/Sydney";

describe("instantToFloating", () => {
  it("stamps the zone's wall clock into the UTC fields", () => {
    // 2026-09-05T01:00Z is Fri 2026-09-04 20:00 in Chicago.
    expect(
      instantToFloating(new Date("2026-09-05T01:00:00.000Z"), CHICAGO),
    ).toEqual(floating(2026, 9, 4, 20));
  });

  it("is a no-op for UTC", () => {
    const instant = new Date("2026-09-05T01:00:00.000Z");
    expect(instantToFloating(instant, "UTC")).toEqual(instant);
  });

  it("returns null for a missing instant or an unknown zone", () => {
    expect(instantToFloating(null, CHICAGO)).toBeNull();
    expect(instantToFloating(undefined, CHICAGO)).toBeNull();
    expect(
      instantToFloating(new Date("2026-09-05T01:00:00.000Z"), "Mars/Olympus"),
    ).toBeNull();
  });
});

describe("wallTimeToFloating / dateTimeToFloating", () => {
  it("reads a wall-time string as the zone's clock, not as an instant", () => {
    expect(wallTimeToFloating("2026-09-04T20:00:00", CHICAGO)).toEqual(
      floating(2026, 9, 4, 20),
    );
  });

  it("returns null for an unparseable value", () => {
    expect(wallTimeToFloating("not-a-date", CHICAGO)).toBeNull();
    expect(
      dateTimeToFloating(DateTime.fromISO("nope", { zone: CHICAGO })),
    ).toBeNull();
  });
});

describe("floatingToInstant — round trip", () => {
  it("inverts instantToFloating away from any transition", () => {
    const instant = new Date("2026-09-05T01:00:00.000Z");
    const round = floatingToInstant(instantToFloating(instant, CHICAGO)!, CHICAGO);
    expect(round?.toISOString()).toBe(instant.toISOString());
  });

  it("carries seconds and milliseconds through", () => {
    expect(
      floatingToInstant(floating(2026, 9, 4, 20, 30, 45, 123), CHICAGO)
        ?.toISOString(),
    ).toBe("2026-09-05T01:30:45.123Z");
  });

  it("returns null for an unknown zone or an invalid input", () => {
    expect(floatingToInstant(floating(2026, 9, 4, 20), "Mars/Olympus")).toBeNull();
    expect(floatingToInstant(new Date(NaN), CHICAGO)).toBeNull();
  });
});

describe("floatingToInstant — fall-back overlap picks the EARLIER offset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 01:30 on Sun 2026-11-01 happens TWICE in Chicago: once at CDT (-5,
  // 06:30Z) and again at CST (-6, 07:30Z). The tie-break is the earlier one.
  const AMBIGUOUS_CHICAGO = floating(2026, 11, 1, 1, 30);

  it("takes the earlier of the two candidates", () => {
    expect(floatingToInstant(AMBIGUOUS_CHICAGO, CHICAGO)?.toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("gives the same answer whatever the process clock says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z")); // CDT
    const summer = floatingToInstant(AMBIGUOUS_CHICAGO, CHICAGO)?.toISOString();
    vi.setSystemTime(new Date("2027-01-15T12:00:00.000Z")); // CST
    const winter = floatingToInstant(AMBIGUOUS_CHICAGO, CHICAGO)?.toISOString();
    expect(summer).toBe(winter);
    expect(summer).toBe("2026-11-01T06:30:00.000Z");
  });

  it("holds in the southern hemisphere too", () => {
    // Sydney's DST ends Sun 2026-04-05: 03:00 AEDT (+11) -> 02:00 AEST (+10),
    // so 02:30 happens twice. Earlier = AEDT = 2026-04-04T15:30Z.
    const ambiguous = floating(2026, 4, 5, 2, 30);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z")); // AEDT
    const a = floatingToInstant(ambiguous, SYDNEY)?.toISOString();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z")); // AEST
    const b = floatingToInstant(ambiguous, SYDNEY)?.toISOString();
    expect(a).toBe(b);
    expect(a).toBe("2026-04-04T15:30:00.000Z");
  });
});

describe("floatingToInstant — spring-forward gap falls through", () => {
  it("shifts a nonexistent Chicago time forward past the gap", () => {
    // 02:30 on Sun 2026-03-08 never happens (02:00 -> 03:00). Falling through
    // to the pre-transition offset (CST, -6) yields 08:30Z, which reads back
    // as 03:30 CDT — one transition-step later, never an Invalid Date.
    const instant = floatingToInstant(floating(2026, 3, 8, 2, 30), CHICAGO);
    expect(instant?.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    expect(
      DateTime.fromJSDate(instant!).setZone(CHICAGO).toFormat("HH:mm"),
    ).toBe("03:30");
  });

  it("shifts a nonexistent Sydney time forward past the gap", () => {
    // Sydney's DST starts Sun 2026-10-04: 02:00 AEST -> 03:00 AEDT, so 02:30
    // never happens. Pre-transition offset is +10 -> 2026-10-03T16:30Z.
    const instant = floatingToInstant(floating(2026, 10, 4, 2, 30), SYDNEY);
    expect(instant?.toISOString()).toBe("2026-10-03T16:30:00.000Z");
    expect(
      DateTime.fromJSDate(instant!).setZone(SYDNEY).toFormat("HH:mm"),
    ).toBe("03:30");
  });
});

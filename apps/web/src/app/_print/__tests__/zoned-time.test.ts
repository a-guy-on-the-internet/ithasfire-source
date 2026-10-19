import { describe, expect, it } from "vitest";

import { isSameZonedDay, resolveDisplayTimeZone } from "../zoned-time";

/**
 * Shared by the volunteer badge sheet and the volunteer's own check-in code.
 * Both print a shift window in the VENUE's zone and name that zone, so the two
 * documents have to agree about where a day ends — a screen re-renders when
 * the reader moves, paper does not.
 */

describe("resolveDisplayTimeZone", () => {
  it("passes a real IANA zone through", () => {
    expect(resolveDisplayTimeZone("America/Chicago")).toBe("America/Chicago");
  });

  it("degrades to the viewer's zone rather than throwing on a bad identifier", () => {
    // `Intl.DateTimeFormat` THROWS a RangeError on an unknown zone, and these
    // values are free-form data we did not mint. One bad row would otherwise
    // take a whole badge run — or a volunteer's only copy of their code —
    // down on a show night.
    expect(resolveDisplayTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(resolveDisplayTimeZone(null)).toBeUndefined();
    expect(resolveDisplayTimeZone(undefined)).toBeUndefined();
    expect(resolveDisplayTimeZone("")).toBeUndefined();
  });
});

describe("isSameZonedDay", () => {
  it("answers in the VENUE's zone, not the runner's", () => {
    // 22:00 and 02:00 UTC are different UTC days, but in Chicago they are
    // 17:00 and 21:00 on the SAME evening — which is the day the volunteer is
    // expected, and the one the paper has to print.
    const start = new Date("2026-08-14T22:00:00Z");
    const end = new Date("2026-08-15T02:00:00Z");

    expect(isSameZonedDay(start, end, "America/Chicago")).toBe(true);
    expect(isSameZonedDay(start, end, "UTC")).toBe(false);
  });

  it("detects a genuine overnight shift so the document can repeat the date", () => {
    const start = new Date("2026-08-14T23:00:00Z"); // 18:00 Chicago
    const end = new Date("2026-08-15T07:00:00Z"); // 02:00 Chicago, next day

    expect(isSameZonedDay(start, end, "America/Chicago")).toBe(false);
  });

  it("falls back to the runtime zone when none is given", () => {
    const a = new Date("2026-08-14T10:00:00Z");
    const b = new Date("2026-08-14T11:00:00Z");

    expect(isSameZonedDay(a, b, undefined)).toBe(true);
  });
});

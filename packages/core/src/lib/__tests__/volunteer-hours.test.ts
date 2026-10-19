/**
 * The ONE hours-crediting rule. Imported through the `@th/core` entry
 * point rather than `@th/types` directly, so this also pins that the
 * re-export is wired (the adapter imports the same functions from
 * `@th/types/volunteer-hours`).
 *
 * Deliberately tested here rather than in `packages/types/src/__tests__`:
 * the core suite is known to run, and this rule feeds a printable hours
 * statement volunteers submit for school service credit and grant
 * reporting.
 */
import { describe, expect, it } from "vitest";

import { creditedHours, scheduledHoursBetween } from "../volunteer-hours";

const at = (iso: string) => new Date(iso);

describe("scheduledHoursBetween", () => {
  it("returns the duration in hours", () => {
    expect(
      scheduledHoursBetween(at("2026-07-01T09:00:00Z"), at("2026-07-01T13:00:00Z")),
    ).toBe(4);
  });

  it("rounds to 2dp", () => {
    // 2h 20m 10s = 2.336111… hours
    expect(
      scheduledHoursBetween(at("2026-07-01T09:00:00Z"), at("2026-07-01T11:20:10Z")),
    ).toBe(2.34);
  });

  it("returns null when either bound is missing", () => {
    expect(scheduledHoursBetween(null, at("2026-07-01T13:00:00Z"))).toBeNull();
    expect(scheduledHoursBetween(at("2026-07-01T09:00:00Z"), null)).toBeNull();
    expect(scheduledHoursBetween(null, null)).toBeNull();
    expect(scheduledHoursBetween(undefined, undefined)).toBeNull();
  });
});

describe("creditedHours", () => {
  it("derives from the window when there is no override — null is NOT zero", () => {
    expect(
      creditedHours(null, at("2026-08-15T21:00:00Z"), at("2026-08-16T01:00:00Z")),
    ).toBe(4);
  });

  it("lets the override win over a derivable duration", () => {
    expect(
      creditedHours(2.5, at("2026-07-01T09:00:00Z"), at("2026-07-01T13:00:00Z")),
    ).toBe(2.5);
  });

  it("honours a legitimate ZERO override instead of falling through to the duration", () => {
    // `?? ` not `||`: a volunteer marked as having worked 0 hours must not
    // silently be credited with the full scheduled shift.
    expect(
      creditedHours(0, at("2026-07-01T09:00:00Z"), at("2026-07-01T13:00:00Z")),
    ).toBe(0);
  });

  it("returns null when there is neither an override nor a window", () => {
    expect(creditedHours(null, null, null)).toBeNull();
  });

  it("returns the override when there is no window to derive from", () => {
    expect(creditedHours(3, null, null)).toBe(3);
  });
});

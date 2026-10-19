import { describe, expect, it } from "vitest";

import {
  formatEventDate,
  formatEventTimeRange,
  formatEventDateShort,
} from "../format-event-date";

// Fixed dates for deterministic tests (no time-zone-sensitive assertions on
// formatted calendar names — those vary by Node/ICU version).  We just check
// that output is non-empty, contains expected substrings, and that options are
// respected.

const START = "2025-09-20T18:00:00.000Z"; // Sat Sep 20 2025, 6 PM UTC
const END_SAME_DAY = "2025-09-20T23:00:00.000Z"; // 11 PM UTC
const END_NEXT_DAY = "2025-09-21T02:00:00.000Z"; // Sun Sep 21 2025, 2 AM UTC

describe("formatEventDate", () => {
  it("formats an ISO string with defaults", () => {
    const result = formatEventDate(START);
    expect(result).toBeTruthy();
    // Should contain "2025" somewhere (year)
    expect(result).toContain("2025");
  });

  it("formats a Date object", () => {
    const result = formatEventDate(new Date(START));
    expect(result).toContain("2025");
  });

  it("formats a numeric timestamp", () => {
    const result = formatEventDate(new Date(START).getTime());
    expect(result).toContain("2025");
  });

  it("respects locale", () => {
    const en = formatEventDate(START, { locale: "en-US" });
    const es = formatEventDate(START, { locale: "es-ES" });
    // Both should contain 2025 but differ in text
    expect(en).toContain("2025");
    expect(es).toContain("2025");
    expect(en).not.toBe(es);
  });

  it("respects timeZone", () => {
    const utc = formatEventDate(START, { timeZone: "UTC" });
    const la = formatEventDate(START, { timeZone: "America/Los_Angeles" });
    // Same instant formatted differently
    expect(utc).not.toBe(la);
  });

  it("falls back gracefully on invalid timeZone", () => {
    // Should not throw
    const result = formatEventDate(START, { timeZone: "Not/A/Zone" });
    expect(result).toBeTruthy();
    expect(result).toContain("2025");
  });
});

describe("formatEventTimeRange", () => {
  it("returns a single date when endsAt is absent", () => {
    const result = formatEventTimeRange(START);
    expect(result).toContain("2025");
    expect(result).not.toContain("\u2013");
  });

  it("returns a single date when endsAt is null", () => {
    const result = formatEventTimeRange(START, null);
    expect(result).not.toContain("\u2013");
  });

  it("collapses same-day range by default", () => {
    const result = formatEventTimeRange(START, END_SAME_DAY, {
      timeZone: "UTC",
    });
    // Should have an en-dash separator
    expect(result).toContain("\u2013");
    // The end portion should NOT repeat the full date (just a time)
    // Count "2025" occurrences — should be exactly 1
    const yearMatches = result.match(/2025/g);
    expect(yearMatches).toHaveLength(1);
  });

  it("shows full dates for multi-day range", () => {
    const result = formatEventTimeRange(START, END_NEXT_DAY, {
      timeZone: "UTC",
    });
    expect(result).toContain("\u2013");
    // Both dates should appear
    const yearMatches = result.match(/2025/g);
    expect(yearMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("can be told not to collapse same-day", () => {
    const result = formatEventTimeRange(START, END_SAME_DAY, {
      timeZone: "UTC",
      collapseSameDay: false,
    });
    // Should show full dates for both
    const yearMatches = result.match(/2025/g);
    expect(yearMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("respects timezone when determining same-day", () => {
    // END_NEXT_DAY is 2 AM UTC on Sep 21 — still Sep 20 in LA (PDT = UTC-7)
    const laResult = formatEventTimeRange(START, END_NEXT_DAY, {
      timeZone: "America/Los_Angeles",
    });
    // In LA these are the same calendar day, so should collapse
    const laYears = laResult.match(/2025/g);
    expect(laYears).toHaveLength(1);

    // In UTC they're different days
    const utcResult = formatEventTimeRange(START, END_NEXT_DAY, {
      timeZone: "UTC",
    });
    const utcYears = utcResult.match(/2025/g);
    expect(utcYears!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatEventDateShort", () => {
  it("formats a compact date string", () => {
    const result = formatEventDateShort(START, { timeZone: "UTC" });
    expect(result).toBeTruthy();
    // Should contain abbreviated month and day
    expect(result).toMatch(/Sep/i);
    expect(result).toContain("20");
  });

  it("includes day of week abbreviation", () => {
    const result = formatEventDateShort(START, {
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(result).toMatch(/Sat/i);
  });

  it("respects locale", () => {
    const en = formatEventDateShort(START, {
      locale: "en-US",
      timeZone: "UTC",
    });
    const es = formatEventDateShort(START, {
      locale: "es-ES",
      timeZone: "UTC",
    });
    expect(en).not.toBe(es);
  });

  it("falls back on invalid timeZone", () => {
    const result = formatEventDateShort(START, { timeZone: "Bad/Zone" });
    expect(result).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATE_PRESET_ORDER,
  datePresetsFor,
  detectActivePreset,
  isoDate,
  rangeForPreset,
} from "../search-dates";

/**
 * Frozen local clock. The dates below are chosen for their weekday, so the
 * assertions have to be read as local time — which is exactly the basis
 * `isoDate` uses.
 */
const at = (iso: string) => new Date(`${iso}T09:00:00`);

// 2026-09-01 is a Tuesday. The rest are derived from that week.
const TUESDAY = at("2026-09-01");
const SATURDAY = at("2026-09-05");
const SUNDAY = at("2026-09-06");
const FRIDAY = at("2026-09-04");
const MONTH_END = at("2026-09-30"); // a Wednesday

afterEach(() => {
  vi.useRealTimers();
});

describe("isoDate", () => {
  it("formats the LOCAL calendar date, zero-padded", () => {
    expect(isoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(isoDate(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });

  it("does not drift a late-evening date backwards the way toISOString can", () => {
    const lateLocal = new Date(2026, 8, 1, 23, 30);
    expect(isoDate(lateLocal)).toBe("2026-09-01");
  });
});

describe("rangeForPreset — today", () => {
  it("is a single day", () => {
    expect(rangeForPreset("today", TUESDAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-01",
    });
  });
});

describe("rangeForPreset — this-weekend", () => {
  it("mid-week jumps forward to the coming Sat–Sun", () => {
    expect(rangeForPreset("this-weekend", TUESDAY)).toEqual({
      from: "2026-09-05",
      to: "2026-09-06",
    });
  });

  it("on Friday still points at tomorrow's Saturday", () => {
    expect(rangeForPreset("this-weekend", FRIDAY)).toEqual({
      from: "2026-09-05",
      to: "2026-09-06",
    });
  });

  it("on Saturday starts today", () => {
    expect(rangeForPreset("this-weekend", SATURDAY)).toEqual({
      from: "2026-09-05",
      to: "2026-09-06",
    });
  });

  it("on Sunday is TODAY, never yesterday", () => {
    // The regression this module exists for: the old implementation walked
    // back to Saturday, handing a one-tap filter a lower bound in the past.
    expect(rangeForPreset("this-weekend", SUNDAY)).toEqual({
      from: "2026-09-06",
      to: "2026-09-06",
    });
  });

  it("never returns a lower bound before today, on any weekday", () => {
    for (let day = 1; day <= 7; day++) {
      const now = at(`2026-09-0${day}`);
      const { from, to } = rangeForPreset("this-weekend", now);
      expect(from >= isoDate(now)).toBe(true);
      expect(to >= from).toBe(true);
    }
  });
});

describe("rangeForPreset — next-7 / this-month", () => {
  it("next-7 is today plus six more days", () => {
    expect(rangeForPreset("next-7", TUESDAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-07",
    });
  });

  it("this-month runs to the last day of the month", () => {
    expect(rangeForPreset("this-month", TUESDAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("this-month collapses to a single day on the last of the month", () => {
    expect(rangeForPreset("this-month", MONTH_END)).toEqual({
      from: "2026-09-30",
      to: "2026-09-30",
    });
  });

  it("this-month handles a 31-day month and a leap February", () => {
    expect(rangeForPreset("this-month", at("2026-01-15")).to).toBe(
      "2026-01-31",
    );
    expect(rangeForPreset("this-month", at("2024-02-10")).to).toBe(
      "2024-02-29",
    );
  });
});

describe("datePresetsFor", () => {
  it("offers all four mid-week", () => {
    expect(datePresetsFor(TUESDAY).map((p) => p.id)).toEqual([
      ...DATE_PRESET_ORDER,
    ]);
  });

  it("drops this-weekend on a Sunday, where it duplicates today", () => {
    expect(datePresetsFor(SUNDAY).map((p) => p.id)).toEqual([
      "today",
      "next-7",
      "this-month",
    ]);
  });

  it("drops this-month on the last day of the month", () => {
    expect(datePresetsFor(MONTH_END).map((p) => p.id)).toEqual([
      "today",
      "this-weekend",
      "next-7",
    ]);
  });

  it("never offers two chips for the same window", () => {
    for (let day = 1; day <= 28; day++) {
      const now = at(`2026-09-${String(day).padStart(2, "0")}`);
      const keys = datePresetsFor(now).map((p) => `${p.range.from}|${p.range.to}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("detectActivePreset", () => {
  it("round-trips every offered preset", () => {
    for (const now of [TUESDAY, SATURDAY, SUNDAY, MONTH_END]) {
      for (const { id, range } of datePresetsFor(now)) {
        expect(detectActivePreset(range.from, range.to, now)).toBe(id);
      }
    }
  });

  it("returns null for a hand-picked window and for partial input", () => {
    expect(detectActivePreset("2026-09-02", "2026-09-11", TUESDAY)).toBeNull();
    expect(detectActivePreset("", "2026-09-11", TUESDAY)).toBeNull();
    expect(detectActivePreset("2026-09-02", "", TUESDAY)).toBeNull();
  });

  it("never reports a preset that is not on screen", () => {
    // Sunday: {today, today} matches "today", which IS offered — the point is
    // that it does not report the suppressed "this-weekend".
    const sundayIso = "2026-09-06";
    expect(detectActivePreset(sundayIso, sundayIso, SUNDAY)).toBe("today");
    const offered = datePresetsFor(SUNDAY).map((p) => p.id);
    expect(offered).toContain(detectActivePreset(sundayIso, sundayIso, SUNDAY));
  });
});

describe("default clock", () => {
  it("uses the real now when no clock is injected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SUNDAY);
    expect(rangeForPreset("today")).toEqual({
      from: "2026-09-06",
      to: "2026-09-06",
    });
    expect(datePresetsFor().map((p) => p.id)).not.toContain("this-weekend");
  });
});

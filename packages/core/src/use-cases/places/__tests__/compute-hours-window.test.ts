import { describe, expect, it } from "vitest";

import {
  computeHoursWindow,
  type HoursAvailabilityRow,
} from "../compute-hours-window";

// ─────────────────────────────────────────────────────────────────────────────
// computeHoursWindow (event-calendar-redesign FR-005 / FR-011) — pure.
//
// Fixtures are a Chicago venue (CDT in June = UTC-5). `weekDays` are passed
// as instants at UTC noon so each lands unambiguously on its Chicago date:
// Mon 2026-06-15 .. Sun 2026-06-21.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Chicago";
const MAIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIO = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";

/** Mon..Sun, 2026-06-15..21, at 12:00Z (07:00 CDT). */
const WEEK = [15, 16, 17, 18, 19, 20, 21].map(
  (d) => new Date(`2026-06-${d}T12:00:00.000Z`),
);
const [MON, TUE, WED, THU, FRI, SAT, SUN] = [1, 2, 3, 4, 5, 6, 0];

function row(overrides: Partial<HoursAvailabilityRow>): HoursAvailabilityRow {
  return {
    calendarId: null,
    dayOfWeek: null,
    date: null,
    startTime: null,
    endTime: null,
    isOpen: true,
    ...overrides,
  };
}

const weekly = (
  calendarId: string | null,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  isOpen = true,
) => row({ calendarId, dayOfWeek, startTime, endTime, isOpen });

describe("computeHoursWindow", () => {
  it("single calendar: that calendar's weekday rows plus place-wide rows; days with no rows are null", () => {
    const rows = [
      weekly(MAIN, FRI, "19:00", "23:00"),
      weekly(MAIN, SAT, "18:00", "23:30"),
      // Place-wide Sunday brunch applies to every calendar.
      weekly(null, SUN, "10:00", "14:00"),
      // Another calendar's rows are NOT in a single-calendar scope.
      weekly(PATIO, FRI, "12:00", "17:00"),
    ];

    expect(
      computeHoursWindow({ rows, scope: { calendarId: MAIN }, weekDays: WEEK, timezone: TZ }),
    ).toEqual([
      null, // Mon
      null, // Tue
      null, // Wed
      null, // Thu
      { startMinutes: 19 * 60, endMinutes: 23 * 60 }, // Fri — MAIN only, not PATIO's 12:00
      { startMinutes: 18 * 60, endMinutes: 23 * 60 + 30 }, // Sat
      { startMinutes: 10 * 60, endMinutes: 14 * 60 }, // Sun — place-wide
    ]);
  });

  it("scope 'all': unions every calendar's rows plus place-wide — earliest open to latest close", () => {
    const rows = [
      weekly(MAIN, FRI, "19:00", "23:00"),
      weekly(PATIO, FRI, "12:00", "17:00"),
      weekly(null, FRI, "16:00", "20:00"),
      weekly(PATIO, SAT, "11:00", "15:00"),
    ];

    const out = computeHoursWindow({ rows, scope: "all", weekDays: WEEK, timezone: TZ });
    expect(out[4]).toEqual({ startMinutes: 12 * 60, endMinutes: 23 * 60 });
    expect(out[5]).toEqual({ startMinutes: 11 * 60, endMinutes: 15 * 60 });
    expect(out[0]).toBeNull();
  });

  it("a window crossing midnight ends past 1440 — and the union keeps the latest close", () => {
    const rows = [
      weekly(MAIN, SAT, "20:00", "02:00"),
      weekly(PATIO, SAT, "17:00", "23:00"),
    ];

    expect(
      computeHoursWindow({ rows, scope: { calendarId: MAIN }, weekDays: [WEEK[5]!], timezone: TZ }),
    ).toEqual([{ startMinutes: 20 * 60, endMinutes: 26 * 60 }]);
    expect(
      computeHoursWindow({ rows, scope: "all", weekDays: [WEEK[5]!], timezone: TZ }),
    ).toEqual([{ startMinutes: 17 * 60, endMinutes: 26 * 60 }]);
  });

  it("a closed weekday (isOpen: false) on the scoped calendar yields null even when the place is open", () => {
    const rows = [
      weekly(null, MON, "10:00", "22:00"),
      weekly(MAIN, MON, "10:00", "22:00", false),
    ];
    expect(
      computeHoursWindow({ rows, scope: { calendarId: MAIN }, weekDays: [WEEK[0]!], timezone: TZ }),
    ).toEqual([null]);
    // Under "all", MAIN's closure only removes MAIN; the place-wide window stands.
    expect(
      computeHoursWindow({ rows, scope: "all", weekDays: [WEEK[0]!], timezone: TZ }),
    ).toEqual([{ startMinutes: 10 * 60, endMinutes: 22 * 60 }]);
  });

  it("a PLACE-WIDE closure closes every calendar that day, in either scope", () => {
    const rows = [
      weekly(MAIN, TUE, "19:00", "23:00"),
      weekly(PATIO, TUE, "12:00", "17:00"),
      weekly(null, TUE, "00:00", "00:00", false),
    ];
    expect(
      computeHoursWindow({ rows, scope: "all", weekDays: [WEEK[1]!], timezone: TZ }),
    ).toEqual([null]);
    expect(
      computeHoursWindow({ rows, scope: { calendarId: PATIO }, weekDays: [WEEK[1]!], timezone: TZ }),
    ).toEqual([null]);
  });

  it("a specific-date row beats the weekday row for that calendar — override AND blackout", () => {
    const rows = [
      weekly(MAIN, WED, "19:00", "23:00"),
      weekly(MAIN, THU, "19:00", "23:00"),
      // Wed 2026-06-17: a one-off late night (dated rows are stored as the
      // instant of that venue-local day — here 05:00Z = midnight CDT).
      row({ calendarId: MAIN, date: new Date("2026-06-17T05:00:00.000Z"), startTime: "17:00", endTime: "01:00" }),
      // Thu 2026-06-18: private hire, closed.
      row({ calendarId: MAIN, date: new Date("2026-06-18T05:00:00.000Z"), isOpen: false }),
    ];

    const out = computeHoursWindow({ rows, scope: { calendarId: MAIN }, weekDays: WEEK, timezone: TZ });
    expect(out[2]).toEqual({ startMinutes: 17 * 60, endMinutes: 25 * 60 });
    expect(out[3]).toBeNull();
    // Other Wednesdays are untouched by the dated override.
    const nextWed = new Date("2026-06-24T12:00:00.000Z");
    expect(
      computeHoursWindow({ rows, scope: { calendarId: MAIN }, weekDays: [nextWed], timezone: TZ }),
    ).toEqual([{ startMinutes: 19 * 60, endMinutes: 23 * 60 }]);
  });

  it("buckets each instant to the VENUE-local day, not UTC (late-evening UTC is still the same Chicago day)", () => {
    const rows = [weekly(MAIN, FRI, "19:00", "23:00")];
    // 2026-06-20T03:00Z is Sat in UTC but Fri 22:00 in Chicago.
    const out = computeHoursWindow({
      rows,
      scope: { calendarId: MAIN },
      weekDays: [new Date("2026-06-20T03:00:00.000Z")],
      timezone: TZ,
    });
    expect(out).toEqual([{ startMinutes: 19 * 60, endMinutes: 23 * 60 }]);
  });

  it("open rows without both times contribute nothing (never guess a span); no rows at all → null everywhere", () => {
    const rows = [row({ calendarId: MAIN, dayOfWeek: FRI, startTime: "19:00", endTime: null })];
    expect(
      computeHoursWindow({ rows, scope: "all", weekDays: WEEK, timezone: TZ }),
    ).toEqual([null, null, null, null, null, null, null]);
    expect(
      computeHoursWindow({ rows: [], scope: "all", weekDays: WEEK, timezone: TZ }),
    ).toEqual([null, null, null, null, null, null, null]);
  });

  it("output is positional with weekDays, whatever their order", () => {
    const rows = [weekly(MAIN, FRI, "19:00", "23:00"), weekly(MAIN, SAT, "18:00", "23:00")];
    const out = computeHoursWindow({
      rows,
      scope: "all",
      weekDays: [WEEK[5]!, WEEK[4]!],
      timezone: TZ,
    });
    expect(out).toEqual([
      { startMinutes: 18 * 60, endMinutes: 23 * 60 },
      { startMinutes: 19 * 60, endMinutes: 23 * 60 },
    ]);
  });
});

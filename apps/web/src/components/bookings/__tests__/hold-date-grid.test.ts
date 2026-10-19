import { describe, expect, it } from "vitest";

import type { CalendarHold } from "@/app/admin/[slug]/_components/event-calendar-types";
import {
  addHoldDates,
  addIsoDays,
  addIsoMonths,
  availabilityLooksUnconfigured,
  buildHoldMonth,
  describeHoldDay,
  EMPTY_HOLD_SELECTION,
  extendHoldSelection,
  holdGridMoveForKey,
  initialFocusDate,
  initialHoldMonth,
  isoDate,
  isoWeekday,
  MAX_HOLD_DATES,
  monthReadsAllDark,
  moveHoldFocus,
  placeDayKey,
  removeHoldDate,
  retainFailedHoldDates,
  selectablePreferredDates,
  selectableWeekdayDates,
  toggleHoldDate,
  type HoldMonthInput,
} from "../hold-date-grid";

/**
 * The month model behind the hold picker. Everything the grid, the rail and
 * the tray read is decided here, so this suite is where the product rules
 * live: what a day's state is and in what order, what position the act would
 * take, what a Shift-range does when it meets a night it cannot have, and
 * what survives a half-successful `placeMany`.
 */

const REQUEST = "req-1";
const OTHER = "req-2";

const hold = (over: Partial<CalendarHold> & Pick<CalendarHold, "date" | "position">): CalendarHold => ({
  id: `h-${over.date}-${over.position}`,
  bookingRequestId: OTHER,
  calendarId: "cal-1",
  spaceId: null,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  actName: "Marrow Twin",
  performerDisplayName: null,
  ...over,
});

function month(over: Partial<HoldMonthInput> = {}) {
  return buildHoldMonth({
    year: 2026,
    month: 9, // October 2026
    today: "2026-10-06",
    bookingRequestId: REQUEST,
    holds: [],
    closedDates: new Set(),
    takenDates: new Map(),
    preferredDates: new Set(),
    ...over,
  });
}

describe("ISO date arithmetic", () => {
  it("adds days without letting the viewer's zone shift the answer", () => {
    expect(addIsoDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addIsoDays("2026-01-01", -1)).toBe("2025-12-31");
    // A US DST boundary: 2026-11-01 is the fall-back Sunday.
    expect(addIsoDays("2026-10-31", 2)).toBe("2026-11-02");
  });

  it("clamps a month step to the target month's length", () => {
    expect(addIsoMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addIsoMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(addIsoMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("reads weekdays Sunday-first", () => {
    expect(isoWeekday("2026-10-11")).toBe(0);
    expect(isoWeekday("2026-10-16")).toBe(5);
  });

  it("reads an instant as the VENUE's calendar day, not the viewer's", () => {
    // 03:30 UTC on the 7th is still the 6th in Chicago.
    const instant = new Date("2026-10-07T03:30:00.000Z");
    expect(placeDayKey(instant, "America/Chicago")).toBe("2026-10-06");
    expect(placeDayKey(instant, "UTC")).toBe("2026-10-07");
  });

  it("falls back to the viewer's day rather than throwing on a bad zone", () => {
    expect(placeDayKey(new Date("2026-10-07T12:00:00.000Z"), "Not/AZone")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("buildHoldMonth — the grid", () => {
  it("pads to whole Sunday-first weeks without inventing days", () => {
    const m = month();
    expect(m.daysInMonth).toBe(31);
    expect(m.firstDate).toBe("2026-10-01");
    expect(m.lastDate).toBe("2026-10-31");
    // 1 Oct 2026 is a Thursday → four leading pads.
    expect(m.weeks[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(m.weeks[0]![4]!.date).toBe("2026-10-01");
    for (const week of m.weeks) expect(week).toHaveLength(7);
    expect(m.weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(m.cells).toHaveLength(31);
  });

  it("keeps February honest in a leap year", () => {
    expect(buildHoldMonth({ ...monthInput(), year: 2028, month: 1 }).daysInMonth).toBe(29);
    expect(buildHoldMonth({ ...monthInput(), year: 2026, month: 1 }).daysInMonth).toBe(28);
  });
});

function monthInput(): HoldMonthInput {
  return {
    year: 2026,
    month: 9,
    today: "2026-10-06",
    bookingRequestId: REQUEST,
    holds: [],
    closedDates: new Set(),
    takenDates: new Map(),
    preferredDates: new Set(),
  };
}

describe("buildHoldMonth — day state", () => {
  it("offers line length plus one, the same arithmetic the server does", () => {
    const m = month({
      holds: [
        hold({ date: "2026-10-16", position: 1 }),
        hold({ date: "2026-10-16", position: 2 }),
      ],
    });
    const day = m.byDate.get("2026-10-16")!;
    expect(day.line).toHaveLength(2);
    expect(day.offeredPosition).toBe(3);
    expect(day.selectable).toBe(true);
    // An empty open night takes first place.
    expect(m.byDate.get("2026-10-15")!.offeredPosition).toBe(1);
  });

  it("a CONFIRMED hold ENDS the line, it does not sit in it", () => {
    // The admin overlay now carries CONFIRMED rows alongside the live line
    // (booking-hold-overlay.ts), which is what lets the picker mark the night
    // as taken. It must never become a queue POSITION: the act behind a
    // confirmed winner is not 2nd, there is no line left to be 2nd in.
    const m = month({
      holds: [
        hold({ date: "2026-10-17", position: 1, status: "CONFIRMED" }),
        hold({ date: "2026-10-16", position: 1, status: "CONFIRMED" }),
        hold({ date: "2026-10-16", position: 2 }),
      ],
      takenDates: new Map([["2026-10-17", "Palegrass"]]),
    });
    const taken = m.byDate.get("2026-10-17")!;
    expect(taken.line).toHaveLength(0);
    expect(taken.status).toBe("taken");
    expect(taken.selectable).toBe(false);
    expect(taken.offeredPosition).toBeNull();

    // And where the caller has NOT marked the day taken, the confirmed row
    // still must not inflate the offer: one live hold means 2nd, not 3rd.
    const stillOpen = m.byDate.get("2026-10-16")!;
    expect(stillOpen.line).toHaveLength(1);
    expect(stillOpen.offeredPosition).toBe(2);
  });

  it("counts only LIVE holds — a lapsed or released row is not in the line", () => {
    const m = month({
      holds: [
        hold({ date: "2026-10-16", position: 1, status: "RELEASED" }),
        hold({ date: "2026-10-16", position: 2, lapsed: true, status: "CHALLENGED" }),
        hold({ date: "2026-10-16", position: 3 }),
      ],
    });
    const day = m.byDate.get("2026-10-16")!;
    expect(day.line).toHaveLength(1);
    expect(day.offeredPosition).toBe(2);
    expect(day.challenged).toBe(false);
  });

  it("flags a running challenge clock on the day", () => {
    const m = month({
      holds: [hold({ date: "2026-10-16", position: 1, status: "CHALLENGED" })],
    });
    expect(m.byDate.get("2026-10-16")!.challenged).toBe(true);
  });

  it("shows this request's own hold as held, and refuses a second one", () => {
    const m = month({
      holds: [
        hold({ date: "2026-10-16", position: 1 }),
        hold({ date: "2026-10-16", position: 2, bookingRequestId: REQUEST }),
      ],
    });
    const day = m.byDate.get("2026-10-16")!;
    expect(day.minePosition).toBe(2);
    expect(day.selectable).toBe(false);
    expect(day.offeredPosition).toBeNull();
    expect(describeHoldDay(day)).toEqual({ kind: "held", position: 2 });
  });

  it("ranks past over taken over dark", () => {
    const m = month({
      today: "2026-10-06",
      closedDates: new Set(["2026-10-05", "2026-10-12", "2026-10-19"]),
      takenDates: new Map([
        ["2026-10-05", "Palegrass"],
        ["2026-10-19", "Slow Pulse"],
      ]),
    });
    // Past wins even though the day is also taken AND dark.
    expect(m.byDate.get("2026-10-05")!.status).toBe("past");
    // Taken wins over dark.
    expect(m.byDate.get("2026-10-19")!.status).toBe("taken");
    expect(m.byDate.get("2026-10-12")!.status).toBe("dark");
    expect(describeHoldDay(m.byDate.get("2026-10-19")!)).toEqual({
      kind: "taken",
      label: "Slow Pulse",
    });
  });

  it("HARD-blocks only what the server refuses: a past day and a taken line", () => {
    const m = month({
      today: "2026-10-06",
      takenDates: new Map([["2026-10-19", "Slow Pulse"]]),
    });
    for (const date of ["2026-10-05", "2026-10-19"]) {
      const day = m.byDate.get(date)!;
      expect(day.selectable).toBe(false);
      expect(day.bulkSelectable).toBe(false);
      expect(day.offeredPosition).toBeNull();
    }
  });

  it("SOFT-blocks a dark night: holdable by hand, never swept up in bulk", () => {
    // `placeBookingHold` never consults availability, so refusing a dark night
    // in the UI would forbid something the server allows, with no override.
    const m = month({
      today: "2026-10-06",
      closedDates: new Set(["2026-10-12"]),
      holds: [hold({ date: "2026-10-12", position: 1 })],
    });
    const dark = m.byDate.get("2026-10-12")!;
    expect(dark.status).toBe("dark");
    expect(dark.selectable).toBe(true);
    expect(dark.bulkSelectable).toBe(false);
    // The offer is real, so the cell can state it before the click.
    expect(dark.offeredPosition).toBe(2);
    expect(describeHoldDay(dark)).toEqual({
      kind: "dark",
      lineLength: 1,
      offered: 2,
    });
  });

  it("treats the venue's today as holdable — the floor is the past, not today", () => {
    expect(month().byDate.get("2026-10-06")!.status).toBe("open");
  });

  it("marks the dates the act asked for", () => {
    const m = month({ preferredDates: new Set(["2026-10-16", "2026-11-02"]) });
    expect(m.byDate.get("2026-10-16")!.preferred).toBe(true);
    expect(m.byDate.get("2026-10-15")!.preferred).toBe(false);
  });
});

describe("selection", () => {
  const m = month({
    today: "2026-10-06",
    closedDates: new Set(["2026-10-12", "2026-10-13"]),
    takenDates: new Map([["2026-10-14", "Palegrass"]]),
    preferredDates: new Set(["2026-10-09", "2026-10-16", "2026-10-23"]),
  });
  const at = (date: string) => m.byDate.get(date)!;

  it("toggles, keeps dates ascending, and remembers the anchor", () => {
    let sel = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-16"));
    sel = toggleHoldDate(sel, at("2026-10-09"));
    expect(sel.dates).toEqual(["2026-10-09", "2026-10-16"]);
    expect(sel.anchor).toBe("2026-10-09");
    sel = toggleHoldDate(sel, at("2026-10-09"));
    expect(sel.dates).toEqual(["2026-10-16"]);
    expect(sel.anchor).toBeNull();
  });

  it("ignores a day the server would refuse, but takes a dark one on an explicit click", () => {
    expect(toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-14")).dates).toEqual([]);
    expect(toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-01")).dates).toEqual([]);
    expect(toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-12")).dates).toEqual([
      "2026-10-12",
    ]);
  });

  it("runs a range that SKIPS dark and taken nights instead of refusing", () => {
    const anchored = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-10"));
    const ranged = extendHoldSelection(anchored, m, "2026-10-16");
    // 12 and 13 are dark, 14 is taken — the range steps over them.
    expect(ranged.dates).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(ranged.anchor).toBe("2026-10-16");
  });

  it("runs a range backwards from the anchor too", () => {
    const anchored = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-16"));
    expect(extendHoldSelection(anchored, m, "2026-10-15").dates).toEqual([
      "2026-10-15",
      "2026-10-16",
    ]);
  });

  it("falls back to a plain toggle when there is no anchor yet", () => {
    expect(extendHoldSelection(EMPTY_HOLD_SELECTION, m, "2026-10-16").dates).toEqual([
      "2026-10-16",
    ]);
  });

  it("stops at the contract's ceiling, ascending, and still allows deselection", () => {
    const anchored = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-06"));
    const full = extendHoldSelection(anchored, m, "2026-10-31");
    expect(full.dates).toHaveLength(MAX_HOLD_DATES);
    expect(full.dates[0]).toBe("2026-10-06");
    // A full tray refuses a new date…
    const refused = toggleHoldDate(full, at("2026-10-31"));
    expect(refused.dates).toHaveLength(MAX_HOLD_DATES);
    // …but never traps the operator: removing still works.
    expect(toggleHoldDate(full, at(full.dates[0]!)).dates).toHaveLength(
      MAX_HOLD_DATES - 1,
    );
  });

  it("adds the act's asked-for dates in one press", () => {
    const asked = selectablePreferredDates(m);
    expect(asked).toEqual(["2026-10-09", "2026-10-16", "2026-10-23"]);
    expect(addHoldDates(EMPTY_HOLD_SELECTION, m, asked).dates).toEqual(asked);
  });

  it("keeps a DARK asked-for date in the act's list — a named list is not a sweep", () => {
    // Otherwise the button says "3 dates" and adds two.
    const withDarkAsk = month({
      today: "2026-10-06",
      closedDates: new Set(["2026-10-12"]),
      preferredDates: new Set(["2026-10-09", "2026-10-12"]),
    });
    expect(selectablePreferredDates(withDarkAsk)).toEqual([
      "2026-10-09",
      "2026-10-12",
    ]);
  });

  it("leaves DARK days out of a weekday sweep", () => {
    const darkFridays = month({
      today: "2026-10-06",
      closedDates: new Set(["2026-10-16"]),
    });
    expect(selectableWeekdayDates(darkFridays, 5)).toEqual([
      "2026-10-09",
      "2026-10-23",
      "2026-10-30",
    ]);
  });

  it("adds every open day of one weekday", () => {
    // October 2026's Fridays: 2 (past), 9, 16, 23, 30.
    expect(selectableWeekdayDates(m, 5)).toEqual([
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ]);
  });

  it("removes one date and drops the anchor with it", () => {
    const sel = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-16"));
    expect(removeHoldDate(sel, "2026-10-16")).toEqual({ dates: [], anchor: null });
  });

  it("keeps only the dates that failed after a half-successful place", () => {
    let sel = toggleHoldDate(EMPTY_HOLD_SELECTION, at("2026-10-09"));
    sel = toggleHoldDate(sel, at("2026-10-16"));
    sel = toggleHoldDate(sel, at("2026-10-23"));
    const after = retainFailedHoldDates(sel, ["2026-10-16"]);
    expect(after.dates).toEqual(["2026-10-16"]);
    expect(after.anchor).toBeNull();
  });
});

describe("the month the picker opens on", () => {
  // Opening on "today's month" is wrong for the normal case: a request made in
  // August for two Fridays in October opened on August, where every day is
  // past and disabled, so the first action was always "next month, twice".
  it("opens on the act's first asked-for date that has not passed", () => {
    expect(initialHoldMonth(["2026-10-08", "2026-10-15"], "2026-08-31")).toEqual({
      year: 2026,
      month: 9,
    });
  });

  it("ignores asked-for dates already gone", () => {
    expect(initialHoldMonth(["2026-07-04", "2026-12-31"], "2026-08-31")).toEqual({
      year: 2026,
      month: 11,
    });
  });

  it("takes the EARLIEST upcoming date, whatever order the request listed them", () => {
    expect(initialHoldMonth(["2027-03-02", "2026-11-06"], "2026-08-31")).toEqual({
      year: 2026,
      month: 10,
    });
  });

  it("falls back to the current month when the request named none", () => {
    expect(initialHoldMonth([], "2026-08-31")).toEqual({ year: 2026, month: 7 });
  });

  it("falls back to the current month when every asked-for date has passed", () => {
    expect(initialHoldMonth(["2026-01-01"], "2026-08-31")).toEqual({
      year: 2026,
      month: 7,
    });
  });

  it("steps over a malformed preferred entry rather than opening on NaN", () => {
    expect(initialHoldMonth(["nonsense", "2026-10-08"], "2026-08-31")).toEqual({
      year: 2026,
      month: 9,
    });
  });

  it("counts today itself as upcoming", () => {
    expect(initialHoldMonth(["2026-08-31"], "2026-08-31")).toEqual({
      year: 2026,
      month: 7,
    });
  });
});

describe("roving focus", () => {
  it("maps the keys the grid claims", () => {
    expect(holdGridMoveForKey("ArrowLeft")).toBe("prevDay");
    expect(holdGridMoveForKey("ArrowRight")).toBe("nextDay");
    expect(holdGridMoveForKey("ArrowUp")).toBe("prevWeek");
    expect(holdGridMoveForKey("ArrowDown")).toBe("nextWeek");
    expect(holdGridMoveForKey("Home")).toBe("weekStart");
    expect(holdGridMoveForKey("End")).toBe("weekEnd");
    expect(holdGridMoveForKey("PageUp")).toBe("prevMonth");
    expect(holdGridMoveForKey("PageDown")).toBe("nextMonth");
    expect(holdGridMoveForKey("Tab")).toBeNull();
    expect(holdGridMoveForKey("a")).toBeNull();
  });

  it("moves by day and week, and to the ends of the week", () => {
    expect(moveHoldFocus("2026-10-16", "prevDay")).toBe("2026-10-15");
    expect(moveHoldFocus("2026-10-16", "nextWeek")).toBe("2026-10-23");
    // 16 Oct 2026 is a Friday.
    expect(moveHoldFocus("2026-10-16", "weekStart")).toBe("2026-10-11");
    expect(moveHoldFocus("2026-10-16", "weekEnd")).toBe("2026-10-17");
  });

  it("crosses the month boundary rather than dead-ending at the edge", () => {
    expect(moveHoldFocus("2026-10-31", "nextDay")).toBe("2026-11-01");
    expect(moveHoldFocus("2026-10-01", "prevWeek")).toBe("2026-09-24");
    expect(moveHoldFocus("2026-10-16", "nextMonth")).toBe("2026-11-16");
  });

  it("opens on the act's first holdable asked-for date", () => {
    const m = month({
      preferredDates: new Set(["2026-10-02", "2026-10-16"]),
      today: "2026-10-06",
    });
    // 2 Oct is in the past, so the second asked-for date wins.
    expect(initialFocusDate(m)).toBe("2026-10-16");
  });

  it("falls back to the first ORDINARY open day, then a dark one, then the 1st", () => {
    expect(initialFocusDate(month())).toBe("2026-10-06");
    // A dark run at the head of the month is stepped over, not landed on.
    const darkHead = month({
      closedDates: new Set(["2026-10-06", "2026-10-07"]),
    });
    expect(initialFocusDate(darkHead)).toBe("2026-10-08");
    // Nothing ordinary left: a dark night beats no cursor at all.
    const allDark = month({
      closedDates: new Set(
        Array.from({ length: 31 }, (_, i) => isoDate(2026, 9, i + 1)),
      ),
    });
    expect(initialFocusDate(allDark)).toBe("2026-10-06");
    // Nothing holdable at all — the month opens on its first day.
    const allTaken = month({
      takenDates: new Map(
        Array.from({ length: 31 }, (_, i) => [isoDate(2026, 9, i + 1), "Sold"]),
      ),
    });
    expect(initialFocusDate(allTaken)).toBe("2026-10-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The unconfigured venue (availability-onboarding FR-006)
// ─────────────────────────────────────────────────────────────────────────────

const ALL_OCTOBER = () =>
  new Set(Array.from({ length: 31 }, (_, i) => isoDate(2026, 9, i + 1)));

describe("monthReadsAllDark — when the per-cell word is noise", () => {
  it("is true when every day of the month is dark", () => {
    expect(monthReadsAllDark(month({ closedDates: ALL_OCTOBER() }).cells)).toBe(
      true,
    );
  });

  it("ignores PAST days — a half-past, half-dark month is still uniform", () => {
    // today = 2026-10-06, so days 1–5 are past; the rest all dark.
    expect(monthReadsAllDark(month({ closedDates: ALL_OCTOBER() }).cells)).toBe(
      true,
    );
    const halfDark = month({
      closedDates: new Set(
        Array.from({ length: 26 }, (_, i) => isoDate(2026, 9, i + 6)),
      ),
    });
    expect(monthReadsAllDark(halfDark.cells)).toBe(true);
  });

  it("is false the moment one day differs — open, taken, or held", () => {
    const oneOpen = ALL_OCTOBER();
    oneOpen.delete("2026-10-16");
    expect(monthReadsAllDark(month({ closedDates: oneOpen }).cells)).toBe(false);

    const withTaken = month({
      closedDates: ALL_OCTOBER(),
      takenDates: new Map([["2026-10-17", "Palegrass"]]),
    });
    expect(monthReadsAllDark(withTaken.cells)).toBe(false);
  });

  it("is false with nothing dark at all — there is no word to suppress", () => {
    expect(monthReadsAllDark(month().cells)).toBe(false);
  });
});

describe("availabilityLooksUnconfigured — the zero-rows signature, per month", () => {
  const day = (n: number, status: string) => ({
    date: isoDate(2026, 9, n),
    status,
  });

  it("is true when every non-past day reads closed", () => {
    expect(
      availabilityLooksUnconfigured([
        day(1, "past"),
        day(2, "closed"),
        day(3, "closed"),
      ]),
    ).toBe(true);
  });

  it("is false on ANY blackout — a blackout requires an explicit row", () => {
    expect(
      availabilityLooksUnconfigured([day(1, "closed"), day(2, "blackout")]),
    ).toBe(false);
  });

  it("is false on any open day, whatever its load", () => {
    for (const status of ["free", "partial", "full"]) {
      expect(
        availabilityLooksUnconfigured([day(1, "closed"), day(2, status)]),
      ).toBe(false);
    }
  });

  it("is false on an empty or all-past window — nothing to conclude from", () => {
    expect(availabilityLooksUnconfigured([])).toBe(false);
    expect(availabilityLooksUnconfigured([day(1, "past"), day(2, "past")])).toBe(
      false,
    );
  });
});

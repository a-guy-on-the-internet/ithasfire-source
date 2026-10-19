import { describe, expect, it } from "vitest";

import {
  applyFilters,
  chipAccessibleName,
  chipTestId,
  dayCountLabel,
  daySegments,
  distinctSeries,
  formatDayHeading,
  formatDuration,
  formatRangeLabel,
  formatSold,
  formatTime,
  formatTimeRange,
  getMonthGrid,
  getWeekDays,
  isSoldOut,
  WEEK_CHIP_MIN_PX,
  layoutWeekItems,
  renderKeyFor,
  startsOnDay,
  stepAnchor,
  tzMismatch,
  venueLocalTime,
  visibleHours,
  zoneAbbreviation,
} from "../helpers";
import { DEFAULT_CALENDAR_LABELS, resolveCalendarLabels } from "../labels";
import { TZ, at, event, hold } from "./fixtures.stub";

describe("calendar helpers — grids", () => {
  it("month grid is six Sunday-first weeks (42 cells) in the paint zone", () => {
    const grid = getMonthGrid(at(9, 2, 12), TZ);
    expect(grid).toHaveLength(42);
    expect(grid[0]!.key).toBe("2026-08-30");
    expect(grid[0]!.weekday).toBe(0);
    expect(grid[41]!.key).toBe("2026-10-10");
    // Local midnight in Chicago (CDT = UTC-5) is 05:00Z.
    expect(grid[1]!.start.toISOString()).toBe("2026-08-31T05:00:00.000Z");
  });

  it("week days run Sunday–Saturday around the anchor", () => {
    const days = getWeekDays(at(9, 2, 12), TZ);
    expect(days.map((d) => d.key)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });

  it("buckets by the PAINT zone, not the browser's", () => {
    // 11 PM Chicago on Sep 5 is Sep 6 in UTC / London.
    const days = getWeekDays(at(9, 5, 23), "Europe/London");
    expect(days[6]!.key).toBe("2026-09-12");
  });

  it("steps the anchor by month / week / 30 days", () => {
    const anchor = at(9, 2, 12);
    expect(stepAnchor(anchor, "month", 1, TZ).toISOString()).toBe(at(10, 2, 0).toISOString());
    expect(stepAnchor(anchor, "week", -1, TZ).toISOString()).toBe(at(8, 26, 0).toISOString());
    expect(stepAnchor(at(1, 31, 12), "month", 1, TZ).toISOString()).toBe(at(2, 28, 0).toISOString());
  });
});

describe("calendar helpers — labels", () => {
  it("formats the toolbar range per view", () => {
    const anchor = at(9, 2, 12);
    expect(formatRangeLabel("month", anchor, TZ)).toBe("September 2026");
    expect(formatRangeLabel("week", anchor, TZ)).toBe("Aug 30 – Sep 5, 2026");
    expect(formatRangeLabel("week", at(9, 9, 12), TZ)).toBe("Sep 6 – 12, 2026");
    expect(formatRangeLabel("week", at(12, 30, 12), TZ)).toBe("Dec 27, 2026 – Jan 2, 2027");
    expect(formatRangeLabel("agenda", anchor, TZ, at(10, 2, 12))).toBe("Sep 2 – Oct 2, 2026");
  });

  it("folds the ICU narrow no-break space before AM/PM into a plain space", () => {
    const text = formatTime(at(9, 5, 20), TZ);
    expect(text).toBe("8:00 PM");
    expect(text).not.toMatch(/[\u202F\u00A0]/);
    // The raw formatter output is what needed folding on ICU 72+.
    const raw = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(at(9, 5, 20));
    expect(raw.replace(/[\u202F\u00A0]/g, " ")).toBe(text);
    expect(chipAccessibleName(event({ id: "a", title: "Jazz" }), TZ)).not.toMatch(/[\u202F\u00A0]/);
  });

  it("formats time ranges and durations", () => {
    expect(formatTimeRange(at(9, 5, 20), at(9, 5, 23), TZ)).toBe("8:00–11:00 PM");
    expect(formatTimeRange(at(9, 5, 11), at(9, 5, 14), TZ)).toBe("11:00 AM–2:00 PM");
    expect(formatTimeRange(at(9, 5, 20), null, TZ)).toBe("8:00 PM");
    expect(formatDuration(at(9, 5, 20), at(9, 5, 23))).toBe("3h");
    expect(formatDuration(at(9, 5, 20), at(9, 5, 21, 30))).toBe("1h 30m");
    expect(formatDuration(at(9, 5, 20), at(9, 5, 20, 45))).toBe("45m");
    expect(formatDuration(at(9, 5, 20), null)).toBe("");
  });

  it("day headings carry Today / Tomorrow only", () => {
    const [today, tomorrow, later] = getWeekDays(at(9, 2, 12), TZ).slice(3, 6);
    expect(formatDayHeading(today!, "2026-09-02", TZ)).toEqual({ label: "Wed · Sep 2", relative: "today" });
    expect(formatDayHeading(tomorrow!, "2026-09-02", TZ)).toEqual({ label: "Thu · Sep 3", relative: "tomorrow" });
    expect(formatDayHeading(later!, "2026-09-02", TZ).relative).toBeNull();
    // Before the clock mounts there is no today.
    expect(formatDayHeading(today!, null, TZ).relative).toBeNull();
  });

  it("names days and months from the labels it is given", () => {
    const es = {
      weekdaysShort: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
      monthsShort: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
      monthsLong: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    };
    expect(formatRangeLabel("month", at(9, 2, 12), TZ, undefined, es)).toBe("septiembre 2026");
    expect(formatRangeLabel("week", at(9, 2, 12), TZ, undefined, es)).toBe("ago 30 – sep 5, 2026");
    const [today] = getWeekDays(at(9, 2, 12), TZ).slice(3, 4);
    expect(formatDayHeading(today!, "2026-09-02", TZ, es).label).toBe("mié · sep 2");
  });

  it("resolves labels from the catalog and falls back per key", () => {
    const catalog: Record<string, string> = {
      "admin.ecSun": "Dom",
      "admin.ecSeptember": "Septiembre",
      "admin.ecPublished": "Publicado",
      "admin.ecToday": "Hoy",
      "admin.ecHoldCount": "2 reservas",
    };
    const t = (key: string) => catalog[key] ?? key;
    const labels = resolveCalendarLabels(t, { edit: "Editar" });
    expect(labels.weekdaysShort[0]).toBe("Dom");
    expect(labels.weekdaysShort[1]).toBe("Mon");
    expect(labels.monthsLong[8]).toBe("Septiembre");
    // A localised long name without a short key still beats the English stub.
    expect(labels.monthsShort[8]).toBe("Sep");
    expect(labels.monthsShort[0]).toBe("Jan");
    expect(labels.statuses.PUBLISHED).toBe("Publicado");
    expect(labels.statuses.DRAFT).toBe("Draft");
    expect(labels.today).toBe("Hoy");
    expect(labels.holdCount(2)).toBe("2 reservas");
    expect(labels.eventCount(2)).toBe("2 events");
    expect(labels.edit).toBe("Editar");
    // Nothing that reaches the DOM is ever a raw key.
    const flat = JSON.stringify(labels, (_k, v) => (typeof v === "function" ? v(1, "x") : v));
    expect(flat).not.toContain("admin.");
    expect(resolveCalendarLabels(t).edit).toBe(DEFAULT_CALENDAR_LABELS.edit);
  });

  it("sold / capacity and count labels", () => {
    expect(formatSold({ ticketsSold: 148, totalCapacity: 200 })).toBe("148 / 200");
    expect(formatSold({ ticketsSold: null, totalCapacity: 120 })).toBe("— / 120");
    expect(formatSold({ ticketsSold: 148, totalCapacity: null })).toBe("148");
    expect(formatSold({})).toBe("—");
    expect(isSoldOut({ ticketsSold: 200, totalCapacity: 200 })).toBe(true);
    expect(isSoldOut({ ticketsSold: 199, totalCapacity: 200 })).toBe(false);
    expect(isSoldOut({ soldOut: true })).toBe(true);
    expect(dayCountLabel([event({ id: "a" }), hold({ id: "h" })])).toBe("1 event · 1 hold");
    expect(dayCountLabel([])).toBe("0 events");
    expect(chipAccessibleName(event({ id: "a", title: "Jazz" }), TZ)).toBe("8:00 PM Jazz");
  });
});

describe("calendar helpers — timezone", () => {
  it("flags a mismatch by the clock, not the zone name", () => {
    const ny = event({ id: "ny", timezone: "America/New_York", startsAt: at(9, 5, 21, 0, "America/New_York") });
    expect(tzMismatch(ny, TZ)).toBe(true);
    expect(tzMismatch(event({ id: "c" }), TZ)).toBe(false);
    expect(tzMismatch(event({ id: "alias", timezone: "US/Central" }), TZ)).toBe(false);
    expect(venueLocalTime(ny)).toBe("9:00 PM EDT");
    expect(zoneAbbreviation(at(9, 5, 12), TZ)).toBe("CDT");
  });
});

describe("calendar helpers — week layout", () => {
  const day = getWeekDays(at(9, 2, 12), TZ)[6]!; // Sat Sep 5

  const DAY = { startMinutes: 0, endMinutes: 1440 };

  it("splits an overlap group into EQUAL columns; an item clear of it gets the full width", () => {
    const a = event({ id: "a", startsAt: at(9, 5, 20), endsAt: at(9, 5, 22) });
    const b = event({ id: "b", startsAt: at(9, 5, 21), endsAt: at(9, 5, 23) });
    // Starts after the group ends — its own group, so it keeps 100%.
    const c = event({ id: "c", startsAt: at(9, 5, 23), endsAt: at(9, 5, 23, 30) });
    // 2 × 96px of column, so the pair clears the floor and nothing collapses.
    const { placed, overflows } = layoutWeekItems(
      daySegments([a, b, c], day, TZ),
      DAY,
      2 * WEEK_CHIP_MIN_PX,
    );
    expect(overflows).toEqual([]);
    expect(placed.map((p) => [p.item.id, p.leftPercent, p.widthPercent, p.zIndex])).toEqual([
      ["a", 0, 50, 1],
      ["b", 50, 50, 2],
      ["c", 0, 100, 1],
    ]);
    expect(placed[0]!.top).toBe(20 * 60);
    expect(placed[0]!.height).toBe(120);
  });

  it("a 3-way overlap is three equal columns, none under the 96px floor", () => {
    const sameTime = ["x", "y", "z"].map((id) =>
      event({ id, startsAt: at(9, 5, 20), endsAt: at(9, 5, 22) }),
    );
    const column = 3 * WEEK_CHIP_MIN_PX;
    const { placed, overflows } = layoutWeekItems(daySegments(sameTime, day, TZ), DAY, column);
    expect(overflows).toEqual([]);
    expect(placed).toHaveLength(3);
    const widths = placed.map((p) => p.widthPercent);
    expect(new Set(widths).size).toBe(1);
    expect((widths[0]! / 100) * column).toBeGreaterThanOrEqual(WEEK_CHIP_MIN_PX);
    expect(placed.map((p) => p.leftPercent)).toEqual([0, widths[0]! * 1, widths[0]! * 2]);
  });

  it("caps the columns a narrow day cannot afford and collapses the rest into a +N slot", () => {
    const sameTime = ["x", "y", "z"].map((id) =>
      event({ id, startsAt: at(9, 5, 20), endsAt: at(9, 5, 22) }),
    );
    // The grid's own 120px minimum: one 96px block fits, two do not. This is
    // the case that used to paint 145 / 95 / 45px blocks on a shared edge.
    const { placed, overflows } = layoutWeekItems(daySegments(sameTime, day, TZ), DAY);
    expect(placed.map((p) => p.item.id)).toEqual(["x"]);
    expect(placed[0]!.leftPercent).toBe(0);
    expect(placed[0]!.widthPercent).toBe(72);
    expect(overflows).toEqual([
      { count: 2, top: 20 * 60, height: 120, leftPercent: 72, widthPercent: 28 },
    ]);
    // 72% of 120px is still 86px — thin, but it can show a time and a title;
    // the third block used to get 45px, which can show neither.
    expect((placed[0]!.widthPercent / 100) * 120).toBeGreaterThan(80);
  });

  it("paints a midnight-crossing event into the next column as a continuation", () => {
    const late = event({ id: "late", startsAt: at(9, 4, 22), endsAt: at(9, 5, 2) });
    const fri = getWeekDays(at(9, 2, 12), TZ)[5]!;
    expect(daySegments([late], fri, TZ)).toEqual([
      { item: late, startMinutes: 22 * 60, endMinutes: 26 * 60, continuation: false },
    ]);
    expect(daySegments([late], day, TZ)).toEqual([
      { item: late, startMinutes: 0, endMinutes: 120, continuation: true },
    ]);
    // Holds never enter the hour grid.
    expect(daySegments([hold({ id: "h" })], day, TZ)).toEqual([]);
  });

  it("clips to the hours window and enforces a minimum block", () => {
    const tiny = event({ id: "t", startsAt: at(9, 5, 20), endsAt: at(9, 5, 20, 10) });
    const { placed } = layoutWeekItems(daySegments([tiny], day, TZ), {
      startMinutes: 20 * 60 + 15,
      endMinutes: 1440,
    });
    expect(placed[0]!.height).toBe(15);
    expect(placed[0]!.top).toBe(0);
  });

  it("render keys are unique per chip and test ids keep the primary findable by id", () => {
    const late = event({ id: "late", startsAt: at(9, 4, 22), endsAt: at(9, 5, 2) });
    const fri = getWeekDays(at(9, 2, 12), TZ)[5]!;
    expect(startsOnDay(late, fri)).toBe(true);
    expect(startsOnDay(late, day)).toBe(false);
    expect(renderKeyFor(fri, late)).toBe("2026-09-04:late");
    expect(renderKeyFor(day, late, true)).toBe("2026-09-05:late:cont");
    expect(chipTestId("calendar-event-chip", late, fri)).toBe("calendar-event-chip-late");
    expect(chipTestId("calendar-event-chip", late, day)).toBe("calendar-event-chip-late-2026-09-05");
    expect(chipTestId("calendar-event-chip", late, day, true)).toBe("calendar-event-chip-late-cont");
  });

  it("unions the venue window across the week, else auto-fits with the 9–24 floor", () => {
    const union = visibleHours(
      [{ startMinutes: 17 * 60, endMinutes: 26 * 60 }, null, { startMinutes: 12 * 60, endMinutes: 22 * 60 }],
      [],
    );
    expect(union).toEqual({ startMinutes: 12 * 60, endMinutes: 26 * 60 });
    expect(visibleHours(undefined, [{ startMinutes: 20 * 60, endMinutes: 23 * 60 }])).toEqual({
      startMinutes: 9 * 60,
      endMinutes: 24 * 60,
    });
    expect(visibleHours([null, null], [{ startMinutes: 7 * 60 + 30, endMinutes: 25 * 60 + 10 }])).toEqual({
      startMinutes: 7 * 60,
      endMinutes: 26 * 60,
    });
    expect(visibleHours([{ startMinutes: 17 * 60, endMinutes: 26 * 60 }], [], true)).toEqual({
      startMinutes: 0,
      endMinutes: 1440,
    });
  });

  it("widens a venue window to cover a matinee outside it, so nothing vanishes", () => {
    const matinee = { startMinutes: 10 * 60, endMinutes: 12 * 60 };
    expect(visibleHours([{ startMinutes: 17 * 60, endMinutes: 26 * 60 }], [matinee])).toEqual({
      startMinutes: 10 * 60,
      endMinutes: 26 * 60,
    });
    const { placed } = layoutWeekItems(
      [{ item: event({ id: "m" }), ...matinee, continuation: false }],
      visibleHours([{ startMinutes: 17 * 60, endMinutes: 26 * 60 }], [matinee]),
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]!.top).toBe(0);
    expect(placed[0]!.height).toBe(120);
  });
});

describe("calendar helpers — filters", () => {
  const items = [
    event({ id: "p", status: "PUBLISHED", ownerKey: "org1", seriesId: "s1" }),
    event({ id: "d", status: "DRAFT", ownerKey: "org2" }),
    event({ id: "x", status: "CANCELLED", ownerKey: "org1" }),
    hold({ id: "h" }),
  ];

  it("public mode drops holds and ignores filters", () => {
    expect(applyFilters(items, { statuses: new Set(["DRAFT"]) }, "public").map((i) => i.id)).toEqual(["p", "d", "x"]);
  });

  it("internal mode honours status, owner, series and holds", () => {
    const base = { statuses: new Set(["PUBLISHED", "DRAFT"] as const) };
    expect(applyFilters(items, base, "internal").map((i) => i.id)).toEqual(["p", "d", "h"]);
    expect(applyFilters(items, { ...base, owners: new Set(["org2"]) }, "internal").map((i) => i.id)).toEqual(["d", "h"]);
    expect(applyFilters(items, { ...base, seriesId: "s1" }, "internal").map((i) => i.id)).toEqual(["p", "h"]);
    expect(applyFilters(items, { ...base, showHolds: false }, "internal").map((i) => i.id)).toEqual(["p", "d"]);
  });

  it("distinctSeries: one entry per series present, by name, holds and unnamed handled", () => {
    const fetched = [
      event({ id: "a", seriesId: "s-jam", seriesName: "Tuesday Jam" }),
      event({ id: "b", seriesId: "s-jam", seriesName: "Tuesday Jam" }),
      event({ id: "c", seriesId: "s-res", seriesName: "Residency" }),
      event({ id: "d", seriesId: "s-anon" }),
      event({ id: "e" }),
      hold({ id: "h" }),
    ];
    expect(distinctSeries(fetched, "Series")).toEqual([
      { id: "s-res", name: "Residency" },
      { id: "s-anon", name: "Series" },
      { id: "s-jam", name: "Tuesday Jam" },
    ]);
    expect(distinctSeries([event({ id: "e" }), hold({ id: "h" })], "Series")).toEqual([]);
  });
});

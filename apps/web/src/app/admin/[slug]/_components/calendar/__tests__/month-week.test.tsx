import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);

import { CalendarMonthView, MONTH_CELL_MIN_HEIGHT_PX } from "../CalendarMonthView";
import {
  CalendarWeekView,
  WEEK_PRICE_MIN_HEIGHT_PX,
  WEEK_PRICE_MIN_WIDTH_PX,
} from "../CalendarWeekView";
import { WEEK_CHIP_MIN_PX, getMonthGridWeeks, getWeekDays, groupByDay } from "../helpers";
import { TZ, at, event, hold } from "./fixtures.stub";

const anchor = at(9, 2, 12);
const weeks = getMonthGridWeeks(anchor, TZ);
const weekDays = getWeekDays(anchor, TZ);

/** The week grid's mono hour gutter — the measured box includes it. */
const GUTTER_PX = 56;

/**
 * The week measures its own box to honour the per-block px floor. jsdom's
 * ResizeObserver (vitest.setup) never fires, so the layout falls back to the
 * grid's 120px minimum; this drives one entry through so a test can ask for a
 * genuinely wide column. `perColumn` is the width ONE day column should get.
 */
let restoreResizeObserver: (() => void) | null = null;
function stubColumnWidth(perColumn: number) {
  const original = window.ResizeObserver;
  const callbacks: Array<(entries: unknown[]) => void> = [];
  class Stub {
    constructor(cb: (entries: unknown[]) => void) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
  restoreResizeObserver = () => {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
  };
  return () => {
    act(() => {
      for (const cb of callbacks) cb([{ contentRect: { width: GUTTER_PX + perColumn * 7 } }]);
    });
  };
}

afterEach(() => {
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

describe("CalendarMonthView", () => {
  const items = [
    event({ id: "a", startsAt: at(9, 5, 18), endsAt: at(9, 5, 19) }),
    event({ id: "b", startsAt: at(9, 5, 19), endsAt: at(9, 5, 20) }),
    event({ id: "c" }),
    event({ id: "d", startsAt: at(9, 5, 21), endsAt: at(9, 5, 22) }),
  ];
  const itemsByDay = groupByDay(items, weeks.flat());

  it("renders 42 cells, the TODAY square and +N more after three chips", () => {
    const onShowMore = vi.fn();
    const { container } = render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        onShowMore={onShowMore}
      />,
    );
    expect(container.querySelectorAll(".th-cal-cell")).toHaveLength(42);
    expect(screen.getByTestId("calendar-month-grid")).toBeTruthy();
    const today = screen.getByTestId("calendar-day-2026-09-02");
    expect(today.querySelector('[data-testid="calendar-today-marker"]')?.textContent).toBe("2");
    expect(today.textContent).toContain("Today");
    expect(screen.getByTestId("calendar-day-2026-08-30").getAttribute("data-out-of-month")).toBe("true");

    const sat = screen.getByTestId("calendar-day-2026-09-05");
    expect(sat.querySelectorAll('[data-testid^="calendar-event-chip-"]')).toHaveLength(3);
    const more = screen.getByTestId("calendar-more-2026-09-05");
    expect(more.textContent).toBe("+1 more");
    fireEvent.click(more);
    expect(onShowMore).toHaveBeenCalledWith(expect.objectContaining({ key: "2026-09-05" }));
  });

  it("internal mode: the CELL is the create target — empty or populated — and its buttons are not", () => {
    const onCreateAt = vi.fn();
    const onItemPress = vi.fn();
    const onShowMore = vi.fn();
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        onCreateAt={onCreateAt}
        onItemPress={onItemPress}
        onShowMore={onShowMore}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-day-create-2026-09-03"));
    expect(onCreateAt).toHaveBeenLastCalledWith(at(9, 3, 0));
    fireEvent.click(screen.getByTestId("calendar-day-2026-09-04"));
    expect(onCreateAt).toHaveBeenLastCalledWith(at(9, 4, 0));
    expect(onCreateAt).toHaveBeenCalledTimes(2);

    // A day that already carries shows creates from its blank space too. With
    // the "+" hidden at rest this is the ONLY create path a touch user has
    // there, so it is the whole reason the painted affordance could go.
    const busy = screen.getByTestId("calendar-day-2026-09-05");
    expect(busy.getAttribute("data-creatable")).toBe("true");
    fireEvent.click(busy);
    expect(onCreateAt).toHaveBeenLastCalledWith(at(9, 5, 0));
    expect(onCreateAt).toHaveBeenCalledTimes(3);

    // …but never from a control inside it.
    fireEvent.click(screen.getByTestId("calendar-event-chip-a"));
    expect(onItemPress).toHaveBeenCalledWith(items[0], expect.any(HTMLButtonElement), "2026-09-05:a");
    expect(onCreateAt).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-05"));
    expect(onShowMore).toHaveBeenCalledWith(expect.objectContaining({ key: "2026-09-05" }));
    expect(onCreateAt).toHaveBeenCalledTimes(3);

    expect(screen.getByTestId("calendar-day-create-2026-09-03").getAttribute("aria-label")).toBe(
      "Create event on September 3",
    );
  });

  it("the cell reserves no height for the create affordance", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        onCreateAt={vi.fn()}
      />,
    );
    // 124 → 96: the 28px band the always-painted affordance used to hold, six
    // week rows of it, is the ~170px the grid ran over its canvas.
    expect(MONTH_CELL_MIN_HEIGHT_PX).toBe(96);
    const cell = screen.getByTestId("calendar-day-2026-09-03");
    expect(cell.style.minHeight).toBe("96px");
    // Out of flow, which is what makes the 28px recoverable at all.
    expect(cell.style.position).toBe("relative");
  });

  it("a midnight-crossing show gets one chip per cell with distinct keys; the primary keeps the bare id", () => {
    const late = event({ id: "late", startsAt: at(9, 4, 22), endsAt: at(9, 5, 1) });
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={groupByDay([late], weeks.flat())}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        peekRenderKey="2026-09-04:late"
        hasPopup
      />,
    );
    expect(screen.getAllByTestId("calendar-event-chip-late")).toHaveLength(1);
    const primary = screen.getByTestId("calendar-event-chip-late");
    const spill = screen.getByTestId("calendar-event-chip-late-2026-09-05");
    expect(primary.getAttribute("data-render-key")).toBe("2026-09-04:late");
    expect(spill.getAttribute("data-render-key")).toBe("2026-09-05:late");
    expect(primary.getAttribute("aria-expanded")).toBe("true");
    expect(spill.getAttribute("aria-expanded")).toBe("false");
    expect(spill.getAttribute("data-continuation")).toBe("true");
    expect(spill.textContent).toContain("cont.");
  });

  it("paints no today affordance before the clock mounts", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey={null}
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
      />,
    );
    expect(screen.queryByTestId("calendar-today-marker")).toBeNull();
    expect(screen.getByTestId("calendar-day-2026-09-02").getAttribute("data-today")).toBeNull();
    expect(screen.getByTestId("calendar-day-2026-09-02").textContent).not.toContain("Today");
  });

  it("public mode renders no create affordance", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="public"
        onCreateAt={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("calendar-day-create-2026-09-03")).toBeNull();
  });
});

describe("CalendarWeekView", () => {
  const base = {
    days: weekDays,
    todayKey: "2026-09-02",
    timezone: TZ,
    viewerTimezone: TZ,
    mode: "internal" as const,
    showAllHours: false,
  };

  const hourLabels = () => screen.getAllByTestId("calendar-hour-label").map((el) => el.textContent);

  it("paints the venue hours window (union across the week) and the zone abbreviation", () => {
    render(
      <CalendarWeekView
        {...base}
        now={null}
        items={[]}
        hoursWindow={[{ startMinutes: 17 * 60, endMinutes: 26 * 60 }, null, null, null, null, null, null]}
        hoursCaption="Hours · Main Calendar · 5:00 PM – 2:00 AM · America/Chicago"
      />,
    );
    const labels = hourLabels();
    expect(labels[0]).toBe("5 PM");
    expect(labels[labels.length - 1]).toBe("1 AM");
    expect(labels).toHaveLength(9);
    expect(screen.getByTestId("calendar-week-zone").textContent).toBe("CDT");
    expect(screen.getByTestId("calendar-hours-caption").textContent).toContain("Main Calendar");
    expect(
      document.querySelector('[data-today="true"]')?.textContent,
    ).toContain("Wed");
  });

  it("auto-fits with the 09:00–24:00 floor when there are no hours, and Show all hours expands", () => {
    const onShowAllHours = vi.fn();
    const { rerender } = render(
      <CalendarWeekView {...base} now={null} items={[event({ id: "a" })]} onShowAllHours={onShowAllHours} />,
    );
    let labels = hourLabels();
    expect(labels[0]).toBe("9 AM");
    expect(labels[labels.length - 1]).toBe("11 PM");
    fireEvent.click(screen.getByTestId("calendar-show-all-hours"));
    expect(onShowAllHours).toHaveBeenCalled();
    rerender(<CalendarWeekView {...base} now={null} items={[event({ id: "a" })]} showAllHours />);
    labels = hourLabels();
    expect(labels[0]).toBe("12 AM");
    expect(labels).toHaveLength(24);
  });

  it("caps a too-narrow overlap into a +N slot, continues past midnight, and draws the now-line on today", () => {
    const a = event({ id: "a", startsAt: at(9, 5, 20), endsAt: at(9, 5, 22) });
    const b = event({ id: "b", startsAt: at(9, 5, 21), endsAt: at(9, 5, 23) });
    const late = event({ id: "late", startsAt: at(9, 4, 22), endsAt: at(9, 5, 2) });
    const onShowMore = vi.fn();
    render(
      <CalendarWeekView
        {...base}
        now={at(9, 2, 20, 30)}
        items={[a, b, late, hold({ id: "h", startsAt: at(9, 3, 0) })]}
        showAllHours
        onShowMore={onShowMore}
      />,
    );
    // jsdom never measures, so the column is the grid's 120px minimum: two
    // 96px blocks do not fit, so the first paints and the second collapses.
    expect(screen.getByTestId("calendar-event-chip-a").style.left).toBe("0%");
    expect(screen.getByTestId("calendar-event-chip-a").style.width).toBe("calc(72% - 2px)");
    expect(screen.queryByTestId("calendar-event-chip-b")).toBeNull();
    const more = screen.getByTestId("calendar-week-more-2026-09-05-0");
    expect(more.style.left).toBe("72%");
    expect(more.style.width).toBe("calc(28% - 2px)");
    expect(more.textContent).toBe("+1 more");
    expect(more.getAttribute("aria-label")).toBe("1 more on September 5");
    fireEvent.click(more);
    expect(onShowMore).toHaveBeenCalledWith(expect.objectContaining({ key: "2026-09-05" }));
    const sat = screen.getByTestId("calendar-week-col-2026-09-05");
    const cont = sat.querySelector('[data-testid="calendar-event-chip-late-cont"]');
    expect(cont?.getAttribute("data-continuation")).toBe("true");
    expect(cont?.getAttribute("data-render-key")).toBe("2026-09-05:late:cont");
    const fri = screen.getByTestId("calendar-week-col-2026-09-04");
    expect(screen.getAllByTestId("calendar-event-chip-late")).toHaveLength(1);
    expect(fri.querySelector('[data-testid="calendar-event-chip-late"]')?.getAttribute("data-continuation")).toBeNull();
    expect(fri.querySelector('[data-testid="calendar-event-chip-late"]')?.getAttribute("data-render-key")).toBe("2026-09-04:late");
    const now = screen.getByTestId("calendar-now-line");
    expect(screen.getByTestId("calendar-week-col-today").contains(now)).toBe(true);
    expect(now.style.top).toBe(`${(20.5) * 44}px`);
    expect(screen.getByTestId("calendar-week-holds").querySelector('[data-testid="calendar-hold-chip-h"]')).toBeTruthy();
  });

  it("does not draw a now-line before the clock mounts, and slot clicks snap to 30 minutes", () => {
    const onCreateAt = vi.fn();
    render(<CalendarWeekView {...base} now={null} items={[]} showAllHours onCreateAt={onCreateAt} />);
    expect(screen.queryByTestId("calendar-now-line")).toBeNull();
    const col = screen.getByTestId("calendar-week-col-2026-09-03");
    col.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 1056 }) as DOMRect;
    fireEvent.click(col, { clientY: 20 * 44 + 30 });
    expect(onCreateAt).toHaveBeenCalledWith(at(9, 3, 20, 30));
  });

  it("each day header carries a focusable create affordance landing on the window's first hour", () => {
    const onCreateAt = vi.fn();
    const { rerender } = render(
      <CalendarWeekView
        {...base}
        now={null}
        items={[]}
        hoursWindow={[{ startMinutes: 17 * 60, endMinutes: 26 * 60 }, null, null, null, null, null, null]}
        onCreateAt={onCreateAt}
      />,
    );
    const create = screen.getByTestId("calendar-week-create-2026-09-03");
    expect(create.tagName).toBe("BUTTON");
    expect(create.getAttribute("aria-label")).toBe("Create event on September 3");
    fireEvent.click(create);
    expect(onCreateAt).toHaveBeenCalledWith(at(9, 3, 17, 0));
    rerender(<CalendarWeekView {...base} mode="public" now={null} items={[]} onCreateAt={onCreateAt} />);
    expect(screen.queryByTestId("calendar-week-create-2026-09-03")).toBeNull();
  });

  it("a matinee outside the venue window is still painted (the window widens to it)", () => {
    const matinee = event({ id: "m", startsAt: at(9, 3, 10), endsAt: at(9, 3, 12) });
    render(
      <CalendarWeekView
        {...base}
        now={null}
        items={[matinee]}
        hoursWindow={[{ startMinutes: 17 * 60, endMinutes: 26 * 60 }, null, null, null, null, null, null]}
      />,
    );
    expect(hourLabels()[0]).toBe("10 AM");
    const chip = screen.getByTestId("calendar-event-chip-m");
    expect(chip.style.top).toBe("0px");
    expect(chip.style.height).toBe(`${2 * 44}px`);
  });
});

describe("month cell semantics + overlapping week blocks", () => {
  it("every month cell is a named group, so a chip is heard with its DATE", () => {
    const itemsByDay = groupByDay([event({ id: "a", startsAt: at(9, 5, 20) })], weeks.flat());
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey="2026-09-02"
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
      />,
    );
    const cell = screen.getByTestId("calendar-day-2026-09-05");
    expect(cell.getAttribute("role")).toBe("group");
    expect(cell.getAttribute("aria-label")).toBe("September 5");
    // The chip's own name stays the short one; the group supplies the date.
    expect(cell.querySelector('[data-testid="calendar-event-chip-a"]')?.getAttribute("aria-label"))
      .toBe("8:00 PM Event a");
  });

  /**
   * Three shows at the same clock time used to cascade at 0 / 34 / 68% with a
   * shared right edge, so the third was a 45px sliver that could show neither
   * its time nor its title. They now take equal columns, and the block fill
   * stays opaque (the status tint is a 10%-alpha wash; a translucent block
   * shows the hour rules and its neighbour through).
   */
  it("a 3-way overlap takes equal columns wide enough to read, each opaque and separated", () => {
    const sameTime = ["x", "y", "z"].map((id) =>
      event({ id, startsAt: at(9, 2, 20), endsAt: at(9, 2, 22) }),
    );
    // A wide day column (3 × 96px) so all three clear the floor.
    const measure = stubColumnWidth(3 * WEEK_CHIP_MIN_PX);
    render(
      <CalendarWeekView
        days={weekDays}
        todayKey="2026-09-02"
        now={anchor}
        items={sameTime}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        showAllHours={false}
      />,
    );
    measure();
    const blocks = ["x", "y", "z"].map((id) => screen.getByTestId(`calendar-event-chip-${id}`));
    expect(screen.queryByTestId("calendar-week-more-2026-09-02-0")).toBeNull();
    // Equal thirds — no cascade, no shared right edge, nothing under 96px.
    const pct = (value: string) => Number(value.replace(/[^\d.]/g, ""));
    const widths = blocks.map((b) => pct(b.style.width));
    expect(widths[1]).toBeCloseTo(widths[0]!, 3);
    expect(widths[2]).toBeCloseTo(widths[0]!, 3);
    // 288px of column × 1/3 = 96px, exactly the floor (jsdom rounds the %).
    for (const w of widths) {
      expect((w / 100) * (3 * WEEK_CHIP_MIN_PX)).toBeCloseTo(WEEK_CHIP_MIN_PX, 2);
    }
    const lefts = blocks.map((b) => pct(b.style.left));
    expect(lefts[0]).toBe(0);
    expect(lefts[1]).toBeCloseTo(widths[0]!, 3);
    expect(lefts[2]).toBeCloseTo(widths[0]! * 2, 3);
    for (const block of blocks) {
      // Paper under the tint — a translucent block shows its neighbour through.
      expect(block.style.backgroundColor).not.toBe("");
      expect(block.style.backgroundImage).toContain("linear-gradient");
      expect(block.style.overflow).toBe("hidden");
      expect(block.style.minWidth).toBe("0");
    }
    // Only the columns with a neighbour to their left carry the paper edge.
    expect(blocks[0]!.style.boxShadow).toBe("");
    for (const block of blocks.slice(1)) {
      expect(block.style.boxShadow).toContain("-2px 0 0 0 var(--surface");
    }
  });

  it("month chips keep the translucent wash — they stack, they never overlap", () => {
    const itemsByDay = groupByDay([event({ id: "a", startsAt: at(9, 5, 20) })], weeks.flat());
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey={null}
        itemsByDay={itemsByDay}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
      />,
    );
    const chip = screen.getByTestId("calendar-event-chip-a");
    expect(chip.style.backgroundImage).toBe("");
    expect(chip.style.background).toContain("--accentSoft");
  });
});

/**
 * FR-023 — price is a WEEK-ONLY third line, and only on a block big enough to
 * carry it. The block clips (`overflow: hidden`), so a price on a short block
 * would eat the title rather than appear.
 */
describe("week price line (FR-023)", () => {
  const weekBase = {
    days: weekDays,
    todayKey: null,
    now: null,
    timezone: TZ,
    viewerTimezone: TZ,
    mode: "public" as const,
    showAllHours: false,
  };

  const priced = (over: Parameters<typeof event>[0]) => event({ priceLabel: "$25", ...over });

  it("paints the price on a block tall and wide enough, under the title", () => {
    // 20:00–22:00 = 2 hour rows = 88px, comfortably over the 48px floor.
    render(
      <CalendarWeekView
        {...weekBase}
        items={[priced({ id: "p", startsAt: at(9, 2, 20), endsAt: at(9, 2, 22) })]}
      />,
    );
    const block = screen.getByTestId("calendar-event-chip-p");
    expect(Number.parseFloat(block.style.height)).toBeGreaterThanOrEqual(
      WEEK_PRICE_MIN_HEIGHT_PX,
    );
    expect(screen.getByTestId("calendar-event-chip-p-price").textContent).toBe("$25");
    // Third line, after the time row and the title.
    expect(block.textContent).toContain("Event p");
    expect(block.textContent!.indexOf("$25")).toBeGreaterThan(
      block.textContent!.indexOf("Event p"),
    );
  });

  it("renders NOTHING — not an empty line — when the event has no price", () => {
    render(
      <CalendarWeekView
        {...weekBase}
        items={[event({ id: "n", startsAt: at(9, 2, 20), endsAt: at(9, 2, 22), priceLabel: null })]}
      />,
    );
    const block = screen.getByTestId("calendar-event-chip-n");
    expect(screen.queryByTestId("calendar-event-chip-n-price")).toBeNull();
    // Two children: the time row and the title. No third node.
    expect(block.children).toHaveLength(2);
  });

  it("drops the price on a block too SHORT to carry a third line", () => {
    // 45 minutes = 33px, under the 48px floor.
    render(
      <CalendarWeekView
        {...weekBase}
        items={[priced({ id: "s", startsAt: at(9, 2, 20), endsAt: at(9, 2, 20, 45) })]}
      />,
    );
    expect(Number.parseFloat(screen.getByTestId("calendar-event-chip-s").style.height)).toBeLessThan(
      WEEK_PRICE_MIN_HEIGHT_PX,
    );
    expect(screen.queryByTestId("calendar-event-chip-s-price")).toBeNull();
  });

  it("drops the price on a block too NARROW to carry it, where 'From $15' would truncate", () => {
    // Three same-time shows in a 200px column: maxSlots = 2, so the group is
    // capped and each painted block gets (100 - 28)/2 = 36% ≈ 72px — under the
    // 96px floor even though the blocks are tall.
    const measure = stubColumnWidth(200);
    render(
      <CalendarWeekView
        {...weekBase}
        items={["x", "y", "z"].map((id) =>
          priced({ id, startsAt: at(9, 2, 20), endsAt: at(9, 2, 22) }),
        )}
      />,
    );
    measure();
    const block = screen.getByTestId("calendar-event-chip-x");
    // `calc(36% - 2px)` → 36.
    const widthPct = Number(/([\d.]+)%/.exec(block.style.width)?.[1]);
    expect((widthPct / 100) * 200).toBeLessThan(WEEK_PRICE_MIN_WIDTH_PX);
    expect(screen.queryByTestId("calendar-event-chip-x-price")).toBeNull();
    // …and the title survives, which is the whole point of the floor.
    expect(block.textContent).toContain("Event x");
  });

  it("never paints price on a MONTH chip, on any surface", () => {
    const itemsByDay = groupByDay(
      [priced({ id: "p", startsAt: at(9, 5, 20), endsAt: at(9, 5, 23) })],
      weeks.flat(),
    );
    for (const mode of ["internal", "public"] as const) {
      const { unmount } = render(
        <CalendarMonthView
          weeks={weeks}
          month={9}
          todayKey={null}
          itemsByDay={itemsByDay}
          timezone={TZ}
          viewerTimezone={TZ}
          mode={mode}
        />,
      );
      expect(screen.getByTestId("calendar-month-grid").textContent).not.toContain("$25");
      expect(screen.queryByTestId("calendar-event-chip-p-price")).toBeNull();
      unmount();
    }
  });

  it("drops the price on a midnight-crossing CONTINUATION block", () => {
    render(
      <CalendarWeekView
        {...weekBase}
        showAllHours
        items={[priced({ id: "late", startsAt: at(9, 2, 22), endsAt: at(9, 3, 2) })]}
      />,
    );
    expect(screen.getByTestId("calendar-event-chip-late-price").textContent).toBe("$25");
    // The next column's continuation says "cont." and nothing else.
    const cont = screen.getByTestId("calendar-event-chip-late-cont");
    expect(cont.getAttribute("data-continuation")).toBe("true");
    expect(cont.textContent).not.toContain("$25");
  });
});

/**
 * The empty state lives INSIDE the frame in every view. The embed used to
 * render its own caption outside the engine, which read as page copy rather
 * than as the calendar's answer.
 */
describe("in-frame empty state (month + week)", () => {
  it("month: zero items in the painted grid → the empty state, inside the grid", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey={null}
        itemsByDay={new Map()}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="public"
        emptyLabel="No upcoming events in September 2026"
      />,
    );
    const empty = screen.getByTestId("calendar-empty-state");
    expect(empty.textContent).toBe("No upcoming events in September 2026");
    expect(screen.getByTestId("calendar-month-grid").contains(empty)).toBe(true);
    // The grid itself stays painted — the reader still navigates by date.
    expect(screen.getByTestId("calendar-day-2026-09-05")).toBeTruthy();
  });

  it("month: a single item anywhere in the grid suppresses it", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey={null}
        itemsByDay={groupByDay([event({ id: "a", startsAt: at(9, 5, 20) })], weeks.flat())}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="public"
        emptyLabel="No upcoming events in September 2026"
      />,
    );
    expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
  });

  it("week: zero items → the empty state, inside the week frame", () => {
    const { rerender } = render(
      <CalendarWeekView
        days={weekDays}
        todayKey={null}
        now={null}
        items={[]}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="public"
        showAllHours={false}
        emptyLabel="No upcoming events this week"
      />,
    );
    const empty = screen.getByTestId("calendar-empty-state");
    expect(empty.textContent).toBe("No upcoming events this week");
    expect(screen.getByTestId("calendar-week-grid").contains(empty)).toBe(true);

    rerender(
      <CalendarWeekView
        days={weekDays}
        todayKey={null}
        now={null}
        items={[event({ id: "a", startsAt: at(9, 2, 20), endsAt: at(9, 2, 22) })]}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="public"
        showAllHours={false}
        emptyLabel="No upcoming events this week"
      />,
    );
    expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
  });

  it("week: a date-level HOLD counts as content", () => {
    render(
      <CalendarWeekView
        days={weekDays}
        todayKey={null}
        now={null}
        items={[hold({ id: "h", startsAt: at(9, 3, 0) })]}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
        showAllHours={false}
        emptyLabel="Nothing scheduled in this window."
      />,
    );
    expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
  });

  it("paints nothing extra when the mount supplies no empty copy", () => {
    render(
      <CalendarMonthView
        weeks={weeks}
        month={9}
        todayKey={null}
        itemsByDay={new Map()}
        timezone={TZ}
        viewerTimezone={TZ}
        mode="internal"
      />,
    );
    expect(screen.queryByTestId("calendar-empty-state")).toBeNull();
  });
});

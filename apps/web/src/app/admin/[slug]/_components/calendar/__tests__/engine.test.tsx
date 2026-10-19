import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewport = vi.hoisted(() => ({ mobile: false }));

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => viewport.mobile }));

import { CalendarEngine, type CalendarEngineProps } from "../CalendarEngine";
import { TZ, at, event, hold } from "./fixtures.stub";

const items = [
  event({ id: "a", startsAt: at(9, 5, 11), endsAt: at(9, 5, 13), href: { edit: "/edit/a" } }),
  event({ id: "b", status: "DRAFT", startsAt: at(9, 5, 18), endsAt: at(9, 5, 19) }),
  event({ id: "c", startsAt: at(9, 5, 17), endsAt: at(9, 5, 18) }),
  event({ id: "d", startsAt: at(9, 5, 21), endsAt: at(9, 5, 23) }),
  hold({ id: "h", startsAt: at(9, 6, 0) }),
];

function props(over: Partial<CalendarEngineProps> = {}): CalendarEngineProps {
  return {
    mode: "internal",
    items,
    view: "month",
    onViewChange: vi.fn(),
    anchor: at(9, 2, 12),
    onAnchorChange: vi.fn(),
    timezone: TZ,
    viewerTimezone: TZ,
    now: at(9, 2, 12),
    filters: { statuses: new Set(["PUBLISHED", "DRAFT", "COMPLETED"]) },
    onFiltersChange: vi.fn(),
    filterOptions: { holds: true },
    overflowActions: [{ label: "Export month", onSelect: vi.fn() }],
    ...over,
  };
}

describe("CalendarEngine", () => {
  beforeEach(() => {
    viewport.mobile = false;
  });

  it("internal month: root test id, toolbar, filters, chips, and the peek opens/closes on press", () => {
    const onItemPress = vi.fn();
    render(<CalendarEngine {...props({ onItemPress })} />);
    expect(screen.getByTestId("event-calendar").getAttribute("data-mode")).toBe("internal");
    expect(screen.getByTestId("calendar-filters")).toBeTruthy();
    expect(screen.getByTestId("calendar-overflow")).toBeTruthy();
    expect(screen.getByTestId("calendar-month-grid")).toBeTruthy();
    expect(screen.getByTestId("calendar-nav-label").textContent).toBe("September 2026");
    expect(screen.getByTestId("calendar-hold-chip-h")).toBeTruthy();

    const chip = screen.getByTestId("calendar-event-chip-a");
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chip);
    expect(onItemPress).toHaveBeenCalledWith(items[0], { view: "month", renderKey: expect.any(String) });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Event a");
    // The chip stays mounted where it is — same node, now expanded.
    expect(screen.getByTestId("calendar-event-chip-a")).toBe(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("calendar-peek-edit").getAttribute("href")).toBe("/edit/a");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("a midnight-crossing show opens exactly ONE dialog from its primary chip, in month and in week", () => {
    const late = event({ id: "late", startsAt: at(9, 4, 22), endsAt: at(9, 5, 2), href: { edit: "/edit/late" } });
    const { rerender } = render(<CalendarEngine {...props({ items: [late] })} />);
    expect(screen.getAllByTestId("calendar-event-chip-late")).toHaveLength(1);
    expect(screen.getByTestId("calendar-event-chip-late-2026-09-05")).toBeTruthy();
    fireEvent.click(screen.getByTestId("calendar-event-chip-late"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getAllByTestId("calendar-event-chip-late")).toHaveLength(1);
    expect(screen.getByTestId("calendar-event-chip-late").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("calendar-event-chip-late-2026-09-05").getAttribute("aria-expanded")).toBe("false");
    // Pressing the spill toggles the peek onto that render — still one dialog.
    fireEvent.click(screen.getByTestId("calendar-event-chip-late-2026-09-05"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("calendar-event-chip-late").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("calendar-event-chip-late-2026-09-05").getAttribute("aria-expanded")).toBe("true");

    rerender(<CalendarEngine {...props({ items: [late], view: "week" })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTestId("calendar-event-chip-late")).toHaveLength(1);
    expect(screen.getByTestId("calendar-event-chip-late-cont")).toBeTruthy();
    fireEvent.click(screen.getByTestId("calendar-event-chip-late"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("calendar-event-chip-late-cont").getAttribute("aria-expanded")).toBe("false");
  });

  it("the peek anchors to the pressed chip's OWN node, and only one is ever mounted", () => {
    render(<CalendarEngine {...props()} />);
    const chip = screen.getByTestId("calendar-event-chip-a");
    const cell = chip.parentElement;
    // The rect the panel is placed from is the CHIP's, wherever it sits.
    chip.getBoundingClientRect = () =>
      ({ x: 435, y: 612, top: 612, left: 435, width: 145, height: 30, right: 580, bottom: 642 }) as DOMRect;

    fireEvent.click(chip);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    const popover = screen.getByTestId("popover");
    expect(popover.getAttribute("data-anchor-render-key")).toBe(chip.getAttribute("data-render-key"));
    const anchored = (popover as unknown as { anchorElement?: Element | null }).anchorElement;
    expect(anchored).toBe(chip);
    expect(anchored!.getBoundingClientRect().y).toBe(612);

    // The chip was neither remounted nor re-parented into the popover — that
    // is what left the panel anchored to nothing, at the foot of the document.
    expect(screen.getByTestId("calendar-event-chip-a")).toBe(chip);
    expect(chip.parentElement).toBe(cell);
    expect(popover.contains(chip)).toBe(false);

    // Pressing a second chip moves the ONE peek; it never opens a second.
    const other = screen.getByTestId("calendar-event-chip-c");
    fireEvent.click(other);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      (screen.getByTestId("popover") as unknown as { anchorElement?: Element | null }).anchorElement,
    ).toBe(other);
  });

  it("the peek closes on anchor, view and filter changes, and when its item is filtered out", () => {
    const base = props();
    const { rerender } = render(<CalendarEngine {...base} />);
    const open = () => {
      fireEvent.click(screen.getByTestId("calendar-event-chip-a"));
      expect(screen.getByRole("dialog")).toBeTruthy();
    };

    open();
    rerender(<CalendarEngine {...base} anchor={at(10, 2, 12)} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<CalendarEngine {...base} anchor={at(9, 2, 12)} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    rerender(<CalendarEngine {...base} view="week" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<CalendarEngine {...base} view="month" />);
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    rerender(<CalendarEngine {...base} filters={{ statuses: new Set(["PUBLISHED"]) }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // An equal filter object rebuilt by the mount is NOT a change.
    open();
    rerender(<CalendarEngine {...base} filters={{ statuses: new Set(["PUBLISHED"]), showHolds: true }} />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The item leaves the painted set → the peek goes with it.
    rerender(
      <CalendarEngine
        {...base}
        filters={{ statuses: new Set(["PUBLISHED"]) }}
        items={items.filter((i) => i.id !== "a")}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a mount takes a press over by returning false / { openPeek: false }; anything else toggles the peek", () => {
    const onItemPress = vi.fn();
    render(<CalendarEngine {...props({ onItemPress })} />);
    const press = (id: string) => fireEvent.click(screen.getByTestId(`calendar-event-chip-${id}`));

    onItemPress.mockReturnValueOnce(false);
    press("a");
    expect(onItemPress).toHaveBeenCalledWith(items[0], { view: "month", renderKey: expect.any(String) });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("calendar-event-chip-a").getAttribute("aria-expanded")).toBe("false");

    onItemPress.mockReturnValueOnce({ openPeek: false });
    press("a");
    expect(screen.queryByRole("dialog")).toBeNull();

    // A side-effect-only handler (returns undefined) keeps today's behaviour.
    onItemPress.mockReturnValueOnce(undefined);
    press("a");
    expect(screen.getByRole("dialog").textContent).toContain("Event a");

    // A taken-over press on ANOTHER chip closes the open peek — never two surfaces at once.
    onItemPress.mockReturnValueOnce(false);
    press("c");
    expect(screen.queryByRole("dialog")).toBeNull();

    onItemPress.mockReturnValueOnce(true);
    press("c");
    expect(screen.getByRole("dialog").textContent).toContain("Event c");
    onItemPress.mockReturnValueOnce({ openPeek: true });
    press("c");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("public mode: no filters, no overflow, no peek — item presses go to onPublicItemPress", () => {
    const onPublicItemPress = vi.fn();
    render(
      <CalendarEngine
        {...props({ mode: "public", views: ["month", "week"], onPublicItemPress, onCreateAt: vi.fn() })}
      />,
    );
    expect(screen.queryByTestId("calendar-filters")).toBeNull();
    expect(screen.queryByTestId("calendar-overflow")).toBeNull();
    expect(screen.queryByTestId("calendar-view-agenda")).toBeNull();
    expect(screen.queryByTestId("calendar-hold-chip-h")).toBeNull();
    expect(screen.queryByTestId("calendar-day-create-2026-09-03")).toBeNull();
    const chip = screen.getByTestId("calendar-event-chip-a");
    expect(chip.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(chip);
    expect(onPublicItemPress).toHaveBeenCalledWith(items[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-05"));
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Sat · Sep 5");
  });

  it("filters apply to what is painted; +N more expands the day list under the grid on every mount", () => {
    const p = props({ filters: { statuses: new Set(["PUBLISHED"]), showHolds: false } });
    render(<CalendarEngine {...p} />);
    expect(screen.queryByTestId("calendar-event-chip-b")).toBeNull();
    expect(screen.queryByTestId("calendar-hold-chip-h")).toBeNull();
    expect(screen.getByTestId("calendar-event-chip-a")).toBeTruthy();
    expect(screen.queryByTestId("calendar-more-2026-09-05")).toBeNull();
    const all = props();
    const { rerender } = render(<CalendarEngine {...all} />);
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-05"));
    expect(all.onViewChange).not.toHaveBeenCalled();
    expect(all.onAnchorChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Sat · Sep 5");
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("4 events");
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-05"));
    expect(screen.queryByTestId("calendar-day-list")).toBeNull();
    // Navigating away drops the expanded list too.
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-05"));
    rerender(<CalendarEngine {...all} anchor={at(10, 2, 12)} />);
    expect(screen.queryByTestId("calendar-day-list")).toBeNull();
  });

  it("agenda: rolling label, no prev/next, Show more wired; week: hours + now-line; nav steps the anchor", () => {
    const onAgendaShowMore = vi.fn();
    const p = props({ view: "agenda", agendaPageEnd: at(10, 2, 12), hasMoreAgenda: true, onAgendaShowMore });
    const { rerender } = render(<CalendarEngine {...p} />);
    expect(screen.getByTestId("calendar-nav-label").textContent).toBe("Sep 2 – Oct 2, 2026");
    expect(screen.queryByLabelText("Previous")).toBeNull();
    expect(screen.getByTestId("calendar-agenda-row-a")).toBeTruthy();
    fireEvent.click(screen.getByTestId("calendar-agenda-show-more"));
    expect(onAgendaShowMore).toHaveBeenCalled();
    expect(screen.getByTestId("calendar-agenda-show-more").textContent).toBe("Show more · Oct 3 – Nov 1, 2026");

    const w = props({ view: "week", hoursCaption: "Hours · Main Calendar" });
    rerender(<CalendarEngine {...w} />);
    expect(screen.getByTestId("calendar-week-grid")).toBeTruthy();
    expect(screen.getByTestId("calendar-now-line")).toBeTruthy();
    expect(screen.getByTestId("calendar-hours-caption").textContent).toBe("Hours · Main Calendar");
    fireEvent.click(screen.getByLabelText("Next"));
    expect(w.onAnchorChange).toHaveBeenCalledWith(at(9, 9, 0));
    fireEvent.click(screen.getByTestId("calendar-nav-today"));
    expect(w.onAnchorChange).toHaveBeenLastCalledWith(at(9, 2, 12));
  });

  it("Show all hours reports once per toggle, even under StrictMode", () => {
    const onShowAllHours = vi.fn();
    render(
      <StrictMode>
        <CalendarEngine {...props({ view: "week", onShowAllHours })} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId("calendar-show-all-hours"));
    expect(onShowAllHours).toHaveBeenCalledTimes(1);
    expect(onShowAllHours).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("calendar-show-all-hours").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("calendar-show-all-hours"));
    expect(onShowAllHours).toHaveBeenCalledTimes(2);
    expect(onShowAllHours).toHaveBeenLastCalledWith(false);
  });

  it("create-on-click reports the view; loading swaps the always-mounted status text", () => {
    const onCreateAt = vi.fn();
    const p = props({ onCreateAt, loading: true });
    const { rerender } = render(<CalendarEngine {...p} />);
    expect(screen.getByTestId("calendar-views").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("calendar-status").textContent).toBe("Loading");
    fireEvent.click(screen.getByTestId("calendar-day-create-2026-09-03"));
    expect(onCreateAt).toHaveBeenCalledWith(at(9, 3, 0), { view: "month" });
    rerender(<CalendarEngine {...p} loading={false} />);
    expect(screen.getByTestId("calendar-status")).toBeTruthy();
    expect(screen.getByTestId("calendar-status").textContent).toBe("");
  });

  it("server render paints no today affordance — the clock only exists after mount", () => {
    const { now: _now, ...noClock } = props();
    // The clock is pinned inside the fixture's visible month (September 2026)
    // for BOTH halves, so neither expires with the calendar: a render-time clock
    // read would put today in the server HTML. 23:30 on Sep 30 in TZ is already
    // Oct 1 in UTC, so a clock read in the wrong zone lights the wrong cell.
    vi.useFakeTimers({ toFake: ["Date"], now: at(9, 30, 23, 30) });
    try {
      const html = renderToString(<CalendarEngine {...noClock} />);
      expect(html).not.toContain("calendar-today-marker");
      expect(html).not.toContain('data-today="true"');
      expect(html).not.toContain("calendar-now-line");
      // Mounted, the wall clock arrives and today lights up.
      render(<CalendarEngine {...noClock} />);
      expect(screen.getByTestId("calendar-day-2026-09-30").getAttribute("data-today")).toBe("true");
      expect(screen.getByTestId("calendar-day-2026-09-02").getAttribute("data-today")).not.toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels override the defaults and reach every surface", () => {
    render(
      <CalendarEngine
        {...props({ labels: { today: "Hoy", views: { month: "Mes", week: "Semana", agenda: "Agenda" }, plusMore: (n) => `+${n} más` } })}
      />,
    );
    expect(screen.getByTestId("calendar-nav-today").textContent).toBe("Hoy");
    expect(screen.getByTestId("calendar-view-month").textContent).toBe("Mes");
    expect(screen.getByTestId("calendar-more-2026-09-05").textContent).toBe("+1 más");
    expect(screen.getByTestId("calendar-day-2026-09-02").textContent).toContain("Hoy");
  });

  it("below 600px: dot grid + day list, week option removed, a week view falls back to month", () => {
    viewport.mobile = true;
    const p = props({ view: "week" });
    render(<CalendarEngine {...p} />);
    expect(screen.getByTestId("calendar-month-dotgrid")).toBeTruthy();
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Wed · Sep 2");
    expect(screen.queryByTestId("calendar-view-week")).toBeNull();
    expect(screen.getByTestId("calendar-view-month")).toBeTruthy();
    // The clamp is PURELY VISUAL: `data-view` reports month, but the mount is
    // NOT told. Telling it rewrote `?view=week` to `?view=month` in the place
    // calendar's URL, so the preference did not survive a rotate.
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("month");
    expect(p.onViewChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("calendar-dot-2026-09-05"));
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Sat · Sep 5");
    fireEvent.click(screen.getByTestId("calendar-day-list-row-a"));
    expect(screen.getByTestId("bottom-sheet").querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("a view the MOUNT does not offer is still reconciled (a stale stored value)", () => {
    const p = props({ view: "week", views: ["month", "agenda"] });
    render(<CalendarEngine {...p} />);
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("month");
    expect(p.onViewChange).toHaveBeenCalledWith("month");
  });

  it("below 600px the filter row is ONE Filters trigger, not a wall of chips", () => {
    viewport.mobile = true;
    render(<CalendarEngine {...props({ filterOptions: { holds: true } })} />);
    expect(screen.getByTestId("calendar-filters-menu")).toBeTruthy();
    expect(screen.queryByTestId("calendar-filter-status-published")).toBeNull();
    expect(screen.queryByTestId("calendar-filter-holds")).toBeNull();
  });

  it("narrow is decided by the ENGINE's own box, not the viewport (the admin rail lies)", () => {
    // A 1440px window whose calendar column is 420px wide: `useIsMobile` says
    // desktop, the measured box says narrow, and the narrow layout wins.
    viewport.mobile = false;
    const observers: Array<(entries: unknown[]) => void> = [];
    const original = window.ResizeObserver;
    class Stub {
      constructor(cb: (entries: unknown[]) => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
    try {
      render(<CalendarEngine {...props({ view: "month" })} />);
      expect(screen.getByTestId("calendar-month-grid")).toBeTruthy();
      act(() => {
        for (const cb of observers) cb([{ contentRect: { width: 420 } }]);
      });
      expect(screen.getByTestId("calendar-month-dotgrid")).toBeTruthy();
      expect(screen.queryByTestId("calendar-month-grid")).toBeNull();
      expect(screen.getByTestId("calendar-filters-menu")).toBeTruthy();
    } finally {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });

  it.each([
    // Above CALENDAR_TIGHT_PX the label fits and stays, full IANA name intact.
    { width: 500, present: true },
    // Below it the label had nowhere to go but sub-pixel: on the dashboard at
    // a 390px viewport the engine's box was 272px and "Chicago" rendered
    // 1.53px wide — a sliver of the "C" beside the overflow button. Withhold
    // it instead.
    { width: 400, present: false },
  ])(
    "paints the timezone label at $width px: $present",
    ({ width, present }) => {
      viewport.mobile = false;
      const observers: Array<(entries: unknown[]) => void> = [];
      const original = window.ResizeObserver;
      class Stub {
        constructor(cb: (entries: unknown[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      }
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub;
      try {
        render(<CalendarEngine {...props({ timezone: "America/Chicago" })} />);
        act(() => {
          for (const cb of observers) cb([{ contentRect: { width } }]);
        });
        const label = screen.queryByTestId("calendar-timezone");
        if (!present) {
          expect(label).toBeNull();
          return;
        }
        expect(label).toBeTruthy();
        expect(label).toHaveAttribute("aria-label", "America/Chicago");
      } finally {
        (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
        (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
      }
    },
  );

  it("keeps the timezone label before the box has ever been measured", () => {
    // `tight` must NOT fall back to `useIsMobile` — that is the 600px NARROW
    // signal, so every 420-600px box would paint the label, drop it when the
    // mobile hook resolved, and bring it back on the first observer frame.
    viewport.mobile = true;
    const original = window.ResizeObserver;
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    try {
      render(<CalendarEngine {...props({ timezone: "America/Chicago" })} />);
      expect(screen.getByTestId("calendar-timezone")).toBeTruthy();
    } finally {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });
});

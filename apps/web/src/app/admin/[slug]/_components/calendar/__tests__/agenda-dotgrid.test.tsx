import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);

import { CalendarAgendaView } from "../CalendarAgendaView";
import { CalendarDayList } from "../CalendarDayList";
import { CalendarDotGrid } from "../CalendarDotGrid";
import { getAgendaDays, getMonthGridWeeks, groupByDay } from "../helpers";
import { TZ, at, event, hold } from "./fixtures.stub";

const anchor = at(9, 2, 12);

describe("CalendarAgendaView", () => {
  const days = getAgendaDays(anchor, at(10, 2, 12), TZ);
  const items = [
    event({ id: "a", startsAt: at(9, 2, 20), endsAt: at(9, 2, 23), ticketsSold: 148, totalCapacity: 200, venueName: "Drkmttr" }),
    event({ id: "b", startsAt: at(9, 3, 19), endsAt: at(9, 3, 21), ticketsSold: null, totalCapacity: 120, seriesId: "s" }),
    hold({ id: "h", startsAt: at(9, 3, 0), position: 2, spaceName: "Main Room" }),
  ];
  const itemsByDay = groupByDay(items, days);
  const base = { days, todayKey: "2026-09-02", timezone: TZ, viewerTimezone: TZ, mode: "internal" as const };

  it("groups by day with relative headings, counts, sold/capacity, tags and a hold row", () => {
    render(<CalendarAgendaView {...base} itemsByDay={itemsByDay} />);
    const wed = screen.getByTestId("calendar-agenda-day-2026-09-02");
    expect(wed.textContent).toContain("Wed · Sep 2 · Today");
    expect(wed.textContent).toContain("1 event");
    const thu = screen.getByTestId("calendar-agenda-day-2026-09-03");
    expect(thu.textContent).toContain("Thu · Sep 3 · Tomorrow");
    expect(thu.textContent).toContain("1 event · 1 hold");
    expect(screen.getByTestId("calendar-agenda-sold-a").textContent).toBe("148 / 200");
    expect(screen.getByTestId("calendar-agenda-sold-b").textContent).toBe("— / 120");
    expect(screen.getByTestId("calendar-agenda-row-a").textContent).toContain("8:00–11:00 PM");
    expect(screen.getByTestId("calendar-agenda-row-a").textContent).toContain("3h");
    expect(screen.getByTestId("calendar-agenda-row-a").textContent).toContain("Drkmttr");
    const holdRow = screen.getByTestId("calendar-agenda-row-h");
    expect(holdRow.textContent).toContain("Hold · #2");
    expect(holdRow.querySelector('[data-testid="calendar-hold-tag"]')?.textContent).toBe("Held");
    expect(holdRow.querySelector('[data-testid="calendar-status-tag"]')).toBeNull();
    expect(screen.queryByTestId("calendar-agenda-day-2026-09-04")).toBeNull();
    expect(screen.queryByTestId("calendar-agenda-show-more")).toBeNull();
  });

  it("Show more carries the next page label; empty window shows the empty state", () => {
    const onShowMore = vi.fn();
    const { rerender } = render(
      <CalendarAgendaView {...base} itemsByDay={itemsByDay} hasMore onShowMore={onShowMore} nextPageLabel="Sep 13 – Oct 2" />,
    );
    const more = screen.getByTestId("calendar-agenda-show-more");
    expect(more.textContent).toBe("Show more · Sep 13 – Oct 2");
    fireEvent.click(more);
    expect(onShowMore).toHaveBeenCalled();
    rerender(<CalendarAgendaView {...base} itemsByDay={new Map()} emptyLabel="No events Sep 2 – Oct 2" />);
    expect(screen.getByTestId("calendar-empty-state").textContent).toBe("No events Sep 2 – Oct 2");
  });

  it("compact rows collapse to time / title / chevron and fold sold into the meta line", () => {
    render(<CalendarAgendaView {...base} itemsByDay={itemsByDay} compact />);
    expect(screen.queryByTestId("calendar-agenda-sold-a")).toBeNull();
    const row = screen.getByTestId("calendar-agenda-row-a");
    expect(row.style.gridTemplateColumns).toBe("88px minmax(0, 1fr) 40px");
    expect(row.textContent).toContain("148 / 200");
  });

  it("shows the venue-local time for a zone mismatch", () => {
    const ny = event({ id: "ny", timezone: "America/New_York", startsAt: at(9, 2, 21, 0, "America/New_York"), endsAt: null });
    render(<CalendarAgendaView {...base} itemsByDay={groupByDay([ny], days)} />);
    const row = screen.getByTestId("calendar-agenda-row-ny");
    expect(row.textContent).toContain("9:00 PM EDT");
    expect(row.querySelector('[aria-label="Local time at the place: 9:00 PM EDT"]')).toBeTruthy();
  });
});

describe("CalendarDotGrid + CalendarDayList", () => {
  const weeks = getMonthGridWeeks(anchor, TZ);
  const items = [
    event({ id: "a" }),
    event({ id: "b", status: "DRAFT", startsAt: at(9, 5, 18), endsAt: at(9, 5, 19) }),
    hold({ id: "h" }),
    event({ id: "c", startsAt: at(9, 5, 12), endsAt: at(9, 5, 13) }),
  ];
  const itemsByDay = groupByDay(items, weeks.flat());

  it("renders dots per day (max three, hold ring) and reports the tapped day", () => {
    const onSelectDay = vi.fn();
    render(
      <CalendarDotGrid weeks={weeks} month={9} todayKey="2026-09-02" selectedKey="2026-09-02" onSelectDay={onSelectDay} itemsByDay={itemsByDay} />,
    );
    expect(screen.getByTestId("calendar-month-dotgrid")).toBeTruthy();
    const sat = screen.getByTestId("calendar-dot-2026-09-05");
    expect(sat.querySelectorAll("[data-dot]")).toHaveLength(3);
    expect(sat.querySelector('[data-dot="hold"]')).toBeTruthy();
    expect(sat.getAttribute("aria-label")).toBe("September 5, 4 items");
    expect(screen.getByTestId("calendar-dot-2026-09-02").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(sat);
    expect(onSelectDay).toHaveBeenCalledWith(expect.objectContaining({ key: "2026-09-05" }));
  });

  it("day list: heading, counts, rows, and the internal-only create button", () => {
    const day = weeks.flat().find((d) => d.key === "2026-09-05")!;
    const onCreateAt = vi.fn();
    const onItemPress = vi.fn();
    const { rerender } = render(
      <CalendarDayList day={day} items={itemsByDay.get(day.key)!} timezone={TZ} mode="internal" onCreateAt={onCreateAt} onItemPress={onItemPress} />,
    );
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Sat · Sep 5");
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("3 events · 1 hold");
    expect(screen.getByTestId("calendar-day-list-row-h").textContent).toContain("Hold · #1");
    fireEvent.click(screen.getByTestId("calendar-day-list-row-a"));
    expect(onItemPress).toHaveBeenCalledWith(items[0], expect.any(HTMLButtonElement), "2026-09-05:a");
    expect(screen.getByTestId("calendar-day-list-row-a").getAttribute("data-render-key")).toBe("2026-09-05:a");
    const create = screen.getByTestId("calendar-day-list-create-2026-09-05");
    expect(create.textContent).toContain("New event · Sep 5");
    fireEvent.click(create);
    expect(onCreateAt).toHaveBeenCalledWith(at(9, 5, 0));

    rerender(<CalendarDayList day={day} items={itemsByDay.get(day.key)!} timezone={TZ} mode="public" onCreateAt={onCreateAt} />);
    expect(screen.queryByTestId("calendar-day-list-create-2026-09-05")).toBeNull();
    expect(screen.queryByTestId("calendar-day-list-row-h")).toBeNull();
  });

  /**
   * The public embed's <600px layout IS this day list, so an ungated status
   * tag ended every row on a third-party page with "Published" — our
   * editorial vocabulary, meaningless to a ticket buyer.
   */
  it("day list: the status tag is INTERNAL — public rows carry none", () => {
    const day = weeks.flat().find((d) => d.key === "2026-09-05")!;
    const dayItems = itemsByDay.get(day.key)!;
    const { rerender } = render(
      <CalendarDayList day={day} items={dayItems} timezone={TZ} mode="internal" />,
    );
    expect(screen.getAllByTestId("calendar-status-tag").length).toBeGreaterThan(0);
    expect(screen.getByTestId("calendar-day-list").textContent).toContain("Published");
    expect(screen.getByTestId("calendar-day-list-row-a").style.gridTemplateColumns).toBe(
      "76px minmax(0, 1fr) auto",
    );

    rerender(<CalendarDayList day={day} items={dayItems} timezone={TZ} mode="public" />);
    expect(screen.queryAllByTestId("calendar-status-tag")).toHaveLength(0);
    expect(screen.queryAllByTestId("calendar-hold-tag")).toHaveLength(0);
    const list = screen.getByTestId("calendar-day-list");
    expect(list.textContent).not.toContain("Published");
    expect(list.textContent).not.toContain("Draft");
    // The tag's track goes with it — no stranded column.
    expect(screen.getByTestId("calendar-day-list-row-a").style.gridTemplateColumns).toBe(
      "76px minmax(0, 1fr)",
    );
    // The title and time still paint.
    expect(list.textContent).toContain("Event a");
  });

  /**
   * FR-022 on the surface most embed viewers actually see. Below 600px the
   * public embed renders the dot grid plus THIS list — no chips — so a
   * sold-out show looked identical to an available one on every phone.
   * Frame goes neutral, words stay at full ink (no blanket opacity).
   */
  it("day list: sold out mutes the frame and tags the row, in PUBLIC mode only", () => {
    const day = weeks.flat().find((d) => d.key === "2026-09-05")!;
    const dayItems = [
      event({ id: "so", startsAt: at(9, 5, 20), ticketsSold: 200, totalCapacity: 200, venueName: "Drkmttr" }),
      event({ id: "ok", startsAt: at(9, 5, 21), ticketsSold: 10, totalCapacity: 200 }),
    ];
    const { rerender } = render(
      <CalendarDayList day={day} items={dayItems} timezone={TZ} mode="public" />,
    );
    const sold = screen.getByTestId("calendar-day-list-row-so");
    expect(sold.getAttribute("data-sold-out")).toBe("true");
    expect(screen.getByTestId("calendar-day-list-row-so-sold-out").textContent).toBe("Sold out");
    // The neutral frame: the 12% --colorMuted wash on the row, the neutral bar
    // in place of the accent one. Never `opacity` — that took the title under AA.
    expect(sold.style.backgroundImage).toContain("--colorMuted");
    expect(sold.style.opacity).toBe("");
    expect(sold.innerHTML).toContain("--colorMuted");
    expect(sold.innerHTML).not.toContain("--accent");
    // Title, time and venue keep full ink and still paint.
    expect(sold.textContent).toContain("Event so");
    expect(sold.textContent).toContain("8:00 PM");
    expect(sold.textContent).toContain("Drkmttr");
    // aria-label REPLACES the row's text, so the tag has to reach it too.
    expect(sold.getAttribute("aria-label")).toBe("8:00 PM Event so, Sold out");

    // An available row carries neither the tag nor the wash.
    const open = screen.getByTestId("calendar-day-list-row-ok");
    expect(open.getAttribute("data-sold-out")).toBeNull();
    expect(open.style.backgroundImage).toBe("");
    expect(screen.queryByTestId("calendar-day-list-row-ok-sold-out")).toBeNull();
    expect(open.innerHTML).toContain("--accent");

    // Internal is untouched: sold/capacity is the status tag's business there.
    rerender(<CalendarDayList day={day} items={dayItems} timezone={TZ} mode="internal" />);
    const internal = screen.getByTestId("calendar-day-list-row-so");
    expect(internal.getAttribute("data-sold-out")).toBeNull();
    expect(internal.style.backgroundImage).toBe("");
    expect(screen.queryByTestId("calendar-day-list-row-so-sold-out")).toBeNull();
    expect(screen.getByTestId("calendar-day-list").textContent).not.toContain("Sold out");
    expect(internal.getAttribute("aria-label")).toBe("8:00 PM Event so");
    expect(internal.innerHTML).toContain("--accent");
  });

  it("day list: never paints price, in either mode (FR-023 is week-only)", () => {
    const day = weeks.flat().find((d) => d.key === "2026-09-05")!;
    const priced = [event({ id: "p", priceLabel: "$25", startsAt: at(9, 5, 20) })];
    for (const mode of ["internal", "public"] as const) {
      const { unmount } = render(
        <CalendarDayList day={day} items={priced} timezone={TZ} mode={mode} />,
      );
      expect(screen.getByTestId("calendar-day-list").textContent).not.toContain("$25");
      unmount();
    }
  });
});

describe("public mode drops the internal facts (agenda)", () => {
  const days = getAgendaDays(anchor, at(10, 2, 12), TZ);
  const items = [
    event({
      id: "a",
      startsAt: at(9, 2, 20),
      endsAt: at(9, 2, 23),
      ticketsSold: 148,
      totalCapacity: 200,
      venueName: "Drkmttr",
      priceLabel: "$25",
    }),
  ];
  const itemsByDay = groupByDay(items, days);
  const base = { days, todayKey: "2026-09-02", timezone: TZ, viewerTimezone: TZ };

  it("hides the status tag and the sold/capacity count on a public agenda", () => {
    const { rerender } = render(
      <CalendarAgendaView {...base} mode="internal" itemsByDay={itemsByDay} />,
    );
    expect(screen.getByTestId("calendar-agenda-sold-a").textContent).toBe("148 / 200");
    expect(screen.getByTestId("calendar-status-tag")).toBeTruthy();

    rerender(<CalendarAgendaView {...base} mode="public" itemsByDay={itemsByDay} />);
    expect(screen.queryByTestId("calendar-agenda-sold-a")).toBeNull();
    expect(screen.queryByTestId("calendar-status-tag")).toBeNull();
    const row = screen.getByTestId("calendar-agenda-row-a");
    expect(row.textContent).not.toContain("148");
    expect(row.textContent).not.toContain("Published");
    // Both tracks leave with their cells.
    expect(row.style.gridTemplateColumns).toBe("150px minmax(0, 1fr) 40px");
    // Title, time and venue still paint.
    expect(row.textContent).toContain("Event a");
    expect(row.textContent).toContain("Drkmttr");
  });

  it("keeps the sold count out of the COMPACT public meta line too", () => {
    render(<CalendarAgendaView {...base} mode="public" itemsByDay={itemsByDay} compact />);
    const row = screen.getByTestId("calendar-agenda-row-a");
    expect(row.textContent).not.toContain("148 / 200");
    expect(row.textContent).toContain("Drkmttr");
  });

  it("never paints price in the agenda, in either mode (FR-023 is week-only)", () => {
    const { rerender } = render(
      <CalendarAgendaView {...base} mode="internal" itemsByDay={itemsByDay} />,
    );
    expect(screen.getByTestId("calendar-agenda").textContent).not.toContain("$25");
    rerender(<CalendarAgendaView {...base} mode="public" itemsByDay={itemsByDay} />);
    expect(screen.getByTestId("calendar-agenda").textContent).not.toContain("$25");
  });
});

describe("row containment (320px page-overflow regression)", () => {
  const days = getAgendaDays(anchor, at(10, 2, 12), TZ);
  const items = [event({ id: "a", startsAt: at(9, 2, 20), endsAt: at(9, 2, 23) })];
  const itemsByDay = groupByDay(items, days);
  const base = { days, todayKey: "2026-09-02", timezone: TZ, viewerTimezone: TZ, mode: "internal" as const };

  /**
   * The wide agenda template's fixed tracks sum to 428px. Painted into the
   * ~240px the engine gets at a 320px viewport, that grid widened the whole
   * DOCUMENT to 500px (60px of shell/page chrome + 428 + the row's 12px
   * padding). `compact` is the intended layout there; these pins are the
   * containment that stops the row leaking whatever the layout decides.
   */
  it("the agenda row clips instead of widening its parent, in both densities", () => {
    const { rerender } = render(<CalendarAgendaView {...base} itemsByDay={itemsByDay} />);
    let row = screen.getByTestId("calendar-agenda-row-a");
    expect(row.style.gridTemplateColumns).toBe("150px minmax(0, 1fr) 110px 128px 40px");
    expect(row.style.overflow).toBe("hidden");
    expect(row.style.maxWidth).toBe("100%");
    expect(row.style.minWidth).toBe("0");

    rerender(<CalendarAgendaView {...base} itemsByDay={itemsByDay} compact />);
    row = screen.getByTestId("calendar-agenda-row-a");
    // 88 + 1fr + 40 = 128px of fixed tracks, which fits a 320px viewport.
    expect(row.style.gridTemplateColumns).toBe("88px minmax(0, 1fr) 40px");
    expect(row.style.overflow).toBe("hidden");
    expect(row.style.maxWidth).toBe("100%");
  });

  it("the day-list row clips the same way", () => {
    const weeks = getMonthGridWeeks(anchor, TZ);
    const day = weeks.flat().find((d) => d.key === "2026-09-02")!;
    render(
      <CalendarDayList
        day={day}
        items={items}
        timezone={TZ}
        mode="internal"
        onItemPress={vi.fn()}
      />,
    );
    const row = screen.getByTestId("calendar-day-list-row-a");
    expect(row.style.overflow).toBe("hidden");
    expect(row.style.maxWidth).toBe("100%");
    expect(row.style.minWidth).toBe("0");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", async () => (await import("./ui.stub")).uiStub);
vi.mock("lucide-react", async () => (await import("./ui.stub")).lucideStub);

import { CalendarFilterChips } from "../CalendarFilterChips";
import { CalendarToolbar } from "../CalendarToolbar";
import type { CalendarFilters } from "../types";

describe("CalendarToolbar", () => {
  const base = {
    view: "month" as const,
    views: ["month", "week", "agenda"] as const,
    onViewChange: vi.fn(),
    rangeLabel: "September 2026",
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToday: vi.fn(),
    timezone: "America/Chicago",
  };

  it("keeps the calendar-view-* ids inside the mode toggle, labels nav, shows the zone and overflow", () => {
    const onSelect = vi.fn();
    render(
      <CalendarToolbar {...base} views={[...base.views]} overflowActions={[{ label: "Subscribe (webcal)", onSelect }]} />,
    );
    const toggle = screen.getByTestId("calendar-view-mode-toggle");
    expect(toggle.querySelector('[data-testid="calendar-view-month"]')).toBeTruthy();
    expect(toggle.querySelector('[data-testid="calendar-view-week"]')).toBeTruthy();
    expect(toggle.querySelector('[data-testid="calendar-view-agenda"]')).toBeTruthy();
    expect(screen.queryByTestId("calendar-view-day")).toBeNull();
    fireEvent.click(screen.getByTestId("calendar-view-week"));
    expect(base.onViewChange).toHaveBeenCalledWith("week");
    fireEvent.click(screen.getByLabelText("Previous"));
    expect(base.onPrev).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Next"));
    expect(base.onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("calendar-nav-today"));
    expect(base.onToday).toHaveBeenCalled();
    expect(screen.getByTestId("calendar-nav-label").textContent).toBe("September 2026");
    expect(screen.getByTestId("calendar-timezone").textContent).toBe("America/Chicago");
    expect(screen.getByTestId("calendar-overflow").getAttribute("aria-label")).toBe("More");
    fireEvent.click(screen.getByRole("menuitem", { name: "Subscribe (webcal)" }));
    expect(onSelect).toHaveBeenCalled();
  });

  it("narrow lets the cluster wrap only as a last resort, and shortens the zone label", () => {
    render(
      <CalendarToolbar
        {...base}
        views={["month", "agenda"]}
        narrow
        overflowActions={[{ label: "Export month", onSelect: vi.fn() }]}
      />,
    );
    const controls = screen.getByTestId("calendar-toolbar-controls");
    // The zone label has a zero flex basis, so it never forces a break; the
    // cluster wraps only when the toggle and overflow button alone do not fit
    // (a nowrap row overflowed left over the card border at 320px).
    expect(controls.style.flexWrap).toBe("wrap");
    expect(controls.contains(screen.getByTestId("calendar-view-mode-toggle"))).toBe(true);
    expect(controls.contains(screen.getByTestId("calendar-timezone"))).toBe(true);
    expect(controls.contains(screen.getByTestId("calendar-overflow"))).toBe(true);
    // The zone label is the elastic part: short form, full name still announced.
    const zone = screen.getByTestId("calendar-timezone");
    expect(zone.textContent).toBe("Chicago");
    expect(zone.getAttribute("aria-label")).toBe("America/Chicago");
  });

  it("wide: the control cluster never wraps and the zone label does not grow", () => {
    render(
      <CalendarToolbar
        {...base}
        views={["month", "agenda"]}
        overflowActions={[{ label: "Export month", onSelect: vi.fn() }]}
      />,
    );
    expect(screen.getByTestId("calendar-toolbar-controls").style.flexWrap).toBe("nowrap");
    expect(screen.getByTestId("calendar-timezone").style.flexGrow).toBe("");
  });

  it("agenda hides prev / next; a two-view mount offers no agenda; no overflow without actions", () => {
    render(<CalendarToolbar {...base} view="week" views={["month", "week"]} showNav={false} />);
    expect(screen.queryByLabelText("Previous")).toBeNull();
    expect(screen.queryByLabelText("Next")).toBeNull();
    expect(screen.getByTestId("calendar-nav-today")).toBeTruthy();
    expect(screen.queryByTestId("calendar-view-agenda")).toBeNull();
    expect(screen.queryByTestId("calendar-overflow")).toBeNull();
  });
});

describe("CalendarFilterChips", () => {
  const filters: CalendarFilters = { statuses: new Set(["PUBLISHED", "DRAFT", "COMPLETED"]) };

  it("status chips carry pressed state and emit a new status set (Cancelled off by default)", () => {
    const onChange = vi.fn();
    render(<CalendarFilterChips filters={filters} onChange={onChange} options={{}} />);
    expect(screen.getByTestId("calendar-filter-status-published").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("calendar-filter-status-cancelled").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("calendar-filter-status-cancelled"));
    expect([...(onChange.mock.calls[0]![0] as CalendarFilters).statuses]).toContain("CANCELLED");
    fireEvent.click(screen.getByTestId("calendar-filter-status-draft"));
    expect([...(onChange.mock.calls[1]![0] as CalendarFilters).statuses]).not.toContain("DRAFT");
    expect(screen.queryByTestId("calendar-filter-holds")).toBeNull();
    expect(screen.queryByTestId("calendar-filter-series")).toBeNull();
    expect(screen.queryByTestId(/calendar-filter-owner-/)).toBeNull();
  });

  it("owner chips only with more than one owner; toggling narrows, restoring all clears the set", () => {
    const onChange = vi.fn();
    const owners = [
      { key: "org1", label: "Night Owls" },
      { key: "me", label: "Me" },
    ];
    const { rerender } = render(
      <CalendarFilterChips filters={filters} onChange={onChange} options={{ owners: [owners[0]!] }} />,
    );
    expect(screen.queryByTestId("calendar-filter-owner-org1")).toBeNull();
    rerender(<CalendarFilterChips filters={filters} onChange={onChange} options={{ owners }} />);
    fireEvent.click(screen.getByTestId("calendar-filter-owner-org1"));
    expect([...(onChange.mock.calls[0]![0] as CalendarFilters).owners!]).toEqual(["me"]);
    rerender(
      <CalendarFilterChips filters={{ ...filters, owners: new Set(["me"]) }} onChange={onChange} options={{ owners }} />,
    );
    expect(screen.getByTestId("calendar-filter-owner-org1").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("calendar-filter-owner-org1"));
    expect((onChange.mock.calls[1]![0] as CalendarFilters).owners).toBeUndefined();
  });

  it("holds chip and series select emit", () => {
    const onChange = vi.fn();
    render(
      <CalendarFilterChips
        filters={filters}
        onChange={onChange}
        options={{ holds: true, series: [{ id: "s1", name: "Friday Jazz" }] }}
      />,
    );
    const holds = screen.getByTestId("calendar-filter-holds");
    expect(holds.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(holds);
    expect((onChange.mock.calls[0]![0] as CalendarFilters).showHolds).toBe(false);
    fireEvent.change(screen.getByTestId("calendar-filter-series"), { target: { value: "s1" } });
    expect((onChange.mock.calls[1]![0] as CalendarFilters).seriesId).toBe("s1");
  });
});

describe("CalendarFilterChips — collapsing (event-calendar-redesign phase 2)", () => {
  const filters: CalendarFilters = { statuses: new Set(["PUBLISHED", "DRAFT", "COMPLETED"]) };
  const sixOwners = Array.from({ length: 6 }, (_, i) => ({
    key: `org${i}`,
    label: `Owner ${i}`,
  }));

  it("≤3 owners stay chips; >3 collapse into ONE owner menu with the same ids inside", () => {
    const onChange = vi.fn();
    const threeOwners = sixOwners.slice(0, 3);
    const { rerender } = render(
      <CalendarFilterChips filters={filters} onChange={onChange} options={{ owners: threeOwners }} />,
    );
    for (const o of threeOwners) {
      expect(screen.getByTestId(`calendar-filter-owner-${o.key}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("calendar-owner-menu")).toBeNull();

    rerender(
      <CalendarFilterChips filters={filters} onChange={onChange} options={{ owners: sixOwners }} />,
    );
    // The chips are gone; one 38px trigger stands in for all six.
    for (const o of sixOwners) {
      expect(screen.queryByTestId(`calendar-filter-owner-${o.key}`)).toBeNull();
    }
    const trigger = screen.getByTestId("calendar-owner-menu");
    expect(trigger.textContent).toContain("All owners");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(screen.getByTestId("calendar-owner-menu").getAttribute("aria-expanded")).toBe("true");
    // Toggling THROUGH the menu emits exactly what the chip emitted.
    fireEvent.click(screen.getByTestId("calendar-filter-owner-org0"));
    expect([...(onChange.mock.calls[0]![0] as CalendarFilters).owners!]).toEqual([
      "org1",
      "org2",
      "org3",
      "org4",
      "org5",
    ]);
  });

  it("the owner menu names the selection: one owner by name, otherwise a count", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CalendarFilterChips
        filters={{ ...filters, owners: new Set(["org2"]) }}
        onChange={onChange}
        options={{ owners: sixOwners }}
      />,
    );
    expect(screen.getByTestId("calendar-owner-menu").textContent).toContain("Owner 2");

    rerender(
      <CalendarFilterChips
        filters={{ ...filters, owners: new Set(["org2", "org3", "org4"]) }}
        onChange={onChange}
        options={{ owners: sixOwners }}
      />,
    );
    expect(screen.getByTestId("calendar-owner-menu").textContent).toContain("3 owners");
  });

  it("narrow: ONE Filters trigger, no status chips, and the panel carries every control", () => {
    const onChange = vi.fn();
    render(
      <CalendarFilterChips
        narrow
        filters={filters}
        onChange={onChange}
        options={{
          owners: sixOwners.slice(0, 2),
          holds: true,
          series: [{ id: "s1", name: "Friday Jazz" }],
          defaults: { statuses: new Set(["PUBLISHED", "DRAFT", "COMPLETED"]), showHolds: true },
        }}
      />,
    );
    // Nothing else from the filter row renders at this width.
    for (const id of [
      "calendar-filter-status-published",
      "calendar-filter-status-draft",
      "calendar-filter-status-completed",
      "calendar-filter-status-cancelled",
      "calendar-filter-holds",
      "calendar-filter-series",
      "calendar-filter-owner-org0",
      "calendar-owner-menu",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    const trigger = screen.getByTestId("calendar-filters-menu");
    // At the mount's defaults the trigger carries no count.
    expect(trigger.textContent).toBe("Filters");
    // 44px touch target (FR-010 / the DS minimum).
    expect(trigger.style.minHeight).toBe("44px");

    fireEvent.click(trigger);
    for (const id of [
      "calendar-filter-status-published",
      "calendar-filter-status-cancelled",
      "calendar-filter-holds",
      "calendar-filter-series",
      "calendar-filter-owner-org0",
      "calendar-filter-owner-org1",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // The same payloads the chips emitted.
    fireEvent.click(screen.getByTestId("calendar-filter-status-cancelled"));
    expect([...(onChange.mock.calls[0]![0] as CalendarFilters).statuses]).toContain("CANCELLED");
    fireEvent.click(screen.getByTestId("calendar-filter-holds"));
    expect((onChange.mock.calls[1]![0] as CalendarFilters).showHolds).toBe(false);
    fireEvent.change(screen.getByTestId("calendar-filter-series"), { target: { value: "s1" } });
    expect((onChange.mock.calls[2]![0] as CalendarFilters).seriesId).toBe("s1");
  });

  it("narrow: the trigger counts the facets that are off the mount's defaults", () => {
    const options = {
      holds: true,
      defaults: {
        statuses: new Set<"PUBLISHED" | "DRAFT" | "COMPLETED" | "CANCELLED">([
          "PUBLISHED",
          "DRAFT",
          "COMPLETED",
        ]),
        showHolds: true,
      },
    };
    const { rerender } = render(
      <CalendarFilterChips narrow filters={filters} onChange={vi.fn()} options={options} />,
    );
    expect(screen.getByTestId("calendar-filters-menu").textContent).toBe("Filters");

    rerender(
      <CalendarFilterChips
        narrow
        filters={{ statuses: new Set(["PUBLISHED"]), showHolds: false }}
        onChange={vi.fn()}
        options={options}
      />,
    );
    expect(screen.getByTestId("calendar-filters-menu").textContent).toBe("Filters · 2");
  });

  it("unticking the LAST owner reads as 'every owner', never as an empty calendar", () => {
    const onChange = vi.fn();
    render(
      <CalendarFilterChips
        filters={{ ...filters, owners: new Set(["org0"]) }}
        onChange={onChange}
        options={{ owners: sixOwners.slice(0, 2) }}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-filter-owner-org0"));
    expect((onChange.mock.calls[0]![0] as CalendarFilters).owners).toBeUndefined();
  });
});

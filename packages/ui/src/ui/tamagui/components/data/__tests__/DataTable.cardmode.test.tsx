import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { DataTable, type DataTableColumn } from "../DataTable";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name },
];

const renderCard = (row: Row) => <div>card-{row.name}</div>;
const getRowKey = (row: Row) => row.id;

// ── matchMedia mock ────────────────────────────────────────────────────────
// `useIsBelowMobileBreakpoint` queries `(max-width: 599px)`; this mock
// answers it according to the simulated viewport width.
const originalMatchMedia = window.matchMedia;

function setViewportWidth(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const match = /max-width:\s*(\d+)px/.exec(query);
    const matches = match ? width <= Number(match[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

beforeEach(() => {
  setViewportWidth(375);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

describe("DataTable card mode", () => {
  it("renders cards instead of a table when renderMobileCard is provided on a narrow viewport", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        testIdBase="dt"
      />,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByTestId("dt-row-a")).toBeInTheDocument();
    expect(screen.getByTestId("dt-row-b")).toBeInTheDocument();
    expect(screen.getByText("card-Alpha")).toBeInTheDocument();
    // Container keeps the same automation id as table mode.
    expect(screen.getByTestId("dt")).toBeInTheDocument();
  });

  it("keeps rendering the table on a narrow viewport when renderMobileCard is NOT provided", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        testIdBase="dt"
      />,
    );

    expect(document.querySelector("table")).not.toBeNull();
    expect(screen.queryByText("card-Alpha")).not.toBeInTheDocument();
  });

  it("renders the table on a wide viewport even when renderMobileCard is provided", () => {
    setViewportWidth(1024);

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        testIdBase="dt"
      />,
    );

    expect(document.querySelector("table")).not.toBeNull();
    expect(screen.queryByText("card-Alpha")).not.toBeInTheDocument();
  });

  it("fires onRowPress when a card is clicked", () => {
    const onRowPress = vi.fn();

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        onRowPress={onRowPress}
        testIdBase="dt"
      />,
    );

    fireEvent.click(screen.getByTestId("dt-row-b"));
    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onRowPress).toHaveBeenCalledWith(ROWS[1], 1);
  });

  it("activates a card with the keyboard (Enter) and exposes button semantics", () => {
    const onRowPress = vi.fn();

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        onRowPress={onRowPress}
        testIdBase="dt"
      />,
    );

    const card = screen.getByTestId("dt-row-a");
    expect(card).toHaveAttribute("role", "button");
    expect(card).toHaveAttribute("tabindex", "0");

    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onRowPress).toHaveBeenCalledWith(ROWS[0], 0);
  });

  it("reveals renderExpandedRow content below the tapped card", async () => {
    function Harness() {
      const [expandedId, setExpandedId] = useState<string | null>(null);
      return (
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          getRowKey={getRowKey}
          renderMobileCard={renderCard}
          onRowPress={(row) =>
            setExpandedId((prev) => (prev === row.id ? null : row.id))
          }
          renderExpandedRow={(row) =>
            expandedId === row.id ? <div>detail-{row.name}</div> : null
          }
          testIdBase="dt"
        />
      );
    }

    renderWithProvider(<Harness />);

    const card = screen.getByTestId("dt-row-a");
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("detail-Alpha")).not.toBeInTheDocument();

    fireEvent.click(card);

    expect(await screen.findByText("detail-Alpha")).toBeInTheDocument();
    expect(screen.getByTestId("dt-row-a")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("renders the search bar and filters cards in card mode", async () => {
    const searchColumns: DataTableColumn<Row>[] = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable
        columns={searchColumns}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        clientSearch
        testIdBase="dt"
      />,
    );

    // Card mode — no table, but the search bar still renders.
    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByText("card-Alpha")).toBeInTheDocument();
    expect(screen.getByText("card-Beta")).toBeInTheDocument();

    const input = screen.getByTestId("dt-search-input");
    fireEvent.change(input, { target: { value: "beta" } });

    // The search is debounced (200ms) — wait for the filter to apply.
    await waitFor(() => {
      expect(screen.queryByText("card-Alpha")).not.toBeInTheDocument();
    });
    expect(screen.getByText("card-Beta")).toBeInTheDocument();

    // Clearing restores all cards.
    fireEvent.click(screen.getByTestId("dt-search-clear"));
    await waitFor(() => {
      expect(screen.getByText("card-Alpha")).toBeInTheDocument();
    });
    expect(screen.getByText("card-Beta")).toBeInTheDocument();
  });

  it("renders the empty state in card mode", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        emptyState={<div>nothing-here</div>}
        testIdBase="dt"
      />,
    );

    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByText("nothing-here")).toBeInTheDocument();
  });

  it("does not flash the empty state while loading before the skeleton delay", () => {
    vi.useFakeTimers();
    const view = renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        emptyState={<div>nothing-here</div>}
        isLoading
        testIdBase="dt"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByText("nothing-here")).toBeNull();
    expect(screen.getByTestId("dt")).toBeInTheDocument();

    view.rerender(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        emptyState={<div>nothing-here</div>}
        isLoading={false}
        testIdBase="dt"
      />,
    );
    expect(screen.getByText("nothing-here")).toBeInTheDocument();
  });

  it("shows a card skeleton while loading (after the 200ms skeleton delay)", async () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        isLoading
        loadingRowCount={3}
        testIdBase="dt"
      />,
    );

    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="dt"] [aria-hidden="true"]')
          .length,
      ).toBeGreaterThanOrEqual(3);
    });
    expect(document.querySelector("table")).toBeNull();
  });

  it("supports checkbox selection in card mode without triggering row press", () => {
    const onRowPress = vi.fn();
    const onSelectionChange = vi.fn();

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        onRowPress={onRowPress}
        selectable={{
          selectedKeys: new Set<string>(),
          onSelectionChange,
          selectAllLabel: "Select all",
          getRowLabel: (row) => row.name,
        }}
        testIdBase="dt"
      />,
    );

    // Select-all bar keeps the table-mode automation id.
    expect(screen.getByTestId("dt-select-all")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("dt-select-a-frame"));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(Array.from(onSelectionChange.mock.calls[0][0] as Set<string>)).toEqual(
      ["a"],
    );
    // The checkbox tap must not bubble into the card press.
    expect(onRowPress).not.toHaveBeenCalled();
  });

  it("does not hijack keyboard activation of the per-card checkbox", () => {
    const onRowPress = vi.fn();
    const onSelectionChange = vi.fn();

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        onRowPress={onRowPress}
        selectable={{
          selectedKeys: new Set<string>(),
          onSelectionChange,
          selectAllLabel: "Select all",
          getRowLabel: (row) => row.name,
        }}
        testIdBase="dt"
      />,
    );

    const checkbox = screen.getByTestId("dt-select-a-frame");
    checkbox.focus();

    // Space on the focused checkbox must reach the checkbox's own handler:
    // the card must not call preventDefault (fireEvent returns false when the
    // event was cancelled) and must not treat it as a card press. (Enter is
    // cancelled by the checkbox itself per WAI-ARIA, so only Space is
    // asserted as uncancelled — neither may leak into the card press.)
    expect(fireEvent.keyDown(checkbox, { key: " " })).toBe(true);
    fireEvent.keyDown(checkbox, { key: "Enter" });
    expect(onRowPress).not.toHaveBeenCalled();

    // Arrow keys on the checkbox must not be hijacked into card navigation.
    expect(fireEvent.keyDown(checkbox, { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(checkbox);

    // Keys aimed at the card itself still activate the row press.
    const card = screen.getByTestId("dt-row-a");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onRowPress).toHaveBeenCalledWith(ROWS[0], 0);
  });

  it("renders a visible select-all label in the selection bar", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        selectable={{
          selectedKeys: new Set<string>(),
          onSelectionChange: vi.fn(),
          selectAllLabel: "Select all",
          getRowLabel: (row) => row.name,
        }}
        testIdBase="dt"
      />,
    );

    expect(screen.getByText("Select all")).toBeInTheDocument();
  });

  it("exposes list semantics with the pressable card nested inside each item", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        onRowPress={vi.fn()}
        testIdBase="dt"
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    // The pressable element (button role + testid) sits inside the listitem,
    // never on the same node — nested interactive roles are invalid.
    const card = screen.getByTestId("dt-row-a");
    expect(card).toHaveAttribute("role", "button");
    expect(items[0]).toContainElement(card);
    expect(items[0]).not.toBe(card);
  });

  it("registers a prefers-reduced-motion override for the expand reveal", async () => {
    function Harness() {
      const [expandedId, setExpandedId] = useState<string | null>(null);
      return (
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          getRowKey={getRowKey}
          renderMobileCard={renderCard}
          onRowPress={(row) =>
            setExpandedId((prev) => (prev === row.id ? null : row.id))
          }
          renderExpandedRow={(row) =>
            expandedId === row.id ? <div>detail-{row.name}</div> : null
          }
          testIdBase="dt"
        />
      );
    }

    renderWithProvider(<Harness />);
    fireEvent.click(screen.getByTestId("dt-row-a"));
    await screen.findByText("detail-Alpha");

    const styles = document.getElementById("dt-reveal-styles");
    expect(styles).not.toBeNull();
    expect(styles?.textContent).toContain("grid-template-rows 280ms");
    expect(styles?.textContent).toContain("prefers-reduced-motion: reduce");
    // The frame uses the class; the transition is no longer inline.
    const frame = document.querySelector(".dt-expand-reveal") as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.transition).toBe("");
  });
});

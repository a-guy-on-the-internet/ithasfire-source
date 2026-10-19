/**
 * "Open ledger" visual contract for the web DataTable (owner pick B,
 * 2026-10-07): rules above and below instead of a box, full-width hairlines,
 * idle sort carets that cost no width, hover = wash only, and the accent rail
 * reserved for SELECTED rows.
 */
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { DataTable, type DataTableColumn } from "../DataTable";
import {
  DT_STYLE_ID,
  ensureWebStyles,
  tableWrapperStyle,
} from "../DataTableStyles";

type Row = { id: string; name: string; count: number };

const ROWS: Row[] = [
  { id: "a", name: "Alpha", count: 3 },
  { id: "b", name: "Beta", count: 7 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name, sortable: true },
  {
    id: "count",
    header: "Attendees",
    cell: (row) => String(row.count),
    sortable: true,
    align: "right",
  },
];

const getRowKey = (row: Row) => row.id;
const renderCard = (row: Row) => <div>card-{row.name}</div>;

// ── matchMedia mock (same shape as DataTable.cardmode.test.tsx) ────────────
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
  setViewportWidth(1280);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

const HEADER_IDS: Record<string, string> = { Name: "name", Attendees: "count" };
const headerFor = (label: string) =>
  document.querySelector<HTMLTableCellElement>(
    `th[data-col-id="${HEADER_IDS[label]}"]`,
  )!;

describe("DataTable open-ledger frame (table mode)", () => {
  it("has no inline-end padding on the wrapper, so rules run full width", () => {
    expect(tableWrapperStyle(false)).toEqual({});
    expect(tableWrapperStyle(true)).toEqual({ overflow: "auto" });

    renderWithProvider(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={getRowKey} testIdBase="dt" />,
    );
    const wrapper = screen.getByTestId("dt");
    expect(wrapper.style.paddingInlineEnd).toBe("");
    expect(wrapper.style.paddingRight).toBe("");
  });

  it("draws no box of its own (TableContainer owns the top/bottom rules)", () => {
    renderWithProvider(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={getRowKey} testIdBase="dt" />,
    );
    const wrapper = screen.getByTestId("dt");
    const table = wrapper.querySelector("table")!;
    for (const el of [wrapper, table]) {
      expect(el.style.borderLeft).toBe("");
      expect(el.style.borderRight).toBe("");
      expect(el.style.border).toBe("");
    }
  });
});

describe("DataTable sort carets", () => {
  it("takes the idle double caret out of flow and hides it at rest", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={() => {}}
      />,
    );

    const idle = headerFor("Attendees").querySelector("svg")!;
    // The double-caret DOM stays (two polygons) for the existing contract.
    expect(idle.querySelectorAll("polygon")).toHaveLength(2);
    expect(idle).toHaveClass("dt-sort-caret-idle");
    expect(idle.style.position).toBe("absolute");
    expect(idle.style.opacity).toBe("0");
    // Right-aligned column: the caret hangs off the label's LEFT edge.
    expect(idle.style.right).toBe("calc(100% + 4px)");
    expect(idle.style.left).toBe("");

    const button = headerFor("Attendees").querySelector("button")!;
    expect(button.style.position).toBe("relative");
    // The caret is part of the button's hit area (no pointer-events: none)
    // and stays out of its accessible name.
    expect(idle.style.pointerEvents).toBe("");
    expect(idle.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Attendees" })).toBe(button);
  });

  it("places a left-aligned idle caret off the label's right edge", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        sort={{ columnId: "count", direction: "desc" }}
        onSortChange={() => {}}
      />,
    );
    const idle = headerFor("Name").querySelector("svg")!;
    expect(idle).toHaveClass("dt-sort-caret-idle");
    expect(idle.style.left).toBe("calc(100% + 4px)");
    expect(idle.style.right).toBe("");
  });

  it("uses a 2px offset in compact density so the caret fits 10px padding", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        density="compact"
        sort={{ columnId: "count", direction: "desc" }}
        onSortChange={() => {}}
      />,
    );
    const idle = headerFor("Name").querySelector("svg")!;
    expect(idle.style.left).toBe("calc(100% + 2px)");
  });

  it("positions the active caret out of flow and underlines the active header", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={() => {}}
      />,
    );

    const active = headerFor("Name");
    expect(active).toHaveAttribute("aria-sort", "ascending");
    const caret = active.querySelector("svg")!;
    expect(caret).not.toHaveClass("dt-sort-caret-idle");
    expect(caret.querySelectorAll("polygon")).toHaveLength(1);
    // Out of flow like the idle caret, and always visible.
    expect(caret.style.position).toBe("absolute");
    expect(caret.style.left).toBe("calc(100% + 4px)");
    expect(caret.style.opacity).toBe("");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    expect(caret.querySelector("polygon")!.getAttribute("fill")).toContain(
      "--accentText",
    );

    expect(active.style.boxShadow).toContain("inset 0 -3px 0");
    expect(active.style.boxShadow).toContain("--accent");
    // The 2px header baseline stays underneath it.
    expect(active.style.borderBottom).toContain("2px solid");

    expect(headerFor("Attendees").style.boxShadow).toBe("");
  });
});

describe("DataTable sort carets never take label width", () => {
  /** Layout-relevant inline styles of a header's button + label span. */
  const headerLayout = (colId: string) => {
    const th = document.querySelector<HTMLTableCellElement>(
      `th[data-col-id="${colId}"]`,
    )!;
    const button = th.querySelector("button")!;
    const span = button.querySelector("span")!;
    // Every child but the label is out of flow.
    const inFlow = Array.from(button.children).filter(
      (el) => (el as HTMLElement).style.position !== "absolute",
    );
    const { color: _color, ...buttonLayout } = Object.fromEntries(
      Array.from(button.style).map((k) => [k, button.style.getPropertyValue(k)]),
    );
    return { inFlow, span: span.outerHTML, buttonLayout };
  };

  it("keeps the label span the only in-flow child, sorted or not", () => {
    const sortedName = renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={() => {}}
      />,
    );
    const nameSorted = headerFor("Name");
    const nameSortedLayout = headerLayout("name");
    const countIdleLayout = headerLayout("count");
    expect(nameSorted).toHaveAttribute("aria-sort", "ascending");
    sortedName.unmount();

    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        sort={{ columnId: "count", direction: "desc" }}
        onSortChange={() => {}}
      />,
    );
    const nameIdleLayout = headerLayout("name");
    const countSortedLayout = headerLayout("count");
    expect(headerFor("Attendees")).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    for (const layout of [
      nameSortedLayout,
      nameIdleLayout,
      countSortedLayout,
      countIdleLayout,
    ]) {
      expect(layout.inFlow).toHaveLength(1);
      expect(layout.inFlow[0]!.tagName).toBe("SPAN");
      // No gap: nothing in flow to space from.
      expect(layout.buttonLayout.gap).toBeUndefined();
    }
    // Same label span and same button layout whether sorted or not (only the
    // colour changes), so the label gets the same width in both states.
    expect(nameSortedLayout.span).toBe(nameIdleLayout.span);
    expect(countSortedLayout.span).toBe(countIdleLayout.span);
    expect(nameSortedLayout.buttonLayout).toEqual(nameIdleLayout.buttonLayout);
    expect(countSortedLayout.buttonLayout).toEqual(
      countIdleLayout.buttonLayout,
    );
  });

  it("hangs a right-aligned active caret off the label's left edge (2px compact)", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        density="compact"
        sort={{ columnId: "count", direction: "asc" }}
        onSortChange={() => {}}
      />,
    );
    const caret = headerFor("Attendees").querySelector("svg")!;
    expect(caret).not.toHaveClass("dt-sort-caret-idle");
    expect(caret.style.position).toBe("absolute");
    expect(caret.style.right).toBe("calc(100% + 2px)");
    expect(caret.style.left).toBe("");
    // Still the accessible name of the button is just the label.
    expect(screen.getByRole("button", { name: "Attendees" })).toBeTruthy();
  });
});

describe("DataTable expanded row well", () => {
  it("opens with a 2px top rule and carries no accent rail", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        onRowPress={() => {}}
        renderExpandedRow={(row) =>
          row.id === "a" ? <div>detail-{row.name}</div> : null
        }
      />,
    );

    const td = screen.getByText("detail-Alpha").closest("td")!;
    expect(td.style.borderTop).toContain("2px solid");
    expect(td.style.borderTop).toContain("--borderColor");
    expect(td.style.borderBottom).toContain("1px solid");
    expect(td.style.background).toContain("--surfaceMuted");
    expect(td.style.boxShadow).toBe("");
  });
});

describe("DataTable injected row styles", () => {
  it("puts the accent rail on SELECTED rows and keeps hover a wash only", async () => {
    renderWithProvider(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={getRowKey} />,
    );
    await act(async () => {});

    expect(DT_STYLE_ID).toBe("dt-hover-styles-v4");
    const css = document.getElementById(DT_STYLE_ID)?.textContent ?? "";
    const flat = css.replace(/\s+/g, " ");

    // Hover keeps its wash...
    expect(flat).toMatch(/\.dt-row-hover:hover \{ background: [^}]*--backgroundHover/);
    // ...but no longer paints the rail.
    expect(flat).not.toContain(".dt-row-hover:hover > td:first-child");
    expect(flat).not.toContain("div.dt-row-hover:hover");

    // The rail now marks selection, in both table and card mode.
    expect(flat).toMatch(
      /\.dt-row-selected > td:first-child, div\.dt-row-selected \{ box-shadow: inset 3px 0 0 var\(--accent/,
    );

    // A hovered selected row keeps its tint over the hover wash.
    expect(flat).toMatch(
      /\.dt-row-selected\.dt-row-hover:hover \{ background: var\(--accentSoft[^}]*!important/,
    );

    // Idle caret reveal on hover/focus, with a reduced-motion override.
    expect(flat).toContain(".dt-sort-button:hover .dt-sort-caret-idle");
    expect(flat).toContain(".dt-sort-button:focus-visible .dt-sort-caret-idle");
    expect(flat).toMatch(
      /prefers-reduced-motion: reduce\) \{ \.dt-sort-caret-idle \{ transition: none/,
    );
  });

  it("gates every :hover rule to devices that can hover, never focus or drag", () => {
    document.getElementById(DT_STYLE_ID)?.remove();
    ensureWebStyles();
    const css = document.getElementById(DT_STYLE_ID)?.textContent ?? "";

    // Split out the single (hover: hover) block by brace matching.
    const start = css.indexOf("@media (hover: hover)");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const inside = css.slice(start, end);
    const outside = css.slice(0, start) + css.slice(end);
    expect(css.match(/@media \(hover: hover\)/g)).toHaveLength(1);

    // (a) iOS holds :hover after a tap, so no :hover rule may sit outside.
    expect(outside).not.toContain(":hover");
    expect(inside).toContain(".dt-row-hover:hover");
    expect(inside).toContain(".dt-sort-button:hover");
    expect(inside).toContain(".dt-resize-handle:hover::after");

    // (b) Keyboard focus and an active drag stay ungated.
    expect(outside).toContain(
      ".dt-sort-button:focus-visible .dt-sort-caret-idle",
    );
    expect(outside).toContain(".dt-resize-handle.dt-resizing::after");
    expect(inside).not.toContain("focus-visible");
    expect(inside).not.toContain("dt-resizing");
  });

  it("removes a stale older style tag so its hover rail cannot come back", () => {
    document.getElementById(DT_STYLE_ID)?.remove();
    const stale = document.createElement("style");
    stale.id = "dt-hover-styles-v2";
    stale.textContent =
      ".dt-row-hover:hover > td:first-child { box-shadow: inset 3px 0 0 red; }";
    document.head.appendChild(stale);
    expect(document.getElementById("dt-hover-styles-v2")).not.toBeNull();

    ensureWebStyles();

    expect(document.getElementById("dt-hover-styles-v2")).toBeNull();
    expect(document.getElementById(DT_STYLE_ID)).not.toBeNull();
    expect(
      document.querySelectorAll('style[id^="dt-hover-styles"]'),
    ).toHaveLength(1);
  });

  it("marks selected table rows with the selected class", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        selectable={{
          selectedKeys: new Set(["a"]),
          onSelectionChange: () => {},
        }}
      />,
    );
    const rowA = document.querySelector('tr[data-row-key="a"]')!;
    const rowB = document.querySelector('tr[data-row-key="b"]')!;
    expect(rowA).toHaveClass("dt-row-selected");
    expect(rowB).not.toHaveClass("dt-row-selected");
  });
});

describe("DataTable open-ledger frame (card mode)", () => {
  beforeEach(() => {
    setViewportWidth(375);
  });

  it("draws 2px rules above and below the list, no side borders", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        testIdBase="dt"
      />,
    );
    const list = screen.getByTestId("dt");
    expect(list.style.borderTop).toContain("2px solid");
    expect(list.style.borderBottom).toContain("2px solid");
    expect(list.style.borderLeft).toBe("");
    expect(list.style.borderRight).toBe("");
  });

  it("uses the same top/bottom frame for the loading skeleton", async () => {
    vi.useFakeTimers();
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        isLoading
        testIdBase="dt"
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    const list = screen.getByTestId("dt");
    expect(list.style.borderTop).toContain("2px solid");
    expect(list.style.borderBottom).toContain("2px solid");
    expect(list.style.borderLeft).toBe("");
    expect(list.style.borderRight).toBe("");
  });

  it("gives a selected card the selected class and no inline background", () => {
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        selectable={{
          selectedKeys: new Set(["a"]),
          onSelectionChange: () => {},
        }}
        testIdBase="dt"
      />,
    );
    const cardA = screen.getByTestId("dt-row-a");
    const cardB = screen.getByTestId("dt-row-b");
    expect(cardA).toHaveClass("dt-row-selected");
    // An inline background would override the class's accent-soft wash.
    expect(cardA.style.background).toBe("");
    expect(cardB).not.toHaveClass("dt-row-selected");
    expect(cardB.style.background).toContain("--surface");
  });

  it("lets a frame-owning wrapper take over the list's top/bottom rules", async () => {
    renderWithProvider(
      <div data-dt-frame="" data-testid="owner">
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          getRowKey={getRowKey}
          renderMobileCard={renderCard}
          testIdBase="dt"
        />
      </div>,
    );
    await act(async () => {});

    const list = screen.getByTestId("dt");
    expect(list).toHaveClass("dt-card-list");
    // Inline rules stay for first paint and for un-framed pages...
    expect(list.style.borderTop).toContain("2px solid");
    // ...and the injected rule removes them inside a frame owner.
    expect(list.matches("[data-dt-frame] .dt-card-list")).toBe(true);
    const flat = (
      document.getElementById(DT_STYLE_ID)?.textContent ?? ""
    ).replace(/\s+/g, " ");
    expect(flat).toContain(
      "[data-dt-frame] .dt-card-list { border-top: none !important; border-bottom: none !important; }",
    );
  });

  it("tags the loading skeleton list with the same class hook", async () => {
    vi.useFakeTimers();
    renderWithProvider(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={getRowKey}
        renderMobileCard={renderCard}
        isLoading
        testIdBase="dt"
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByTestId("dt")).toHaveClass("dt-card-list");
  });
});

import { renderWithProvider } from "../../../../../test/utils";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataTableColumn } from "../data/DataTable";

type Row = { id: string; name: string };

const columns: Array<DataTableColumn<Row>> = [
  {
    id: "name",
    header: "Name",
    cell: (row) => row.name,
  },
];

describe("DataTable", () => {
  // Fake timers must not outlive a test that fails before its last line.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders default empty state (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");
    renderWithProvider(<DataTable columns={columns} rows={[]} />);
    expect(screen.getByText("No items yet.")).toBeVisible();
  });

  it("opts the empty-state cell out of the fixed-layout word-break rule", async () => {
    // The injected `table[style*="table-layout: fixed"] td` rule sets
    // `word-break: break-word`; inherited by a centred empty state it shrinks
    // the block to min-content and wraps the heading a few letters per line
    // (seen live on /platform/places). The frame is fixed whenever resizable.
    const { DataTable } = await import("../data/DataTable");
    const { container } = renderWithProvider(
      <DataTable columns={columns} rows={[]} />,
    );
    const table = container.querySelector("table") as HTMLTableElement;
    expect(table.style.tableLayout).toBe("fixed");
    const cell = container.querySelector("td[colspan]") as HTMLElement;
    expect(cell.style.wordBreak).toBe("inherit");
    expect(cell.style.overflowWrap).toBe("inherit");
  });

  it("calls onSortChange when clicking header (web)", async () => {
    const onSortChange = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenCalledWith({
      columnId: "name",
      direction: "desc",
    });
  });

  it("renders a table-shaped skeleton when loading (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable<Row>
        testIdBase="table"
        columns={columns}
        rows={[{ id: "r1", name: "Alice" }]}
        getRowKey={(row) => row.id}
        isLoading
        loadingRowCount={2}
      />,
    );

    // We should render a semantic table and keep header layout stable.
    // The skeleton is intentionally delayed by 200ms (useDelayedSkeleton)
    // so fast responses never flash it. The first frame is therefore the
    // data table (also role="table", also headed "Name"), so wait on
    // something only the skeleton produces: the data row ("Alice") gone.
    await waitFor(() => {
      expect(screen.queryByText("Alice")).toBeNull();
    });
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    // `loadingRowCount` placeholder rows, none of them a keyed data row.
    const bodyRows = document.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(2);
    expect(document.querySelector("tbody tr[data-row-key]")).toBeNull();
  });

  it("does not flash the empty copy while loading before the skeleton delay (web)", async () => {
    vi.useFakeTimers();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const view = renderWithProvider(
      <DataTable<Row>
        testIdBase="flash"
        columns={columns}
        rows={[]}
        isLoading
      />,
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // Under the 200ms delay: no skeleton yet, and no "No items yet." either —
    // just the header over one blank full-width cell.
    expect(screen.queryByText("No items yet.")).toBeNull();
    expect(screen.getByText("Name")).toBeInTheDocument();
    const cells = document.querySelectorAll("tbody td");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.getAttribute("colspan")).toBe("1");

    view.rerender(
      <DataTable<Row>
        testIdBase="flash"
        columns={columns}
        rows={[]}
        isLoading={false}
      />,
    );
    expect(screen.getByText("No items yet.")).toBeInTheDocument();
  });

  // ── clientSort tests ──────────────────────────────────────────────────

  it("sorts rows by string column when clientSort is enabled (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const sortableColumns: Array<DataTableColumn<Row>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        sortValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<Row>
        testIdBase="sortable"
        columns={sortableColumns}
        rows={[
          { id: "3", name: "Charlie" },
          { id: "1", name: "Alice" },
          { id: "2", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSort
      />,
    );

    // Before sorting: original order.
    const cellsBefore = screen.getAllByTestId(/^sortable-cell-.*-name$/);
    expect(cellsBefore.map((c) => c.textContent)).toEqual([
      "Charlie",
      "Alice",
      "Bob",
    ]);

    // Click header to sort ascending.
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    const cellsAsc = screen.getAllByTestId(/^sortable-cell-.*-name$/);
    expect(cellsAsc.map((c) => c.textContent)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);

    // Click again to sort descending.
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    const cellsDesc = screen.getAllByTestId(/^sortable-cell-.*-name$/);
    expect(cellsDesc.map((c) => c.textContent)).toEqual([
      "Charlie",
      "Bob",
      "Alice",
    ]);
  });

  it("sorts rows by number column when clientSort is enabled (web)", async () => {
    type NumRow = { id: string; amount: number };

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const numCols: Array<DataTableColumn<NumRow>> = [
      {
        id: "amount",
        header: "Amount",
        cell: (row) => String(row.amount),
        sortValue: (row) => row.amount,
      },
    ];

    renderWithProvider(
      <DataTable<NumRow>
        testIdBase="num"
        columns={numCols}
        rows={[
          { id: "a", amount: 30 },
          { id: "b", amount: 10 },
          { id: "c", amount: 20 },
        ]}
        getRowKey={(row) => row.id}
        clientSort
      />,
    );

    // Sort ascending.
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    const cellsAsc = screen.getAllByTestId(/^num-cell-.*-amount$/);
    expect(cellsAsc.map((c) => c.textContent)).toEqual(["10", "20", "30"]);
  });

  it("does not render sort button for columns without sortValue when clientSort is enabled (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const mixedColumns: Array<DataTableColumn<Row>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        sortValue: (row) => row.name,
      },
      {
        id: "id",
        header: "ID",
        cell: (row) => row.id,
        // No sortValue — should not be sortable.
      },
    ];

    renderWithProvider(
      <DataTable<Row>
        testIdBase="mixed"
        columns={mixedColumns}
        rows={[{ id: "1", name: "Alice" }]}
        getRowKey={(row) => row.id}
        clientSort
      />,
    );

    // Name column should be a sort button, ID column should be plain text.
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ID" })).toBeNull();
  });

  it("pushes null values to the end regardless of sort direction (web)", async () => {
    type NullableRow = { id: string; name: string | null };

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const nullCols: Array<DataTableColumn<NullableRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name ?? "—",
        sortValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<NullableRow>
        testIdBase="nullable"
        columns={nullCols}
        rows={[
          { id: "1", name: null },
          { id: "2", name: "Alice" },
          { id: "3", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSort
      />,
    );

    // Sort ascending — null should be last.
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    const cellsAsc = screen.getAllByTestId(/^nullable-cell-.*-name$/);
    expect(cellsAsc.map((c) => c.textContent)).toEqual(["Alice", "Bob", "—"]);

    // Sort descending — null should still be last.
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    const cellsDesc = screen.getAllByTestId(/^nullable-cell-.*-name$/);
    expect(cellsDesc.map((c) => c.textContent)).toEqual(["Bob", "Alice", "—"]);
  });

  // ── clientSearch tests ─────────────────────────────────────────────────

  it("renders a search bar and filters rows when clientSearch is enabled (web)", async () => {
    vi.useFakeTimers();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string; email: string };

    const searchColumns: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
      {
        id: "email",
        header: "Email",
        cell: (row) => row.email,
        searchValue: (row) => row.email,
      },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="search"
        columns={searchColumns}
        rows={[
          { id: "1", name: "Alice Smith", email: "alice@example.com" },
          { id: "2", name: "Bob Jones", email: "bob@example.com" },
          { id: "3", name: "Charlie Brown", email: "charlie@example.com" },
        ]}
        getRowKey={(row) => row.id}
        clientSearch
      />,
    );

    // Search bar should be present.
    const input = screen.getByTestId("search-search-input");
    expect(input).toBeInTheDocument();

    // All rows visible initially.
    expect(
      screen.getAllByTestId(/^search-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Alice Smith", "Bob Jones", "Charlie Brown"]);

    // Type to search.
    fireEvent.change(input, { target: { value: "bob" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    }); // flush debounce + React state

    // Only Bob should be visible.
    expect(
      screen.getAllByTestId(/^search-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Bob Jones"]);
  });

  it("searches across multiple columns with searchValue (web)", async () => {
    vi.useFakeTimers();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string; email: string };

    const searchColumns: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
      {
        id: "email",
        header: "Email",
        cell: (row) => row.email,
        searchValue: (row) => row.email,
      },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="multi"
        columns={searchColumns}
        rows={[
          { id: "1", name: "Alice Smith", email: "alice@example.com" },
          { id: "2", name: "Bob Jones", email: "bob@example.com" },
          { id: "3", name: "Charlie Brown", email: "charlie@example.com" },
        ]}
        getRowKey={(row) => row.id}
        clientSearch
      />,
    );

    const input = screen.getByTestId("multi-search-input");

    // Search by email domain prefix should match everyone (all have @example.com).
    fireEvent.change(input, { target: { value: "example.com" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(
      screen.getAllByTestId(/^multi-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Alice Smith", "Bob Jones", "Charlie Brown"]);

    // Search by unique email prefix.
    fireEvent.change(input, { target: { value: "charlie@" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(
      screen.getAllByTestId(/^multi-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Charlie Brown"]);
  });

  it("clears search when clear button is clicked (web)", async () => {
    vi.useFakeTimers();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string };

    const cols: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="clr"
        columns={cols}
        rows={[
          { id: "1", name: "Alice" },
          { id: "2", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSearch
      />,
    );

    const input = screen.getByTestId("clr-search-input");

    // Search for Alice.
    fireEvent.change(input, { target: { value: "Alice" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(
      screen.getAllByTestId(/^clr-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Alice"]);

    // Clear button should be visible.
    const clearBtn = screen.getByTestId("clr-search-clear");
    fireEvent.click(clearBtn);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // All rows should be visible again.
    expect(
      screen.getAllByTestId(/^clr-cell-.*-name$/).map((c) => c.textContent),
    ).toEqual(["Alice", "Bob"]);
  });

  it("does not render a search bar when clientSearch is not set (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="nosearch"
        columns={columns}
        rows={[{ id: "1", name: "Alice" }]}
        getRowKey={(row) => row.id}
      />,
    );

    expect(screen.queryByTestId("nosearch-search-input")).toBeNull();
  });

  // ── redesign pass: density / scrollContainer / sort affordance ─────────

  it("defaults to comfortable density with no inner scroll wrapper (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="plain"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
      />,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("data-density", "comfortable");
    // Sticky-header fix: the automation wrapper must NOT be a scroll
    // container by default (scrolling belongs to the page's TableContainer).
    const wrapper = screen.getByTestId("plain");
    expect(wrapper.style.overflow).toBe("");
    expect(wrapper.style.overflowX).toBe("");
  });

  it("applies compact density and restores a scroll wrapper when scrollContainer is set (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="dense"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        density="compact"
        scrollContainer
      />,
    );

    expect(screen.getByRole("table")).toHaveAttribute(
      "data-density",
      "compact",
    );
    expect(screen.getByTestId("dense").style.overflow).toBe("auto");
  });

  it("hides dt-cell-sub content under compact density (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable, DT_CELL_SUB_CLASS } = await import("../data/DataTable");

    const stackedColumns: Array<DataTableColumn<Row>> = [
      {
        id: "name",
        header: "Name",
        truncate: false,
        cell: (row) => (
          <div>
            <div>{row.name}</div>
            <div className={DT_CELL_SUB_CLASS}>sub-{row.name}</div>
          </div>
        ),
      },
    ];

    renderWithProvider(
      <DataTable<Row>
        testIdBase="sub"
        columns={stackedColumns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        density="compact"
      />,
    );

    expect(screen.getByRole("table")).toHaveAttribute(
      "data-density",
      "compact",
    );
    // The injected stylesheet hides `.dt-cell-sub` under data-density=compact.
    expect(screen.getByText("sub-Ada")).not.toBeVisible();
    // Sanity: the primary line stays visible.
    expect(screen.getByText("Ada")).toBeVisible();
  });

  it("marks the active sort column via aria-sort and shows carets on sortable headers (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const sortableColumns: Array<DataTableColumn<Row>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        sortValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<Row>
        testIdBase="carets"
        columns={sortableColumns}
        rows={[
          { id: "1", name: "Ada" },
          { id: "2", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSort
      />,
    );

    const header = screen.getByRole("button", { name: "Name" });
    const th = header.closest("th")!;
    // Unsorted sortable column: persistent double-caret glyph, aria-sort=none.
    expect(th).toHaveAttribute("aria-sort", "none");
    expect(header.querySelector("svg polygon")).not.toBeNull();

    fireEvent.click(header);
    expect(th).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(header);
    expect(th).toHaveAttribute("aria-sort", "descending");
  });

  it("excludes sortable:false columns from controlled-sort affordances (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const onSortChange = vi.fn();
    const mixedColumns: Array<DataTableColumn<Row>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
      },
      {
        id: "id",
        header: "ID",
        cell: (row) => row.id,
        // Opted out — e.g. a column the server cannot sort.
        sortable: false,
      },
    ];

    renderWithProvider(
      <DataTable<Row>
        testIdBase="optout"
        columns={mixedColumns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        sort={{ columnId: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );

    // Sibling column keeps the full sort affordance in controlled mode.
    const nameHeader = screen.getByRole("button", { name: "Name" });
    expect(nameHeader.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(nameHeader.querySelector("svg polygon")).not.toBeNull();

    // Opted-out column renders a plain header: no button, no caret, no
    // aria-sort.
    expect(screen.queryByRole("button", { name: "ID" })).toBeNull();
    const idTh = screen.getByText("ID").closest("th")!;
    expect(idTh).not.toHaveAttribute("aria-sort");
    expect(idTh.querySelector("svg")).toBeNull();
  });

  it("calls onSearchChange callback with debounced value (web)", async () => {
    vi.useFakeTimers();
    const onSearchChange = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string };

    const cols: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="cb"
        columns={cols}
        rows={[
          { id: "1", name: "Alice" },
          { id: "2", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSearch
        onSearchChange={onSearchChange}
      />,
    );

    const input = screen.getByTestId("cb-search-input");
    fireEvent.change(input, { target: { value: "alice" } });

    // Not called immediately (debounced).
    expect(onSearchChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(onSearchChange).toHaveBeenCalledWith("alice");
  });

  // ── Keyboard handling (web) ────────────────────────────────────────────
  it("does not swallow Enter/Space from a control inside the row (web)", async () => {
    const onRowPress = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="kb"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        onRowPress={onRowPress}
        rowActions={{
          render: () => (
            <button type="button" aria-haspopup="menu">
              Actions
            </button>
          ),
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Actions" });
    // jsdom does not synthesize a click from Enter/Space on a button, so the
    // button's own activation can't be observed here. Not being
    // default-prevented is the proxy: preventDefault is what cancelled it.
    // fireEvent returns false when the event was default-prevented.
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(onRowPress).not.toHaveBeenCalled();
  });

  it("leaves Space on a row's selection checkbox to the checkbox (web)", async () => {
    const onRowPress = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="kbsel"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        onRowPress={onRowPress}
        selectable={{
          selectedKeys: new Set<string>(),
          onSelectionChange: vi.fn(),
          getRowLabel: (row) => `Select ${row.name}`,
        }}
      />,
    );

    const checkbox = screen.getByTestId("kbsel-select-1-frame");
    expect(checkbox.closest("tr[data-row-key]")).not.toBeNull();
    // fireEvent returns false when the event was default-prevented.
    expect(fireEvent.keyDown(checkbox, { key: " " })).toBe(true);
    expect(onRowPress).not.toHaveBeenCalled();
  });

  it("still activates the row on Enter/Space when the row itself has focus (web)", async () => {
    const onRowPress = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="kb2"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        onRowPress={onRowPress}
      />,
    );

    const row = document.querySelector<HTMLElement>("tr[data-row-key]")!;
    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onRowPress).toHaveBeenCalledWith({ id: "1", name: "Ada" }, 0);
    fireEvent.keyDown(row, { key: " " });
    expect(onRowPress).toHaveBeenCalledTimes(2);
  });

  it("makes rows tab stops only when onRowPress is provided (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    const rows = [{ id: "1", name: "Ada" }];
    const { unmount } = renderWithProvider(
      <DataTable
        testIdBase="tab1"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
      />,
    );
    expect(
      document.querySelector("tr[data-row-key]")!.hasAttribute("tabindex"),
    ).toBe(false);
    unmount();

    renderWithProvider(
      <DataTable
        testIdBase="tab2"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        onRowPress={() => {}}
      />,
    );
    expect(document.querySelector("tr[data-row-key]")).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("moves focus between rows with ArrowDown/ArrowUp (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="nav"
        columns={columns}
        rows={[
          { id: "1", name: "Ada" },
          { id: "2", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        onRowPress={() => {}}
      />,
    );

    const [first, second] = Array.from(
      document.querySelectorAll<HTMLElement>("tr[data-row-key]"),
    ) as [HTMLElement, HTMLElement];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("exposes native table/row semantics without grid roles (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    renderWithProvider(
      <DataTable
        testIdBase="sem"
        columns={columns}
        rows={[{ id: "1", name: "Ada" }]}
        getRowKey={(row) => row.id}
        onRowPress={() => {}}
      />,
    );

    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByRole("table")).not.toHaveAttribute("role");
    expect(
      document.querySelector("tr[data-row-key]")!.hasAttribute("role"),
    ).toBe(false);
    // Native <tr> still maps to the row role (header row + 1 data row).
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  // ── Select-all vs client search (web) ──────────────────────────────────
  it("select-all covers only rows visible under clientSearch and keeps hidden selections (web)", async () => {
    vi.useFakeTimers();
    const onSelectionChange = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string };
    const cols: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
    ];
    const data: PersonRow[] = [
      { id: "a", name: "Alice" },
      { id: "al", name: "Alan" },
      { id: "b", name: "Bob" },
      { id: "c", name: "Cara" },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="sel"
        columns={cols}
        rows={data}
        getRowKey={(row) => row.id}
        clientSearch
        selectable={{
          // "b" is hidden by the search and was already selected.
          selectedKeys: new Set(["b"]),
          onSelectionChange,
          // "al" is visible but not selectable.
          isRowSelectable: (row) => row.id !== "al",
          selectAllLabel: "Select all",
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("sel-search-input"), {
      target: { value: "al" },
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    // Alice + Alan visible; Bob, Cara hidden.
    expect(screen.queryByText("Bob")).toBeNull();

    fireEvent.click(screen.getByTestId("sel-select-all-frame"));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const next = onSelectionChange.mock.calls[0]![0] as Set<string>;
    // Visible selectable row added, hidden selected row preserved, hidden
    // unselected row ("c") and the non-selectable visible row ("al") absent.
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  it("deselect-all removes only visible selectable keys under clientSearch (web)", async () => {
    vi.useFakeTimers();
    const onSelectionChange = vi.fn();

    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    type PersonRow = { id: string; name: string };
    const cols: Array<DataTableColumn<PersonRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        searchValue: (row) => row.name,
      },
    ];

    renderWithProvider(
      <DataTable<PersonRow>
        testIdBase="desel"
        columns={cols}
        rows={[
          { id: "a", name: "Alice" },
          { id: "b", name: "Bob" },
        ]}
        getRowKey={(row) => row.id}
        clientSearch
        selectable={{
          selectedKeys: new Set(["a", "b"]),
          onSelectionChange,
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("desel-search-input"), {
      target: { value: "alice" },
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    fireEvent.click(screen.getByTestId("desel-select-all-frame"));
    const next = onSelectionChange.mock.calls[0]![0] as Set<string>;
    expect([...next]).toEqual(["b"]);
  });

  it("header select-all/deselect-all drop selected keys whose rows left `rows` (web)", async () => {
    vi.doMock("react-native", async () => {
      const actual = (await vi.importActual("react-native")) as Record<
        string,
        unknown
      >;
      return {
        ...actual,
        Platform: {
          ...(actual.Platform as Record<string, unknown>),
          OS: "web",
          select: (spec: Record<string, unknown>) => spec.web,
        },
      };
    });

    const { DataTable } = await import("../data/DataTable");

    // "x" was selected, then its row was refetched out of `rows` (e.g. it no
    // longer matches a server-side filter). It must not ride along into a
    // bulk action the user can no longer see.
    const data: Row[] = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ];
    const renderWith = (
      selectedKeys: Set<string>,
      onSelectionChange: (keys: Set<string>) => void,
    ) =>
      renderWithProvider(
        <DataTable
          testIdBase="stale"
          columns={columns}
          rows={data}
          getRowKey={(row) => row.id}
          selectable={{ selectedKeys, onSelectionChange }}
        />,
      );

    // Select-all: exactly the visible selectable keys, no "x".
    const onSelectAll = vi.fn();
    const first = renderWith(new Set(["x"]), onSelectAll);
    fireEvent.click(screen.getByTestId("stale-select-all-frame"));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect([...(onSelectAll.mock.calls[0]![0] as Set<string>)].sort()).toEqual([
      "a",
      "b",
    ]);
    first.unmount();

    // Deselect-all (every visible row ticked, plus stale "x"): empty set.
    const onDeselectAll = vi.fn();
    renderWith(new Set(["a", "b", "x"]), onDeselectAll);
    fireEvent.click(screen.getByTestId("stale-select-all-frame"));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
    expect((onDeselectAll.mock.calls[0]![0] as Set<string>).size).toBe(0);
  });

  describe("column resize (web)", () => {
    // ── Column resize (web) ────────────────────────────────────────────────
    // Renders a resizable one-column table whose header measures 120px, so the
    // first drag seeds a deterministic 120px start width.
    // jsdom (26) has no PointerEvent, so fireEvent's pointer helpers build a
    // plain Event and drop `clientX`. A MouseEvent named "pointer*" carries it,
    // and both React's root listener and the drag's document listeners take it.
    // Restores the getBoundingClientRect / document listener spies even when a
    // test fails before reaching its end.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const pointer = (target: EventTarget, type: string, clientX = 0) =>
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX }),
      );

    const renderResizable = async () => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });

      const { DataTable } = await import("../data/DataTable");

      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 120,
        height: 20,
        top: 0,
        left: 0,
        right: 120,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      const view = renderWithProvider(
        <DataTable
          testIdBase="rs"
          columns={columns}
          rows={[{ id: "1", name: "Ada" }]}
          getRowKey={(row) => row.id}
          resizable
        />,
      );

      const handle = document.querySelector<HTMLElement>(".dt-resize-handle")!;
      handle.setPointerCapture = vi.fn();
      const col = () =>
        document.querySelector<HTMLTableColElement>("colgroup col")!;
      return { ...view, handle, col };
    };

    it("applies every queued resize move even when release lands in the same batch (web)", async () => {
      const { handle, col } = await renderResizable();

      act(() => {
        pointer(handle, "pointerdown", 100);
      });
      expect(handle.classList.contains("dt-resizing")).toBe(true);

      // Two moves and the release in ONE batch. Each move computes its width
      // up front (no state updater reads drag state the release tears down),
      // so the last move wins: 120 + 60.
      act(() => {
        pointer(document, "pointermove", 150);
        pointer(document, "pointermove", 160);
        pointer(document, "pointerup");
      });

      // startW 120 + (160 - 100): the last move wins.
      expect(col().style.width).toBe("180px");
      expect(handle.classList.contains("dt-resizing")).toBe(false);
    });

    it("removes the exact drag listeners when unmounted mid-drag (web)", async () => {
      const { handle, unmount } = await renderResizable();

      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");
      act(() => {
        pointer(handle, "pointerdown", 100);
      });

      const added = (type: string) =>
        addSpy.mock.calls.filter((c) => c[0] === type).at(-1)?.[1];
      const onMove = added("pointermove");
      const onUp = added("pointerup");
      expect(onMove).toBeTypeOf("function");
      expect(onUp).toBeTypeOf("function");
      expect(added("pointercancel")).toBe(onUp);

      removeSpy.mockClear();
      unmount();
      expect(removeSpy).toHaveBeenCalledWith("pointermove", onMove);
      expect(removeSpy).toHaveBeenCalledWith("pointerup", onUp);
      expect(removeSpy).toHaveBeenCalledWith("pointercancel", onUp);
    });

    it("ends the drag on pointercancel (web)", async () => {
      const { handle, col } = await renderResizable();

      act(() => {
        pointer(handle, "pointerdown", 100);
      });
      act(() => {
        pointer(document, "pointermove", 150);
      });
      expect(col().style.width).toBe("170px");

      act(() => {
        pointer(document, "pointercancel");
      });
      expect(handle.classList.contains("dt-resizing")).toBe(false);

      // The drag is over: later moves no longer resize the column.
      act(() => {
        pointer(document, "pointermove", 200);
      });
      expect(col().style.width).toBe("170px");
    });

    const renderResizableTwoColumns = async () => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });
      const { DataTable } = await import("../data/DataTable");

      // 200px, not the 120px drag fallback, so the start width can only have
      // come from measuring the header.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 200,
        height: 20,
        top: 0,
        left: 0,
        right: 200,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      renderWithProvider(
        <DataTable<Row>
          testIdBase="rs2"
          columns={[
            ...columns,
            { id: "id", header: "Id", cell: (row) => row.id },
          ]}
          rows={[{ id: "1", name: "Ada" }]}
          getRowKey={(row) => row.id}
          resizable
        />,
      );
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );

      const handle = document.querySelector<HTMLElement>(".dt-resize-handle")!;
      handle.setPointerCapture = vi.fn();
      return { handle };
    };

    it("seeds every column from the live header on the first drag, not at mount (web)", async () => {
      const { handle } = await renderResizableTwoColumns();
      const cols = () =>
        Array.from(
          document.querySelectorAll<HTMLTableColElement>("colgroup col"),
        ).map((c) => c.style.width);

      // No drag yet: the columns keep their % share.
      expect(cols()).toEqual(["50%", "50%"]);

      act(() => {
        pointer(handle, "pointerdown", 100);
      });
      act(() => {
        pointer(document, "pointermove", 110);
        pointer(document, "pointerup");
      });

      // Both columns pinned at their measured 200px; the dragged one + 10.
      expect(cols()).toEqual(["210px", "200px"]);
    });

    it("leaves the table fluid when a handle is pressed and released without moving (web)", async () => {
      const { handle } = await renderResizableTwoColumns();
      const cols = () =>
        Array.from(
          document.querySelectorAll<HTMLTableColElement>("colgroup col"),
        ).map((c) => c.style.width);

      act(() => {
        pointer(handle, "pointerdown", 100);
      });
      // The press still marks the handle as active...
      expect(handle.classList.contains("dt-resizing")).toBe(true);
      act(() => {
        // Pens and touch report a move at the press point before release.
        pointer(document, "pointermove", 100);
        pointer(document, "pointerup", 100);
      });

      // ...but a click with no drag must not pin any column in px.
      expect(handle.classList.contains("dt-resizing")).toBe(false);
      expect(cols()).toEqual(["50%", "50%"]);
    });

    it("measures a column added after the first drag, keeping stored widths (web)", async () => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });
      const { DataTable } = await import("../data/DataTable");

      // The late column renders at 80px; the first two at 200px.
      const live: Record<string, number> = { name: 200, id: 200, extra: 80 };
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const width = live[this.dataset.colId ?? ""] ?? 0;
        return {
          width,
          height: 20,
          top: 0,
          left: 0,
          right: width,
          bottom: 20,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

      const base: Array<DataTableColumn<Row>> = [
        ...columns,
        { id: "id", header: "Id", cell: (row) => row.id },
      ];
      const tree = (cols: Array<DataTableColumn<Row>>) => (
        <DataTable<Row>
          testIdBase="rs3"
          columns={cols}
          rows={[{ id: "1", name: "Ada" }]}
          getRowKey={(row) => row.id}
          resizable
        />
      );
      const view = renderWithProvider(tree(base));
      const cols = () =>
        Array.from(
          document.querySelectorAll<HTMLTableColElement>("colgroup col"),
        ).map((c) => c.style.width);
      const handleAt = (i: number) => {
        const h =
          document.querySelectorAll<HTMLElement>(".dt-resize-handle")[i]!;
        h.setPointerCapture = vi.fn();
        return h;
      };

      // First drag seeds name + id (name dragged +10).
      act(() => {
        pointer(handleAt(0), "pointerdown", 100);
      });
      act(() => {
        pointer(document, "pointermove", 110);
        pointer(document, "pointerup");
      });
      expect(cols()).toEqual(["210px", "200px"]);

      // A third column appears (e.g. an actions column after a role change).
      view.rerender(
        tree([
          ...base,
          { id: "extra", header: "Extra", cell: (row) => row.name },
        ]),
      );
      expect(cols()).toHaveLength(3);
      expect(cols()[2]).not.toMatch(/px$/);

      act(() => {
        pointer(handleAt(2), "pointerdown", 100);
      });
      act(() => {
        pointer(document, "pointermove", 110);
        pointer(document, "pointerup");
      });

      // Measured 80 + 10 (not the 120 fallback); the stored widths are kept
      // even though the live header would now report 200 for "name".
      expect(cols()).toEqual(["210px", "200px", "90px"]);
    });
  });

  // ── One table frame for loading, empty and data ───────────────────────
  // The three states render through a single frame, so the header (labels,
  // padding, nowrap, sort caret, checkbox + actions columns) and the
  // <colgroup> must not drift between them — otherwise the layout shifts when
  // data lands.
  describe("table frame across states (web)", () => {
    type FrameRow = { id: string; name: string; date: string };
    type FrameState = "loading" | "empty" | "data";

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const frameColumns: Array<DataTableColumn<FrameRow>> = [
      {
        id: "name",
        header: "Name",
        cell: (row) => row.name,
        sortValue: (row) => row.name,
        width: 3,
      },
      {
        id: "date",
        header: "Date",
        cell: (row) => row.date,
        align: "right",
        noWrap: true,
      },
    ];

    const afterNextFrame = () =>
      act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );

    // Renders the same table in `state`, then reads back the parts that must
    // be identical across states.
    const captureFrame = async (state: FrameState) => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });
      const { DataTable } = await import("../data/DataTable");

      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 120,
        height: 20,
        top: 0,
        left: 0,
        right: 120,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      const view = renderWithProvider(
        <DataTable<FrameRow>
          testIdBase="frame"
          caption="People"
          columns={frameColumns}
          rows={
            state === "empty"
              ? []
              : [{ id: "r1", name: "Alice", date: "2026-10-06" }]
          }
          getRowKey={(row) => row.id}
          isLoading={state === "loading"}
          loadingRowCount={2}
          sort={{ columnId: "name", direction: "asc" }}
          onSortChange={vi.fn()}
          selectable={{
            selectedKeys: new Set<string>(),
            onSelectionChange: vi.fn(),
            selectAllLabel: "Select all",
          }}
          rowActions={{ header: "Actions", render: () => null }}
        />,
      );

      if (state === "loading") {
        // The skeleton is delayed 200ms; the first frame is the data table.
        await waitFor(() => {
          expect(document.querySelector("tbody tr[data-row-key]")).toBeNull();
        });
      }
      // Flush a frame so any deferred re-render of the <colgroup> lands.
      await afterNextFrame();

      const table = document.querySelector("table")!;
      const thead = table
        .querySelector("thead")!
        .cloneNode(true) as HTMLElement;
      // The select-all <th> is the only one without a data-col-id. Its inner
      // markup legitimately differs (disabled while there is nothing to
      // select), so compare it separately.
      const selectAllTh = thead.querySelector("th:not([data-col-id])")!;
      const selectAllDisabled =
        selectAllTh.querySelector('[data-disabled="true"]') !== null;
      selectAllTh.innerHTML = "";

      const frame = {
        wrapper: table.parentElement!.outerHTML.replace(
          table.outerHTML,
          "<table/>",
        ),
        tableStyle: table.getAttribute("style"),
        density: table.getAttribute("data-density"),
        caption: table.querySelector("caption")?.outerHTML,
        colgroup: table.querySelector("colgroup")!.outerHTML,
        thead: thead.outerHTML,
      };
      view.unmount();
      return { frame, selectAllDisabled };
    };

    it("renders an identical header, colgroup and caption in loading, empty and data states", async () => {
      const data = await captureFrame("data");
      const loading = await captureFrame("loading");
      const empty = await captureFrame("empty");

      // Guard the comparison itself: the data header carries everything the
      // other states must match.
      expect(data.frame.caption).toContain("People");
      expect(data.frame.tableStyle).toContain("table-layout: fixed");
      // Before any resize drag the columns keep their % share (name weight
      // 3, date and actions 1 each) beside the fixed-px checkbox column.
      expect(data.frame.colgroup).toContain("width: 36px");
      expect(data.frame.colgroup).toContain("width: 60%");
      expect(data.frame.colgroup).toContain("width: 20%");
      expect(data.frame.colgroup).not.toContain("120px");
      expect(data.frame.thead).toContain('aria-sort="ascending"');
      expect(data.frame.thead).toContain("<polygon");
      expect(data.frame.thead).toContain("white-space: nowrap");
      expect(data.frame.thead).toContain("Actions");

      expect(loading.frame).toEqual(data.frame);
      expect(empty.frame).toEqual(data.frame);
    });

    it("keeps percentage column widths when rows land after an empty first render (web)", async () => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });
      const { DataTable } = await import("../data/DataTable");

      // The empty first render must not pin px widths for the life of the
      // mount: with `table-layout: fixed` that stops the table following its
      // container (a scrollbar appearing, the window narrowing).
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 120,
        height: 20,
        top: 0,
        left: 0,
        right: 120,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      const table = (rows: FrameRow[], isLoading: boolean) => (
        <DataTable<FrameRow>
          testIdBase="fluid"
          columns={frameColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          isLoading={isLoading}
        />
      );
      const view = renderWithProvider(table([], true));
      await afterNextFrame();

      view.rerender(
        table([{ id: "r1", name: "Alice", date: "2026-10-06" }], false),
      );
      await afterNextFrame();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      await afterNextFrame();

      const colgroup = document.querySelector("colgroup")!.outerHTML;
      expect(colgroup).toContain("width: 75%");
      expect(colgroup).toContain("width: 25%");
      expect(colgroup).not.toContain("px");
    });

    it("disables the select-all checkbox only when there is nothing to select (web)", async () => {
      expect((await captureFrame("data")).selectAllDisabled).toBe(false);
      expect((await captureFrame("loading")).selectAllDisabled).toBe(true);
      expect((await captureFrame("empty")).selectAllDisabled).toBe(true);
    });
  });

  // ── Dev-only warnings (once per module) ───────────────────────────────
  describe("dev warnings", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    const ownWarnings = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.filter((call) =>
        String(call[0]).includes("@th/ui DataTable"),
      );

    it("warns once when selectable + clientSearch have no getRowKey (web)", async () => {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "web",
            select: (spec: Record<string, unknown>) => spec.web,
          },
        };
      });
      const { DataTable } = await import("../data/DataTable");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const table = (
        <DataTable<Row>
          columns={columns}
          rows={[{ id: "r1", name: "Alice" }]}
          clientSearch
          selectable={{
            selectedKeys: new Set<string>(),
            onSelectionChange: vi.fn(),
          }}
        />
      );
      const view = renderWithProvider(table);
      view.rerender(table);

      const warnings = ownWarnings(warn);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![0])).toContain("getRowKey");
    });

    it("does not warn when getRowKey is provided (web)", async () => {
      const { DataTable } = await import("../data/DataTable");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      renderWithProvider(
        <DataTable<Row>
          columns={columns}
          rows={[{ id: "r1", name: "Alice" }]}
          getRowKey={(row) => row.id}
          clientSearch
          selectable={{
            selectedKeys: new Set<string>(),
            onSelectionChange: vi.fn(),
          }}
        />,
      );

      expect(ownWarnings(warn)).toHaveLength(0);
    });

    it("explains the removed native renderer once, and never in production", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { warnNativeRendererRemoved } =
        await import("../data/DataTableDevWarnings");

      warnNativeRendererRemoved();
      warnNativeRendererRemoved();
      expect(ownWarnings(warn)).toHaveLength(1);
      expect(String(ownWarnings(warn)[0]![0])).toContain("2026-10-06");

      vi.resetModules();
      vi.stubEnv("NODE_ENV", "production");
      const fresh = await import("../data/DataTableDevWarnings");
      fresh.warnNativeRendererRemoved();
      vi.unstubAllEnvs();
      expect(ownWarnings(warn)).toHaveLength(1);
    });
  });
});

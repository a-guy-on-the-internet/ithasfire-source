import type { ReactNode } from "react";

export type DataTableDensity = "comfortable" | "compact";

export type DataTableTextAlign = "left" | "center" | "right";

export type DataTableCheckboxSize = "sm" | "md" | "lg";

export interface DataTableColumn<TRow> {
  /** Stable column id (used for sorting + keying). */
  id: string;
  header: ReactNode;
  /** Render cell contents for row. */
  cell: (row: TRow) => ReactNode;
  align?: DataTableTextAlign;
  /** Relative width hint, used as a CSS `width` hint via `<col>`. */
  width?: number;
  /**
   * Extract a sortable value from the row for this column.
   *
   * When `clientSort` is enabled on the DataTable, columns with a `sortValue`
   * accessor are sortable. Columns without it are rendered unsortable (no
   * clickable header). Comparison is type-aware:
   *   - `string`  → locale-insensitive lowercase compare
   *   - `number`  → numeric compare
   *   - `Date`    → `.getTime()` numeric compare
   *   - `null`/`undefined` → sorted to the end
   */
  sortValue?: (row: TRow) => string | number | Date | null | undefined;

  /**
   * Whether this column participates in sorting. Default `true` when sorting
   * is enabled; set `false` to exclude this column from sort affordances
   * (plain header — no button, no caret, no aria-sort) — use for columns the
   * server cannot sort in controlled mode.
   */
  sortable?: boolean;

  /**
   * Extract a searchable string from the row for this column.
   *
   * When `clientSearch` is enabled on the DataTable, columns with a
   * `searchValue` accessor participate in the built-in search bar.
   * The search performs a case-insensitive substring match across all
   * columns that provide this accessor.
   *
   * Return `null` or `undefined` if the row has no searchable value for
   * this column (it will simply not match on this column).
   */
  searchValue?: (row: TRow) => string | null | undefined;

  /**
   * Prevent text wrapping in this column's cells and header.
   * Useful for date/time columns or short fixed-width values.
   */
  noWrap?: boolean;

  /**
   * Force the cell to a single line with `…` ellipsis when content overflows.
   * Defaults to `true`. Set to `false` for cells that need multi-line layout
   * (e.g. cells with stacked title + subtitle). Combine with `tooltipValue`
   * to surface the full text on hover.
   */
  truncate?: boolean;

  /**
   * When provided, the cell is wrapped in a Tooltip showing this string on
   * hover. Return `null`/`undefined`/`""` to skip the tooltip for that row.
   * Designed to pair with `truncate` so users can read the full value when
   * the visible cell is clipped.
   */
  tooltipValue?: (row: TRow, rowIndex: number) => string | null | undefined;
}

export interface DataTableSortState {
  columnId: string;
  direction: "asc" | "desc";
}

export interface DataTableProps<TRow> {
  columns: Array<DataTableColumn<TRow>>;
  rows: Array<TRow>;
  /**
   * Provide a stable key for each row.
   * Defaults to the row index (fine for static lists, not for dynamic updates).
   */
  getRowKey?: (row: TRow, index: number) => string;

  caption?: string;
  showHeader?: boolean;

  /** Loading + empty states. */
  isLoading?: boolean;
  emptyState?: ReactNode;

  /**
   * Controlled sorting (caller owns state + pre-sorts `rows`).
   * Mutually exclusive with `clientSort`.
   */
  sort?: DataTableSortState;
  onSortChange?: (next: DataTableSortState) => void;

  /**
   * Enable built-in client-side sorting.
   *
   * When `true`, DataTable manages sort state internally and sorts `rows`
   * using each column's `sortValue` accessor. Columns without `sortValue`
   * are rendered as non-sortable. A stable row-index tiebreaker preserves
   * insertion order for equal values.
   *
   * Cannot be used together with `sort` / `onSortChange`.
   */
  clientSort?: boolean;

  /**
   * Enable built-in client-side search.
   *
   * When `true`, DataTable renders a search bar above the table and filters
   * `rows` using each column's `searchValue` accessor. The search is a
   * case-insensitive substring match across all searchable columns.
   * Columns without `searchValue` are excluded from search.
   *
   * Composes with `clientSort` — search is applied after sorting.
   *
   * Alternatively, set to `"controlled"` to render the search bar UI but
   * delegate filtering to the caller via `onSearchChange`.
   */
  clientSearch?: boolean | "controlled";

  /**
   * Placeholder text for the built-in search bar.
   * Only used when `clientSearch` is enabled.
   */
  clientSearchPlaceholder?: string;

  /**
   * Accessible label for the search bar's clear button.
   * Only used when `clientSearch` is enabled.
   */
  clientSearchClearLabel?: string;

  /**
   * Called when the internal search query changes.
   *
   * Useful in `clientSearch="controlled"` mode where the caller owns
   * filtering (e.g. server-side search). Also fires in `clientSearch={true}`
   * mode for analytics or external state sync.
   */
  onSearchChange?: (query: string) => void;

  /** Row interaction. */
  onRowPress?: (row: TRow, index: number) => void;

  /**
   * Expandable row detail.
   * When provided, the returned ReactNode is rendered in a full-width row
   * directly below the source row. Return `null` for collapsed rows.
   */
  renderExpandedRow?: (row: TRow, index: number) => ReactNode | null;

  /**
   * Opt-in mobile card rendering (web only).
   *
   * When provided AND the platform is web AND the viewport is narrower than
   * 600px (the app-wide mobile breakpoint), rows render as a stacked
   * vertical list of cards instead of a `<table>`. SSR-safe: the server and
   * first client render always use the table, then `matchMedia` takes over.
   * When omitted, behavior is unchanged at every width.
   *
   * Card mode preserves row semantics: `onRowPress` fires on card tap (the
   * whole card is the tap target, keyboard activatable), `renderExpandedRow`
   * reveals below the tapped card, `isLoading`/`emptyState` render
   * card-shaped equivalents, selection renders as a select-all bar plus
   * per-card checkboxes, and rows keep the `{testIdBase}-row-{key}` test id.
   *
   * Table-only concepts are NOT rendered in card mode: column headers,
   * sorting controls, column resize, and `rowActions`.
   * Surface any needed actions inside `renderMobileCard` or the expanded row.
   */
  renderMobileCard?: (row: TRow) => ReactNode;

  /**
   * Optional row actions column.
   * `render` supplies the cell contents for each row.
   */
  rowActions?: {
    header?: ReactNode;
    width?: number;
    render: (row: TRow, index: number) => ReactNode;
  };

  /**
   * Checkbox row selection.
   *
   * When provided, a checkbox column is prepended to the table.
   * The header checkbox toggles all selectable rows.
   */
  selectable?: {
    /** Currently selected row keys. */
    selectedKeys: Set<string>;
    /** Called when selection changes. */
    onSelectionChange: (next: Set<string>) => void;
    /** Optional predicate — return false to disable selection for a row. */
    isRowSelectable?: (row: TRow, index: number) => boolean;
    /**
     * Disable every selection checkbox without hiding them — e.g. while a
     * bulk mutation over the selection is in flight.
     */
    disabled?: boolean;
    /** Accessible label for the header select-all checkbox. */
    selectAllLabel?: string;
    /** Accessible label for a row's checkbox (e.g. the row's display name). */
    getRowLabel?: (row: TRow, index: number) => string;
    /**
     * Visual size of the selection checkboxes. Defaults to `"sm"` (16px),
     * the historical behavior. Pass `"lg"` (24px) on touch-heavy admin
     * surfaces where the 16px box is too small a target. The checkbox
     * column width scales to match.
     */
    checkboxSize?: DataTableCheckboxSize;
  };

  /** Automation ids */
  testIdBase?: string;
  qaId?: string;

  /** Skeleton tuning */
  loadingRowCount?: number;

  /**
   * Enable resizable columns (web only).
   *
   * When `true`, drag handles appear between column headers allowing
   * the user to adjust column widths, and the table uses
   * `table-layout: fixed`. Until the first drag, columns keep their
   * percentage share of the container (from each column's relative `width`
   * weight), so the table stays fluid. The first drag reads every rendered
   * `<th>`'s width and pins all columns in px from then on.
   *
   * Minimum column width is 32 px.
   *
   * Defaults to `true`.
   */
  resizable?: boolean;

  /**
   * Row rhythm (web table mode).
   *
   * - `"comfortable"` (default): 12px 14px cell padding.
   * - `"compact"`: 7px 10px cell padding; cells that mark their secondary
   *   line with the `dt-cell-sub` class (`DT_CELL_SUB_CLASS`) collapse to a
   *   single line.
   */
  density?: DataTableDensity;

  /**
   * Render DataTable's own `overflow: auto` scroll wrapper (web only).
   *
   * Defaults to `false`: the table expects an ancestor scroll container
   * (e.g. the admin `TableContainer`) so the sticky header sticks to the
   * box that actually scrolls — an inner `overflow` wrapper becomes the
   * scroll container itself and defeats `position: sticky`.
   *
   * Set to `true` for standalone usages with no scrolling ancestor that
   * still need horizontal overflow scrolling on narrow viewports.
   */
  scrollContainer?: boolean;
}

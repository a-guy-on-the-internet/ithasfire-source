"use client";

import { Checkbox } from "../forms/Checkbox";
import { ACTIONS_COL_ID, CHECKBOX_COL_ID } from "./DataTableColumns";
import {
  headerCellPadding,
  headerTextStyle,
  SORT_CARET_IDLE_CLASS,
  stickyHeadStyle,
} from "./DataTableStyles";
import type {
  DataTableCheckboxSize,
  DataTableColumn,
  DataTableDensity,
  DataTableSortState,
  DataTableTextAlign,
} from "./DataTableTypes";
import {
  DT_ACCENT,
  DT_ACCENT_TEXT,
  DT_BORDER_STRONG,
  DT_INK_MUTED,
} from "./tokens";

/**
 * Sort glyph, always out of flow: absolutely positioned just outside the
 * label, in the header cell's horizontal padding, so it never costs the label
 * any width and the label truncates (or not) the same whether or not the
 * column is sorted. Left/center columns hang it off the label's right edge;
 * right-aligned (numeric) columns off its left edge, so the label's right
 * edge stays flush with the numbers below.
 *
 * - Active sort column: the single active-direction caret in `accentText`,
 *   always visible.
 * - Inactive sortable column: the stacked double caret, invisible until the
 *   sort button is hovered or keyboard-focused (`SORT_CARET_IDLE_CLASS`).
 *
 * Both are aria-hidden (the button's name stays the label; `aria-sort` on the
 * th carries the state) and both sit inside the button, so they are part of
 * its hit area. Where a caret overlaps the resize handle, the handle's
 * z-index wins.
 */
function SortCaret({
  direction,
  align,
  gap,
}: {
  /** `undefined` = sortable but not the active sort column. */
  direction?: "asc" | "desc";
  align: DataTableTextAlign | undefined;
  /** Distance from the label edge to the caret, in px. */
  gap: number;
}) {
  const offset = `calc(100% + ${gap}px)`;
  const position = {
    display: "block",
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    ...(align === "right" ? { right: offset } : { left: offset }),
  } as const;

  if (direction === undefined) {
    return (
      <svg
        aria-hidden="true"
        className={SORT_CARET_IDLE_CLASS}
        width={8}
        height={11}
        viewBox="0 0 8 11"
        style={{ ...position, opacity: 0 }}
      >
        <g fill={DT_INK_MUTED}>
          <polygon points="4,0 8,5 0,5" />
          <polygon points="0,6 8,6 4,11" />
        </g>
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      width={8}
      height={11}
      viewBox="0 0 8 11"
      style={position}
    >
      {direction === "asc" ? (
        <polygon points="4,3 8,8 0,8" fill={DT_ACCENT_TEXT} />
      ) : (
        <polygon points="0,3 8,3 4,8" fill={DT_ACCENT_TEXT} />
      )}
    </svg>
  );
}

export interface DataTableSelectAll {
  checked: boolean | "indeterminate";
  onToggle: () => void;
  disabled?: boolean;
  size: DataTableCheckboxSize;
  columnPx: number;
  label?: string;
  testIdBase: string;
}

interface DataTableHeaderProps<TRow> {
  columns: Array<DataTableColumn<TRow>>;
  density: DataTableDensity;
  resizable: boolean;
  activeSort: DataTableSortState | undefined;
  isSortable: (col: DataTableColumn<TRow>) => boolean;
  onSortChange: ((next: DataTableSortState) => void) | undefined;
  onResizePointerDown: (e: React.PointerEvent, colId: string) => void;
  /** Present when the table is selectable (renders the select-all column). */
  selectAll: DataTableSelectAll | undefined;
}

/** The sticky `<thead>`. Rendered once and shared by the loading, empty and data states. */
export function DataTableHeader<TRow>({
  columns,
  density,
  resizable,
  activeSort,
  isSortable,
  onSortChange,
  onResizePointerDown,
  selectAll,
}: DataTableHeaderProps<TRow>) {
  return (
    <thead style={stickyHeadStyle}>
      <tr>
        {columns.map((col) => {
          const isActions = col.id === ACTIONS_COL_ID;
          const isCheckbox = col.id === CHECKBOX_COL_ID;

          if (isCheckbox && selectAll) {
            return (
              <th
                key={col.id}
                scope="col"
                style={{
                  textAlign: "center",
                  borderBottom: `2px solid ${DT_BORDER_STRONG}`,
                  padding: density === "compact" ? "8px 6px" : "12px 6px",
                  fontWeight: 700,
                  width: selectAll.columnPx,
                }}
              >
                <Checkbox
                  size={selectAll.size}
                  checked={selectAll.checked}
                  onCheckedChange={selectAll.onToggle}
                  disabled={selectAll.disabled}
                  aria-label={selectAll.label}
                  testIdBase={selectAll.testIdBase}
                />
              </th>
            );
          }

          const colSortable = isSortable(col) && !isActions;
          const isSorted = activeSort?.columnId === col.id;
          const nextDirection: "asc" | "desc" =
            isSorted && activeSort?.direction === "asc" ? "desc" : "asc";

          return (
            <th
              key={col.id}
              scope="col"
              data-col-id={col.id}
              aria-sort={
                colSortable
                  ? isSorted
                    ? activeSort?.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                  : undefined
              }
              style={{
                textAlign: col.align ?? "left",
                borderBottom: `2px solid ${DT_BORDER_STRONG}`,
                padding: headerCellPadding(density),
                ...headerTextStyle,
                position: resizable ? "relative" : undefined,
                whiteSpace: col.noWrap ? "nowrap" : undefined,
                // Active sort column: a 3px accent underline that sits on top
                // of the 2px header baseline (inset, so it shifts nothing).
                ...(colSortable && isSorted
                  ? { boxShadow: `inset 0 -3px 0 ${DT_ACCENT}` }
                  : {}),
              }}
            >
              {colSortable ? (
                <button
                  type="button"
                  className="dt-sort-button"
                  onClick={() =>
                    onSortChange?.({
                      columnId: col.id,
                      direction: nextDirection,
                    })
                  }
                  // Inline reset deliberately excludes `color` —
                  // inline color would beat the class-based hover
                  // color (rest color comes from `.dt-sort-button
                  // { color: inherit }`; hover from its :hover
                  // rule; active sort below wins over both).
                  style={{
                    border: "none",
                    background: "transparent",
                    margin: 0,
                    padding: 0,
                    font: "inherit",
                    letterSpacing: "inherit",
                    textTransform: "inherit",
                    cursor: "pointer",
                    // Anchors the out-of-flow caret to the label. The
                    // label span is the only in-flow child, so no gap.
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    // Never wider than the th content box — a
                    // narrow column truncates its label (span
                    // below) instead of spilling into the
                    // neighbouring column.
                    maxWidth: "100%",
                    // Active sort column: label + caret in the
                    // AA-safe accent-text rung.
                    ...(isSorted ? { color: DT_ACCENT_TEXT } : {}),
                  }}
                >
                  {/* minWidth 0 lets the label shrink inside the
                      inline-flex button; overflowing text clips
                      with an ellipsis (the caret is out of flow, so
                      it never clips and never takes label width).
                      whiteSpace is
                      inherited from the th (`nowrap` only when
                      col.noWrap), so wrapping headers keep
                      wrapping. */}
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {col.header}
                  </span>
                  <SortCaret
                    direction={isSorted ? activeSort?.direction : undefined}
                    align={col.align}
                    // 8px caret + gap must fit the cell's horizontal
                    // padding: 14px comfortable, 10px compact. Same
                    // offset sorted or not, so sorting moves nothing.
                    gap={density === "compact" ? 2 : 4}
                  />
                </button>
              ) : (
                col.header
              )}
              {resizable && !isActions && !isCheckbox && (
                <div
                  className="dt-resize-handle"
                  onPointerDown={(e) => onResizePointerDown(e, col.id)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${typeof col.header === "string" ? col.header : col.id}`}
                />
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

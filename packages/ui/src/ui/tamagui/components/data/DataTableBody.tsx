"use client";

import { Fragment, useRef } from "react";
import type { ReactNode } from "react";

import {
  ExpandRevealFrame,
  FOCUS_ROW_CLASS,
  HOVER_ROW_CLASS,
  useExpandReveal,
} from "./DataTableCardList";
import {
  DataTableActionsCell,
  DataTableCell,
  DataTableCheckboxCell,
} from "./DataTableCell";
import { ACTIONS_COL_ID, CHECKBOX_COL_ID } from "./DataTableColumns";
import { SELECTED_ROW_CLASS } from "./DataTableStyles";
import type {
  DataTableColumn,
  DataTableDensity,
  DataTableProps,
} from "./DataTableTypes";
import { DT_BORDER, DT_BORDER_SOFT, DT_SURFACE_MUTED } from "./tokens";

// ── Expandable-row animation wrapper ─────────────────────────────────────
// The reveal state machine + animated frame live in DataTableCardList so the
// card-mode renderer can share them; this wraps them in table semantics.
function ExpandableRowCell({
  content,
  colSpan,
}: {
  content: ReactNode | null;
  colSpan: number;
}) {
  const { isOpen, mounted, visualOpen, lastContent } = useExpandReveal(content);

  // Nothing to render at all (never been expanded).
  if (!mounted && !isOpen) return null;

  return (
    <tr aria-hidden={!isOpen}>
      <td
        colSpan={colSpan}
        style={{
          padding: 0,
          // Keep the border + well treatment visible while the row is
          // animating out (mounted stays true for EXPAND_MS after isOpen
          // becomes false).
          // A 2px structure rule on top opens the well under its row; the
          // accent rail is reserved for selected rows.
          borderTop: mounted ? `2px solid ${DT_BORDER}` : "none",
          borderBottom: mounted ? `1px solid ${DT_BORDER_SOFT}` : "none",
          background: mounted ? DT_SURFACE_MUTED : undefined,
        }}
      >
        <ExpandRevealFrame visualOpen={visualOpen}>
          {lastContent}
        </ExpandRevealFrame>
      </td>
    </tr>
  );
}

interface DataTableBodyProps<TRow> {
  /** Columns including the synthetic selection / actions ones. */
  columns: Array<DataTableColumn<TRow>>;
  rows: Array<TRow>;
  getRowKey: (row: TRow, index: number) => string;
  density: DataTableDensity;
  testIdBase: string;
  onRowPress: DataTableProps<TRow>["onRowPress"];
  renderExpandedRow: DataTableProps<TRow>["renderExpandedRow"];
  rowActions: DataTableProps<TRow>["rowActions"];
  selectable: DataTableProps<TRow>["selectable"];
  /** Width of the selection checkbox column (`selectionColumnPx`). */
  selectionColumnPx: number;
  onToggleRow: (key: string) => void;
}

/** Data-state `<tbody>`: keyed rows, row keyboard handling, selection, actions, expanded detail. */
export function DataTableBody<TRow>({
  columns,
  rows,
  getRowKey,
  density,
  testIdBase,
  onRowPress,
  renderExpandedRow,
  rowActions,
  selectable,
  selectionColumnPx,
  onToggleRow,
}: DataTableBodyProps<TRow>) {
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);

  const focusRow = (delta: number) => {
    const tbody = tbodyRef.current;
    if (!tbody) return;
    // Collect only real, focusable data rows (not expanded-detail rows, and
    // not rows that are inert because `onRowPress` is absent).
    const focusable = Array.from(
      tbody.querySelectorAll<HTMLTableRowElement>("tr[data-row-key][tabindex]"),
    );
    const current = focusable.findIndex((r) => r === document.activeElement);
    const next = Math.max(0, Math.min(focusable.length - 1, current + delta));
    focusable[next]?.focus();
  };

  const handleRowKeyDown = (
    e: React.KeyboardEvent<HTMLTableRowElement>,
    row: TRow,
    rowIndex: number,
  ) => {
    // Only handle keys aimed at the row itself. Keys bubbling from controls
    // inside it (row-action buttons, checkboxes, inputs, links) keep their
    // native behaviour — preventDefault here would cancel their activation.
    if (e.target !== e.currentTarget) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onRowPress?.(row, rowIndex);
        break;
      case "Escape":
        (e.currentTarget as HTMLElement).blur();
        break;
      default:
        break;
    }
  };

  const checkboxSize = selectable?.checkboxSize ?? "sm";

  return (
    <tbody ref={tbodyRef}>
      {rows.map((row, rowIndex) => {
        const key = getRowKey(row, rowIndex);
        const isSelected = Boolean(selectable?.selectedKeys.has(key));
        const expandedContent = renderExpandedRow?.(row, rowIndex) ?? null;

        return (
          <Fragment key={key}>
            <tr
              data-row-key={key}
              className={`${HOVER_ROW_CLASS} ${FOCUS_ROW_CLASS}${
                isSelected ? ` ${SELECTED_ROW_CLASS}` : ""
              }`}
              tabIndex={onRowPress ? 0 : undefined}
              onClick={onRowPress ? () => onRowPress(row, rowIndex) : undefined}
              onKeyDown={
                onRowPress
                  ? (e) => handleRowKeyDown(e, row, rowIndex)
                  : undefined
              }
              // NB: no inline `background` here — the selected-row
              // background comes from a class, and inline style
              // would silently override it.
              style={{
                cursor: onRowPress ? "pointer" : undefined,
              }}
            >
              {columns.map((col) => {
                const cellTestId = `${testIdBase}-cell-${key}-${col.id}`;

                if (col.id === ACTIONS_COL_ID && rowActions) {
                  return (
                    <DataTableActionsCell
                      key={col.id}
                      density={density}
                      testId={cellTestId}
                    >
                      {rowActions.render(row, rowIndex)}
                    </DataTableActionsCell>
                  );
                }

                if (col.id === CHECKBOX_COL_ID && selectable) {
                  return (
                    <DataTableCheckboxCell
                      key={col.id}
                      density={density}
                      testId={cellTestId}
                      columnPx={selectionColumnPx}
                      size={checkboxSize}
                      selectable={
                        selectable.isRowSelectable?.(row, rowIndex) ?? true
                      }
                      checked={isSelected}
                      disabled={selectable.disabled}
                      label={selectable.getRowLabel?.(row, rowIndex)}
                      checkboxTestIdBase={`${testIdBase}-select-${key}`}
                      onToggle={() => onToggleRow(key)}
                    />
                  );
                }

                return (
                  <DataTableCell
                    key={col.id}
                    col={col}
                    row={row}
                    rowIndex={rowIndex}
                    density={density}
                    testId={cellTestId}
                  />
                );
              })}
            </tr>
            {renderExpandedRow && (
              <ExpandableRowCell
                content={expandedContent}
                colSpan={columns.length}
              />
            )}
          </Fragment>
        );
      })}
    </tbody>
  );
}

"use client";

import type { ReactNode } from "react";

import { Checkbox } from "../forms/Checkbox";
import { Tooltip } from "../feedback/Tooltip";
import { bodyCellPadding } from "./DataTableStyles";
import type {
  DataTableCheckboxSize,
  DataTableColumn,
  DataTableDensity,
} from "./DataTableTypes";
import { DT_BORDER_SOFT } from "./tokens";

interface DataTableCellProps<TRow> {
  col: DataTableColumn<TRow>;
  row: TRow;
  rowIndex: number;
  density: DataTableDensity;
  testId: string;
}

/** A user-column body cell: alignment, single-line truncation and the optional tooltip. */
export function DataTableCell<TRow>({
  col,
  row,
  rowIndex,
  density,
  testId,
}: DataTableCellProps<TRow>) {
  const isTruncated = col.truncate !== false;
  const tooltipText = col.tooltipValue?.(row, rowIndex) || null;
  const cellNode = col.cell(row);
  const truncatedNode = isTruncated ? (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {cellNode}
    </div>
  ) : (
    cellNode
  );
  const tooltipped = tooltipText ? (
    <Tooltip
      anchor={
        <div
          style={{
            display: "block",
            width: "100%",
            minWidth: 0,
          }}
        >
          {truncatedNode}
        </div>
      }
      placement="top"
      tone="neutral"
      maxWidth={320}
    >
      {tooltipText}
    </Tooltip>
  ) : (
    truncatedNode
  );
  const singleLine = col.noWrap || isTruncated;
  return (
    <td
      data-testid={testId}
      style={{
        textAlign: col.align ?? "left",
        padding: bodyCellPadding(density),
        borderBottom: `1px solid ${DT_BORDER_SOFT}`,
        verticalAlign: "middle",
        // Right-aligned columns are numeric by
        // convention — keep digits column-aligned.
        ...(col.align === "right"
          ? { fontVariantNumeric: "tabular-nums" as const }
          : {}),
        whiteSpace: singleLine ? "nowrap" : undefined,
        overflowWrap: singleLine ? undefined : "break-word",
        wordBreak: singleLine ? undefined : "break-word",
        overflow: "hidden",
        maxWidth: isTruncated ? 0 : undefined,
      }}
    >
      {tooltipped}
    </td>
  );
}

/** The row-actions cell. Clicks stop here so action buttons don't trigger the row's `onRowPress`. */
export function DataTableActionsCell({
  density,
  testId,
  children,
}: {
  density: DataTableDensity;
  testId: string;
  children: ReactNode;
}) {
  return (
    <td
      data-testid={testId}
      style={{
        textAlign: "right",
        padding: bodyCellPadding(density),
        borderBottom: `1px solid ${DT_BORDER_SOFT}`,
        verticalAlign: "middle",
        whiteSpace: "nowrap",
      }}
      onClick={(e) => {
        // Prevent row click handlers from firing when clicking action buttons.
        e.stopPropagation();
      }}
    >
      {children}
    </td>
  );
}

interface DataTableCheckboxCellProps {
  density: DataTableDensity;
  testId: string;
  columnPx: number;
  size: DataTableCheckboxSize;
  /** False renders an empty cell (row cannot be selected). */
  selectable: boolean;
  checked: boolean;
  disabled?: boolean;
  label?: string;
  checkboxTestIdBase: string;
  onToggle: () => void;
}

/** The per-row selection checkbox cell. */
export function DataTableCheckboxCell({
  density,
  testId,
  columnPx,
  size,
  selectable,
  checked,
  disabled,
  label,
  checkboxTestIdBase,
  onToggle,
}: DataTableCheckboxCellProps) {
  return (
    <td
      data-testid={testId}
      style={{
        textAlign: "center",
        padding: density === "compact" ? "7px 6px" : "12px 6px",
        borderBottom: `1px solid ${DT_BORDER_SOFT}`,
        verticalAlign: "middle",
        width: columnPx,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {selectable ? (
        <Checkbox
          size={size}
          checked={checked}
          onCheckedChange={onToggle}
          disabled={disabled}
          aria-label={label}
          testIdBase={checkboxTestIdBase}
        />
      ) : null}
    </td>
  );
}

import type {
  DataTableCheckboxSize,
  DataTableColumn,
  DataTableProps,
} from "./DataTableTypes";

export const CHECKBOX_COL_ID = "__checkbox";
export const ACTIONS_COL_ID = "__actions";

/**
 * The user's columns plus the synthetic selection (leading) and row-actions
 * (trailing) columns. Header + body iterate this list, so those columns line
 * up with `colSpan` and the `<colgroup>` automatically.
 */
export function resolveColumns<TRow>(
  columns: Array<DataTableColumn<TRow>>,
  selectable: DataTableProps<TRow>["selectable"],
  rowActions: DataTableProps<TRow>["rowActions"],
): Array<DataTableColumn<TRow>> {
  let cols = columns;
  if (selectable) {
    const checkboxCol: DataTableColumn<TRow> = {
      id: CHECKBOX_COL_ID,
      header: "", // header checkbox rendered separately
      cell: () => null, // cell checkbox rendered separately
      align: "center" as const,
      width: 4,
    };
    cols = [checkboxCol, ...cols];
  }
  if (!rowActions) return cols;
  return [
    ...cols,
    {
      id: ACTIONS_COL_ID,
      header: rowActions.header ?? "",
      cell: () => null,
      align: "right" as const,
      width: rowActions.width,
    } satisfies DataTableColumn<TRow>,
  ];
}

/**
 * Selection checkbox column width — it tracks the visual box size so larger
 * checkboxes don't get clipped by the historical 36px column.
 */
export function selectionColumnPx(size: DataTableCheckboxSize): number {
  return size === "lg" ? 48 : size === "md" ? 40 : 36;
}

export interface DataTableColumnLayout {
  id: string;
  /** Percentage share of the flexible columns (undefined for fixed-px). */
  width: number | undefined;
  /** Fixed pixel width (the checkbox column only). */
  fixedPx: number | undefined;
}

/**
 * Per-column `<col>` sizing. Fixed-width columns (the checkbox) are excluded
 * from the flex-weight calculation so they don't steal proportional space.
 */
export function columnLayouts<TRow>(
  columns: Array<DataTableColumn<TRow>>,
  selectionColPx: number,
): DataTableColumnLayout[] {
  const FIXED_PX: Record<string, number> = {
    [CHECKBOX_COL_ID]: selectionColPx,
  };
  const flexCols = columns.filter((c) => !(c.id in FIXED_PX));
  const totalWeight = flexCols.reduce((sum, c) => sum + (c.width ?? 1), 0);
  return columns.map((col) => {
    if (col.id in FIXED_PX) {
      return { id: col.id, width: undefined, fixedPx: FIXED_PX[col.id] };
    }
    const raw = col.width ?? 1;
    const pct = totalWeight > 0 ? (raw / totalWeight) * 100 : undefined;
    return { id: col.id, width: pct, fixedPx: undefined };
  });
}

"use client";

import { useMemo, useState } from "react";

import type {
  DataTableColumn,
  DataTableProps,
  DataTableSortState,
} from "./DataTableTypes";

interface UseDataTableSortArgs<TRow> {
  columns: Array<DataTableColumn<TRow>>;
  rows: Array<TRow>;
  clientSort: boolean;
  /** Controlled sort state (ignored when `clientSort`). */
  sort: DataTableProps<TRow>["sort"];
  onSortChange: DataTableProps<TRow>["onSortChange"];
}

/**
 * Sort state + client-side sorting. With `clientSort` the hook owns the sort
 * state and returns the sorted rows; otherwise it defers to the caller's
 * controlled `sort` / `onSortChange` and returns `rows` untouched.
 */
export function useDataTableSort<TRow>({
  columns,
  rows,
  clientSort,
  sort,
  onSortChange,
}: UseDataTableSortArgs<TRow>) {
  const [internalSort, setInternalSort] = useState<DataTableSortState | null>(
    null,
  );

  const activeSort: DataTableSortState | undefined = clientSort
    ? (internalSort ?? undefined)
    : sort;

  const handleSortChange = clientSort ? setInternalSort : onSortChange;

  // A column is sortable when using clientSort only if it supplies
  // `sortValue`, or when the caller provides a controlled `onSortChange`.
  // `sortable: false` opts a column out in BOTH modes (columns the server
  // cannot sort in controlled mode render a plain header instead of a dead
  // affordance).
  const isSortable = (col: DataTableColumn<TRow>) => {
    if (col.sortable === false) return false;
    if (clientSort) return typeof col.sortValue === "function";
    return Boolean(onSortChange);
  };

  const sortedRows = useMemo(() => {
    if (!clientSort || !internalSort) return rows;

    const col = columns.find((c) => c.id === internalSort.columnId);
    if (!col?.sortValue) return rows;

    const accessor = col.sortValue;
    const dir = internalSort.direction === "asc" ? 1 : -1;

    // Tag rows with their original index for a stable tiebreaker.
    const tagged = rows.map((row, i) => ({ row, i }));

    tagged.sort((a, b) => {
      const va = accessor(a.row);
      const vb = accessor(b.row);

      // Nullish values sink to the bottom regardless of direction.
      if (va == null && vb == null) return a.i - b.i;
      if (va == null) return 1;
      if (vb == null) return -1;

      let cmp: number;
      if (typeof va === "string" && typeof vb === "string") {
        cmp = va.toLowerCase().localeCompare(vb.toLowerCase());
      } else if (va instanceof Date && vb instanceof Date) {
        cmp = va.getTime() - vb.getTime();
      } else {
        cmp = Number(va) - Number(vb);
      }

      return cmp !== 0 ? cmp * dir : a.i - b.i;
    });

    return tagged.map((t) => t.row);
  }, [clientSort, internalSort, rows, columns]);

  return { activeSort, handleSortChange, isSortable, sortedRows };
}

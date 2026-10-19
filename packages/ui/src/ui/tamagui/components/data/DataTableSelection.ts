import type { DataTableProps } from "./DataTableTypes";

type Selectable<TRow> = NonNullable<DataTableProps<TRow>["selectable"]>;

export interface DataTableSelection {
  allSelected: boolean;
  someSelected: boolean;
  toggleAll: () => void;
  toggleRow: (key: string) => void;
}

/**
 * Row-selection state derived from the caller's controlled `selectable`.
 *
 * Computed over `displayRows` (after client sort + search) with the DISPLAY
 * index — the same basis the body render passes to `isRowSelectable` /
 * `getRowKey` — so select-all never reaches rows the user cannot see.
 *
 * Plain function, not a hook: `selectable` is typically a fresh object every
 * render, so there is nothing stable to memoize against.
 */
export function resolveDataTableSelection<TRow>(
  selectable: Selectable<TRow> | undefined,
  rows: Array<TRow>,
  displayRows: Array<TRow>,
  getRowKey: (row: TRow, index: number) => string,
): DataTableSelection {
  const selectableKeys = new Set<string>();
  if (selectable) {
    displayRows.forEach((row, index) => {
      const canSelect = selectable.isRowSelectable?.(row, index) ?? true;
      if (canSelect) selectableKeys.add(getRowKey(row, index));
    });
  }

  const selectedKeys = selectable?.selectedKeys;
  let selectedCount = 0;
  for (const key of selectableKeys) {
    if (selectedKeys?.has(key)) selectedCount++;
  }
  const allSelected =
    selectableKeys.size > 0 && selectedCount === selectableKeys.size;
  const someSelected = selectedCount > 0;

  const toggleAll = () => {
    if (!selectable) return;
    // Keys of every row the table currently holds (search-hidden ones too).
    const heldRowKeys = new Set<string>();
    rows.forEach((row, index) => heldRowKeys.add(getRowKey(row, index)));
    // Start from the selected keys whose rows the table still holds, then
    // touch only the visible selectable keys. Selections of rows hidden by
    // search survive; keys whose rows have left `rows` (e.g. refetched out of
    // a filter) are dropped, as a full reset of the selection used to do.
    const next = new Set<string>();
    for (const key of selectable.selectedKeys) {
      if (heldRowKeys.has(key)) next.add(key);
    }
    if (allSelected) {
      for (const key of selectableKeys) next.delete(key);
    } else {
      for (const key of selectableKeys) next.add(key);
    }
    selectable.onSelectionChange(next);
  };

  const toggleRow = (key: string) => {
    if (!selectable) return;
    const next = new Set(selectable.selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectable.onSelectionChange(next);
  };

  return { allSelected, someSelected, toggleAll, toggleRow };
}

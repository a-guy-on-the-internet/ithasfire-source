"use client";

import { useEffect } from "react";
import { Platform } from "react-native";

import { useTranslations } from "../../../../locale";
import { Text } from "../typography/Text";
import { DataTableBody } from "./DataTableBody";
import {
  DataTableCardList,
  useIsBelowMobileBreakpoint,
} from "./DataTableCardList";
import {
  columnLayouts,
  resolveColumns,
  selectionColumnPx,
} from "./DataTableColumns";
import {
  warnNativeRendererRemoved,
  warnSelectionWithSearchNeedsRowKey,
} from "./DataTableDevWarnings";
import { DataTableFrame } from "./DataTableFrame";
import { DataTableHeader } from "./DataTableHeader";
import {
  DataTableEmptyBody,
  DataTableSkeletonBody,
} from "./DataTablePlaceholderBodies";
import { DataTableSearchBar } from "./DataTableSearchBar";
import { resolveDataTableSelection } from "./DataTableSelection";
import { ensureWebStyles } from "./DataTableStyles";
import type { DataTableProps } from "./DataTableTypes";
import { useDataTableColumnResize } from "./useDataTableColumnResize";
import { useDataTableDelayedSkeleton } from "./useDataTableDelayedSkeleton";
import { useDataTableSearch } from "./useDataTableSearch";
import { useDataTableSort } from "./useDataTableSort";

export { DT_CELL_SUB_CLASS } from "./DataTableStyles";
export type {
  DataTableColumn,
  DataTableDensity,
  DataTableProps,
  DataTableSortState,
  DataTableTextAlign,
} from "./DataTableTypes";

const isWeb = Platform.OS === "web";

/** Delay before the loading skeleton appears (see `useDataTableDelayedSkeleton`). */
const SKELETON_DELAY_MS = 200;

const indexRowKey = (_: unknown, index: number) => `row-${index}`;

export function DataTable<TRow>({
  columns,
  rows,
  getRowKey,
  caption,
  showHeader = true,
  isLoading = false,
  emptyState,
  sort,
  onSortChange,
  clientSort = false,
  clientSearch = false,
  clientSearchPlaceholder,
  clientSearchClearLabel,
  onSearchChange,
  onRowPress,
  renderExpandedRow,
  renderMobileCard,
  rowActions,
  selectable,
  testIdBase,
  qaId,
  loadingRowCount = 6,
  resizable = true,
  density = "comfortable",
  scrollContainer = false,
}: DataTableProps<TRow>) {
  const t = useTranslations();
  const rowKey = getRowKey ?? indexRowKey;
  const resolvedTestId = testIdBase ?? "data-table";
  const resolvedQaId = qaId ?? resolvedTestId;

  // Inject hover/focus CSS once for the lifetime of the page.
  useEffect(() => {
    if (isWeb) ensureWebStyles();
  }, []);

  // Mobile card mode is strictly opt-in (web + `renderMobileCard` + <600px).
  // The hook is inert (no listener, always false) unless enabled, so other
  // consumers — including the Expo apps — are unaffected.
  const cardMode = useIsBelowMobileBreakpoint(
    isWeb && Boolean(renderMobileCard),
  );

  const { tableRef, columnWidths, onResizePointerDown } =
    useDataTableColumnResize(resizable && isWeb);

  // rows → sorted → searched. Both stages hand `rows` back untouched when
  // their feature is off.
  const { activeSort, handleSortChange, isSortable, sortedRows } =
    useDataTableSort({ columns, rows, clientSort, sort, onSortChange });
  const search = useDataTableSearch({
    clientSearch,
    columns,
    rows: sortedRows,
    onSearchChange,
  });
  const displayRows = search.searchedRows;

  const selection = resolveDataTableSelection(
    selectable,
    rows,
    displayRows,
    rowKey,
  );

  // Defer the skeleton so cached / sub-200ms responses don't flash a
  // skeleton frame and immediately replace it with data — the "wickedly fast
  // flicker" we kept seeing on filter changes.
  const showSkeleton = useDataTableDelayedSkeleton(
    isLoading,
    SKELETON_DELAY_MS,
  );

  // All hooks are above: the native bail-out and card mode below must not
  // change hook order when the viewport crosses the breakpoint at runtime.
  // The native renderer was removed 2026-10-06; rebuild it if an Expo screen
  // needs a table.
  if (!isWeb) {
    warnNativeRendererRemoved();
    return null;
  }

  if (selectable && clientSearch && !getRowKey) {
    warnSelectionWithSearchNeedsRowKey();
  }

  const resolvedEmpty = emptyState ?? (
    <Text variant="body" tone="muted">
      {String(t("common.noItemsYet"))}
    </Text>
  );

  const selectionCheckboxSize = selectable?.checkboxSize ?? "sm";
  const selectionColPx = selectionColumnPx(selectionCheckboxSize);
  const loading = isLoading && showSkeleton;
  // Inside the skeleton delay there is nothing to show yet, but "No items
  // yet" would be a lie: keep the empty layout and leave out its copy.
  const emptyContent = isLoading ? null : resolvedEmpty;

  // Built-in search bar (renders in table AND card mode).
  const searchBar = search.enabled ? (
    <DataTableSearchBar
      query={search.query}
      onQueryChange={search.handleInput}
      onClear={search.clear}
      testIdBase={resolvedTestId}
      placeholder={clientSearchPlaceholder}
      clearLabel={clientSearchClearLabel}
    />
  ) : null;

  if (cardMode && renderMobileCard) {
    return (
      <>
        {searchBar}
        <DataTableCardList
          rows={displayRows}
          renderCard={renderMobileCard}
          getRowKey={rowKey}
          onRowPress={onRowPress}
          renderExpandedRow={renderExpandedRow}
          emptyState={emptyContent}
          showLoadingSkeleton={loading}
          loadingRowCount={loadingRowCount}
          testIdBase={resolvedTestId}
          qaId={resolvedQaId}
          selection={
            selectable
              ? {
                  selectedKeys: selectable.selectedKeys,
                  disabled: selectable.disabled,
                  isRowSelectable: selectable.isRowSelectable,
                  getRowLabel: selectable.getRowLabel,
                  selectAllLabel: selectable.selectAllLabel,
                  checkboxSize: selectionCheckboxSize,
                  allSelected: selection.allSelected,
                  someSelected: selection.someSelected,
                  onToggleAll: selection.toggleAll,
                  onToggleRow: selection.toggleRow,
                }
              : undefined
          }
        />
      </>
    );
  }

  // Web table: ONE frame (wrapper, <table>, caption, <colgroup>, header) for
  // every state; only the <tbody> differs. The header can't drift between
  // loading → loaded → empty, so the layout doesn't jump when data lands.
  const allColumns = resolveColumns(columns, selectable, rowActions);
  const isEmpty = displayRows.length === 0;

  const header = showHeader ? (
    <DataTableHeader
      columns={allColumns}
      density={density}
      resizable={resizable}
      activeSort={activeSort}
      isSortable={isSortable}
      onSortChange={handleSortChange}
      onResizePointerDown={onResizePointerDown}
      selectAll={
        selectable
          ? {
              checked: selection.allSelected
                ? true
                : selection.someSelected
                  ? "indeterminate"
                  : false,
              onToggle: selection.toggleAll,
              // Nothing to select while loading or empty.
              disabled: selectable.disabled || loading || isEmpty,
              size: selectionCheckboxSize,
              columnPx: selectionColPx,
              label: selectable.selectAllLabel,
              testIdBase: `${resolvedTestId}-select-all`,
            }
          : undefined
      }
    />
  ) : null;

  return (
    <>
      {searchBar}
      <DataTableFrame
        testId={resolvedTestId}
        qaId={resolvedQaId}
        density={density}
        resizable={resizable}
        scrollContainer={scrollContainer}
        caption={caption}
        tableRef={tableRef}
        columnLayouts={columnLayouts(allColumns, selectionColPx)}
        columnWidths={columnWidths}
        header={header}
      >
        {loading ? (
          <DataTableSkeletonBody
            columns={allColumns}
            density={density}
            rowCount={loadingRowCount}
          />
        ) : isEmpty ? (
          <DataTableEmptyBody columnCount={allColumns.length}>
            {emptyContent}
          </DataTableEmptyBody>
        ) : (
          <DataTableBody
            columns={allColumns}
            rows={displayRows}
            getRowKey={rowKey}
            density={density}
            testIdBase={resolvedTestId}
            onRowPress={onRowPress}
            renderExpandedRow={renderExpandedRow}
            rowActions={rowActions}
            selectable={selectable}
            selectionColumnPx={selectionColPx}
            onToggleRow={selection.toggleRow}
          />
        )}
      </DataTableFrame>
    </>
  );
}

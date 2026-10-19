"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { DataTableColumn, DataTableProps } from "./DataTableTypes";

/** How long typing must pause before the query filters rows / fires `onSearchChange`. */
const SEARCH_DEBOUNCE_MS = 200;

interface UseDataTableSearchArgs<TRow> {
  clientSearch: NonNullable<DataTableProps<TRow>["clientSearch"]>;
  columns: Array<DataTableColumn<TRow>>;
  /** Rows to filter (already sorted). */
  rows: Array<TRow>;
  onSearchChange: DataTableProps<TRow>["onSearchChange"];
}

/**
 * Search bar state + client-side filtering. `clientSearch={true}` filters
 * `rows` by each column's `searchValue`; `"controlled"` only drives the bar
 * and `onSearchChange`, leaving the rows to the caller.
 */
export function useDataTableSearch<TRow>({
  clientSearch,
  columns,
  rows,
  onSearchChange,
}: UseDataTableSearchArgs<TRow>) {
  const enabled = clientSearch === true || clientSearch === "controlled";
  const filters = clientSearch === true; // only auto-filter when not "controlled"

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInput = (value: string) => {
    setQuery(value);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      const trimmed = value.trim();
      setDebouncedQuery(trimmed);
      onSearchChange?.(trimmed);
    }, SEARCH_DEBOUNCE_MS);
  };

  const clear = () => {
    setQuery("");
    setDebouncedQuery("");
    onSearchChange?.("");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  };

  // Cancel any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const searchedRows = useMemo(() => {
    if (!filters || !debouncedQuery) return rows;
    const accessors = columns
      .filter((col) => typeof col.searchValue === "function")
      .map((col) => col.searchValue!);
    if (accessors.length === 0) return rows;
    const needle = debouncedQuery.toLowerCase();
    return rows.filter((row) =>
      accessors.some((accessor) => {
        const val = accessor(row);
        return val != null && val.toLowerCase().includes(needle);
      }),
    );
  }, [filters, debouncedQuery, rows, columns]);

  return { enabled, query, handleInput, clear, searchedRows };
}

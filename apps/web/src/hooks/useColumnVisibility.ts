"use client";

import { useState, useCallback, useMemo } from "react";

/**
 * Manages column visibility state, persisted to localStorage.
 *
 * @param storageKey  Unique key per table (e.g. "admin-orders-columns").
 * @param allColumnIds  Ordered list of all column IDs defined by the table.
 * @param defaultHidden  Column IDs hidden by default on first visit (optional).
 */
export function useColumnVisibility(
  storageKey: string,
  allColumnIds: readonly string[],
  defaultHidden: readonly string[] = [],
) {
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set(defaultHidden);
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed: string[] = JSON.parse(raw);
        return new Set(parsed);
      }
    } catch {
      // ignore corrupt data
    }
    return new Set(defaultHidden);
  });

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // storage full — non-critical
      }
    },
    [storageKey],
  );

  const toggleColumn = useCallback(
    (columnId: string) => {
      setHiddenSet((prev) => {
        const next = new Set(prev);
        if (next.has(columnId)) {
          next.delete(columnId);
        } else {
          // Don't allow hiding ALL columns — keep at least one
          if (next.size >= allColumnIds.length - 1) return prev;
          next.add(columnId);
        }
        persist(next);
        return next;
      });
    },
    [allColumnIds.length, persist],
  );

  const showAll = useCallback(() => {
    const next = new Set<string>();
    setHiddenSet(next);
    persist(next);
  }, [persist]);

  const isVisible = useCallback(
    (columnId: string) => !hiddenSet.has(columnId),
    [hiddenSet],
  );

  const visibleColumnIds = useMemo(
    () => allColumnIds.filter((id) => !hiddenSet.has(id)),
    [allColumnIds, hiddenSet],
  );

  const hasHidden = hiddenSet.size > 0;

  return {
    hiddenSet,
    toggleColumn,
    showAll,
    isVisible,
    visibleColumnIds,
    hasHidden,
  } as const;
}

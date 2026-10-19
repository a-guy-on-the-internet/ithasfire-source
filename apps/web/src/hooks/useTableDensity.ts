"use client";

import { useCallback, useState } from "react";
import type { DataTableDensity } from "@th/ui";

/**
 * Manages a DataTable's row-density preference, persisted to localStorage.
 *
 * @param storageKey  Unique key per table, mirroring `useColumnVisibility`'s
 *                    pattern (e.g. "admin-orders-density").
 * @param defaultDensity  Density used on first visit (default "comfortable").
 */
export function useTableDensity(
  storageKey: string,
  defaultDensity: DataTableDensity = "comfortable",
) {
  const [density, setDensity] = useState<DataTableDensity>(() => {
    if (typeof window === "undefined") return defaultDensity;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === "comfortable" || raw === "compact") return raw;
    } catch {
      // ignore corrupt/unavailable storage
    }
    return defaultDensity;
  });

  const toggleDensity = useCallback(() => {
    setDensity((prev) => {
      const next: DataTableDensity =
        prev === "compact" ? "comfortable" : "compact";
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // storage full — non-critical
      }
      return next;
    });
  }, [storageKey]);

  return { density, toggleDensity } as const;
}

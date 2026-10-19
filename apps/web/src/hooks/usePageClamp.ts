"use client";

import { useEffect } from "react";

export interface UsePageClampOptions {
  /** Current zero-based page index. */
  page: number;
  /**
   * Total page count derived from the settled dataset. `0`/`undefined`
   * (nothing loaded yet, or an empty dataset) never clamps.
   */
  totalPages: number | undefined;
  /**
   * Pass the query's `isFetching` so the clamp only runs after data
   * settles — clamping against a placeholder/previous dataset mid-refetch
   * would fight the incoming result.
   */
  isFetching?: boolean;
  /** Page setter (zero-based). Must be referentially stable. */
  setPage: (page: number) => void;
}

/**
 * Snaps an out-of-range page back to the last real page once data settles.
 *
 * A stale or shared URL (`?p=3`) against a since-shrunken dataset otherwise
 * strands the table: the server returns `items: []` and the page shows a
 * misleading "no items yet" empty state. On consumers that hide the pager at
 * one page there is no escape hatch at all; on those that always render it
 * (sell/listings, sell/claims, sell/payouts) prev/next still collapse, so the
 * user can see the pager but not use it to get back.
 *
 * Fires once per out-of-range state (the clamped page is in range, so the
 * effect's re-run is a no-op) and never loops on `totalPages` of `0` or
 * `undefined` during load.
 *
 * Callers should pass `undefined` — not a floor of `1` — whenever the query
 * has no settled data. A FAILED query reports `data: undefined` with
 * `isLoading`/`isFetching` both false, so a `total ?? 0` derived page count
 * would look like a real one-page dataset and silently rewrite a deep-linked
 * `?p=5` out of the URL on a transient API error.
 */
export function usePageClamp({
  page,
  totalPages,
  isFetching = false,
  setPage,
}: UsePageClampOptions) {
  useEffect(() => {
    if (isFetching) return;
    if (totalPages === undefined || totalPages <= 0) return;
    if (page >= totalPages) setPage(totalPages - 1);
  }, [page, totalPages, isFetching, setPage]);
}

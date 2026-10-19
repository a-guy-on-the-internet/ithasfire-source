"use client";

import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type {
  GetPayeeStatementOutput,
  PayeeStatementEntry,
} from "@th/core/use-cases/payouts/get-payee-statement";

import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Offset paging that APPENDS. The ledger is one continuous statement, so
// "Load more" adds the next page under the last rather than replacing it.
// Each loaded offset is its own query (`trpc.useQueries`), which keeps every
// page cached, refetchable and retryable without copying rows into local
// state — the only state here is the list of offsets asked for.
//
// Four things the page above relies on:
//
//   * `hasMore` is about what is LOADED, not what was asked for. A LATER page
//     that has not arrived (or failed) counts as "more behind", because the
//     oldest visible row's balance movement is only exact when nothing is
//     behind it; treating an in-flight page as "nothing behind" would read
//     the ledger's opening zero as that row's older balance. Page 0's own
//     pendency is NOT "more behind" — it is the ledger not being here yet,
//     which `isLoading` reports and the table renders as a skeleton.
//   * `canLoadMore` is separate from `hasMore`: at the use case's offset cap
//     the server answers `hasMore: true, nextOffset: null` — more exists, but
//     not through this view — and the button must not render as a no-op.
//   * Entries are DEDUPED by id, first occurrence wins. Offset pages over a
//     head-growing list can OVERLAP after a refetch (a new credit lands, page
//     1 is fetched after page 0, the row that was at index 24 is now at 25
//     and arrives twice); the rows are the same ledger rows, so the trade-off
//     is one row rendered once at its newest position rather than twice with
//     a duplicate key.
//   * The mirror case is a GAP: page 0 refetched AFTER page 1 was fetched,
//     with a new row on top, pushes its old last row into page 1's window —
//     and stale page 1 still starts one row later, so that row is on neither
//     page. Nothing here can fill it (that needs page 1 to refetch, which
//     `refetch()` does for every page). What it MUST not do is let the row
//     above the seam read the row below it as adjacent: its Change would
//     render `balanceAfter(a) − balanceAfter(c)`, a two-row movement dressed
//     as one. So a seam whose older page is STALER than the newer page, with
//     no overlap to prove contiguity, is reported in `unconfirmedSeams` and
//     the row above it falls back to its type-derived direction. An in-order
//     load (every later page fetched after the one before it) cannot gap, so
//     the normal path keeps every movement exact. Across a Refresh the flag
//     can alternate — page 0 usually resolves after page 1 (it does more
//     reads), so the seam row briefly reads type-derived until page 1 lands.
//     Accepted: conservative for a moment beats a wrong figure for a moment.
//   * A FAILED REFETCH of page 0 keeps its data (React Query retains the last
//     result). That is reported as `refreshError`, not `error`: the rows are
//     still true as of the last successful load and must stay on screen with
//     a note, never be replaced by an "unavailable" block.
// ─────────────────────────────────────────────────────────────────────────────

export const STATEMENT_PAGE_SIZE = 25;

export type StatementScope = { kind: "org"; orgId: string } | { kind: "human" };

type StatementPages = {
  /** The first page — the headline fields live here. Undefined until loaded. */
  first: GetPayeeStatementOutput | undefined;
  /** Every loaded page's entries, in offset order, deduped by id. */
  entries: PayeeStatementEntry[];
  /**
   * Indices into `entries` of rows sitting directly ABOVE a page seam whose
   * contiguity could not be confirmed (see the header). Their balance
   * movement must not be read from the row below.
   */
  unconfirmedSeams: ReadonlySet<number>;
  /** Rows exist behind the last LOADED row (or a later page is in flight). */
  hasMore: boolean;
  /** The last loaded page offered a next offset. */
  canLoadMore: boolean;
  /** False if ANY loaded page could not carry running balances. */
  balanceAfterResolved: boolean;
  /** Page 0 has not arrived. */
  isLoading: boolean;
  isLoadingMore: boolean;
  /** Page 0 failed with NOTHING to show — the ledger cannot render. */
  error: unknown;
  /** Page 0 failed to REFRESH but still holds its last result — rows stay. */
  refreshError: unknown;
  /** A later page's error — the rows above it stay. */
  loadMoreError: unknown;
  loadMore: () => void;
  refetch: () => void;
};

export function useStatementPages(scope: StatementScope | null): StatementPages {
  const scopeKey =
    scope === null ? null : scope.kind === "org" ? `org:${scope.orgId}` : "human";
  const [offsets, setOffsets] = useState<{ key: string | null; list: number[] }>(
    { key: scopeKey, list: [0] },
  );
  // A scope change resets to the first page. Derived during render (not in
  // an effect) so the new scope's first page is requested on the same pass.
  const activeOffsets = offsets.key === scopeKey ? offsets.list : [0];
  if (offsets.key !== scopeKey) {
    setOffsets({ key: scopeKey, list: [0] });
  }

  const results = trpc.useQueries((q) =>
    activeOffsets.map((offset) =>
      q.payouts.getStatement(
        scope?.kind === "org"
          ? { orgId: scope.orgId, limit: STATEMENT_PAGE_SIZE, offset }
          : { limit: STATEMENT_PAGE_SIZE, offset },
        {
          enabled: scope !== null,
          staleTime: 30_000,
          placeholderData: keepPreviousData,
        },
      ),
    ),
  );

  return useMemo(() => {
    const first = results[0]?.data;
    const laterResults = results.slice(1);
    // Only LATER pages: page 0 pending is "not here yet", not "more behind".
    const pendingLater = laterResults.some((result) => result.data === undefined);

    // Loaded pages in offset order, each with when it was fetched.
    const loaded = results.flatMap((result) =>
      result.data === undefined
        ? []
        : [{ page: result.data, updatedAt: result.dataUpdatedAt ?? 0 }],
    );
    const lastLoaded = loaded[loaded.length - 1]?.page;

    const seen = new Set<string>();
    const entries: PayeeStatementEntry[] = [];
    const unconfirmedSeams = new Set<number>();
    loaded.forEach(({ page, updatedAt }, pageIndex) => {
      let overlapped = false;
      for (const entry of page.entries) {
        if (seen.has(entry.id)) {
          overlapped = true;
          continue;
        }
        seen.add(entry.id);
        entries.push(entry);
      }
      // The seam BEFORE this page: confirmed by an overlap, or by this page
      // having been fetched no earlier than the one above it.
      // An EMPTY later page proves nothing about the seam either way, and
      // has no row to be adjacent to — never flag on it.
      const previous = loaded[pageIndex - 1];
      if (
        previous &&
        !overlapped &&
        page.entries.length > 0 &&
        previous.updatedAt > updatedAt &&
        entries.length > page.entries.length
      ) {
        const firstOfThisPage = entries.length - page.entries.length;
        unconfirmedSeams.add(firstOfThisPage - 1);
      }
    });

    const balanceAfterResolved = loaded.every(
      ({ page }) => page.balanceAfterResolved,
    );
    const firstResult = results[0];
    const failedLater = laterResults.find((result) => result.error != null);
    const nextOffset = lastLoaded?.nextOffset ?? null;

    return {
      first,
      entries,
      unconfirmedSeams,
      hasMore: pendingLater || (lastLoaded?.hasMore ?? false),
      // From the last LOADED page: the control stays mounted (disabled, with
      // its spinner) while the next page is in flight, and doubles as the
      // retry when that page failed.
      canLoadMore: nextOffset !== null,
      balanceAfterResolved,
      isLoading: first === undefined && firstResult?.error == null,
      isLoadingMore: laterResults.some((result) => result.isLoading),
      // Page-level only when there is nothing to show; a retained result
      // with a fresh error is a refresh failure, surfaced beside the rows.
      error: first === undefined ? (firstResult?.error ?? null) : null,
      refreshError: first !== undefined ? (firstResult?.error ?? null) : null,
      loadMoreError: failedLater?.error ?? null,
      loadMore: () => {
        if (failedLater) {
          void failedLater.refetch();
          return;
        }
        if (pendingLater || nextOffset === null) return;
        setOffsets((prev) =>
          prev.list.includes(nextOffset)
            ? prev
            : { key: scopeKey, list: [...prev.list, nextOffset] },
        );
      },
      refetch: () => {
        for (const result of results) void result.refetch();
      },
    };
  }, [results, scopeKey]);
}

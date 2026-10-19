"use client";

import { useCallback, useMemo, useState } from "react";

import { trpc } from "@/trpc";

import type { SavedEventItem } from "./SavedEventCard";

export type SavedScope = "upcoming" | "past";

/** Page size for `eventSaves.listMine`. Lifted from the old /saved page. */
export const SAVED_PAGE_LIMIT = 20;

export interface UseSavedEventListArgs {
  /** Which half of the watchlist to read. Driven by the page-level tab. */
  scope: SavedScope;
  /** Every `eventSaves` procedure is authed — don't fire while signed out. */
  enabled: boolean;
}

export interface SavedEventListState {
  items: SavedEventItem[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
  unsave: (eventId: string) => void;
}

/**
 * The watchlist half of `/my-tickets`.
 *
 * Extracted from `app/saved/_components/SavedEvents.tsx` — the query, the
 * page flattening and the optimistic unsave were all page-local there, which
 * is why the merged page could not have reused them without a copy-paste.
 *
 * The scope is an ARGUMENT now, not internal state: `/saved`'s own
 * Upcoming/Past segmented control is gone and the page-level tab supplies it.
 * React Query keys on `{ scope }`, so switching tabs re-reads once and then
 * serves the other scope from cache.
 *
 * Deliberately returns a flat state object rather than the query: the host
 * needs `items.length` BEFORE it renders in order to derive the section index
 * numbers (design-system-v2 §8 — numbers are assigned over the sections that
 * actually render, never hardcoded).
 */
export function useSavedEventList({
  scope,
  enabled,
}: UseSavedEventListArgs): SavedEventListState {
  const utils = trpc.useUtils();

  const listQuery = trpc.eventSaves.listMine.useInfiniteQuery(
    { scope, limit: SAVED_PAGE_LIMIT },
    {
      enabled,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  // Optimistic unsave: hide the row immediately, restore it on error. Keyed by
  // event id rather than save id so it survives the list refetch that follows.
  const [hiddenEventIds, setHiddenEventIds] = useState<Set<string>>(new Set());
  const unsaveMutation = trpc.eventSaves.unsave.useMutation();

  const unsave = useCallback(
    (eventId: string) => {
      setHiddenEventIds((prev) => new Set(prev).add(eventId));
      unsaveMutation.mutate(
        { eventId },
        {
          onError: () => {
            setHiddenEventIds((prev) => {
              const next = new Set(prev);
              next.delete(eventId);
              return next;
            });
          },
          onSuccess: () => {
            void utils.eventSaves.listMine.invalidate();
            void utils.eventSaves.savedState.invalidate();
          },
        },
      );
    },
    [unsaveMutation, utils],
  );

  const items = useMemo<SavedEventItem[]>(() => {
    const pages = listQuery.data?.pages ?? [];
    return pages
      .flatMap((page) => page.items as SavedEventItem[])
      .filter((item) => !hiddenEventIds.has(item.event.id));
  }, [listQuery.data?.pages, hiddenEventIds]);

  const { fetchNextPage, refetch } = listQuery;

  const fetchNext = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    items,
    // `enabled: false` leaves React Query pending forever, which would read as
    // an eternal skeleton. A disabled query is not loading — it is off.
    isLoading: enabled && listQuery.isLoading,
    isError: Boolean(listQuery.error),
    isFetching: listQuery.isFetching,
    hasNextPage: Boolean(listQuery.hasNextPage),
    isFetchingNextPage: listQuery.isFetchingNextPage,
    fetchNextPage: fetchNext,
    refetch: retry,
    unsave,
  };
}

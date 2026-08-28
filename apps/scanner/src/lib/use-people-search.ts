import { useEffect, useMemo, useRef, useState } from "react";

import { useNetworkState } from "../features/network/use-network-state";
import { trpc } from "../trpc";
import { searchPeople, type LocalPersonRow } from "./local-db";
import {
  mergeLocalAndNetwork,
  type PeopleSearchResult,
  type SearchUnifiedResult,
} from "./people-search-merge";

export type {
  PeopleSearchResult,
  SearchTicketItem,
  SearchUnifiedResult,
  VolunteerCandidate,
} from "./people-search-merge";

export type PeopleSearchSource = "local" | "merged" | "network-only";

export interface UsePeopleSearchValue {
  results: PeopleSearchResult[];
  source: PeopleSearchSource;
  isOffline: boolean;
  isFetching: boolean;
  /** Most-recent `synced_at` across the local rows in the current result set. */
  syncedAt: number | null;
}

const DEBOUNCE_MS = 150;
const MIN_QUERY_LEN = 2;
const LOCAL_LIMIT = 50;
const NETWORK_LIMIT = 20;

/**
 * Local-first / network-augment people search for the unified-scan manual
 * search screen.
 *
 * On every keystroke (debounced 150ms, gated to ≥2 chars) the hook reads
 * from the local FTS5 people index for instant results. When online, it
 * fires `scan.searchUnified` in parallel; the response merges into the
 * local result set, hydrating rows with their rich `ticket` / `volunteer`
 * payloads. Stale network responses (query changed before they returned)
 * are dropped via a request-id ref.
 */
export function usePeopleSearch({
  eventId,
  query,
}: {
  eventId: string;
  query: string;
}): UsePeopleSearchValue {
  const network = useNetworkState();
  const isOffline = network === "offline";

  const utils = trpc.useUtils();

  const trimmed = query.trim();
  const enabled = trimmed.length >= MIN_QUERY_LEN;

  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    if (!enabled) {
      setDebounced("");
      return;
    }
    const t = setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed, enabled]);

  // Local rows, recomputed when the debounced query or eventId changes.
  const local = useMemo<LocalPersonRow[]>(() => {
    if (!debounced) return [];
    try {
      return searchPeople(eventId, debounced, LOCAL_LIMIT);
    } catch {
      return [];
    }
  }, [eventId, debounced]);

  const [networkData, setNetworkData] = useState<SearchUnifiedResult | null>(
    null,
  );
  const [isFetching, setIsFetching] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!debounced || isOffline) {
      // Reset network state so a stale online result can't bleed into a new
      // offline query.
      setNetworkData(null);
      setIsFetching(false);
      return;
    }

    const myId = ++requestIdRef.current;
    setIsFetching(true);
    setNetworkData(null);

    let cancelled = false;
    void (async () => {
      try {
        const data = (await utils.scan.searchUnified.fetch({
          eventId,
          query: debounced,
          limit: NETWORK_LIMIT,
        })) as SearchUnifiedResult;
        if (cancelled || requestIdRef.current !== myId) return;
        setNetworkData(data);
      } catch {
        if (cancelled || requestIdRef.current !== myId) return;
        // Swallow — local results still render and the offline banner will
        // appear if connectivity drops; transient errors don't need to block
        // the operator.
        setNetworkData(null);
      } finally {
        if (!cancelled && requestIdRef.current === myId) {
          setIsFetching(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, debounced, isOffline, utils.scan.searchUnified]);

  const results = useMemo(
    () => mergeLocalAndNetwork(local, isOffline ? null : networkData),
    [local, networkData, isOffline],
  );

  const source: PeopleSearchSource = useMemo(() => {
    if (local.length === 0 && networkData) return "network-only";
    if (networkData && !isOffline) return "merged";
    return "local";
  }, [local.length, networkData, isOffline]);

  const syncedAt = useMemo(() => {
    if (local.length === 0) return null;
    let max = 0;
    for (const r of local) {
      if (r.syncedAt > max) max = r.syncedAt;
    }
    return max || null;
  }, [local]);

  return { results, source, isOffline, isFetching, syncedAt };
}

import { useEffect, useRef } from "react";

import { staleEstimateKey, type ListedEstimateTicket } from "./stale-estimate";

/**
 * Un-latch "Calculating total…". When any listed row was priced at another
 * face than its ticket (see `isListedEstimateStale`), refetch the fee rates
 * ONCE. The query is cached for 60s with no refetch on focus, so without this
 * a buyer who loaded the page inside the window kept "Calculating total…"
 * until a remount.
 *
 * Loop guard: one refetch per mismatch. If the refetched rows still disagree
 * the same way (the TICKET list is the stale side), the key is unchanged and
 * nothing fires again; a different mismatch is a new key and gets its own
 * single refetch.
 */
export function useRefetchStaleEstimates(
  tickets: readonly ListedEstimateTicket[],
  refetch: () => unknown,
): void {
  const key = staleEstimateKey(tickets);
  const refetchedFor = useRef<string | null>(null);
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  useEffect(() => {
    if (key === "") {
      // Mismatch cleared: a later identical mismatch is a new event.
      refetchedFor.current = null;
      return;
    }
    if (refetchedFor.current === key) return;
    refetchedFor.current = key;
    void refetchRef.current();
  }, [key]);
}

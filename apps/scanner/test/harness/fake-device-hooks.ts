import { useSyncExternalStore } from "react";

import type { NetworkState } from "../../src/features/network/network-state";
import type {
  PeopleSearchResult,
  UsePeopleSearchValue,
} from "../../src/lib/use-people-search";

/**
 * The device's ambient state — connectivity, screen reader, the people
 * index — as tiny external stores a test can flip MID-scenario, and the screen
 * re-renders exactly as it would on a NetInfo / AccessibilityInfo event.
 */
const store = <T>(initial: T) => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
      for (const l of listeners) l();
    },
    reset: () => {
      value = initial;
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    use: () =>
      useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => value,
      ),
  };
};

export const networkStore = store<NetworkState>("online");
export const screenReaderStore = store(false);
/** Rows the manual search returns, matched on name/email/code substring. */
export const peopleStore = store<PeopleSearchResult[]>([]);

// ── Module replacements (wired in `setup.ts`) ───────────────────────────────

export const useNetworkState = (): NetworkState => networkStore.use();
export const useScreenReaderEnabled = (): boolean => screenReaderStore.use();
export const useReducedMotion = (): boolean => false;
export const useBrightnessBoost = (): void => {};

export const usePeopleSearch = ({
  query,
}: {
  eventId: string;
  query: string;
}): UsePeopleSearchValue => {
  const rows = peopleStore.use();
  const network = networkStore.use();
  const q = query.trim().toLowerCase();
  const results =
    q.length < 2
      ? []
      : rows.filter((r) =>
          [
            r.displayName,
            r.email,
            r.kind === "attendee" ? r.ticket?.ticketCode : null,
          ].some((field) => field?.toLowerCase().includes(q)),
        );
  return {
    results,
    source: "merged",
    isOffline: network === "offline",
    isFetching: false,
    syncedAt: null,
  };
};

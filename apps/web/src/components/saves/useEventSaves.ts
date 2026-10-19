"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventSummary } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

/** Server bound for one savedState batch (spec NFR-001). */
const SAVED_STATE_BATCH_SIZE = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep only real event UUIDs — discovery/search feeds can carry synthetic ids. */
const toValidEventIds = (
  eventIds: Array<string | null | undefined>,
): string[] => {
  const unique = new Set<string>();
  for (const id of eventIds) {
    if (id && UUID_RE.test(id)) unique.add(id);
  }
  // Stable order → stable React Query keys across re-renders.
  return [...unique].sort();
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export interface UseEventSavesResult {
  /** True once the session has resolved to a signed-in user. */
  isSignedIn: boolean;
  /** Saved flag for an event id (false while loading / signed out). */
  isSaved: (eventId: string | null | undefined) => boolean;
  /**
   * Toggle the save for an event. Optimistic with rollback on error.
   * Signed-out users get the sign-in overlay (no anonymous saves — FR-001).
   * Pass `forceNext` to pin the direction (e.g. an unsave-only quick action)
   * instead of flipping the current flag.
   */
  toggleSave: (eventId: string | null | undefined, forceNext?: boolean) => void;
}

/**
 * Batched saved-state + save/unsave toggling for a render group of event
 * cards. One `eventSaves.savedState` query per ≤50 visible ids — cards must
 * never query per-card (spec FR-005). Signed-out short-circuits to all-false
 * without touching the API.
 *
 * Saves are PRIVATE (FR-003): this hook only ever reads/writes the viewer's
 * own flags; no counts exist anywhere.
 */
export function useEventSaves(
  eventIds: Array<string | null | undefined>,
): UseEventSavesResult {
  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);
  const { showSignInOverlay } = useAppOverlay();
  const utils = trpc.useUtils();

  const idsKey = toValidEventIds(eventIds).join(",");
  const ids = useMemo(
    () => (idsKey ? idsKey.split(",") : []),
    [idsKey],
  );
  const batches = useMemo(() => chunk(ids, SAVED_STATE_BATCH_SIZE), [ids]);

  const savedStateQueries = trpc.useQueries((t) =>
    batches.map((batch) =>
      t.eventSaves.savedState(
        { eventIds: batch },
        {
          enabled: isSignedIn && batch.length > 0,
          staleTime: 30_000,
          retry: false,
          refetchOnWindowFocus: false,
        },
      ),
    ),
  );

  const serverSaved = useMemo(() => {
    const merged: Record<string, boolean> = {};
    for (const query of savedStateQueries) {
      if (query.data?.saved) Object.assign(merged, query.data.saved);
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedStateQueries.map((q) => q.dataUpdatedAt).join(","), idsKey]);

  // Optimistic per-event overrides applied on top of the server flags.
  // Overrides are TRANSIENT: settled on mutation success (write-through +
  // drop) and reconciled away whenever fresh server state agrees — a stale
  // override must never shadow newer server truth for the life of the mount.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Reconcile: once the server reports the same flag an override holds, the
  // override has nothing left to say — drop it so future server changes
  // (e.g. an unsave made from another render group) show through.
  useEffect(() => {
    setOverrides((prev) => {
      const settled = Object.keys(prev).filter(
        (id) => serverSaved[id] === prev[id],
      );
      if (settled.length === 0) return prev;
      const next = { ...prev };
      for (const id of settled) delete next[id];
      return next;
    });
  }, [serverSaved]);

  const saveMutation = trpc.eventSaves.save.useMutation();
  const unsaveMutation = trpc.eventSaves.unsave.useMutation();

  // Write the settled flag straight into this hook's cached savedState
  // batches so there's no flash between dropping the override and the
  // post-invalidation refetch landing.
  const writeThroughOwnBatches = useCallback(
    (eventId: string, saved: boolean) => {
      for (const batch of batches) {
        if (!batch.includes(eventId)) continue;
        utils.eventSaves.savedState.setData({ eventIds: batch }, (old) =>
          old ? { ...old, saved: { ...old.saved, [eventId]: saved } } : old,
        );
      }
    },
    [batches, utils],
  );

  const isSaved = useCallback(
    (eventId: string | null | undefined): boolean => {
      if (!eventId || !isSignedIn) return false;
      return overrides[eventId] ?? serverSaved[eventId] ?? false;
    },
    [isSignedIn, overrides, serverSaved],
  );

  const toggleSave = useCallback(
    (eventId: string | null | undefined, forceNext?: boolean) => {
      if (!eventId || !UUID_RE.test(eventId)) return;

      if (!isSignedIn) {
        // No anonymous saves — route through sign-in, back to this page.
        // Read the location at click time so the redirect is always fresh.
        const redirect =
          typeof window !== "undefined"
            ? `${window.location.pathname}${window.location.search}`
            : "/";
        showSignInOverlay({ redirect: redirect || "/" });
        return;
      }

      const next =
        forceNext ?? !(overrides[eventId] ?? serverSaved[eventId] ?? false);
      setOverrides((prev) => ({ ...prev, [eventId]: next }));

      const mutation = next ? saveMutation : unsaveMutation;
      mutation.mutate(
        { eventId },
        {
          onError: () => {
            // Roll the optimistic flip back — but only if this toggle still
            // owns the override; a newer toggle's flag must not be inverted.
            setOverrides((prev) =>
              prev[eventId] === next ? { ...prev, [eventId]: !next } : prev,
            );
          },
          onSuccess: () => {
            // Settle: write the confirmed flag through to the cache, then
            // drop the override (unless a newer toggle superseded it) so
            // fresher server state is never shadowed. Invalidations refetch
            // every other render group + the /saved list.
            writeThroughOwnBatches(eventId, next);
            setOverrides((prev) => {
              if (prev[eventId] !== next) return prev;
              const rest = { ...prev };
              delete rest[eventId];
              return rest;
            });
            void utils.eventSaves.savedState.invalidate();
            void utils.eventSaves.listMine.invalidate();
          },
        },
      );
    },
    [
      isSignedIn,
      overrides,
      saveMutation,
      serverSaved,
      showSignInOverlay,
      unsaveMutation,
      utils,
      writeThroughOwnBatches,
    ],
  );

  return { isSignedIn, isSaved, toggleSave };
}

export interface UseSavedEventSummariesResult {
  /** Input summaries with the viewer's `favorite` flag merged in. */
  events: EventSummary[];
  /** Pass straight to `EventGrid`'s `onFavoriteToggle`. */
  onFavoriteToggle: (eventId: string) => void;
}

/**
 * Convenience wrapper for `EventGrid` render sites: merges the viewer's
 * saved flags into `EventSummary.favorite` (the shared EventCard heart) and
 * provides the toggle handler. Signed-out grids still show the outline heart;
 * tapping it opens the sign-in overlay.
 */
export function useSavedEventSummaries(
  events: EventSummary[],
): UseSavedEventSummariesResult {
  const { isSaved, toggleSave } = useEventSaves(events.map((e) => e.id));

  const withFlags = useMemo(
    () => events.map((e) => ({ ...e, favorite: isSaved(e.id) })),
    [events, isSaved],
  );

  const onFavoriteToggle = useCallback(
    (eventId: string) => toggleSave(eventId),
    [toggleSave],
  );

  return { events: withFlags, onFavoriteToggle };
}

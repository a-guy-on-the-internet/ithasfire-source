"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { getMutationKey } from "@trpc/react-query";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { deriveRsvpButtonState } from "./rsvp-button.helpers";

export type UseRsvpToggleArgs = {
  /** Event UUID (must be a PUBLISHED RSVP event). */
  eventId: string;
  /** Server-rendered `viewerRsvped` seed — avoids a loading flash. */
  initialRsvped?: boolean;
  /**
   * When false the underlying `myRsvpForEvent` query is disabled — used by
   * the event-detail bridge, which mounts on every event detail page but only wants
   * the RSVP round-trip for RSVP (community) listings. Defaults to true so
   * the in-body RsvpButton (only mounted on RSVP events) needs no flag.
   */
  enabled?: boolean;
};

export type RsvpToggle = {
  /** The viewer's own RSVP state — the ONLY state this ever reflects. */
  going: boolean;
  /** True while the state can't yet be known (session/query resolving). */
  resolving: boolean;
  /** Block presses (resolving or a mutation already in flight). */
  disabled: boolean;
  /** Localized button label reflecting `going`. */
  label: string;
  /** Toggle handler — routes signed-out viewers through sign-in. */
  handlePress: () => void;
};

/**
 * Controller for the personal "I'm going" RSVP toggle (community-managed
 * listings FR-004). Extracted from RsvpButton so the same behavior can drive
 * BOTH the in-body button and the bottom nav's primary CTA without duplicating the
 * optimistic mutation / rollback / sign-in wiring.
 *
 * FR-004: reflects ONLY the viewer's own state — never attendee counts.
 */
export function useRsvpToggle({
  eventId,
  initialRsvped,
  enabled = true,
}: UseRsvpToggleArgs): RsvpToggle {
  const t = useTranslations();
  const { toast } = useNotify();
  const { showSignInOverlay } = useAppOverlay();
  const utils = trpc.useUtils();

  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);

  /**
   * "Has this island hydrated yet." Fed to `deriveRsvpButtonState` so the FIRST
   * client render reproduces the server's render by premise instead of by
   * session-fetch luck — see the `hydrated` field on `RsvpButtonStateInput` for
   * the failure it removes. The signed-in shape arrives on the commit right
   * after hydration, which is when it arrived before too: nothing is slower,
   * only the divergence is gone.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const stateQuery = trpc.community.myRsvpForEvent.useQuery(
    { eventId },
    {
      enabled: enabled && isSignedIn,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
      ...(initialRsvped !== undefined
        ? { initialData: { rsvped: initialRsvped } }
        : {}),
    },
  );

  const writeState = useCallback(
    (rsvped: boolean) => {
      utils.community.myRsvpForEvent.setData({ eventId }, { rsvped });
    },
    [eventId, utils],
  );

  const onToggleError = useCallback(
    (previous: boolean) => {
      // Roll the optimistic flip back and tell the viewer.
      writeState(previous);
      toast.danger({ title: String(t("rsvp.errToggleFailed")) });
    },
    [toast, t, writeState],
  );

  const onToggleSettled = useCallback(() => {
    void utils.community.myRsvpForEvent.invalidate({ eventId });
    void utils.community.myRsvps.invalidate();
  }, [eventId, utils]);

  const rsvpMut = trpc.community.rsvp.useMutation({
    onError: () => onToggleError(false),
    onSettled: onToggleSettled,
  });
  const cancelMut = trpc.community.cancelRsvp.useMutation({
    onError: () => onToggleError(true),
    onSettled: onToggleSettled,
  });

  // Shared pending state across surfaces: the in-body RsvpButton and the
  // bridge mount SEPARATE hook instances sharing the tRPC cache. Gating on
  // per-hook `isPending` would let a fast cross-surface double-press fire a
  // second mutation. `useIsMutating` reactively counts in-flight rsvp/cancel
  // mutations across ALL instances (including this one), so either surface
  // goes disabled the moment the other starts a toggle.
  const rsvpPending = useIsMutating({
    mutationKey: getMutationKey(trpc.community.rsvp),
  });
  const cancelPending = useIsMutating({
    mutationKey: getMutationKey(trpc.community.cancelRsvp),
  });

  const { going, resolving, disabled } = deriveRsvpButtonState({
    hydrated,
    isSignedIn,
    sessionPending: sessionQuery.isPending,
    queryRsvped: stateQuery.data?.rsvped,
    initialRsvped,
    mutationPending: rsvpPending + cancelPending > 0,
  });

  const handlePress = useCallback(() => {
    if (disabled) return;

    if (!isSignedIn) {
      // No anonymous RSVPs — route through sign-in, back to this page.
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/";
      showSignInOverlay({ redirect: redirect || "/" });
      return;
    }

    const next = !going;
    // Optimistic flip — the mutation callbacks roll back on error.
    writeState(next);
    (next ? rsvpMut : cancelMut).mutate({ eventId });
  }, [
    cancelMut,
    disabled,
    eventId,
    going,
    isSignedIn,
    rsvpMut,
    showSignInOverlay,
    writeState,
  ]);

  const label = going
    ? String(t("rsvp.youreGoing"))
    : String(t("rsvp.imGoing"));

  return { going, resolving, disabled, label, handlePress };
}

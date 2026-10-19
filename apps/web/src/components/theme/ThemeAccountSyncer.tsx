"use client";

import { useEffect, useRef } from "react";

import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { useAppTheme } from "@/components/theme/AppThemeProvider";

/**
 * Persists the user's light/dark MODE to their account when they toggle it,
 * so the choice follows a signed-in user across devices/browsers.
 *
 * Must live INSIDE `TrpcProvider` (it calls a tRPC mutation) — mirror
 * `ActiveThemeInjector`. `AppThemeProvider` sits OUTSIDE `TrpcProvider`, so it
 * can't do this itself; this component reads the mode from context instead.
 *
 * Behaviour:
 *   - Skips the initial mount (never persists the SSR-resolved mode back — that
 *     would echo the value we just read from the account).
 *   - Only persists when signed in (gated on `authClient.useSession()`), so
 *     logged-out toggling makes no request and never 401s.
 *   - Tracks the last mode actually PERSISTED (not just the previous render's
 *     mode). A toggle made while the session is still loading — `isSignedIn`
 *     briefly false — is therefore flushed the moment the session resolves,
 *     instead of being silently swallowed.
 *   - Fire-and-forget: the optimistic cookie + local flip already happened in
 *     `AppThemeProvider.toggle()`; a failed persist never blocks or reverts it.
 */
export const ThemeAccountSyncer = () => {
  const { mode } = useAppTheme();
  const { data: session } = authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const setThemePreference = trpc.humans.setThemePreference.useMutation();

  // The mode we last persisted to the account. Seeded with the SSR-resolved
  // mode so mount is a no-op (that value already came FROM the account/cookie).
  // Advanced ONLY when we actually persist — so a toggle during the session-
  // loading window survives to be flushed once `isSignedIn` becomes true.
  const lastPersistedRef = useRef(mode);

  useEffect(() => {
    // Don't advance the ref while signed out — a toggle here must still be
    // flushed once the session resolves.
    if (!isSignedIn) {
      return;
    }
    if (lastPersistedRef.current === mode) {
      return;
    }
    lastPersistedRef.current = mode;

    // Fire-and-forget. The UI has already flipped optimistically; a failed
    // persist must never revert it. Swallow errors so a transient failure or a
    // race with sign-out is harmless.
    setThemePreference.mutate({ mode });
    // `setThemePreference` is a stable mutation handle; excluded to avoid
    // re-running on its internal state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isSignedIn]);

  return null;
};

ThemeAccountSyncer.displayName = "ThemeAccountSyncer";

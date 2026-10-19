"use client";

import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth/auth-client";

/**
 * Session state that is safe to branch on during render.
 *
 * `authClient.useSession()` resolves differently on the server than on the
 * client's FIRST render: the server always reports `isPending: true` with no
 * user, while the client can hydrate straight into a settled signed-out (or
 * signed-in) state from its cached store. Any component that forks its markup
 * on that — the booking CTAs render a whole different `<button>` per branch —
 * therefore emits server HTML the client immediately disagrees with, and React
 * bails with "a tree hydrated but some attributes … didn't match" (verified on
 * `/p/[slug]`: the server's `disabled` + `aria-haspopup="dialog"` were absent
 * client-side). React does NOT patch attributes up after that warning, so the
 * button can be left permanently `disabled` in the DOM.
 *
 * Holding `isPending` true until the first effect runs makes the server render
 * and the first client render identical by construction; the real state lands
 * one commit later.
 */
export function useSessionGate() {
  const session = authClient.useSession();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const isPending = !hydrated || session.isPending;

  return {
    session,
    isPending,
    // Never true before hydration — the signed-in branch must not appear in
    // markup the server could not have produced.
    isSignedIn: hydrated && Boolean(session.data?.user),
  };
}

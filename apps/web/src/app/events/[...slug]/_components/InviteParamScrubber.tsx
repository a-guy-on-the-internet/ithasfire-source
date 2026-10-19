"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { stripInviteParam, syncRouterToCleanUrl } from "./invite-url";

/**
 * Drops `?invite=<token>` from the address bar on the event-page branches
 * that have no use for it: an event whose gate was removed after the invites
 * went out, and the route's 404. Without it the token would sit in the
 * address bar and the history entry's URL, and keep analytics off
 * (analytics-url-guard.ts). A copy stays inside `history.state` (Next's tree
 * keys the page by its search params): an accepted residual, local to the
 * browser and never sent over the network (invite-url.ts).
 *
 * NOT rendered on the gated branch: `GatedEventShell` (via `useInviteLink`)
 * owns the token there and must capture it before it is stripped. Both use
 * the same idempotent `stripInviteParam`, so even if both ran, the first one
 * to run takes the token and the other finds a clean URL.
 */
export function InviteParamScrubber() {
  const stripped = useRef(false);
  useLayoutEffect(() => {
    // Any strip, an empty `?invite=` included, needs the router sync. Set
    // only: StrictMode re-runs this on a URL that is already clean.
    if (stripInviteParam().stripped) stripped.current = true;
  }, []);
  useEffect(
    () => (stripped.current ? syncRouterToCleanUrl() : undefined),
    [],
  );
  return null;
}

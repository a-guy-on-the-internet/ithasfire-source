"use client";

import { useEffect, useState } from "react";

/**
 * Carries an invitation's bearer token across the sign-in round trip WITHOUT
 * putting it in a URL (security review, 2026-09-29).
 *
 * The accept pages (`/invite/accept`, `/delegate/accept`) arrive with
 * `?token=`. For a signed-out visitor, sending `?redirect=/invite/accept?
 * token=…` to /sign-in would put the token into the sign-in URL, which
 * third-party analytics record. Instead the Sign in button stashes the token
 * here (per-tab `sessionStorage`, strictly necessary for the flow the visitor
 * started, gone when the tab closes) and redirects to the bare accept path;
 * the accept page reads it back on return. If storage is unavailable (private
 * mode quirks, disabled storage) we fall back to the URL param so the flow
 * still works.
 */

export type InviteKind = "org" | "delegate";

const KEY: Record<InviteKind, string> = {
  org: "th:pending-invite-token:org",
  delegate: "th:pending-invite-token:delegate",
};

const PATH: Record<InviteKind, string> = {
  org: "/invite/accept",
  delegate: "/delegate/accept",
};

export function stashInviteToken(kind: InviteKind, token: string): boolean {
  try {
    window.sessionStorage.setItem(KEY[kind], token);
    return window.sessionStorage.getItem(KEY[kind]) === token;
  } catch {
    return false;
  }
}

export function readStashedInviteToken(kind: InviteKind): string | null {
  try {
    return window.sessionStorage.getItem(KEY[kind]);
  } catch {
    return null;
  }
}

export function clearStashedInviteToken(kind: InviteKind): void {
  try {
    window.sessionStorage.removeItem(KEY[kind]);
  } catch {
    // nothing to clear
  }
}

/**
 * The sign-in URL for a signed-out invitee. Stashes the token and returns a
 * redirect WITHOUT it; only if stashing fails does the token ride in the URL.
 */
export function signInHrefForInvite(kind: InviteKind, token: string): string {
  const back = stashInviteToken(kind, token)
    ? PATH[kind]
    : `${PATH[kind]}?token=${encodeURIComponent(token)}`;
  return `/sign-in?redirect=${encodeURIComponent(back)}`;
}

/**
 * The token to use on an accept page: the URL's, else the stashed one.
 *
 * `resolved` is false on the server AND on the client's first (hydration)
 * render, and flips after mount. Pages render one neutral spinner while it is
 * false, so SSR and the hydration pass always produce the SAME markup. Without
 * this the server rendered "Checking your session…" (the session is always
 * pending in SSR) while the client, with the session already cached, rendered
 * the next state — a hydration mismatch the live e2e caught.
 */
export function useInviteToken(
  kind: InviteKind,
  urlToken: string | null,
): { token: string | null; resolved: boolean } {
  const [stashed, setStashed] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (urlToken === null) {
      setStashed(readStashedInviteToken(kind));
    }
    setResolved(true);
  }, [kind, urlToken]);

  return { token: urlToken ?? stashed, resolved };
}

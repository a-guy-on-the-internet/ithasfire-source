"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EMBED_AUTH_HANDOFF_PATH,
  isEmbedAuthTokenMessage,
} from "@/lib/embed-auth-handoff";

export type EmbedAuthStatus = "idle" | "waiting" | "authed";

export type EmbedAuthHandoff = {
  /** Bearer JWT held IN MEMORY ONLY — never persisted anywhere. */
  token: string | null;
  /**
   * Monotonic counter, bumped each time a token is received. Use this (not
   * the raw token) as a React `key` for signed-in subtrees so the JWT never
   * leaks into DevTools / element inspection via key props.
   */
  loginCount: number;
  status: EmbedAuthStatus;
  /** `window.open` returned null — the browser blocked the popup. */
  popupBlocked: boolean;
  /** A previously-held token was rejected (401) — quiet re-login affordance. */
  sessionExpired: boolean;
  /** The handoff hit the overall cap without a token — "try again" note. */
  timedOut: boolean;
  login: () => void;
  cancelLogin: () => void;
  logout: () => void;
  markSessionExpired: () => void;
};

/** Give a queued token message a beat to land after the popup closes. */
const CLOSE_GRACE_MS = 500;
const POPUP_POLL_MS = 500;
/** Sign-in can take a while (OTP, passkey prompts) — generous overall cap. */
const HANDOFF_TIMEOUT_MS = 5 * 60_000;

/**
 * Iframe side of the popup auth handoff (FR-010). See
 * `@/lib/embed-auth-handoff` for the protocol + security invariants. Accepts
 * a token ONLY from the exact popup window it opened, on our exact origin,
 * with a shape-validated payload; everything else is ignored silently.
 */
export function useEmbedAuthHandoff(): EmbedAuthHandoff {
  const [token, setToken] = useState<string | null>(null);
  const [loginCount, setLoginCount] = useState(0);
  const [status, setStatus] = useState<EmbedAuthStatus>("idle");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const gotTokenRef = useRef(false);
  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const pollRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const graceRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (listenerRef.current) {
      window.removeEventListener("message", listenerRef.current);
      listenerRef.current = null;
    }
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (graceRef.current !== null) {
      window.clearTimeout(graceRef.current);
      graceRef.current = null;
    }
    popupRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const login = useCallback(() => {
    teardown();
    setPopupBlocked(false);
    setSessionExpired(false);
    setTimedOut(false);
    gotTokenRef.current = false;

    const ownOrigin = window.location.origin;
    const popup = window.open(
      `${ownOrigin}${EMBED_AUTH_HANDOFF_PATH}`,
      "hf-auth",
      "popup,width=480,height=640",
    );
    if (!popup) {
      setPopupBlocked(true);
      return;
    }
    popupRef.current = popup;
    setStatus("waiting");

    const onMessage = (event: MessageEvent) => {
      // SECURITY: exact-origin + exact-source + shape checks. Reject (silently)
      // anything that isn't OUR popup speaking from OUR origin.
      if (event.origin !== window.location.origin) return;
      if (!popupRef.current || event.source !== popupRef.current) return;
      if (!isEmbedAuthTokenMessage(event.data)) return;

      gotTokenRef.current = true;
      setToken(event.data.token);
      setLoginCount((count) => count + 1);
      setStatus("authed");
      teardown();
    };
    listenerRef.current = onMessage;
    window.addEventListener("message", onMessage);

    // User closed the popup without finishing → quiet reset. The token message
    // (posted just before the popup self-closes) may still be in flight, so
    // give it a short grace period before resetting.
    pollRef.current = window.setInterval(() => {
      if (!popupRef.current?.closed) return;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      graceRef.current = window.setTimeout(() => {
        if (!gotTokenRef.current) {
          teardown();
          setStatus("idle");
        }
      }, CLOSE_GRACE_MS);
    }, POPUP_POLL_MS);

    timeoutRef.current = window.setTimeout(() => {
      if (!gotTokenRef.current) {
        // Best-effort close so the popup can't sit there implying success
        // while the iframe has already stopped listening.
        try {
          popupRef.current?.close();
        } catch {
          // Cross-window close can throw in exotic states — the timeout
          // reset must not.
        }
        teardown();
        setStatus("idle");
        setTimedOut(true);
      }
    }, HANDOFF_TIMEOUT_MS);
  }, [teardown]);

  const cancelLogin = useCallback(() => {
    try {
      popupRef.current?.close();
    } catch {
      // Cross-window close can throw in exotic states — cancel must not.
    }
    teardown();
    setStatus("idle");
  }, [teardown]);

  const logout = useCallback(() => {
    teardown();
    setToken(null);
    setStatus("idle");
  }, [teardown]);

  const markSessionExpired = useCallback(() => {
    teardown();
    setToken(null);
    setStatus("idle");
    setSessionExpired(true);
  }, [teardown]);

  return {
    token,
    loginCount,
    status,
    popupBlocked,
    sessionExpired,
    timedOut,
    login,
    cancelLogin,
    logout,
    markSessionExpired,
  };
}

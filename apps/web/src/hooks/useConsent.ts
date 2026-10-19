"use client";

import { useCallback, useEffect, useState } from "react";

import { trpc } from "@/trpc";
import {
  COOKIE_POLICY_VERSION,
  PRIVACY_POLICY_VERSION,
} from "@/config/legal-versions";

/**
 * Consent preference stored in the `th-consent` cookie.
 *
 * - `"all"` — all cookies accepted (analytics, marketing, etc.)
 * - `"essential"` — only strictly necessary cookies
 * - `null` — user has not yet made a choice (banner should appear)
 */
export type ConsentChoice = "all" | "essential" | null;

/** Where the consent decision was made. */
export type ConsentSource = "BANNER" | "FOOTER_MANAGE";

const COOKIE_NAME = "th-consent";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 1 year
const ANON_ID_KEY = "th-anon-id";

/** Read the consent cookie value (client-only). */
function readConsent(): ConsentChoice {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const value = match.split("=")[1];
  if (value === "all" || value === "essential") return value;
  return null;
}

/** Write the consent cookie. */
function writeConsent(choice: "all" | "essential") {
  document.cookie = `${COOKIE_NAME}=${choice}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Read or lazily mint a stable anonymous device id stored in localStorage.
 * Used to correlate consent decisions across sessions and to stitch
 * pre-signup consents to the eventual account.
 *
 * Only ever called from a decision handler (accept / essential / reset), never
 * on mount. A visitor who reads the banner and walks away leaves no identifier
 * behind — minting one to audit a consent they never gave would be exactly the
 * tracking the banner is asking permission for.
 */
function getOrCreateAnonymousId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(ANON_ID_KEY);
    if (existing) return existing;
    // crypto.randomUUID is available in all browsers we ship to.
    const next = window.crypto.randomUUID();
    window.localStorage.setItem(ANON_ID_KEY, next);
    return next;
  } catch {
    // Private-mode / disabled storage — generate per-call and skip persistence.
    return null;
  }
}

export interface UseConsentResult {
  /** Current consent choice. `null` means undecided — show the banner. */
  consent: ConsentChoice;
  /** Accept all cookies. `source` defaults to "BANNER". */
  acceptAll: (source?: ConsentSource) => void;
  /** Accept only essential cookies. `source` defaults to "BANNER". */
  acceptEssential: (source?: ConsentSource) => void;
  /** Clear the stored choice so the banner reappears. `source` defaults to "FOOTER_MANAGE". */
  resetConsent: (source?: ConsentSource) => void;
  /** True once the client has hydrated and we know the real value. */
  ready: boolean;
}

/**
 * Manages cookie-consent state. The consent choice is persisted in a
 * first-party cookie (`th-consent`) for 1 year. Every decision (accept,
 * essential-only, reset) is also fire-and-forget logged to the server-side
 * audit trail via `trpc.consent.record` to satisfy GDPR Art. 7(1)
 * "demonstrate consent."
 */
export function useConsent(): UseConsentResult {
  const [consent, setConsent] = useState<ConsentChoice>(null);
  const [ready, setReady] = useState(false);

  const recordMutation = trpc.consent.record.useMutation();

  useEffect(() => {
    setConsent(readConsent());
    setReady(true);
  }, []);

  const sendRecord = useCallback(
    (choice: "ALL" | "ESSENTIAL" | "RESET", source: ConsentSource) => {
      const anonymousId = getOrCreateAnonymousId();
      if (!anonymousId) return;
      // Fire and forget — never block the UI on the audit log.
      recordMutation.mutate({
        anonymousId,
        choice,
        source,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        cookiePolicyVersion: COOKIE_POLICY_VERSION,
      });
    },
    [recordMutation],
  );

  const acceptAll = useCallback(
    (source: ConsentSource = "BANNER") => {
      writeConsent("all");
      setConsent("all");
      sendRecord("ALL", source);
    },
    [sendRecord],
  );

  const acceptEssential = useCallback(
    (source: ConsentSource = "BANNER") => {
      writeConsent("essential");
      setConsent("essential");
      sendRecord("ESSENTIAL", source);
    },
    [sendRecord],
  );

  const resetConsent = useCallback(
    (source: ConsentSource = "FOOTER_MANAGE") => {
      // Expire the cookie so the banner reappears.
      document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
      setConsent(null);
      sendRecord("RESET", source);
    },
    [sendRecord],
  );

  return { consent, acceptAll, acceptEssential, resetConsent, ready };
}

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { redactUrlTokens } from "@/lib/sentry/redact-url-tokens";

import { isAnalyticsExcludedPath } from "./analytics-excluded-paths";

/**
 * Dispatched on `window` by code that removes a credential from the URL in
 * place (`history.replaceState`), so `useAnalyticsUrlSafe` re-checks.
 */
export const ANALYTICS_URL_SCRUBBED_EVENT = "th:url-scrubbed";

/**
 * sessionStorage key prefix under which the event page keeps an invite token
 * across a reload (`th:invite:<eventId>`, invite-url.ts). Same-origin scripts
 * can read sessionStorage, so analytics stays off while one is held.
 */
export const INVITE_STASH_PREFIX = "th:invite:";

/** True while this tab's sessionStorage holds an invite token. */
export function sessionHoldsInviteToken(): boolean {
  try {
    const store = window.sessionStorage;
    for (let i = 0; i < store.length; i += 1) {
      if (store.key(i)?.startsWith(INVITE_STASH_PREFIX)) return true;
    }
  } catch {
    // Storage blocked: nothing can be stashed there either.
  }
  return false;
}

const SECRET_PARAM = /(?:^|[?&])[a-z_-]*secret=/i;
const STRIPE_SECRET_VALUE = /\b(?:pi|seti)_[A-Za-z0-9]+_secret_/;
/**
 * Bearer tokens carried under a bare key:
 *  - `invite`: a gated-event invite link (`/events/<slug>?invite=<token>`).
 *    The event page strips it on load (`invite-link.ts`), but nothing orders
 *    that against a script reading `location.href`, so the guard owns it too.
 *  - `token`: the tokenised email links (`/invites/stop?token=`,
 *    `/invite/accept?token=`, `/delegate/accept?token=`, password reset…).
 * Exact keys only: `invited=` or `tokens=` is not a credential.
 */
const BEARER_KEYS: ReadonlySet<string> = new Set(["invite", "token"]);
/** The same param URL-encoded inside another one (`?redirect=%2Fe%3Finvite%3DT`). */
const ENCODED_BEARER_PARAM = /(?:%3F|%26|%23)(?:invite|token)%3D/i;

/** `URLSearchParams` decodes keys, so `?%69nvite=` counts, as the page reads it. */
function hasBearerParam(search: string): boolean {
  if (ENCODED_BEARER_PARAM.test(search)) return true;
  try {
    for (const key of new URLSearchParams(search).keys()) {
      if (BEARER_KEYS.has(key)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * True when a query string carries a Stripe client secret
 * (`payment_intent_client_secret=pi_X_secret_Y`, left on the checkout URL by
 * a redirect payment method's return) or a bearer token (`invite=`,
 * `token=`).
 * Plausible, the Cloudflare beacon and GA4 all read `location.href`
 * themselves, so none of them may run while it is there.
 */
export function searchCarriesClientSecret(search: string): boolean {
  return (
    SECRET_PARAM.test(search) ||
    STRIPE_SECRET_VALUE.test(search) ||
    hasBearerParam(search)
  );
}

/**
 * Drops every `…secret` param, the `invite` and `token` params, and any bare
 * `pi_…_secret_…` value from a query string; a token nested URL-encoded in
 * another param is redacted.
 */
export function stripClientSecretParams(search: string): string {
  if (!searchCarriesClientSecret(search)) return search;
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    if (
      /secret$/i.test(key) ||
      BEARER_KEYS.has(key) ||
      STRIPE_SECRET_VALUE.test(params.get(key) ?? "")
    ) {
      params.delete(key);
    }
  }
  // Prefix "?" so a secret param in FIRST position matches (the redactor
  // anchors on `?`/`&`/`#`), then strip it again.
  const out = redactUrlTokens(`?${params.toString()}`).slice(1);
  return out ? `?${out}` : "";
}

/**
 * Whether THIS DOCUMENT was loaded from a URL carrying a credential. Read
 * from the Navigation Timing entry, whose `name` is the URL the document was
 * requested with and is NOT updated by `history.replaceState`. The Cloudflare
 * beacon reports Navigation Timing, so a `?invite=` (or a Stripe client
 * secret) stripped in place would still leave with it. Constant for the life
 * of the document; false when the entry is unavailable.
 */
export function documentLoadedWithSecret(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    const name = entry?.name;
    if (typeof name !== "string" || !name) return false;
    const url = new URL(name);
    // A document that loaded on a token route (`/invites/stop`, the accept
    // pages) keeps that URL in its entry after a soft navigation away, so it
    // counts whatever its query looked like.
    return (
      isAnalyticsExcludedPath(url.pathname) ||
      searchCarriesClientSecret(url.search)
    );
  } catch {
    return false;
  }
}

/**
 * Whether the current URL is safe to hand to a third-party analytics script.
 * `false` until mounted (so nothing loads before the check can run — these
 * scripts are `afterInteractive`, so waiting one effect costs nothing), then
 * re-evaluated on every pathname change and on `ANALYTICS_URL_SCRUBBED_EVENT`.
 * Never safe in a document that LOADED with a credential (see
 * `documentLoadedWithSecret`), whatever the URL says now.
 */
export function useAnalyticsUrlSafe(): boolean {
  const pathname = usePathname();
  const [safe, setSafe] = useState(false);
  useEffect(() => {
    // Unsafe for the whole document once it loaded with a credential: only a
    // hard navigation (a new document) clears it. The scrubbed event below
    // re-runs this same check, so it can never re-enable such a document.
    const check = () =>
      setSafe(
        !documentLoadedWithSecret() &&
          !searchCarriesClientSecret(window.location.search) &&
          // A RELOADED invite landing: its URL and navigation entry are both
          // clean, but the token waits in sessionStorage for the guest's tap.
          !sessionHoldsInviteToken(),
      );
    check();
    // A credential stripped in place (the event page's `?invite=`) leaves the
    // pathname alone; the stripper announces it so the check can run again.
    window.addEventListener(ANALYTICS_URL_SCRUBBED_EVENT, check);
    return () => window.removeEventListener(ANALYTICS_URL_SCRUBBED_EVENT, check);
  }, [pathname]);
  return safe;
}

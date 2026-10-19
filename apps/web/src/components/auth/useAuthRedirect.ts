import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { readRedirectParam, sanitizeRedirectPath } from "@/lib/redirect";

import {
  DEFAULT_POST_AUTH_PATH,
  resolvePostAuthDestination,
} from "./auth-helpers";

/**
 * Shared hook that resolves the post-auth redirect destination.
 *
 * Logic (identical for sign-in and sign-up):
 *  1. If the parent passes an explicit `redirectOverride`, use it.
 *  2. Otherwise, read any supported redirect query param from the current URL.
 *  3. Fall back to the default destination computed by `buildDestination`.
 *
 * Returns `{ destination, oauthCallbackUrl }`:
 *  - `destination` — relative path for client-side `router.replace()` after
 *    email/password sign-in (preserves existing behaviour).
 *  - `oauthCallbackUrl` — **absolute** URL pointing to the web origin.
 *    Must be used as `callbackURL` in `signIn.social()` because the Better Auth
 *    oAuthProxy plugin resolves it against the *API* origin. A relative path
 *    like `/sign-in` would resolve to `https://api.…/sign-in` → Fastify 404.
 */
export const useAuthRedirect = (redirectOverride?: string | null) => {
  const searchParams = useSearchParams();

  const sanitizedOverride = useMemo(
    () => sanitizeRedirectPath(redirectOverride ?? null),
    [redirectOverride],
  );

  const clientRedirectParam = useMemo(
    () => readRedirectParam(searchParams),
    [searchParams],
  );

  const sanitizedRedirect = useMemo(
    () => sanitizedOverride ?? clientRedirectParam,
    [clientRedirectParam, sanitizedOverride],
  );

  // Relative path for client-side navigation (email/password flow)
  const destination = useMemo(
    () => resolvePostAuthDestination(sanitizedRedirect),
    [sanitizedRedirect],
  );

  // Absolute URL for OAuth callbackURL — always points at the web origin.
  // Uses the user-intended redirect if available, otherwise falls back to "/".
  const oauthCallbackUrl = useMemo(() => {
    const path = sanitizedRedirect ?? DEFAULT_POST_AUTH_PATH;
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path.startsWith("/") ? path : `/${path}`}`;
  }, [sanitizedRedirect]);

  return { destination, oauthCallbackUrl };
};

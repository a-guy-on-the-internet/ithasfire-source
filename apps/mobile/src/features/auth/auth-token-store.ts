import * as SecureStore from "expo-secure-store";

import { getApiBaseUrl } from "@/config/api";

/**
 * Session token + JWT minting for outbound tRPC requests.
 *
 * ## The contract, and why the previous version was broken
 *
 * React Native's fetch cannot read `Set-Cookie`, so a mobile client can never
 * hold a session COOKIE. The API accounts for this by mounting `bearer()`
 * alongside `jwt()` (`apps/api/src/auth/better-auth.ts`): sign-in returns the
 * session token in a `set-auth-token` RESPONSE HEADER, the client caches it,
 * and then sends it as `Authorization: Bearer <session-token>` when calling
 * `/api/auth/token` to mint the short-lived JWT that tRPC actually uses.
 *
 * The previous implementation made `setAuthToken()` a no-op and relied on
 * `authClient.token()`, which authenticates with a cookie the app does not
 * have. Every mint returned 401, so EVERY authed procedure failed — the whole
 * signed-in surface of the app was dead. Sign-in itself succeeded, which is
 * what made it look like a per-screen bug rather than a transport one.
 *
 * This now mirrors `apps/scanner/src/features/auth/auth-token-store.ts`, which
 * the old file's docblock already claimed to mirror but did not.
 */

/** Slightly under the JWT's real TTL, so we re-mint before it expires. */
const TOKEN_TTL_MS = 55_000;

/**
 * Keep using a recent JWT when minting fails, so a brief network blip at a
 * venue doesn't present as a signed-out app.
 */
const STALE_FALLBACK_TTL_MS = 10 * 60 * 1000;

/**
 * Namespaced to mobile. MUST NOT collide with the scanner's
 * `ithasfire-scanner_session_token` — iOS keychains are per-app so a shared key
 * would technically work, but relying on that is fragile.
 */
const SESSION_KEY = "ithasfire-mobile_session_token";

let cachedJwt: { token: string; mintedAtMs: number } | null = null;
let sessionToken: string | null = null;

export function getSessionTokenSync(): string | null {
  return sessionToken;
}

/**
 * Rehydrate the session token from the keychain. Must run at startup — without
 * it the token only lives in memory and every cold start looks signed-out to
 * tRPC even though better-auth still has a session.
 */
export async function loadSessionToken(): Promise<string | null> {
  try {
    sessionToken = await SecureStore.getItemAsync(SESSION_KEY);
  } catch {
    sessionToken = null;
  }
  return sessionToken;
}

export async function setSessionToken(token: string | null): Promise<void> {
  sessionToken = token;
  // A new session invalidates any JWT minted for the old one.
  cachedJwt = null;
  try {
    if (token) {
      await SecureStore.setItemAsync(SESSION_KEY, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } else {
      await SecureStore.deleteItemAsync(SESSION_KEY);
    }
  } catch {
    // Non-fatal: the in-memory token still serves the current session, the
    // user just has to sign in again after a cold start.
  }
}

async function mintJwt(): Promise<string | null> {
  if (!sessionToken) return null;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/auth/token`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) {
      if (__DEV__) {
        console.warn("[auth] /api/auth/token failed", res.status);
      }
      return null;
    }
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch (error) {
    if (__DEV__) {
      console.warn("[auth] mint JWT error", error);
    }
    return null;
  }
}

export async function getAuthToken(): Promise<string | null> {
  if (cachedJwt && Date.now() - cachedJwt.mintedAtMs < TOKEN_TTL_MS) {
    return cachedJwt.token;
  }

  const jwt = await mintJwt();
  if (jwt) {
    cachedJwt = { token: jwt, mintedAtMs: Date.now() };
    return jwt;
  }

  if (cachedJwt && Date.now() - cachedJwt.mintedAtMs < STALE_FALLBACK_TTL_MS) {
    return cachedJwt.token;
  }
  return null;
}

export async function clearAuthToken(): Promise<void> {
  cachedJwt = null;
  sessionToken = null;
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    // Non-fatal.
  }
}

/**
 * Back-compat alias. `better-auth-client.ts`'s `fetchOptions.onSuccess` hook
 * calls this with the token read from the sign-in response BODY — the only
 * place the session token is ever handed to us, so it must actually persist.
 * (The API also sends it as a `set-auth-token` header, but RN's fetch does not
 * surface that; reading the header is what made the old version fail.)
 */
export const setAuthToken = setSessionToken;

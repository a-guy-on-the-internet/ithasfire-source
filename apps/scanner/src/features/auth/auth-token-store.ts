import * as SecureStore from "expo-secure-store";

import { getApiBaseUrl } from "../../config/api";

const TOKEN_TTL_MS = 55_000;
const SESSION_KEY = "ithasfire-scanner_session_token";

let cachedJwt: { token: string; mintedAtMs: number } | null = null;
let sessionToken: string | null = null;

export function getSessionTokenSync(): string | null {
  return sessionToken;
}

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
  cachedJwt = null;
  try {
    if (token) {
      await SecureStore.setItemAsync(SESSION_KEY, token);
    } else {
      await SecureStore.deleteItemAsync(SESSION_KEY);
    }
  } catch {
    // SecureStore failures are non-fatal — in-memory token still works for
    // the current session.
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
        console.warn("[scanner-auth] /api/auth/token failed", res.status);
      }
      return null;
    }
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch (err) {
    if (__DEV__) console.warn("[scanner-auth] mint JWT error", err);
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
  // Stale fallback: if minting failed but we have a recent JWT (< 10 min),
  // keep using it so a brief network blip doesn't sign the user out.
  if (cachedJwt && Date.now() - cachedJwt.mintedAtMs < 10 * 60 * 1000) {
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

// Back-compat: kept so existing call sites (e.g. better-auth onSuccess) that
// previously called setAuthToken still compile. Routes through setSessionToken.
export const setAuthToken = setSessionToken;

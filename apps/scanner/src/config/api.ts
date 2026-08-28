import * as SecureStore from "expo-secure-store";

import { getAppEnv } from "../lib/capabilities";

/**
 * Resolution order for the API + web + auth-origin URLs:
 *
 *   1. Developer override stored in SecureStore — wins everything. Set via
 *      Settings → Developer → "API base URL" preset chips.
 *      Cleared when the value is an empty string. Useful for pointing a
 *      dev-built APK at a localhost LAN IP without rebuilding, or for
 *      flipping between localhost and api-dev to test passkeys (the
 *      auth-origin host determines the WebAuthn RP ID, and localhost
 *      can't host a public assetlinks.json).
 *   2. `EXPO_PUBLIC_API_BASE_URL` / `EXPO_PUBLIC_WEB_BASE_URL` /
 *      `EXPO_PUBLIC_AUTH_ORIGIN` env vars, baked at build time by EAS
 *      from the active profile's `env` block in eas.json.
 *   3. Fallback to localhost — only useful when running with `expo start`
 *      against a Metro server on the same machine.
 *
 * Security note: SecureStore overrides are IGNORED in production builds
 * (defense in depth — the Settings UI also hides the Developer panel in
 * production). If a future attacker gained write access to a user's
 * SecureStore on a production binary, they still couldn't redirect API
 * traffic to a hostile host.
 *
 * The override is cached after the first sync read so every `getApiBaseUrl`
 * call doesn't hit SecureStore. `loadApiOverridesAsync` should be invoked
 * once at app boot to seed the cache before any tRPC client is created.
 */

const normalize = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
};

// Gate defaults on the *build-time* environment, not Metro's `__DEV__`.
// Local `./gradlew assembleRelease` runs produce non-DEV bundles with
// `appEnv = "development"` (unless `EXPO_PUBLIC_APP_ENV` is exported).
// Those builds expect to reach a local API via `adb reverse`, so falling
// back to hosted infrastructure is the wrong behaviour — it bypasses the
// dev's running server. Production binaries must fail closed to production
// hosts if EAS env injection is ever missing.
const isProductionBinary = getAppEnv() === "production";
const DEFAULT_API_BASE_URL = isProductionBinary
  ? "https://api.ithasfire.com"
  : "http://localhost:3001";
const DEFAULT_WEB_BASE_URL = isProductionBinary
  ? "https://ithasfire.com"
  : "http://localhost:3000";
const DEFAULT_AUTH_ORIGIN = isProductionBinary
  ? "https://ithasfire.com"
  : "http://localhost:3000";

const API_OVERRIDE_KEY = "th.scanner.api_base_url_override";
const WEB_OVERRIDE_KEY = "th.scanner.web_base_url_override";
const AUTH_ORIGIN_OVERRIDE_KEY = "th.scanner.auth_origin_override";

// Direct `process.env.EXPO_PUBLIC_*` references — `babel-preset-expo`
// only inlines the literal form. Going through a helper that touches
// `globalThis.process.env` leaves the lookup as a runtime read, which on
// Hermes resolves to `undefined` and silently falls through to the
// hardcoded default.
const ENV_API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const ENV_WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_BASE_URL;
const ENV_AUTH_ORIGIN = process.env.EXPO_PUBLIC_AUTH_ORIGIN;

// Hard gate: SecureStore overrides are *never* honoured on production
// binaries. This is the runtime half of the security model — the UI
// also hides the Developer panel — and protects against attacker-write
// scenarios in SecureStore.
const overridesAllowed = (): boolean => getAppEnv() !== "production";

// Module-level cache — populated by `loadApiOverridesAsync` at boot and
// subsequently by `setApiBaseUrlOverride` / `setWebBaseUrlOverride` /
// `setAuthOriginOverride`. Sync reads are essential because tRPC's
// `httpBatchLink` resolves the URL synchronously per request — AND
// because `better-auth-client` captures `baseURL` once at module load,
// which happens before App.tsx can `await loadApiOverridesAsync()`.
let apiOverride: string | null = null;
let webOverride: string | null = null;
let authOriginOverride: string | null = null;

// Synchronous best-effort read at module init so consumer modules
// (better-auth-client, tRPC) that capture URLs at construction time see
// the override on first paint. SecureStore.getItem is sync on Android
// only; iOS returns null and the async `loadApiOverridesAsync` picks
// it up a tick later (which is fine for tRPC's per-request URL, but
// auth-client baseURL on iOS still needs a second restart — Android
// is the primary scanner platform so we accept the asymmetry).
try {
  const syncGet = (SecureStore as { getItem?: (k: string) => string | null })
    .getItem;
  const allowed = overridesAllowed();
  if (typeof syncGet === "function" && allowed) {
    apiOverride = normalize(syncGet(API_OVERRIDE_KEY));
    webOverride = normalize(syncGet(WEB_OVERRIDE_KEY));
    authOriginOverride = normalize(syncGet(AUTH_ORIGIN_OVERRIDE_KEY));
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      // Debug only: avoid emitting override values in production logs.
      // Keeps local dev ergonomics without leaking PII or hostnames.
      // eslint-disable-next-line no-console
      console.debug("[api-init] loaded overrides (dev-only)");
    }
  }
} catch (err) {
  // SecureStore not initialised yet, or keychain locked — async load
  // will repopulate, accepting one stale auth-client request.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    // eslint-disable-next-line no-console
    console.debug(
      "[api-init] sync read failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Read the persisted overrides into module state. Call once at app boot
 * (before the tRPC client is constructed) so the first request honours
 * the override without a stale cycle.
 */
export const loadApiOverridesAsync = async (): Promise<void> => {
  if (!overridesAllowed()) {
    apiOverride = null;
    webOverride = null;
    authOriginOverride = null;
    return;
  }
  try {
    const [api, web, authOrigin] = await Promise.all([
      SecureStore.getItemAsync(API_OVERRIDE_KEY),
      SecureStore.getItemAsync(WEB_OVERRIDE_KEY),
      SecureStore.getItemAsync(AUTH_ORIGIN_OVERRIDE_KEY),
    ]);
    apiOverride = normalize(api);
    webOverride = normalize(web);
    authOriginOverride = normalize(authOrigin);
  } catch {
    apiOverride = null;
    webOverride = null;
    authOriginOverride = null;
  }
};

/**
 * Persist a new API base URL override. Pass `null` (or an empty string)
 * to clear the override and revert to the baked default.
 */
export const setApiBaseUrlOverride = async (
  next: string | null,
): Promise<void> => {
  if (!overridesAllowed()) return;
  const normalized = normalize(next);
  apiOverride = normalized;
  try {
    if (normalized) {
      await SecureStore.setItemAsync(API_OVERRIDE_KEY, normalized, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } else {
      await SecureStore.deleteItemAsync(API_OVERRIDE_KEY);
    }
  } catch {
    // SecureStore failures are rare on physical devices; cache stays in
    // memory either way so the operator's session continues to work.
  }
};

export const setWebBaseUrlOverride = async (
  next: string | null,
): Promise<void> => {
  if (!overridesAllowed()) return;
  const normalized = normalize(next);
  webOverride = normalized;
  try {
    if (normalized) {
      await SecureStore.setItemAsync(WEB_OVERRIDE_KEY, normalized, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } else {
      await SecureStore.deleteItemAsync(WEB_OVERRIDE_KEY);
    }
  } catch {
    // see above.
  }
};

export const setAuthOriginOverride = async (
  next: string | null,
): Promise<void> => {
  if (!overridesAllowed()) return;
  const normalized = normalize(next);
  authOriginOverride = normalized;
  try {
    if (normalized) {
      await SecureStore.setItemAsync(AUTH_ORIGIN_OVERRIDE_KEY, normalized, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } else {
      await SecureStore.deleteItemAsync(AUTH_ORIGIN_OVERRIDE_KEY);
    }
  } catch {
    // see above.
  }
};

export const getApiBaseUrlOverride = (): string | null => apiOverride;
export const getWebBaseUrlOverride = (): string | null => webOverride;
export const getAuthOriginOverride = (): string | null => authOriginOverride;

export const getApiBaseUrl = (): string =>
  apiOverride ?? normalize(ENV_API_BASE_URL) ?? DEFAULT_API_BASE_URL;

export const getWebBaseUrl = (): string =>
  webOverride ?? normalize(ENV_WEB_BASE_URL) ?? DEFAULT_WEB_BASE_URL;

export const getAuthOrigin = (): string =>
  authOriginOverride ?? normalize(ENV_AUTH_ORIGIN) ?? DEFAULT_AUTH_ORIGIN;

export const getTrpcHttpUrl = (): string => `${getApiBaseUrl()}/trpc`;

/**
 * Heuristic: is the currently resolved API URL one a physical Android
 * device probably can't reach? Returns true for loopback / link-local
 * addresses, which only work in a Metro dev setup with `adb reverse`
 * or against a localhost-bound API on the same machine. Internal
 * testers running a preview build over USB get silent connection
 * failures with no surface clue, so UI surfaces (NetworkBanner, Settings
 * → Developer) can call this and warn loudly.
 */
export const isApiLikelyUnreachable = (): boolean => {
  const url = getApiBaseUrl();
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::|\/|$)/i.test(
    url,
  );
};

// Boot-time loud warning: if the binary is non-`development` and we still
// resolved to a loopback URL, env injection broke between EAS and the
// runtime. The build-time check in app.config.ts should have caught this,
// but log here too in case the binary was somehow shipped past it.
if (isApiLikelyUnreachable() && getAppEnv() !== "development") {
  // eslint-disable-next-line no-console
  console.warn(
    `[api-config] API base URL resolved to a loopback address (${getApiBaseUrl()}) ` +
      `on a non-development build (appEnv=${getAppEnv()}). The device cannot reach ` +
      `localhost — set EXPO_PUBLIC_API_BASE_URL in the EAS profile, or use the ` +
      `Settings → Developer override.`,
  );
}

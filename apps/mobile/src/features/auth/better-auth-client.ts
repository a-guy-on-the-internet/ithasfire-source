import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  jwtClient,
  magicLinkClient,
} from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { getApiBaseUrl } from "@/config/api";
import { getSessionTokenSync, setSessionToken } from "./auth-token-store";

WebBrowser.maybeCompleteAuthSession();

const SCHEME = "ithasfire";
const STORAGE_PREFIX = "ithasfire-mobile";

// Literal `process.env.EXPO_PUBLIC_*` at module scope: `babel-preset-expo`
// inlines only that form. Reading it through `globalThis.process.env` stayed
// a runtime lookup, `undefined` on Hermes in EAS builds, so the origin always
// fell back to localhost. Same trap as src/config/api.ts.
const ENV_AUTH_ORIGIN = process.env.EXPO_PUBLIC_AUTH_ORIGIN;

// eas.json sets EXPO_PUBLIC_AUTH_ORIGIN for preview + production. The
// localhost fallback is dev-only: a release build missing the var sends NO
// Origin header rather than a wrong one. That holds only while the API does
// NOT mount `@better-auth/expo`'s `expo()` server plugin; if it ever does,
// the plugin promotes our `expo-origin: ithasfire://` header to Origin.
// (Better Auth only checks Origin on cookie-bearing POSTs; either way that
// request fails, but a missing header points at the config instead of
// looking like a trusted-origins bug.)
const resolveAuthOrigin = (): string | undefined => {
  const trimmed = ENV_AUTH_ORIGIN?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  // Guarded like the scanner's client: `__DEV__` is undefined outside Metro
  // (e.g. vitest), and this runs at module scope.
  return typeof __DEV__ !== "undefined" && __DEV__
    ? "http://localhost:3000"
    : undefined;
};

export const magicLinkCallbackUrl = `${SCHEME}://auth-callback`;
export const magicLinkErrorUrl = `${SCHEME}://auth-error`;

const authOrigin = resolveAuthOrigin();

export const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  plugins: [
    expoClient({
      scheme: SCHEME,
      storagePrefix: STORAGE_PREFIX,
      storage: SecureStore,
    }),
    magicLinkClient(),
    jwtClient(),
    // Email verification codes (`emailOtp.sendVerificationOtp` /
    // `emailOtp.verifyEmail`) for the B2 own-orders gate.
    emailOTPClient(),
  ],
  fetchOptions: {
    onRequest: (ctx) => {
      // RN's fetch strips Set-Cookie, so `expoClient` can never persist the
      // session cookie. We carry the session token ourselves and present it as
      // a Bearer credential — the API's `bearer()` plugin authenticates these.
      // Without this, /api/auth/token (the JWT mint every tRPC call depends on)
      // arrives unauthenticated and 401s.
      const token = getSessionTokenSync();
      if (token) {
        ctx.headers.set("Authorization", `Bearer ${token}`);
      }
      if (authOrigin) {
        ctx.headers.set("origin", authOrigin);
      }
      return ctx;
    },
    onSuccess: async (ctx) => {
      // Read the token from the response BODY, not the headers.
      //
      // The API does send it as `set-auth-token` (and CORS-exposes it), but
      // RN's fetch does not surface that header — which is why the previous
      // `ctx.response.headers.get("set-auth-token")` always came back null and
      // nothing was ever persisted. better-auth also returns `token` in the
      // sign-in/sign-up response body, which RN does give us.
      const bodyToken =
        typeof ctx.data === "object" && ctx.data !== null && "token" in ctx.data
          ? (ctx.data as { token?: string }).token
          : undefined;
      if (bodyToken) {
        await setSessionToken(bodyToken);
      }
    },
  },
});

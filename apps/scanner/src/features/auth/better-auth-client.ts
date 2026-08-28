import { createAuthClient } from "better-auth/react";
import {
  jwtClient,
  magicLinkClient,
  usernameClient,
} from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { getApiBaseUrl, getAuthOrigin } from "../../config/api";
import { getSessionTokenSync, setSessionToken } from "./auth-token-store";

WebBrowser.maybeCompleteAuthSession();

const SCHEME = "ithasfire-scanner";
const STORAGE_PREFIX = "ithasfire-scanner";

export const magicLinkCallbackUrl = `${SCHEME}://auth-callback`;
export const magicLinkErrorUrl = `${SCHEME}://auth-error`;

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
    // Surfaces `authClient.signIn.username()` so the sign-in screen can
    // accept a username as an alternative identifier when the user
    // didn't type an @.
    usernameClient(),
  ],
  fetchOptions: {
    onRequest: (ctx) => {
      // RN's fetch strips Set-Cookie, so expoClient can't persist the
      // session cookie. We carry the session token ourselves (stashed in
      // SecureStore by setSessionToken) and present it as a Bearer token —
      // the API's `bearer()` plugin authenticates these requests.
      const token = getSessionTokenSync();
      if (token) {
        ctx.headers.set("Authorization", `Bearer ${token}`);
      }
      // Resolved fresh per request so a Settings → Developer preset
      // switch (Localhost ↔ api-dev) takes effect on the *next* auth
      // call without re-importing better-auth-client. Better Auth uses
      // this origin's hostname as the WebAuthn RP ID.
      const origin = getAuthOrigin();
      if (origin) {
        ctx.headers.set("origin", origin);
      }
      return ctx;
    },
    onSuccess: async (ctx) => {
      // Sign-in / sign-up return the session token in the response body
      // (the cookie is also set, but RN's fetch implementation strips
      // Set-Cookie from response headers, so expoClient can't capture it).
      // We cache the session token here and the auth-token-store mints a
      // JWT against /api/auth/token using `Authorization: Bearer <token>`
      // — only works because the API has the `bearer()` plugin enabled.
      const bodyToken =
        typeof ctx.data === "object" && ctx.data !== null && "token" in ctx.data
          ? (ctx.data as { token?: string }).token
          : undefined;
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        // Debug-only: avoid logging request/response details in production
        // which may contain sensitive hostnames or tokens.
        // eslint-disable-next-line no-console
        console.debug("[better-auth-client] onSuccess (dev-only)");
      }
      if (bodyToken) {
        await setSessionToken(bodyToken);
      }
    },
    onError: (ctx) => {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        // eslint-disable-next-line no-console
        console.warn(
          "[better-auth-client] onError (dev-only)",
          ctx.error?.message ?? ctx.error,
        );
      }
    },
  },
});

import { createAuthClient } from "better-auth/react";
import { jwtClient, magicLinkClient } from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { getApiBaseUrl } from "@/config/api";
import { getSessionTokenSync, setSessionToken } from "./auth-token-store";

WebBrowser.maybeCompleteAuthSession();

const SCHEME = "ithasfire";
const STORAGE_PREFIX = "ithasfire-mobile";

const resolveAuthOrigin = (): string | undefined => {
  const envSource = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const envOrigin = envSource.process?.env?.EXPO_PUBLIC_AUTH_ORIGIN;
  const trimmed = envOrigin?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "http://localhost:3000";
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

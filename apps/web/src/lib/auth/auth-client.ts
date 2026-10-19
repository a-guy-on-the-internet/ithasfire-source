import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  jwtClient,
  phoneNumberClient,
  twoFactorClient,
  usernameClient,
} from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

import { publicRuntimeEnv } from "@/config/env.public";

import {
  listenForCrossTabSignOut,
  signOutSignalPlugin,
} from "./sign-out-signal-plugin";

export const authClient = createAuthClient({
  // Must be absolute so server-side code (Node fetch) doesn't try to parse relative URLs.
  // We always want to talk to the Fastify API host that serves Better Auth.
  baseURL: publicRuntimeEnv.apiBaseUrl
    ? `${publicRuntimeEnv.apiBaseUrl}/api/auth`
    : "http://localhost:3001/api/auth",
  plugins: [
    jwtClient(),
    phoneNumberClient(),
    twoFactorClient(),
    usernameClient(),
    passkeyClient(),
    emailOTPClient(),
    // Every successful sign-out drops the tRPC provider's cached bearer token.
    signOutSignalPlugin(),
  ],
});

// A sign-out in another tab drops this tab's cached bearer too. Browser only:
// the channel is localStorage-backed and nothing posts to it on the server.
// The unsubscribe lives on globalThis so a dev HMR re-evaluation of this
// module replaces the previous subscriber instead of stacking another one.
const kCrossTabSignOut = Symbol.for("th.auth.cross-tab-sign-out");
if (typeof window !== "undefined") {
  const registry = globalThis as typeof globalThis & {
    [kCrossTabSignOut]?: () => void;
  };
  registry[kCrossTabSignOut]?.();
  registry[kCrossTabSignOut] = listenForCrossTabSignOut();
}

import {
  getGlobalBroadcastChannel,
  type BetterAuthClientPlugin,
  type BroadcastChannel as AuthBroadcastChannel,
} from "better-auth/client";

import { notifySignedOut } from "./auth-epoch";

/** True when the request URL's path is a Better Auth `/sign-out` endpoint. */
function isSignOutRequest(url: URL | string): boolean {
  try {
    // Relative URLs (no baseURL) still parse against a dummy origin; the
    // query string never takes part in the match.
    return new URL(String(url), "http://localhost").pathname.endsWith(
      "/sign-out",
    );
  } catch {
    return false;
  }
}

/**
 * Fires `notifySignedOut()` for every SUCCESSFUL `/sign-out` made through
 * `authClient`, whatever the call site passes, so the tRPC provider stops
 * sending the signed-out user's bearer token (see `auth-epoch.ts`).
 *
 * Hooks `onResponse`, not `onSuccess`. In @better-fetch/fetch both lists are
 * built the same way (`initializePlugins`): the per-call option is entry 0 and
 * each plugin's hook is pushed after it, and `betterFetch` awaits them in
 * order. So a plugin hook always runs IN ADDITION to a call site's own
 * `fetchOptions.onSuccess` (AppNavbar passes one), never instead of it. But
 * every `onSuccess` hook runs after that call-site hook has finished, and is
 * skipped if it throws, and AppNavbar's calls `utils.invalidate()`, which
 * refetches queries. `onResponse` runs before any `onSuccess`, so the cache is
 * gone before the call site does anything. `response.ok` is the same test
 * `betterFetch` uses to decide whether `onSuccess` runs at all.
 */
export const signOutSignalPlugin = () =>
  ({
    id: "th-sign-out-signal",
    fetchPlugins: [
      {
        id: "th-sign-out-signal",
        name: "th-sign-out-signal",
        hooks: {
          onResponse(context) {
            if (context.response.ok && isSignOutRequest(context.request.url)) {
              notifySignedOut();
            }
          },
        },
      },
    ],
  }) satisfies BetterAuthClientPlugin;

/**
 * Turn a sign-out in ANOTHER tab of this browser into this tab's sign-out
 * signal. Both tabs share the session cookie, so that session is gone here
 * too, but this tab's tRPC provider would keep sending its fresh cached bearer
 * until the 55s TTL ran out.
 *
 * Better Auth's sign-out listener calls `broadcastSessionUpdate("signout")`,
 * which posts `{ event: "session", data: { trigger: "signout" } }` through the
 * channel `getGlobalBroadcastChannel()` returns (a public export of
 * `better-auth/client`, message typed as `BroadcastMessage`). The channel
 * delivers it through a `storage` event, which never fires in the tab that
 * posted it, so the signing-out tab is not signalled twice. The session
 * atom's refresh manager calls `setup()` on the channel; this only subscribes.
 *
 * Returns the unsubscribe function. `channel` is injectable for tests.
 */
export function listenForCrossTabSignOut(
  channel: AuthBroadcastChannel = getGlobalBroadcastChannel(),
): () => void {
  return channel.subscribe((message) => {
    if (message.event === "session" && message.data?.trigger === "signout") {
      notifySignedOut();
    }
  });
}

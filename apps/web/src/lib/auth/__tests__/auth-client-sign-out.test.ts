import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalBroadcastChannel } from "better-auth/client";

import { authClient } from "../auth-client";
import { subscribeSignedOut } from "../auth-epoch";

/**
 * Pins the WIRING in the real exported `authClient`: the plugin and the
 * cross-tab listener are registered, so a sign-out actually reaches the
 * tRPC provider's token cache. (The plugin's own behaviour is pinned in
 * `sign-out-signal-plugin.test.ts`.)
 */

const ok = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("authClient sign-out signal wiring", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function listen() {
    const listener = vi.fn();
    cleanups.push(subscribeSignedOut(listener));
    return listener;
  }

  it("a successful /sign-out through the real authClient fires the signal", async () => {
    const listener = listen();
    const customFetchImpl = vi.fn(async () => ok());

    await authClient.signOut({ fetchOptions: { customFetchImpl } });

    expect(customFetchImpl).toHaveBeenCalledTimes(1);
    expect(String(customFetchImpl.mock.calls[0])).toContain("/sign-out");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("another tab's sign-out broadcast fires the signal in this tab", () => {
    const listener = listen();
    // The session atom's refresh manager does this when useSession mounts.
    cleanups.push(getGlobalBroadcastChannel().setup());

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "better-auth.message",
        newValue: JSON.stringify({
          event: "session",
          data: { trigger: "signout" },
          clientId: "other-tab",
          timestamp: 1,
        }),
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

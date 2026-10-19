import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/client";

import { subscribeSignedOut } from "../auth-epoch";
import {
  listenForCrossTabSignOut,
  signOutSignalPlugin,
} from "../sign-out-signal-plugin";

/**
 * Drives a REAL Better Auth client (same createFetch / plugin pipeline as
 * `authClient`) against a fake fetch, so these pin both that the plugin fires
 * only on a successful `/sign-out` and that a call site's own fetch hooks
 * (AppNavbar passes `onSuccess`) add to it rather than replace it.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function makeClient(respond: (path: string) => Response) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    return respond(new URL(String(url)).pathname);
  });
  const client = createAuthClient({
    baseURL: "http://api.test/api/auth",
    plugins: [signOutSignalPlugin()],
    fetchOptions: { customFetchImpl: fetchImpl },
  });
  return { client, fetchImpl };
}

describe("signOutSignalPlugin", () => {
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  });

  function listen() {
    const listener = vi.fn();
    unsubscribes.push(subscribeSignedOut(listener));
    return listener;
  }

  it("fires the signal for a successful sign-out", async () => {
    const listener = listen();
    const { client } = makeClient(() => json({ success: true }));

    await client.signOut();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires in addition to a call site's own onSuccess, and before it", async () => {
    const listener = listen();
    const { client } = makeClient(() => json({ success: true }));
    const order: string[] = [];
    listener.mockImplementation(() => order.push("signal"));
    const onSuccess = vi.fn(() => {
      order.push("call-site onSuccess");
    });

    await client.signOut({ fetchOptions: { onSuccess } });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // The cache is gone before the call site invalidates queries.
    expect(order).toEqual(["signal", "call-site onSuccess"]);
  });

  it("still fires when the call site passes its own onResponse, or disableSignal", async () => {
    const listener = listen();
    const { client } = makeClient(() => json({ success: true }));
    const onResponse = vi.fn();

    await client.signOut({ fetchOptions: { onResponse } });
    await client.signOut({ fetchOptions: { disableSignal: true } });

    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not fire for a refused sign-out (403 INVALID_ORIGIN)", async () => {
    const listener = listen();
    const { client } = makeClient(() =>
      // Better Auth 1.6.9's /sign-out answers 200 even with no session; the
      // realistic refusal is the origin check.
      json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, 403),
    );

    const result = await client.signOut();

    expect(result.error?.status).toBe(403);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not fire for a successful sign-in", async () => {
    const listener = listen();
    const { client, fetchImpl } = makeClient((path) =>
      path.endsWith("/sign-in/email")
        ? json({ token: "t", user: { id: "u1", email: "a@b.test" } })
        : json(null),
    );

    await client.signIn.email({ email: "a@b.test", password: "pw-123456" });

    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes("/sign-in/email"),
      ),
    ).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("listenForCrossTabSignOut", () => {
  function fakeChannel() {
    let deliver: ((message: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    return {
      channel: {
        post: vi.fn(),
        setup: () => () => undefined,
        subscribe: (listener: (message: never) => void) => {
          deliver = listener as (message: Record<string, unknown>) => void;
          return unsubscribe;
        },
      },
      deliver: (message: Record<string, unknown>) => deliver?.(message),
      unsubscribe,
    };
  }

  it("signals for another tab's sign-out broadcast, and nothing else", () => {
    const listener = vi.fn();
    const stop = subscribeSignedOut(listener);
    const { channel, deliver, unsubscribe } = fakeChannel();
    const unlisten = listenForCrossTabSignOut(channel);

    deliver({ event: "session", data: { trigger: "getSession" }, clientId: "a", timestamp: 1 });
    deliver({ event: "session", data: { trigger: "updateUser" }, clientId: "a", timestamp: 1 });
    expect(listener).not.toHaveBeenCalled();

    deliver({ event: "session", data: { trigger: "signout" }, clientId: "a", timestamp: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    unlisten();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    stop();
  });
});

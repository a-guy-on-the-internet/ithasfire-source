import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => {}),
  deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock("../../config/api", () => ({
  getApiBaseUrl: () => "https://api.test",
}));

import {
  clearAuthToken,
  getAuthToken,
  setSessionToken,
} from "./auth-token-store";

/**
 * `/api/auth/token` stand-in: each call waits until the test releases it,
 * then answers with a JWT named after the bearer it was sent with.
 */
const pendingMints: Array<() => void> = [];
const mintedFor: string[] = [];

beforeEach(async () => {
  vi.stubGlobal("__DEV__", false);
  pendingMints.length = 0;
  mintedFor.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: { headers: Record<string, string> }) =>
        new Promise((resolve) => {
          const bearer = init.headers.Authorization!.replace("Bearer ", "");
          mintedFor.push(bearer);
          pendingMints.push(() =>
            resolve({
              ok: true,
              json: async () => ({ token: `jwt-for-${bearer}` }),
            }),
          );
        }),
    ),
  );
  await clearAuthToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const releaseNextMint = async () => {
  await vi.waitFor(() => expect(pendingMints.length).toBeGreaterThan(0));
  pendingMints.shift()!();
};

describe("getAuthToken across a session change mid-mint", () => {
  it("a mint still in flight at sign-out neither returns nor caches the departing operator's JWT", async () => {
    await setSessionToken("session-a");
    const inFlight = getAuthToken();
    await vi.waitFor(() => expect(mintedFor).toEqual(["session-a"]));

    await clearAuthToken();
    await releaseNextMint();

    expect(await inFlight).toBeNull();
    // Nothing cached: the next request (operator B's first) gets no bearer,
    // not A's JWT for the next 55s / 10-minute stale window.
    expect(await getAuthToken()).toBeNull();
  });

  it("a session replaced mid-mint gets a JWT for the NEW session", async () => {
    await setSessionToken("session-a");
    const inFlight = getAuthToken();
    await vi.waitFor(() => expect(mintedFor).toEqual(["session-a"]));

    await setSessionToken("session-b");
    await releaseNextMint(); // A's mint lands: discarded
    await releaseNextMint(); // the retry, for B

    expect(await inFlight).toBe("jwt-for-session-b");
    expect(mintedFor).toEqual(["session-a", "session-b"]);
    // Cached for B, so no third mint.
    expect(await getAuthToken()).toBe("jwt-for-session-b");
    expect(mintedFor).toHaveLength(2);
  });

  it("an unchanged session caches its JWT as before", async () => {
    await setSessionToken("session-a");
    const inFlight = getAuthToken();
    await releaseNextMint();

    expect(await inFlight).toBe("jwt-for-session-a");
    expect(await getAuthToken()).toBe("jwt-for-session-a");
    expect(mintedFor).toEqual(["session-a"]);
  });
});

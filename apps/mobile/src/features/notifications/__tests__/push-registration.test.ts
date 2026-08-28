import { describe, expect, it, vi } from "vitest";

import {
  clearPushTokenStore,
  createPushTokenStore,
  syncPushRegistration,
  unregisterCurrentPushDevice,
  type PushPermissionState,
  type SyncPushDeps,
} from "../push-registration";

const granted: PushPermissionState = { status: "granted", canAskAgain: true };
const denied: PushPermissionState = { status: "denied", canAskAgain: false };
const undetermined: PushPermissionState = {
  status: "undetermined",
  canAskAgain: true,
};

const makeSyncDeps = (
  overrides: Partial<Omit<SyncPushDeps, "store">> = {},
): SyncPushDeps & { store: NonNullable<SyncPushDeps["store"]> } => ({
  humanId: "human-a",
  getPermission: vi.fn().mockResolvedValue(granted),
  fetchToken: vi.fn().mockResolvedValue("ExponentPushToken[abc]"),
  register: vi.fn().mockResolvedValue({ ok: true }),
  platform: "ios",
  appId: "com.ithasfire.app",
  store: createPushTokenStore(),
  ...overrides,
});

describe("syncPushRegistration", () => {
  it("registers once when signed in with permission granted", async () => {
    const deps = makeSyncDeps();

    await expect(syncPushRegistration(deps)).resolves.toBe("registered");
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.register).toHaveBeenCalledWith({
      provider: "expo",
      token: "ExponentPushToken[abc]",
      platform: "ios",
      appId: "com.ithasfire.app",
    });
    expect(deps.store.registeredToken).toBe("ExponentPushToken[abc]");
    expect(deps.store.registeredHumanId).toBe("human-a");
  });

  it("omits appId from the payload when unavailable", async () => {
    const deps = makeSyncDeps({ appId: null });

    await syncPushRegistration(deps);
    expect(deps.register).toHaveBeenCalledWith({
      provider: "expo",
      token: "ExponentPushToken[abc]",
      platform: "ios",
    });
  });

  it("is a no-op on repeat syncs with the same token (once per session)", async () => {
    const deps = makeSyncDeps();

    await expect(syncPushRegistration(deps)).resolves.toBe("registered");
    await expect(syncPushRegistration(deps)).resolves.toBe("unchanged");
    await expect(syncPushRegistration(deps)).resolves.toBe("unchanged");
    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it("re-registers when the token rotates", async () => {
    const deps = makeSyncDeps();
    await syncPushRegistration(deps);

    (deps.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      "ExponentPushToken[rotated]",
    );
    await expect(syncPushRegistration(deps)).resolves.toBe("registered");
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(deps.store.registeredToken).toBe("ExponentPushToken[rotated]");
  });

  it("re-registers when the actor changes with the same token (account switch on one device)", async () => {
    const deps = makeSyncDeps();
    await expect(syncPushRegistration(deps)).resolves.toBe("registered");

    // User A's session dies WITHOUT unregister (expiry/revocation); user B
    // signs in on the same device — same Expo token, different human. The
    // server row still maps the token to A, so the sync MUST re-register.
    const asUserB = { ...deps, humanId: "human-b" };
    await expect(syncPushRegistration(asUserB)).resolves.toBe("registered");
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(deps.store.registeredToken).toBe("ExponentPushToken[abc]");
    expect(deps.store.registeredHumanId).toBe("human-b");
  });

  it("re-registers after a session drop that bypassed unregister (store cleared on signed-out)", async () => {
    const deps = makeSyncDeps();
    await expect(syncPushRegistration(deps)).resolves.toBe("registered");

    // The hook clears the store whenever it observes a signed-out session
    // (expiry path — signOut()/unregister never ran).
    clearPushTokenStore(deps.store);
    expect(deps.store.registeredToken).toBeNull();
    expect(deps.store.registeredHumanId).toBeNull();

    // Same account signs back in: must re-register, not short-circuit.
    await expect(syncPushRegistration(deps)).resolves.toBe("registered");
    expect(deps.register).toHaveBeenCalledTimes(2);
  });

  it("no-ops when signed out — no permission read, no token fetch", async () => {
    const deps = makeSyncDeps({ humanId: null });

    await expect(syncPushRegistration(deps)).resolves.toBe(
      "skipped-signed-out",
    );
    expect(deps.getPermission).not.toHaveBeenCalled();
    expect(deps.fetchToken).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", denied],
    ["undetermined", undetermined],
  ])("no-ops when permission is %s — never fetches a token", async (_, permission) => {
    const deps = makeSyncDeps({
      getPermission: vi.fn().mockResolvedValue(permission),
    });

    await expect(syncPushRegistration(deps)).resolves.toBe(
      "skipped-permission",
    );
    expect(deps.fetchToken).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("no-ops when the token is unavailable (simulator / no projectId)", async () => {
    const deps = makeSyncDeps({
      fetchToken: vi.fn().mockResolvedValue(null),
    });

    await expect(syncPushRegistration(deps)).resolves.toBe("skipped-no-token");
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("guards against concurrent syncs via the in-flight flag", async () => {
    let releaseRegister!: () => void;
    const deps = makeSyncDeps({
      register: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegister = resolve;
          }),
      ),
    });

    const first = syncPushRegistration(deps);
    // Give the first sync a tick to pass its guards and start registering.
    await Promise.resolve();
    const second = await syncPushRegistration(deps);
    expect(second).toBe("skipped-in-flight");

    releaseRegister();
    await expect(first).resolves.toBe("registered");
    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it("reports failures via onError, keeps the token unset, and retries next sync", async () => {
    const onError = vi.fn();
    const deps = makeSyncDeps({
      register: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue({ ok: true }),
      onError,
    });

    await expect(syncPushRegistration(deps)).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deps.store.registeredToken).toBeNull();
    expect(deps.store.inFlight).toBe(false);

    // Next sync (e.g. next foreground) retries and succeeds.
    await expect(syncPushRegistration(deps)).resolves.toBe("registered");
    expect(deps.store.registeredToken).toBe("ExponentPushToken[abc]");
  });
});

describe("unregisterCurrentPushDevice", () => {
  it("unregisters the token registered this session and clears the store", async () => {
    const store = createPushTokenStore();
    store.registeredToken = "ExponentPushToken[abc]";
    store.registeredHumanId = "human-a";
    const unregister = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      unregisterCurrentPushDevice({ unregister, store }),
    ).resolves.toBe("unregistered");
    expect(unregister).toHaveBeenCalledWith({
      token: "ExponentPushToken[abc]",
    });
    expect(store.registeredToken).toBeNull();
    expect(store.registeredHumanId).toBeNull();
  });

  it("no-ops when nothing was registered this session", async () => {
    const store = createPushTokenStore();
    const unregister = vi.fn();

    await expect(
      unregisterCurrentPushDevice({ unregister, store }),
    ).resolves.toBe("skipped-no-token");
    expect(unregister).not.toHaveBeenCalled();
  });

  it("swallows failures (best-effort) and still clears local state", async () => {
    const store = createPushTokenStore();
    store.registeredToken = "ExponentPushToken[abc]";
    store.registeredHumanId = "human-a";
    const onError = vi.fn();
    const unregister = vi.fn().mockRejectedValue(new Error("api down"));

    await expect(
      unregisterCurrentPushDevice({ unregister, store, onError }),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    // Cleared regardless so the next sign-in re-registers.
    expect(store.registeredToken).toBeNull();
    expect(store.registeredHumanId).toBeNull();
  });

  it("times out instead of blocking sign-out on a hung request", async () => {
    const store = createPushTokenStore();
    store.registeredToken = "ExponentPushToken[abc]";
    const onError = vi.fn();
    // Never resolves — simulates a dead network.
    const unregister = vi.fn().mockImplementation(() => new Promise(() => {}));

    await expect(
      unregisterCurrentPushDevice({
        unregister,
        store,
        onError,
        timeoutMs: 10,
      }),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain(
      "push_unregister_timeout",
    );
  });
});

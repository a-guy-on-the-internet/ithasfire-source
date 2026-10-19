import { describe, expect, it, vi } from "vitest";

import type { PushPort } from "@th/ports/comms/push";

import { registerPushDevice } from "../register-push-device";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

type FakeDevice = {
  humanId: string;
  provider: string;
  token: string;
  platform: string;
  appId: string | null;
  enabled: boolean;
};

/**
 * In-memory PushPort mimicking the Expo adapter's registration semantics:
 * upsert keyed on (provider, token), re-registration re-enables + reassigns
 * ownership to the registering human.
 */
function createFakePushPort() {
  const devices = new Map<string, FakeDevice>();
  const port: PushPort = {
    async registerDevice(input) {
      const key = `${input.provider}:${input.token}`;
      const existing = devices.get(key);
      devices.set(key, {
        humanId: input.humanId,
        provider: input.provider,
        token: input.token,
        platform: input.platform ?? existing?.platform ?? "unknown",
        appId: input.appId ?? existing?.appId ?? null,
        enabled: true,
      });
      return { ok: true };
    },
    async unregisterDevice() {
      return { ok: true };
    },
    async send() {
      throw new Error("not_under_test");
    },
    async health() {
      return { ok: true, vendor: "fake", latencyMs: 0 };
    },
  };
  return { port, devices };
}

describe("registerPushDevice", () => {
  it("registers a device owned by the acting human", async () => {
    const { port, devices } = createFakePushPort();

    const result = await registerPushDevice(
      { push: port },
      {
        actorHumanId: ACTOR_ID,
        provider: "expo",
        token: TOKEN,
        platform: "ios",
        appId: "com.ithasfire.app",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(devices.size).toBe(1);
    const device = [...devices.values()][0]!;
    expect(device.humanId).toBe(ACTOR_ID);
    expect(device.provider).toBe("expo");
    expect(device.token).toBe(TOKEN);
    expect(device.platform).toBe("ios");
    expect(device.appId).toBe("com.ithasfire.app");
    expect(device.enabled).toBe(true);
  });

  it("is idempotent per (provider, token): re-registering upserts a single device", async () => {
    const { port, devices } = createFakePushPort();

    await registerPushDevice(
      { push: port },
      { actorHumanId: ACTOR_ID, provider: "expo", token: TOKEN },
    );
    await registerPushDevice(
      { push: port },
      { actorHumanId: ACTOR_ID, provider: "expo", token: TOKEN },
    );

    expect(devices.size).toBe(1);
    expect([...devices.values()][0]!.enabled).toBe(true);
  });

  it("reassigns a token to the new actor when the same device signs into another account", async () => {
    const { port, devices } = createFakePushPort();

    await registerPushDevice(
      { push: port },
      { actorHumanId: OTHER_HUMAN_ID, provider: "expo", token: TOKEN },
    );
    await registerPushDevice(
      { push: port },
      { actorHumanId: ACTOR_ID, provider: "expo", token: TOKEN },
    );

    expect(devices.size).toBe(1);
    expect([...devices.values()][0]!.humanId).toBe(ACTOR_ID);
  });

  it("rejects a client-supplied target humanId (strict schema — actor only)", async () => {
    const { port } = createFakePushPort();

    await expect(
      registerPushDevice(
        { push: port },
        {
          actorHumanId: ACTOR_ID,
          // Injection attempt: registering a device for someone else.
          humanId: OTHER_HUMAN_ID,
          provider: "expo",
          token: TOKEN,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects input missing the actor", async () => {
    const { port } = createFakePushPort();

    await expect(
      registerPushDevice({ push: port }, { provider: "expo", token: TOKEN }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fails with NOT_CONFIGURED when no push port is wired", async () => {
    await expect(
      registerPushDevice(
        {},
        { actorHumanId: ACTOR_ID, provider: "expo", token: TOKEN },
      ),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("propagates port errors (e.g. invalid token format) untouched", async () => {
    const port: PushPort = {
      registerDevice: vi
        .fn()
        .mockRejectedValue({ code: "invalid_input", message: "invalid_push_token" }),
      unregisterDevice: vi.fn(),
      send: vi.fn(),
      health: vi.fn(),
    } as unknown as PushPort;

    await expect(
      registerPushDevice(
        { push: port },
        { actorHumanId: ACTOR_ID, provider: "expo", token: "garbage" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

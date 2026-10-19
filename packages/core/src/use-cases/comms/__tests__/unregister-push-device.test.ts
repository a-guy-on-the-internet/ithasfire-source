import { describe, expect, it, vi } from "vitest";

import type { PushPort } from "@th/ports/comms/push";

import { unregisterPushDevice } from "../unregister-push-device";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

function createSpyPort() {
  const unregisterDevice = vi.fn(async () => ({ ok: true as const }));
  const port = {
    registerDevice: vi.fn(),
    unregisterDevice,
    send: vi.fn(),
    health: vi.fn(),
  } as unknown as PushPort;
  return { port, unregisterDevice };
}

describe("unregisterPushDevice", () => {
  it("unregisters the actor's device (humanId comes from the actor, not the client)", async () => {
    const { port, unregisterDevice } = createSpyPort();

    const result = await unregisterPushDevice(
      { push: port },
      { actorHumanId: ACTOR_ID, token: TOKEN },
    );

    expect(result).toEqual({ ok: true });
    expect(unregisterDevice).toHaveBeenCalledTimes(1);
    expect(unregisterDevice).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      token: TOKEN,
    });
  });

  it("rejects a client-supplied humanId targeting another human (strict schema)", async () => {
    const { port, unregisterDevice } = createSpyPort();

    await expect(
      unregisterPushDevice(
        { push: port },
        { actorHumanId: ACTOR_ID, humanId: OTHER_HUMAN_ID, token: TOKEN },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(unregisterDevice).not.toHaveBeenCalled();
  });

  it("is idempotent: unregistering twice succeeds both times", async () => {
    const { port } = createSpyPort();

    await expect(
      unregisterPushDevice(
        { push: port },
        { actorHumanId: ACTOR_ID, token: TOKEN },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      unregisterPushDevice(
        { push: port },
        { actorHumanId: ACTOR_ID, token: TOKEN },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("fails with NOT_CONFIGURED when no push port is wired", async () => {
    await expect(
      unregisterPushDevice({}, { actorHumanId: ACTOR_ID, token: TOKEN }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

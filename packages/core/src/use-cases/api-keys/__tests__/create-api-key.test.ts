import { describe, expect, it, vi } from "vitest";

import {
  MAX_ACTIVE_API_KEYS_PER_HUMAN,
  createApiKey,
} from "../create-api-key";

const ACTOR = "11111111-1111-4111-8111-111111111111";

function makeDeps(
  opts: { emailVerified?: boolean; activeKeys?: number } = {},
) {
  const apiKeys = {
    create: vi.fn(async () => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      key: "thk_test_key_value",
      createdAt: new Date("2026-04-22T00:00:00Z"),
    })),
    lockAndCountActiveByHuman: vi.fn(async () => opts.activeKeys ?? 0),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR },
      identity: { emailVerified: opts.emailVerified ?? true },
    })),
  };
  const audit = { log: vi.fn(async () => {}) };

  const txRepos = { apiKeys, humans, audit };
  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: typeof txRepos) => Promise<T>) => fn(txRepos),
  } as any;

  return { repos, mocks: { apiKeys, humans, audit } };
}

describe("createApiKey", () => {
  it("creates a key and returns it with label", async () => {
    const { repos } = makeDeps();

    const result = await createApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
        label: "CI deploy key",
      },
    );

    expect(result).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      key: "thk_test_key_value",
      label: "CI deploy key",
      createdAt: new Date("2026-04-22T00:00:00Z"),
    });
  });

  it("passes humanId and label to repo", async () => {
    const { repos, mocks } = makeDeps();

    await createApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
        label: "My key",
      },
    );

    expect(mocks.apiKeys.create).toHaveBeenCalledWith({
      humanId: ACTOR,
      label: "My key",
    });
  });

  it("defaults label to null when omitted", async () => {
    const { repos } = makeDeps();

    const result = await createApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
      },
    );

    expect(result.label).toBeNull();
  });

  it("writes an audit log inside the transaction", async () => {
    const { repos, mocks } = makeDeps();

    await createApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
        label: "Audit test",
      },
    );

    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "api_key",
        entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        action: "api_key.created",
        data: expect.objectContaining({ actorHumanId: ACTOR }),
      }),
    );
  });

  it("rejects invalid input", async () => {
    const { repos } = makeDeps();

    await expect(
      createApiKey({ repos }, { label: "no actor" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  // ── F5 (2026-09-29 review): keys are permanent full-scope credentials ──

  it("refuses an actor whose email is not verified, and mints nothing", async () => {
    const { repos, mocks } = makeDeps({ emailVerified: false });

    await expect(
      createApiKey({ repos }, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(mocks.apiKeys.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it(`refuses a ${MAX_ACTIVE_API_KEYS_PER_HUMAN + 1}th active key`, async () => {
    const { repos, mocks } = makeDeps({
      activeKeys: MAX_ACTIVE_API_KEYS_PER_HUMAN,
    });

    await expect(
      createApiKey({ repos }, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "forbidden", message: "quota_exceeded" });
    expect(mocks.apiKeys.create).not.toHaveBeenCalled();
  });

  it("allows the last key under the cap and counts under the per-human lock", async () => {
    const { repos, mocks } = makeDeps({
      activeKeys: MAX_ACTIVE_API_KEYS_PER_HUMAN - 1,
    });

    await createApiKey({ repos }, { actorHumanId: ACTOR });

    expect(mocks.apiKeys.lockAndCountActiveByHuman).toHaveBeenCalledWith({
      humanId: ACTOR,
    });
    // Count (and its lock) happen BEFORE the insert, in the same tx.
    expect(
      mocks.apiKeys.lockAndCountActiveByHuman.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.apiKeys.create.mock.invocationCallOrder[0]!);
  });

  it("pins the cap at 5", () => {
    expect(MAX_ACTIVE_API_KEYS_PER_HUMAN).toBe(5);
  });
});

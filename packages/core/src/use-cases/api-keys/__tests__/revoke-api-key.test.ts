import { describe, expect, it, vi } from "vitest";

import { revokeApiKey } from "../revoke-api-key";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ACTIVE_KEY = {
  id: KEY_ID,
  humanId: ACTOR,
  label: "deploy",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  lastUsedAt: null,
  revokedAt: null,
};

function makeDeps(existing = ACTIVE_KEY as typeof ACTIVE_KEY | null) {
  const apiKeys = {
    getById: vi.fn(async () => existing),
    revoke: vi.fn(async () => {}),
  };
  const audit = { log: vi.fn(async () => {}) };

  const txRepos = { apiKeys, audit };
  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: typeof txRepos) => Promise<T>) => fn(txRepos),
  } as any;

  return { repos, mocks: { apiKeys, audit } };
}

describe("revokeApiKey", () => {
  it("revokes an active key", async () => {
    const { repos, mocks } = makeDeps();

    await revokeApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
        apiKeyId: KEY_ID,
      },
    );

    expect(mocks.apiKeys.revoke).toHaveBeenCalledWith({
      apiKeyId: KEY_ID,
      humanId: ACTOR,
    });
  });

  it("writes an audit log", async () => {
    const { repos, mocks } = makeDeps();

    await revokeApiKey(
      { repos },
      {
        actorHumanId: ACTOR,
        apiKeyId: KEY_ID,
      },
    );

    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "api_key",
        entityId: KEY_ID,
        action: "api_key.revoked",
      }),
    );
  });

  it("throws not_found when key does not exist", async () => {
    const { repos } = makeDeps(null);

    await expect(
      revokeApiKey(
        { repos },
        {
          actorHumanId: ACTOR,
          apiKeyId: KEY_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
  });

  it("throws conflict when key is already revoked", async () => {
    const { repos } = makeDeps({
      ...ACTIVE_KEY,
      revokedAt: new Date("2026-04-20T00:00:00Z"),
    });

    await expect(
      revokeApiKey(
        { repos },
        {
          actorHumanId: ACTOR,
          apiKeyId: KEY_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "API_KEY_ALREADY_REVOKED" });
  });

  it("does not call revoke when key is not found", async () => {
    const { repos, mocks } = makeDeps(null);

    await expect(
      revokeApiKey(
        { repos },
        {
          actorHumanId: ACTOR,
          apiKeyId: KEY_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });

    expect(mocks.apiKeys.revoke).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const { repos } = makeDeps();

    await expect(
      revokeApiKey({ repos }, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

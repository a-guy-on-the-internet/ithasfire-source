import { describe, expect, it, vi } from "vitest";

import { listApiKeys } from "../list-api-keys";

const ACTOR = "11111111-1111-4111-8111-111111111111";

const SAMPLE_KEY = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  humanId: ACTOR,
  label: "deploy",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  lastUsedAt: new Date("2026-04-20T00:00:00Z"),
  revokedAt: null,
};

function makeDeps(items = [SAMPLE_KEY], total = items.length) {
  const apiKeys = {
    listByHuman: vi.fn(async () => ({ items, total })),
  };

  return {
    repos: { apiKeys } as any,
    mocks: { apiKeys },
  };
}

describe("listApiKeys", () => {
  it("returns items with page info", async () => {
    const { repos } = makeDeps();

    const result = await listApiKeys(
      { repos },
      {
        actorHumanId: ACTOR,
      },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: SAMPLE_KEY.id,
      label: "deploy",
      createdAt: SAMPLE_KEY.createdAt,
      lastUsedAt: SAMPLE_KEY.lastUsedAt,
      revokedAt: null,
    });
    expect(result.pageInfo).toMatchObject({
      total: 1,
      count: 1,
      hasNextPage: false,
      nextOffset: null,
    });
  });

  it("applies default limit and offset", async () => {
    const { repos, mocks } = makeDeps();

    await listApiKeys({ repos }, { actorHumanId: ACTOR });

    expect(mocks.apiKeys.listByHuman).toHaveBeenCalledWith({
      humanId: ACTOR,
      limit: 25,
      offset: 0,
    });
  });

  it("passes custom pagination", async () => {
    const { repos, mocks } = makeDeps();

    await listApiKeys(
      { repos },
      {
        actorHumanId: ACTOR,
        limit: 10,
        offset: 20,
      },
    );

    expect(mocks.apiKeys.listByHuman).toHaveBeenCalledWith({
      humanId: ACTOR,
      limit: 10,
      offset: 20,
    });
  });

  it("computes hasNextPage correctly", async () => {
    const { repos } = makeDeps([SAMPLE_KEY], 5);

    const result = await listApiKeys(
      { repos },
      {
        actorHumanId: ACTOR,
        limit: 1,
        offset: 0,
      },
    );

    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.nextOffset).toBe(1);
  });

  it("returns empty list", async () => {
    const { repos } = makeDeps([], 0);

    const result = await listApiKeys(
      { repos },
      {
        actorHumanId: ACTOR,
      },
    );

    expect(result.items).toHaveLength(0);
    expect(result.pageInfo.total).toBe(0);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("rejects invalid input", async () => {
    const { repos } = makeDeps();

    await expect(listApiKeys({ repos }, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

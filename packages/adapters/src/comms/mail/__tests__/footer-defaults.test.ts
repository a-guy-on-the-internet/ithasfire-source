import { describe, expect, it, vi } from "vitest";

import { createFooterDefaultsCache } from "../footer-defaults";

type Row = { key: string; value: string };

const makeRepo = (rows: Row[]) => ({
  getAll: vi.fn(async () => rows),
});

describe("createFooterDefaultsCache", () => {
  it("resolves each field from platform settings", async () => {
    const repo = makeRepo([
      { key: "email:physicalAddress", value: "123 Main St, Austin, TX" },
      { key: "supportEmail", value: "help@example.com" },
      { key: "platformName", value: "Acme Tickets" },
    ]);
    const cache = createFooterDefaultsCache({ platformSettings: repo });

    expect(await cache.resolve()).toEqual({
      physicalAddress: "123 Main St, Austin, TX",
      contactEmail: "help@example.com",
      brandName: "Acme Tickets",
    });
  });

  it("falls back to env defaults when a setting is absent or blank", async () => {
    const repo = makeRepo([{ key: "email:physicalAddress", value: "   " }]);
    const cache = createFooterDefaultsCache({
      platformSettings: repo,
      fallback: {
        physicalAddress: "Fallback Addr",
        brandName: "Fallback Brand",
      },
    });

    expect(await cache.resolve()).toEqual({
      physicalAddress: "Fallback Addr",
      contactEmail: undefined,
      brandName: "Fallback Brand",
    });
  });

  it("caches reads until the TTL backstop expires", async () => {
    const repo = makeRepo([{ key: "platformName", value: "First" }]);
    let nowMs = 1_000;
    const cache = createFooterDefaultsCache({
      platformSettings: repo,
      ttlMs: 100,
      now: () => nowMs,
    });

    await cache.resolve();
    await cache.resolve();
    expect(repo.getAll).toHaveBeenCalledTimes(1);

    nowMs += 101;
    await cache.resolve();
    expect(repo.getAll).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next resolve to re-read", async () => {
    const repo = makeRepo([{ key: "platformName", value: "First" }]);
    const cache = createFooterDefaultsCache({ platformSettings: repo });

    await cache.resolve();
    cache.invalidate();
    await cache.resolve();

    expect(repo.getAll).toHaveBeenCalledTimes(2);
  });

  it("returns fallback without poisoning the cache when the read fails", async () => {
    const getAll = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce([{ key: "platformName", value: "Recovered" }]);
    const cache = createFooterDefaultsCache({
      platformSettings: { getAll },
      fallback: { brandName: "Fallback Brand" },
    });

    expect(await cache.resolve()).toEqual({ brandName: "Fallback Brand" });

    expect(await cache.resolve()).toEqual({
      physicalAddress: undefined,
      contactEmail: undefined,
      brandName: "Recovered",
    });
    expect(getAll).toHaveBeenCalledTimes(2);
  });
});

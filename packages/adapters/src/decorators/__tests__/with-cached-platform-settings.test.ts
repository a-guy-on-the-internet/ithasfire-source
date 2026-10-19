import { describe, expect, it, vi } from "vitest";

import { withCachedPlatformSettings } from "../with-cached-platform-settings";
import {
  createCacheGeneration,
  type CacheGenerationStore,
} from "../cache-generation";
import type { PlatformSettingRecord } from "@th/ports/repos/platform-settings";

const row = (key: string, value: string): PlatformSettingRecord =>
  ({ key, value }) as PlatformSettingRecord;

function makeInner(rows: PlatformSettingRecord[] = [row("a", "1")]) {
  let current = rows;
  const getAll = vi.fn(async () => current);
  const get = vi.fn(
    async (key: string) => current.find((r) => r.key === key) ?? null,
  );
  const upsert = vi.fn(async (key: string, value: string) => {
    current = [...current.filter((r) => r.key !== key), row(key, value)];
    return row(key, value);
  });
  return {
    inner: { getAll, get, upsert } as never,
    mocks: { getAll, get, upsert },
    setRows: (next: PlatformSettingRecord[]) => {
      current = next;
    },
  };
}

describe("withCachedPlatformSettings", () => {
  it("reads the table once and serves subsequent getAll from cache", async () => {
    const { inner, mocks } = makeInner();
    const repo = withCachedPlatformSettings(inner);

    await repo.getAll();
    await repo.getAll();
    await repo.getAll();

    expect(mocks.getAll).toHaveBeenCalledTimes(1);
  });

  it("serves get(key) from the same snapshot without a findUnique", async () => {
    const { inner, mocks } = makeInner([row("a", "1"), row("b", "2")]);
    const repo = withCachedPlatformSettings(inner);

    await expect(repo.get("b" as never)).resolves.toEqual(row("b", "2"));
    await expect(repo.get("a" as never)).resolves.toEqual(row("a", "1"));
    await expect(repo.get("missing" as never)).resolves.toBeNull();

    // One table read total; the underlying `get` is never used.
    expect(mocks.getAll).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("collapses a concurrent cold-cache stampede into one read", async () => {
    // The batched-tRPC case: several callers miss simultaneously.
    const { inner, mocks } = makeInner();
    const repo = withCachedPlatformSettings(inner);

    await Promise.all([
      repo.getAll(),
      repo.getAll(),
      repo.get("a" as never),
      repo.getAll(),
    ]);

    expect(mocks.getAll).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the TTL backstop expires", async () => {
    let clock = 1_000;
    const { inner, mocks } = makeInner();
    const repo = withCachedPlatformSettings(inner, {
      ttlMs: 60_000,
      now: () => clock,
    });

    await repo.getAll();
    clock += 59_000;
    await repo.getAll();
    expect(mocks.getAll).toHaveBeenCalledTimes(1);

    clock += 2_000; // now past the TTL
    await repo.getAll();
    expect(mocks.getAll).toHaveBeenCalledTimes(2);
  });

  it("write-through: upsert invalidates so the writer reads its own write", async () => {
    const { inner, mocks } = makeInner([row("a", "1")]);
    const repo = withCachedPlatformSettings(inner);

    await repo.getAll();
    await repo.upsert("a" as never, "2");

    await expect(repo.get("a" as never)).resolves.toEqual(row("a", "2"));
    expect(mocks.upsert).toHaveBeenCalledWith("a", "2");
    // One read before the write, one after the invalidation.
    expect(mocks.getAll).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next read to hit the table", async () => {
    const { inner, mocks, setRows } = makeInner();
    const repo = withCachedPlatformSettings(inner);

    await repo.getAll();
    setRows([row("a", "changed")]);
    repo.invalidate();

    await expect(repo.getAll()).resolves.toEqual([row("a", "changed")]);
    expect(mocks.getAll).toHaveBeenCalledTimes(2);
  });

  it("a failed read does not wedge later callers on a rejected promise", async () => {
    const getAll = vi
      .fn<[], Promise<PlatformSettingRecord[]>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue([row("a", "1")]);
    const repo = withCachedPlatformSettings({ getAll } as never);

    await expect(repo.getAll()).rejects.toThrow("db down");
    // The in-flight promise must have been cleared, so this retries cleanly.
    await expect(repo.getAll()).resolves.toEqual([row("a", "1")]);
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read as an empty snapshot", async () => {
    const getAll = vi
      .fn<[], Promise<PlatformSettingRecord[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([row("k", "v")]);
    const repo = withCachedPlatformSettings({ getAll } as never);

    await expect(repo.getAll()).rejects.toThrow("boom");
    await expect(repo.get("k" as never)).resolves.toEqual(row("k", "v"));
  });

  // ── Split freshness (2026-09-30): long snapshot for gates, short for point reads
  describe("pointReadTtlMs", () => {
    const FIFTEEN_MIN = 15 * 60_000;

    it("getAll() serves the snapshot for the full ttlMs", async () => {
      let clock = 1_000;
      const { inner, mocks } = makeInner();
      const repo = withCachedPlatformSettings(inner, {
        ttlMs: FIFTEEN_MIN,
        pointReadTtlMs: 60_000,
        now: () => clock,
      });

      await repo.getAll();
      clock += FIFTEEN_MIN - 1;
      await repo.getAll();
      expect(mocks.getAll).toHaveBeenCalledTimes(1);

      clock += 1;
      await repo.getAll();
      expect(mocks.getAll).toHaveBeenCalledTimes(2);
    });

    it("get(key) refreshes a snapshot older than pointReadTtlMs, and the refresh serves getAll() too", async () => {
      let clock = 1_000;
      const { inner, mocks, setRows } = makeInner([row("a", "1")]);
      const repo = withCachedPlatformSettings(inner, {
        ttlMs: FIFTEEN_MIN,
        pointReadTtlMs: 60_000,
        now: () => clock,
      });

      await repo.getAll();
      // Another process (the jobs service) changes a row; this instance is
      // never told.
      setRows([row("a", "2")]);

      clock += 59_999;
      await expect(repo.get("a" as never)).resolves.toEqual(row("a", "1"));
      expect(mocks.getAll).toHaveBeenCalledTimes(1);

      clock += 1;
      await expect(repo.get("a" as never)).resolves.toEqual(row("a", "2"));
      expect(mocks.getAll).toHaveBeenCalledTimes(2);

      await expect(repo.getAll()).resolves.toEqual([row("a", "2")]);
      expect(mocks.getAll).toHaveBeenCalledTimes(2);
    });

    it("never lets a point read accept an older snapshot than getAll()", async () => {
      let clock = 1_000;
      const { inner, mocks } = makeInner();
      const repo = withCachedPlatformSettings(inner, {
        ttlMs: 60_000,
        pointReadTtlMs: FIFTEEN_MIN,
        now: () => clock,
      });

      await repo.get("a" as never);
      clock += 60_000;
      await repo.get("a" as never);
      expect(mocks.getAll).toHaveBeenCalledTimes(2);
    });

    it("the writer still reads its own write at once under the long TTL", async () => {
      let clock = 1_000;
      const { inner, setRows } = makeInner([row("feature:resale", "false")]);
      const repo = withCachedPlatformSettings(inner, {
        ttlMs: FIFTEEN_MIN,
        pointReadTtlMs: 60_000,
        now: () => clock,
      });

      await repo.getAll();
      // `updatePlatformSetting` writes inside a transaction (not through this
      // wrapper), then the platform router calls invalidate().
      setRows([row("feature:resale", "true")]);
      clock += 1;
      repo.invalidate();

      await expect(repo.getAll()).resolves.toEqual([
        row("feature:resale", "true"),
      ]);
    });
  });

  it("a read in flight across an invalidation does not become the snapshot", async () => {
    let release!: (rows: PlatformSettingRecord[]) => void;
    const getAll = vi
      .fn<[], Promise<PlatformSettingRecord[]>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([row("a", "post-write")]);
    const repo = withCachedPlatformSettings({ getAll } as never, {
      ttlMs: 15 * 60_000,
    });

    const preWrite = repo.getAll();
    // The table read has started (it is issued on a microtask).
    await vi.waitFor(() => expect(getAll).toHaveBeenCalledTimes(1));
    repo.invalidate(); // the write lands while that read is still running
    release([row("a", "pre-write")]);
    await expect(preWrite).resolves.toEqual([row("a", "pre-write")]);

    await expect(repo.getAll()).resolves.toEqual([row("a", "post-write")]);
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  // ── Cross-instance flips through the shared generation ─────────────────
  describe("with a generation", () => {
    const FIFTEEN_MIN = 15 * 60_000;
    const MEMO = 10_000;

    /** One PlatformSetting table and one Redis counter, two API instances. */
    function twoInstances() {
      let clock = 1_000;
      const now = () => clock;
      const db = makeInner([row("feature:humanProfilesPublic", "true")]);
      let counter = 0;
      let redisDown = false;
      const store: CacheGenerationStore = {
        read: vi.fn(async () => {
          if (redisDown) throw new Error("ECONNREFUSED");
          return String(counter);
        }),
        bump: vi.fn(async () => {
          if (redisDown) throw new Error("ECONNREFUSED");
          counter += 1;
          return String(counter);
        }),
      };
      const make = () => {
        const generation = createCacheGeneration({ store, now }).reader(MEMO);
        const repo = withCachedPlatformSettings(db.inner, {
          ttlMs: FIFTEEN_MIN,
          pointReadTtlMs: 60_000,
          generation,
          now,
        });
        return { generation, repo };
      };
      return {
        a: make(),
        b: make(),
        db,
        advance: (ms: number) => (clock += ms),
        setRedisDown: (d: boolean) => (redisDown = d),
      };
    }

    it("a flag flipped on instance A reaches instance B within the memo window, not the TTL", async () => {
      const { a, b, db, advance } = twoInstances();
      await a.repo.getAll();
      await b.repo.getAll();

      // Admin turns public human profiles OFF on A: tx write, router
      // invalidate(), then the mutation middleware bumps the generation.
      db.setRows([row("feature:humanProfilesPublic", "false")]);
      a.repo.invalidate();
      await a.generation.bump("platform.updatePlatformSetting");

      await expect(a.repo.getAll()).resolves.toEqual([
        row("feature:humanProfilesPublic", "false"),
      ]);
      // B inside its memo window may still answer the old snapshot...
      advance(MEMO);
      // ...and after it, B re-reads — minutes before its 15-minute TTL.
      await expect(b.repo.getAll()).resolves.toEqual([
        row("feature:humanProfilesPublic", "false"),
      ]);
    });

    it("an unchanged generation keeps serving the snapshot for the full TTL", async () => {
      const { a, db, advance } = twoInstances();
      await a.repo.getAll();
      advance(FIFTEEN_MIN - 1);
      await a.repo.getAll();
      expect(db.mocks.getAll).toHaveBeenCalledTimes(1);
    });

    it("shared store down: getAll reads fresh and stores nothing", async () => {
      const { a, db, setRedisDown, advance } = twoInstances();
      await a.repo.getAll();
      setRedisDown(true);
      advance(MEMO);

      await a.repo.getAll();
      await a.repo.getAll();
      expect(db.mocks.getAll).toHaveBeenCalledTimes(3);
    });

    it("a generation port that rejects: reads fresh, stores nothing, and reports", async () => {
      const db = makeInner();
      const reportError = vi.fn();
      const repo = withCachedPlatformSettings(db.inner, {
        ttlMs: FIFTEEN_MIN,
        generation: {
          current: async () => {
            throw new Error("port broken");
          },
          bump: async () => undefined,
        },
        reportError,
      });

      await repo.getAll();
      await repo.getAll();
      expect(db.mocks.getAll).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { cache: "platform-settings", fallback: "uncached" },
      });
    });

    it("point reads keep their 60s bound without consulting the generation", async () => {
      const { a, db, advance } = twoInstances();
      await a.repo.get("feature:humanProfilesPublic" as never);
      advance(30_000);
      await a.repo.get("feature:humanProfilesPublic" as never);
      expect(db.mocks.getAll).toHaveBeenCalledTimes(1);
    });
  });
});

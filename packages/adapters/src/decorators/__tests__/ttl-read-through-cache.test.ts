import { describe, expect, it, vi } from "vitest";

import { createTtlReadThroughCache } from "../ttl-read-through-cache";

const TTL = 15 * 60 * 1000;

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTtlReadThroughCache", () => {
  it("loads once on a miss and serves later reads from memory", async () => {
    const clock = makeClock();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      now: clock.now,
    });
    const load = vi.fn(async () => ({ n: 1 }));

    const first = await cache.getOrLoad("k", load);
    clock.advance(TTL - 1);
    const second = await cache.getOrLoad("k", load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("reloads once the TTL has passed", async () => {
    const clock = makeClock();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      now: clock.now,
    });
    let n = 0;
    const load = vi.fn(async () => ++n);

    await expect(cache.getOrLoad("k", load)).resolves.toBe(1);
    clock.advance(TTL);
    await expect(cache.getOrLoad("k", load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries independently", async () => {
    const cache = createTtlReadThroughCache({ name: "t", ttlMs: TTL });
    const a = await cache.getOrLoad("a", async () => "A");
    const b = await cache.getOrLoad("b", async () => "B");
    expect([a, b]).toEqual(["A", "B"]);
  });

  it("shares one load between concurrent misses for the same key", async () => {
    const cache = createTtlReadThroughCache({ name: "t", ttlMs: TTL });
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);

    const calls = [
      cache.getOrLoad("k", load),
      cache.getOrLoad("k", load),
      cache.getOrLoad("k", load),
    ];
    gate.resolve("v");

    await expect(Promise.all(calls)).resolves.toEqual(["v", "v", "v"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure: with no prior value the error propagates and the next call retries", async () => {
    const reportError = vi.fn();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      reportError,
    });
    const boom = new Error("db down");

    await expect(
      cache.getOrLoad("k", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    // Nothing was swallowed, so nothing to report — the caller sees the throw.
    expect(reportError).not.toHaveBeenCalled();

    await expect(cache.getOrLoad("k", async () => "ok")).resolves.toBe("ok");
  });

  it("turns a synchronously-throwing loader into a rejection", async () => {
    const cache = createTtlReadThroughCache({ name: "t", ttlMs: TTL });
    await expect(
      cache.getOrLoad("k", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(cache.getOrLoad("k", async () => 1)).resolves.toBe(1);
  });

  it("by default never serves stale: a failed reload throws even with an expired entry", async () => {
    const clock = makeClock();
    const reportError = vi.fn();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      now: clock.now,
      reportError,
    });
    await cache.getOrLoad("k", async () => "good");
    clock.advance(TTL);

    await expect(
      cache.getOrLoad("k", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("serves the stale value and reports when a reload fails (opt-in)", async () => {
    const clock = makeClock();
    const reportError = vi.fn();
    const logger = { warn: vi.fn() } as never;
    const cache = createTtlReadThroughCache({
      name: "public-discovery",
      ttlMs: TTL,
      staleIfErrorMs: 60 * 60 * 1000,
      now: clock.now,
      reportError,
      logger,
    });
    await cache.getOrLoad("k", async () => "good");
    clock.advance(TTL + 1);
    const boom = new Error("db down");

    await expect(
      cache.getOrLoad("k", async () => {
        throw boom;
      }),
    ).resolves.toBe("good");

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { cache: "public-discovery", fallback: "stale" },
      extra: { key: "k", ageMs: TTL + 1 },
    });

    // The failure did not refresh the entry: the next call tries the DB again.
    const load = vi.fn(async () => "fresh");
    await expect(cache.getOrLoad("k", load)).resolves.toBe("fresh");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops serving stale once the stale-if-error window is spent", async () => {
    const clock = makeClock();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      staleIfErrorMs: 1000,
      now: clock.now,
    });
    await cache.getOrLoad("k", async () => "good");
    clock.advance(TTL + 1000);

    await expect(
      cache.getOrLoad("k", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });

  it("a throwing reporter does not break the stale fallback", async () => {
    const clock = makeClock();
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      staleIfErrorMs: 60 * 60 * 1000,
      now: clock.now,
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await cache.getOrLoad("k", async () => "good");
    clock.advance(TTL);

    await expect(
      cache.getOrLoad("k", async () => {
        throw new Error("db down");
      }),
    ).resolves.toBe("good");
  });

  it("evicts the least-recently-used key past maxEntries", async () => {
    const cache = createTtlReadThroughCache({
      name: "t",
      ttlMs: TTL,
      maxEntries: 2,
    });
    await cache.getOrLoad("a", async () => "A");
    await cache.getOrLoad("b", async () => "B");
    // Touch `a`, so `b` is now the least recently used.
    await cache.getOrLoad("a", async () => "A2");
    await cache.getOrLoad("c", async () => "C");

    const reloadA = vi.fn(async () => "A3");
    const reloadB = vi.fn(async () => "B2");
    await expect(cache.getOrLoad("a", reloadA)).resolves.toBe("A");
    await expect(cache.getOrLoad("b", reloadB)).resolves.toBe("B2");
    expect(reloadA).not.toHaveBeenCalled();
    expect(reloadB).toHaveBeenCalledTimes(1);
  });

  it("clear() drops entries, and a load that started before it does not repopulate", async () => {
    const cache = createTtlReadThroughCache({ name: "t", ttlMs: TTL });
    await cache.getOrLoad("k", async () => "old");

    cache.clear();
    const load = vi.fn(async () => "new");
    await expect(cache.getOrLoad("k", load)).resolves.toBe("new");
    expect(load).toHaveBeenCalledTimes(1);

    // In-flight across a clear: the caller still gets its value, but it is
    // not stored.
    const gate = deferred<string>();
    cache.clear();
    const racing = cache.getOrLoad("r", () => gate.promise);
    cache.clear();
    gate.resolve("pre-clear");
    await expect(racing).resolves.toBe("pre-clear");

    const after = vi.fn(async () => "post-clear");
    await expect(cache.getOrLoad("r", after)).resolves.toBe("post-clear");
    expect(after).toHaveBeenCalledTimes(1);
  });

  // ── Cross-instance generation ──────────────────────────────────────────
  describe("with a generation", () => {
    /** A controllable CacheGenerationPort. */
    const makeGeneration = (initial: string | null = "1") => {
      let value: string | null = initial;
      return {
        port: {
          current: vi.fn(async () => value),
          bump: vi.fn(async () => undefined),
        },
        set: (next: string | null) => {
          value = next;
        },
      };
    };

    it("serves within the TTL while the generation is unchanged", async () => {
      const gen = makeGeneration();
      const cache = createTtlReadThroughCache({
        name: "t",
        ttlMs: TTL,
        generation: gen.port,
      });
      const load = vi.fn(async () => "v");

      await cache.getOrLoad("k", load);
      await cache.getOrLoad("k", load);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("reloads as soon as the generation moves, well inside the TTL", async () => {
      const gen = makeGeneration("1");
      const cache = createTtlReadThroughCache({
        name: "t",
        ttlMs: TTL,
        generation: gen.port,
      });
      let label = "123 Main St";
      const load = vi.fn(async () => label);

      await expect(cache.getOrLoad("k", load)).resolves.toBe("123 Main St");
      // The venue withholds its address; the write bumps the generation.
      label = "Nashville, TN";
      gen.set("2");
      await expect(cache.getOrLoad("k", load)).resolves.toBe("Nashville, TN");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("unknown generation (store down): reads fresh every time and stores nothing", async () => {
      const gen = makeGeneration("1");
      const cache = createTtlReadThroughCache({
        name: "t",
        ttlMs: TTL,
        generation: gen.port,
      });
      const load = vi.fn(async () => "v");

      await cache.getOrLoad("k", load);
      gen.set(null);
      await cache.getOrLoad("k", load);
      await cache.getOrLoad("k", load);
      expect(load).toHaveBeenCalledTimes(3);

      // Store back, same generation as the original entry: served again —
      // nothing loaded while the store was down replaced it.
      gen.set("1");
      await cache.getOrLoad("k", load);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it("a generation port that rejects is treated as unknown", async () => {
      const reportError = vi.fn();
      const cache = createTtlReadThroughCache({
        name: "public-discovery",
        reportError,
        ttlMs: TTL,
        generation: {
          current: async () => {
            throw new Error("boom");
          },
          bump: async () => undefined,
        },
      });
      const load = vi.fn(async () => "v");
      await cache.getOrLoad("k", load);
      await cache.getOrLoad("k", load);
      expect(load).toHaveBeenCalledTimes(2);
      // The swallow is reported (CLAUDE.md reporter rule).
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { cache: "public-discovery", fallback: "uncached" },
      });
    });

    it("never serves a stale entry from an older generation, even with staleIfErrorMs", async () => {
      const clock = makeClock();
      const gen = makeGeneration("1");
      const cache = createTtlReadThroughCache({
        name: "t",
        ttlMs: TTL,
        staleIfErrorMs: TTL,
        generation: gen.port,
        now: clock.now,
      });
      await cache.getOrLoad("k", async () => "123 Main St");
      gen.set("2");

      await expect(
        cache.getOrLoad("k", async () => {
          throw new Error("db down");
        }),
      ).rejects.toThrow("db down");
    });

    it("a load that started under the old generation is not joined by a request under the new one", async () => {
      const gen = makeGeneration("1");
      const cache = createTtlReadThroughCache({
        name: "t",
        ttlMs: TTL,
        generation: gen.port,
      });
      const gate = deferred<string>();
      const oldRead = cache.getOrLoad("k", () => gate.promise);
      await vi.waitFor(() => expect(gen.port.current).toHaveBeenCalled());

      gen.set("2");
      const freshLoad = vi.fn(async () => "post-write");
      const newRead = cache.getOrLoad("k", freshLoad);
      gate.resolve("pre-write");

      await expect(oldRead).resolves.toBe("pre-write");
      await expect(newRead).resolves.toBe("post-write");
      expect(freshLoad).toHaveBeenCalledTimes(1);
      // And the cache now holds the post-write value for generation 2.
      await expect(cache.getOrLoad("k", vi.fn())).resolves.toBe("post-write");
    });
  });
});

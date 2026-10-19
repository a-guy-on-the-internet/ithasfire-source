import { describe, expect, it, vi } from "vitest";

import {
  createCacheGeneration,
  createRedisCacheGenerationStore,
  type CacheGenerationStore,
} from "../cache-generation";

const MEMO = 10_000;

/** One shared counter, as Redis would be for every process. */
function makeSharedStore(initial = 100) {
  let counter = initial;
  let down = false;
  const store: CacheGenerationStore = {
    read: vi.fn(async () => {
      if (down) throw new Error("ECONNREFUSED");
      return String(counter);
    }),
    bump: vi.fn(async () => {
      if (down) throw new Error("ECONNREFUSED");
      counter += 1;
      return String(counter);
    }),
  };
  return {
    store,
    setDown: (d: boolean) => {
      down = d;
    },
    counter: () => counter,
  };
}

function makeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createCacheGeneration — readers", () => {
  it("a reader reads the store at most once per its memo window", async () => {
    const shared = makeSharedStore();
    const clock = makeClock();
    const reader = createCacheGeneration({
      store: shared.store,
      now: clock.now,
    }).reader(MEMO);

    const a = await reader.current();
    clock.advance(MEMO - 1);
    expect(await reader.current()).toBe(a);
    expect(shared.store.read).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await reader.current();
    expect(shared.store.read).toHaveBeenCalledTimes(2);
  });

  it("readers with different memo windows read independently (10s vs 60s)", async () => {
    const shared = makeSharedStore();
    const clock = makeClock();
    const gen = createCacheGeneration({ store: shared.store, now: clock.now });
    const fast = gen.reader(10_000);
    const slow = gen.reader(60_000);

    await fast.current();
    await slow.current();
    clock.advance(10_000);
    await fast.current();
    await slow.current();
    // fast re-read once; slow did not.
    expect(shared.store.read).toHaveBeenCalledTimes(3);
  });

  it("collapses concurrent reads into one store call", async () => {
    const shared = makeSharedStore();
    const reader = createCacheGeneration({ store: shared.store }).reader(MEMO);
    await Promise.all([reader.current(), reader.current(), reader.current()]);
    expect(shared.store.read).toHaveBeenCalledTimes(1);
  });

  it("store down on read → null (unknown) for the memo window, then retried", async () => {
    const shared = makeSharedStore();
    const clock = makeClock();
    const reportError = vi.fn();
    const reader = createCacheGeneration({
      store: shared.store,
      now: clock.now,
      reportError,
    }).reader(MEMO);
    shared.setDown(true);

    expect(await reader.current()).toBeNull();
    expect(await reader.current()).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { area: "cache-generation", op: "read" },
    });

    shared.setDown(false);
    clock.advance(MEMO);
    expect(await reader.current()).not.toBeNull();
  });
});

describe("createCacheGeneration — bump", () => {
  it("moves EVERY reader on this instance synchronously, before the store answers", async () => {
    const shared = makeSharedStore();
    const gen = createCacheGeneration({ store: shared.store });
    const fast = gen.reader(10_000);
    const slow = gen.reader(60_000);
    const [f0, s0] = [await fast.current(), await slow.current()];

    const bumping = gen.bump("events.unpublishEvent");
    expect(await fast.current()).not.toBe(f0);
    expect(await slow.current()).not.toBe(s0);
    await bumping;
  });

  it("another instance sees the bump once its memo window lapses", async () => {
    const shared = makeSharedStore();
    const clock = makeClock();
    const writer = createCacheGeneration({ store: shared.store, now: clock.now });
    const other = createCacheGeneration({
      store: shared.store,
      now: clock.now,
    }).reader(MEMO);
    const before = await other.current();

    await writer.bump("places.upsert");
    expect(await other.current()).toBe(before); // inside its memo window
    clock.advance(MEMO);
    expect(await other.current()).not.toBe(before);
  });

  it("a failed INCR is reported, never thrown, and this instance still moves", async () => {
    const shared = makeSharedStore();
    const reportError = vi.fn();
    const gen = createCacheGeneration({ store: shared.store, reportError });
    const reader = gen.reader(MEMO);
    const before = await reader.current();
    shared.setDown(true);

    await expect(gen.bump("platform.updateSetting")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "cache-generation", op: "bump" },
      extra: { reason: "platform.updateSetting" },
    });
    expect(await reader.current()).not.toBe(before);
  });

  it("coalesces a burst: one INCR in flight plus ONE trailing INCR that starts after it", async () => {
    let release!: () => void;
    let n = 0;
    const store: CacheGenerationStore = {
      read: vi.fn(async () => String(n)),
      bump: vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              release = () => r(String(++n));
            }),
        )
        .mockImplementation(async () => String(++n)),
    };
    const gen = createCacheGeneration({ store });

    const first = gen.bump("search.index-write");
    await vi.waitFor(() => expect(store.bump).toHaveBeenCalledTimes(1));
    // A reindex batch loop: many writes while the first INCR is in flight.
    const burst = Promise.all(
      Array.from({ length: 50 }, () => gen.bump("search.index-write")),
    );
    expect(store.bump).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, burst]);
    expect(store.bump).toHaveBeenCalledTimes(2);
  });

  it("a store read in flight when an INCR lands does not overwrite the memo", async () => {
    let releaseRead!: (v: string) => void;
    const store: CacheGenerationStore = {
      read: vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => new Promise((r) => (releaseRead = r)))
        .mockResolvedValue("2"),
      bump: vi.fn(async () => "2"),
    };
    const gen = createCacheGeneration({ store });
    const reader = gen.reader(MEMO);

    const stale = reader.current();
    await vi.waitFor(() => expect(store.read).toHaveBeenCalledTimes(1));
    await gen.bump("x");
    releaseRead("1");
    await stale;

    expect(await reader.current()).toBe("2#1");
  });
});

describe("createCacheGeneration — after a store outage", () => {
  it("the first successful read after ANY store failure advances the epoch, so pre-outage tags never match again", async () => {
    const shared = makeSharedStore();
    const clock = makeClock();
    const reader = createCacheGeneration({
      store: shared.store,
      now: clock.now,
    }).reader(MEMO);
    const beforeOutage = await reader.current();

    shared.setDown(true);
    clock.advance(MEMO);
    expect(await reader.current()).toBeNull();

    // Redis is back with the SAME counter (another instance's INCR failed).
    shared.setDown(false);
    clock.advance(MEMO);
    const afterOutage = await reader.current();
    expect(afterOutage).not.toBeNull();
    expect(afterOutage).not.toBe(beforeOutage);
    // Only once: the next read after that is stable again.
    clock.advance(MEMO);
    expect(await reader.current()).toBe(afterOutage);
  });

  it("a failed INCR is owed and re-sent with the next successful store read (no timer)", async () => {
    const shared = makeSharedStore(500);
    const clock = makeClock();
    const writer = createCacheGeneration({ store: shared.store, now: clock.now });
    const writerReader = writer.reader(MEMO);
    await writerReader.current();

    shared.setDown(true);
    await writer.bump("places.upsert");
    expect(shared.counter()).toBe(500); // INCR failed

    shared.setDown(false);
    clock.advance(MEMO);
    await writerReader.current(); // first successful read → owed INCR
    await vi.waitFor(() => expect(shared.counter()).toBe(501));
    expect(shared.store.bump).toHaveBeenCalledTimes(2);
  });

  it("a successful later bump settles the owed one (no duplicate INCR)", async () => {
    const shared = makeSharedStore(500);
    const clock = makeClock();
    const gen = createCacheGeneration({ store: shared.store, now: clock.now });
    const reader = gen.reader(MEMO);
    shared.setDown(true);
    await gen.bump("a");
    shared.setDown(false);
    await gen.bump("b");
    expect(shared.counter()).toBe(501);

    clock.advance(MEMO);
    await reader.current();
    await Promise.resolve();
    expect(shared.store.bump).toHaveBeenCalledTimes(2);
  });

  it("a throwing logger does not break a store-failure report", async () => {
    const shared = makeSharedStore();
    const reportError = vi.fn();
    const gen = createCacheGeneration({
      store: shared.store,
      reportError,
      logger: {
        warn: () => {
          throw new Error("logger down");
        },
      } as never,
    });
    shared.setDown(true);
    await expect(gen.reader(MEMO).current()).resolves.toBeNull();
    await expect(gen.bump("x")).resolves.toBeUndefined();
  });
});

describe("createRedisCacheGenerationStore", () => {
  it("reads and bumps with one EVAL each, seeding a missing key with a random base (ABA)", async () => {
    const redis = { eval: vi.fn(async () => 7) };
    const store = createRedisCacheGenerationStore(redis, "cache:gen");

    await expect(store.read()).resolves.toBe("7");
    await expect(store.bump()).resolves.toBe("7");

    for (const call of redis.eval.mock.calls) {
      const [script, numKeys, key, base] = call as unknown as [
        string,
        number,
        string,
        number,
      ];
      expect(numKeys).toBe(1);
      expect(key).toBe("cache:gen");
      expect(script).toMatch(/redis\.call\('SET', KEYS\[1\], ARGV\[1\]\)/);
      expect(Number.isInteger(base) && base > 0).toBe(true);
    }
    expect(redis.eval.mock.calls[1]![0]).toMatch(/INCR/);
  });
});

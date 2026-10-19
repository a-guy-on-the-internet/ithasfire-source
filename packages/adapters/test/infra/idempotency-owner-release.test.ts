import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

import { PrismaIdempotencyAdapter } from "../../src/idempotency/prisma-adapter";
import { RedisIdempotency } from "../../src/idempotency/redis-adapter";

// Owner-checked release (refund-mutex double-pay fix): both adapters must
// free a claim ONLY for the holder that begin()'d it. These are unit tests
// against mocked drivers — there are no integration tests for the
// idempotency adapters (the DB-backed suites silently skip without PrismaPg),
// so the call shapes and result mapping are pinned here.

const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("PrismaIdempotencyAdapter owner-checked release", () => {
  function makeDb() {
    const queryRaw = vi.fn(async () => [{ key: "x" }]);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      $queryRaw: queryRaw,
      idempotency: { deleteMany },
    } as unknown as PrismaClient;
    return { db, queryRaw, deleteMany };
  }

  it("begin threads the owner token into the claim row (errorText slot, both INSERT and re-acquire arms)", async () => {
    const { db, queryRaw } = makeDb();
    const adapter = new PrismaIdempotencyAdapter(db, "testns");

    await expect(adapter.begin("refund-op:o1", 600, TOKEN)).resolves.toBe(true);

    // $queryRaw is a tagged template: mock receives (strings, ...values).
    // The token must appear in BOTH the INSERT values and the ON CONFLICT
    // UPDATE SET — a re-acquire after TTL lapse must overwrite the stale
    // holder's token or release() could still match it.
    const [, ...values] = queryRaw.mock.calls[0]! as unknown[];
    expect(values.filter((v) => v === TOKEN)).toHaveLength(2);
    expect(values).toContain("testns:refund-op:o1");
  });

  it("begin without a token stores NULL (plain dedupe callers unchanged)", async () => {
    const { db, queryRaw } = makeDb();
    const adapter = new PrismaIdempotencyAdapter(db, "testns");

    await adapter.begin("stripe_evt:e1", 120);

    const [, ...values] = queryRaw.mock.calls[0]! as unknown[];
    expect(values.filter((v) => v === null)).toHaveLength(2);
  });

  it("release is a single conditional DELETE on key + in_progress status + token", async () => {
    const { db, deleteMany } = makeDb();
    const adapter = new PrismaIdempotencyAdapter(db, "testns");

    await expect(adapter.release("refund-op:o1", TOKEN)).resolves.toBe(true);

    // The WHERE is the whole safety property: dropping `errorText` makes it
    // an unconditional release (the pre-token bug); dropping `status` lets it
    // delete committed dedupe records.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        key: "testns:refund-op:o1",
        status: "in_progress",
        errorText: TOKEN,
      },
    });
  });

  it("release returns false when nothing matched (stale token / re-acquired claim), touching nothing else", async () => {
    const { db, deleteMany } = makeDb();
    deleteMany.mockResolvedValueOnce({ count: 0 });
    const adapter = new PrismaIdempotencyAdapter(db, "testns");

    await expect(adapter.release("refund-op:o1", "stale-token")).resolves.toBe(
      false,
    );
    // No fallback write path: a failed compare must not upsert/overwrite.
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("RedisIdempotency owner-checked release", () => {
  /**
   * Stateful fake redis whose `eval` EXECUTES the adapter's compare-and-del
   * script semantics (GET == ARGV[1] → DEL, else 0) against the same store as
   * `set`/`get` — so these tests pin the adapter's end-to-end behaviour, with
   * the script string itself asserted verbatim below.
   */
  function makeRedis() {
    const store = new Map<string, string>();
    const set = vi.fn(
      async (
        key: string,
        value: string,
        _ex: string,
        _ttl: number,
        nx?: string,
      ) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    );
    const evalMock = vi.fn(
      async (script: string, _numKeys: number, key: string, arg: string) => {
        expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
        if (store.get(key) === arg) {
          store.delete(key);
          return 1;
        }
        return 0;
      },
    );
    const redis = {
      set,
      eval: evalMock,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    } as unknown as Redis;
    return { redis, store, set, evalMock };
  }

  it("begin stores in_progress:${token} under NX+EX; tokenless begin keeps the legacy value", async () => {
    const { redis, set } = makeRedis();
    const adapter = new RedisIdempotency(redis, "testns");

    await expect(adapter.begin("refund-op:o1", 600, TOKEN)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      "idem:testns:refund-op:o1",
      `in_progress:${TOKEN}`,
      "EX",
      600,
      "NX",
    );

    await adapter.begin("stripe_evt:e1", 120);
    expect(set).toHaveBeenCalledWith(
      "idem:testns:stripe_evt:e1",
      "in_progress",
      "EX",
      120,
      "NX",
    );
  });

  it("release frees the holder's own claim (atomic Lua) and reports true", async () => {
    const { redis, store } = makeRedis();
    const adapter = new RedisIdempotency(redis, "testns");

    await adapter.begin("refund-op:o1", 600, TOKEN);
    await expect(adapter.release("refund-op:o1", TOKEN)).resolves.toBe(true);
    expect(store.has("idem:testns:refund-op:o1")).toBe(false);

    // Key freed → immediately re-acquirable (NX succeeds again).
    await expect(
      adapter.begin("refund-op:o1", 600, "next-holder"),
    ).resolves.toBe(true);
  });

  it("a stale holder's release must NOT delete the new holder's live claim", async () => {
    const { redis, store } = makeRedis();
    const adapter = new RedisIdempotency(redis, "testns");

    // New holder B owns the key (A's claim expired and was re-acquired —
    // simulated by B's value simply being present under B's token).
    store.set("idem:testns:refund-op:o1", "in_progress:token-b");

    // Stale holder A releases with its old token: compare fails, no delete.
    await expect(adapter.release("refund-op:o1", "token-a")).resolves.toBe(
      false,
    );
    expect(store.get("idem:testns:refund-op:o1")).toBe("in_progress:token-b");
  });

  it("release never matches committed/failed values", async () => {
    const { redis, store } = makeRedis();
    const adapter = new RedisIdempotency(redis, "testns");

    store.set("idem:testns:order:refund-full:o1", "succeeded");
    await expect(adapter.release("order:refund-full:o1", TOKEN)).resolves.toBe(
      false,
    );
    expect(store.get("idem:testns:order:refund-full:o1")).toBe("succeeded");
  });

  it("get() is blind to the token suffix (only the exact 'succeeded' value replays)", async () => {
    const { redis } = makeRedis();
    const adapter = new RedisIdempotency(redis, "testns");

    await adapter.begin("refund-op:o1", 600, TOKEN);
    // A token-suffixed in_progress value must read as "no cached result",
    // exactly like the legacy bare "in_progress".
    await expect(adapter.get("refund-op:o1")).resolves.toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import type { RerunJobRunOutcome } from "@th/ports/job-diagnostics";
import {
  PURGE_DLQ_LUA,
  RELEASE_RERUN_CLAIM_LUA,
  RedisJobDiagnosticsAdapter,
  SWAP_DLQ_MEMBER_LUA,
  type RerunJobFromDlq,
} from "../redis-dlq-adapter";
import { redisKeyHash } from "../../redis/exec-or-throw";

const KEY_HASH = redisKeyHash("th:jobs:dlq:demo.job");

// ioredis's exec() resolves instead of rejecting on failure: per-command
// errors arrive as `[err, result]` tuples and an aborted MULTI resolves null.
// pushToDLQ must turn both into a rejection, or a failed job's DLQ entry
// vanishes while the jobs service thinks it was stored.
function fakeRedisWithExec(exec: () => Promise<unknown>) {
  const multi = {
    zadd: vi.fn().mockReturnThis(),
    zremrangebyrank: vi.fn().mockReturnThis(),
    exec: vi.fn(exec),
  };
  return { redis: { multi: vi.fn(() => multi) } as any, multi };
}

const item = {
  ref: { queue: "demo.job", id: "run-1" },
  failedAt: "2026-10-07T12:00:00.000Z",
  payload: { secret: "s3cr3t" },
  attempt: 1,
  error: { message: "boom" },
};

function adapter(redis: any) {
  return new RedisJobDiagnosticsAdapter({
    redis,
    maxPerQueue: 10,
    rerunJob: vi.fn(async () => ({ outcome: "ran" as const, runId: "new-id" })),
  });
}

const KEY = "th:jobs:dlq:demo.job";
const CLAIM_KEY = "th:jobs:dlq-rerun-claim:demo.job:run-1";
const CLAIM_KEY_HASH = redisKeyHash(CLAIM_KEY);

type Reply = [Error | null, unknown];

/**
 * In-memory sorted sets and string keys behind the ioredis calls this adapter
 * makes.
 *
 * `multi()` and `pipeline()` queue commands and apply them on exec, replying
 * `[null, result]` per command like ioredis; a command queued with a callback
 * gets its own reply through it, as an ioredis pipeline does. `eval` accepts
 * only the adapter's three scripts and does in JS what each does, so it shows
 * how the adapter USES a script, not that the Lua is right (that is checked
 * against a real Redis, outside this suite).
 *
 * There is no bare `redis.zrange(...)`/`zrem(...)`/`del(...)` here on purpose:
 * an adapter call that skipped the sanitising pipeline would fail as "not a
 * function".
 *
 * Two seams:
 *  - `exec(apply, commands)` replaces exec for one batch: it decides what exec
 *    resolves and whether the queued commands are applied first;
 *  - `hooks.afterScan` runs after each `zrange` batch has been applied and
 *    before its exec resolves, i.e. between an adapter's scan and its write.
 */
function memoryRedis(
  options: {
    exec?: (apply: () => Reply[], commands: string[]) => Promise<unknown>;
  } = {},
) {
  const sortedSets = new Map<string, Map<string, number>>();
  const setOf = (key: string) => {
    let set = sortedSets.get(key);
    if (!set) {
      set = new Map();
      sortedSets.set(key, set);
    }
    return set;
  };
  const ascending = (key: string) =>
    [...setOf(key).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
  const range = (list: string[], start: number, stop: number) =>
    list.slice(start, stop === -1 ? undefined : stop + 1);

  const zadd = (key: string, score: number, member: string) => {
    const added = setOf(key).has(member) ? 0 : 1;
    setOf(key).set(member, score);
    return added;
  };
  const zrem = (key: string, member: string) =>
    setOf(key).delete(member) ? 1 : 0;

  const hooks: { afterScan?: () => Promise<void> | void } = {};
  const batches: Array<{ kind: "multi" | "pipeline"; commands: string[] }> = [];
  /** `SWAP_DLQ_MEMBER_LUA` calls only. */
  const evals: Array<{ script: string; numKeys: number; args: unknown[]; reply: number }> = [];
  /** String keys: the rerun claims. */
  const strings = new Map<string, string>();
  /** Every `SET` as the adapter sent it, whether or not it took the key. */
  const sets: Array<{ key: string; value: string; options: unknown[]; reply: "OK" | null }> = [];
  /** Every `RELEASE_RERUN_CLAIM_LUA` call. */
  const releases: Array<{ numKeys: number; key: string; token: string; reply: number }> = [];

  const batch = (kind: "multi" | "pipeline") => () => {
    const queued: Array<() => unknown> = [];
    const record = { kind, commands: [] as string[] };
    batches.push(record);
    const queue = (
      name: string,
      run: () => unknown,
      callback?: (err: Error | null, reply?: any) => void,
    ) => {
      record.commands.push(name);
      queued.push(() => {
        const reply = run();
        callback?.(null, reply);
        return reply;
      });
      return chain;
    };
    const chain = {
      zadd: (key: string, score: number, member: string) =>
        queue("zadd", () => zadd(key, score, member)),
      zrem: (
        key: string,
        member: string,
        callback?: (err: Error | null, reply?: number) => void,
      ) => queue("zrem", () => zrem(key, member), callback),
      zremrangebyrank: (key: string, start: number, stop: number) =>
        queue("zremrangebyrank", () => {
          const doomed = ascending(key).slice(
            start,
            stop < 0 ? ascending(key).length + stop + 1 : stop + 1,
          );
          for (const member of doomed) setOf(key).delete(member);
          return doomed.length;
        }),
      zrange: (
        key: string,
        start: number,
        stop: number,
        callback?: (err: Error | null, reply?: string[]) => void,
      ) => queue("zrange", () => range(ascending(key), start, stop), callback),
      zrevrange: (
        key: string,
        start: number,
        stop: number,
        callback?: (err: Error | null, reply?: string[]) => void,
      ) => queue("zrevrange", () => range(ascending(key).reverse(), start, stop), callback),
      // SET key value EX seconds NX
      set: (key: string, value: string, ...rest: unknown[]) => {
        const callback = rest.pop() as (err: Error | null, reply?: "OK" | null) => void;
        return queue(
          "set",
          () => {
            const taken = strings.has(key);
            if (!taken) strings.set(key, value);
            const reply = taken ? null : ("OK" as const);
            sets.push({ key, value, options: rest, reply });
            return reply;
          },
          callback,
        );
      },
      get: (key: string, callback?: (err: Error | null, reply?: string | null) => void) =>
        queue("get", () => strings.get(key) ?? null, callback),
      eval: (script: string, numKeys: number, key: string, ...rest: unknown[]) => {
        const callback = rest.pop() as (err: Error | null, reply?: unknown) => void;
        return queue(
          "eval",
          () => {
            if (script === RELEASE_RERUN_CLAIM_LUA) {
              // Delete the key only while it still holds this token.
              const [token] = rest as [string];
              const reply = strings.get(key) === token && strings.delete(key) ? 1 : 0;
              releases.push({ numKeys, key, token, reply });
              return reply;
            }
            if (script === PURGE_DLQ_LUA) {
              // Count, delete, return the count.
              const count = setOf(key).size;
              sortedSets.delete(key);
              return count;
            }
            if (script !== SWAP_DLQ_MEMBER_LUA) throw new Error("unknown script");
            // SWAP_DLQ_MEMBER_LUA: check the old member, add the new one,
            // remove the old one.
            const [oldMember, score, newMember] = rest as [string, number, string];
            let reply = 0;
            if (setOf(key).has(oldMember)) {
              zadd(key, Number(score), newMember);
              if (oldMember !== newMember) zrem(key, oldMember);
              reply = 1;
            }
            evals.push({ script, numKeys, args: [key, oldMember, score, newMember], reply });
            return reply;
          },
          callback,
        );
      },
      async exec() {
        const apply = () => queued.map((run) => [null, run()] as Reply);
        if (options.exec) return options.exec(apply, record.commands);
        const replies = apply();
        if (record.commands.includes("zrange")) await hooks.afterScan?.();
        return replies;
      },
    };
    return chain;
  };

  const redis = {
    multi: vi.fn(batch("multi")),
    pipeline: vi.fn(batch("pipeline")),
  };

  return {
    redis: redis as any,
    hooks,
    batches,
    evals,
    sets,
    releases,
    /** The string keys (rerun claims) as they stand. */
    claims: () => Object.fromEntries(strings),
    /** Write a claim straight in, as another process would. */
    putClaim: (key: string, token: string) => strings.set(key, token),
    dropClaim: (key: string) => strings.delete(key),
    /** Stored members, oldest first, exactly as stored. */
    members: () => ascending(KEY),
    /** Stored entries, oldest first, parsed. */
    entries: () => ascending(KEY).map((raw) => JSON.parse(raw)),
    score: (id: string) => {
      for (const [raw, score] of setOf(KEY)) {
        if (JSON.parse(raw).ref.id === id) return score;
      }
      return undefined;
    },
    /** Write straight into the set, as another process would. */
    put: (entry: unknown, score = 0) => zadd(KEY, score, JSON.stringify(entry)),
    /** Store a member verbatim, valid JSON or not. */
    putRaw: (member: string, score = 0) => zadd(KEY, score, member),
    remove: (raw: string) => zrem(KEY, raw),
  };
}

function adapterWithRerun(
  redis: any,
  rerunJob: RerunJobFromDlq,
  extra: { reportError?: (...args: any[]) => void; logger?: { error: (...args: any[]) => void } } = {},
) {
  return new RedisJobDiagnosticsAdapter({ redis, maxPerQueue: 10, rerunJob, ...extra });
}

const neverRerun: RerunJobFromDlq = async () => {
  throw new Error("rerunJob must not be called");
};

/** An ioredis-shaped error: the client attaches the command arguments. */
function redisErrorWithArgs(message: string) {
  return Object.assign(new Error(message), {
    command: { name: "eval", args: [SWAP_DLQ_MEMBER_LUA, 1, KEY, JSON.stringify(item)] },
    previousErrors: [new Error(`ERR ${JSON.stringify(item)}`)],
  });
}

describe("RedisJobDiagnosticsAdapter.pushToDLQ (exec failures reject)", () => {
  it("resolves when both queued commands succeeded", async () => {
    const { redis, multi } = fakeRedisWithExec(async () => [
      [null, 1],
      [null, 0],
    ]);

    await expect(adapter(redis).pushToDLQ(item)).resolves.toBeUndefined();
    expect(multi.zadd).toHaveBeenCalledWith(
      "th:jobs:dlq:demo.job",
      Date.parse(item.failedAt),
      JSON.stringify(item),
    );
    expect(multi.zremrangebyrank).toHaveBeenCalledWith("th:jobs:dlq:demo.job", 0, -11);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("rejects when exec resolves null (transaction aborted)", async () => {
    const { redis } = fakeRedisWithExec(async () => null);

    await expect(adapter(redis).pushToDLQ(item)).rejects.toThrow(
      `redis dlq push aborted (keyHash=${KEY_HASH})`,
    );
  });

  it("rejects when a queued command carries an error, naming op and key hash but not the value", async () => {
    const cmdErr = Object.assign(new Error("WRONGTYPE Operation against a key"), {
      command: { name: "zadd", args: ["th:jobs:dlq:demo.job", 1, JSON.stringify(item)] },
    });
    const { redis } = fakeRedisWithExec(async () => [
      [cmdErr, null],
      [null, 0],
    ]);

    const err = await adapter(redis)
      .pushToDLQ(item)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(
      `redis dlq push failed at command 0 [WRONGTYPE] (keyHash=${KEY_HASH})`,
    );
    expect(JSON.stringify(err) + err!.message).not.toContain("s3cr3t");
    expect(err!.cause).toBeUndefined();
  });
});

describe("RedisJobDiagnosticsAdapter.rerunFromDLQ (the entry goes only on a confirmed run)", () => {
  async function seeded(
    result: RerunJobRunOutcome | Error,
    extra: Parameters<typeof adapterWithRerun>[2] = {},
    store = memoryRedis(),
  ) {
    const rerunJob = vi.fn<RerunJobFromDlq>(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const dlq = adapterWithRerun(store.redis, rerunJob, extra);
    await dlq.pushToDLQ(item);
    return { store, dlq, rerunJob };
  }

  it("ran: deletes the entry and says so", async () => {
    const { store, dlq, rerunJob } = await seeded({ outcome: "ran", runId: "run-2" });

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(store.entries()).toEqual([]);
    expect(rerunJob).toHaveBeenCalledWith("demo.job", item.payload, {
      dlqItemId: "run-1",
      claimToken: expect.any(String),
    });
  });

  it.each([["disabled"], ["coalesced"], ["unconfirmed"]] as const)(
    "not_run (%s): keeps the entry untouched",
    async (reason) => {
      const { store, dlq } = await seeded({ outcome: "not_run", reason });

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "not_run",
        reason,
      });
      expect(store.entries()).toEqual([item]);
    },
  );

  it("failed: does not delete the entry", async () => {
    const failed: RerunJobRunOutcome = {
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error", code: "internal_error" },
    };
    const { store, dlq } = await seeded(failed);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual(failed);
    expect(store.entries()).toEqual([item]);
  });

  it("a throwing rerunJob rejects and leaves the entry untouched", async () => {
    const { store, dlq } = await seeded(new Error("fetch failed"));

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).rejects.toThrow(
      "fetch failed",
    );
    expect(store.entries()).toEqual([item]);
  });

  it("sends the override payload when one is given", async () => {
    const { dlq, rerunJob } = await seeded({ outcome: "not_run", reason: "disabled" });

    await dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1", payloadOverride: { fixed: true } });
    expect(rerunJob).toHaveBeenCalledWith(
      "demo.job",
      { fixed: true },
      { dlqItemId: "run-1", claimToken: expect.any(String) },
    );
  });

  it("an unknown entry rejects not_found without calling rerunJob", async () => {
    const { dlq, rerunJob } = await seeded({ outcome: "ran", runId: "run-2" });

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "nope" })).rejects.toMatchObject({
      name: "JobDiagnosticsError",
      code: "not_found",
    });
    expect(rerunJob).not.toHaveBeenCalled();
  });

  it("ran: deletes the entry even when it was rewritten while the job ran", async () => {
    const store = memoryRedis();
    const dlq: RedisJobDiagnosticsAdapter = adapterWithRerun(store.redis, async () => {
      // Another rerun of the same entry failed in the meantime.
      await dlq.recordRerunFailure({
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-other",
        failedAt: "2026-10-08T09:30:00.000Z",
        error: { message: "boom again" },
      });
      return { outcome: "ran", runId: "run-2" };
    });
    await dlq.pushToDLQ(item);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(store.entries()).toEqual([]);
  });

  it("ran, entry already gone: nothing to delete, nothing reported", async () => {
    const reportError = vi.fn();
    const store = memoryRedis();
    const dlq = adapterWithRerun(
      store.redis,
      async () => {
        store.remove(store.members()[0]!);
        return { outcome: "ran", runId: "run-2" };
      },
      { reportError },
    );
    await dlq.pushToDLQ(item);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  describe("the entry is rewritten between the delete's scan and its ZREM", () => {
    /** Another rerun of the same entry fails: its swap replaces the member. */
    const rewrite = (store: ReturnType<typeof memoryRedis>, n: number) => {
      for (const raw of store.members()) store.remove(raw);
      store.put({ ...item, attempt: 1 + n, error: { message: `rewrite ${n}` } }, n);
    };

    it("removes the rewritten member on the next round and answers entryDeleted true", async () => {
      const reportError = vi.fn();
      const store = memoryRedis();
      const dlq = adapterWithRerun(
        store.redis,
        async () => {
          // From here on, i.e. for the delete's first scan only.
          let done = false;
          store.hooks.afterScan = () => {
            if (done) return;
            done = true;
            rewrite(store, 1);
          };
          return { outcome: "ran", runId: "run-2" };
        },
        { reportError },
      );
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: true,
      });
      // Not "true" with the rewritten entry still listed.
      expect(store.members()).toEqual([]);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("rewritten on every round: still `ran`, entryDeleted false, reported once as contended", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const store = memoryRedis();
      const dlq = adapterWithRerun(
        store.redis,
        async () => {
          let n = 0;
          store.hooks.afterScan = () => rewrite(store, ++n);
          return { outcome: "ran", runId: "run-2" };
        },
        { reportError, logger },
      );
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: false,
      });
      // The entry really is still there, as last rewritten: three rounds, then
      // the last look that found it again.
      expect(store.entries()).toEqual([
        { ...item, attempt: 5, error: { message: "rewrite 4" } },
      ]);

      const message = `redis dlq rerun delete contended after 3 attempts (keyHash=${KEY_HASH})`;
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(reportError.mock.calls[0]![0].message).toBe(message);
      expect(reportError.mock.calls[0]![1]).toEqual({
        tags: { area: "job-dlq", phase: "rerun-delete" },
        extra: { queue: "demo.job", jobId: "run-1", runId: "run-2" },
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("dlq_rerun_delete_failed", {
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-2",
        error: { name: "Error", message },
      });
    });
  });

  it("ran: a member that is not valid JSON is skipped, and the entry is still deleted", async () => {
    const reportError = vi.fn();
    const store = memoryRedis();
    const dlq = adapterWithRerun(
      store.redis,
      async () => {
        // Sorts before the entry, so the delete's scan meets it first.
        store.putRaw('s3cr3t-token{"not json', 0);
        return { outcome: "ran", runId: "run-2" };
      },
      { reportError },
    );
    await dlq.pushToDLQ(item);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(store.members()).toEqual(['s3cr3t-token{"not json']);
    // The skip is reported (count only); the delete itself is not a failure.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "job-dlq", phase: "unreadable-member" },
      extra: { op: "dlq rerun delete", keyHash: KEY_HASH, count: 1 },
    });
  });

  describe("the job ran but the entry could not be deleted", () => {
    /** Every batch works except the delete's zrem, which fails like ioredis. */
    function deleteFails() {
      const zremErr = Object.assign(new Error("OOM command not allowed"), {
        command: { name: "zrem", args: [KEY, JSON.stringify(item)] },
      });
      return memoryRedis({
        exec: async (apply, commands) =>
          commands.length === 1 && commands[0] === "zrem" ? [[zremErr, null]] : apply(),
      });
    }

    it("still answers `ran`, with entryDeleted false, and logs and reports it", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const { store, dlq } = await seeded(
        { outcome: "ran", runId: "run-2" },
        { reportError, logger },
        deleteFails(),
      );

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: false,
      });
      expect(store.entries()).toEqual([item]);

      const message = `redis dlq rerun delete failed at command 0 [OOM] (keyHash=${KEY_HASH})`;
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = reportError.mock.calls[0]!;
      expect(reported).toBeInstanceOf(Error);
      expect(reported.message).toBe(message);
      expect(context).toEqual({
        tags: { area: "job-dlq", phase: "rerun-delete" },
        extra: { queue: "demo.job", jobId: "run-1", runId: "run-2" },
      });
      expect(logger.error).toHaveBeenCalledWith("dlq_rerun_delete_failed", {
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-2",
        error: { name: "Error", message },
      });
      // Neither the report nor the log line carries the stored payload.
      const everything = JSON.stringify(
        [reportError.mock.calls, logger.error.mock.calls],
        (_k, v) => (v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v),
      );
      expect(everything).not.toContain("s3cr3t");
    });

    it("a throwing reporter does not change the answer", async () => {
      const { dlq } = await seeded(
        { outcome: "ran", runId: "run-2" },
        {
          reportError: () => {
            throw new Error("reporter down");
          },
        },
        deleteFails(),
      );

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: false,
      });
    });

    it("answers the same with no reporter and no logger wired", async () => {
      const { dlq } = await seeded({ outcome: "ran", runId: "run-2" }, {}, deleteFails());

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: false,
      });
    });
  });
});

describe("SWAP_DLQ_MEMBER_LUA", () => {
  it("checks the old member, adds the new one, then removes the old one", () => {
    const check = SWAP_DLQ_MEMBER_LUA.indexOf('redis.call("ZSCORE", KEYS[1], ARGV[1])');
    const add = SWAP_DLQ_MEMBER_LUA.indexOf('redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])');
    const remove = SWAP_DLQ_MEMBER_LUA.indexOf('redis.call("ZREM", KEYS[1], ARGV[1])');

    expect(check).toBeGreaterThan(-1);
    // Add before remove: a failure part-way never leaves the set without the entry.
    expect(add).toBeGreaterThan(check);
    expect(remove).toBeGreaterThan(add);
    // Returns 0 before writing anything when the old member is gone.
    expect(SWAP_DLQ_MEMBER_LUA.indexOf("return 0")).toBeGreaterThan(check);
    expect(SWAP_DLQ_MEMBER_LUA.indexOf("return 0")).toBeLessThan(add);
  });

  it("never decodes a member and touches no key but KEYS[1]", () => {
    expect(SWAP_DLQ_MEMBER_LUA).not.toMatch(/cjson|cmsgpack/);
    const calls = SWAP_DLQ_MEMBER_LUA.match(/redis\.call\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toContain("KEYS[1]");
  });
});

describe("RedisJobDiagnosticsAdapter.recordRerunFailure (one entry, rewritten in place)", () => {
  const SECOND_FAILURE = "2026-10-08T09:30:00.000Z";
  const THIRD_FAILURE = "2026-10-09T18:45:00.000Z";

  const secondFailure = (runId = "run-2") => ({
    queue: "demo.job",
    jobId: "run-1",
    runId,
    failedAt: SECOND_FAILURE,
    error: { message: "boom again" },
  });

  it("rewrites the entry: same id and payload, new time, error and attempt", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    await dlq.pushToDLQ(item);
    const [stored] = store.members();

    await expect(
      dlq.recordRerunFailure({
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-2",
        failedAt: SECOND_FAILURE,
        error: { message: "boom again", code: "E_AGAIN" },
      }),
    ).resolves.toBe(true);

    const rewritten = {
      ref: { queue: "demo.job", id: "run-1" },
      failedAt: SECOND_FAILURE,
      payload: { secret: "s3cr3t" },
      attempt: 2,
      error: { message: "boom again", code: "E_AGAIN" },
      metadata: { firstFailedAt: item.failedAt, lastRunId: "run-2" },
    };
    expect(store.entries()).toEqual([rewritten]);
    expect(store.score("run-1")).toBe(Date.parse(SECOND_FAILURE));
    // One compare-and-swap: the key as KEYS[1], then the member exactly as it
    // was stored, the new score and the new member.
    expect(store.evals).toEqual([
      {
        script: SWAP_DLQ_MEMBER_LUA,
        numKeys: 1,
        args: [KEY, stored, Date.parse(SECOND_FAILURE), JSON.stringify(rewritten)],
        reply: 1,
      },
    ]);
  });

  it("a second failed rerun counts up and keeps the first failure time", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    await dlq.pushToDLQ(item);

    await dlq.recordRerunFailure(secondFailure());
    await expect(
      dlq.recordRerunFailure({
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-3",
        failedAt: THIRD_FAILURE,
        error: { message: "third time" },
      }),
    ).resolves.toBe(true);

    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ref: { queue: "demo.job", id: "run-1" },
      failedAt: THIRD_FAILURE,
      payload: { secret: "s3cr3t" },
      attempt: 3,
      error: { message: "third time" },
      metadata: { firstFailedAt: item.failedAt, lastRunId: "run-3" },
    });
    // Still reachable by the id the console holds.
    await expect(dlq.getFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toMatchObject({
      attempt: 3,
    });
  });

  it("an entry stored without an attempt counts as the first", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    const { attempt: _attempt, ...withoutAttempt } = item;
    await dlq.pushToDLQ(withoutAttempt);

    await dlq.recordRerunFailure(secondFailure());
    expect(store.entries()[0].attempt).toBe(2);
  });

  it("leaves the other entries of the queue alone", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    const other = { ...item, ref: { queue: "demo.job", id: "run-0" } };
    await dlq.pushToDLQ(other);
    await dlq.pushToDLQ({ ...item, failedAt: "2026-10-07T13:00:00.000Z" });

    await dlq.recordRerunFailure(secondFailure());

    const entries = store.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(other);
    expect(entries[1].ref.id).toBe("run-1");
  });

  it.each([
    ["not valid JSON", 's3cr3t-token{"not json'],
    ["JSON null", "null"],
    ["an object with no ref", '{"payload":"s3cr3t"}'],
  ])("skips a stored member that is %s and still rewrites the entry", async (_label, corrupt) => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    // Sorts before the entry, so the scan meets it first.
    store.putRaw(corrupt, 0);
    await dlq.pushToDLQ(item);

    await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(true);

    const members = store.members();
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(corrupt);
    expect(JSON.parse(members[1]!)).toMatchObject({ ref: { id: "run-1" }, attempt: 2 });
  });

  describe("an unreadable member is skipped, logged and reported, never quoted", () => {
    const CORRUPT = 's3cr3t-token{"not json';
    const asText = (calls: unknown) =>
      JSON.stringify(calls, (_k, v) =>
        v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v,
      );

    async function withCorruptMember(reportError: (...args: any[]) => void) {
      const logger = { error: vi.fn() };
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, { reportError, logger });
      // Sorts before the entry, so the scan meets it first.
      store.putRaw(CORRUPT, 0);
      await dlq.pushToDLQ(item);
      return { store, dlq, logger };
    }

    it("the readable entry is still found; one log and one report carry the count only", async () => {
      const reportError = vi.fn();
      const { store, dlq, logger } = await withCorruptMember(reportError);

      await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(true);
      expect(JSON.parse(store.members()[1]!)).toMatchObject({ ref: { id: "run-1" }, attempt: 2 });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("dlq_unreadable_members", {
        op: "dlq rerun record",
        keyHash: KEY_HASH,
        count: 1,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = reportError.mock.calls[0]!;
      expect(reported).toBeInstanceOf(Error);
      expect(reported.message).toBe(
        `redis dlq rerun record skipped unreadable members (keyHash=${KEY_HASH})`,
      );
      expect(context).toEqual({
        tags: { area: "job-dlq", phase: "unreadable-member" },
        extra: { op: "dlq rerun record", keyHash: KEY_HASH, count: 1 },
      });

      // Neither the member's text nor the parse error that quotes it.
      const everything = asText([reportError.mock.calls, logger.error.mock.calls]);
      expect(everything).not.toContain("s3cr3t");
      expect(everything).not.toContain("not json");
      expect(everything).not.toMatch(/SyntaxError|Unexpected token|is not valid JSON/);
    });

    it("counts every unreadable member of the scan in one report", async () => {
      const reportError = vi.fn();
      const { store, dlq } = await withCorruptMember(reportError);
      store.putRaw("null", 1);
      store.putRaw('{"payload":"s3cr3t"}', Date.parse("2027-01-01T00:00:00.000Z"));

      await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(true);

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1].extra).toEqual({
        op: "dlq rerun record",
        keyHash: KEY_HASH,
        count: 3,
      });
      expect(asText(reportError.mock.calls)).not.toContain("s3cr3t");
    });

    it("a throwing reporter changes nothing", async () => {
      const { store, dlq } = await withCorruptMember(() => {
        throw new Error("reporter down");
      });

      await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(true);
      expect(JSON.parse(store.members()[1]!)).toMatchObject({ ref: { id: "run-1" }, attempt: 2 });
    });

    it("no unreadable member: no log and no report", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, { reportError, logger });
      await dlq.pushToDLQ(item);

      await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(true);
      expect(reportError).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  it("only unreadable members in the queue: false, and no error that could quote one", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    store.putRaw('s3cr3t-token{"not json', 0);

    await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(false);
    expect(store.evals).toEqual([]);
  });

  it("returns false and writes nothing when the entry is absent", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    await dlq.pushToDLQ(item);

    await expect(
      dlq.recordRerunFailure({ ...secondFailure(), jobId: "gone" }),
    ).resolves.toBe(false);
    expect(store.entries()).toEqual([item]);
    expect(store.evals).toEqual([]);
  });

  describe("when the entry changes between the scan and the write", () => {
    it("two reruns failing together leave ONE entry, counted twice", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      // The other rerun's whole rewrite lands after this one's first scan.
      let interleaved = false;
      store.hooks.afterScan = async () => {
        if (interleaved) return;
        interleaved = true;
        await dlq.recordRerunFailure({
          queue: "demo.job",
          jobId: "run-1",
          runId: "run-other",
          failedAt: "2026-10-08T09:29:00.000Z",
          error: { message: "the other rerun" },
        });
      };

      await expect(dlq.recordRerunFailure(secondFailure("run-mine"))).resolves.toBe(true);

      const entries = store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        ref: { queue: "demo.job", id: "run-1" },
        payload: { secret: "s3cr3t" },
        attempt: 3,
        error: { message: "boom again" },
        metadata: { firstFailedAt: item.failedAt, lastRunId: "run-mine" },
      });
      // other: swapped. mine: refused on the stale member, then swapped on the fresh one.
      expect(store.evals.map((call) => call.reply)).toEqual([1, 0, 1]);
    });

    it("two calls started together also end with one entry at attempt 3", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      await expect(
        Promise.all([
          dlq.recordRerunFailure(secondFailure("run-a")),
          dlq.recordRerunFailure({ ...secondFailure("run-b"), failedAt: THIRD_FAILURE }),
        ]),
      ).resolves.toEqual([true, true]);

      const entries = store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        ref: { queue: "demo.job", id: "run-1" },
        attempt: 3,
        metadata: { firstFailedAt: item.failedAt },
      });
    });

    it("a delete in between is not undone: false, and the set stays empty", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);
      store.hooks.afterScan = () => {
        for (const raw of store.members()) store.remove(raw);
      };

      await expect(dlq.recordRerunFailure(secondFailure())).resolves.toBe(false);

      expect(store.members()).toEqual([]);
      // The one swap was refused, and the second scan found nothing to rewrite.
      expect(store.evals.map((call) => call.reply)).toEqual([0]);
    });

    it("gives up after three refused swaps, with an error that names no entry", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);
      // Something rewrites the entry after every scan.
      let churn = 0;
      store.hooks.afterScan = () => {
        for (const raw of store.members()) store.remove(raw);
        churn += 1;
        store.put({ ...item, error: { message: `churn ${churn}` } }, churn);
      };

      const err = await dlq.recordRerunFailure(secondFailure()).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe(
        `redis dlq rerun record contended after 3 attempts (keyHash=${KEY_HASH})`,
      );
      expect(JSON.stringify(err) + err!.message).not.toContain("s3cr3t");
      expect(store.evals.map((call) => call.reply)).toEqual([0, 0, 0]);
      // Nothing was written by the refused swaps.
      expect(store.entries()).toEqual([{ ...item, error: { message: "churn 3" } }]);
    });
  });

  describe("when Redis fails, the error names the op and a key hash, never a member", () => {
    it("the swap's reply carries an error", async () => {
      const store = memoryRedis({
        exec: async (apply, commands) =>
          commands.includes("eval")
            ? [[redisErrorWithArgs("OOM command not allowed"), null]]
            : apply(),
      });
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await dlq.recordRerunFailure(secondFailure()).then(
        () => null,
        (e: unknown) => e as Error & { command?: unknown; previousErrors?: unknown },
      );

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe(
        `redis dlq rerun record failed at command 0 [OOM] (keyHash=${KEY_HASH})`,
      );
      expect(err!.command).toBeUndefined();
      expect(err!.previousErrors).toBeUndefined();
      expect(err!.cause).toBeUndefined();
      expect(JSON.stringify(err) + err!.message + err!.stack).not.toContain("s3cr3t");
      expect(store.entries()).toEqual([item]);
    });

    it("the swap is rejected outright (connection lost)", async () => {
      const store = memoryRedis({
        exec: async (apply, commands) => {
          if (commands.includes("eval")) throw redisErrorWithArgs("Connection is closed.");
          return apply();
        },
      });
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await dlq.recordRerunFailure(secondFailure()).then(
        () => null,
        (e: unknown) => e as Error & { command?: unknown },
      );

      expect(err!.message).toBe(
        `redis dlq rerun record rejected [CONNECTION_CLOSED] (keyHash=${KEY_HASH})`,
      );
      expect(err!.command).toBeUndefined();
      expect(JSON.stringify(err) + err!.message + err!.stack).not.toContain("s3cr3t");
    });

    it("the scan fails", async () => {
      const store = memoryRedis({
        exec: async (apply, commands) => {
          if (commands.includes("zrange")) throw redisErrorWithArgs("Command timed out");
          return apply();
        },
      });
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await dlq.recordRerunFailure(secondFailure()).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(err!.message).toBe(
        `redis dlq rerun record rejected [TIMEOUT] (keyHash=${KEY_HASH})`,
      );
      expect(JSON.stringify(err) + err!.message + err!.stack).not.toContain("s3cr3t");
      expect(store.evals).toEqual([]);
    });
  });
});

/** Everything a reporter and a logger were given, errors spelled out. */
const spelledOut = (calls: unknown) =>
  JSON.stringify(calls, (_k, v) =>
    v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v,
  );

/** A promise and its resolver, to hold a rerun open. */
function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("RedisJobDiagnosticsAdapter.rerunFromDLQ (one rerun per entry at a time)", () => {
  const RERUN = { queue: "demo.job", jobId: "run-1" };

  it("claims the entry with SET NX EX 330 and a random token, before reading it", async () => {
    const store = memoryRedis();
    const rerunJob = vi.fn<RerunJobFromDlq>(async () => ({ outcome: "ran", runId: "run-2" }));
    const dlq = adapterWithRerun(store.redis, rerunJob);
    await dlq.pushToDLQ(item);
    store.batches.length = 0;

    await dlq.rerunFromDLQ(RERUN);

    expect(store.sets).toHaveLength(1);
    const [claim] = store.sets;
    expect(claim).toMatchObject({ key: CLAIM_KEY, options: ["EX", 330, "NX"], reply: "OK" });
    // A token and nothing else: no payload, no entry.
    expect(claim!.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(rerunJob.mock.calls[0]![2]).toEqual({ dlqItemId: "run-1", claimToken: claim!.value });
    // The claim is the first thing sent; the entry is read after it.
    expect(store.batches[0]!.commands).toEqual(["set"]);
    expect(store.batches[1]!.commands).toEqual(["zrange"]);
  });

  it("a second rerun of the same entry answers `claimed` and runs nothing", async () => {
    const store = memoryRedis();
    const running = gate<RerunJobRunOutcome>();
    const rerunJob = vi.fn<RerunJobFromDlq>(() => running.promise);
    const dlq = adapterWithRerun(store.redis, rerunJob);
    await dlq.pushToDLQ(item);

    const first = dlq.rerunFromDLQ(RERUN);
    await vi.waitFor(() => expect(rerunJob).toHaveBeenCalledTimes(1));
    store.batches.length = 0;

    await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual({
      outcome: "not_run",
      reason: "claimed",
    });
    // Refused on the claim alone: the entry was not even read.
    expect(store.batches.map((b) => b.commands)).toEqual([["set"]]);
    expect(rerunJob).toHaveBeenCalledTimes(1);
    // The refused one must not release the claim it never held.
    expect(store.releases).toEqual([]);

    running.open({ outcome: "ran", runId: "run-2" });
    await expect(first).resolves.toEqual({ outcome: "ran", runId: "run-2", entryDeleted: true });
  });

  it("five at once: one runs, four answer `claimed`", async () => {
    const store = memoryRedis();
    const rerunJob = vi.fn<RerunJobFromDlq>(async () => ({
      outcome: "failed",
      runId: "run-2",
      status: 500,
      error: { message: "internal_error" },
    }));
    const dlq = adapterWithRerun(store.redis, rerunJob);
    await dlq.pushToDLQ(item);

    const results = await Promise.all(Array.from({ length: 5 }, () => dlq.rerunFromDLQ(RERUN)));

    expect(rerunJob).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.outcome === "failed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "not_run" && r.reason === "claimed")).toHaveLength(4);
    expect(store.entries()).toEqual([item]);
    expect(store.claims()).toEqual({});
  });

  it("another entry of the same queue is not held up", async () => {
    const store = memoryRedis();
    const running = gate<RerunJobRunOutcome>();
    const rerunJob = vi.fn<RerunJobFromDlq>(() => running.promise);
    const dlq = adapterWithRerun(store.redis, rerunJob);
    await dlq.pushToDLQ(item);
    await dlq.pushToDLQ({ ...item, ref: { queue: "demo.job", id: "run-9" } });

    const first = dlq.rerunFromDLQ(RERUN);
    const other = dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-9" });
    await vi.waitFor(() => expect(rerunJob).toHaveBeenCalledTimes(2));
    expect(Object.keys(store.claims()).sort()).toEqual([
      CLAIM_KEY,
      "th:jobs:dlq-rerun-claim:demo.job:run-9",
    ]);

    running.open({ outcome: "not_run", reason: "disabled" });
    await Promise.all([first, other]);
  });

  describe("the claim is released once rerunJob has answered, with a compare-and-delete", () => {
    const outcomes: Array<[string, RerunJobRunOutcome]> = [
      ["ran", { outcome: "ran", runId: "run-2" }],
      ["not_run", { outcome: "not_run", reason: "disabled" }],
      ["failed", { outcome: "failed", runId: "run-2", status: 500, error: { message: "boom" } }],
    ];

    it.each(outcomes)("%s", async (_label, outcome) => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, async () => outcome);
      await dlq.pushToDLQ(item);

      await dlq.rerunFromDLQ(RERUN);

      expect(store.claims()).toEqual({});
      // The key as KEYS[1], our own token as the value to compare.
      expect(store.releases).toEqual([
        { numKeys: 1, key: CLAIM_KEY, token: store.sets[0]!.value, reply: 1 },
      ]);
      // So the next rerun gets through.
      expect((await dlq.rerunFromDLQ(RERUN).catch((e) => e)) as unknown).not.toEqual({
        outcome: "not_run",
        reason: "claimed",
      });
    });

    it("an entry that does not exist: still not_found, and the claim is released", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "nope" })).rejects.toMatchObject({
        name: "JobDiagnosticsError",
        code: "not_found",
      });
      expect(store.sets).toHaveLength(1);
      expect(store.claims()).toEqual({});
    });

    it("never deletes a claim that expired and was taken by someone else", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, async () => {
        // Our claim ran out mid-run and another process took the entry.
        store.dropClaim(CLAIM_KEY);
        store.putClaim(CLAIM_KEY, "someone-elses-token");
        return { outcome: "not_run", reason: "unconfirmed" };
      });
      await dlq.pushToDLQ(item);

      await dlq.rerunFromDLQ(RERUN);

      expect(store.claims()).toEqual({ [CLAIM_KEY]: "someone-elses-token" });
      expect(store.releases.map((r) => r.reply)).toEqual([0]);
    });
  });

  describe("rerunJob THREW: the run may still be going, so the claim is kept", () => {
    /** The request to the runner breaks off; what the run does next is up to the test. */
    async function brokenOff() {
      const store = memoryRedis();
      const rerunJob = vi.fn<RerunJobFromDlq>(async () => {
        throw new TypeError("fetch failed");
      });
      const dlq = adapterWithRerun(store.redis, rerunJob);
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ(RERUN)).rejects.toThrow("fetch failed");
      return { store, dlq, rerunJob, token: store.sets[0]!.value };
    }

    it("no release is sent, and the claim stays under its TTL", async () => {
      const { store, token } = await brokenOff();

      expect(store.releases).toEqual([]);
      expect(store.claims()).toEqual({ [CLAIM_KEY]: token });
      expect(store.sets[0]!.options).toEqual(["EX", 330, "NX"]);
      expect(store.entries()).toEqual([item]);
    });

    it("a second rerun answers `claimed` and rerunJob is not invoked again", async () => {
      const { store, dlq, rerunJob } = await brokenOff();

      await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual({
        outcome: "not_run",
        reason: "claimed",
      });
      expect(rerunJob).toHaveBeenCalledTimes(1);
      // Nor did the refused one release the first one's claim.
      expect(Object.keys(store.claims())).toEqual([CLAIM_KEY]);
    });

    it("the late failure of that run still matches the claim and rewrites the entry in place", async () => {
      const { store, dlq, token } = await brokenOff();

      // What the run route does when the run it was still running fails.
      await expect(dlq.holdsRerunClaim({ ...RERUN, token })).resolves.toBe(true);
      await expect(
        dlq.recordRerunFailure({
          ...RERUN,
          runId: "run-2",
          failedAt: "2026-10-08T09:30:00.000Z",
          error: { message: "boom again" },
        }),
      ).resolves.toBe(true);

      const entries = store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        ref: { queue: "demo.job", id: "run-1" },
        attempt: 2,
        metadata: { firstFailedAt: item.failedAt, lastRunId: "run-2" },
      });
    });

    it("once the claim has gone (its TTL), the entry can be rerun again", async () => {
      const { store, dlq, rerunJob } = await brokenOff();
      store.dropClaim(CLAIM_KEY);
      rerunJob.mockResolvedValueOnce({ outcome: "ran", runId: "run-3" });

      await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual({
        outcome: "ran",
        runId: "run-3",
        entryDeleted: true,
      });
      expect(store.claims()).toEqual({});
    });
  });

  describe("Redis fails while claiming: nothing runs, the entry is untouched", () => {
    function claimFails(how: "reply" | "reject") {
      const err = Object.assign(new Error("OOM command not allowed"), {
        command: { name: "set", args: [CLAIM_KEY, "token", "EX", 330, "NX"] },
      });
      return memoryRedis({
        exec: async (apply, commands) => {
          if (!commands.includes("set")) return apply();
          if (how === "reject") throw err;
          return [[err, null]];
        },
      });
    }

    it.each([
      ["the SET's reply carries an error", "reply", `failed at command 0 [OOM]`],
      ["the SET is rejected outright", "reject", `rejected [OOM]`],
    ] as const)("%s", async (_label, how, what) => {
      const store = claimFails(how);
      const rerunJob = vi.fn<RerunJobFromDlq>(neverRerun);
      const dlq = adapterWithRerun(store.redis, rerunJob);
      await dlq.pushToDLQ(item);
      store.batches.length = 0;

      const err = await dlq.rerunFromDLQ(RERUN).then(
        () => null,
        (e: unknown) => e as Error & { command?: unknown },
      );

      expect(err!.message).toBe(`redis dlq rerun claim ${what} (keyHash=${CLAIM_KEY_HASH})`);
      expect(err!.command).toBeUndefined();
      expect(rerunJob).not.toHaveBeenCalled();
      expect(store.entries()).toEqual([item]);
      // The entry was never read. The one other batch is the attempt to take
      // back a SET that may have landed with its reply lost.
      expect(store.batches.map((b) => b.commands)).toEqual([["set"], ["eval"]]);
    });

    it("a reply that is neither OK nor nil is an error, not a claim and not a refusal", async () => {
      const store = memoryRedis({
        exec: async (apply, commands) => (commands.includes("set") ? [[null, "QUEUED"]] : apply()),
      });
      const rerunJob = vi.fn<RerunJobFromDlq>(neverRerun);
      const dlq = adapterWithRerun(store.redis, rerunJob);
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ(RERUN)).rejects.toThrow(
        `redis dlq rerun claim unexpected reply (keyHash=${CLAIM_KEY_HASH})`,
      );
      expect(rerunJob).not.toHaveBeenCalled();
    });
  });

  describe("the release fails: the rerun's outcome still reaches the caller", () => {
    function releaseFails() {
      const err = Object.assign(new Error("Command timed out"), {
        command: { name: "eval", args: [RELEASE_RERUN_CLAIM_LUA, 1, CLAIM_KEY, "the-token"] },
      });
      return memoryRedis({
        exec: async (apply, commands) =>
          commands.length === 1 && commands[0] === "eval" ? [[err, null]] : apply(),
      });
    }
    const outcome: RerunJobRunOutcome = { outcome: "not_run", reason: "disabled" };

    it("answers what the run did, and logs and reports the release", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const store = releaseFails();
      const dlq = adapterWithRerun(store.redis, async () => outcome, { reportError, logger });
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual(outcome);

      const message = `redis dlq rerun claim release failed at command 0 [TIMEOUT] (keyHash=${CLAIM_KEY_HASH})`;
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = reportError.mock.calls[0]!;
      expect(reported).toBeInstanceOf(Error);
      expect(reported.message).toBe(message);
      expect(context).toEqual({
        tags: { area: "job-dlq", phase: "rerun-claim-release" },
        extra: { queue: "demo.job", jobId: "run-1" },
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("dlq_rerun_claim_release_failed", {
        queue: "demo.job",
        jobId: "run-1",
        error: { name: "Error", message },
      });
      // Neither line carries the token or the payload.
      const everything = spelledOut([reportError.mock.calls, logger.error.mock.calls]);
      expect(everything).not.toContain(store.sets[0]!.value);
      expect(everything).not.toContain("s3cr3t");

      // The claim is still there (it goes by its TTL), so a rerun is refused.
      expect(store.claims()).toEqual({ [CLAIM_KEY]: store.sets[0]!.value });
      await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual({
        outcome: "not_run",
        reason: "claimed",
      });
    });

    it("a throwing reporter does not change the answer", async () => {
      const dlq = adapterWithRerun(releaseFails().redis, async () => outcome, {
        reportError: () => {
          throw new Error("reporter down");
        },
      });
      await dlq.pushToDLQ(item);

      await expect(dlq.rerunFromDLQ(RERUN)).resolves.toEqual(outcome);
    });

    it("an entry that does not exist still rejects not_found, not the release's error", async () => {
      const reportError = vi.fn();
      const dlq = adapterWithRerun(releaseFails().redis, neverRerun, { reportError });

      await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "nope" })).rejects.toMatchObject({
        name: "JobDiagnosticsError",
        code: "not_found",
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1].tags.phase).toBe("rerun-claim-release");
    });
  });
});

describe("RedisJobDiagnosticsAdapter.holdsRerunClaim", () => {
  const CLAIM = { queue: "demo.job", jobId: "run-1" };

  it("true only for the live claim's own token, and only while the rerun runs", async () => {
    const store = memoryRedis();
    const seen: Record<string, boolean> = {};
    const dlq: RedisJobDiagnosticsAdapter = adapterWithRerun(store.redis, async (_q, _p, ctx) => {
      seen.own = await dlq.holdsRerunClaim({ ...CLAIM, token: ctx.claimToken });
      seen.wrong = await dlq.holdsRerunClaim({ ...CLAIM, token: "not-the-token" });
      seen.empty = await dlq.holdsRerunClaim({ ...CLAIM, token: "" });
      seen.otherEntry = await dlq.holdsRerunClaim({
        queue: "demo.job",
        jobId: "run-9",
        token: ctx.claimToken,
      });
      return { outcome: "not_run", reason: "unconfirmed" };
    });
    await dlq.pushToDLQ(item);

    await dlq.rerunFromDLQ(CLAIM);

    expect(seen).toEqual({ own: true, wrong: false, empty: false, otherEntry: false });
    // Released: the same token no longer holds anything.
    await expect(
      dlq.holdsRerunClaim({ ...CLAIM, token: store.sets[0]!.value }),
    ).resolves.toBe(false);
  });

  it("false when no claim exists", async () => {
    const dlq = adapterWithRerun(memoryRedis().redis, neverRerun);

    await expect(dlq.holdsRerunClaim({ ...CLAIM, token: "anything" })).resolves.toBe(false);
  });

  it("reads the claim and sends the token nowhere", async () => {
    const store = memoryRedis();
    const dlq = adapterWithRerun(store.redis, neverRerun);

    await dlq.holdsRerunClaim({ ...CLAIM, token: "caller-supplied" });

    expect(store.batches.map((b) => b.commands)).toEqual([["get"]]);
    expect(store.sets).toEqual([]);
  });

  it("a Redis failure throws, naming the op and a key hash only", async () => {
    const store = memoryRedis({
      exec: async () => {
        throw Object.assign(new Error("Connection is closed."), {
          command: { name: "get", args: [CLAIM_KEY] },
        });
      },
    });
    const dlq = adapterWithRerun(store.redis, neverRerun);

    const err = await dlq.holdsRerunClaim({ ...CLAIM, token: "t0ken" }).then(
      () => null,
      (e: unknown) => e as Error & { command?: unknown },
    );

    expect(err!.message).toBe(
      `redis dlq rerun claim check rejected [CONNECTION_CLOSED] (keyHash=${CLAIM_KEY_HASH})`,
    );
    expect(err!.command).toBeUndefined();
    expect(err!.message).not.toContain("t0ken");
  });
});

describe("RELEASE_RERUN_CLAIM_LUA and PURGE_DLQ_LUA", () => {
  it("release: deletes only after comparing the stored value with ARGV[1]", () => {
    const compare = RELEASE_RERUN_CLAIM_LUA.indexOf('redis.call("GET", KEYS[1]) == ARGV[1]');
    const del = RELEASE_RERUN_CLAIM_LUA.indexOf('redis.call("DEL", KEYS[1])');

    expect(compare).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(compare);
    expect(RELEASE_RERUN_CLAIM_LUA.trim().endsWith("return 0")).toBe(true);
  });

  it("purge: counts before it deletes, and returns the count", () => {
    const count = PURGE_DLQ_LUA.indexOf('redis.call("ZCARD", KEYS[1])');
    const del = PURGE_DLQ_LUA.indexOf('redis.call("DEL", KEYS[1])');

    expect(count).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(count);
    expect(PURGE_DLQ_LUA.trim().endsWith("return count")).toBe(true);
  });

  it("neither touches a key but KEYS[1]", () => {
    for (const script of [RELEASE_RERUN_CLAIM_LUA, PURGE_DLQ_LUA]) {
      const calls = script.match(/redis\.call\([^)]*\)/g) ?? [];
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call).toContain("KEYS[1]");
    }
  });
});

describe("RedisJobDiagnosticsAdapter reads and deletes (no stored payload in any error)", () => {
  const CORRUPT = 's3cr3t-token{"not json';
  const other = { ...item, ref: { queue: "demo.job", id: "run-0" } };
  const later = { ...item, failedAt: "2026-10-07T13:00:00.000Z" };

  /** Redis answers every batch of `command` with an ioredis-shaped error. */
  function failing(command: string, message: string, how: "reply" | "reject" = "reply") {
    const err = Object.assign(new Error(message), {
      command: { name: command, args: [KEY, JSON.stringify(item)] },
      previousErrors: [new Error(`ERR ${JSON.stringify(item)}`)],
    });
    return memoryRedis({
      exec: async (apply, commands) => {
        if (!commands.includes(command)) return apply();
        if (how === "reject") throw err;
        return [[err, null]];
      },
    });
  }

  async function thrownBy(run: () => Promise<unknown>) {
    const err = await run().then(
      () => null,
      (e: unknown) => e as Error & { command?: unknown; previousErrors?: unknown },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.command).toBeUndefined();
    expect(err!.previousErrors).toBeUndefined();
    expect(err!.cause).toBeUndefined();
    expect(JSON.stringify(err) + err!.message + err!.stack).not.toContain("s3cr3t");
    return err!;
  }

  describe("deleteFromDLQ", () => {
    it("true when it removed the entry, and only that entry", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(other);
      await dlq.pushToDLQ(later);

      await expect(dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toBe(true);
      expect(store.entries()).toEqual([other]);
    });

    it("false when no entry has that id", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      await expect(dlq.deleteFromDLQ({ queue: "demo.job", jobId: "nope" })).resolves.toBe(false);
      expect(store.entries()).toEqual([item]);
    });

    it("a corrupt member ahead of the entry is skipped and reported, never quoted", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, { reportError, logger });
      store.putRaw(CORRUPT, 0);
      await dlq.pushToDLQ(item);

      await expect(dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toBe(true);

      expect(store.members()).toEqual([CORRUPT]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual({
        tags: { area: "job-dlq", phase: "unreadable-member" },
        extra: { op: "dlq delete", keyHash: KEY_HASH, count: 1 },
      });
      expect(spelledOut([reportError.mock.calls, logger.error.mock.calls])).not.toMatch(
        /s3cr3t|not json|SyntaxError|Unexpected token/,
      );
    });

    it("rewritten between the scan and the ZREM: removes the rewritten member", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);
      let done = false;
      store.hooks.afterScan = () => {
        if (done) return;
        done = true;
        for (const raw of store.members()) store.remove(raw);
        store.put({ ...item, attempt: 2 }, 1);
      };

      await expect(dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toBe(true);
      expect(store.members()).toEqual([]);
    });

    it("rewritten under every attempt: throws rather than say the entry does not exist", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);
      let n = 0;
      store.hooks.afterScan = () => {
        for (const raw of store.members()) store.remove(raw);
        store.put({ ...item, attempt: 1 + ++n }, n);
      };

      const err = await thrownBy(() => dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" }));

      expect(err.message).toBe(
        `redis dlq delete contended after 3 attempts (keyHash=${KEY_HASH})`,
      );
      expect(store.entries()).toHaveLength(1);
    });

    it.each([
      ["the scan", "zrange", "reject", "rejected [TIMEOUT]", "Command timed out"],
      ["the ZREM", "zrem", "reply", "failed at command 0 [OOM]", "OOM command not allowed"],
    ] as const)("%s fails: op, key hash and error code only", async (_l, command, how, what, message) => {
      const store = failing(command, message, how);
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await thrownBy(() => dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" }));

      expect(err.message).toBe(`redis dlq delete ${what} (keyHash=${KEY_HASH})`);
      expect(store.entries()).toEqual([item]);
    });
  });

  describe("purgeDLQ", () => {
    it("empties the queue and answers how many entries it held", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(other);
      await dlq.pushToDLQ(later);

      await expect(dlq.purgeDLQ({ queue: "demo.job" })).resolves.toEqual({ purged: 2 });
      expect(store.members()).toEqual([]);
      // One script call: the count and the delete cannot be split.
      expect(store.batches.at(-1)!.commands).toEqual(["eval"]);
    });

    it("an empty queue purges zero", async () => {
      const dlq = adapterWithRerun(memoryRedis().redis, neverRerun);

      await expect(dlq.purgeDLQ({ queue: "demo.job" })).resolves.toEqual({ purged: 0 });
    });

    it("a Redis failure: op, key hash and error code only, and nothing is purged", async () => {
      const store = failing("eval", "Connection is closed.", "reject");
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await thrownBy(() => dlq.purgeDLQ({ queue: "demo.job" }));

      expect(err.message).toBe(
        `redis dlq purge rejected [CONNECTION_CLOSED] (keyHash=${KEY_HASH})`,
      );
      expect(store.entries()).toEqual([item]);
    });
  });

  describe("getFromDLQ", () => {
    it("finds the entry behind a corrupt member instead of throwing on it", async () => {
      const reportError = vi.fn();
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, { reportError });
      store.putRaw(CORRUPT, 0);
      await dlq.pushToDLQ(item);

      await expect(dlq.getFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual(item);
      expect(reportError.mock.calls[0]![1].extra).toEqual({
        op: "dlq get",
        keyHash: KEY_HASH,
        count: 1,
      });
      expect(spelledOut(reportError.mock.calls)).not.toMatch(/s3cr3t|not json/);
    });

    it("null when no entry has that id", async () => {
      const dlq = adapterWithRerun(memoryRedis().redis, neverRerun);

      await expect(dlq.getFromDLQ({ queue: "demo.job", jobId: "nope" })).resolves.toBeNull();
    });

    it("a Redis failure: op, key hash and error code only", async () => {
      const store = failing("zrange", "WRONGTYPE Operation against a key");
      const dlq = adapterWithRerun(store.redis, neverRerun);

      const err = await thrownBy(() => dlq.getFromDLQ({ queue: "demo.job", jobId: "run-1" }));

      expect(err.message).toBe(
        `redis dlq get failed at command 0 [WRONGTYPE] (keyHash=${KEY_HASH})`,
      );
    });
  });

  describe("peekDLQ", () => {
    it("lists newest first, up to max", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(other);
      await dlq.pushToDLQ(later);

      await expect(dlq.peekDLQ({ queue: "demo.job", max: 10 })).resolves.toEqual([later, other]);
      await expect(dlq.peekDLQ({ queue: "demo.job", max: 1 })).resolves.toEqual([later]);
    });

    it("one corrupt member does not break the list: skipped, one log and one report, count only", async () => {
      const reportError = vi.fn();
      const logger = { error: vi.fn() };
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, { reportError, logger });
      await dlq.pushToDLQ(item);
      // Newest, so it heads the list.
      store.putRaw(CORRUPT, Date.parse("2027-01-01T00:00:00.000Z"));
      store.putRaw("null", 1);

      await expect(dlq.peekDLQ({ queue: "demo.job", max: 10 })).resolves.toEqual([item]);

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("dlq_unreadable_members", {
        op: "dlq peek",
        keyHash: KEY_HASH,
        count: 2,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual({
        tags: { area: "job-dlq", phase: "unreadable-member" },
        extra: { op: "dlq peek", keyHash: KEY_HASH, count: 2 },
      });
      expect(spelledOut([reportError.mock.calls, logger.error.mock.calls])).not.toMatch(
        /s3cr3t|not json|SyntaxError|Unexpected token|is not valid JSON/,
      );
    });

    it("a throwing reporter changes nothing", async () => {
      const store = memoryRedis();
      const dlq = adapterWithRerun(store.redis, neverRerun, {
        reportError: () => {
          throw new Error("reporter down");
        },
      });
      store.putRaw(CORRUPT, 0);
      await dlq.pushToDLQ(item);

      await expect(dlq.peekDLQ({ queue: "demo.job", max: 10 })).resolves.toEqual([item]);
    });

    it("a Redis failure: op, key hash and error code only", async () => {
      const store = failing("zrevrange", "Command timed out", "reject");
      const dlq = adapterWithRerun(store.redis, neverRerun);
      await dlq.pushToDLQ(item);

      const err = await thrownBy(() => dlq.peekDLQ({ queue: "demo.job", max: 10 }));

      expect(err.message).toBe(`redis dlq peek rejected [TIMEOUT] (keyHash=${KEY_HASH})`);
    });
  });
});

describe("RedisJobDiagnosticsAdapter: a scan is never read as more than it says", () => {
  /** Scans succeed but hand back no array once `odd.on` is set. */
  function oddScans() {
    const odd = { on: false };
    const store = memoryRedis({
      exec: async (apply, commands) =>
        odd.on && commands.includes("zrange") ? [[null, "OK"]] : apply(),
    });
    return { store, odd };
  }

  it("a scan reply that is not an array throws; it is not an empty queue", async () => {
    const { store, odd } = oddScans();
    const dlq = adapterWithRerun(store.redis, neverRerun);
    await dlq.pushToDLQ(item);
    odd.on = true;

    const message = `unexpected reply (keyHash=${KEY_HASH})`;
    // Was: `false`, "the entry is gone", and the caller pushed a second entry.
    await expect(
      dlq.recordRerunFailure({
        queue: "demo.job",
        jobId: "run-1",
        runId: "run-2",
        failedAt: "2026-10-08T09:30:00.000Z",
        error: { message: "boom again" },
      }),
    ).rejects.toThrow(`redis dlq rerun record ${message}`);
    await expect(dlq.getFromDLQ({ queue: "demo.job", jobId: "run-1" })).rejects.toThrow(
      `redis dlq get ${message}`,
    );
    await expect(dlq.deleteFromDLQ({ queue: "demo.job", jobId: "run-1" })).rejects.toThrow(
      `redis dlq delete ${message}`,
    );
    expect(store.entries()).toEqual([item]);
  });

  it("after a confirmed rerun it is `entryDeleted: false`, reported, not `true`", async () => {
    const reportError = vi.fn();
    const { store, odd } = oddScans();
    const dlq = adapterWithRerun(
      store.redis,
      async () => {
        odd.on = true;
        return { outcome: "ran", runId: "run-2" };
      },
      { reportError },
    );
    await dlq.pushToDLQ(item);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: false,
    });
    expect(store.entries()).toEqual([item]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0].message).toBe(
      `redis dlq rerun delete unexpected reply (keyHash=${KEY_HASH})`,
    );
  });

  it("the last ZREM missed and the entry then went away: `entryDeleted: true`, nothing reported", async () => {
    const reportError = vi.fn();
    const store = memoryRedis();
    const dlq = adapterWithRerun(
      store.redis,
      async () => {
        // Rewritten after the first two scans, deleted after the third: every
        // ZREM removes nothing, and only the last look sees it is gone.
        let scan = 0;
        store.hooks.afterScan = () => {
          scan += 1;
          if (scan > 3) return;
          for (const raw of store.members()) store.remove(raw);
          if (scan < 3) store.put({ ...item, attempt: 1 + scan }, scan);
        };
        return { outcome: "ran", runId: "run-2" };
      },
      { reportError },
    );
    await dlq.pushToDLQ(item);

    await expect(dlq.rerunFromDLQ({ queue: "demo.job", jobId: "run-1" })).resolves.toEqual({
      outcome: "ran",
      runId: "run-2",
      entryDeleted: true,
    });
    expect(store.members()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

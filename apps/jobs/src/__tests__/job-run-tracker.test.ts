import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { createJobRunTracker, type RunEntry } from "../lib/job-run-tracker";

/**
 * Minimal ioredis surface for the sorted-set commands the tracker uses, with
 * ONE piece of fidelity that matters: it reproduces how ioredis's `keyPrefix`
 * behaves, including the two places it does NOT apply.
 *
 * Verified 2026-09-12 against real ioredis 5.x + redis:7-alpine
 * (`keyPrefix: "ithasfire:dev:"`):
 *   - `zadd`/`zrevrange` key arguments ARE prefixed by the client.
 *   - `SCAN`'s MATCH pattern is NOT prefixed — `MATCH th:jobs:runs:*` against
 *     a prefixed keyspace returned `["0", []]`.
 *   - `SCAN` returns FULLY-QUALIFIED keys — feeding one back verbatim into
 *     `zrevrange` returned `[]` (it got double-prefixed); slicing the prefix
 *     off first returned the member.
 *   - (`EVAL` keys ARE prefixed, so the rate-limit adapter needs no change.)
 */
function makeFakeRedis(keyPrefix?: string) {
  const store = new Map<string, Array<{ score: number; member: string }>>();
  const prefix = keyPrefix ?? "";
  const q = (key: string) => `${prefix}${key}`;

  const scanCalls: string[] = [];
  const zrevrangeCalls: string[] = [];

  const fake = {
    options: { keyPrefix },

    async zadd(key: string, score: number, member: string) {
      const set = store.get(q(key)) ?? [];
      set.push({ score, member });
      store.set(q(key), set);
      return 1;
    },

    /** `record()` writes through MULTI; both key args get prefixed too. */
    multi() {
      const ops: Array<() => void> = [];
      const chain = {
        zadd(key: string, score: number, member: string) {
          ops.push(() => {
            const set = store.get(q(key)) ?? [];
            set.push({ score, member });
            store.set(q(key), set);
          });
          return chain;
        },
        zremrangebyrank(key: string, start: number, stop: number) {
          ops.push(() => {
            const set = [...(store.get(q(key)) ?? [])].sort(
              (a, b) => a.score - b.score,
            );
            const from = start;
            const to = stop < 0 ? set.length + stop : stop;
            if (to >= from) set.splice(from, to - from + 1);
            store.set(q(key), set);
          });
          return chain;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },

    async zrevrange(key: string, start: number, stop: number) {
      // ioredis prefixes this key argument.
      zrevrangeCalls.push(q(key));
      const set = [...(store.get(q(key)) ?? [])].sort(
        (a, b) => b.score - a.score,
      );
      const end = stop === -1 ? undefined : stop + 1;
      return set.slice(start, end).map((e) => e.member);
    },

    async scan(
      cursor: string,
      _match: "MATCH",
      pattern: string,
      _count: "COUNT",
      _n: number,
    ): Promise<[string, string[]]> {
      // ioredis does NOT prefix the MATCH pattern...
      scanCalls.push(pattern);
      const re = new RegExp(
        `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`,
      );
      // ...and returns keys exactly as they are stored on the server.
      const matched = [...store.keys()].filter((k) => re.test(k)).sort();
      void cursor;
      return ["0", matched];
    },
  };

  return {
    redis: fake as unknown as Redis,
    store,
    scanCalls,
    zrevrangeCalls,
  };
}

const entry = (jobName: string, startedAt: string): RunEntry => ({
  id: `${jobName}-run`,
  jobName,
  startedAt,
  finishedAt: startedAt,
  durationMs: 10,
  status: "success",
});

describe("job-run-tracker latestAll()", () => {
  it("returns the newest run per job with no keyPrefix", async () => {
    const { redis, scanCalls, zrevrangeCalls } = makeFakeRedis();
    const tracker = createJobRunTracker(redis);

    await tracker.record(entry("alpha", "2026-09-01T00:00:00.000Z"));
    await tracker.record(entry("alpha", "2026-09-02T00:00:00.000Z"));
    await tracker.record(entry("beta", "2026-09-03T00:00:00.000Z"));

    const latest = await tracker.latestAll();

    expect(scanCalls).toEqual(["th:jobs:runs:*"]);
    expect([...latest.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(latest.get("alpha")?.startedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(latest.get("beta")?.startedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(zrevrangeCalls).toContain("th:jobs:runs:alpha");
  });

  it("returns the newest run per job WITH a keyPrefix", async () => {
    const { redis, store, scanCalls, zrevrangeCalls } =
      makeFakeRedis("ithasfire:dev:");
    const tracker = createJobRunTracker(redis);

    await tracker.record(entry("alpha", "2026-09-01T00:00:00.000Z"));
    await tracker.record(entry("alpha", "2026-09-02T00:00:00.000Z"));
    await tracker.record(entry("beta", "2026-09-03T00:00:00.000Z"));

    // Sanity: the writes really did land under the namespace.
    expect([...store.keys()].sort()).toEqual([
      "ithasfire:dev:th:jobs:runs:alpha",
      "ithasfire:dev:th:jobs:runs:beta",
    ]);

    const latest = await tracker.latestAll();

    // The MATCH pattern must carry the prefix by hand, or it matches nothing.
    expect(scanCalls).toEqual(["ithasfire:dev:th:jobs:runs:*"]);
    expect([...latest.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(latest.get("alpha")?.startedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(latest.get("beta")?.startedAt).toBe("2026-09-03T00:00:00.000Z");

    // And the SCAN result must be stripped before zrevrange, or the client
    // re-prefixes it into `ithasfire:dev:ithasfire:dev:th:jobs:runs:alpha`.
    expect(zrevrangeCalls).toContain("ithasfire:dev:th:jobs:runs:alpha");
    for (const key of zrevrangeCalls) {
      expect(key).not.toContain("ithasfire:dev:ithasfire:dev:");
    }
  });

  it("ignores keys outside the run namespace", async () => {
    const { redis, store } = makeFakeRedis("ithasfire:dev:");
    const tracker = createJobRunTracker(redis);

    await tracker.record(entry("alpha", "2026-09-01T00:00:00.000Z"));
    store.set("ithasfire:dev:th:jobs:dlq:alpha", [
      { score: 1, member: "not-a-run" },
    ]);
    store.set("ithasfire:prod:th:jobs:runs:alpha", [
      { score: 1, member: JSON.stringify(entry("alpha", "2026-01-01")) },
    ]);

    const latest = await tracker.latestAll();
    expect([...latest.keys()]).toEqual(["alpha"]);
    expect(latest.get("alpha")?.startedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns an empty map when nothing has run", async () => {
    const { redis } = makeFakeRedis("ithasfire:dev:");
    const latest = await createJobRunTracker(redis).latestAll();
    expect(latest.size).toBe(0);
  });
});

// ioredis's exec() resolves instead of rejecting on failure, which made the
// run route's `job_run_record_failed` catch dead code. record() must reject.
describe("job-run-tracker record() (exec failures reject)", () => {
  const entry: RunEntry = {
    id: "run-1",
    jobName: "demo.job",
    startedAt: "2026-10-07T12:00:00.000Z",
    finishedAt: "2026-10-07T12:00:01.000Z",
    durationMs: 1000,
    status: "success",
    resultSummary: '{"secret":"s3cr3t"}',
  };

  function redisWithExec(exec: () => Promise<unknown>) {
    const multi = {
      zadd: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
      exec: vi.fn(exec),
    };
    return { redis: { multi: vi.fn(() => multi) } as unknown as Redis, multi };
  }

  it("resolves when both commands succeeded", async () => {
    const { redis, multi } = redisWithExec(async () => [
      [null, 1],
      [null, 0],
    ]);
    await expect(createJobRunTracker(redis).record(entry)).resolves.toBeUndefined();
    expect(multi.zadd).toHaveBeenCalledWith(
      "th:jobs:runs:demo.job",
      Date.parse(entry.startedAt),
      JSON.stringify(entry),
    );
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("rejects when exec resolves null (transaction aborted)", async () => {
    const { redis } = redisWithExec(async () => null);
    await expect(createJobRunTracker(redis).record(entry)).rejects.toThrow(
      /^redis job run record aborted \(keyHash=[0-9a-f]{12}\)$/,
    );
  });

  it("rejects on an error tuple without leaking the run entry", async () => {
    const { redis } = redisWithExec(async () => [
      [Object.assign(new Error("OOM command not allowed"), { command: { args: [JSON.stringify(entry)] } }), null],
      [null, 0],
    ]);
    const err = await createJobRunTracker(redis)
      .record(entry)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err?.message).toMatch(/^redis job run record failed at command 0 \[OOM\] \(keyHash=[0-9a-f]{12}\)$/);
    expect(JSON.stringify(err) + err?.message).not.toContain("s3cr3t");
  });
});

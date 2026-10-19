import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";

import type { JobDiagnosticsDlqItem, RerunJobRunOutcome } from "@th/ports/job-diagnostics";

import {
  RedisJobDiagnosticsAdapter,
  SWAP_DLQ_MEMBER_LUA,
  type RerunJobFromDlq,
} from "../redis-dlq-adapter";

/**
 * The DLQ adapter against a REAL Redis, through a client with `keyPrefix` set
 * (production sets it from `REDIS_NAMESPACE`).
 *
 * The unit test (`redis-dlq-adapter.test.ts`) drives the adapter through a
 * fake whose `eval` redoes the Lua in JS, so it cannot catch a wrong script,
 * a KEYS/ARGV mix-up, a key that escapes the client's prefix, or how ioredis
 * hands a pipeline callback the nil of a refused `SET NX`. Here the literal
 * scripts and commands run.
 *
 * Which server, and why not `@th/test-utils`' `startRedisContainer`: the same
 * as `rate-limit/__tests__/redis-rate-limit-adapter.integration.test.ts`.
 * `TESTCONTAINERS_REUSE_REDIS_URL` set (CI's `redis` service): connect to it,
 * a server SHARED with later steps, so this suite never flushes it and touches
 * only keys under its own random per-run namespace. Otherwise an in-memory
 * `redis-server` from `redis-memory-server`, started and stopped by this
 * suite. Skipped only under `CI` with no url (no egress to fetch the binary).
 */
const providedRedisUrl =
  process.env.TESTCONTAINERS_REUSE_REDIS_URL?.trim() || undefined;
const ciFlag = process.env.CI?.toLowerCase();
const inCi = ciFlag === "true" || ciFlag === "1";

/** The client's `keyPrefix`: every key this suite writes lives under it. */
const NS = `dlq-it-${randomBytes(6).toString("hex")}:`;
const QUEUE = "demo.job";
const DLQ_KEY = `th:jobs:dlq:${QUEUE}`;
const claimKeyOf = (jobId: string) => `th:jobs:dlq-rerun-claim:${QUEUE}:${jobId}`;

function entry(id: string, failedAt = "2026-10-01T00:00:00.000Z"): JobDiagnosticsDlqItem {
  return {
    ref: { queue: QUEUE, id },
    payload: { orderId: "o-1", list: [] },
    failedAt,
    attempt: 1,
    error: { message: "job blew up" },
  };
}

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(inCi && !providedRedisUrl)(
  "RedisJobDiagnosticsAdapter (integration, real Redis, prefixed client)",
  () => {
    /** Only set when this suite started the server; then it also stops it. */
    let server: RedisMemoryServer | undefined;
    /** The adapter's client: `keyPrefix` = NS, as in production. */
    let prefixed: Redis;
    /** No prefix: reads the real key names, to check where things landed. */
    let raw: Redis;

    beforeAll(async () => {
      let options: { host: string; port: number } | string;
      if (providedRedisUrl) {
        options = providedRedisUrl;
      } else {
        server = await RedisMemoryServer.create();
        options = { host: await server.getHost(), port: await server.getPort() };
      }
      const make = (keyPrefix?: string) =>
        typeof options === "string"
          ? new Redis(options, { maxRetriesPerRequest: 1, keyPrefix })
          : new Redis({ ...options, maxRetriesPerRequest: 1, keyPrefix });
      prefixed = make(NS);
      raw = make();
    }, 180_000);

    /** Delete only this run's keys. Never FLUSHALL/FLUSHDB: the server may be shared. */
    const deleteOwnKeys = async () => {
      let cursor = "0";
      do {
        const [next, keys] = await raw.scan(cursor, "MATCH", `${NS}*`, "COUNT", 500);
        cursor = next;
        if (keys.length > 0) await raw.del(...keys);
      } while (cursor !== "0");
    };

    afterEach(async () => {
      await deleteOwnKeys();
    });

    afterAll(async () => {
      try {
        if (raw) await deleteOwnKeys();
      } finally {
        try {
          await prefixed?.quit();
          await raw?.quit();
        } finally {
          await server?.stop();
        }
      }
    });

    function adapter(rerunJob: RerunJobFromDlq) {
      return new RedisJobDiagnosticsAdapter({ redis: prefixed, rerunJob });
    }

    /** A rerun whose callback waits until the test lets it answer. */
    function heldRerun(answer: RerunJobRunOutcome) {
      const started = deferred<{ claimToken: string }>();
      const release = deferred<void>();
      const rerunJob: RerunJobFromDlq = async (_queue, _payload, ctx) => {
        started.resolve({ claimToken: ctx.claimToken });
        await release.promise;
        return answer;
      };
      return { rerunJob, started: started.promise, letGo: () => release.resolve() };
    }

    it("keys land under the client's prefix, and nowhere else", async () => {
      const held = heldRerun({ outcome: "ran", runId: "run-2" });
      const dlq = adapter(held.rerunJob);
      await dlq.pushToDLQ(entry("e-1"));

      const running = dlq.rerunFromDLQ({ queue: QUEUE, jobId: "e-1" });
      await held.started;

      expect(await raw.exists(`${NS}${DLQ_KEY}`)).toBe(1);
      expect(await raw.exists(`${NS}${claimKeyOf("e-1")}`)).toBe(1);
      expect(await raw.exists(DLQ_KEY)).toBe(0);
      expect(await raw.exists(claimKeyOf("e-1"))).toBe(0);

      held.letGo();
      await expect(running).resolves.toEqual({
        outcome: "ran",
        runId: "run-2",
        entryDeleted: true,
      });
    });

    it("the claim: won by the first rerun (token, 330s TTL), lost by a second (`SET NX` nil through the pipeline callback)", async () => {
      const held = heldRerun({ outcome: "ran", runId: "run-2" });
      const dlq = adapter(held.rerunJob);
      await dlq.pushToDLQ(entry("e-1"));

      const first = dlq.rerunFromDLQ({ queue: QUEUE, jobId: "e-1" });
      const { claimToken } = await held.started;

      expect(await prefixed.get(claimKeyOf("e-1"))).toBe(claimToken);
      const ttl = await prefixed.ttl(claimKeyOf("e-1"));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(330);
      await expect(
        dlq.holdsRerunClaim({ queue: QUEUE, jobId: "e-1", token: claimToken }),
      ).resolves.toBe(true);
      await expect(
        dlq.holdsRerunClaim({ queue: QUEUE, jobId: "e-1", token: randomUUID() }),
      ).resolves.toBe(false);

      // The loser reads nothing and runs nothing.
      const second = adapter(async () => {
        throw new Error("the loser must not run");
      });
      await expect(second.rerunFromDLQ({ queue: QUEUE, jobId: "e-1" })).resolves.toEqual({
        outcome: "not_run",
        reason: "claimed",
      });
      // And did not touch the winner's claim.
      expect(await prefixed.get(claimKeyOf("e-1"))).toBe(claimToken);

      held.letGo();
      await first;
      // Released by compare-and-delete with the right token.
      expect(await prefixed.exists(claimKeyOf("e-1"))).toBe(0);
    });

    it("release with the wrong token: a claim taken over by someone else is left alone", async () => {
      const takenOver = randomUUID();
      const dlq = adapter(async () => {
        // The claim expired and someone else took it meanwhile.
        await prefixed.set(claimKeyOf("e-1"), takenOver, "EX", 330);
        return { outcome: "not_run", reason: "unconfirmed" };
      });
      await dlq.pushToDLQ(entry("e-1"));

      await expect(dlq.rerunFromDLQ({ queue: QUEUE, jobId: "e-1" })).resolves.toEqual({
        outcome: "not_run",
        reason: "unconfirmed",
      });
      expect(await prefixed.get(claimKeyOf("e-1"))).toBe(takenOver);
    });

    it("a rerunJob that throws keeps the claim under its TTL", async () => {
      let token = "";
      const dlq = adapter(async (_q, _p, ctx) => {
        token = ctx.claimToken;
        throw new TypeError("fetch failed");
      });
      await dlq.pushToDLQ(entry("e-1"));

      await expect(dlq.rerunFromDLQ({ queue: QUEUE, jobId: "e-1" })).rejects.toThrow(
        "fetch failed",
      );
      expect(await prefixed.get(claimKeyOf("e-1"))).toBe(token);
      expect(await prefixed.ttl(claimKeyOf("e-1"))).toBeGreaterThan(0);
      expect(await dlq.peekDLQ({ queue: QUEUE })).toEqual([entry("e-1")]);
    });

    it("recordRerunFailure rewrites the entry in place, keeping the stored payload byte for byte", async () => {
      const dlq = adapter(async () => ({ outcome: "ran", runId: null }));
      await dlq.pushToDLQ(entry("e-1"));

      await expect(
        dlq.recordRerunFailure({
          queue: QUEUE,
          jobId: "e-1",
          runId: "run-3",
          failedAt: "2026-10-02T00:00:00.000Z",
          error: { message: "still broken" },
        }),
      ).resolves.toBe(true);

      const members = await prefixed.zrange(DLQ_KEY, 0, -1, "WITHSCORES");
      expect(members).toHaveLength(2);
      const stored = JSON.parse(members[0]!) as JobDiagnosticsDlqItem;
      expect(stored).toMatchObject({
        ref: { queue: QUEUE, id: "e-1" },
        attempt: 2,
        failedAt: "2026-10-02T00:00:00.000Z",
        error: { message: "still broken" },
        metadata: { firstFailedAt: "2026-10-01T00:00:00.000Z", lastRunId: "run-3" },
      });
      // `[]` stays `[]` (cjson would make it `{}`): the member is never decoded in Lua.
      expect(stored.payload).toEqual({ orderId: "o-1", list: [] });
      expect(Number(members[1])).toBe(new Date("2026-10-02T00:00:00.000Z").getTime());
    });

    it("a swap whose old member is gone returns 0 and writes nothing; recordRerunFailure then answers false", async () => {
      const swapped = await prefixed.eval(
        SWAP_DLQ_MEMBER_LUA,
        1,
        DLQ_KEY,
        JSON.stringify(entry("gone")),
        Date.now(),
        JSON.stringify({ ...entry("gone"), attempt: 2 }),
      );
      expect(swapped).toBe(0);
      expect(await prefixed.zcard(DLQ_KEY)).toBe(0);

      const dlq = adapter(async () => ({ outcome: "ran", runId: null }));
      await expect(
        dlq.recordRerunFailure({
          queue: QUEUE,
          jobId: "gone",
          runId: null,
          failedAt: "2026-10-02T00:00:00.000Z",
          error: { message: "x" },
        }),
      ).resolves.toBe(false);
      expect(await prefixed.zcard(DLQ_KEY)).toBe(0);
    });

    it("purge answers the count it deleted, and 0 for an empty queue", async () => {
      const dlq = adapter(async () => ({ outcome: "ran", runId: null }));
      await dlq.pushToDLQ(entry("e-1", "2026-10-01T00:00:00.000Z"));
      await dlq.pushToDLQ(entry("e-2", "2026-10-01T00:00:01.000Z"));
      await dlq.pushToDLQ(entry("e-3", "2026-10-01T00:00:02.000Z"));

      await expect(dlq.purgeDLQ({ queue: QUEUE })).resolves.toEqual({ purged: 3 });
      expect(await raw.exists(`${NS}${DLQ_KEY}`)).toBe(0);
      await expect(dlq.purgeDLQ({ queue: QUEUE })).resolves.toEqual({ purged: 0 });
    });
  },
);

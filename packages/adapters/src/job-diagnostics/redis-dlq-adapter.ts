import type Redis from "ioredis";
import type { Callback, ChainableCommander } from "ioredis";
import { randomUUID } from "node:crypto";

import {
  type JobDiagnosticsDlqItem,
  type JobDiagnosticsPort,
  type RerunJobFromDlqResult,
  type RerunJobRunOutcome,
  createJobDiagnosticsError,
  peekJobDlqInputSchema,
  getJobDlqItemInputSchema,
  deleteJobDlqItemInputSchema,
  purgeJobDlqInputSchema,
  rerunJobFromDlqInputSchema,
} from "@th/ports/job-diagnostics";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";

import { execOrThrow, redisKeyHash } from "../redis/exec-or-throw";

// ─────────────────────────────────────────────────────────────────────────────
// Redis-backed JobDiagnosticsPort adapter.
//
// Stores DLQ items in Redis sorted sets keyed by queue name. This is the
// adapter production runs (wired in apps/jobs/src/lib/container.ts); there is
// no other DLQ backend.
// ─────────────────────────────────────────────────────────────────────────────

type RedisJobDiagnosticsOptions = {
  redis: Redis;
  /** Key prefix for DLQ sorted sets. Default: "th:jobs:dlq:" */
  keyPrefix?: string;
  /**
   * Key prefix for per-entry rerun claims (see `rerunFromDLQ`); the key is
   * `<prefix><queue>:<entry id>`. Default: "th:jobs:dlq-rerun-claim:"
   */
  rerunClaimKeyPrefix?: string;
  /** Max items per queue before oldest are pruned. Default: 500 */
  maxPerQueue?: number;
  /**
   * Callback to re-run a job. Typically POSTs to the jobs service. It answers
   * with what the run did; only `outcome: "ran"` deletes the entry. It
   * THROWS for any answer that does not show the run ended: a network
   * failure, a timeout, a gateway's 5xx in place of the runner's own answer.
   * The throw propagates, leaves the entry untouched and keeps the claim (see
   * `rerunFromDLQ`).
   */
  rerunJob: RerunJobFromDlq;
  /**
   * Told about the failures this adapter swallows: the entry could not be
   * deleted after a confirmed rerun, or its rerun claim could not be released
   * (see `rerunFromDLQ`), and a stored member was unreadable and skipped (see
   * `readEntries`).
   */
  reportError?: ReporterPort;
  /** Error-level log line for those same swallows. */
  logger?: Pick<LoggerPort, "error">;
};

/**
 * `ctx.dlqItemId` is the id of the entry being rerun. `ctx.claimToken` is the
 * value of the rerun claim held on it while this callback runs; the run route
 * gets both, and rewrites the entry on failure only when the token is still
 * the live claim (`holdsRerunClaim`).
 */
export type RerunJobFromDlq = (
  queue: string,
  payload: unknown,
  ctx: { dlqItemId: string; claimToken: string },
) => Promise<RerunJobRunOutcome>;

/**
 * Compare-and-swap of one sorted-set member: replace `ARGV[1]` (the member as
 * it was read) with `ARGV[3]` at score `ARGV[2]`, only if `ARGV[1]` is still
 * in the set. Returns 1 when swapped, 0 when the old member is gone.
 *
 * - Lua, so nothing can interleave between the check and the write. A scan
 *   followed by a MULTI cannot do that: two reruns failing together both read
 *   the same member, and the second would add a duplicate.
 * - Members are compared as RAW strings and never decoded here: `cjson`
 *   re-encodes `[]` as `{}` and loses precision on large integers, which
 *   would corrupt the stored payload.
 * - ZADD before ZREM, so no failure part-way can leave the set without the
 *   entry.
 * - The key is `KEYS[1]`: ioredis applies the client's `keyPrefix` to declared
 *   keys only.
 *
 * Exported so the tests can run it against a fake and assert its text.
 */
export const SWAP_DLQ_MEMBER_LUA = `
if redis.call("ZSCORE", KEYS[1], ARGV[1]) == false then
  return 0
end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
if ARGV[1] ~= ARGV[3] then
  redis.call("ZREM", KEYS[1], ARGV[1])
end
return 1
`;

/**
 * Release a rerun claim: delete `KEYS[1]` only while it still holds `ARGV[1]`,
 * the token this process wrote. Returns 1 when deleted, 0 when the key is gone
 * or holds another token.
 *
 * - Lua, so the compare and the delete cannot be split. A GET followed by a
 *   DEL could delete a claim that expired and was taken again by someone else
 *   in between, and their rerun would then run unguarded.
 * - The key is `KEYS[1]`, for the same `keyPrefix` reason as the swap above.
 *
 * Exported so the tests can assert its text.
 */
export const RELEASE_RERUN_CLAIM_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Purge one queue: count its entries, delete the key, return the count. Lua so
 * no push can land between the count and the delete and go uncounted. (A MULTI
 * would be atomic too, but ioredis hands a command queued in a MULTI the reply
 * "QUEUED", so the count could only be read from a bare `exec()`.)
 *
 * Exported so the tests can assert its text.
 */
export const PURGE_DLQ_LUA = `
local count = redis.call("ZCARD", KEYS[1])
redis.call("DEL", KEYS[1])
return count
`;

/**
 * Scan-and-write rounds before giving up, for `recordRerunFailure`, for the
 * delete after a confirmed rerun and for `deleteFromDLQ`.
 */
const MAX_SWAP_ATTEMPTS = 3;

/**
 * Seconds a rerun claim lives when nobody releases it.
 *
 * Longer than the REQUEST can last: a rerun is one request that waits for the
 * job, and Cloud Run cuts a request off at 300s (docs/jobs.md, "Finish inside
 * 300s"). That cap bounds the request, not the run: past it Cloud Run's front
 * end answers 504 while the handler behind it keeps going. A claim kept after
 * such an answer (see `rerunFromDLQ`) expires 330s after it was taken, so a run
 * that lasts longer than that outlives its claim. From then on a second rerun
 * can start beside it, and if the first run then fails, its token no longer
 * matches and its failure is pushed as an entry of its own. Jobs are written to
 * finish inside 300s, so that window is the residual, not the norm.
 *
 * A claim left behind by a process that died is gone at most 330s later.
 * Until a claim goes, every rerun of that entry answers `claimed`.
 */
const RERUN_CLAIM_TTL_SECONDS = 330;

/** A stored member, and the entry parsed from it. */
type StoredEntry = { raw: string; item: JobDiagnosticsDlqItem };

function logSafe(err: unknown): { name: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: "NonError", message: String(err) };
}

export type RecordRerunFailureInput = {
  queue: string;
  /** Id of the DLQ entry the failed run was a rerun of. */
  jobId: string;
  /** Run id of the failed rerun. */
  runId: string | null;
  /** ISO time the rerun failed. */
  failedAt: string;
  error: { message: string; code?: string };
};

function dlqKey(prefix: string, queue: string) {
  return `${prefix}${queue}`;
}

/**
 * One claim key per entry. Queue and id are joined as they are, so an operator
 * can read the key; two pairs that join to the same text could at worst answer
 * each other `claimed`, and ids are run ids (UUIDs), so they do not.
 */
function rerunClaimKey(prefix: string, queue: string, jobId: string) {
  return `${prefix}${queue}:${jobId}`;
}

export class RedisJobDiagnosticsAdapter implements JobDiagnosticsPort {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly rerunClaimPrefix: string;
  private readonly maxPerQueue: number;
  private readonly rerunJob: RerunJobFromDlq;
  private readonly reportError?: ReporterPort;
  private readonly logger?: Pick<LoggerPort, "error">;

  constructor(options: RedisJobDiagnosticsOptions) {
    this.redis = options.redis;
    this.prefix = options.keyPrefix ?? "th:jobs:dlq:";
    this.rerunClaimPrefix =
      options.rerunClaimKeyPrefix ?? "th:jobs:dlq-rerun-claim:";
    this.maxPerQueue = options.maxPerQueue ?? 500;
    this.rerunJob = options.rerunJob;
    this.reportError = options.reportError;
    this.logger = options.logger;
  }

  /**
   * Run ONE command as a pipeline through `execOrThrow` and return its reply.
   *
   * Every read and write of this adapter goes through here or through
   * `execOrThrow` directly: its errors are logged, reported, or answered to
   * the console by the Fastify backstop. A bare `redis.zrem(...)` or
   * `redis.eval(...)` rejects with an ioredis error that carries
   * `command.args`, here the stored entries with their full payloads.
   * `execOrThrow` replaces that with the op name, a key hash and the Redis
   * error code.
   */
  private async one<T>(
    op: string,
    key: string,
    queue: (pipeline: ChainableCommander, reply: Callback<T>) => ChainableCommander,
  ): Promise<T> {
    let value: T | undefined;
    await execOrThrow(
      queue(this.redis.pipeline(), (err, result) => {
        if (!err) value = result;
      }),
      op,
      key,
    );
    return value as T;
  }

  /**
   * Read one range of a queue's sorted set and parse it, in the order Redis
   * returned it.
   *
   * A member that is not valid JSON, or has no `ref.id`, is skipped: it cannot
   * be listed or looked up (its id is unreadable). Skipping rather than
   * throwing keeps one corrupt member from breaking the console's list, every
   * failed-rerun rewrite and every delete on its queue.
   *
   * The skip is a deliberate swallow, so each read that skipped anything logs
   * once at error and reports once (CLAUDE.md reporter rule), with the op, a
   * key hash and the count. Never the member and never the parse error: V8
   * quotes the text it choked on in a `SyntaxError` message. Nothing else
   * surfaces such a member.
   *
   * A reply that is not an array throws (fixed text, op and key hash). Read as
   * an empty queue it would say "the entry is gone" for an answer that says
   * nothing of the kind.
   */
  private async readEntries(
    op: string,
    key: string,
    range: (
      pipeline: ChainableCommander,
      reply: Callback<string[]>,
    ) => ChainableCommander,
  ): Promise<StoredEntry[]> {
    const members = await this.one<string[]>(op, key, range);
    if (!Array.isArray(members)) {
      throw new Error(
        `redis ${op} unexpected reply (keyHash=${redisKeyHash(key)})`,
      );
    }

    const entries: StoredEntry[] = [];
    let unreadable = 0;
    for (const raw of members) {
      let item: JobDiagnosticsDlqItem | null = null;
      try {
        item = JSON.parse(raw) as JobDiagnosticsDlqItem | null;
      } catch {
        // Counted and reported below, without the error (it quotes the member).
      }
      if (typeof item?.ref?.id !== "string") {
        unreadable += 1;
        continue;
      }
      entries.push({ raw, item });
    }

    if (unreadable > 0) {
      const keyHash = redisKeyHash(key);
      this.logger?.error("dlq_unreadable_members", {
        op,
        keyHash,
        count: unreadable,
      });
      try {
        this.reportError?.(
          new Error(`redis ${op} skipped unreadable members (keyHash=${keyHash})`),
          {
            tags: { area: "job-dlq", phase: "unreadable-member" },
            extra: { op, keyHash, count: unreadable },
          },
        );
      } catch {
        // best-effort only
      }
    }
    return entries;
  }

  /**
   * The stored member whose entry has this id, exactly as stored (the first
   * one, oldest first, when several carry it). Unreadable members are skipped
   * (see `readEntries`).
   */
  private async findMember(
    op: string,
    key: string,
    jobId: string,
  ): Promise<StoredEntry | null> {
    const entries = await this.readEntries(op, key, (pipeline, reply) =>
      pipeline.zrange(key, 0, -1, reply),
    );
    return entries.find((entry) => entry.item.ref.id === jobId) ?? null;
  }

  /**
   * Remove the entry with this id.
   *
   * - `removed`: a ZREM of this call removed it.
   * - `absent`: a scan found no entry with that id (never there, or someone
   *   else removed it).
   * - `contended`: every round's ZREM removed nothing because the member was
   *   rewritten between the scan and the ZREM (a rerun of the same entry
   *   failed meanwhile), the rounds ran out, and a last scan still found the
   *   entry. That last scan is what keeps "the final ZREM missed, and the
   *   entry then went away" from being answered as "still there".
   *
   * Redis failures throw, sanitised.
   */
  private async removeEntry(
    op: string,
    key: string,
    jobId: string,
  ): Promise<"removed" | "absent" | "contended"> {
    for (let round = 1; round <= MAX_SWAP_ATTEMPTS; round++) {
      const found = await this.findMember(op, key, jobId);
      if (!found) return "absent";
      const removed = await this.one<number>(op, key, (pipeline, reply) =>
        pipeline.zrem(key, found.raw, reply),
      );
      if (Number(removed) >= 1) return "removed";
      // 0: that member is no longer there. Read again.
    }
    return (await this.findMember(op, key, jobId)) ? "contended" : "absent";
  }

  // ── Write (called by the jobs service when a job fails) ─────────────────

  /**
   * Push a failed job into the DLQ. Not part of the port interface itself —
   * this is the "ingestion" side that the jobs handler calls on error.
   */
  async pushToDLQ(item: JobDiagnosticsDlqItem): Promise<void> {
    const key = dlqKey(this.prefix, item.ref.queue);
    const score = new Date(item.failedAt).getTime();
    const member = JSON.stringify(item);

    // Throws when the MULTI is aborted or either command fails; exec() alone
    // resolves on failure and the job's DLQ entry would vanish silently.
    await execOrThrow(
      this.redis
        .multi()
        .zadd(key, score, member)
        .zremrangebyrank(key, 0, -(this.maxPerQueue + 1)),
      "dlq push",
      key,
    );
  }

  /**
   * Record that a rerun of an existing entry failed, by rewriting that entry
   * in place. Ingestion-side like `pushToDLQ`, so not on the port interface.
   *
   * A failed rerun is itself a failed run. Pushing it as a new entry would
   * leave two entries for one piece of work, so the run route calls this
   * instead and pushes only when it answers `false` (the entry is gone).
   *
   * The rewritten entry keeps its `ref` (the console's row id stays valid) and
   * its original `payload`. `failedAt`, the sorted-set score and `error` move
   * to the new failure, and `attempt` counts up. `metadata.firstFailedAt` is
   * set once from the original `failedAt`; `metadata.lastRunId` names the
   * rerun.
   *
   * The write is a compare-and-swap (`SWAP_DLQ_MEMBER_LUA`) on the member as
   * it was read. When the entry changed in between (another rerun of it
   * failed, or it was deleted), the entry is read again and the rewrite is
   * rebuilt from the fresh copy, up to `MAX_SWAP_ATTEMPTS` rounds; if it is
   * gone by then, this answers `false` and writes nothing. So reruns failing
   * together still leave one entry, each one counted, and a delete is never
   * undone.
   *
   * Throws when Redis fails or the rounds run out. Every error thrown here
   * names the op and a key hash (plus the Redis error code when Redis
   * failed), never a member; a stored member that cannot be parsed is skipped,
   * not thrown (see `readEntries`). One
   * case stays open: a swap that Redis applied but whose reply was lost also
   * throws, and the caller's fallback push then adds a second entry.
   */
  async recordRerunFailure(input: RecordRerunFailureInput): Promise<boolean> {
    const { queue, jobId, runId, failedAt, error } = input;
    const key = dlqKey(this.prefix, queue);
    const op = "dlq rerun record";

    for (let round = 1; round <= MAX_SWAP_ATTEMPTS; round++) {
      const found = await this.findMember(op, key, jobId);
      if (!found) return false;
      const { raw, item } = found;

      const next: JobDiagnosticsDlqItem = {
        ...item,
        failedAt,
        attempt: (item.attempt ?? 1) + 1,
        error,
        metadata: {
          ...(item.metadata ?? {}),
          firstFailedAt: item.metadata?.firstFailedAt ?? item.failedAt,
          ...(runId ? { lastRunId: runId } : {}),
        },
      };

      const swapped = await this.one<unknown>(op, key, (pipeline, reply) =>
        pipeline.eval(
          SWAP_DLQ_MEMBER_LUA,
          1,
          key,
          raw,
          new Date(failedAt).getTime(),
          JSON.stringify(next),
          reply,
        ),
      );
      if (Number(swapped) === 1) return true;
      // 0: the member read above is gone. Read again and rebuild from what is
      // there now.
    }

    throw new Error(
      `redis ${op} contended after ${MAX_SWAP_ATTEMPTS} attempts (keyHash=${redisKeyHash(key)})`,
    );
  }

  // ── Port methods ────────────────────────────────────────────────────────

  /**
   * Newest first. An unreadable member is left out of the list rather than
   * failing it (logged and reported once per call, see `readEntries`), so the
   * list can be shorter than `max` while such a member sits in its range.
   */
  async peekDLQ(input: unknown): Promise<JobDiagnosticsDlqItem[]> {
    const { queue, max } = peekJobDlqInputSchema.parse(input);
    const key = dlqKey(this.prefix, queue);

    const entries = await this.readEntries("dlq peek", key, (pipeline, reply) =>
      pipeline.zrevrange(key, 0, max - 1, reply),
    );
    return entries.map((entry) => entry.item);
  }

  async getFromDLQ(input: unknown): Promise<JobDiagnosticsDlqItem | null> {
    const { queue, jobId } = getJobDlqItemInputSchema.parse(input);
    const key = dlqKey(this.prefix, queue);

    // Scan for the entry with matching id. Small set, so this is fine.
    const found = await this.findMember("dlq get", key, jobId);
    return found?.item ?? null;
  }

  /**
   * True when this call removed the entry, false when no entry has that id.
   * Throws when the entry was rewritten under every attempt and is still
   * there: `false` would say it does not exist.
   */
  async deleteFromDLQ(input: unknown): Promise<boolean> {
    const { queue, jobId } = deleteJobDlqItemInputSchema.parse(input);
    const key = dlqKey(this.prefix, queue);
    const op = "dlq delete";

    const outcome = await this.removeEntry(op, key, jobId);
    if (outcome === "contended") {
      throw new Error(
        `redis ${op} contended after ${MAX_SWAP_ATTEMPTS} attempts (keyHash=${redisKeyHash(key)})`,
      );
    }
    return outcome === "removed";
  }

  async purgeDLQ(input: unknown): Promise<{ purged: number }> {
    const { queue } = purgeJobDlqInputSchema.parse(input);
    const key = dlqKey(this.prefix, queue);

    const count = await this.one<unknown>("dlq purge", key, (pipeline, reply) =>
      pipeline.eval(PURGE_DLQ_LUA, 1, key, reply),
    );
    return { purged: Number(count) || 0 };
  }

  /**
   * True when `token` is the live rerun claim on this entry. The run route
   * asks before it writes a failed run onto the entry named by its
   * `X-Dlq-Rerun-Of` header, so only the rerun that holds the claim can
   * rewrite an entry; anyone else naming it gets an entry of their own.
   * Ingestion-side like `recordRerunFailure`, so not on the port interface.
   *
   * The token is compared here and never sent to Redis. Plain `===`: it is
   * not a credential. Every caller of the run route already holds the jobs API
   * key, and the token only decides whether a failed run rewrites an entry or
   * pushes its own, so there is nothing for a timing-safe compare to protect.
   *
   * Throws, sanitised, when Redis fails.
   */
  async holdsRerunClaim(input: {
    queue: string;
    jobId: string;
    token: string;
  }): Promise<boolean> {
    const claimKey = rerunClaimKey(
      this.rerunClaimPrefix,
      input.queue,
      input.jobId,
    );
    const held = await this.one<string | null>(
      "dlq rerun claim check",
      claimKey,
      (pipeline, reply) => pipeline.get(claimKey, reply),
    );
    return typeof held === "string" && held.length > 0 && held === input.token;
  }

  /**
   * Release the claim taken by `rerunFromDLQ`, if it is still ours.
   *
   * Never throws. A failed release is a deliberate swallow: the rerun has
   * settled by now, and what the job did must reach the caller whatever
   * happens here. The claim then expires by its TTL, and until it does reruns
   * of the entry answer `claimed`. Logged and reported because nothing else
   * surfaces it (CLAUDE.md reporter rule); the error is `execOrThrow`'s (op,
   * key hash, Redis error code).
   */
  private async releaseRerunClaim(
    claimKey: string,
    token: string,
    entry: { queue: string; jobId: string },
  ): Promise<void> {
    try {
      await this.one<unknown>(
        "dlq rerun claim release",
        claimKey,
        (pipeline, reply) =>
          pipeline.eval(RELEASE_RERUN_CLAIM_LUA, 1, claimKey, token, reply),
      );
    } catch (err) {
      this.logger?.error("dlq_rerun_claim_release_failed", {
        ...entry,
        error: logSafe(err),
      });
      try {
        this.reportError?.(err, {
          tags: { area: "job-dlq", phase: "rerun-claim-release" },
          extra: entry,
        });
      } catch {
        // best-effort only
      }
    }
  }

  /**
   * Rerun one entry, under a claim on it.
   *
   * The claim is what keeps two people rerunning one entry at the same moment
   * from running the job twice: `SET <claim key> <random token> NX EX`, taken
   * before the entry is read. Whoever does not get it answers
   * `not_run / claimed` without reading or running anything.
   *
   * - The value is a random token and nothing else: no payload, no entry.
   * - It is released (`releaseRerunClaim`: only if still ours) once
   *   `rerunJob` has ANSWERED, whatever the answer, and when nothing was
   *   started (no such entry, the read failed).
   * - It is KEPT when `rerunJob` throws. A request that broke off (Node's
   *   fetch gives up on the response headers at 300s), and a gateway's 5xx in
   *   place of the runner's answer (Cloud Run's 504 past 300s; the callback
   *   throws for it), say nothing about whether the run ended, and releasing
   *   would let a second rerun start beside a run that is still going. The
   *   claim then goes by its TTL: reruns of the entry answer `claimed` for up
   *   to `RERUN_CLAIM_TTL_SECONDS` after such a throw, also when nothing in
   *   fact ran (a refused connection, a 503 from a gateway with no instance
   *   behind it). The run's own failure, if it comes while the claim lives,
   *   still matches it and is written onto the entry (see the TTL's comment
   *   for a run that outlives it).
   * - A process that dies holding it never releases it either; same TTL.
   * - Redis failing on the claim throws: nothing ran and the entry is
   *   untouched.
   */
  async rerunFromDLQ(input: unknown): Promise<RerunJobFromDlqResult> {
    const { queue, jobId, payloadOverride } =
      rerunJobFromDlqInputSchema.parse(input);
    const claimKey = rerunClaimKey(this.rerunClaimPrefix, queue, jobId);
    const token = randomUUID();
    const claimOp = "dlq rerun claim";

    let claim: unknown;
    try {
      claim = await this.one<"OK" | null>(claimOp, claimKey, (pipeline, reply) =>
        pipeline.set(
          claimKey,
          token,
          "EX",
          RERUN_CLAIM_TTL_SECONDS,
          "NX",
          reply,
        ),
      );
    } catch (err) {
      // The SET may have landed with only its reply lost (a timeout). Try to
      // take it back, so the entry is not locked for the whole TTL with
      // nothing running.
      await this.releaseRerunClaim(claimKey, token, { queue, jobId });
      throw err;
    }
    // nil: the key exists, so someone else holds the claim.
    if (claim === null) return { outcome: "not_run", reason: "claimed" };

    // Set when `rerunJob` threw: the run may still be going, so the claim
    // stays and its TTL clears it.
    const run = { mayBeLive: false };
    try {
      if (claim !== "OK") {
        // Neither "taken" nor "refused". Not read as either.
        throw new Error(
          `redis ${claimOp} unexpected reply (keyHash=${redisKeyHash(claimKey)})`,
        );
      }
      return await this.rerunClaimedEntry({
        queue,
        jobId,
        payloadOverride,
        token,
        run,
      });
    } finally {
      if (!run.mayBeLive) {
        await this.releaseRerunClaim(claimKey, token, { queue, jobId });
      }
    }
  }

  /**
   * The rerun itself. The caller holds the entry's claim under `token`, and
   * reads `run.mayBeLive` afterwards to decide whether to release it.
   */
  private async rerunClaimedEntry(input: {
    queue: string;
    jobId: string;
    payloadOverride: unknown;
    token: string;
    run: { mayBeLive: boolean };
  }): Promise<RerunJobFromDlqResult> {
    const { queue, jobId, payloadOverride, token, run } = input;
    const key = dlqKey(this.prefix, queue);

    const found = await this.findMember("dlq rerun read", key, jobId);
    if (!found) {
      throw createJobDiagnosticsError(
        "not_found",
        `DLQ item ${jobId} not found in queue ${queue}`,
      );
    }

    const payload =
      payloadOverride !== undefined ? payloadOverride : found.item.payload;
    let result: RerunJobRunOutcome;
    try {
      result = await this.rerunJob(queue, payload, {
        dlqItemId: jobId,
        claimToken: token,
      });
    } catch (err) {
      // No answer is not "it did not run" (see `rerunFromDLQ`).
      run.mayBeLive = true;
      throw err;
    }

    // The entry goes only when the run was confirmed. A paused job, a
    // coalesced or unconfirmed request and a failed run all keep it: the
    // runner answers 2xx for work it never did, so "the call returned" is not
    // evidence that anything ran.
    //
    // Every answer here releases the claim (the caller's `finally`). For
    // `coalesced` that is BEFORE this payload runs: the runner took it into
    // the next pass of a drain already in flight, inside another request. A
    // second rerun can then start while that pass is pending or running. Left
    // so on purpose: drain jobs are idempotent, so an extra pass is harmless.
    if (result.outcome !== "ran") return result;

    // `entryDeleted` is true only when the entry is known to be gone: a ZREM
    // removed it, or no entry with that id is left.
    const op = "dlq rerun delete";
    let failure: unknown;
    try {
      if ((await this.removeEntry(op, key, jobId)) !== "contended") {
        return { ...result, entryDeleted: true };
      }
      failure = new Error(
        `redis ${op} contended after ${MAX_SWAP_ATTEMPTS} attempts (keyHash=${redisKeyHash(key)})`,
      );
    } catch (err) {
      failure = err;
    }

    // Deliberate swallow: the job RAN, and that must reach the caller. An
    // error here would read as "the rerun failed" with the entry still listed,
    // and a second click would run the job (a settlement, a payout) again. So
    // the answer stays `ran` and says the entry is still there. Logged and
    // reported because nothing else surfaces it (CLAUDE.md reporter rule).
    // `failure` is either the fixed-text error above or one from
    // `execOrThrow` (op, key hash, Redis error code): `removeEntry` makes no
    // bare Redis call and `readEntries` lets no parse error out, so it carries
    // no member.
    this.logger?.error("dlq_rerun_delete_failed", {
      queue,
      jobId,
      runId: result.runId,
      error: logSafe(failure),
    });
    try {
      this.reportError?.(failure, {
        tags: { area: "job-dlq", phase: "rerun-delete" },
        extra: { queue, jobId, runId: result.runId },
      });
    } catch {
      // best-effort only
    }
    return { ...result, entryDeleted: false };
  }

  /**
   * Generate a unique DLQ item id.
   */
  static generateId(): string {
    return randomUUID();
  }
}

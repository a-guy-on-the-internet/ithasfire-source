// @th/adapters/db/idempotency-prisma.ts
import { Prisma, PrismaClient } from "@prisma/client";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";

const DAY_SEC = 86400;

export class PrismaIdempotencyAdapter implements IdempotencyPort {
  constructor(
    private readonly db: PrismaClient,
    private readonly namespace = "global",
    private readonly logger?: LoggerPort,
  ) {}

  private physicalKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private jsonValue(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    const normalized = JSON.parse(
      JSON.stringify(value ?? null),
    ) as Prisma.InputJsonValue | null;
    return normalized === null ? Prisma.JsonNull : normalized;
  }

  /**
   * NOTE (owner-checked release, NO schema change): while a claim is
   * `in_progress`, the `errorText` column doubles as the OWNER-TOKEN slot —
   * it is unused (NULL) in that status otherwise, and `commit`/`fail` both
   * overwrite it, so a token can never survive into a terminal record.
   * {@link release} compare-and-deletes on it.
   */
  async begin(key: string, ttlSec = 60, ownerToken?: string): Promise<boolean> {
    const physicalKey = this.physicalKey(key);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const token = ownerToken ?? null;
    const rows = await this.db.$queryRaw<{ key: string }[]>`
      INSERT INTO "Idempotency" (
        "key",
        "status",
        "lockedAt",
        "expiresAt",
        "resultJson",
        "errorText",
        "updatedAt"
      )
      VALUES (${physicalKey}, 'in_progress', ${now}, ${expiresAt}, NULL, ${token}, ${now})
      ON CONFLICT ("key") DO UPDATE
      SET
        "status" = 'in_progress',
        "lockedAt" = ${now},
        "expiresAt" = ${expiresAt},
        "resultJson" = NULL,
        "errorText" = ${token},
        "updatedAt" = ${now}
      WHERE "Idempotency"."expiresAt" IS NOT NULL
        AND "Idempotency"."expiresAt" <= ${now}
      RETURNING "key"
    `;

    return rows.length === 1;
  }

  /**
   * Owner-checked release: a single conditional DELETE (atomic in Postgres)
   * that frees the key IFF it is still the caller's own live claim —
   * `status = 'in_progress'` AND `errorText` = the token this caller passed
   * to {@link begin}. An expired holder whose claim was re-acquired (begin's
   * ON CONFLICT arm overwrote `errorText` with the NEW holder's token)
   * matches nothing and returns false, leaving the new holder's lock intact.
   * Committed/failed records never match (`status` filter + errorText
   * overwritten), so this can never destroy a dedupe record.
   */
  async release(key: string, ownerToken: string): Promise<boolean> {
    const { count } = await this.db.idempotency.deleteMany({
      where: {
        key: this.physicalKey(key),
        status: "in_progress",
        errorText: ownerToken,
      },
    });
    return count === 1;
  }

  async commit<T = unknown>(
    key: string,
    result: T,
    keepSec = 3 * DAY_SEC,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + keepSec * 1000);
    await this.db.idempotency.upsert({
      where: { key: this.physicalKey(key) },
      create: {
        key: this.physicalKey(key),
        status: "succeeded",
        lockedAt: now,
        expiresAt,
        resultJson: this.jsonValue(result),
        errorText: null,
      },
      update: {
        status: "succeeded",
        lockedAt: now,
        expiresAt,
        resultJson: this.jsonValue(result),
        errorText: null,
      },
    });
  }

  async fail(key: string, error?: string, keepSec = 15 * 60): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + keepSec * 1000);
    await this.db.idempotency.upsert({
      where: { key: this.physicalKey(key) },
      create: {
        key: this.physicalKey(key),
        status: "failed",
        lockedAt: now,
        expiresAt,
        resultJson: Prisma.JsonNull,
        errorText: error ?? "",
      },
      update: {
        status: "failed",
        lockedAt: now,
        expiresAt,
        resultJson: Prisma.JsonNull,
        errorText: error ?? "",
      },
    });
  }

  async status(
    key: string,
  ): Promise<"in_progress" | "succeeded" | "failed" | null> {
    const now = new Date();
    const row = await this.db.idempotency.findFirst({
      where: {
        key: this.physicalKey(key),
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { status: true },
    });
    const s = row?.status;
    return s === "in_progress" || s === "succeeded" || s === "failed"
      ? s
      : null;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const now = new Date();
    const row = await this.db.idempotency.findFirst({
      where: {
        key: this.physicalKey(key),
        status: "succeeded",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { resultJson: true },
    });
    if (!row) return null;
    return (row.resultJson as T) ?? null;
  }

  async run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
    keepSec = 3 * DAY_SEC,
  ): Promise<{ fresh: boolean; result: T }> {
    const acquired = await this.begin(key, ttlSec);
    if (!acquired) {
      const prior = await this.get<T>(key);
      if (prior !== null) return { fresh: false, result: prior };
      throw new Error("idempotent-op-in-progress");
    }
    try {
      const result = await fn();
      await this.commit(key, result, keepSec);
      return { fresh: true, result };
    } catch (e) {
      await this.fail(key, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * Delete records past their retention window.
   *
   * Unlike the Redis adapter there is no automatic expiry here, so without this
   * the table grows forever. Reads already filter on `expiresAt` (see `get`),
   * so an unswept row is inert and correctness never depended on this running —
   * but `resultJson` caches whole success payloads, so the space is real.
   *
   * `expiresAt: null` means "keep indefinitely" and is never swept. Only rows
   * with an expiry that has already passed are eligible, at ANY status:
   *
   * - `succeeded` past expiry — the replay window is over. A retry after this
   *   point re-executes, which is the same outcome the Redis backend has always
   *   had once its key expired.
   * - `failed` past expiry — short retention by design (15 min default).
   * - `in_progress` past expiry — the owner died mid-flight. `begin` already
   *   treats a lapsed claim as re-acquirable, so deleting the row changes
   *   nothing beyond reclaiming it.
   *
   * Bounded by `limit` and driven by an id-based sub-select, so one call can't
   * emit an unbounded DELETE. Callers loop until a pass returns short.
   */
  async purgeExpired(limit = 1000): Promise<number> {
    const now = new Date();
    const doomed = await this.db.idempotency.findMany({
      where: { expiresAt: { not: null, lt: now } },
      select: { key: true },
      take: limit,
    });
    if (doomed.length === 0) return 0;
    const { count } = await this.db.idempotency.deleteMany({
      where: { key: { in: doomed.map((r) => r.key) } },
    });
    return count;
  }
}

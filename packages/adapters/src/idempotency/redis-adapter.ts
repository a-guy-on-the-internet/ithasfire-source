// @th/adapters/idempotency/redis-idempotency.ts
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Redis } from "ioredis";

import { execOrThrow } from "../redis/exec-or-throw";

const DAY_SECONDS = 86400;

/**
 * Atomic owner-checked release: DEL only if the key still holds THIS owner's
 * in-progress value. Lua (not GET-then-DEL) so no interleaving is possible
 * between the compare and the delete — a plain GET/compare/DEL pair has a
 * window where the key expires and a new holder SETs between the two calls,
 * which would delete the new holder's live lock.
 */
const RELEASE_IF_OWNER_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export class RedisIdempotency implements IdempotencyPort {
  constructor(
    private r: Redis,
    private ns = "global",
    private logger?: LoggerPort,
  ) {}

  private k(key: string) {
    return `idem:${this.ns}:${key}`;
  } // status: in_progress|succeeded|failed
  private kr(key: string) {
    return `idemres:${this.ns}:${key}`;
  } // JSON result

  /**
   * NOTE (owner-checked release): when `ownerToken` is passed, the status
   * value stored is `in_progress:${ownerToken}` — the token rides IN the
   * value so {@link release} can compare-and-del atomically. `get()` only
   * ever matches the exact string "succeeded", so the suffix is invisible to
   * every other reader, and commit/fail overwrite the value entirely.
   */
  async begin(key: string, ttlSec = 60, ownerToken?: string): Promise<boolean> {
    const value = ownerToken ? `in_progress:${ownerToken}` : "in_progress";
    const ok = await this.r.set(this.k(key), value, "EX", ttlSec, "NX");
    return ok === "OK";
  }

  /**
   * Owner-checked release via {@link RELEASE_IF_OWNER_LUA}: frees the key IFF
   * it still holds this owner's `in_progress:${ownerToken}` value. After TTL
   * expiry + re-acquisition by a new holder the value carries the NEW token,
   * so a stale holder's release returns false and touches nothing. Committed
   * ("succeeded") / failed ("failed:…") values never match either.
   */
  async release(key: string, ownerToken: string): Promise<boolean> {
    const result = await this.r.eval(
      RELEASE_IF_OWNER_LUA,
      1,
      this.k(key),
      `in_progress:${ownerToken}`,
    );
    return Number(result) === 1;
  }

  async commit<T = unknown>(
    key: string,
    result: T,
    keepSec = 3 * DAY_SECONDS,
  ): Promise<void> {
    const p = this.r.multi();
    p.set(this.k(key), "succeeded", "EX", keepSec);
    p.set(this.kr(key), JSON.stringify(result ?? null), "EX", keepSec);
    await execOrThrow(p, "idempotency commit", key);
  }

  async fail(key: string, error?: string, keepSec = 15 * 60): Promise<void> {
    await this.r.set(this.k(key), `failed:${error ?? ""}`, "EX", keepSec);
  }

  async status(
    key: string,
  ): Promise<"in_progress" | "succeeded" | "failed" | null> {
    const s = await this.r.get(this.k(key));
    if (!s) return null;
    if (s === "succeeded") return "succeeded";
    if (s === "in_progress" || s.startsWith("in_progress:")) return "in_progress";
    if (s.startsWith("failed")) return "failed";
    return null;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const s = await this.r.get(this.k(key));
    if (s !== "succeeded") return null;
    const j = await this.r.get(this.kr(key));
    if (!j) return null;
    try {
      return JSON.parse(j) as T;
    } catch (err) {
      // If the stored value is malformed, treat it as a cache miss instead of
      // throwing so callers can recover and re-run the operation.
      this.logger?.warn("idempotency_malformed_json", {
        key,
        namespace: this.ns,
        rawValue: j.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
    keepSec = 3 * DAY_SECONDS,
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
   * No-op: Redis expires these keys itself. Every write here sets `EX`, so a
   * record is gone the moment its retention window passes and there is nothing
   * left to sweep. Returning 0 lets a caller's drain loop terminate on the
   * first pass.
   *
   * Deliberately implemented rather than omitted — see `IdempotencyPort` — so
   * that "who reclaims the space?" is answered explicitly by every backend
   * instead of being an accident of which adapter is wired.
   */
  async purgeExpired(): Promise<number> {
    return 0;
  }
}

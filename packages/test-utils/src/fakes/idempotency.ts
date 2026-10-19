import { vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
export type FakeIdempotencyOptions = {
  beginSequence?: boolean[];
  /**
   * Expose the optional read-only `status(key)` (both real adapters have
   * it). Off by default: callers branch on its presence, so turning it on
   * for every suite would change what they exercise.
   */
  withStatus?: boolean;
};

export type FakeIdempotencyRecord<T = unknown> = {
  payloadHash: string;
  response: T;
};

export type FakeIdempotencyPort = IdempotencyPort & {
  __store: Map<string, FakeIdempotencyRecord>;
  __locks: Map<string, number>;
  /** ownerToken recorded per key by `begin` (owner-checked `release`). */
  __tokens: Map<string, string>;
  __mocks: {
    begin: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    purgeExpired: ReturnType<typeof vi.fn>;
    /** Wired into the port only with `withStatus: true`. */
    status: ReturnType<typeof vi.fn>;
  };
};

export function createFakeIdempotencyPort({
  beginSequence = [],
  withStatus = false,
}: FakeIdempotencyOptions = {}): FakeIdempotencyPort {
  const store = new Map<string, FakeIdempotencyRecord>();
  const locks = new Map<string, number>();
  const tokens = new Map<string, string>();
  /** Keys whose live record is a `fail` marker (for `status` only). */
  const failed = new Set<string>();
  const queue = [...beginSequence];

  const beginMock = vi.fn(
    async (key: string, ttlSec = 60, ownerToken?: string) => {
      if (queue.length > 0) {
        const forced = queue.shift()!;
        // A sequence-forced acquire still records the token so an
        // owner-checked release matches (mirrors the real adapters, where a
        // successful begin always stores the token with the claim).
        if (forced && ownerToken !== undefined) tokens.set(key, ownerToken);
        return forced;
      }
      const now = Date.now();
      const lockUntil = locks.get(key);
      if (lockUntil && lockUntil > now) {
        return false;
      }
      locks.set(key, now + ttlSec * 1000);
      failed.delete(key);
      if (ownerToken !== undefined) {
        tokens.set(key, ownerToken);
      } else {
        tokens.delete(key);
      }
      return true;
    },
  );

  const commitMock = vi.fn(
    async (key: string, result: unknown, keepSec = 60) => {
      const payload = result as FakeIdempotencyRecord;
      store.set(key, payload);
      locks.set(key, Date.now() + keepSec * 1000);
      // Terminal records carry no owner token (adapters overwrite the slot).
      tokens.delete(key);
    },
  );

  // Pinned to the real adapters (prisma-adapter.ts / redis-adapter.ts `fail`):
  // a `failed` record that `get` never returns and `begin` refuses until it
  // expires (15 min by default). A same-key retry after `fail` is LOCKED OUT,
  // which is why transient failures go through `abandonClaim` (release).
  const failMock = vi.fn(
    async (key: string, _reason?: string, keepSec = 15 * 60) => {
      store.delete(key);
      locks.set(key, Date.now() + keepSec * 1000);
      tokens.delete(key);
      failed.add(key);
    },
  );

  // Owner-checked release, pinned to the real adapters' semantics
  // (prisma-adapter.ts `release`: conditional DELETE on key+status+token;
  // redis-adapter.ts `release`: Lua compare-and-del): frees the key IFF the
  // caller's token matches the recorded claim, otherwise touches NOTHING —
  // a stale (TTL-expired, re-acquired) holder must not free the new
  // holder's live lock.
  const releaseMock = vi.fn(async (key: string, ownerToken: string) => {
    if (tokens.get(key) !== ownerToken) {
      return false;
    }
    tokens.delete(key);
    locks.delete(key);
    return true;
  });

  const getMock = vi.fn(
    async (key: string) => (store.get(key) ?? null) as unknown,
  );

  const runMock = vi.fn(async () => {
    throw new Error("run not implemented for tests");
  });

  // Drops entries whose lock/retention instant has passed, mirroring the real
  // adapters' "expired means eligible" rule closely enough for callers that
  // just need a working port. `locks` doubles as the expiry clock here (commit
  // stamps it with keepSec), so a record is purgeable exactly when a real
  // backend would consider it past retention.
  const purgeExpiredMock = vi.fn(async (limit = 1000) => {
    const now = Date.now();
    let removed = 0;
    for (const [key, expiresAt] of locks) {
      if (removed >= limit) break;
      if (expiresAt > now) continue;
      locks.delete(key);
      store.delete(key);
      removed++;
    }
    return removed;
  });

  // Live record (unexpired lock) → its status: a stored result means
  // `succeeded`; a token or a bare lock (begin, or a test seeding `__locks`)
  // means `in_progress`; otherwise `failed`. Mirrors the adapters' "only
  // unexpired rows count".
  const statusMock = vi.fn(async (key: string) => {
    const until = locks.get(key);
    if (!until || until <= Date.now()) return null;
    if (store.has(key)) return "succeeded" as const;
    if (failed.has(key)) return "failed" as const;
    return "in_progress" as const;
  });

  const port: IdempotencyPort = {
    ...(withStatus
      ? { status: statusMock as NonNullable<IdempotencyPort["status"]> }
      : {}),
    begin: beginMock as IdempotencyPort["begin"],
    commit: commitMock as IdempotencyPort["commit"],
    fail: failMock as IdempotencyPort["fail"],
    release: releaseMock as IdempotencyPort["release"],
    get: getMock as IdempotencyPort["get"],
    run: runMock as IdempotencyPort["run"],
    purgeExpired: purgeExpiredMock as IdempotencyPort["purgeExpired"],
  };

  return Object.assign(port, {
    __store: store,
    __locks: locks,
    __tokens: tokens,
    __mocks: {
      begin: beginMock,
      commit: commitMock,
      fail: failMock,
      release: releaseMock,
      get: getMock,
      run: runMock,
      purgeExpired: purgeExpiredMock,
      status: statusMock,
    },
  }) as unknown as FakeIdempotencyPort;
}

import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";

import {
  ORDER_REFUND_MUTEX_TTL_SECONDS,
  buildOrderRefundMutexKey,
  withOrderRefundMutex,
} from "../refund-mutex";

const ORDER_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Adapter-faithful in-memory idempotency port, pinned to the semantics
 * VERIFIED in both real adapters (do not loosen this fake without re-reading
 * them — the mutex's owner-checked release depends on these exact
 * behaviours):
 *
 * - `begin(key, ttl, ownerToken)` stores the token WITH the claim:
 *   - Prisma (`packages/adapters/src/idempotency/prisma-adapter.ts`,
 *     `begin`): the token rides in the in-progress row's `errorText` column;
 *     the ON CONFLICT re-acquire arm (gated on `expiresAt <= now`)
 *     OVERWRITES it with the new holder's token.
 *   - Redis (`packages/adapters/src/idempotency/redis-adapter.ts`, `begin`):
 *     value is `in_progress:${token}`, `SET .. NX EX ttl` — a re-acquire
 *     after expiry writes the new holder's token.
 * - `begin` is blocked by an UNEXPIRED record of ANY status (Prisma:
 *   `WHERE "expiresAt" <= now` update gate; Redis: `NX` while key exists).
 * - `release(key, ownerToken)` is an atomic compare-and-delete: it frees the
 *   key IFF the stored token matches (Prisma: conditional DELETE on
 *   key+status+errorText; Redis: Lua GET==value → DEL) and NEVER touches a
 *   non-matching record. A successful release makes the key immediately
 *   re-acquirable.
 * - An `in_progress` claim past its TTL is re-acquirable (crashed holder).
 */
function createAdapterFaithfulIdempotency(clock: { nowMs: number }) {
  const records = new Map<
    string,
    { status: string; expiresAtMs: number; ownerToken: string | null }
  >();

  const port: IdempotencyPort = {
    begin: vi.fn(async (key: string, ttlSec = 60, ownerToken?: string) => {
      const existing = records.get(key);
      if (existing && existing.expiresAtMs > clock.nowMs) {
        return false;
      }
      records.set(key, {
        status: "in_progress",
        expiresAtMs: clock.nowMs + ttlSec * 1000,
        ownerToken: ownerToken ?? null,
      });
      return true;
    }) as IdempotencyPort["begin"],
    commit: vi.fn(async (key: string, _r: unknown, keepSec = 3 * 86400) => {
      records.set(key, {
        status: "succeeded",
        expiresAtMs: clock.nowMs + keepSec * 1000,
        ownerToken: null,
      });
    }) as IdempotencyPort["commit"],
    fail: vi.fn(async (key: string, _e?: string, keepSec = 15 * 60) => {
      records.set(key, {
        status: "failed",
        expiresAtMs: clock.nowMs + keepSec * 1000,
        ownerToken: null,
      });
    }) as IdempotencyPort["fail"],
    release: vi.fn(async (key: string, ownerToken: string) => {
      const existing = records.get(key);
      if (
        !existing ||
        existing.status !== "in_progress" ||
        existing.ownerToken !== ownerToken
      ) {
        // Token mismatch (or terminal record): touch NOTHING.
        return false;
      }
      records.delete(key);
      return true;
    }) as IdempotencyPort["release"],
    get: vi.fn(async () => null) as IdempotencyPort["get"],
    run: vi.fn(async () => {
      throw new Error("run not used by the mutex");
    }) as IdempotencyPort["run"],
    purgeExpired: vi.fn(async () => 0) as IdempotencyPort["purgeExpired"],
  };

  return { port, records };
}

function makeLogger() {
  const error = vi.fn();
  const logger = {
    error,
    warn: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  } as unknown as LoggerPort;
  return { logger, error };
}

describe("withOrderRefundMutex", () => {
  it("builds keys in the dedicated refund-op namespace, disjoint from every use-case prefix", () => {
    const key = buildOrderRefundMutexKey(ORDER_ID);
    expect(key).toBe(`refund-op:${ORDER_ID}`);

    // The refund use cases' OWN idempotency records must never collide with
    // the mutex (refund-full-order's catch fails its own key while the mutex
    // finally releases this one).
    for (const useCasePrefix of [
      "order:refund-full:",
      "order:refund-items:",
      "order:org-refund-items:",
      "event:cancel:",
      "claim:review:",
    ]) {
      expect(key.startsWith(useCasePrefix)).toBe(false);
      expect(useCasePrefix.startsWith("refund-op:")).toBe(false);
    }
  });

  it("runs fn while holding a token-tagged claim and returns its result", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port, records } = createAdapterFaithfulIdempotency(clock);

    const result = await withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      async () => {
        const held = records.get(buildOrderRefundMutexKey(ORDER_ID));
        expect(held?.status).toBe("in_progress");
        // The acquire carried a per-acquire owner token.
        expect(held?.ownerToken).toEqual(expect.any(String));
        expect(held!.expiresAtMs).toBe(
          clock.nowMs + ORDER_REFUND_MUTEX_TTL_SECONDS * 1000,
        );
        return "refund-done";
      },
    );

    expect(result).toBe("refund-done");
    // Owner-checked release deleted the claim outright.
    expect(records.has(buildOrderRefundMutexKey(ORDER_ID))).toBe(false);
  });

  it("throws IDEMPOTENCY_LOCK_IN_PROGRESS and never runs fn when the order is held", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);

    // Op A holds the mutex mid-flight (no release yet).
    await port.begin(
      buildOrderRefundMutexKey(ORDER_ID),
      ORDER_REFUND_MUTEX_TTL_SECONDS,
      "token-a",
    );

    const fn = vi.fn(async () => "never");
    await expect(
      withOrderRefundMutex({ idempotency: port }, ORDER_ID, fn),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
      message: "order_refund_in_progress",
      meta: { orderId: ORDER_ID },
    });
    expect(fn).not.toHaveBeenCalled();
    // A conflicting acquire must NOT attempt to release the holder's key.
    expect(port.release).not.toHaveBeenCalled();
    expect(port.fail).not.toHaveBeenCalled();
  });

  it("release-on-success: the key is immediately re-acquirable (owned release)", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);

    await withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      async () => "ok",
    );

    // No clock advance needed: owner-checked release DELETES the record, so
    // the very next legitimate refund acquires (release ~1s later in prod).
    const second = await withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      async () => "second-refund",
    );
    expect(second).toBe("second-refund");
  });

  it("release-on-failure: fn's error propagates and a retry re-acquires", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);

    const boom = new Error("stripe_refund_failed");
    await expect(
      withOrderRefundMutex({ idempotency: port }, ORDER_ID, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(port.release).toHaveBeenCalledWith(
      buildOrderRefundMutexKey(ORDER_ID),
      expect.any(String),
    );

    const retried = await withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      async () => "retried",
    );
    expect(retried).toBe("retried");
  });

  it("NO OWNERSHIP TOKEN regression: an expired holder's late release must not free the new holder's live lock", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port, records } = createAdapterFaithfulIdempotency(clock);
    const { logger, error } = makeLogger();
    const reportError = vi.fn();
    const key = buildOrderRefundMutexKey(ORDER_ID);

    // Op A acquires, then STALLS past its TTL while still "running".
    let resolveA!: (v: string) => void;
    const gateA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const aDone = withOrderRefundMutex(
      { idempotency: port, logger, reportError },
      ORDER_ID,
      () => gateA,
    );

    // A's claim lapses…
    clock.nowMs += ORDER_REFUND_MUTEX_TTL_SECONDS * 1000 + 1;

    // …and op B legitimately acquires with a NEW token and starts its own
    // external refund work (still in flight below).
    let resolveB!: (v: string) => void;
    const gateB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });
    const bDone = withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      () => gateB,
    );
    // Let B's begin land before A resumes (B's claim is the LIVE one — A's
    // stale record was expired, so a live expiry proves the overwrite).
    await vi.waitFor(() => {
      expect(records.get(key)!.expiresAtMs).toBeGreaterThan(clock.nowMs);
    });
    const bToken = records.get(key)!.ownerToken;
    expect(bToken).toEqual(expect.any(String));

    // A resumes and finishes: its finally runs release with A's STALE token.
    resolveA("a-finished-late");
    await expect(aDone).resolves.toBe("a-finished-late");

    // B's live lock is UNTOUCHED (A's compare-and-release matched nothing)…
    expect(records.get(key)?.ownerToken).toBe(bToken);
    // …so op C still conflicts while B runs — the pre-token bug let C in here.
    await expect(
      withOrderRefundMutex({ idempotency: port }, ORDER_ID, async () => "c"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });

    // A's lost lock is a distinct, reported signal (its work may have raced).
    expect(error).toHaveBeenCalledWith(
      "order_refund_mutex_lock_lost",
      expect.objectContaining({ orderId: ORDER_ID, key }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "order_refund_mutex_lock_lost" }),
      expect.objectContaining({
        tags: { useCase: "withOrderRefundMutex" },
        extra: expect.objectContaining({ orderId: ORDER_ID, key }),
      }),
    );

    // B completes and releases its OWN lock normally.
    resolveB("b-finished");
    await expect(bDone).resolves.toBe("b-finished");
    expect(records.has(key)).toBe(false);
  });

  it("a crashed holder self-expires after the acquisition TTL", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);

    // Op A acquires and crashes (no release ever happens).
    await port.begin(
      buildOrderRefundMutexKey(ORDER_ID),
      ORDER_REFUND_MUTEX_TTL_SECONDS,
      "token-a",
    );

    // Still blocked just before the TTL…
    clock.nowMs += ORDER_REFUND_MUTEX_TTL_SECONDS * 1000 - 1;
    await expect(
      withOrderRefundMutex({ idempotency: port }, ORDER_ID, async () => "x"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });

    // …re-acquirable once it lapses (matches Prisma's `expiresAt <= now`
    // re-acquire rule and Redis's EX expiry).
    clock.nowMs += 2;
    const out = await withOrderRefundMutex(
      { idempotency: port },
      ORDER_ID,
      async () => "recovered",
    );
    expect(out).toBe("recovered");
  });

  it("a throwing release never masks fn's outcome and is logged + reported", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);
    const releaseError = new Error("db_down_during_release");
    (port.release as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      releaseError,
    );

    const { logger, error } = makeLogger();
    const reportError = vi.fn();

    const result = await withOrderRefundMutex(
      { idempotency: port, logger, reportError },
      ORDER_ID,
      async () => "still-succeeds",
    );

    expect(result).toBe("still-succeeds");
    expect(error).toHaveBeenCalledWith(
      "order_refund_mutex_release_failed",
      expect.objectContaining({ orderId: ORDER_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      releaseError,
      expect.objectContaining({
        tags: { useCase: "withOrderRefundMutex" },
      }),
    );
  });

  it("a THROWING REPORTER in the release swallow never propagates into the caller", async () => {
    const clock = { nowMs: 1_000_000 };
    const { port } = createAdapterFaithfulIdempotency(clock);
    (port.release as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db_down_during_release"),
    );

    // Both the logger AND the reporter blow up — the completed refund must
    // still come back as a success (helper contract holds standalone, without
    // relying on the composition roots' safeReporter).
    const logger = {
      error: vi.fn(() => {
        throw new Error("logger_exploded");
      }),
      warn: vi.fn(),
      info: vi.fn(),
      child: vi.fn(),
    } as unknown as LoggerPort;
    const reportError = vi.fn(() => {
      throw new Error("sentry_exploded");
    });

    await expect(
      withOrderRefundMutex(
        { idempotency: port, logger, reportError },
        ORDER_ID,
        async () => "refund-completed",
      ),
    ).resolves.toBe("refund-completed");
    expect(reportError).toHaveBeenCalled();

    // Same guarantee on the lock-lost arm: release returns false and the
    // reporter throws — still no propagation. Fresh port: the failed release
    // above correctly left the previous claim held until its TTL.
    const second = createAdapterFaithfulIdempotency(clock);
    (second.port.release as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false,
    );
    await expect(
      withOrderRefundMutex(
        { idempotency: second.port, logger, reportError },
        ORDER_ID,
        async () => "refund-completed-2",
      ),
    ).resolves.toBe("refund-completed-2");
  });
});

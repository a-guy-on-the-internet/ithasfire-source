import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  DEFAULT_TX_MAX_WAIT_MS,
  DEFAULT_TX_TIMEOUT_MS,
  createPrismaRepos,
  resolveTxOptions,
} from "../index";

/**
 * Per-call transaction timeout (booking-accept spec 2026-09-05, P-3).
 *
 * Pins three things about `repos.tx(fn, options?)`:
 *   1. With no options the `$transaction` options object is byte-for-byte
 *      the historical `{ maxWait: 10_000, timeout: 30_000 }` — the default
 *      is unchanged for every existing one-arg caller.
 *   2. A per-call `timeout` / `maxWait` reaches `$transaction`, and each
 *      falls back to its own default independently.
 *   3. Non-finite / zero / negative values throw a `RangeError` before
 *      `$transaction` is touched — never clamped.
 *
 * Pure unit test: `$transaction` is a stub, no database.
 */

type TxCall = [fn: (tx: unknown) => Promise<unknown>, opts: unknown];

function stubPrisma() {
  const txClient = {};
  const $transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) =>
      fn(txClient),
  );
  // Only $transaction is exercised; makeTxRepos just closes over the client
  // and never touches a model at construction time.
  const prisma = { $transaction } as unknown as PrismaClient;
  return { prisma, $transaction, txClient };
}

function lastTxOptions($transaction: ReturnType<typeof vi.fn>) {
  const calls = $transaction.mock.calls as unknown as TxCall[];
  return calls[calls.length - 1]?.[1];
}

describe("createPrismaRepos().tx — per-call options", () => {
  it("default is unchanged: no options → { maxWait: 10000, timeout: 30000 }", async () => {
    const { prisma, $transaction } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    const result = await repos.tx(async () => "ok");

    expect(result).toBe("ok");
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(lastTxOptions($transaction)).toEqual({
      maxWait: 10_000,
      timeout: 30_000,
    });
    expect(DEFAULT_TX_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_TX_MAX_WAIT_MS).toBe(10_000);
  });

  it("an empty options object behaves exactly like no options", async () => {
    const { prisma, $transaction } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    await repos.tx(async () => undefined, {});

    expect(lastTxOptions($transaction)).toEqual({
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  it("{ timeout: 45_000 } reaches $transaction with maxWait at its default", async () => {
    const { prisma, $transaction } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    await repos.tx(async () => undefined, { timeout: 45_000 });

    expect(lastTxOptions($transaction)).toEqual({
      maxWait: 10_000,
      timeout: 45_000,
    });
  });

  it("{ maxWait } is independent of timeout", async () => {
    const { prisma, $transaction } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    await repos.tx(async () => undefined, { maxWait: 2_500 });

    expect(lastTxOptions($transaction)).toEqual({
      maxWait: 2_500,
      timeout: 30_000,
    });
  });

  it("hands the callback a TxRepos built from the transaction client", async () => {
    const { prisma } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    const seen = await repos.tx(async (tx) => Object.keys(tx));

    // Sanity: the tx-scoped repos object has the same shape as the outer one
    // minus `tx` itself.
    expect(seen).not.toContain("tx");
    expect(seen).toContain("events");
    expect(seen).toContain("audit");
  });

  it.each([
    ["timeout: 0", { timeout: 0 }],
    ["timeout: negative", { timeout: -1 }],
    ["timeout: NaN", { timeout: Number.NaN }],
    ["timeout: Infinity", { timeout: Number.POSITIVE_INFINITY }],
    ["maxWait: 0", { maxWait: 0 }],
    ["maxWait: negative", { maxWait: -5 }],
    ["maxWait: NaN", { maxWait: Number.NaN }],
  ])("rejects %s with a RangeError and never opens a transaction", async (_label, options) => {
    const { prisma, $transaction } = stubPrisma();
    const repos = createPrismaRepos(prisma);
    const fn = vi.fn(async () => undefined);

    await expect(repos.tx(fn, options)).rejects.toThrow(RangeError);
    expect($transaction).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not swallow errors thrown inside the callback (979840b4 posture)", async () => {
    const { prisma } = stubPrisma();
    const repos = createPrismaRepos(prisma);

    await expect(
      repos.tx(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("resolveTxOptions", () => {
  it("fills each missing field from its own default", () => {
    expect(resolveTxOptions()).toEqual({ timeout: 30_000, maxWait: 10_000 });
    expect(resolveTxOptions({ timeout: 1 })).toEqual({
      timeout: 1,
      maxWait: 10_000,
    });
    expect(resolveTxOptions({ maxWait: 1 })).toEqual({
      timeout: 30_000,
      maxWait: 1,
    });
  });

  it("names the offending field in the error", () => {
    expect(() => resolveTxOptions({ timeout: 0 })).toThrow(/timeout/);
    expect(() => resolveTxOptions({ maxWait: -1 })).toThrow(/maxWait/);
  });
});

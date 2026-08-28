import { describe, expect, it, vi } from "vitest";

import { purgeExpiredIdempotency } from "../jobs/idempotency";

/**
 * The job is a bounded drain loop over `IdempotencyPort.purgeExpired`. These
 * cover the loop's contract; the SQL itself is covered against a real Postgres
 * in `packages/adapters/src/idempotency/__tests__/prisma-adapter.test.ts`.
 */
const makeCtx = (purgeExpired: ReturnType<typeof vi.fn>) => {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_l: string, fn: () => Promise<unknown>) => fn()),
  };
  return { ctx: { idempotency: { purgeExpired }, logger }, logger };
};

const run = async (ctx: unknown, input: Record<string, unknown> = {}) =>
  (await purgeExpiredIdempotency.handler({
    input: input as never,
    ctx: ctx as never,
  })) as { deleted: number; passes: number; drained: boolean };

describe("idempotency.purge-expired", () => {
  it("stops after one pass when the backend returns a short batch", async () => {
    const purgeExpired = vi.fn(async () => 12);
    const { ctx } = makeCtx(purgeExpired);

    const result = await run(ctx, { batch: 100 });

    expect(result).toEqual({ deleted: 12, passes: 1, drained: true });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(purgeExpired).toHaveBeenCalledWith(100);
  });

  it("keeps draining while each pass comes back full", async () => {
    // Two full batches, then a short one.
    const purgeExpired = vi
      .fn()
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(7);
    const { ctx } = makeCtx(purgeExpired);

    const result = await run(ctx, { batch: 50 });

    expect(result).toEqual({ deleted: 107, passes: 3, drained: true });
  });

  it("is a no-op against a backend that expires its own records", async () => {
    // The Redis adapter returns 0 — one pass, nothing deleted, no warning.
    const purgeExpired = vi.fn(async () => 0);
    const { ctx, logger } = makeCtx(purgeExpired);

    const result = await run(ctx);

    expect(result).toEqual({ deleted: 0, passes: 1, drained: true });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("caps the loop and warns rather than spinning forever", async () => {
    // Pathological adapter: always reports a full batch.
    const purgeExpired = vi.fn(async () => 10);
    const { ctx, logger } = makeCtx(purgeExpired);

    const result = await run(ctx, { batch: 10 });

    expect(result.drained).toBe(false);
    expect(result.passes).toBe(100);
    expect(result.deleted).toBe(1000);
    expect(purgeExpired).toHaveBeenCalledTimes(100);
    expect(logger.warn).toHaveBeenCalledWith(
      "idempotency.purge-expired.cap_reached",
      expect.objectContaining({ deleted: 1000, batch: 10 }),
    );
  });
});

/**
 * tickets.expire-resale-listings: the stale-hold sweep (G1 backstop) is
 * wired with the job context's reporter, so a paid order on a HELD listing,
 * a HELD listing with no hold, or a failed release reaches Sentry.
 */
import { describe, it, expect, vi } from "vitest";

import { ticketJobs } from "../jobs/tickets";

describe("expire-resale-listings job", () => {
  const job = ticketJobs.find(
    (j) => j.name === "tickets.expire-resale-listings",
  )!;

  it("is registered in ticketJobs", () => {
    expect(job).toBeDefined();
  });

  it("runs the sweep inside a transaction and hands its failures to ctx.reportError", async () => {
    const heldUntil = new Date("2026-01-01T00:00:00.000Z");
    const resaleListings = {
      listExpiredHolds: vi.fn(async () => [
        { listingId: "listing-1", buyerHumanId: "buyer-1", heldUntil },
      ]),
      listHeldWithoutHold: vi.fn(async () => []),
      lockHold: vi.fn(async () => {
        throw new Error("lock_timeout");
      }),
      expireStale: vi.fn(async () => ({ expiredCount: 0 })),
    };
    const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn({ resaleListings, audit: { log: vi.fn() } }),
    );
    const reportError = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const jobCursors = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
    const ctx = {
      repos: { resaleListings, tx, jobCursors },
      clock: { now: () => new Date("2026-03-10T12:00:00.000Z") },
      logger,
      reportError,
    };

    const result = await job.handler({ input: {} as never, ctx: ctx as never });

    expect(tx).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failedHoldCount: 1, expiredCount: 0 });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "lock_timeout" }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "expireResaleListings" }),
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import type { RequeueDegradedModerationsInput } from "@th/ports/repos/image-moderation-records";

import {
  requeueDegradedModerations,
  type RequeueDegradedModerationsDeps,
} from "../requeue-degraded-moderations";

const NOW = new Date("2026-08-20T18:00:00.000Z");

function makeLogger() {
  return {
    child: vi.fn(function () {
      return this;
    }),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeDeps(count = 0): {
  deps: RequeueDegradedModerationsDeps;
  requeueDegraded: ReturnType<typeof vi.fn>;
} {
  const requeueDegraded = vi.fn(
    async (_input: RequeueDegradedModerationsInput) => count,
  );
  const deps: RequeueDegradedModerationsDeps = {
    repos: { imageModerationRecords: { requeueDegraded } } as any,
    clock: { now: () => NOW } as any,
    logger: makeLogger(),
  };
  return { deps, requeueDegraded };
}

describe("requeueDegradedModerations", () => {
  it("passes the requeue cap through so unscannable rows stop cycling", async () => {
    // The churn guard. Without a cap, a row whose R2 object is gone would be
    // revived, burn the whole retry window, dead-letter, and be revived again
    // forever — which is exactly what a manual requeue did on 2026-08-20.
    const { deps, requeueDegraded } = makeDeps(2);

    const out = await requeueDegradedModerations(deps, { maxRequeues: 3 });

    expect(out).toEqual({ requeued: 2 });
    expect(requeueDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequeues: 3 }),
    );
  });

  it("only considers rows that dead-lettered before now minus minAgeMinutes", async () => {
    // Keeps this job from fighting the drain over a row still inside its own
    // retry window — a row that dead-lettered a minute ago is not stuck yet.
    const { deps, requeueDegraded } = makeDeps();

    await requeueDegradedModerations(deps, { minAgeMinutes: 15 });

    expect(requeueDegraded).toHaveBeenCalledWith(
      expect.objectContaining({
        now: NOW,
        moderatedBefore: new Date("2026-08-20T17:45:00.000Z"),
      }),
    );
  });

  it("applies defaults when called with no input at all (the scheduled path)", async () => {
    const { deps, requeueDegraded } = makeDeps();

    await requeueDegradedModerations(deps);

    expect(requeueDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequeues: 3, limit: 200 }),
    );
    // 15-minute default age → 17:45.
    expect(requeueDegraded.mock.calls[0]![0].moderatedBefore).toEqual(
      new Date("2026-08-20T17:45:00.000Z"),
    );
  });

  it("does not log when nothing was requeued", async () => {
    // A quiet system should be quiet — an hourly job logging "0" forever is how
    // a real signal gets ignored.
    const { deps } = makeDeps(0);

    await requeueDegradedModerations(deps);

    expect(deps.logger.child().info).not.toHaveBeenCalled();
  });

  it("rejects a zero requeue cap rather than silently disabling the job", async () => {
    // maxRequeues 0 would make `requeues < 0` match nothing — a job that runs
    // hourly and can never do anything. Fail loudly at the boundary instead.
    const { deps } = makeDeps();

    await expect(
      requeueDegradedModerations(deps, { maxRequeues: 0 }),
    ).rejects.toBeDefined();
  });

  it("holds no eligibility logic of its own — the repo WHERE is the only gate", async () => {
    // Guards the design property that makes this safe: the use case cannot
    // widen the selection, because it does not build one. It forwards four
    // scheduling parameters and nothing else. If someone adds a status or
    // degraded flag here, this assertion should fail and force a rethink.
    const { deps, requeueDegraded } = makeDeps(1);

    await requeueDegradedModerations(deps, {});

    expect(Object.keys(requeueDegraded.mock.calls[0]![0]).sort()).toEqual([
      "limit",
      "maxRequeues",
      "moderatedBefore",
      "now",
    ]);
  });
});

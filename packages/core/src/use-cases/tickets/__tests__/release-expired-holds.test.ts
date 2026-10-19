import { describe, expect, it, vi } from "vitest";

import { releaseExpiredSeatHolds } from "../release-expired-holds";
import type { ReleaseExpiredSeatHoldsDeps } from "../release-expired-holds";
import type { Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const NOW = new Date("2025-02-01T12:00:00.000Z");

function makeDeps() {
  const releaseExpiredHolds = vi.fn(async () => 3);
  const repos: Pick<Repos, "seats"> = {
    seats: {
      releaseExpiredHolds:
        releaseExpiredHolds as Repos["seats"]["releaseExpiredHolds"],
      findByIdsForUpdate: vi.fn(),
      updateStatuses: vi.fn(),
      reserveForHold: vi.fn(),
      releaseSeats: vi.fn(),
      listByEvent: vi.fn(),
      listAvailableBySection: vi.fn(),
      getSectionById: vi.fn(),
      listSectionsByEvent: vi.fn(),
      materializeSections: vi.fn(),
    },
  };

  const deps: ReleaseExpiredSeatHoldsDeps = {
    repos,
    clock: { now: () => NOW },
    logger: createTestLogger(),
  };

  return { deps, releaseExpiredHolds };
}

describe("releaseExpiredSeatHolds", () => {
  it("releases expired holds using the default TTL", async () => {
    const ctx = makeDeps();

    const result = await releaseExpiredSeatHolds(ctx.deps, {});

    expect(result).toEqual({ releasedCount: 3 });
    expect(ctx.releaseExpiredHolds).toHaveBeenCalledWith(
      expect.objectContaining({
        releasedAt: NOW,
        before: new Date(NOW.getTime() - 900 * 1000),
      }),
    );
  });

  it("supports custom ttl and limit", async () => {
    const ctx = makeDeps();

    const result = await releaseExpiredSeatHolds(ctx.deps, {
      ttlSeconds: 120,
      limit: 50,
    });

    expect(result.releasedCount).toBe(3);
    expect(ctx.releaseExpiredHolds).toHaveBeenCalledWith(
      expect.objectContaining({
        releasedAt: NOW,
        before: new Date(NOW.getTime() - 120 * 1000),
        limit: 50,
      }),
    );
  });
});

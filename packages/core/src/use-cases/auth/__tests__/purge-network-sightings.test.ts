import { describe, expect, it, vi } from "vitest";

import { purgeNetworkSightings } from "../purge-network-sightings";

const NOW = new Date("2026-09-29T05:50:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeDeps() {
  const purgeOlderThan = vi.fn(async () => ({ count: 7 }));
  const purgeExpired = vi.fn(async () => ({ count: 2 }));
  const clearSubmitterIpHashesBefore = vi.fn(async () => ({ count: 3 }));
  return {
    deps: {
      repos: {
        networkSightings: { purgeOlderThan },
        bans: { purgeExpired },
        eventEditSuggestions: { clearSubmitterIpHashesBefore },
      },
      clock: { now: () => NOW },
    } as unknown as Parameters<typeof purgeNetworkSightings>[0],
    purgeOlderThan,
    purgeExpired,
    clearSubmitterIpHashesBefore,
  };
}

describe("purgeNetworkSightings", () => {
  it("deletes sightings older than 30 days and ban rows already expired", async () => {
    const { deps, purgeOlderThan, purgeExpired, clearSubmitterIpHashesBefore } =
      makeDeps();

    const result = await purgeNetworkSightings(deps, {});

    expect(purgeOlderThan).toHaveBeenCalledWith({
      before: new Date(NOW.getTime() - 30 * DAY),
    });
    expect(purgeExpired).toHaveBeenCalledWith({ before: NOW });
    expect(clearSubmitterIpHashesBefore).toHaveBeenCalledWith({
      before: new Date(NOW.getTime() - 30 * DAY),
    });
    expect(result).toEqual({
      sightingsDeleted: 7,
      expiredBansDeleted: 2,
      suggestionIpHashesCleared: 3,
      cutoff: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    });
  });

  it("accepts a shorter window but never a longer one", async () => {
    const { deps, purgeOlderThan } = makeDeps();
    await purgeNetworkSightings(deps, { retentionDays: 7 });
    expect(purgeOlderThan).toHaveBeenCalledWith({
      before: new Date(NOW.getTime() - 7 * DAY),
    });
    await expect(
      purgeNetworkSightings(deps, { retentionDays: 31 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

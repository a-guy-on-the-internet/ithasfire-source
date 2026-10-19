import { describe, expect, it } from "vitest";

import type { HumanStatsRecord } from "@th/types/repos/human-stats";
import {
  MIN_SHOWS_FOR_STATS,
  buildPerformerStatsBlockData,
  isPerformerStatsEligible,
  toPublicStatsSnapshot,
  toVerifiedStatsSnapshot,
} from "./performer-stats";

function buildStats(overrides: Partial<HumanStatsRecord> = {}): HumanStatsRecord {
  return {
    id: "stats-1",
    humanId: "human-1",
    totalEventsPerformed: 5,
    totalTicketsAttributed: 120,
    avgDrawPerEvent: 24,
    topCities: [
      { city: "Nashville", state: "TN", country: "US", tickets: 80 },
    ],
    topPlaceIds: ["place-1"],
    topGenres: ["indie"],
    channelBreakdown: [
      { source: "checkout_select", tickets: 60 },
      { source: "ref_link", tickets: 45 },
      { source: "direct", tickets: 15 },
    ],
    totalConsentedFans: 30,
    repeatFanCount: 8,
    followerCount: 200,
    last90DayTickets: 40,
    last90DayEvents: 2,
    computedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("isPerformerStatsEligible", () => {
  it("MIN_SHOWS_FOR_STATS is 3", () => {
    expect(MIN_SHOWS_FOR_STATS).toBe(3);
  });

  it("false below the threshold, true at/above", () => {
    expect(isPerformerStatsEligible(null)).toBe(false);
    expect(isPerformerStatsEligible({ totalEventsPerformed: 0 })).toBe(false);
    expect(isPerformerStatsEligible({ totalEventsPerformed: 2 })).toBe(false);
    expect(isPerformerStatsEligible({ totalEventsPerformed: 3 })).toBe(true);
    expect(isPerformerStatsEligible({ totalEventsPerformed: 9 })).toBe(true);
  });
});

describe("toPublicStatsSnapshot", () => {
  it("extracts the ref_link ticket total when present", () => {
    const snapshot = toPublicStatsSnapshot(buildStats());
    expect(snapshot.refLinkTickets).toBe(45);
  });

  it("returns 0 refLinkTickets when the channel is absent", () => {
    const snapshot = toPublicStatsSnapshot(
      buildStats({
        channelBreakdown: [{ source: "direct", tickets: 10 }],
      }),
    );
    expect(snapshot.refLinkTickets).toBe(0);
  });

  it("returns 0 refLinkTickets when channelBreakdown is null", () => {
    const snapshot = toPublicStatsSnapshot(
      buildStats({ channelBreakdown: null }),
    );
    expect(snapshot.refLinkTickets).toBe(0);
  });

  it("NEVER leaks non-whitelisted fields (topCities/topPlaceIds/topGenres/channelBreakdown/followerCount/totalConsentedFans)", () => {
    const snapshot = toPublicStatsSnapshot(buildStats());
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "avgDrawPerEvent",
        "last90DayEvents",
        "last90DayTickets",
        "refLinkTickets",
        "repeatFanCount",
        "totalEventsPerformed",
      ].sort(),
    );
    expect(snapshot).not.toHaveProperty("topCities");
    expect(snapshot).not.toHaveProperty("topPlaceIds");
    expect(snapshot).not.toHaveProperty("topGenres");
    expect(snapshot).not.toHaveProperty("channelBreakdown");
    expect(snapshot).not.toHaveProperty("followerCount");
    expect(snapshot).not.toHaveProperty("totalConsentedFans");
  });

  it("zeroes a null aggregate", () => {
    expect(toPublicStatsSnapshot(null)).toEqual({
      totalEventsPerformed: 0,
      avgDrawPerEvent: null,
      repeatFanCount: 0,
      refLinkTickets: 0,
      last90DayTickets: 0,
      last90DayEvents: 0,
    });
  });
});

describe("buildPerformerStatsBlockData", () => {
  it("marks a thin performer ineligible with a null computedAt", () => {
    const data = buildPerformerStatsBlockData(null);
    expect(data.eligible).toBe(false);
    expect(data.computedAt).toBeNull();
    expect(data.metrics.totalEventsPerformed).toBe(0);
  });

  it("marks an eligible performer with ISO computedAt + whitelisted metrics", () => {
    const data = buildPerformerStatsBlockData(buildStats());
    expect(data.eligible).toBe(true);
    expect(data.computedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(data.metrics.refLinkTickets).toBe(45);
    expect(data.metrics).not.toHaveProperty("topCities");
  });

  it("eligible:false but real metrics for a 2-show performer", () => {
    const data = buildPerformerStatsBlockData(
      buildStats({ totalEventsPerformed: 2 }),
    );
    expect(data.eligible).toBe(false);
    expect(data.metrics.totalEventsPerformed).toBe(2);
  });
});

describe("toVerifiedStatsSnapshot", () => {
  it("is the whitelisted metrics plus the source computedAt", () => {
    const snapshot = toVerifiedStatsSnapshot(buildStats());
    expect(snapshot).toEqual({
      totalEventsPerformed: 5,
      avgDrawPerEvent: 24,
      repeatFanCount: 8,
      refLinkTickets: 45,
      last90DayTickets: 40,
      last90DayEvents: 2,
      computedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});

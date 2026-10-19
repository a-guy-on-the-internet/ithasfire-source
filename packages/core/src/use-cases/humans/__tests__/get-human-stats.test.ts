import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { HumansRepo } from "@th/ports/repos/humans";
import type { HumanStatsRepo } from "@th/ports/repos/human-stats";
import type { Repos } from "@th/ports/repos";

import { getHumanStats, type GetHumanStatsDeps } from "../get-human-stats";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const BASE_HUMAN = {
  id: HUMAN_ID,
  name: "Ada",
  status: "ACTIVE" as const,
  roles: ["USER"],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  jobs: [],
  genreTags: [],
  otherJobDescription: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const BASE_STATS = {
  id: "44444444-4444-4444-8444-444444444444",
  humanId: HUMAN_ID,
  totalEventsPerformed: 12,
  totalTicketsAttributed: 340,
  avgDrawPerEvent: 28.3,
  topCities: [{ city: "Austin", country: "US", tickets: 120 }],
  topPlaceIds: ["55555555-5555-4555-8555-555555555555"],
  topGenres: ["rock", "indie"],
  channelBreakdown: [{ source: "instagram", tickets: 80 }],
  totalConsentedFans: 190,
  repeatFanCount: 42,
  followerCount: 88,
  last90DayTickets: 96,
  last90DayEvents: 4,
  computedAt: new Date("2026-04-15T00:00:00.000Z"),
};

function makeDeps(overrides?: {
  targetHuman?: typeof BASE_HUMAN | null;
  actorHuman?: typeof BASE_HUMAN | null;
  stats?: typeof BASE_STATS | null;
  staffAllowed?: boolean;
}): GetHumanStatsDeps {
  const targetHuman =
    overrides && "targetHuman" in overrides
      ? overrides.targetHuman
      : BASE_HUMAN;
  const actorHuman =
    overrides && "actorHuman" in overrides ? overrides.actorHuman : undefined;
  const stats =
    overrides && "stats" in overrides ? overrides.stats : BASE_STATS;
  const staffAllowed = overrides?.staffAllowed ?? false;

  const humans = {
    getById: vi.fn(async (id: string) => {
      if (id === HUMAN_ID) return targetHuman;
      if (id === ADMIN_ID)
        return actorHuman ?? { ...BASE_HUMAN, id: ADMIN_ID, roles: ["ADMIN"] };
      if (id === OTHER_ID)
        return actorHuman ?? { ...BASE_HUMAN, id: OTHER_ID, roles: ["USER"] };
      return null;
    }),
    getByIdWithIdentity: vi.fn(),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    batchLookupHumanIdsByEmail: vi.fn(),
    searchByQuery: vi.fn(),
    getHumanTrustStats: vi.fn(),
    updateJobs: vi.fn(),
  } as unknown as HumansRepo;

  const humanStats = {
    upsert: vi.fn(),
    findByHumanId: vi.fn(async () => stats),
  } as unknown as HumanStatsRepo;

  const repos: Repos = {
    humans,
    humanStats,
    audit: {} as any,
    tx: async () => {
      throw new Error("unexpected tx call");
    },
  } as unknown as Repos;

  const authz: Pick<AuthZPort, "hasStaffRole"> = {
    hasStaffRole: vi.fn(async () => ({ allowed: staffAllowed })),
  };

  return { repos, authz };
}

describe("getHumanStats", () => {
  it("returns the materialized stats for self access", async () => {
    const deps = makeDeps();

    const result = await getHumanStats(deps, {
      actorHumanId: HUMAN_ID,
      humanId: HUMAN_ID,
    });

    expect(result.humanId).toBe(HUMAN_ID);
    expect(result.totalTicketsAttributed).toBe(340);
    expect(result.topCities).toEqual([
      { city: "Austin", country: "US", tickets: 120 },
    ]);
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("phoneMasked");
  });

  it("allows platform admin access", async () => {
    const deps = makeDeps({
      actorHuman: { ...BASE_HUMAN, id: ADMIN_ID, roles: ["ADMIN"] },
      staffAllowed: true,
    });

    const result = await getHumanStats(deps, {
      actorHumanId: ADMIN_ID,
      humanId: HUMAN_ID,
    });

    expect(result.followerCount).toBe(88);
  });

  it("rejects non-staff access to another human", async () => {
    const deps = makeDeps({
      actorHuman: { ...BASE_HUMAN, id: OTHER_ID, roles: ["USER"] },
    });

    await expect(
      getHumanStats(deps, {
        actorHumanId: OTHER_ID,
        humanId: HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("does not reveal target existence to non-staff actors", async () => {
    const deps = makeDeps({
      targetHuman: null,
      actorHuman: { ...BASE_HUMAN, id: OTHER_ID, roles: ["USER"] },
    });

    await expect(
      getHumanStats(deps, {
        actorHumanId: OTHER_ID,
        humanId: HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("returns a zeroed stats payload when no materialized stats exist", async () => {
    const deps = makeDeps({ stats: null });

    const result = await getHumanStats(deps, {
      actorHumanId: HUMAN_ID,
      humanId: HUMAN_ID,
    });

    expect(result).toMatchObject({
      id: HUMAN_ID,
      humanId: HUMAN_ID,
      totalEventsPerformed: 0,
      totalTicketsAttributed: 0,
      avgDrawPerEvent: null,
      topCities: null,
      topPlaceIds: null,
      topGenres: null,
      channelBreakdown: null,
      totalConsentedFans: 0,
      repeatFanCount: 0,
      followerCount: 0,
      last90DayTickets: 0,
      last90DayEvents: 0,
      computedAt: new Date(0),
    });
  });

  it("returns not_found when the target human does not exist", async () => {
    const deps = makeDeps({ targetHuman: null });

    await expect(
      getHumanStats(deps, {
        actorHumanId: HUMAN_ID,
        humanId: HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });
});

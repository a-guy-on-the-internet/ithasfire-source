import { describe, expect, it, vi } from "vitest";

import type { AuthNPort } from "@th/ports/authn";
import type { AuthZPort } from "@th/ports/authz";
import type { OrgStatsRepo } from "@th/ports/repos/org-stats";
import type { OrganizationsRepo } from "@th/ports/repos/organizations";
import type { Repos } from "@th/ports/repos";

import { getOrgStats, type GetOrgStatsDeps } from "./get-org-stats";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const BASE_ORG = {
  id: ORG_ID,
  name: "Indie Nights",
  slug: "indie-nights",
  status: "ACTIVE" as const,
  defaultLocale: null,
  contactEmail: null,
  physicalAddress: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const BASE_STATS = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: ORG_ID,
  totalEventsOrganized: 15,
  totalTicketsSold: 1200,
  totalVenues: 6,
  avgTicketsPerEvent: 80,
  topPlaceIds: ["44444444-4444-4444-8444-444444444444"],
  topArtistHumanIds: ["55555555-5555-4555-8555-555555555555"],
  uniqueAttendees: 840,
  repeatAttendees: 210,
  attributionSummary: [
    {
      eventId: "66666666-6666-4666-8666-666666666666",
      attributed: 55,
      walkIn: 20,
    },
  ],
  topGenres: ["house", "techno"],
  followerCount: 320,
  last90DayTickets: 410,
  last90DayEvents: 5,
  computedAt: new Date("2026-04-15T00:00:00.000Z"),
};

function makeDeps(overrides?: {
  authzError?: unknown;
  org?: typeof BASE_ORG | null;
  stats?: typeof BASE_STATS | null;
}): GetOrgStatsDeps & { authn: AuthNPort } {
  const org = overrides && "org" in overrides ? overrides.org : BASE_ORG;
  const stats =
    overrides && "stats" in overrides ? overrides.stats : BASE_STATS;

  const organizations = {
    getById: vi.fn(async () => org),
  } as unknown as OrganizationsRepo;

  const orgStats = {
    upsert: vi.fn(),
    findByOrgId: vi.fn(async () => stats),
  } as unknown as OrgStatsRepo;

  const repos = {
    organizations,
    orgStats,
  } as unknown as Repos;

  const authn: AuthNPort = {
    ensureAuthedHuman: vi.fn(async () => ({ humanId: ACTOR_ID })),
    ensureAuthedHumanFromApiKey: vi.fn(),
    getProviderUserId: vi.fn(),
  };

  const authz: AuthZPort = {
    hasOrgRole: vi.fn(),
    requireOrgRole: overrides?.authzError
      ? vi.fn(async () => {
          throw overrides.authzError;
        })
      : vi.fn(async () => undefined),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  };

  return { repos, authn, authz };
}

describe("getOrgStats", () => {
  it("returns materialized org stats for an authorized member", async () => {
    const deps = makeDeps();

    const result = await getOrgStats(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.orgId).toBe(ORG_ID);
    expect(result.totalTicketsSold).toBe(1200);
    expect(result.topGenres).toEqual(["house", "techno"]);
    expect(deps.authn.ensureAuthedHuman).not.toHaveBeenCalled();
    expect(deps.authz.requireOrgRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      requiredRoles: expect.any(Array),
    });
  });

  it("rejects actors who are not org members", async () => {
    const deps = makeDeps({
      authzError: { code: "forbidden", message: "insufficient_org_role" },
    });

    await expect(
      getOrgStats(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns not_found when the org does not exist", async () => {
    const deps = makeDeps({ org: null });

    await expect(
      getOrgStats(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
  });

  it("returns a zeroed stats payload when the org stats are missing", async () => {
    const deps = makeDeps({ stats: null });

    const result = await getOrgStats(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result).toMatchObject({
      id: ORG_ID,
      orgId: ORG_ID,
      totalEventsOrganized: 0,
      totalTicketsSold: 0,
      totalVenues: 0,
      avgTicketsPerEvent: null,
      topPlaceIds: null,
      topArtistHumanIds: null,
      uniqueAttendees: 0,
      repeatAttendees: 0,
      attributionSummary: null,
      topGenres: null,
      followerCount: 0,
      last90DayTickets: 0,
      last90DayEvents: 0,
      computedAt: new Date(0),
    });
  });
});

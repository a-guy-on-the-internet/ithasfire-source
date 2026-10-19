import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { OrgDashboardSummary } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  getOrgDashboardStats,
  type GetOrgDashboardStatsDeps,
} from "../get-org-dashboard-stats";

// ── Fixtures ───────────────────────────────────────────────────────────────

const ACTOR_ID = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "cccc0000-cccc-4ccc-8ccc-cccccccccccc";

function makeOrgMembership(role = "EDITOR" as const): OrgMembership {
  return {
    orgId: ORG_ID,
    humanId: ACTOR_ID,
    role,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  } as OrgMembership;
}

function makeSummary(
  overrides: Partial<OrgDashboardSummary> = {},
): OrgDashboardSummary {
  return {
    totalGrossRevenueCents: 100_000,
    totalNetRevenueCents: 90_000,
    totalTicketsSold: 50,
    averageSellThroughRate: 0.75,
    totalRefundedCents: 5_000,
    refundRate: 0.05,
    eventCount: 3,
    ...overrides,
  };
}

// ── Deps factory ───────────────────────────────────────────────────────────

function createDeps(overrides?: {
  membership?: OrgMembership | null;
  summary?: OrgDashboardSummary;
}) {
  const membership =
    overrides?.membership !== undefined
      ? overrides.membership
      : makeOrgMembership();
  const summary = overrides?.summary ?? makeSummary();

  const repos = {
    authz: {
      getOrgMembership: vi.fn(async () => membership),
    },
    analytics: {
      getOrgDashboardSummary: vi.fn(async () => summary),
    },
  } as unknown as Repos;

  const logger = createTestLogger();
  const deps: GetOrgDashboardStatsDeps = { repos, logger };

  return { deps, repos };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getOrgDashboardStats", () => {
  it("returns the org dashboard summary for an authorized member", async () => {
    const expected = makeSummary();
    const { deps, repos } = createDeps({ summary: expected });

    const result = await getOrgDashboardStats(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result).toEqual(expected);
    expect(repos.analytics.getOrgDashboardSummary).toHaveBeenCalledWith(ORG_ID);
  });

  it("throws forbidden when actor is not an org member", async () => {
    const { deps } = createDeps({ membership: null });

    await expect(
      getOrgDashboardStats(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toThrow();
  });

  it("throws on invalid input (bad UUID)", async () => {
    const { deps } = createDeps();

    await expect(
      getOrgDashboardStats(deps, {
        actorHumanId: "not-a-uuid",
        orgId: ORG_ID,
      }),
    ).rejects.toThrow();
  });

  it("returns zero-value summary when org has no events with stats", async () => {
    const zeroSummary = makeSummary({
      totalGrossRevenueCents: 0,
      totalNetRevenueCents: 0,
      totalTicketsSold: 0,
      averageSellThroughRate: 0,
      totalRefundedCents: 0,
      refundRate: 0,
      eventCount: 0,
    });
    const { deps } = createDeps({ summary: zeroSummary });

    const result = await getOrgDashboardStats(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.eventCount).toBe(0);
    expect(result.totalGrossRevenueCents).toBe(0);
    expect(result.averageSellThroughRate).toBe(0);
  });
});

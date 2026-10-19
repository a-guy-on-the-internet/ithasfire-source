import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgDashboardSummary } from "@th/types";
import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";

// ── Schemas ────────────────────────────────────────────────────────────────

export const getOrgDashboardStatsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
});

export const getOrgDashboardStatsOutputSchema = z.object({
  totalGrossRevenueCents: z.number(),
  totalNetRevenueCents: z.number(),
  totalTicketsSold: z.number(),
  averageSellThroughRate: z.number(),
  totalRefundedCents: z.number(),
  refundRate: z.number(),
  eventCount: z.number(),
});

export type GetOrgDashboardStatsInput = z.infer<
  typeof getOrgDashboardStatsInputSchema
>;
export type GetOrgDashboardStatsOutput = OrgDashboardSummary;

export type GetOrgDashboardStatsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Returns an aggregated dashboard summary for an organization: total revenue,
 * tickets sold, average sell-through rate, refund rate, and event count.
 *
 * Reads from the latest EventDailyStats row per event owned by the org.
 * RBAC-checked: actor must be an org member with at least EDITOR role.
 */
export async function getOrgDashboardStats(
  deps: GetOrgDashboardStatsDeps,
  rawInput: unknown,
): Promise<GetOrgDashboardStatsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getOrgDashboardStats" });

  const execute = async () => {
    const input = parseInput(getOrgDashboardStatsInputSchema, rawInput);
    return executeGetOrgDashboardStats(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getOrgDashboardStats", execute);
  }
  return execute();
}

async function executeGetOrgDashboardStats(
  deps: GetOrgDashboardStatsDeps,
  logger: LoggerPort | undefined,
  input: GetOrgDashboardStatsInput,
): Promise<GetOrgDashboardStatsOutput> {
  const { repos } = deps;

  // RBAC: actor must be a member of the org (EDITOR+)
  await requireOrgMembership({
    repos,
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    roles: ORG_EDIT_ROLES,
    errorCode: "FORBIDDEN",
  });

  logger?.info("fetching org dashboard summary", { orgId: input.orgId });

  return repos.analytics.getOrgDashboardSummary(input.orgId);
}

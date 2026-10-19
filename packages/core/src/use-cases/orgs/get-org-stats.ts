import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE } from "../../lib/rbac";
import { fail } from "@th/errors";

export const getOrgStatsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
  })
  .strict();

const attributionSummarySchema = z
  .object({
    eventId: z.string().uuid(),
    attributed: z.number().int().nonnegative(),
    walkIn: z.number().int().nonnegative(),
  })
  .strict();

export const getOrgStatsOutputSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    totalEventsOrganized: z.number().int().nonnegative(),
    totalTicketsSold: z.number().int().nonnegative(),
    totalVenues: z.number().int().nonnegative(),
    avgTicketsPerEvent: z.number().nullable(),
    topPlaceIds: z.array(z.string().uuid()).nullable(),
    topArtistHumanIds: z.array(z.string().uuid()).nullable(),
    uniqueAttendees: z.number().int().nonnegative(),
    repeatAttendees: z.number().int().nonnegative(),
    attributionSummary: z.array(attributionSummarySchema).nullable(),
    topGenres: z.array(z.string()).nullable(),
    followerCount: z.number().int().nonnegative(),
    last90DayTickets: z.number().int().nonnegative(),
    last90DayEvents: z.number().int().nonnegative(),
    computedAt: z.date(),
  })
  .strict();

export type GetOrgStatsInput = z.infer<typeof getOrgStatsInputSchema>;
export type GetOrgStatsOutput = z.infer<typeof getOrgStatsOutputSchema>;

export type GetOrgStatsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

const REQUIRED_ACTOR_ROLES = ORG_ANY_ROLE;

function makeDefaultOrgStats(orgId: string): GetOrgStatsOutput {
  return {
    id: orgId,
    orgId,
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
  };
}

export async function getOrgStats(
  deps: GetOrgStatsDeps,
  rawInput: unknown,
): Promise<GetOrgStatsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getOrgStats" });

  const execute = async () => {
    const input = parseInput(getOrgStatsInputSchema, rawInput);

    await deps.authz.requireOrgRole({
      actorHumanId: input.actorHumanId,
      orgId: input.orgId,
      requiredRoles: [...REQUIRED_ACTOR_ROLES],
    });

    const org = await deps.repos.organizations.getById(input.orgId);
    if (!org) {
      throw fail("ORG_NOT_FOUND");
    }

    const stats = await deps.repos.orgStats.findByOrgId(input.orgId);

    return getOrgStatsOutputSchema.parse(stats ?? makeDefaultOrgStats(org.id));
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getOrgStats", execute);
  }

  return execute();
}

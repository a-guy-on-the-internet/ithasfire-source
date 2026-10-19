import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const getHumanStatsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    humanId: z.uuid(),
  })
  .strict();

const humanTopCitySchema = z
  .object({
    city: z.string(),
    state: z.string().optional(),
    country: z.string(),
    tickets: z.number().int().nonnegative(),
  })
  .strict();

const humanChannelBreakdownSchema = z
  .object({
    source: z.string(),
    tickets: z.number().int().nonnegative(),
  })
  .strict();

export const getHumanStatsOutputSchema = z
  .object({
    id: z.uuid(),
    humanId: z.uuid(),
    totalEventsPerformed: z.number().int().nonnegative(),
    totalTicketsAttributed: z.number().int().nonnegative(),
    avgDrawPerEvent: z.number().nullable(),
    topCities: z.array(humanTopCitySchema).nullable(),
    topPlaceIds: z.array(z.uuid()).nullable(),
    topGenres: z.array(z.string()).nullable(),
    channelBreakdown: z.array(humanChannelBreakdownSchema).nullable(),
    totalConsentedFans: z.number().int().nonnegative(),
    repeatFanCount: z.number().int().nonnegative(),
    followerCount: z.number().int().nonnegative(),
    last90DayTickets: z.number().int().nonnegative(),
    last90DayEvents: z.number().int().nonnegative(),
    computedAt: z.date(),
  })
  .strict();

export type GetHumanStatsInput = z.infer<typeof getHumanStatsInputSchema>;
export type GetHumanStatsOutput = z.infer<typeof getHumanStatsOutputSchema>;

export type GetHumanStatsDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

function makeDefaultHumanStats(humanId: string): GetHumanStatsOutput {
  return {
    id: humanId,
    humanId,
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
  };
}

export async function getHumanStats(
  deps: GetHumanStatsDeps,
  rawInput: unknown,
): Promise<GetHumanStatsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getHumanStats" });

  const execute = async () => {
    const input = parseInput(getHumanStatsInputSchema, rawInput);

    const isSelf = input.actorHumanId === input.humanId;
    if (!isSelf) {
      const staffCheck = await deps.authz.hasStaffRole({
        actorHumanId: input.actorHumanId,
        requiredRoles: [...PLATFORM_STAFF_ROLES],
      });
      if (!staffCheck.allowed) {
        throw fail("INSUFFICIENT_ROLE");
      }
    }

    const human = await deps.repos.humans.getById(input.humanId);
    if (!human) {
      throw fail("HUMAN_NOT_FOUND");
    }

    const stats = await deps.repos.humanStats.findByHumanId(input.humanId);

    return getHumanStatsOutputSchema.parse(
      stats ?? makeDefaultHumanStats(human.id),
    );
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getHumanStats", execute);
  }

  return execute();
}

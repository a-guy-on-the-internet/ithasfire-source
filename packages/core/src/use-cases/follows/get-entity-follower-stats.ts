import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  getEntityFollowerStatsInputSchema,
  getEntityFollowerStatsOutputSchema,
} from "./schemas";
import { ensureCanViewFollowerStats, getEntityPageOrThrow } from "./shared";

export type GetEntityFollowerStatsInput = z.infer<
  typeof getEntityFollowerStatsInputSchema
>;
export type GetEntityFollowerStatsOutput = z.infer<
  typeof getEntityFollowerStatsOutputSchema
>;

export type GetEntityFollowerStatsDeps = {
  repos: Pick<Repos, "entityPages" | "follows">;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  logger?: LoggerPort;
};

export async function getEntityFollowerStats(
  deps: GetEntityFollowerStatsDeps,
  rawInput: unknown,
): Promise<GetEntityFollowerStatsOutput> {
  const logger = deps.logger?.child({ useCase: "getEntityFollowerStats" });

  const execute = async () => {
    const input = parseInput(getEntityFollowerStatsInputSchema, rawInput);
    const page = await getEntityPageOrThrow(deps.repos, input.entityPageId);

    await ensureCanViewFollowerStats(deps.authz, input.actorHumanId, page);

    const now = Date.now();
    const last7Days = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [totalFollowers, newLast7Days, newLast30Days] = await Promise.all([
      deps.repos.follows.countByEntity(page.id),
      deps.repos.follows.countByEntitySince(page.id, last7Days),
      deps.repos.follows.countByEntitySince(page.id, last30Days),
    ]);

    return getEntityFollowerStatsOutputSchema.parse({
      totalFollowers,
      newLast7Days,
      newLast30Days,
    });
  };

  if (logger) {
    return logger.withTime("getEntityFollowerStats", execute);
  }

  return execute();
}

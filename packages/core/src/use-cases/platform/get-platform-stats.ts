import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getPlatformStatsInputSchema = z.object({}).strict();

export const getPlatformStatsOutputSchema = z
  .object({
    totalOrders: z.number().int(),
    totalSucceededOrders: z.number().int(),
    totalGrossRevenueCents: z.number().int(),
    totalPlatformFeesCents: z.number().int(),
    totalEvents: z.number().int(),
    totalTicketsSold: z.number().int(),
    totalHumans: z.number().int(),
    totalOrganizations: z.number().int(),
  })
  .strict();

export type GetPlatformStatsInput = z.infer<typeof getPlatformStatsInputSchema>;
export type GetPlatformStatsOutput = z.infer<
  typeof getPlatformStatsOutputSchema
>;

export type GetPlatformStatsDeps = {
  repos: Pick<Repos, "analytics">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function getPlatformStats(
  deps: GetPlatformStatsDeps,
  rawInput: unknown,
): Promise<GetPlatformStatsOutput> {
  const logger = deps.logger?.child({ useCase: "getPlatformStats" });

  const execute = async () => {
    getPlatformStatsInputSchema.parse(rawInput);
    return deps.repos.analytics.getPlatformStats();
  };

  if (logger) {
    return logger.withTime("getPlatformStats", execute);
  }
  return execute();
}

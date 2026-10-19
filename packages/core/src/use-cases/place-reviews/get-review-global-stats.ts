import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const getReviewGlobalStatsOutputSchema = z
  .object({
    venuesRated: z.number().int().nonnegative(),
    totalReviews: z.number().int().nonnegative(),
    contributors: z.number().int().nonnegative(),
  })
  .strict();

export type GetReviewGlobalStatsOutput = z.infer<
  typeof getReviewGlobalStatsOutputSchema
>;

export type GetReviewGlobalStatsDeps = {
  repos: Pick<Repos, "placeReviews">;
  logger?: LoggerPort;
};

/**
 * Public use case — returns aggregate review counts for the landing page
 * stats banner. No auth required.
 */
export async function getReviewGlobalStats(
  deps: GetReviewGlobalStatsDeps,
): Promise<GetReviewGlobalStatsOutput> {
  return deps.repos.placeReviews.globalStats();
}

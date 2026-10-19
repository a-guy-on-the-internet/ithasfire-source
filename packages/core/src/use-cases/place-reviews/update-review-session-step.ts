import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const updateReviewSessionStepInputSchema = z
  .object({
    sessionToken: z.string().uuid(),
    lastStepKey: z.string().min(1).max(100),
    pageReached: z.number().int().min(1).max(3),
  })
  .strict();

export const updateReviewSessionStepOutputSchema = z
  .object({ ok: z.boolean() })
  .strict();

export type UpdateReviewSessionStepInput = z.infer<
  typeof updateReviewSessionStepInputSchema
>;
export type UpdateReviewSessionStepOutput = z.infer<
  typeof updateReviewSessionStepOutputSchema
>;

export type UpdateReviewSessionStepDeps = {
  repos: Pick<Repos, "placeReviewSessions">;
  logger?: LoggerPort;
};

export async function updateReviewSessionStep(
  deps: UpdateReviewSessionStepDeps,
  rawInput: unknown,
): Promise<UpdateReviewSessionStepOutput> {
  const input = parseInput(updateReviewSessionStepInputSchema, rawInput);

  await deps.repos.placeReviewSessions.updateStep({
    sessionToken: input.sessionToken,
    lastStepKey: input.lastStepKey,
    pageReached: input.pageReached,
  });

  return { ok: true };
}

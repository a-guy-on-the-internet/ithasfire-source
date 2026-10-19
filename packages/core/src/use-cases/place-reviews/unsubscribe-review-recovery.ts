import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const unsubscribeReviewRecoveryInputSchema = z
  .object({
    email: z.string().email().max(320),
  })
  .strict();

export const unsubscribeReviewRecoveryOutputSchema = z
  .object({ ok: z.boolean() })
  .strict();

export type UnsubscribeReviewRecoveryInput = z.infer<
  typeof unsubscribeReviewRecoveryInputSchema
>;
export type UnsubscribeReviewRecoveryOutput = z.infer<
  typeof unsubscribeReviewRecoveryOutputSchema
>;

export type UnsubscribeReviewRecoveryDeps = {
  repos: Pick<Repos, "placeReviewSessions">;
  logger?: LoggerPort;
};

export async function unsubscribeReviewRecovery(
  deps: UnsubscribeReviewRecoveryDeps,
  rawInput: unknown,
): Promise<UnsubscribeReviewRecoveryOutput> {
  const input = parseInput(unsubscribeReviewRecoveryInputSchema, rawInput);

  await deps.repos.placeReviewSessions.markRecoveryUnsubscribed(input.email);

  deps.logger?.info("review_recovery.unsubscribed", { email: input.email });

  return { ok: true };
}

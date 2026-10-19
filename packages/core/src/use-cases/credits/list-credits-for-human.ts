import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  UserCreditRecord,
  UserCreditRedemptionRecord,
} from "@th/types";

import { parseInput } from "../../lib/io";

export const listCreditsForHumanInputSchema = z
  .object({
    humanId: z.uuid(),
  })
  .strict();

export type ListCreditsForHumanInput = z.infer<
  typeof listCreditsForHumanInputSchema
>;

export type ListCreditsForHumanOutput = {
  credits: UserCreditRecord[];
  redemptions: UserCreditRedemptionRecord[];
  /** Sum of spendable balances across active, unexpired credits, by currency. */
  activeBalanceByCurrency: Record<string, number>;
};

export type ListCreditsForHumanDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Read-only view of a human's platform credits and redemption history for the
 * account UI. Computes the spendable active balance per currency so the UI can
 * surface a headline number without re-deriving it.
 */
export async function listCreditsForHuman(
  deps: ListCreditsForHumanDeps,
  rawInput: unknown,
): Promise<ListCreditsForHumanOutput> {
  const input = parseInput(listCreditsForHumanInputSchema, rawInput);

  const [credits, redemptions] = await Promise.all([
    deps.repos.credits.listAllForHuman(input.humanId),
    deps.repos.credits.listRedemptionsForHuman(input.humanId),
  ]);

  const now = Date.now();
  const activeBalanceByCurrency: Record<string, number> = {};
  for (const credit of credits) {
    const expired =
      credit.expiresAt != null && credit.expiresAt.getTime() <= now;
    if (credit.status !== "ACTIVE" || expired || credit.balanceCents <= 0) {
      continue;
    }
    activeBalanceByCurrency[credit.currency] =
      (activeBalanceByCurrency[credit.currency] ?? 0) + credit.balanceCents;
  }

  return { credits, redemptions, activeBalanceByCurrency };
}

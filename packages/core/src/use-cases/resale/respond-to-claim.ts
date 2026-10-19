import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { claimSellerEvidenceSchema } from "./claim-evidence";

// ── Schemas ────────────────────────────────────────────────────────────────

export const respondToClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  claimId: z.string().uuid(),
  /** v1 seller evidence is a written reply (see claim-evidence.ts). */
  sellerEvidence: claimSellerEvidenceSchema,
});

export const respondToClaimOutputSchema = z.object({
  claimId: z.string().uuid(),
  respondedAt: z.string().datetime(),
});

export type RespondToClaimInput = z.infer<typeof respondToClaimInputSchema>;
export type RespondToClaimOutput = z.infer<typeof respondToClaimOutputSchema>;

export type RespondToClaimDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Seller submits their side of the story for a claim.
 * Support staff see both buyer evidence and seller response.
 *
 * The seller may reply for as long as staff have not decided the claim —
 * there is no reply deadline. Claims never close on their own and staff can
 * decide at any time (owner rulings Q8 + Q9, 2026-10-06), so a cut-off would
 * only silence the seller on a claim nobody has ruled on yet.
 */
export async function respondToClaim(
  deps: RespondToClaimDeps,
  rawInput: unknown,
): Promise<RespondToClaimOutput> {
  const input = parseInput(respondToClaimInputSchema, rawInput);
  const now = deps.clock.now();

  const result = await deps.repos.tx(async (tx) => {
    const claim = await tx.claims.getById(input.claimId);
    if (!claim) {
      throw fail("CLAIM_NOT_FOUND");
    }

    // Only the seller (respondent) can respond
    if (claim.respondentId !== input.actorHumanId) {
      throw fail("CLAIM_NOT_RESPONDENT");
    }

    // Cannot respond to resolved claims
    if (
      claim.status === "approved" ||
      claim.status === "denied" ||
      claim.status === "expired"
    ) {
      throw fail("CLAIM_ALREADY_RESOLVED");
    }

    // Conditional on the claim still being undecided: a reply racing a
    // staff decision writes nothing rather than landing on a resolved claim.
    // No advisory lock on purpose: the reply never changes the status, and
    // under READ COMMITTED the conditional update re-checks the status after
    // waiting on the deciding transaction's row lock, which is enough.
    const updated = await tx.claims.recordSellerResponse(input.claimId, {
      sellerEvidence: input.sellerEvidence,
      respondedAt: now,
    });
    if (!updated) {
      throw fail("CLAIM_ALREADY_RESOLVED");
    }

    // ── Audit ────────────────────────────────────────────────────────
    await tx.audit.log({
      entity: "claim",
      entityId: claim.id,
      action: "seller_responded",
      data: {
        claimId: claim.id,
        respondentId: input.actorHumanId,
        respondedAt: now.toISOString(),
      },
      at: now,
    });

    return {
      claimId: updated.id,
      respondedAt: now.toISOString(),
    };
  });

  deps.logger?.info("respondToClaim.succeeded", { claimId: result.claimId });

  return result;
}

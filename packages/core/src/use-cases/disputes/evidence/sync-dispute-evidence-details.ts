import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// syncDisputeEvidenceDetails — mirrors Stripe's `evidence_details` hash onto
// the local Dispute row. Called best-effort from the webhook on
// created / updated / closed, AFTER the lifecycle use case has run (so the
// row exists). Unknown dispute = `updated: false`, never a throw: the
// lifecycle write is the one that matters, this is desk display state.
// ─────────────────────────────────────────────────────────────────────────────

export const syncDisputeEvidenceDetailsInputSchema = z
  .object({
    stripeDisputeId: z.string().trim().min(3),
    evidenceDetails: z
      .object({
        dueBy: z.coerce.date().nullable().optional(),
        hasEvidence: z.boolean().nullable().optional(),
        pastDue: z.boolean().nullable().optional(),
        submissionCount: z.number().int().nonnegative().nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const syncDisputeEvidenceDetailsOutputSchema = z
  .object({
    ok: z.literal(true),
    updated: z.boolean(),
  })
  .strict();

export type SyncDisputeEvidenceDetailsInput = z.infer<
  typeof syncDisputeEvidenceDetailsInputSchema
>;
export type SyncDisputeEvidenceDetailsOutput = z.infer<
  typeof syncDisputeEvidenceDetailsOutputSchema
>;

export type SyncDisputeEvidenceDetailsDeps = {
  repos: Pick<Repos, "disputes">;
  logger?: LoggerPort;
};

export async function syncDisputeEvidenceDetails(
  deps: SyncDisputeEvidenceDetailsDeps,
  rawInput: unknown,
): Promise<SyncDisputeEvidenceDetailsOutput> {
  const input = parseInput(syncDisputeEvidenceDetailsInputSchema, rawInput);
  const details = input.evidenceDetails;

  const updated = await deps.repos.disputes.updateEvidenceDetails({
    stripeDisputeId: input.stripeDisputeId,
    // dueBy is only written when the event carried it; the lifecycle write
    // already owns the "keep the known value" fallback for that column.
    ...(details.dueBy !== undefined ? { evidenceDueBy: details.dueBy } : {}),
    evidenceHasEvidence: details.hasEvidence ?? null,
    evidencePastDue: details.pastDue ?? null,
    evidenceSubmissionCount: details.submissionCount ?? null,
  });

  const didUpdate = updated !== null;
  if (!didUpdate) {
    deps.logger?.warn("dispute.evidence_details.unknown_dispute", {
      stripeDisputeId: input.stripeDisputeId,
    });
  }

  return syncDisputeEvidenceDetailsOutputSchema.parse({
    ok: true,
    updated: didUpdate,
  });
}

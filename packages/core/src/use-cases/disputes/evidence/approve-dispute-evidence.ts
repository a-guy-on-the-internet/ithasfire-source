import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { checkDisputeEvidenceLimits } from "@th/ports/dispute-evidence";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { withDisputeEvidenceMutex } from "./_shared/evidence-mutex";
import { disputeEvidenceRecordSchema } from "./schemas";
import { requireDisputeDeskStaff, type DisputeDeskAuthzDeps } from "./staff";

// ─────────────────────────────────────────────────────────────────────────────
// approveDisputeEvidence — an ops reviewer signs a package off for submit.
// DRAFT → APPROVED; SUBMIT_FAILED → APPROVED (re-approve before retrying).
// APPROVED is idempotent (returns the package as-is, no second audit row);
// SUBMITTED is terminal.
// ─────────────────────────────────────────────────────────────────────────────

export const approveDisputeEvidenceInputSchema = z
  .object({
    disputeId: z.string().min(1),
    actorHumanId: z.string().min(1),
  })
  .strict();

export const approveDisputeEvidenceOutputSchema = z
  .object({
    ok: z.literal(true),
    evidence: disputeEvidenceRecordSchema,
  })
  .strict();

export type ApproveDisputeEvidenceInput = z.infer<
  typeof approveDisputeEvidenceInputSchema
>;
export type ApproveDisputeEvidenceOutput = z.infer<
  typeof approveDisputeEvidenceOutputSchema
>;

export type ApproveDisputeEvidenceDeps = DisputeDeskAuthzDeps & {
  repos: Pick<Repos, "tx" | "disputeEvidence" | "audit">;
  /** Per-dispute mutex shared with submit / edit / force-assemble. */
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function approveDisputeEvidence(
  deps: ApproveDisputeEvidenceDeps,
  rawInput: unknown,
): Promise<ApproveDisputeEvidenceOutput> {
  const input = parseInput(approveDisputeEvidenceInputSchema, rawInput);
  await requireDisputeDeskStaff(deps, input.actorHumanId, "write");

  const evidence = await withDisputeEvidenceMutex(deps, input.disputeId, () =>
    deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const existing = await tx.disputeEvidence.getByDisputeId(input.disputeId);
    if (!existing) {
      throw fail("DISPUTE_EVIDENCE_NOT_FOUND", {
        meta: { disputeId: input.disputeId },
      });
    }
    if (existing.status === "APPROVED") return existing;
    if (existing.status === "SUBMITTED") {
      throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
        message: "submitted dispute evidence cannot be re-approved",
        meta: { disputeId: input.disputeId, status: existing.status },
      });
    }

    // Approving an empty or over-limit package would only move the failure
    // to submit time; refuse here where ops can still edit.
    const keys = Object.keys(existing.fields);
    if (keys.length === 0) {
      throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
        message: "dispute evidence package is empty",
        meta: { disputeId: input.disputeId },
      });
    }
    const limits = checkDisputeEvidenceLimits(existing.fields);
    if (!limits.ok) {
      throw fail("DISPUTE_EVIDENCE_LIMIT_EXCEEDED", {
        message: "dispute evidence exceeds the processor's size limits",
        meta: {
          disputeId: input.disputeId,
          combinedChars: limits.combinedChars,
          violations: limits.violations,
        },
      });
    }

    const approved = await tx.disputeEvidence.update({
      disputeId: input.disputeId,
      expect: {
        status: existing.status,
        assembledVersion: existing.assembledVersion,
      },
      status: "APPROVED",
      reviewedByHumanId: input.actorHumanId,
      reviewedAt: now,
      submitError: null,
    });

    await tx.audit.log({
      entity: "dispute",
      entityId: input.disputeId,
      action: "dispute.evidence_approved",
      data: {
        actorHumanId: input.actorHumanId,
        previousStatus: existing.status,
        assembledVersion: existing.assembledVersion,
        fieldKeys: keys,
        combinedChars: limits.combinedChars,
      },
      at: now,
    });

    return approved;
    }),
  );

  deps.logger?.info("dispute.evidence.approved", {
    disputeId: input.disputeId,
    actorHumanId: input.actorHumanId,
    assembledVersion: evidence.assembledVersion,
  });

  return approveDisputeEvidenceOutputSchema.parse({ ok: true, evidence });
}

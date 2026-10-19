import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  checkDisputeEvidenceLimits,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { withDisputeEvidenceMutex } from "./_shared/evidence-mutex";
import {
  disputeEvidenceDraftFieldsSchema,
  disputeEvidenceRecordSchema,
} from "./schemas";
import { requireDisputeDeskStaff, type DisputeDeskAuthzDeps } from "./staff";

// ─────────────────────────────────────────────────────────────────────────────
// updateDisputeEvidenceDraft — ops edits the TEXT fields of a package.
//
// Edits merge over the stored fields key-by-key: a key present in `fields`
// replaces the stored value (including `""`, which is the deliberate way to
// clear a field the assembler filled — the processor treats a posted empty
// string as "unset"); a key absent from `fields` is left alone. File-id
// keys are rejected at parse time (v1 is text-only).
//
// Allowed from DRAFT, APPROVED (drops back to DRAFT — an edited package needs
// a fresh sign-off) and SUBMIT_FAILED (ops fix and retry). SUBMITTED is
// terminal.
// ─────────────────────────────────────────────────────────────────────────────

export const updateDisputeEvidenceDraftInputSchema = z
  .object({
    disputeId: z.string().min(1),
    actorHumanId: z.string().min(1),
    fields: disputeEvidenceDraftFieldsSchema,
  })
  .strict();

export const updateDisputeEvidenceDraftOutputSchema = z
  .object({
    ok: z.literal(true),
    evidence: disputeEvidenceRecordSchema,
    combinedChars: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateDisputeEvidenceDraftInput = z.infer<
  typeof updateDisputeEvidenceDraftInputSchema
>;
export type UpdateDisputeEvidenceDraftOutput = z.infer<
  typeof updateDisputeEvidenceDraftOutputSchema
>;

export type UpdateDisputeEvidenceDraftDeps = DisputeDeskAuthzDeps & {
  repos: Pick<Repos, "tx" | "disputeEvidence" | "audit">;
  /** Per-dispute mutex shared with submit / approve / force-assemble. */
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function updateDisputeEvidenceDraft(
  deps: UpdateDisputeEvidenceDraftDeps,
  rawInput: unknown,
): Promise<UpdateDisputeEvidenceDraftOutput> {
  const input = parseInput(updateDisputeEvidenceDraftInputSchema, rawInput);
  await requireDisputeDeskStaff(deps, input.actorHumanId, "write");

  const editedKeys = Object.keys(input.fields);
  if (editedKeys.length === 0) {
    throw fail("INVALID_INPUT", {
      message: "no evidence fields supplied",
    });
  }

  // Same per-dispute lock as submit: an edit can never land between a
  // submit's pre-flight read and its terminal write.
  const result = await withDisputeEvidenceMutex(deps, input.disputeId, () =>
    deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const existing = await tx.disputeEvidence.getByDisputeId(input.disputeId);
    if (!existing) {
      throw fail("DISPUTE_EVIDENCE_NOT_FOUND", {
        meta: { disputeId: input.disputeId },
      });
    }
    if (existing.status === "SUBMITTED") {
      throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
        message: "submitted dispute evidence cannot be edited",
        meta: { disputeId: input.disputeId, status: existing.status },
      });
    }

    const merged: DisputeEvidenceFields = {
      ...existing.fields,
      ...input.fields,
    };
    const limits = checkDisputeEvidenceLimits(merged);
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

    const evidence = await tx.disputeEvidence.update({
      disputeId: input.disputeId,
      expect: {
        status: existing.status,
        assembledVersion: existing.assembledVersion,
      },
      fields: merged,
      status: "DRAFT",
      reviewedByHumanId: null,
      reviewedAt: null,
      submitError: null,
    });

    await tx.audit.log({
      entity: "dispute",
      entityId: input.disputeId,
      action: "dispute.evidence_draft_updated",
      data: {
        actorHumanId: input.actorHumanId,
        previousStatus: existing.status,
        assembledVersion: existing.assembledVersion,
        // Keys only — the values are buyer PII and belong in the package,
        // not the audit log.
        editedKeys,
        clearedKeys: editedKeys.filter(
          (key) => input.fields[key as keyof typeof input.fields] === "",
        ),
        combinedChars: limits.combinedChars,
      },
      at: now,
    });

    return { evidence, combinedChars: limits.combinedChars };
    }),
  );

  deps.logger?.info("dispute.evidence.draft_updated", {
    disputeId: input.disputeId,
    actorHumanId: input.actorHumanId,
    editedKeys,
  });

  return updateDisputeEvidenceDraftOutputSchema.parse({
    ok: true,
    evidence: result.evidence,
    combinedChars: result.combinedChars,
  });
}

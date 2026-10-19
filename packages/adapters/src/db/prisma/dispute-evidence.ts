import { Prisma, type DisputeEvidence } from "@prisma/client";
import type {
  DisputeEvidenceRecord,
  DisputeEvidenceRepo,
  UpdateDisputeEvidenceInput,
} from "@th/ports/repos/dispute-evidence";
import type {
  DisputeEvidenceSources,
  DisputeEvidenceStatus,
} from "@th/types/repos/disputes";
import type { DisputeEvidenceFields } from "@th/ports/dispute-evidence";
import { DISPUTE_EVIDENCE_FIELD_KEYS } from "@th/ports/dispute-evidence";
import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

/**
 * Reads the stored fields object back through the field table so a stray
 * key written by an older version (or by hand) is dropped rather than
 * forwarded to the processor. Non-string values are ignored the same way.
 */
function mapFields(value: unknown): DisputeEvidenceFields {
  const out: DisputeEvidenceFields = {};
  if (!value || typeof value !== "object") return out;
  const raw = value as Record<string, unknown>;
  for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
    const v = raw[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

// Only present keys are stored — an `undefined` value would serialise as
// nothing anyway, but being explicit keeps the JSON shape equal to what the
// processor mapping iterates.
function toFieldsJson(fields: DisputeEvidenceFields): Prisma.InputJsonObject {
  const out: Record<string, string> = {};
  for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
    const v = fields[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function mapRow(row: DisputeEvidence): DisputeEvidenceRecord {
  return {
    id: row.id,
    disputeId: row.disputeId,
    status: row.status as DisputeEvidenceStatus,
    fields: mapFields(row.fields),
    sources: row.sources as unknown as DisputeEvidenceSources,
    assembledAt: row.assembledAt,
    assembledVersion: row.assembledVersion,
    reviewedByHumanId: row.reviewedByHumanId ?? null,
    reviewedAt: row.reviewedAt ?? null,
    submittedByHumanId: row.submittedByHumanId ?? null,
    submittedAt: row.submittedAt ?? null,
    submitError: row.submitError ?? null,
    processorSubmissionCount: row.processorSubmissionCount ?? null,
    reconciledFromProcessor: row.reconciledFromProcessor ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildUpdateData(
  input: UpdateDisputeEvidenceInput,
): Prisma.DisputeEvidenceUncheckedUpdateInput {
  return {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.fields !== undefined ? { fields: toFieldsJson(input.fields) } : {}),
    ...(input.sources !== undefined
      ? { sources: input.sources as unknown as Prisma.InputJsonObject }
      : {}),
    ...(input.reviewedByHumanId !== undefined
      ? { reviewedByHumanId: input.reviewedByHumanId }
      : {}),
    ...(input.reviewedAt !== undefined ? { reviewedAt: input.reviewedAt } : {}),
    ...(input.submittedByHumanId !== undefined
      ? { submittedByHumanId: input.submittedByHumanId }
      : {}),
    ...(input.submittedAt !== undefined
      ? { submittedAt: input.submittedAt }
      : {}),
    ...(input.submitError !== undefined
      ? { submitError: input.submitError }
      : {}),
    ...(input.processorSubmissionCount !== undefined
      ? { processorSubmissionCount: input.processorSubmissionCount }
      : {}),
    ...(input.reconciledFromProcessor !== undefined
      ? { reconciledFromProcessor: input.reconciledFromProcessor }
      : {}),
  };
}

export function makeDisputeEvidenceRepo(
  p: PrismaClientOrTx,
): DisputeEvidenceRepo {
  return {
    getByDisputeId: async (disputeId) => {
      const row = await p.disputeEvidence.findUnique({ where: { disputeId } });
      return row ? mapRow(row) : null;
    },

    upsertDraft: async (input) => {
      const fields = toFieldsJson(input.fields);
      const sources = input.sources as unknown as Prisma.InputJsonObject;
      const row = await p.disputeEvidence.upsert({
        where: { disputeId: input.disputeId },
        create: {
          disputeId: input.disputeId,
          status: "DRAFT",
          fields,
          sources,
          assembledAt: input.assembledAt,
          assembledVersion: 1,
        },
        // Re-assembly: a fresh attempt id and a fresh sign-off — every
        // review/submit stamp is cleared along with the status reset.
        update: {
          status: "DRAFT",
          fields,
          sources,
          assembledAt: input.assembledAt,
          assembledVersion: { increment: 1 },
          reviewedByHumanId: null,
          reviewedAt: null,
          submittedByHumanId: null,
          submittedAt: null,
          submitError: null,
          processorSubmissionCount: null,
          reconciledFromProcessor: null,
        },
      });
      return mapRow(row);
    },

    update: async (input) => {
      // updateMany + re-read so an `expect` mismatch is a zero-row CAS miss
      // (no throw from Prisma, no partial write), distinguishable from a
      // missing package by a follow-up read.
      const updated = await p.disputeEvidence.updateMany({
        where: {
          disputeId: input.disputeId,
          ...(input.expect?.status !== undefined
            ? { status: input.expect.status }
            : {}),
          ...(input.expect?.assembledVersion !== undefined
            ? { assembledVersion: input.expect.assembledVersion }
            : {}),
        },
        data: buildUpdateData(input),
      });
      const row = await p.disputeEvidence.findUnique({
        where: { disputeId: input.disputeId },
      });
      if (!row) {
        throw fail("DISPUTE_EVIDENCE_NOT_FOUND", {
          message: "dispute evidence package not found",
          meta: { disputeId: input.disputeId },
        });
      }
      if (updated.count === 0) {
        throw fail("DISPUTE_EVIDENCE_STATE_INVALID", {
          message: "dispute evidence package changed underneath this write",
          meta: {
            disputeId: input.disputeId,
            expected: input.expect ?? null,
            actual: { status: row.status, assembledVersion: row.assembledVersion },
          },
        });
      }
      return mapRow(row);
    },
  };
}

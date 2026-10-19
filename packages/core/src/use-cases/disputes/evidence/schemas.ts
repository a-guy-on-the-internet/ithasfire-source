import { z } from "zod";

import type { DisputeEvidenceRecord } from "@th/ports/repos/dispute-evidence";
import type {
  DisputeDeskRow,
  DisputeDeskStatusFilter,
  DisputeEvidenceSources,
  DisputeEvidenceSourceState,
  DisputeEvidenceStatus,
} from "@th/ports/repos/disputes";
import {
  DISPUTE_EVIDENCE_FIELD_KEYS,
  DISPUTE_EVIDENCE_FIELD_KINDS,
  DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
  type DisputeEvidenceFieldKey,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";

import { disputeStatusSchema } from "../schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Shared zod shapes for the dispute-evidence slice. Kept in one file so the
// transport imports exactly what the use cases parse with.
// ─────────────────────────────────────────────────────────────────────────────

export const disputeEvidenceStatusSchema = z.enum([
  "DRAFT",
  "APPROVED",
  "SUBMITTED",
  "SUBMIT_FAILED",
] satisfies readonly DisputeEvidenceStatus[]);

/** Text-only evidence keys (the v1 editable surface; file slots stay unset). */
export const DISPUTE_EVIDENCE_TEXT_FIELD_KEYS = DISPUTE_EVIDENCE_FIELD_KEYS.filter(
  (key) => DISPUTE_EVIDENCE_FIELD_KINDS[key] === "text",
) as readonly DisputeEvidenceFieldKey[];

/** File-id evidence keys — rejected by the draft editor in v1. */
export const DISPUTE_EVIDENCE_FILE_FIELD_KEYS = DISPUTE_EVIDENCE_FIELD_KEYS.filter(
  (key) => DISPUTE_EVIDENCE_FIELD_KINDS[key] === "file",
) as readonly DisputeEvidenceFieldKey[];

// Output shape: every key optional, any string (the limit check is a
// separate, richer error than a zod max would give — it reports combined
// totals too — so the output schema does not re-cap).
export const disputeEvidenceFieldsSchema = z
  .object(
    Object.fromEntries(
      DISPUTE_EVIDENCE_FIELD_KEYS.map((key) => [key, z.string().optional()]),
    ) as Record<DisputeEvidenceFieldKey, z.ZodOptional<z.ZodString>>,
  )
  .strict();

// Draft-editor input: TEXT keys only, `.strict()` so a file-id key (or a
// typo) is an invalid_input rather than a silently ignored edit. The per-key
// cap is a cheap first line; the combined 150k cap is checked in the use
// case via `checkDisputeEvidenceLimits` on the MERGED package.
//
// `""` is accepted on purpose: it is the one way ops can clear a field the
// assembler filled (Stripe treats a posted empty string as "unset").
export const disputeEvidenceDraftFieldsSchema = z
  .object(
    Object.fromEntries(
      DISPUTE_EVIDENCE_TEXT_FIELD_KEYS.map((key) => [
        key,
        z.string().max(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS).optional(),
      ]),
    ) as Record<DisputeEvidenceFieldKey, z.ZodOptional<z.ZodString>>,
  )
  .strict();

export type DisputeEvidenceDraftFields = z.infer<
  typeof disputeEvidenceDraftFieldsSchema
>;

const sourceStateSchema = z.enum([
  "found",
  "missing",
  "not_applicable",
] satisfies readonly DisputeEvidenceSourceState[]);

export const disputeEvidenceSourcesSchema = z
  .object({
    order: sourceStateSchema,
    buyer: sourceStateSchema,
    buyerEmail: sourceStateSchema,
    checkoutIp: sourceStateSchema,
    billingAddress: sourceStateSchema,
    event: sourceStateSchema,
    venue: sourceStateSchema,
    organizer: sourceStateSchema,
    refundPolicy: sourceStateSchema,
    termsAcceptance: sourceStateSchema,
    tickets: sourceStateSchema,
    scanLog: sourceStateSchema,
    refundHistory: sourceStateSchema,
    cardChecks: sourceStateSchema,
    ticketEmail: sourceStateSchema,
    statementDescriptor: sourceStateSchema,
    truncated: z.boolean(),
  } satisfies Record<keyof DisputeEvidenceSources, z.ZodTypeAny>)
  .strict();

export const disputeEvidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    disputeId: z.string().min(1),
    status: disputeEvidenceStatusSchema,
    fields: disputeEvidenceFieldsSchema,
    sources: disputeEvidenceSourcesSchema,
    assembledAt: z.date(),
    assembledVersion: z.number().int().positive(),
    reviewedByHumanId: z.string().nullable(),
    reviewedAt: z.date().nullable(),
    submittedByHumanId: z.string().nullable(),
    submittedAt: z.date().nullable(),
    submitError: z.string().nullable(),
    processorSubmissionCount: z.number().int().nullable(),
    reconciledFromProcessor: z.boolean().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  } satisfies Record<keyof DisputeEvidenceRecord, z.ZodTypeAny>)
  .strict();

export const disputeDeskStatusFilterSchema = z.enum([
  "open",
  "closed",
  "all",
] satisfies readonly DisputeDeskStatusFilter[]);

/** Shared by the desk row and the desk detail read. */
export const earlyFraudWarningSummarySchema = z
  .object({
    fraudType: z.string(),
    stripeCreatedAt: z.date(),
  })
  .strict();

export const disputeDeskRowSchema = z
  .object({
    id: z.string().min(1),
    stripeDisputeId: z.string().min(1),
    status: disputeStatusSchema,
    reason: z.string(),
    amountCents: z.number().int(),
    feeCents: z.number().int(),
    currency: z.string(),
    triageReason: z.string().nullable(),
    evidenceDueBy: z.date().nullable(),
    evidenceHasEvidence: z.boolean().nullable(),
    evidencePastDue: z.boolean().nullable(),
    evidenceSubmissionCount: z.number().int().nullable(),
    evidenceSubmittedAt: z.date().nullable(),
    fundsWithdrawnAt: z.date().nullable(),
    closedAt: z.date().nullable(),
    outcome: z.string().nullable(),
    createdAt: z.date(),
    orderId: z.string().nullable(),
    orderKind: z.enum(["TICKETING", "MEMBERSHIP"]).nullable(),
    orderShortId: z.string().nullable(),
    buyerHumanId: z.string().nullable(),
    buyerName: z.string().nullable(),
    eventId: z.string().nullable(),
    eventTitle: z.string().nullable(),
    ownerOrgId: z.string().nullable(),
    ownerOrgName: z.string().nullable(),
    ownerHumanId: z.string().nullable(),
    ownerHumanName: z.string().nullable(),
    evidenceStatus: disputeEvidenceStatusSchema.nullable(),
    evidenceAssembledVersion: z.number().int().nullable(),
    evidenceReconciledFromProcessor: z.boolean().nullable(),
    earlyFraudWarning: earlyFraudWarningSummarySchema.nullable(),
  } satisfies Record<keyof DisputeDeskRow, z.ZodTypeAny>)
  .strict();

export const disputeDeskListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(CURSOR_MAX_LIMIT);

/** Helper for tests and callers: an all-`missing` provenance map. */
export function emptyDisputeEvidenceSources(): DisputeEvidenceSources {
  return {
    order: "missing",
    buyer: "missing",
    buyerEmail: "missing",
    checkoutIp: "missing",
    billingAddress: "missing",
    event: "missing",
    venue: "missing",
    organizer: "missing",
    refundPolicy: "missing",
    termsAcceptance: "missing",
    tickets: "missing",
    scanLog: "missing",
    refundHistory: "missing",
    cardChecks: "missing",
    ticketEmail: "missing",
    statementDescriptor: "missing",
    truncated: false,
  };
}

/**
 * Provenance for a package reconciled from the processor: nothing here was
 * gathered by us, so every source is `not_applicable`. The row's
 * `reconciledFromProcessor` flag is the authoritative marker.
 */
export function processorProvenanceSources(): DisputeEvidenceSources {
  const sources = emptyDisputeEvidenceSources();
  for (const key of Object.keys(sources) as (keyof DisputeEvidenceSources)[]) {
    if (key !== "truncated") sources[key] = "not_applicable";
  }
  return sources;
}

export type { DisputeEvidenceFields };

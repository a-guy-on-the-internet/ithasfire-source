import type {
  DisputeEvidenceSources,
  DisputeEvidenceStatus,
} from "@th/types/repos/disputes";

import type { DisputeEvidenceFields } from "../dispute-evidence";

/**
 * The persisted evidence package for one dispute. `fields` is the editable
 * `DisputeEvidenceFields` object exactly as it will be posted to the
 * processor (absent key = not sent; `""` = an explicit ops-driven clear).
 * Defined here rather than in @th/types because it references the
 * processor-agnostic evidence vocabulary that lives in ports.
 */
export interface DisputeEvidenceRecord {
  id: string;
  disputeId: string;
  status: DisputeEvidenceStatus;
  fields: DisputeEvidenceFields;
  sources: DisputeEvidenceSources;
  assembledAt: Date;
  assembledVersion: number;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  submittedByHumanId: string | null;
  submittedAt: Date | null;
  submitError: string | null;
  processorSubmissionCount: number | null;
  /** See the Prisma model: SUBMITTED via processor reconciliation, not the desk. */
  reconciledFromProcessor: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * (Re-)assembly write. Creates the package on first run; on re-run resets it
 * to DRAFT with the new fields/sources, bumps `assembledVersion` and clears
 * every review/submit stamp — a fresh attempt id, a fresh sign-off.
 */
export interface UpsertDisputeEvidenceDraftInput {
  disputeId: string;
  fields: DisputeEvidenceFields;
  sources: DisputeEvidenceSources;
  assembledAt: Date;
}

/**
 * Partial update. `undefined` = leave alone; `null` = clear. `fields`
 * replaces the whole object (callers merge first — a partial JSON merge in
 * the adapter would make "unset this key" impossible to express).
 */
export interface UpdateDisputeEvidenceInput {
  disputeId: string;
  /**
   * Compare-and-set guard. When present the write applies ONLY if the row
   * still has this status / assembledVersion; otherwise the adapter throws
   * DISPUTE_EVIDENCE_STATE_INVALID and writes nothing. The submit path uses
   * it so a package edited or re-assembled mid-flight can never be stamped
   * SUBMITTED over fields the processor never saw.
   */
  expect?: { status?: DisputeEvidenceStatus; assembledVersion?: number };
  status?: DisputeEvidenceStatus;
  fields?: DisputeEvidenceFields;
  /** Replaces the whole provenance map (reconcile path). */
  sources?: DisputeEvidenceSources;
  reviewedByHumanId?: string | null;
  reviewedAt?: Date | null;
  submittedByHumanId?: string | null;
  submittedAt?: Date | null;
  submitError?: string | null;
  processorSubmissionCount?: number | null;
  reconciledFromProcessor?: boolean | null;
}

export interface DisputeEvidenceRepo {
  getByDisputeId(disputeId: string): Promise<DisputeEvidenceRecord | null>;
  upsertDraft(
    input: UpsertDisputeEvidenceDraftInput,
  ): Promise<DisputeEvidenceRecord>;
  /**
   * Throws DISPUTE_EVIDENCE_NOT_FOUND when no package exists for the
   * dispute, and DISPUTE_EVIDENCE_STATE_INVALID when `expect` does not match
   * (compare-and-set miss).
   */
  update(input: UpdateDisputeEvidenceInput): Promise<DisputeEvidenceRecord>;
}

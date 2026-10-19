// AcceptanceRecord — platform-wide, human-keyed, version-gated document
// acceptances. See docs/specs/2026-05-17/completed/acceptance-records.spec.md.

export type AcceptanceDocumentType =
  | "CHARGEBACK_TERMS_ORGANIZER"
  | "BUYER_TERMS"
  | "REFUND_POLICY"
  | "ORGANIZER_TERMS"
  | "PRIVACY_POLICY"
  | "AGE_VERIFICATION";

export type AcceptanceScope = "GLOBAL" | "ORGANIZATION" | "EVENT";

export interface AcceptanceRecordRow {
  id: string;
  humanId: string;
  documentType: AcceptanceDocumentType;
  documentVersion: string;
  documentTextSnapshot: string;
  scopeType: AcceptanceScope;
  scopeId: string | null;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateAcceptanceRecordInput {
  humanId: string;
  documentType: AcceptanceDocumentType;
  documentVersion: string;
  documentTextSnapshot: string;
  scopeType: AcceptanceScope;
  scopeId?: string | null;
  acceptedAt?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FindCurrentAcceptanceInput {
  humanId: string;
  documentType: AcceptanceDocumentType;
  documentVersion: string;
  /** Defaults to GLOBAL when omitted. */
  scopeType?: AcceptanceScope;
  /** Defaults to null when omitted. */
  scopeId?: string | null;
}

export interface AcceptanceRepo {
  /**
   * Returns the most recent acceptance matching the human + document +
   * version + scope, or null if the human has not accepted the current
   * version in that scope (i.e. a re-accept is required).
   */
  findCurrent(
    input: FindCurrentAcceptanceInput,
  ): Promise<AcceptanceRecordRow | null>;
  /**
   * Duplicate-safe insert. At most one row exists per (humanId,
   * documentType, documentVersion, scopeType, scopeId) — NULL scopeId
   * included (DB unique index, NULLS NOT DISTINCT). When a concurrent or
   * prior acceptance already holds the key, the existing row is returned
   * instead of raising, and the surrounding transaction is NOT aborted —
   * an order-creating tx must never fail because the human accepted the
   * same document elsewhere at the same moment.
   */
  create(input: CreateAcceptanceRecordInput): Promise<AcceptanceRecordRow>;
}

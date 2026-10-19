// SmsConsentRepo — app-owned phone-level SMS opt-out / opt-in ledger.
// See docs/specs/2026-05-18/completed/sms-opt-out-sns.spec.yaml.

export type SmsConsentStatus = "OPTED_OUT" | "OPTED_IN" | "UNKNOWN";

export interface SmsConsentRecord {
  id: string;
  phoneE164: string;
  status: SmsConsentStatus;
  source: string;
  reasonKeyword: string | null;
  providerMessageId: string | null;
  actorHumanId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  optedOutAt: Date | null;
  optedInAt: Date | null;
}

export interface UpsertSmsConsentInput {
  phoneE164: string;
  status: SmsConsentStatus;
  source: string;
  reasonKeyword?: string | null;
  providerMessageId?: string | null;
  actorHumanId?: string | null;
  metadata?: Record<string, unknown> | null;
  optedOutAt?: Date | null;
  optedInAt?: Date | null;
}

/**
 * A consent decision stamped with the time the person made it. `eventAt` is
 * the provider's timestamp for an inbound keyword, or the clock's now for
 * consent given in the app.
 */
export interface ApplySmsConsentDecisionInput {
  phoneE164: string;
  status: "OPTED_IN" | "OPTED_OUT";
  eventAt: Date;
  source: string;
  reasonKeyword?: string | null;
  providerMessageId?: string | null;
  actorHumanId?: string | null;
}

export interface ApplySmsConsentDecisionResult {
  /** False when a newer decision was already on the row (nothing written). */
  applied: boolean;
  /** The row after the call: the new state when applied, else the current one. */
  record: SmsConsentRecord;
}

export interface RecordSmsConsentEventInput {
  phoneE164: string;
  eventType: string;
  source: string;
  providerMessageId?: string | null;
  payloadHash?: string | null;
}

export interface SmsConsentRepo {
  /** Current consent state for a normalized E.164 number, or null. */
  getByPhone(phoneE164: string): Promise<SmsConsentRecord | null>;
  /**
   * Upsert the current consent state keyed by `phoneE164`. Repeated calls with
   * the same status are idempotent at the row level (one current row per
   * number); the append-only event log is the historical record.
   *
   * @deprecated Unordered write: it overwrites whatever is on the row, so a
   * redelivered older STOP/START can undo a newer one. Use
   * `applyDecisionIfNewer`.
   */
  upsertStatus(input: UpsertSmsConsentInput): Promise<SmsConsentRecord>;
  /**
   * Apply an opt-in or opt-out only if no newer decision is on the row, as
   * one atomic compare-and-set (safe against a concurrent STOP and START).
   *
   * The row keeps the latest `optedInAt` and the latest `optedOutAt`; this
   * call sets the column matching `status` to `eventAt` and leaves the other
   * untouched. A decision is stale, and nothing is written, when:
   * - OPTED_IN:  `eventAt <= optedOutAt` or `eventAt < optedInAt`
   * - OPTED_OUT: `eventAt < optedInAt`  or `eventAt < optedOutAt`
   * Ties between an opt-in and an opt-out go to the opt-out.
   */
  applyDecisionIfNewer(
    input: ApplySmsConsentDecisionInput,
  ): Promise<ApplySmsConsentDecisionResult>;
  /** Append an immutable consent event to the audit trail. */
  recordEvent(input: RecordSmsConsentEventInput): Promise<void>;
}

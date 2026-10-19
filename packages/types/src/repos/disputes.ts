import type { PayeeSubjectType } from "./payees";
import type { EarlyFraudWarningSummary } from "./early-fraud-warnings";

export type DisputeStatus =
  | "NEEDS_TRIAGE"
  | "OPEN"
  | "UNDER_REVIEW"
  | "WON"
  | "LOST"
  | "WARNING_OPEN"
  | "WARNING_UNDER_REVIEW"
  | "WARNING_CLOSED";

/** Who absorbs Stripe's per-dispute fee. */
export type DisputeFeeBearer = "PLATFORM" | "PAYEE";

export interface DisputeRecord {
  id: string;
  stripeDisputeId: string;
  stripeChargeId: string | null;
  paymentIntentId: string | null;
  orderId: string | null;
  ownerSubjectType: PayeeSubjectType | null;
  ownerSubjectId: string | null;
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  amountCents: number;
  /**
   * Stripe's dispute fee in cents, summed across the dispute's balance
   * transactions. 0 until Stripe reports it — usually at `funds_withdrawn`,
   * not at `charge.dispute.created`.
   */
  feeCents: number;
  /** Null until the fee is first observed. */
  feeBorneBy: DisputeFeeBearer | null;
  currency: string;
  reason: string;
  status: DisputeStatus;
  triageReason: string | null;
  linkedAt: Date | null;
  evidenceDueBy: Date | null;
  /**
   * Mirror of Stripe `evidence_details` (has_evidence / past_due /
   * submission_count), refreshed from every dispute webhook and after a
   * successful desk submit. Null = never observed for this dispute.
   */
  evidenceHasEvidence: boolean | null;
  evidencePastDue: boolean | null;
  evidenceSubmissionCount: number | null;
  /** When WE last submitted evidence through the desk. */
  evidenceSubmittedAt: Date | null;
  fundsWithdrawnAt: Date | null;
  closedAt: Date | null;
  outcome: string | null;
  metadata: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Evidence package ─────────────────────────────────────────────────────────

export type DisputeEvidenceStatus =
  | "DRAFT"
  | "APPROVED"
  | "SUBMITTED"
  | "SUBMIT_FAILED";

/**
 * Provenance of one evidence source. `found` = data was present and made it
 * into the package; `missing` = the source exists in the domain but had no
 * data for this order (or is not persisted anywhere yet — AVS/CVC on legacy
 * orders); `not_applicable` = the source cannot exist for this order kind
 * (scan log on a membership invoice).
 */
export type DisputeEvidenceSourceState = "found" | "missing" | "not_applicable";

/**
 * Per-source provenance recorded by `assembleDisputeEvidence`, keyed by a
 * fixed source name so the desk can render "what's thin" without parsing the
 * evidence text. Every key is always present — a new source added to the
 * assembler must be added here too (the assembler `satisfies` this shape).
 */
export interface DisputeEvidenceSources {
  order: DisputeEvidenceSourceState;
  buyer: DisputeEvidenceSourceState;
  buyerEmail: DisputeEvidenceSourceState;
  checkoutIp: DisputeEvidenceSourceState;
  billingAddress: DisputeEvidenceSourceState;
  event: DisputeEvidenceSourceState;
  venue: DisputeEvidenceSourceState;
  organizer: DisputeEvidenceSourceState;
  refundPolicy: DisputeEvidenceSourceState;
  termsAcceptance: DisputeEvidenceSourceState;
  tickets: DisputeEvidenceSourceState;
  scanLog: DisputeEvidenceSourceState;
  refundHistory: DisputeEvidenceSourceState;
  cardChecks: DisputeEvidenceSourceState;
  ticketEmail: DisputeEvidenceSourceState;
  statementDescriptor: DisputeEvidenceSourceState;
  /** True when `uncategorizedText` was cut to fit the processor limits. */
  truncated: boolean;
}

export interface UpdateDisputeEvidenceDetailsInput {
  stripeDisputeId: string;
  evidenceDueBy?: Date | null;
  evidenceHasEvidence: boolean | null;
  evidencePastDue: boolean | null;
  evidenceSubmissionCount: number | null;
  /** Only set by the desk submit path; webhooks leave it alone. */
  evidenceSubmittedAt?: Date | null;
}

// ── Desk list ────────────────────────────────────────────────────────────────

export type DisputeDeskStatusFilter = "open" | "closed" | "all";

export interface ListDisputesForDeskInput {
  status: DisputeDeskStatusFilter;
  cursor?: string | null;
  limit: number;
}

/**
 * One desk queue row: the dispute plus the minimal display fields joined from
 * order / event / owner, and the evidence package status (null = never
 * assembled). Buyer email is NOT here — it lives on the auth identity and the
 * detail read fetches it; the queue only needs a name.
 */
export interface DisputeDeskRow {
  id: string;
  stripeDisputeId: string;
  status: DisputeStatus;
  reason: string;
  amountCents: number;
  feeCents: number;
  currency: string;
  triageReason: string | null;
  evidenceDueBy: Date | null;
  evidenceHasEvidence: boolean | null;
  evidencePastDue: boolean | null;
  evidenceSubmissionCount: number | null;
  evidenceSubmittedAt: Date | null;
  fundsWithdrawnAt: Date | null;
  closedAt: Date | null;
  outcome: string | null;
  createdAt: Date;
  orderId: string | null;
  orderKind: "TICKETING" | "MEMBERSHIP" | null;
  orderShortId: string | null;
  buyerHumanId: string | null;
  buyerName: string | null;
  eventId: string | null;
  eventTitle: string | null;
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  ownerHumanId: string | null;
  ownerHumanName: string | null;
  evidenceStatus: DisputeEvidenceStatus | null;
  evidenceAssembledVersion: number | null;
  /** Package was reconciled to SUBMITTED from processor state, not the desk. */
  evidenceReconciledFromProcessor: boolean | null;
  /**
   * Newest Radar early fraud warning on the linked order, whatever its
   * resolution — "the issuer warned us on <date>" is exactly what the desk
   * wants to see next to the chargeback that followed. Null = never warned
   * (or no linked order).
   */
  earlyFraudWarning: EarlyFraudWarningSummary | null;
}

export interface ListDisputesForDeskResult {
  items: DisputeDeskRow[];
  nextCursor: string | null;
}

/**
 * One (owner, status) aggregate of disputes on MEMBERSHIP orders, for the
 * platform standing overview. Exactly one of the owner ids is set —
 * membership dispute rows always carry the denormalised owner written by
 * `resolveDisputeOwner` (disputes/shared.ts). Grouping keys keep owners
 * separate by construction; folding statuses into open/lost buckets is the
 * use case's job.
 */
export interface MembershipDisputeExposureRow {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  status: DisputeStatus;
  disputeCount: number;
  /** Sum of disputed `amountCents` for this owner + status. */
  amountCents: number;
  /** Sum of Stripe dispute fees (`feeCents`) for this owner + status. */
  feeCents: number;
}

/**
 * Per-owner recency of LOST disputes on MEMBERSHIP orders — the seasoning
 * curve's reset signal (a lost dispute within the window pins the owner's
 * reserve at the maximum and freezes releases). Exactly one owner id is set,
 * same denormalised-owner contract as {@link MembershipDisputeExposureRow}.
 *
 * `latestLostAt` is the best available "when was it lost" timestamp: the
 * group-max of `closedAt`, falling back to the group-max of `createdAt` when
 * no LOST row in the group ever had its close stamped. The fallback is a
 * documented approximation: `createdAt` precedes the actual loss, so a
 * fallback row relaxes the curve slightly EARLIER than the truth. Accepted
 * because the Stripe dispute lifecycle stamps `closedAt` on every close —
 * the fallback exists only for hand-written or legacy rows.
 */
export interface OwnerLatestLostMembershipDisputeRow {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  latestLostAt: Date;
}

/**
 * Per-owner count of disputes still in flight (`OPEN` / `UNDER_REVIEW`) —
 * the "more debt may be coming" signal beside a payee's debt position.
 * Exactly one owner id is set, same denormalised-owner contract as
 * {@link MembershipDisputeExposureRow}. Owners with no open dispute are
 * simply absent.
 */
export interface OwnerOpenDisputeCountRow {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  openDisputeCount: number;
}

export interface CountOpenDisputesByOwnersInput {
  orgIds: string[];
  humanIds: string[];
}

export interface UpsertDisputeFromStripeInput {
  stripeDisputeId: string;
  stripeChargeId?: string | null;
  paymentIntentId?: string | null;
  orderId?: string | null;
  ownerSubjectType?: PayeeSubjectType | null;
  ownerSubjectId?: string | null;
  ownerOrgId?: string | null;
  ownerHumanId?: string | null;
  amountCents: number;
  /** Omit to leave a previously-captured fee untouched. */
  feeCents?: number;
  feeBorneBy?: DisputeFeeBearer | null;
  currency: string;
  reason: string;
  status: DisputeStatus;
  triageReason?: string | null;
  linkedAt?: Date | null;
  evidenceDueBy?: Date | null;
  fundsWithdrawnAt?: Date | null;
  closedAt?: Date | null;
  outcome?: string | null;
  metadata?: unknown | null;
}

// ── Evidence-deadline sweep ──────────────────────────────────────────────────

export interface ListOpenDisputesNeedingEvidenceAttentionInput {
  now: Date;
  /** Deadlines at or before `now + dueWithinDays` days count as "due soon". */
  dueWithinDays: number;
  /** Hard cap on rows returned (defaults to, and never exceeds, 200). */
  limit?: number;
}

/**
 * One dispute the daily evidence sweep should look at: still contestable
 * (OPEN / UNDER_REVIEW), linked to an order, nothing submitted yet, and
 * either close to (or past) its deadline, missing a deadline, missing an
 * evidence package, or carrying a failed submit. Enough joined display
 * fields for one alert line; `evidenceStatus` null = never assembled.
 */
export interface DisputeEvidenceAttentionRow {
  id: string;
  stripeDisputeId: string;
  status: DisputeStatus;
  evidenceDueBy: Date | null;
  evidencePastDue: boolean | null;
  amountCents: number;
  currency: string;
  orderId: string;
  eventId: string | null;
  eventTitle: string | null;
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  ownerHumanId: string | null;
  ownerHumanName: string | null;
  evidenceStatus: DisputeEvidenceStatus | null;
}

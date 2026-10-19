import type {
  DisputeEvidenceSources,
  DisputeEvidenceStatus,
  DisputeStatus,
} from "@th/types";
import { getAppErrorCode } from "@/lib/app-error";
import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the dispute desk. No React, no Tamagui — everything here is
// unit-testable without the design system and shared by the queue, the detail
// panel and the evidence editor.
//
// Copy is English literal throughout. // i18n: key pending — the desk is a
// new surface and the locale catalogs are off-limits for this change; see the
// "Roles" nav item precedent in platform/layout.tsx.
// ─────────────────────────────────────────────────────────────────────────────

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

// ── Dispute status ───────────────────────────────────────────────────────────

// Colour carries INTENT only; the label carries identity (OrderStatusBadge's
// rule). OPEN is the one that needs a human today, so it is the only warning.
const DISPUTE_STATUS_META: Record<
  DisputeStatus,
  { label: string; tone: BadgeTone; open: boolean }
> = {
  NEEDS_TRIAGE: { label: "Needs triage", tone: "warning", open: true },
  OPEN: { label: "Needs response", tone: "warning", open: true },
  UNDER_REVIEW: { label: "Under review", tone: "info", open: true },
  WON: { label: "Won", tone: "success", open: false },
  LOST: { label: "Lost", tone: "danger", open: false },
  WARNING_OPEN: { label: "Inquiry open", tone: "warning", open: true },
  WARNING_UNDER_REVIEW: {
    label: "Inquiry under review",
    tone: "info",
    open: true,
  },
  WARNING_CLOSED: { label: "Inquiry closed", tone: "neutral", open: false },
};

export function disputeStatusLabel(status: DisputeStatus): string {
  return DISPUTE_STATUS_META[status]?.label ?? status;
}

export function disputeStatusTone(status: DisputeStatus): BadgeTone {
  return DISPUTE_STATUS_META[status]?.tone ?? "neutral";
}

export function isDisputeOpen(status: DisputeStatus): boolean {
  return DISPUTE_STATUS_META[status]?.open ?? false;
}

// ── Evidence status ──────────────────────────────────────────────────────────

const EVIDENCE_STATUS_META: Record<
  DisputeEvidenceStatus,
  { label: string; tone: BadgeTone }
> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  APPROVED: { label: "Approved", tone: "info" },
  SUBMITTED: { label: "Submitted", tone: "success" },
  SUBMIT_FAILED: { label: "Submit failed", tone: "danger" },
};

export function evidenceStatusLabel(
  status: DisputeEvidenceStatus | null,
): string {
  if (!status) return "Not assembled";
  return EVIDENCE_STATUS_META[status]?.label ?? status;
}

export function evidenceStatusTone(
  status: DisputeEvidenceStatus | null,
): BadgeTone {
  if (!status) return "neutral";
  return EVIDENCE_STATUS_META[status]?.tone ?? "neutral";
}

// ── Reason ───────────────────────────────────────────────────────────────────

/** Stripe's dispute reason enum → plain English. Unknown reasons pass through. */
const REASON_LABELS: Record<string, string> = {
  bank_cannot_process: "Bank cannot process",
  check_returned: "Check returned",
  credit_not_processed: "Credit not processed",
  customer_initiated: "Customer initiated",
  debit_not_authorized: "Debit not authorized",
  duplicate: "Duplicate",
  fraudulent: "Fraudulent",
  general: "General",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  noncompliant: "Noncompliant",
  product_not_received: "Product not received",
  product_unacceptable: "Product unacceptable",
  subscription_canceled: "Subscription canceled",
  unrecognized: "Unrecognized",
};

export function disputeReasonLabel(reason: string): string {
  return lookupOwn(REASON_LABELS, reason) ?? reason.replace(/_/g, " ");
}

// ── Evidence due date ────────────────────────────────────────────────────────

export type DueTreatment = {
  /** Short relative text: "Overdue", "in 3d", "in 5h", "in 12d", or "—". */
  label: string;
  /** Semantic intent; `danger` = overdue, `warning` = due within 3 days. */
  intent: "none" | "warning" | "danger";
  /** True when the deadline has passed (or Stripe says past due). */
  overdue: boolean;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const DUE_SOON_DAYS = 3;

export function dueTreatment(
  dueBy: Date | string | null | undefined,
  now: Date,
  pastDue?: boolean | null,
): DueTreatment {
  if (!dueBy) {
    return { label: "—", intent: "none", overdue: false };
  }
  const due = new Date(dueBy);
  const diff = due.getTime() - now.getTime();
  if (pastDue || diff <= 0) {
    return { label: "Overdue", intent: "danger", overdue: true };
  }
  const days = Math.floor(diff / DAY_MS);
  if (days < 1) {
    const hours = Math.max(1, Math.floor(diff / HOUR_MS));
    return { label: `in ${hours}h`, intent: "warning", overdue: false };
  }
  return {
    label: `in ${days}d`,
    intent: days <= DUE_SOON_DAYS ? "warning" : "none",
    overdue: false,
  };
}

// ── Owner display ────────────────────────────────────────────────────────────

export function ownerDisplay(row: {
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  ownerHumanId: string | null;
  ownerHumanName: string | null;
}): { name: string; kind: "org" | "human" | null } {
  if (row.ownerOrgId) {
    return { name: row.ownerOrgName ?? "Unnamed group", kind: "org" };
  }
  if (row.ownerHumanId) {
    return { name: row.ownerHumanName ?? "Unnamed human", kind: "human" };
  }
  return { name: "—", kind: null };
}

// ── Evidence fields (the 14 editable text keys, in Stripe's order) ──────────

export type EvidenceTextKey =
  | "productDescription"
  | "customerName"
  | "customerEmailAddress"
  | "customerPurchaseIp"
  | "billingAddress"
  | "serviceDate"
  | "refundPolicyDisclosure"
  | "refundRefusalExplanation"
  | "uncategorizedText"
  | "accessActivityLog"
  | "duplicateChargeId"
  | "duplicateChargeExplanation"
  | "cancellationPolicyDisclosure"
  | "cancellationRebuttal";

export interface EvidenceFieldMeta {
  key: EvidenceTextKey;
  /** Stripe's snake_case evidence key — the mono field label. */
  stripeName: string;
  /** What ops should put here. */
  hint: string;
  /** Short fields render a single-line-ish textarea. */
  short?: boolean;
}

export const EVIDENCE_TEXT_FIELDS: readonly EvidenceFieldMeta[] = [
  {
    key: "productDescription",
    stripeName: "product_description",
    hint: "What was sold: event, ticket type, quantity, date, place.",
  },
  {
    key: "customerName",
    stripeName: "customer_name",
    hint: "Buyer's name as entered at checkout.",
    short: true,
  },
  {
    key: "customerEmailAddress",
    stripeName: "customer_email_address",
    hint: "Email the tickets were sent to.",
    short: true,
  },
  {
    key: "customerPurchaseIp",
    stripeName: "customer_purchase_ip",
    hint: "IP address the buyer checked out from.",
    short: true,
  },
  {
    key: "billingAddress",
    stripeName: "billing_address",
    hint: "Billing address as one line.",
    short: true,
  },
  {
    key: "serviceDate",
    stripeName: "service_date",
    hint: "When the event happened, as text.",
    short: true,
  },
  {
    key: "refundPolicyDisclosure",
    stripeName: "refund_policy_disclosure",
    hint: "Where and how the refund policy was shown at purchase.",
  },
  {
    key: "refundRefusalExplanation",
    stripeName: "refund_refusal_explanation",
    hint: "Why a refund was refused, if the buyer asked for one.",
  },
  {
    key: "uncategorizedText",
    stripeName: "uncategorized_text",
    hint: "Anything that fits no other field. Truncated to fit if too long.",
  },
  {
    key: "accessActivityLog",
    stripeName: "access_activity_log",
    hint: "Scan or sign-in log showing the buyer used what they bought.",
  },
  {
    key: "duplicateChargeId",
    stripeName: "duplicate_charge_id",
    hint: "For duplicate disputes: the other charge the buyer means.",
    short: true,
  },
  {
    key: "duplicateChargeExplanation",
    stripeName: "duplicate_charge_explanation",
    hint: "For duplicate disputes: why the two charges are distinct.",
  },
  {
    key: "cancellationPolicyDisclosure",
    stripeName: "cancellation_policy_disclosure",
    hint: "Where and how the cancellation policy was shown at purchase.",
  },
  {
    key: "cancellationRebuttal",
    stripeName: "cancellation_rebuttal",
    hint: "Why the buyer's cancellation claim is wrong.",
  },
];

export const EVIDENCE_FIELD_MAX = 20_000;
export const EVIDENCE_COMBINED_MAX = 150_000;

export type EvidenceDraft = Record<EvidenceTextKey, string>;

/** Server fields → editor draft. Absent keys become "" for the textarea. */
export function draftFromFields(
  fields: Partial<Record<string, string | undefined>> | null | undefined,
): EvidenceDraft {
  const draft = {} as EvidenceDraft;
  for (const meta of EVIDENCE_TEXT_FIELDS) {
    draft[meta.key] = fields?.[meta.key] ?? "";
  }
  return draft;
}

/**
 * Only the keys the operator changed, per the three-way rule on
 * `DisputeEvidenceFields`: an untouched key is OMITTED (leave it alone), a
 * cleared key is sent as `""` (unset at the processor), an edited key carries
 * its new value.
 */
export function changedFields(
  initial: EvidenceDraft,
  current: EvidenceDraft,
): Partial<EvidenceDraft> {
  const out: Partial<EvidenceDraft> = {};
  for (const meta of EVIDENCE_TEXT_FIELDS) {
    const before = normalizeFieldValue(initial[meta.key]);
    const after = normalizeFieldValue(current[meta.key]);
    if (after !== before) out[meta.key] = after;
  }
  return out;
}

/** Whitespace-only is "cleared": Stripe would store the spaces otherwise. */
function normalizeFieldValue(value: string): string {
  return value.trim() === "" ? "" : value;
}

export function isDraftDirty(
  initial: EvidenceDraft,
  current: EvidenceDraft,
): boolean {
  return Object.keys(changedFields(initial, current)).length > 0;
}

/** UTF-16 code units, matching `checkDisputeEvidenceLimits` server-side. */
export function combinedChars(draft: EvidenceDraft): number {
  let total = 0;
  for (const meta of EVIDENCE_TEXT_FIELDS) {
    total += draft[meta.key].length;
  }
  return total;
}

// ── Sources provenance ───────────────────────────────────────────────────────

export type SourceState = "found" | "missing" | "not_applicable";

export interface SourceDisplay {
  key: keyof Omit<DisputeEvidenceSources, "truncated">;
  label: string;
  state: SourceState;
}

const SOURCE_LABELS: Record<keyof Omit<DisputeEvidenceSources, "truncated">, string> =
  {
    order: "Order",
    buyer: "Buyer",
    buyerEmail: "Buyer email",
    checkoutIp: "Checkout IP",
    billingAddress: "Billing address",
    event: "Event",
    venue: "Place",
    organizer: "Organizer",
    refundPolicy: "Refund policy",
    termsAcceptance: "Terms acceptance",
    tickets: "Tickets",
    scanLog: "Scan log",
    refundHistory: "Refund history",
    cardChecks: "AVS / CVC checks",
    ticketEmail: "Ticket email",
    statementDescriptor: "Statement descriptor",
  };

export function sourcesForDisplay(
  sources: DisputeEvidenceSources,
): SourceDisplay[] {
  return (
    Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>
  ).map((key) => ({ key, label: SOURCE_LABELS[key], state: sources[key] }));
}

export function sourceStateLabel(state: SourceState): string {
  switch (state) {
    case "found":
      return "Found";
    case "missing":
      return "Missing";
    case "not_applicable":
      return "N/A";
  }
}

// ── Error decoding ───────────────────────────────────────────────────────────

export interface DecodedDeskError {
  code: string | null;
  /** Plain-English headline for the inline alert. */
  title: string;
  /** Sanitised detail (the server message, when it is a sentence). */
  detail: string | null;
  /** Field-level violations from DISPUTE_EVIDENCE_LIMIT_EXCEEDED. */
  fieldViolations: Array<{ field: EvidenceTextKey; chars: number; max: number }>;
  /** Combined-limit violation, if any. */
  combinedViolation: { chars: number; max: number } | null;
}

function readMeta(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { meta?: unknown } }).data;
  const meta = data?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : null;
}

function readMessage(error: unknown): string | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || message.length === 0) return null;
  // A bare code is not a sentence; only pass through human-readable text.
  return /\s/.test(message) ? message : null;
}

const TEXT_KEYS = new Set<string>(EVIDENCE_TEXT_FIELDS.map((f) => f.key));

/** Wire shape of `meta.violations` on DISPUTE_EVIDENCE_LIMIT_EXCEEDED
 *  (`DisputeEvidenceLimitViolation` in @th/ports/dispute-evidence). */
type LimitViolation =
  | { kind: "field"; field: string; chars: number; max: number }
  | { kind: "combined"; chars: number; max: number };

/**
 * Decode a tRPC mutation error from the desk procedures into something the
 * evidence editor can render inline: a headline, an optional sanitised
 * detail, and the offending fields for the limit case.
 */
export function decodeDeskError(error: unknown): DecodedDeskError {
  const code = getAppErrorCode(error);
  const meta = readMeta(error);
  const message = readMessage(error);
  const base: DecodedDeskError = {
    code,
    title: "Something went wrong",
    detail: message,
    fieldViolations: [],
    combinedViolation: null,
  };

  switch (code) {
    case "DISPUTE_EVIDENCE_LIMIT_EXCEEDED": {
      const violations = Array.isArray(meta?.violations)
        ? (meta!.violations as LimitViolation[])
        : [];
      const fieldViolations: DecodedDeskError["fieldViolations"] = [];
      let combinedViolation: DecodedDeskError["combinedViolation"] = null;
      for (const v of violations) {
        if (v.kind === "field" && TEXT_KEYS.has(v.field)) {
          fieldViolations.push({
            field: v.field as EvidenceTextKey,
            chars: v.chars,
            max: v.max,
          });
        } else if (v.kind === "combined") {
          combinedViolation = { chars: v.chars, max: v.max };
        }
      }
      return {
        ...base,
        title: "Evidence is over Stripe's size limits",
        detail: null,
        fieldViolations,
        combinedViolation,
      };
    }
    case "DISPUTE_NOT_ACCEPTING_EVIDENCE": {
      const processorError =
        typeof meta?.processorError === "string" ? meta.processorError : null;
      return {
        ...base,
        title: "Stripe is not accepting evidence for this dispute",
        detail:
          processorError ??
          message ??
          "The dispute is no longer waiting on a response, or the deadline has passed.",
      };
    }
    case "DISPUTE_EVIDENCE_STATE_INVALID":
      if (meta?.inFlight === true) {
        return {
          ...base,
          title: "Another operator is working on this package",
          detail: message ?? "Try again in a moment.",
        };
      }
      return {
        ...base,
        title: "The evidence package changed under you",
        detail: message ?? "Reload to see its current state.",
      };
    case "DISPUTE_EVIDENCE_SUBMIT_FAILED": {
      const processorError =
        typeof meta?.processorError === "string" ? meta.processorError : null;
      return {
        ...base,
        title: "Stripe rejected the submission",
        detail: processorError ?? message,
      };
    }
    case "STAFF_ONLY":
    case "FORBIDDEN":
    case "INSUFFICIENT_ROLE":
      return {
        ...base,
        title: "You do not have permission to do that",
        detail: null,
      };
    default:
      return base;
  }
}

/** Convenience: which text fields carry a violation (for highlighting). */
export function violatedFieldKeys(
  decoded: DecodedDeskError | null,
): Set<EvidenceTextKey> {
  return new Set(decoded?.fieldViolations.map((v) => v.field) ?? []);
}


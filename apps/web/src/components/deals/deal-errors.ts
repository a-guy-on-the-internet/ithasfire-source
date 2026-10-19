import { getAppErrorCode } from "@/lib/app-error";

import type { DealNotEditableReason } from "./deal-model";

// ─────────────────────────────────────────────────────────────────────────────
// What a deal read or write refused, in the editor's terms.
//
// The deals router maps two kinds of refusal (packages/transport/trpc utils
// `toTrpcError`): an AppError (`data.appCode`, domain meta on `data.meta`),
// and a lowercase use-case refusal whose code rides the MESSAGE
// (`fail("conflict", "deal_terms_changed")` → message "deal_terms_changed").
// Both are read here, so a component never parses an error itself.
// ─────────────────────────────────────────────────────────────────────────────

function metaOf(error: unknown): Record<string, unknown> {
  const meta = (error as { data?: { meta?: unknown } } | null)?.data?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : {};
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

export type DealReadOutcome =
  /** No terms on this event / no default yet: the empty state and the presets. */
  | { kind: "NO_DEAL" }
  /** The event's deal lives in its booking: a link, not an error. */
  | { kind: "OWNED_BY_BOOKING"; agreementId: string }
  /**
   * A booking agreement made without a payout-terms row (older agreements):
   * there is no deal to show or write, which is a fact about the agreement,
   * not a failure to retry.
   */
  | { kind: "NO_TERMS" }
  /** The viewer may not see this deal at all. */
  | { kind: "NOT_ALLOWED" }
  | { kind: "ERROR" };

export function classifyDealReadError(error: unknown): DealReadOutcome {
  const code = getAppErrorCode(error);
  const meta = metaOf(error);
  if (
    code === "PAYOUT_TERMS_NOT_FOUND" &&
    (meta.reason === "event_has_no_terms_yet" ||
      meta.reason === "org_has_no_default_terms_yet")
  ) {
    return { kind: "NO_DEAL" };
  }
  if (
    code === "AGREEMENT_FINALIZED" &&
    meta.reason === "event_terms_owned_by_booking" &&
    typeof meta.agreementId === "string"
  ) {
    return { kind: "OWNED_BY_BOOKING", agreementId: meta.agreementId };
  }
  if (code === "AGREEMENT_MISSING_PAYOUT_TERMS") return { kind: "NO_TERMS" };
  if (
    code === "INSUFFICIENT_ROLE" ||
    code === "FORBIDDEN" ||
    code === "NOT_AGREEMENT_PARTY"
  )
    return { kind: "NOT_ALLOWED" };
  return { kind: "ERROR" };
}

/** The catalog key that explains why a deal is read-only. */
export const NOT_EDITABLE_KEYS: Record<DealNotEditableReason, string> = {
  not_payout_editor: "deals.notEditable.notPayoutEditor",
  booking_not_editable: "deals.notEditable.bookingNotEditable",
  terms_is_default: "deals.notEditable.termsIsDefault",
  event_archived: "deals.notEditable.eventArchived",
  event_cancelled: "deals.notEditable.eventCancelled",
  event_terms_shared: "deals.notEditable.eventTermsShared",
  org_inactive: "deals.notEditable.orgInactive",
  default_terms_shared: "deals.notEditable.defaultTermsShared",
};

// setTermsDeal's own conflicts: `fail("conflict", "<code>")`, so the code is
// the message (appCode CONFLICT).
const CONFLICT_MESSAGES = new Set([
  "deal_terms_changed",
  "deal_event_owner_changed",
]);

// `fail("invalid_input", "<code>")` from set-terms-deal, set-agreement-deal
// and lib/settlement/deal-terms: the code is the message (appCode INVALID_INPUT).
const MESSAGE_KEYS: Record<string, string> = {
  deal_payee_has_scoped_per_order_line: "deals.errors.scopedPerOrderLine",
  deal_payee_has_several_per_order_lines: "deals.errors.scopedPerOrderLine",
  deal_remainder_not_the_event_owner: "deals.errors.remainderNotOwner",
  deal_percent_over_100: "deals.errors.percentOver100",
  deal_per_order_percent_over_100: "deals.errors.perOrderPercentOver100",
  deal_clause_zero_percent: "deals.errors.clauseZeroPercent",
  deal_duplicate_per_order_payee: "deals.errors.duplicatePerOrderPayee",
  deal_remainder_not_a_party: "deals.errors.remainderNotAParty",
  deal_remainder_not_the_org: "deals.errors.remainderNotTheOrg",
  deal_room_rental_remainder_is_the_renter: "deals.errors.rentalRestIsRenter",
  // An agreement's deal: the act's fixed parts become the header guarantee.
  deal_guarantee_too_large: "deals.errors.guaranteeTooLarge",
};

export type DealWriteFailure =
  /** Someone else changed the deal: say so, then refetch. */
  | { kind: "CONFLICT"; key: string }
  /** A known refusal with its own copy. */
  | { kind: "KNOWN"; key: string }
  /** Anything else: `formatErrorMessage(err, t)`. */
  | { kind: "OTHER" };

export function classifyDealWriteError(error: unknown): DealWriteFailure {
  const message = messageOf(error);
  if (CONFLICT_MESSAGES.has(message))
    return { kind: "CONFLICT", key: "deals.errors.changed" };

  const code = getAppErrorCode(error);
  const meta = metaOf(error);
  // The deal froze under the open form (first publish, or someone pressed
  // Freeze): refetch, so the page shows it frozen and the way to change it.
  if (code === "DEAL_FROZEN")
    return { kind: "CONFLICT", key: "deals.freeze.frozeUnder" };
  if (code === "SPLITS_CAPS_UNSATISFIABLE") {
    return { kind: "KNOWN", key: "deals.errors.capsUnsatisfiable" };
  }
  if (code === "AGREEMENT_NOT_EDITABLE") {
    const reason = meta.reason;
    if (typeof reason === "string" && reason in NOT_EDITABLE_KEYS) {
      return {
        kind: "KNOWN",
        key: NOT_EDITABLE_KEYS[reason as DealNotEditableReason],
      };
    }
    return { kind: "KNOWN", key: "deals.errors.notEditable" };
  }
  if (code === "AGREEMENT_FINALIZED")
    return { kind: "KNOWN", key: "deals.errors.finalized" };
  if (code === "EVENT_ARCHIVED")
    return { kind: "KNOWN", key: NOT_EDITABLE_KEYS.event_archived };
  if (code === "EVENT_CANCELLED")
    return { kind: "KNOWN", key: NOT_EDITABLE_KEYS.event_cancelled };
  if (code === "INSUFFICIENT_ROLE")
    return { kind: "KNOWN", key: NOT_EDITABLE_KEYS.not_payout_editor };
  // set-terms-deal refuses a deal for a group that is not active.
  if (code === "ORGANIZATION_INACTIVE")
    return { kind: "KNOWN", key: NOT_EDITABLE_KEYS.org_inactive };
  if (code === "PAYEE_NOT_READY")
    return { kind: "KNOWN", key: "deals.errors.payeeNotReady" };

  const key = MESSAGE_KEYS[message];
  if (key) return { kind: "KNOWN", key };
  return { kind: "OTHER" };
}

/**
 * `bookingAgreements.updateHeader` refused a guarantee change because The
 * deal sets it now (AGREEMENT_NOT_EDITABLE, reason `guarantee_set_by_deal`):
 * the header was read before the deal existed. Refetch and point at the deal.
 */
export function isGuaranteeSetByDealError(error: unknown): boolean {
  return (
    getAppErrorCode(error) === "AGREEMENT_NOT_EDITABLE" &&
    metaOf(error).reason === "guarantee_set_by_deal"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The resale clause (organiser-resale-share, board RC1): what
// `deals.setResaleClause` refuses, in plain words. Every refusal the writer
// and its gates can raise has a key; only a lookup failure (an event or group
// that vanished) falls to `formatErrorMessage`.
// ─────────────────────────────────────────────────────────────────────────────

const RESALE_CONFLICT_MESSAGES = new Set([
  "resale_clause_changed",
  "deal_terms_changed",
  "deal_event_owner_changed",
]);

const RESALE_NOT_EDITABLE_REASON_KEYS: Record<string, string> = {
  event_resale_owned_by_booking: "deals.resale.notEditable.ownedByBooking",
  agreement_has_no_event_yet: "deals.resale.notEditable.noEventYet",
  event_terms_shared: "deals.resale.notEditable.termsShared",
  default_terms_shared: "deals.resale.notEditable.termsShared",
  not_resale_terms: "deals.resale.notEditable.termsLocked",
  terms_archived: "deals.resale.notEditable.termsLocked",
};

export function classifyResaleWriteError(error: unknown): DealWriteFailure {
  const message = messageOf(error);
  if (RESALE_CONFLICT_MESSAGES.has(message)) {
    return { kind: "CONFLICT", key: "deals.resale.errors.changed" };
  }
  const code = getAppErrorCode(error);
  const meta = metaOf(error);
  switch (code) {
    case "DEAL_FROZEN":
      return { kind: "CONFLICT", key: "deals.freeze.frozeUnder" };
    case "AGREEMENT_NOT_EDITABLE": {
      const reason = typeof meta.reason === "string" ? meta.reason : "";
      return {
        kind: "KNOWN",
        // No reason: the event's RESALE terms are a shared default row.
        key:
          RESALE_NOT_EDITABLE_REASON_KEYS[reason] ??
          "deals.resale.notEditable.termsLocked",
      };
    }
    case "AGREEMENT_MISSING_LINES":
      return { kind: "KNOWN", key: "deals.resale.errors.missingLines" };
    case "RESALE_SHARE_IN_USE":
      return { kind: "KNOWN", key: "deals.resale.errors.inUse" };
    case "INSUFFICIENT_ROLE":
      return { kind: "KNOWN", key: "deals.resale.notEditable.notPayoutEditor" };
    case "EVENT_ARCHIVED":
      return { kind: "KNOWN", key: "deals.resale.notEditable.eventArchived" };
    case "EVENT_CANCELLED":
      return { kind: "KNOWN", key: "deals.resale.notEditable.eventCancelled" };
    case "ORGANIZATION_INACTIVE":
      return { kind: "KNOWN", key: NOT_EDITABLE_KEYS.org_inactive };
    // The booking gate: no longer a DRAFT, the act's side, not an edit-level party.
    case "AGREEMENT_NOT_DRAFT":
    case "TERMS_EDITOR_ONLY":
    case "NOT_AGREEMENT_PARTY":
      return { kind: "KNOWN", key: "deals.resale.notEditable.bookingNotEditable" };
    // The terms row went away under the form: reload, like a conflict.
    case "PAYOUT_TERMS_NOT_FOUND":
      return { kind: "CONFLICT", key: "deals.resale.errors.changed" };
    // The clause failed the server's parse (the form checks first).
    case "INVALID_INPUT":
      return { kind: "KNOWN", key: "deals.resale.errors.invalid" };
  }
  return { kind: "OTHER" };
}

/** A failed `deals.getResaleClause`: hidden for someone who may not see it. */
export function classifyResaleReadError(
  error: unknown,
): "NOT_ALLOWED" | "ERROR" {
  const code = getAppErrorCode(error);
  return code === "INSUFFICIENT_ROLE" ||
    code === "FORBIDDEN" ||
    code === "NOT_AGREEMENT_PARTY" ||
    code === "AGREEMENT_MISSING_PAYOUT_TERMS"
    ? "NOT_ALLOWED"
    : "ERROR";
}

/**
 * Shared display + form helpers for booking Agreements (the two-party
 * negotiation editor at /agreements/[agreementId] and its entry points).
 * Status set mirrors `agreementStatusSchema` in
 * `packages/core/src/use-cases/booking-agreements/list-booking-agreements.ts`.
 *
 * Pure (no React) so the parsing/matching rules can be unit-tested like
 * `request-to-play-form.helpers`.
 */

import { lookupOwn } from "./lookup-own";

export type AgreementStatus =
  | "DRAFT"
  | "PROPOSED"
  | "COUNTERED"
  | "ACCEPTED"
  | "DECLINED"
  | "CANCELLED"
  | "FULFILLED"
  | "EXPIRED"
  | "DISPUTED";

export const AGREEMENT_STATUS_LABEL_KEYS: Record<AgreementStatus, string> = {
  DRAFT: "admin.baStatusDraft",
  PROPOSED: "admin.baStatusProposed",
  COUNTERED: "admin.baStatusCountered",
  ACCEPTED: "admin.baStatusAccepted",
  DECLINED: "admin.baStatusDeclined",
  CANCELLED: "admin.baStatusCancelled",
  FULFILLED: "admin.baStatusFulfilled",
  EXPIRED: "admin.baStatusExpired",
  DISPUTED: "admin.baStatusDisputed",
};

export function agreementStatusTone(
  status: AgreementStatus,
): "success" | "info" | "warning" | "neutral" | "danger" {
  switch (status) {
    case "DRAFT":
      return "info";
    case "PROPOSED":
    case "COUNTERED":
      return "warning";
    case "ACCEPTED":
    case "FULFILLED":
      return "success";
    case "DECLINED":
    case "CANCELLED":
    case "DISPUTED":
      return "danger";
    default:
      return "neutral";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Money / percent input parsing (integer cents + integer percent — no floats
// on the wire; see NFR-002)
// ─────────────────────────────────────────────────────────────────────────────

const DOLLARS_RE = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * Parse a dollars text input into integer cents.
 * Returns `null` for invalid input (negative, >2 decimals, not a number).
 * Empty/whitespace input is the caller's "cleared" case — handled before this.
 */
export function dollarsToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!DOLLARS_RE.test(trimmed)) return null;
  // String math avoids float drift on e.g. "0.29".
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Integer cents → dollars text suitable for re-seeding the input. */
export function centsToDollarsInput(cents: number | null): string {
  if (cents === null) return "";
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** Parse a whole-number percent (0–100). Returns `null` when invalid. */
export function percentFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 100 ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Basis points ↔ percent text (counter asks travel as integer bps on the
// wire; line percents stay whole integers — see counter form in
// PayoutLinesSection)
// ─────────────────────────────────────────────────────────────────────────────

const PERCENT_BPS_RE = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * Parse a percent text input (0–100, up to 2 decimals) into integer basis
 * points. String math — no float drift on e.g. "12.3". Returns `null` for
 * invalid input.
 */
export function percentTextToBps(text: string): number | null {
  const trimmed = text.trim();
  if (!PERCENT_BPS_RE.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  return bps >= 0 && bps <= 10000 ? bps : null;
}

/** Integer basis points → display percent text (1250 → "12.5", 1234 → "12.34"). */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return `${whole}.${frac / 10}`;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/**
 * Whole percent for a bps value when exact, else `null`. Gates the
 * "Apply counter" affordance — line percents are integers, so a fractional
 * ask (e.g. 12.5%) can't be applied verbatim.
 */
export function bpsToWholePercent(bps: number): number | null {
  return bps % 100 === 0 ? bps / 100 : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-line confirmation — who can confirm / counter / decline a line
// ─────────────────────────────────────────────────────────────────────────────

export type AgreementLineSubject = {
  subjectType: "human" | "organization" | null;
  subjectId: string | null;
  requiresConfirmation: boolean;
  confirmationStatus: "PENDING" | "CONFIRMED" | "COUNTERED" | "DECLINED" | null;
};

export type ViewerIdentity = {
  humanId: string | null;
  /** Org ids where the viewer is OWNER or ADMIN (mirrors confirm-payout-line RBAC). */
  adminOrgIds: string[];
};

/**
 * Client-side mirror of `confirmPayoutLine`'s auth rule (server re-checks):
 * the viewer is the line's human payee, or an OWNER/ADMIN of its org payee,
 * and the line is still actionable — PENDING, or COUNTERED (the payee may
 * accept the original terms, update their own ask, or decline; matches the
 * use case's per-line state machine). CONFIRMED and DECLINED lines only
 * change via a DRAFT economics edit, which resets them to PENDING.
 */
export function canViewerConfirmLine(
  line: AgreementLineSubject,
  viewer: ViewerIdentity,
): boolean {
  if (
    !line.requiresConfirmation ||
    (line.confirmationStatus !== "PENDING" &&
      line.confirmationStatus !== "COUNTERED")
  ) {
    return false;
  }
  if (!line.subjectId) return false;
  if (line.subjectType === "human") {
    return viewer.humanId !== null && viewer.humanId === line.subjectId;
  }
  if (line.subjectType === "organization") {
    return viewer.adminOrgIds.includes(line.subjectId);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Negotiation actions — who may respond / pull back / finalize
// ─────────────────────────────────────────────────────────────────────────────

export type AgreementParties = {
  proposerType: "human" | "organization";
  proposerId: string;
  counterpartyType: "human" | "organization";
  counterpartyId: string;
};

export type ViewerActIdentity = {
  humanId: string | null;
  /** Org ids where the viewer is OWNER, ADMIN, or EDITOR (mirrors ORG_EDIT_ROLES). */
  editOrgIds: string[];
};

/**
 * Client-side mirror of `requireAgreementParty` with ORG_EDIT_ROLES (the
 * server re-checks): sendForReview/respond/pullBack/finalize require the
 * actor to BE a party — the human party themselves, or an
 * OWNER/ADMIN/EDITOR of an org party. FINANCE/VIEWER/SCANNER members can
 * view but not act, so the UI hides the action buttons for them.
 */
export function canViewerActOnAgreement(
  agreement: AgreementParties,
  viewer: ViewerActIdentity,
): boolean {
  const partyMatches = (type: "human" | "organization", id: string): boolean =>
    type === "human"
      ? viewer.humanId !== null && viewer.humanId === id
      : viewer.editOrgIds.includes(id);
  return (
    partyMatches(agreement.proposerType, agreement.proposerId) ||
    partyMatches(agreement.counterpartyType, agreement.counterpartyId)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize error mapping (codes thrown by finalize-booking-agreement)
// ─────────────────────────────────────────────────────────────────────────────

export type FinalizeErrorKey =
  | "admin.baErrLinesUnconfirmed"
  | "admin.baErrPayeeNotReady"
  | "admin.baErrEventHasAgreement"
  | "admin.baErrAgreementFinalized";

const FINALIZE_ERROR_KEYS: Record<string, FinalizeErrorKey> = {
  lines_unconfirmed: "admin.baErrLinesUnconfirmed",
  payee_not_ready: "admin.baErrPayeeNotReady",
  event_already_has_agreement: "admin.baErrEventHasAgreement",
  // Not thrown by finalize itself (it's the line-mutation guard in
  // core/_shared/agreement-lines.ts); kept so a future shared error path
  // maps cleanly instead of falling back to the raw message.
  agreement_finalized: "admin.baErrAgreementFinalized",
};

/** Map a finalize use-case error message to its i18n key (null = generic). */
export function finalizeErrorKey(message: string | undefined): FinalizeErrorKey | null {
  if (!message) return null;
  return lookupOwn(FINALIZE_ERROR_KEYS, message) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terms-mutation error mapping (header / lines / send / pull back / reopen)
// ─────────────────────────────────────────────────────────────────────────────

export type AgreementActionErrorKey =
  | "admin.baErrTermsEditorOnly"
  | "admin.baErrActResponseOnly"
  | "admin.baErrAgreementFinalized"
  | "admin.baErrAgreementNotCancellable";

/**
 * Codes the terms mutations throw that deserve their own copy rather than the
 * generic "action failed" line. `TERMS_EDITOR_ONLY` is the act side trying to
 * change terms it can only accept or decline (`_shared/agreement-editor-side.ts`);
 * the UI already hides those affordances, so reaching this means a stale
 * page or a direct call — the copy explains the rule rather than the failure.
 *
 * Keyed by the canonical SCREAMING_SNAKE code, which is what `AppError.message`
 * carries through the tRPC boundary (`errors.termsEditorOnly` also exists for
 * the generic `formatErrorMessage(err, t)` path).
 */
const AGREEMENT_ACTION_ERROR_KEYS: Record<string, AgreementActionErrorKey> = {
  TERMS_EDITOR_ONLY: "admin.baErrTermsEditorOnly",
  // The inverse: the editor trying to accept/decline its own proposal.
  ACT_RESPONSE_ONLY: "admin.baErrActResponseOnly",
  // Cancel / reopen against an agreement an event is already stamped on
  // (FORBIDDEN, not CONFLICT — so it reaches this map, not the refresh toast).
  AGREEMENT_FINALIZED: "admin.baErrAgreementFinalized",
  // Cancel from a status that is already terminal. The server sends CONFLICT
  // for this, which the editor turns into the refresh toast first; kept so a
  // caller that reads the message still gets the rule.
  AGREEMENT_NOT_CANCELLABLE: "admin.baErrAgreementNotCancellable",
};

/** Map a terms-mutation error message to its i18n key (null = generic). */
export function agreementActionErrorKey(
  message: string | undefined,
): AgreementActionErrorKey | null {
  if (!message) return null;
  return lookupOwn(AGREEMENT_ACTION_ERROR_KEYS, message) ?? null;
}

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { computeOrderSplits } from "@th/core/lib/pricing/compute-order-splits";
import {
  RESALE_SHARE_MAX_BPS,
  computeResaleShare,
} from "@th/core/lib/pricing/resale-pricing";

import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

// ─────────────────────────────────────────────────────────────────────────────
// The resale clause in The deal (organiser-resale-share FR-001, FR-002,
// FR-011; board RC1). Pure: the form's values, their parse into the clause
// `deals.setResaleClause` takes, and the worked example.
//
// The example is priced by the SAME functions the server charges with
// (NFR-002): `computeResaleShare` for the share, the seller's money and the
// buyer's price, and `computeOrderSplits` for each recipient's part of the
// share, exactly as finalize splits it over the RESALE lines. Nothing is
// summed here.
// ─────────────────────────────────────────────────────────────────────────────

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ResaleClauseRead = RouterOutputs["deals"]["getResaleClause"];
export type ResaleClauseView = NonNullable<ResaleClauseRead["clause"]>;
export type ResaleRecipient = NonNullable<ResaleClauseRead["recipients"]>[number];
export type ResaleNotEditableReason = NonNullable<
  ResaleClauseRead["notEditableReason"]
>;
export type ResaleShareType = ResaleClauseView["type"];
export type ResaleSharePayer = ResaleClauseView["payer"];

/** What `setResaleClause` takes as `clause` (null clears it). */
export type ResaleClauseWrite =
  | { type: "PERCENT"; bps: number; payer: ResaleSharePayer }
  | { type: "FLAT"; cents: number; payer: ResaleSharePayer };

/** The worked example on the board: first sold at $40, resold for $50. */
export const RESALE_EXAMPLE = { originalCents: 4000, askCents: 5000 } as const;

/** The 10% limit, as a whole percentage, for copy. */
export const RESALE_LIMIT_PERCENT = RESALE_SHARE_MAX_BPS / 100;

export type ResaleForm = {
  type: ResaleShareType;
  /** As typed: a percentage ("7.5") or dollars ("2.50"). */
  amountText: string;
  payer: ResaleSharePayer;
};

/** "10", "7.5", "0.25": basis points as the percentage a person types. */
export function percentTextOfBps(bps: number): string {
  return String(bps / 100);
}

/** "2", "2.50": cents as the dollars a person types. */
export function dollarsTextOfCents(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The form for a stored clause; not set starts as a blank percentage paid by the seller. */
export function formOfClause(clause: ResaleClauseView | null): ResaleForm {
  if (!clause) return { type: "PERCENT", amountText: "", payer: "SELLER" };
  return {
    type: clause.type,
    amountText:
      clause.type === "PERCENT"
        ? percentTextOfBps(clause.bps ?? 0)
        : dollarsTextOfCents(clause.cents ?? 0),
    payer: clause.payer,
  };
}

export type ResaleFormError = "percentInvalid" | "overLimit" | "flatInvalid";

/**
 * The form as a clause, or why it isn't one. A percentage takes up to two
 * decimals, with a point or a comma (basis points are whole), and at most 10%;
 * zero is allowed. A flat
 * amount is dollars above zero; it is held to 10% of each sale by pricing,
 * not refused here.
 */
export function parseResaleForm(
  form: ResaleForm,
):
  | { ok: true; clause: ResaleClauseWrite }
  | { ok: false; error: ResaleFormError } {
  const text = form.amountText.trim();
  if (form.type === "PERCENT") {
    // "7,5" as typed in Spanish is 7.5.
    const typed = text.replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(typed) && !/^\.\d{1,2}$/.test(typed)) {
      return { ok: false, error: "percentInvalid" };
    }
    const bps = Math.round(Number(typed) * 100);
    if (!Number.isFinite(bps)) return { ok: false, error: "percentInvalid" };
    if (bps > RESALE_SHARE_MAX_BPS) return { ok: false, error: "overLimit" };
    return { ok: true, clause: { type: "PERCENT", bps, payer: form.payer } };
  }
  const parsed = parseMoneyInputToCents(text);
  if (!parsed.ok || parsed.cents <= 0) return { ok: false, error: "flatInvalid" };
  return { ok: true, clause: { type: "FLAT", cents: parsed.cents, payer: form.payer } };
}

/** Is the write the same clause as the one stored (nothing to save)? */
export function sameResaleClause(
  stored: ResaleClauseView | null,
  next: ResaleClauseWrite | null,
): boolean {
  if (stored === null || next === null) return stored === null && next === null;
  if (stored.type !== next.type || stored.payer !== next.payer) return false;
  return next.type === "PERCENT"
    ? stored.bps === next.bps
    : stored.cents === next.cents;
}

/** A stored clause as a write (the view carries nulls for the other type). */
export function writeOfView(view: ResaleClauseView): ResaleClauseWrite {
  return view.type === "PERCENT"
    ? { type: "PERCENT", bps: view.bps ?? 0, payer: view.payer }
    : { type: "FLAT", cents: view.cents ?? 0, payer: view.payer };
}

export type ResaleExample = {
  originalCents: number;
  askCents: number;
  /** Before processing and tax: the ask, plus the share when the buyer pays it. */
  buyerPaysCents: number;
  sellerReceivesCents: number;
  shareCents: number;
  /** A flat amount held to 10% of this sale. */
  held: boolean;
  /**
   * Each recipient's part of the share, as finalize splits it. Null when it
   * can't be shown honestly: no recipients yet, or a line limited to one
   * ticket type (its part depends on which ticket is sold).
   */
  parts: { lineId: string; name: string | null; cents: number }[] | null;
};

/**
 * What splitting needs from a line. A saved recipient has all of it; so does
 * a line in the event's RESALE lines editor before it is saved.
 */
export type PortionLine = Pick<
  ResaleRecipient,
  "lineId" | "payeeId" | "percent" | "capPercent" | "priority" | "ticketTypeId"
> & { rounding?: ResaleRecipient["rounding"]; name?: string | null };

/** Can each line's part be shown honestly? Not with nobody, nor with a line limited to one ticket type. */
function splittable(
  recipients: readonly PortionLine[] | null,
): recipients is readonly PortionLine[] {
  return (
    !!recipients &&
    recipients.length > 0 &&
    recipients.every((r) => r.ticketTypeId === null)
  );
}

/**
 * An amount split over the RESALE lines exactly as finalize splits it
 * (`computeOrderSplits`: each line's percentage, floored, then what is left
 * handed round the lines a cent at a time, caps respected). Null when it
 * can't be shown honestly (`splittable`).
 */
function splitByLine(
  amountCents: number,
  recipients: readonly PortionLine[] | null,
): { lineId: string; name: string | null; cents: number }[] | null {
  if (!splittable(recipients)) return null;
  // computeOrderSplits sorts its lines by priority (high first), then payee
  // id; a stable sort here with the same comparator puts ours in its order,
  // so its splits zip back to our lines by index, even when one payee holds
  // two lines.
  const ordered = [...recipients].sort(
    (a, b) => b.priority - a.priority || a.payeeId.localeCompare(b.payeeId),
  );
  const split = computeOrderSplits({
    amountCents,
    lines: ordered.map((r) => ({
      id: r.lineId,
      payeeId: r.payeeId,
      percent: r.percent,
      capPercent: r.capPercent,
      priority: r.priority,
      rounding: r.rounding ?? "FLOOR",
    })),
  });
  return split.splits.map((s, i) => ({
    lineId: ordered[i]!.lineId,
    name: ordered[i]!.name ?? null,
    cents: s.amountCents,
  }));
}

/** The amount each line's portion is measured on: fine enough for one decimal. */
const PORTION_BASIS_CENTS = 100_000;

/**
 * Each line's portion of the resale share, as finalize will actually pay it,
 * keyed by line. A line's stored percentage is not its portion: whatever the
 * percentages leave over is handed round the lines too, so a lone 0% line
 * receives the whole share. "all" when a line gets every cent; otherwise a
 * percentage to one decimal. Null when it depends on the ticket sold, or
 * nobody receives it yet.
 */
export function recipientPortions(
  recipients: readonly PortionLine[] | null,
): Map<string, "all" | number> | null {
  const parts = splitByLine(PORTION_BASIS_CENTS, recipients);
  if (!parts) return null;
  return new Map(
    parts.map((p) => [
      p.lineId,
      p.cents === PORTION_BASIS_CENTS
        ? "all"
        : Math.round((p.cents / PORTION_BASIS_CENTS) * 1000) / 10,
    ]),
  );
}

/** The worked example for a clause, priced by the server's own functions. */
export function resaleExample(
  clause: ResaleClauseWrite,
  recipients: readonly ResaleRecipient[] | null,
): ResaleExample {
  const share = computeResaleShare({
    askCents: RESALE_EXAMPLE.askCents,
    clause,
  });
  const parts = splitByLine(share.shareCents, recipients);
  return {
    originalCents: RESALE_EXAMPLE.originalCents,
    askCents: share.askCents,
    buyerPaysCents: share.basisCents,
    sellerReceivesCents: share.sellerReceivesCents,
    shareCents: share.shareCents,
    held: share.shareHeld,
    parts,
  };
}

/** The catalog key for why the clause is read-only. */
export const RESALE_NOT_EDITABLE_KEYS: Record<ResaleNotEditableReason, string> = {
  not_payout_editor: "deals.resale.notEditable.notPayoutEditor",
  booking_not_editable: "deals.resale.notEditable.bookingNotEditable",
  agreement_has_no_event_yet: "deals.resale.notEditable.noEventYet",
  resale_owned_by_booking: "deals.resale.notEditable.ownedByBooking",
  event_archived: "deals.resale.notEditable.eventArchived",
  event_cancelled: "deals.resale.notEditable.eventCancelled",
  terms_shared: "deals.resale.notEditable.termsShared",
  terms_locked: "deals.resale.notEditable.termsLocked",
  org_inactive: "deals.notEditable.orgInactive",
  no_recipients_yet: "deals.resale.noRecipients",
};

/**
 * The clause in plain words: the main sentence (bold on the board) by type,
 * then who pays it. Catalog keys and their values; the copy is the catalog's.
 */
export function resaleSentenceOf(clause: ResaleClauseWrite): {
  mainKey: string;
  percent: string;
  amountCents: number | null;
  payerKey: string;
} {
  return {
    mainKey:
      clause.type === "PERCENT"
        ? "deals.resale.sentencePercent"
        : "deals.resale.sentenceFlat",
    percent: clause.type === "PERCENT" ? percentTextOfBps(clause.bps) : "",
    amountCents: clause.type === "FLAT" ? clause.cents : null,
    payerKey:
      clause.payer === "BUYER"
        ? "deals.resale.sentenceBuyer"
        : "deals.resale.sentenceSeller",
  };
}

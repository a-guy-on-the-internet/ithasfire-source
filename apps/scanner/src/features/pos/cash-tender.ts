/**
 * The cash sheet's arithmetic and the done screen's words.
 *
 * The only sums here are on what the operator TYPED (cash received) against
 * the server's cash total, to say "change $X" or "$X short" before they press
 * Confirm. The server re-prices the sale, refuses a short amount
 * (CASH_AMOUNT_SHORT) and returns the change it worked out; the done screen
 * shows the server's figure, never this one.
 *
 * Integer cents throughout. The typed amount is parsed as text, never through
 * `parseFloat(...) * 100` (19.99 → 1998.9999…).
 */
import { currencyFractionDigits, formatCents } from "@th/types";

import { formatMoney, maskEmail } from "./sell-quote";

/*
 * Every amount is in the currency's MINOR units, and the field takes as many
 * decimals as the currency has (`currencyFractionDigits`, the same table
 * `formatCents` formats with): two for USD, none for JPY. `fractions`
 * defaults to two so the USD door reads plainly at the call site.
 */

/** The currency's symbol as the till formats it: "$", "CA$", "€", "¥". */
export function currencySymbol(currency: string): string {
  return formatCents(0, currency).replace(/[\d\s.,\u00a0]/g, "");
}

/** Keeps digits and one decimal point with at most `fractions` decimals. */
export function sanitizeCashInput(next: string, fractions = 2): string {
  const cleaned = next.replace(/[^0-9.]/g, "");
  if (fractions === 0) return cleaned.split(".")[0] ?? "";
  const parts = cleaned.split(".");
  return parts.length <= 1
    ? cleaned
    : `${parts[0]}.${parts.slice(1).join("").slice(0, fractions)}`;
}

/** "43.7" → 4370, "" → 0, "." → 0. Expects `sanitizeCashInput` output. */
export function parseCashInput(raw: string, fractions = 2): number {
  const [wholeRaw = "", fracRaw = ""] = sanitizeCashInput(raw, fractions).split(".");
  const whole = wholeRaw === "" ? 0 : Number.parseInt(wholeRaw, 10);
  const scale = 10 ** fractions;
  if (fractions === 0) return whole;
  const frac = Number.parseInt(fracRaw.padEnd(fractions, "0").slice(0, fractions), 10);
  return whole * scale + (Number.isNaN(frac) ? 0 : frac);
}

/** 4370 → "43.70": the input field's text for an amount. */
export function centsToInput(cents: number, fractions = 2): string {
  const safe = Math.max(0, Math.round(cents));
  if (fractions === 0) return String(safe);
  const scale = 10 ** fractions;
  return `${Math.floor(safe / scale)}.${String(safe % scale).padStart(fractions, "0")}`;
}

/** Decimals the cash field takes for this currency. */
export function cashFractions(currency: string): number {
  return currencyFractionDigits(currency);
}

/**
 * The quick-amount chips after "Exact": the bills a buyer is likely to hand
 * over for this total. The next $10 above the total, the $10 after that, and
 * the next $100 above both. $43.70 → $50, $60, $100. A $0 total (free with a
 * code) gets no bills. Steps are 1,000 and 10,000 minor units: US bills. Other
 * currencies get the same steps, which is only a shortcut; "Exact" and the
 * field always work.
 */
export function quickCashAmounts(dueCents: number): number[] {
  if (dueCents <= 0) return [];
  const nextTen = (Math.floor(dueCents / 1_000) + 1) * 1_000;
  const tenAfter = nextTen + 1_000;
  const nextHundred = (Math.floor(tenAfter / 10_000) + 1) * 10_000;
  return Array.from(new Set([nextTen, tenAfter, nextHundred]));
}

export type CashSheetView = {
  /** Received − due, when it covers it; 0 otherwise. */
  changeCents: number;
  /** Due − received, when it falls short; 0 otherwise. */
  shortCents: number;
  /** Confirm stays off until the amount covers the due total. */
  covers: boolean;
};

export function cashSheetView(
  dueCents: number,
  receivedCents: number,
): CashSheetView {
  const covers = receivedCents >= dueCents;
  return {
    covers,
    changeCents: covers ? receivedCents - dueCents : 0,
    shortCents: covers ? 0 : dueCents - receivedCents,
  };
}

/** The amber line under a short amount (board S3). */
export function cashShortCopy(
  dueCents: number,
  receivedCents: number,
  currency: string,
): string {
  const short = formatMoney(dueCents - receivedCents, currency);
  return `${short} short. Cash due is ${formatMoney(dueCents, currency)}; you entered ${formatMoney(receivedCents, currency)}. Confirm stays off until the amount covers it.`;
}

// ── The done screen ─────────────────────────────────────────────────────────

export type DoneSale = {
  orderId: string;
  tender: "card" | "cash" | "comp";
  /** What the sale cost the buyer: the server's figure. */
  amountCents: number;
  ticketCount: number;
  discountCents: number;
  /** Codes the sale redeemed, normalized, as the server returned them. */
  promoCodes: string[];
  /** Cash to hand back, as the server worked it out. 0 for card and comp. */
  changeCents: number;
  autoAdmitted: boolean;
  seatLabels: string[];
  /** The address the receipt went to, as sent; null when none was given. */
  buyerEmail: string | null;
};

export type DoneSaleWords = {
  /** "$43.70", or "Comped". */
  headline: string;
  /** "Paid cash — 2 tickets", "Free with FRIENDS100 — 2 tickets". */
  summary: string;
  admitted: string;
  /** "Change $16.30", or null when no change is due. */
  giveBack: string | null;
  /** "No fee, no tax" / "Counted as a sale, not a comp", or null. */
  footnote: string | null;
  /** "Receipt sent to n•••@example.com", or null. */
  receipt: string | null;
};

/**
 * ONE MEANING FOR "COMP" (board D1). Only the Comp action comps. A sale a
 * promo code took to $0 is a SALE: the code was redeemed and the till counts
 * it under "Free with a code", so it reads "$0.00 · Free with CODE", never
 * "Comped".
 */
export function describeDoneSale(
  sale: DoneSale,
  currency: string,
): DoneSaleWords {
  const tickets = `${sale.ticketCount} ${sale.ticketCount === 1 ? "ticket" : "tickets"}`;
  const isComp = sale.tender === "comp";
  const freeWithCode =
    !isComp &&
    sale.amountCents === 0 &&
    (sale.promoCodes.length > 0 || sale.discountCents > 0);
  const codeName =
    sale.promoCodes.length > 0 ? sale.promoCodes.join(" + ") : "a code";

  const summary = isComp
    ? `Guest list — ${tickets}`
    : freeWithCode
      ? `Free with ${codeName} — ${tickets}`
      : sale.tender === "card"
        ? `Paid by card — ${tickets}`
        : `Paid cash — ${tickets}`;

  return {
    headline: isComp ? "Comped" : formatMoney(sale.amountCents, currency),
    summary,
    admitted: sale.autoAdmitted
      ? "Admitted · walk straight in"
      : "Tickets issued · scan at the door",
    giveBack:
      sale.changeCents > 0
        ? `Change ${formatMoney(sale.changeCents, currency)}`
        : null,
    footnote: isComp
      ? "No fee, no tax"
      : freeWithCode
        ? "Counted as a sale, not a comp"
        : null,
    receipt: sale.buyerEmail
      ? `Receipt sent to ${maskEmail(sale.buyerEmail)}`
      : null,
  };
}

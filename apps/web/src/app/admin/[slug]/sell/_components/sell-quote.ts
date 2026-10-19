/**
 * The Sell screen's reading of the server quote and the server's refusals.
 *
 * Pure on purpose, like `sell-cart.ts`: the unit tests here mock the design
 * system away, so anything decided in JSX goes untested. Nothing in this file
 * computes money. Prices, fees, tax and totals all come from `pos.quoteCart`
 * (and the sale's own answer); this module only labels, formats and routes
 * them.
 */

import { getAppErrorCode } from "@/lib/app-error";
import { bpsToPercentText } from "@/lib/booking-agreements";

/** One channel of `pos.quoteCart` (card or cash), as the screen reads it. */
export type QuoteTaxLine = {
  code: string;
  label: string;
  rateBps: number;
  amountCents: number;
};

export type ChannelQuote = {
  ticketSubtotalCents: number;
  discountCents: number;
  ticketTotalCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  taxLines: QuoteTaxLine[];
  taxAmountCents: number;
  totalCents: number;
};

export type CartQuote = {
  currency: string;
  lines: Array<{
    ticketTypeId: string;
    qty: number;
    unitPriceCents: number;
    amountCents: number;
  }>;
  /** Null when the card till would refuse the cart (a $0 cart): cash only. */
  card: ChannelQuote | null;
  cash: ChannelQuote;
};

/** "9.25", "3", "9.5": a rate in basis points as percent text. */
export function ratePercentText(rateBps: number): string {
  return bpsToPercentText(rateBps);
}

/** "Sales tax (9.25%)": one row per tax line, labelled as checkout labels it. */
export function taxLineLabel(line: Pick<QuoteTaxLine, "label" | "rateBps">): string {
  return `${line.label} (${ratePercentText(line.rateBps)}%)`;
}

/**
 * One row of the card/cash breakdown. `card`/`cash` are cents, or null when
 * that channel has no such row (a 0 fee renders "—", as the board draws it).
 */
export type BreakdownRow = {
  key: string;
  label: string;
  card: number | null;
  cash: number | null;
};

/**
 * The breakdown rows for the two columns, in checkout's order: Subtotal,
 * Discount (only when either channel has one), Platform fee, Processing fee,
 * then one row per tax line.
 *
 * A zero fee is null so the column shows "—": cash carries no platform or
 * processing fee (owner ruling 2026-10-08) and printing "$0.00" twice in the
 * cash column reads like a fee that happens to be free tonight.
 *
 * Tax lines are matched across channels by code. A line one channel lacks is
 * null in that column.
 */
export function breakdownRows(quote: Pick<CartQuote, "card" | "cash">): BreakdownRow[] {
  const { card, cash } = quote;
  const nonZero = (cents: number | undefined) =>
    cents == null || cents === 0 ? null : cents;

  const rows: BreakdownRow[] = [
    {
      key: "subtotal",
      label: "Subtotal",
      card: card ? card.ticketSubtotalCents : null,
      cash: cash.ticketSubtotalCents,
    },
  ];

  if ((card?.discountCents ?? 0) > 0 || cash.discountCents > 0) {
    rows.push({
      key: "discount",
      label: "Discount",
      card: nonZero(card?.discountCents),
      cash: nonZero(cash.discountCents),
    });
  }

  rows.push(
    {
      key: "platform-fee",
      label: "Platform fee",
      card: nonZero(card?.platformFeeCents),
      cash: nonZero(cash.platformFeeCents),
    },
    {
      key: "processing-fee",
      label: "Processing fee",
      card: nonZero(card?.processingFeeCents),
      cash: nonZero(cash.processingFeeCents),
    },
  );

  const seen = new Set<string>();
  const taxLines = [...(card?.taxLines ?? []), ...cash.taxLines];
  for (const line of taxLines) {
    if (seen.has(line.code)) continue;
    seen.add(line.code);
    const cardLine = card?.taxLines.find((l) => l.code === line.code);
    const cashLine = cash.taxLines.find((l) => l.code === line.code);
    rows.push({
      key: `tax-${line.code}`,
      label: taxLineLabel(line),
      card: cardLine ? cardLine.amountCents : null,
      cash: cashLine ? cashLine.amountCents : null,
    });
  }

  return rows;
}

// ── Refusals ────────────────────────────────────────────────────────────────

function readMeta(error: unknown): Record<string, unknown> | null {
  const meta = (error as { data?: { meta?: unknown } } | null)?.data?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : null;
}

/**
 * The tax lookup could not answer, so the quote (or the sale) refused rather
 * than charge 0%. `canEnterManualTaxRate` is true only for an Owner, Admin or
 * Editor of the group; missing means "ask one of them".
 */
export function readTaxRefusal(
  error: unknown,
): { canEnterManualTaxRate: boolean } | null {
  if (getAppErrorCode(error) !== "TAX_RATE_UNAVAILABLE") return null;
  return { canEnterManualTaxRate: readMeta(error)?.canEnterManualTaxRate === true };
}

/**
 * A cash sale refused because the cash total moved between the quote and
 * the sale (a tax rate updated in between). Returns the total the server now
 * wants, or null for any other failure.
 */
export function readCashShortTotal(error: unknown): number | null {
  if (getAppErrorCode(error) !== "CASH_AMOUNT_SHORT") return null;
  const total = readMeta(error)?.requiredTotalCents;
  return typeof total === "number" && Number.isInteger(total) && total >= 0
    ? total
    : null;
}

export type ManualRateRefusalReason =
  | "rate_resolved"
  | "no_location"
  | "lookup_available"
  | "lookup_not_configured"
  | "location_changed";

const MANUAL_RATE_REFUSAL_COPY: Record<ManualRateRefusalReason, string> = {
  lookup_available:
    "The tax lookup is working again, so there’s nothing to enter. Close this and charge the sale.",
  rate_resolved:
    "This event already has a tax rate. Close this and charge the sale.",
  no_location:
    "This event has no address, so tax can’t be worked out. Add an address to the event first.",
  lookup_not_configured:
    "Tax lookup isn’t set up here, so a rate can’t be entered.",
  location_changed:
    "The event’s address changed while you were entering the rate. Close this and try again.",
};

/**
 * `events.setManualTaxRate` refused because the event needs no hand-entered
 * rate. Returns the reason and the line to show, or null for any other
 * failure (an unknown reason falls back to the generic catalog copy, so this
 * returns null for it too).
 */
export function readManualRateRefusal(
  error: unknown,
): { reason: ManualRateRefusalReason; message: string } | null {
  if (getAppErrorCode(error) !== "MANUAL_TAX_RATE_NOT_ALLOWED") return null;
  const reason = readMeta(error)?.reason;
  if (typeof reason !== "string" || !(reason in MANUAL_RATE_REFUSAL_COPY)) {
    return null;
  }
  const known = reason as ManualRateRefusalReason;
  return { reason: known, message: MANUAL_RATE_REFUSAL_COPY[known] };
}

// ── The manual tax rate dialog ──────────────────────────────────────────────

/** The highest rate the server accepts, in basis points (25%). */
export const MANUAL_TAX_RATE_MAX_BPS = 2500;

/**
 * A typed percentage as basis points, or null when it isn't one the server
 * takes: a number from 0 to 25 with at most two decimals. "9.25" → 925.
 */
export function parseManualRatePercent(raw: string): number | null {
  const trimmed = raw.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  if (!Number.isFinite(bps) || bps < 0 || bps > MANUAL_TAX_RATE_MAX_BPS) {
    return null;
  }
  return bps;
}

const SMALL_NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one",
  "twenty-two", "twenty-three", "twenty-four", "twenty-five",
];

/**
 * The rate in words, so a mistyped rate reads wrong out loud before anyone
 * charges it: 925 → "Nine and a quarter percent", 950 → "Nine and a half
 * percent", 905 → "Nine point zero five percent".
 */
export function ratePercentWords(rateBps: number): string {
  const whole = Math.trunc(rateBps / 100);
  const frac = rateBps % 100;
  const wholeWords = SMALL_NUMBER_WORDS[whole] ?? String(whole);
  let words: string;
  if (frac === 0) words = wholeWords;
  else if (frac === 25) words = `${wholeWords} and a quarter`;
  else if (frac === 50) words = `${wholeWords} and a half`;
  else if (frac === 75) words = `${wholeWords} and three quarters`;
  else {
    const digits = String(frac).padStart(2, "0").replace(/0$/, "");
    words = `${wholeWords} point ${digits
      .split("")
      .map((d) => SMALL_NUMBER_WORDS[Number(d)])
      .join(" ")}`;
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} percent`;
}

// ── Buyer email ─────────────────────────────────────────────────────────────

/**
 * A light check for obvious typos only: something before and after an "@".
 * The server validates the address properly; this just stops "jane.gmail.com"
 * from being sent as typed.
 */
export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(raw.trim());
}

/** The email to send: trimmed, or undefined when the field is blank. */
export function buyerEmailForSale(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * "n•••@example.com": enough for the operator to confirm which address the
 * receipt went to without reading a stranger's email out across the counter.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  return `${email.charAt(0)}•••${email.slice(at)}`;
}

// ── What the ring-up screen shows for the quote ─────────────────────────────

/**
 * The quote, as the ring-up screen reads it.
 *
 * - `empty`: nothing in the cart, nothing to quote.
 * - `updating`: the cart changed and the server hasn't answered for THIS
 *   cart yet. Totals show "—" and Charge stays off, so nobody reads out a
 *   number the till won't charge. `last` is the previous answer, kept only
 *   so the rows don't jump while the new one is on its way.
 * - `ready`: the server's quote for exactly this cart.
 * - `tax-refused`: the tax lookup can't answer; the sale stops rather than
 *   charge no tax.
 * - `error`: any other refusal (a tier went off sale, a dropped request).
 */
export type QuoteState =
  | { kind: "empty" }
  | { kind: "updating"; last: CartQuote | null }
  | { kind: "ready"; quote: CartQuote }
  | { kind: "tax-refused"; canEnterManualTaxRate: boolean; retrying: boolean }
  | { kind: "error"; error: unknown; retrying: boolean };

/**
 * Retry a failed quote only when no answer came back. A refusal the server
 * decided (the tax lookup is down, a tier went off sale) is the answer, and
 * asking again can't change it; a tax refusal also costs a paid lookup.
 */
export function shouldRetryQuote(failureCount: number, error: unknown): boolean {
  return getAppErrorCode(error) === null && failureCount < 2;
}

/**
 * The quote query, reduced to what decides the screen. `asked` is whether
 * the debounced input the query ran for is the cart on screen now.
 */
export type QuoteQueryView = {
  hasCart: boolean;
  asked: boolean;
  data: CartQuote | undefined;
  isPlaceholderData: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
};

/**
 * What the ring-up screen shows for the quote.
 *
 * Only a quote that has SETTLED for this exact cart is `ready`. Cached data
 * for the same cart while a refetch is in flight is `updating`: the refetch
 * exists because something may have moved (the operator came back from a tax
 * refusal, a cash sale was refused as short, the cached answer went stale),
 * and Charge must not freeze the old number in the meantime.
 *
 * An error with a retry in flight stays an error with a spinner, so the
 * refusal and its way out don't flicker away while the retry runs.
 */
export function deriveQuoteState(q: QuoteQueryView): QuoteState {
  if (!q.hasCart) return { kind: "empty" };
  const last = q.data ?? null;
  if (!q.asked) return { kind: "updating", last };
  if (q.isError) {
    const taxRefusal = readTaxRefusal(q.error);
    return taxRefusal
      ? {
          kind: "tax-refused",
          canEnterManualTaxRate: taxRefusal.canEnterManualTaxRate,
          retrying: q.isFetching,
        }
      : { kind: "error", error: q.error, retrying: q.isFetching };
  }
  if (q.data && !q.isPlaceholderData && !q.isFetching) {
    return { kind: "ready", quote: q.data };
  }
  return { kind: "updating", last };
}

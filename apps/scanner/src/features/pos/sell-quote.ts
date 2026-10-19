/**
 * The Sell screen's reading of the server quote and the server's refusals.
 *
 * Ported from the web box office (`apps/web/.../sell/_components/sell-quote.ts`)
 * so both tills read `pos.quoteCart` the same way. Nothing in this file
 * computes money: prices, fees, tax and totals all come from the server
 * (`pos.quoteCart`, and each sale's own answer). This module only labels,
 * formats and routes them.
 *
 * Pure on purpose: the scanner's vitest runs in node with no renderer, so
 * anything decided in JSX goes untested.
 */
import { fromLegacyCode } from "@th/errors";
import { formatCents } from "@th/types";

import type { RouterInputs, RouterOutputs } from "../../trpc";

/** `pos.quoteCart`, as the server sends it. */
export type CartQuote = RouterOutputs["pos"]["quoteCart"];
/** One channel (card or cash) of the quote. */
export type ChannelQuote = CartQuote["cash"];
export type QuoteTaxLine = ChannelQuote["taxLines"][number];
export type QuoteInput = RouterInputs["pos"]["quoteCart"];
export type SaleItems = QuoteInput["items"];

/** "$43.70": every amount on the Sell screen goes through this. */
export function formatMoney(cents: number, currency: string): string {
  return formatCents(cents, currency);
}

/**
 * The widest figure the Card | Cash columns are sized for before any quote
 * has settled: three dollar digits. Digits are tabular, so this measures like
 * any amount up to 999.99, and the columns hold one width from "Updating…"
 * through the settled quote instead of growing when the figures arrive.
 */
export const COLUMN_RESERVE_CENTS = 88_888;

export function columnReserveText(currency: string): string {
  return formatMoney(COLUMN_RESERVE_CENTS, currency);
}

/**
 * The Card | Cash column width: the widest figure measured, never under
 * `min`, and never under the reserve gauge WHEN the row can afford it.
 *
 * "Afford" means the label cell keeps at least one gauge's width. The gauge
 * is a 20pt bold figure and the labels are 14pt, so that is wider than the
 * longest label word ("Processing") at every text size (both scale with the
 * same font multiplier). On a narrow screen or a large text size the
 * reserve gives way, and the columns size to the real figures only: a few
 * points of movement when the first quote lands, rather than a label broken
 * mid-word. Until the row has been measured the reserve doesn't apply.
 */
export function sharedColumnWidth({
  min,
  cells,
  reserve,
  rowWidth,
  gap,
}: {
  min: number;
  /** Every amount cell's measured natural width. */
  cells: Iterable<number>;
  /** The gauge's measured width, or null before it has laid out. */
  reserve: number | null;
  /** The breakdown row's width, or null before it has laid out. */
  rowWidth: number | null;
  /** The row's gap (two of them: label | card | cash). */
  gap: number;
}): number {
  const widest = Math.max(min, ...cells);
  if (reserve === null || rowWidth === null || rowWidth <= 0) return widest;
  const labelLeft = rowWidth - 2 * (reserve + gap);
  return labelLeft >= reserve ? Math.max(widest, reserve) : widest;
}

/**
 * The app error code the server put on a failure, or null for anything that
 * isn't one (a dropped connection, a bare 500). Reads the stable
 * `data.appCode` first, then the message, as the web's `getAppErrorCode`.
 */
export function getAppErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const appCode = (error as { data?: { appCode?: unknown } | null }).data
    ?.appCode;
  const message = (error as { message?: unknown }).message;
  const raw =
    typeof appCode === "string" && appCode.trim().length > 0
      ? appCode
      : typeof message === "string"
        ? message
        : null;
  return raw === null ? null : fromLegacyCode(raw);
}

function readMeta(error: unknown): Record<string, unknown> | null {
  const meta = (error as { data?: { meta?: unknown } | null } | null)?.data
    ?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : null;
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** "9.25", "3", "9.5": a rate in basis points as percent text. */
export function ratePercentText(rateBps: number): string {
  const whole = Math.trunc(rateBps / 100);
  const frac = rateBps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** "Sales tax (9.25%)": one row per tax line, labelled as checkout labels it. */
export function taxLineLabel(
  line: Pick<QuoteTaxLine, "label" | "rateBps">,
): string {
  return `${line.label} (${ratePercentText(line.rateBps)}%)`;
}

/**
 * One row of the Card | Cash breakdown. `card`/`cash` are cents, or null when
 * that column has no such amount (rendered "—").
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
 * processing fee (owner ruling 2026-10-08), and "$0.00" twice in the cash
 * column reads like a fee that happens to be free tonight. A null `card`
 * (a cart a card can't take) leaves the whole card column "—".
 *
 * Tax lines are matched across channels by code; a line one channel lacks is
 * null in that column.
 */
export function breakdownRows(
  quote: Pick<CartQuote, "card" | "cash">,
): BreakdownRow[] {
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
  for (const line of [...(card?.taxLines ?? []), ...cash.taxLines]) {
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

/**
 * The cash sheet's one-line explanation of the due amount:
 * "2 × General admission · $40.00 + $3.70 sales tax · no fees".
 *
 * Built from the quote's own lines and totals; `names` only supplies the
 * ticket type names the quote doesn't carry.
 */
export function cashDueSummary(
  quote: Pick<CartQuote, "lines" | "cash" | "currency">,
  names: ReadonlyMap<string, string>,
): string {
  const items = quote.lines
    .map((line) => `${line.qty} × ${names.get(line.ticketTypeId) ?? "Ticket"}`)
    .join(", ");
  const { cash, currency } = quote;
  const tickets = formatMoney(cash.ticketTotalCents, currency);
  let taxPart = "";
  if (cash.taxAmountCents > 0) {
    const onlyLine = cash.taxLines.length === 1 ? cash.taxLines[0] : undefined;
    const taxWord = onlyLine ? onlyLine.label.toLowerCase() : "tax";
    taxPart = ` + ${formatMoney(cash.taxAmountCents, currency)} ${taxWord}`;
  }
  return `${items} · ${tickets}${taxPart} · no fees`;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * The tax lookup couldn't answer, so the quote (or the sale) refused rather
 * than charge 0%. `canEnterManualTaxRate` is true only for an Owner, Admin or
 * Editor of the group; missing means "ask one of them".
 */
export function readTaxRefusal(
  error: unknown,
): { canEnterManualTaxRate: boolean } | null {
  if (getAppErrorCode(error) !== "TAX_RATE_UNAVAILABLE") return null;
  return {
    canEnterManualTaxRate: readMeta(error)?.canEnterManualTaxRate === true,
  };
}

/**
 * A cash sale refused because the cash handed over is below the total the
 * server worked out (the total moved after the quote, e.g. a tax rate update).
 * Returns that total, or null for any other failure.
 */
export function readCashShortTotal(error: unknown): number | null {
  if (getAppErrorCode(error) !== "CASH_AMOUNT_SHORT") return null;
  const total = readMeta(error)?.requiredTotalCents;
  return typeof total === "number" && Number.isInteger(total) && total >= 0
    ? total
    : null;
}

/** The tax-refused panel's second line, by what the operator may do. */
export function taxRefusalNextStep(canEnterManualTaxRate: boolean): string {
  return canEnterManualTaxRate
    ? "You can enter the tax rate on the web Sell screen (Enter tax rate). Then try again here."
    : "Ask an Owner, Admin or Editor for this group to enter the tax rate on the web Sell screen. Then try again.";
}

// ── Buyer email ─────────────────────────────────────────────────────────────

/**
 * A light check for obvious typos only: something before and after an "@".
 * The server validates the address properly.
 */
export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(raw.trim());
}

/** True when something is typed and it doesn't look like an address. */
export function emailBlocksSale(raw: string): boolean {
  return raw.trim() !== "" && !looksLikeEmail(raw);
}

/** The email to send: trimmed, or undefined when the field is blank. */
export function buyerEmailForSale(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * "n•••@example.com": enough to confirm which address the receipt went to
 * without reading a stranger's email out across the counter.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  return `${email.charAt(0)}•••${email.slice(at)}`;
}

// ── What the Sell screen shows for the quote ────────────────────────────────

/**
 * - `empty`: nothing in the cart.
 * - `updating`: the cart (or its codes) changed and the server hasn't
 *   settled an answer for THIS cart yet, or a refetch is in flight. Totals
 *   read "—" and both tenders stay off. `last` keeps the rows from jumping.
 * - `ready`: the server's quote for exactly this cart.
 * - `tax-refused`: the tax lookup can't answer; the sale stops rather than
 *   charge no tax. Only a comp works.
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
 * decided (TAX_RATE_UNAVAILABLE, a tier off sale) is the answer, and asking
 * again can't change it; a tax refusal also costs a paid lookup.
 */
export function shouldRetryQuote(failureCount: number, error: unknown): boolean {
  return getAppErrorCode(error) === null && failureCount < 2;
}

/** The quote query, reduced to what decides the screen. */
export type QuoteQueryView = {
  hasCart: boolean;
  /**
   * Whether the input the query ran for is the cart (and settled promo
   * codes) on screen now. False while the debounce or a promo re-preview is
   * still catching up.
   */
  asked: boolean;
  data: CartQuote | undefined;
  isPlaceholderData: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
};

/**
 * Only a quote that has SETTLED for this exact cart is `ready`. Cached data
 * for the same cart while a refetch is in flight is `updating`: the refetch
 * exists because something may have moved (back from a tax refusal, a cash
 * sale refused as short), and Charge must not freeze the old number.
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

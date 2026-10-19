// ─────────────────────────────────────────────────────────────────────────────
// Sell → Cash taken tonight → the event's cash sales (door-sales step 9b).
//
// Owner ruling 2026-10-08: Editors refund cash door sales here, not from
// Orders (Orders carries buyer details and is Owner/Admin/Finance only). The
// rows come from `pos.eventCashSales`, which carries no buyer email, name or
// address. Pure rules, kept out of the component so they can be tested
// without rendering it; the server (`orgRefundCashSale`) is the authority.
// ─────────────────────────────────────────────────────────────────────────────

/** A row of `pos.eventCashSales`. Dates may arrive as Date or ISO string. */
export type EventCashSale = {
  orderId: string;
  soldAt: Date | string;
  ticketCount: number;
  amountPaidCents: number;
  promoCode: string | null;
  isComp: boolean;
  isFreeWithCode: boolean;
  status: "SUCCEEDED" | "REFUNDED" | "PART_REFUNDED";
  refundedAt: Date | string | null;
};

/** The page-level fields `pos.eventCashSales` returns beside its rows. */
export type EventCashSalesPage = {
  items: EventCashSale[];
  nextCursor: string | null;
  refundableUntil: Date | string;
  canRefund: boolean;
  refundWindowApplies: boolean;
};

export type CashSaleRefundWindow = Pick<
  EventCashSalesPage,
  "refundableUntil" | "canRefund" | "refundWindowApplies"
>;

/**
 * Where the caller stands with the refund window, for the line above the
 * list:
 *  - `cannot`: their role cannot refund (Scanner);
 *  - `unlimited`: platform staff, whom `orgRefundCashSale` does not hold to
 *    the window;
 *  - `open` / `closed`: an Owner, Admin or Editor before or after
 *    `refundableUntil` (inclusive: at that instant the server still takes it).
 */
export type CashRefundWindowState = "cannot" | "unlimited" | "open" | "closed";

export function cashRefundWindowState(
  page: CashSaleRefundWindow,
  now: Date,
): CashRefundWindowState {
  if (!page.canRefund) return "cannot";
  if (!page.refundWindowApplies) return "unlimited";
  const until = new Date(page.refundableUntil).getTime();
  if (Number.isNaN(until)) return "closed";
  return now.getTime() <= until ? "open" : "closed";
}

/**
 * Whether a row gets a Refund button: the rule `eventCashSales` documents,
 * `status === "SUCCEEDED" && canRefund && (!refundWindowApplies || now <=
 * refundableUntil)`.
 */
export function cashSaleRefundable(
  sale: Pick<EventCashSale, "status">,
  page: CashSaleRefundWindow,
  now: Date,
): boolean {
  if (sale.status !== "SUCCEEDED") return false;
  const state = cashRefundWindowState(page, now);
  return state === "open" || state === "unlimited";
}

/**
 * The word after the ticket count. Only the Comp button makes a comp; a $0
 * sale made free by a code is "Free with <CODE>", a sale (owner ruling); a
 * paid sale that used a code names the code.
 */
export function cashSaleKindLabel(
  sale: Pick<EventCashSale, "isComp" | "isFreeWithCode" | "promoCode">,
): string | null {
  if (sale.isComp) return "Comp";
  if (sale.isFreeWithCode) {
    return sale.promoCode ? `Free with ${sale.promoCode}` : "Free with a code";
  }
  return sale.promoCode;
}

/**
 * What the row's action is called. Nothing changes hands on a $0 sale, so
 * "Refund" would promise money that isn't there: a comp or a free sale is
 * voided. The server call is the same (`orgRefundCashSale`).
 */
export type CashSaleAction =
  | { verb: "refund" }
  | { verb: "void"; noun: "comp" | "free sale" };

export function cashSaleAction(
  sale: Pick<EventCashSale, "amountPaidCents" | "isComp">,
): CashSaleAction {
  if (sale.amountPaidCents > 0) return { verb: "refund" };
  return { verb: "void", noun: sale.isComp ? "comp" : "free sale" };
}

/** The status line under a sale that is no longer live. */
export function cashSaleClosedLabel(
  sale: Pick<EventCashSale, "amountPaidCents" | "isComp" | "refundedAt">,
  now: Date,
): string {
  const word = cashSaleAction(sale).verb === "void" ? "Voided" : "Refunded";
  return sale.refundedAt ? `${word} ${cashSaleTime(sale.refundedAt, now)}` : word;
}

/**
 * The rows of every loaded page, newest first as the server sends them, each
 * order once: a sale rung up between two page reads shifts the keyset, and a
 * row must not show twice.
 */
export function mergeCashSalePages(
  pages: ReadonlyArray<{ items: EventCashSale[] } | null | undefined>,
): EventCashSale[] {
  const seen = new Set<string>();
  const out: EventCashSale[] = [];
  for (const page of pages) {
    for (const sale of page?.items ?? []) {
      if (seen.has(sale.orderId)) continue;
      seen.add(sale.orderId);
      out.push(sale);
    }
  }
  return out;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "8:41 PM" for a sale today, "Oct 8, 8:41 PM" otherwise: a door tablet's
 * night is usually one day, but a festival or a presale table is not.
 */
export function cashSaleTime(at: Date | string, now: Date): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameLocalDay(date, now)) return time;
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${day}, ${time}`;
}

export function ticketsLabel(count: number): string {
  return `${count} ${count === 1 ? "ticket" : "tickets"}`;
}

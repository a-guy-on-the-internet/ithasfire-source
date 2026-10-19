import { fail } from "@th/errors";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";

/** A door sale: card at the till (`POS`) or cash (`CASH`), comps included. */
export function isDoorSaleOrder(order: Pick<OrderRecord, "paymentChannel">): boolean {
  return order.paymentChannel === "POS" || order.paymentChannel === "CASH";
}

export type DoorSaleReceipt = {
  lineItems: Array<{ label: string; amountCents: number }>;
  totalCents: number;
  /** "Card", "Cash", or "Complimentary" for a comp. */
  paymentMethod: string;
  /** A comp: the receipt reads as a gift, not a purchase. */
  complimentary: boolean;
};

/**
 * The itemised receipt a door buyer who gave an email is sent (spec
 * 2026-10-07 door-sales-same-price-and-tax, FR-011, owner ruling R7), read
 * from the order AS RECORDED, never re-priced:
 *
 *   one line per ticket type (face before discounts), the discount, the
 *   platform fee and the processing fee (card only: a cash sale carries
 *   neither, owner ruling 2026-10-08, so a cash receipt has no fee line;
 *   a cash order recorded before it still shows the fee it charged), every
 *   tax line the buyer paid (its own label and rate), and the total the
 *   buyer paid.
 *
 * Labels follow online checkout's summary ("Platform fee", "Processing fee",
 * "Discount", "Taxes" when there is no tax line). A tax line keeps the label
 * its imposition stored ("Sales tax", "Minneapolis entertainment tax"), with
 * the rate as checkout shows it. A comp is the ticket lines at $0 and a $0
 * total: no fee, no tax (R4).
 *
 * The lines MUST add up to the total the buyer paid
 * (`computeExpectedPaymentAmount`, the finalize webhook's own sum); a
 * receipt that does not is refused (INTERNAL) rather than sent with guessed
 * lines.
 */
export function buildDoorSaleReceipt(params: {
  order: Pick<
    OrderRecord,
    | "paymentChannel"
    | "amountGrossCents"
    | "feesPlatformCents"
    | "taxAmountCents"
    | "items"
  >;
  taxLines: ReadonlyArray<Pick<OrderTaxLineRecord, "label" | "rateBps" | "amountCents" | "collector">>;
  ticketTypeNames: ReadonlyMap<string, string | null | undefined>;
}): DoorSaleReceipt {
  const { order, taxLines, ticketTypeNames } = params;
  const ticketItems = order.items.filter((item) => item.kind === "ticket");
  const comp =
    ticketItems.length > 0 &&
    ticketItems.every((item) => metaFlag(item.meta, "comp"));

  // One line per ticket type, in the order the cart listed them.
  const byType = new Map<string, { qty: number; amountCents: number }>();
  for (const item of ticketItems) {
    const key = item.ticketTypeId ?? "";
    const line = byType.get(key) ?? { qty: 0, amountCents: 0 };
    line.qty += item.qty;
    line.amountCents += item.amountCents;
    byType.set(key, line);
  }
  const lineItems: DoorSaleReceipt["lineItems"] = [];
  for (const [ticketTypeId, line] of byType) {
    const name = ticketTypeNames.get(ticketTypeId)?.trim() || "Ticket";
    lineItems.push({ label: `${name} × ${line.qty}`, amountCents: line.amountCents });
  }

  const paymentMethod = comp
    ? "Complimentary"
    : order.paymentChannel === "CASH"
      ? "Cash"
      : "Card";

  const totalCents = computeExpectedPaymentAmount(order);
  if (comp) {
    assertAddsUp(lineItems, totalCents);
    return { lineItems, totalCents, paymentMethod, complimentary: true };
  }

  const discountCents = order.items
    .filter((item) => item.kind === "discount")
    .reduce((sum, item) => sum + item.amountCents, 0);
  if (discountCents !== 0) {
    lineItems.push({ label: "Discount", amountCents: discountCents });
  }
  if (order.feesPlatformCents > 0) {
    lineItems.push({ label: "Platform fee", amountCents: order.feesPlatformCents });
  }
  // What the buyer paid beyond face, fee and tax: the card's processing fee
  // (spread into the per-ticket buyer totals by `priceCart`). 0 for cash.
  const taxCents = order.taxAmountCents ?? 0;
  const processingFeeCents =
    totalCents - order.amountGrossCents - order.feesPlatformCents - taxCents;
  if (processingFeeCents > 0) {
    lineItems.push({ label: "Processing fee", amountCents: processingFeeCents });
  }
  const charged = taxLines.filter((line) => line.collector === "PLATFORM");
  if (charged.length === 0) {
    // Always the figure, "$0.00" when nothing is owed (online checkout's
    // rule, owner ruling 2026-10-01). A taxed order without its lines fails
    // the sum below.
    lineItems.push({ label: "Taxes", amountCents: 0 });
  } else {
    for (const line of charged) {
      lineItems.push({
        label: `${line.label} (${formatRatePercent(line.rateBps)}%)`,
        amountCents: line.amountCents,
      });
    }
  }

  assertAddsUp(lineItems, totalCents);
  return { lineItems, totalCents, paymentMethod, complimentary: false };
}

/** "9.75", "3", "8.88": the percent online checkout prints beside "Taxes". */
function formatRatePercent(rateBps: number): string {
  return String(+(rateBps / 100).toFixed(2));
}

function metaFlag(meta: unknown, key: string): boolean {
  return (
    meta != null &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>)[key] === true
  );
}

function assertAddsUp(
  lineItems: DoorSaleReceipt["lineItems"],
  totalCents: number,
): void {
  const sum = lineItems.reduce((acc, line) => acc + line.amountCents, 0);
  if (sum !== totalCents) {
    throw fail("INTERNAL", {
      message: `door_sale_receipt_lines_disagree: lines=${sum} total=${totalCents}`,
    });
  }
}

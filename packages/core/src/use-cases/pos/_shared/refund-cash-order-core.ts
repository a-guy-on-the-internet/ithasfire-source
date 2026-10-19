import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import { fail } from "@th/errors";
import { formatOrderCode } from "@th/types/order-identifier";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import { requireTicketingEventId } from "../../orders/_shared/require-ticketing-order";
import { releaseSeatsForVoidedTickets } from "../../orders/_shared/release-seats-for-voided-tickets";
import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
} from "../../orders/_shared/tickets-leaving-on-refund";
import { allocateRefundPlatformFeeShares } from "../../orders/_shared/refund-platform-fee-share";
import { allocateRefundTaxSharesForOrder } from "../../orders/_shared/refund-tax-shares-for-order";
import {
  cashSaleDebitKey,
  cashSaleDebitReversalKey,
} from "./cash-sale-ledger";

/**
 * Who asked for the cash refund. Recorded on the audit row and the ledger
 * reversal's metadata; the refund itself is identical for all four.
 *
 *  - `gate`: the till's Last sale refund, inside its 15-minute window
 *    (`refundCashSale`).
 *  - `org`: an org member in `ORG_CASH_REFUND_ROLES` (Owner, Admin, Editor,
 *    Finance) refunding a cash sale until 7 days after the event ends
 *    (`orgRefundCashSale`, owner rulings 2026-10-07).
 *  - `platform`: a platform admin through `orgRefundCashSale` (the staff
 *    override, or any refund after the org's window closed).
 *  - `event_cancel`: the event was cancelled (`cancelEvent`, or the door
 *    sweep finishing a cancellation's cash phase; same ruling).
 */
export type CashRefundVia = "gate" | "org" | "platform" | "event_cancel";

export type CashOrderRefundResult = {
  orderId: string;
  refundedTicketCount: number;
  /**
   * Cash to hand back: what the buyer paid, read from the order as recorded
   * (spec 2026-10-07 FR-008) — ticket net of discount + tax for a sale since
   * the owner ruling of 2026-10-08 (cash = no platform fee); ticket +
   * platform fee + tax for one recorded before it. 0 for a comp. A cash
   * order recorded before the door was priced returns its gross.
   */
  amountReturnedCents: number;
  /** True when the order was already REFUNDED: nothing was written. */
  alreadyRefunded: boolean;
  /**
   * The CASH_SALE_DEBIT this call reversed (or found already reversed), at
   * the amount the debit row recorded: the tax for a sale since 2026-10-08,
   * fee + tax for one before it. 0 when the sale had no debit: a comp, a
   * tax-free sale, or a cash order recorded before cash debits existed.
   * Always 0 on `alreadyRefunded`.
   */
  cashSaleDebitReversedCents: number;
};

export type RefundCashOrderInTxArgs = {
  orderId: string;
  /** Null only for the door sweep, which acts for no one in particular. */
  actorHumanId: string | null;
  via: CashRefundVia;
  now: Date;
  /**
   * The caller's access rule, run once the order and its event are loaded
   * and BEFORE the order's channel or status is revealed. Throws to refuse.
   * The event may be ownerless; each caller decides what that means.
   */
  authorize: (ctx: { order: OrderRecord; event: EventRecord }) => Promise<void>;
  /**
   * The caller's last word on a SUCCEEDED order about to be refunded: throw
   * to refuse (the gate's 15-minute window, the org's 7-days-after-the-
   * event window), or return `{ via }` to attribute the refund to someone
   * other than `args.via` (a platform admin past the org's window). Never
   * runs on the idempotent replay, so an already-refunded order answers the
   * same at any age.
   */
  checkRefundable?: (ctx: {
    order: OrderRecord;
    event: EventRecord;
  }) => void | { via?: CashRefundVia } | Promise<void | { via?: CashRefundVia }>;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * The per-item tax allocation reports (never throws) when an order's tax
   * lines don't add up to its tax — the same report the card refund makes.
   */
  reportError?: ReporterPort | null;
};

/**
 * THE cash refund. Every path that refunds a door cash sale (the till's gate
 * refund, an Editor's later refund, an event cancellation) runs this,
 * on the caller's transaction, so there is one implementation of what a cash
 * refund does.
 *
 * Cash refunds move no PLATFORM money: the organiser received the cash and
 * hands it back themselves — the whole amount the buyer paid (spec
 * 2026-10-07 FR-008): ticket + tax, plus the platform fee on a sale recorded
 * before the owner ruling of 2026-10-08 (cash = no platform fee). This flips the order and its
 * tickets to REFUNDED, gives back seats, promo holds and the fee-waiver
 * allowance, stamps each ticket item's tax and fee share, reverses the sale's
 * CASH_SALE_DEBIT and writes the audit row.
 *
 * LEDGER. A priced cash sale wrote a CASH_SALE_DEBIT for what the organiser
 * owed the platform out of the cash: its tax (since 2026-10-08), or its fee +
 * tax (before). The refund hands that back to the buyer, so the debit is
 * reversed — a CASH_SALE_DEBIT_REVERSAL on this same transaction, its amount
 * COPIED from the debit row by the adapter, never recomputed, so an old
 * fee + tax debit is reversed in full and a new tax-only one is reversed as
 * the tax. The adapter reverses a debit at most once, ever. A comp, a
 * tax-free sale since the ruling, or a cash order recorded before cash
 * debits existed has no debit, and nothing is written. There is still NO REFUND_DEBIT: a
 * cash sale mints no SETTLEMENT_CREDIT, so there is no organiser revenue on
 * the ledger to claw back.
 *
 * Refuses: ORDER_NOT_FOUND, EVENT_NOT_FOUND, whatever `authorize` throws,
 * NOT_A_CASH_ORDER, a non-SUCCEEDED order (`order_not_refundable`), whatever
 * `assertRefundable` throws.
 *
 * Idempotent: a CASH order that is already REFUNDED returns the same totals
 * with `alreadyRefunded: true` and writes nothing. The order is CLAIMED with
 * a compare-and-set (SUCCEEDED → REFUNDED) before anything else is written,
 * so of two concurrent refunds of one order exactly one does the work; the
 * other waits on the row lock, loses the claim and takes the no-op path.
 */
export async function refundCashOrderInTx(
  tx: TxRepos,
  args: RefundCashOrderInTxArgs,
): Promise<CashOrderRefundResult> {
  const order = await tx.orders.getById(args.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const event = await tx.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  await args.authorize({ order, event });

  if (order.paymentChannel !== "CASH") {
    throw fail("NOT_A_CASH_ORDER");
  }

  // What the buyer paid: Σ ticket buyer totals (each ticket's face; plus its
  // platform fee share on a sale recorded before 2026-10-08) + discount
  // items + tax — `computeExpectedPaymentAmount`, the sum the
  // card path checks a charge against. A cash order recorded before the
  // door was priced carries no buyer totals and no fee or tax, and falls
  // back to its gross: what the operator typed then.
  const amountReturnedCents = computeExpectedPaymentAmount(order);

  const alreadyRefunded = async (): Promise<CashOrderRefundResult> => {
    // Idempotent no-op: re-call returns the same totals.
    const tickets = await tx.tickets.listByOrderId(order.id);
    return {
      orderId: order.id,
      refundedTicketCount: tickets.filter((t) => t.status === "REFUNDED")
        .length,
      amountReturnedCents,
      alreadyRefunded: true,
      cashSaleDebitReversedCents: 0,
    };
  };
  const notRefundable = (status: string) =>
    ({
      code: "invalid_input",
      message: "order_not_refundable",
      status,
    }) as const;

  if (order.status === "REFUNDED") {
    return await alreadyRefunded();
  }
  if (order.status !== "SUCCEEDED") {
    throw notRefundable(order.status);
  }

  const verdict = await args.checkRefundable?.({ order, event });
  const via: CashRefundVia = (verdict && verdict.via) || args.via;

  // Claim the order before writing anything else. The read above holds no
  // lock: two refunds (the till and a cancellation, or two taps) can both
  // see SUCCEEDED. Only one UPDATE matches; the other blocks on its row lock
  // until that transaction ends, then matches nothing and returns false.
  if (!(await tx.orders.markRefundedIfSucceeded(order.id))) {
    const current = await tx.orders.getById(order.id);
    if (current?.status === "REFUNDED") {
      return await alreadyRefunded();
    }
    throw notRefundable(current?.status ?? "MISSING");
  }

  const now = args.now;
  const tickets = await tx.tickets.listByOrderId(order.id);

  // The tickets that had admitted someone, for the audit row. Taken BEFORE
  // the write below, which clears `scannedAt`: once it runs, nothing on the
  // ticket row says it was ever used.
  const leftOnRefund = ticketsLeavingOnRefund(tickets);

  for (const ticket of tickets) {
    // Auto-admitted tickets land in SCANNED. Comp tickets too. Either way,
    // a refund yanks the admit by moving the ticket to REFUNDED, and the
    // refund means the person left (owner ruling 2026-10-10). The scanner's
    // home-screen counter (FR-015) reads no audit row: it counts the VALID
    // and SCANNED tickets in the device's local manifest (`getEventCounts`,
    // apps/scanner/src/lib/local-db.ts), so it falls when the next manifest
    // sync brings this ticket back as REFUNDED.
    await tx.tickets.setStatus(ticket.id, "REFUNDED", { scannedAt: null });
  }

  // A cash sale can be seated too (`startPosSale` holds seats and mint
  // stamps them SOLD), and this path is INDEPENDENT of refundFullOrder — it
  // gets the seats back itself or the refunded seat is dead inventory.
  // Every ticket on the order was just voided above, so the whole list is
  // the voided list.
  const releasedSeatIds = await releaseSeatsForVoidedTickets(tx, tickets, now);

  // Stamp what each ticket item gave back, as `refundFullOrder` does: its
  // tax share (split per PLATFORM tax line, by each line's own base) and
  // its platform-fee share, both allocated over EVERY ticket item so they
  // sum to the order's `taxAmountCents` and `feesPlatformCents` exactly.
  // A cash refund returns the whole of both (FR-008), so these are the
  // order's full fee and tax. Without the fee stamp, platform revenue
  // counts a refunded cash sale's fee as kept (get-platform-revenue.ts,
  // `feesReturnedCents` and coverage condition 4). A sale since the
  // 2026-10-08 ruling has no fee and stamps fee shares of 0. Comps and
  // pre-pricing cash orders stamp measured zeros: nothing was charged,
  // nothing returned.
  const ticketItems = (order.items ?? []).filter((i) => i.kind === "ticket");
  if (ticketItems.length > 0) {
    const { taxByItem } = allocateRefundTaxSharesForOrder({
      useCase: useCaseName(via),
      order,
      ticketItems,
      taxLines: await tx.orders.listTaxLines(order.id),
      logger: args.logger,
      reportError: args.reportError ?? undefined,
    });
    const platformFeeByItem = allocateRefundPlatformFeeShares(
      ticketItems,
      order.feesPlatformCents,
    );
    for (const item of ticketItems) {
      await tx.orderItems.updateStatus(
        item.id,
        "refunded",
        now,
        taxByItem.get(item.id) ?? 0,
        // `?? null`, as refundFullOrder: an item the share map does not
        // know stays "not attributed", never a fabricated 0.
        platformFeeByItem.get(item.id) ?? null,
      );
    }
  }

  // Release promo holds — same call the online refund makes
  // (refund-full-order). For cash orders the holds were CONFIRMED inline at
  // sale time, and release only flips PENDING holds, so the PromoRedemption
  // row survives and still counts against maxRedemptions. That exactly
  // matches the online paid-then-refunded behaviour; do not "fix" it here
  // without fixing it there.
  await tx.promos.releaseHoldsForOrder(order.id);

  // The fee-waiver allowance the sale spent comes back with the sale, as it
  // does on a full online refund. Idempotent; a no-op when none was reserved.
  await tx.feeWaivers.release(order.id);

  // What the debit claimed (the tax; fee + tax on a sale recorded before
  // 2026-10-08) goes back to the buyer, so the platform is no longer owed
  // it: reverse the sale's CASH_SALE_DEBIT (FR-008). Amount and payee come
  // from the debit row itself, never recomputed from today's pricing rule.
  // Null = there was no debit (comp, a tax-free sale, or a pre-pricing cash
  // order).
  //
  // Deliberately NO REFUND_DEBIT, despite spec §4's always-debit rule: a
  // cash order writes no OrderSplits and no SETTLEMENT_CREDIT (the organiser
  // physically holds the cash), so there is no credit to net.
  const reversal = await tx.payeeLedger.cashSaleDebitReversal({
    idempotencyKey: cashSaleDebitReversalKey(order.id),
    debitIdempotencyKey: cashSaleDebitKey(order.id),
    description: reversalDescription(via, order.id),
    sourceKind: "pos_cash_refund",
    sourceId: order.id,
    metadata: {
      eventId: event.id,
      actorHumanId: args.actorHumanId,
      via,
    },
  });
  const cashSaleDebitReversedCents = reversal?.amountCents ?? 0;

  await tx.audit.log({
    entity: "order",
    entityId: order.id,
    action: "pos_cash_refund",
    data: {
      orderId: order.id,
      eventId: event.id,
      actorHumanId: args.actorHumanId,
      via,
      amountReturnedCents,
      refundedTicketCount: tickets.length,
      releasedSeatIds: releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
      // Scanned-in tickets this refund voided: the person left.
      ...leftOnRefundAuditData(leftOnRefund),
      channel: "CASH",
      // No platform money moved — the organiser hands the cash back.
      moneyMoved: false,
      cashSaleDebitReversedCents,
    },
    at: now,
  });

  const logName =
    via === "gate" ? "pos.refund.gate_issued" : "pos.refund.cash_issued";
  args.logger?.info(logName, {
    orderId: order.id,
    eventId: event.id,
    actorHumanId: args.actorHumanId,
    via,
    channel: "CASH",
    amountReturnedCents,
    refundedTicketCount: tickets.length,
    cashSaleDebitReversedCents,
  });
  args.metrics?.increment(logName, {
    eventId: event.id,
    channel: "CASH",
    via,
  });

  return {
    orderId: order.id,
    refundedTicketCount: tickets.length,
    amountReturnedCents,
    alreadyRefunded: false,
    cashSaleDebitReversedCents,
  };
}

function useCaseName(via: CashRefundVia): string {
  switch (via) {
    case "gate":
      return "refundCashSale";
    case "org":
    case "platform":
      return "orgRefundCashSale";
    case "event_cancel":
      return "cancelEvent";
  }
}

function reversalDescription(via: CashRefundVia, orderId: string): string {
  switch (via) {
    case "gate":
      return `Door cash sale refunded — amount owed on it returned, order ${formatOrderCode(orderId)}`;
    case "org":
      return `Door cash sale refunded by the organiser — amount owed on it returned, order ${formatOrderCode(orderId)}`;
    case "platform":
      return `Door cash sale refunded by Ithas Fire staff — amount owed on it returned, order ${formatOrderCode(orderId)}`;
    case "event_cancel":
      return `Event cancelled — door cash sale refunded, amount owed on it returned, order ${formatOrderCode(orderId)}`;
  }
}

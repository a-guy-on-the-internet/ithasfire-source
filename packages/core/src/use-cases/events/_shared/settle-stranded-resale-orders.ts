import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
} from "../../orders/_shared/retire-carried-over-cart";

/** The only fields this phase needs off a stranded resale order. */
interface StrandedResaleOrder {
  id: string;
  stripePaymentIntentId: string | null;
}

export interface SettleStrandedResaleOrdersResult {
  /**
   * Orders whose PaymentIntent was PROVEN DEAD: nobody was charged, so the
   * order is CANCELLED and its promo / fee-waiver / credit holds handed back.
   */
  cancelledCount: number;
  /**
   * Orders whose PaymentIntent had already SUCCEEDED. The buyer's money is
   * real and there is no ticket to give them, so the charge was refunded in
   * full and the order marked REFUNDED.
   */
  refundedCount: number;
  /**
   * Orders this phase could NOT settle: the PI is `processing`, Stripe threw,
   * there is no payment processor, or the refund itself failed. Every one is
   * reported to Sentry AND counted here — a stranded buyer must never be a
   * silent number. Left PENDING with everything held, deliberately: keeping a
   * hold costs a slot, releasing a live one costs a real buyer a real charge.
   */
  strandedCount: number;
  /**
   * True when the scan for PENDING resale orders itself failed, so the three
   * counts above describe NOTHING rather than describing zero. Separate from
   * `strandedCount` on purpose: "we settled none of them" and "we do not know
   * whether there were any" are different facts, and collapsing them is how a
   * cancellation reads as clean while a buyer is out of pocket.
   */
  scanFailed: boolean;
}

export type SettleStrandedResaleOrdersDeps = {
  repos: Pick<Repos, "tx" | "orders">;
  /**
   * Optional so a composition root with no Stripe key still compiles. Its
   * ABSENCE makes every PI-bearing order strand rather than be cancelled —
   * `settleCarriedOverCartPaymentIntent` refuses with `no_processor`, and
   * de-holding under a PI nobody has asked about is the unsafe direction.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent" | "refundPaymentIntent"
  > | null;
  logger?: LoggerPort;
  /**
   * Every branch of this phase is a deliberate swallow — it must never throw,
   * because the event is already CANCELLED by the time it runs (see the
   * placement note below) and a throw would tell the caller the cancellation
   * failed. That makes `reportError` the ONLY way these failures reach
   * Sentry (CLAUDE.md error-reporting convention: a bare log is not
   * captured). Guarded everywhere so a throwing reporter cannot manufacture
   * a new failure.
   */
  reportError?: ReporterPort | null;
};

const PAGE_LIMIT = 100;

/**
 * Settles the PENDING RESALE orders left behind by an event cancellation.
 *
 * ── The bug this closes (money audit #22, the loser) ────────────────────────
 * `cancelEvent` cancels every OPEN resale listing for the event inside its
 * main transaction. That is correct — otherwise a refunded ticket stays
 * purchasable — but it has a victim: a resale purchase that was mid-finalize.
 * `cancelOpenForEvent` takes the listing row locks first, so
 * `resaleListings.commit` (HELD → SOLD) then flips zero rows and throws
 * `resale_listing_commit_mismatch` (or `resale_listing_not_sellable` if it
 * had not reached the CAS yet). The finalize transaction aborts, the order
 * stays PENDING, and the webhook goes to the DLQ where only an operator can
 * replay it — which cannot help, because the listing is CANCELLED forever.
 *
 * `collectRefundableOrders` only collects `SUCCEEDED | PART_REFUNDED`, so
 * that buyer was charged, got no ticket, and got no automatic refund.
 *
 * ── WHY THIS RUNS AFTER THE MAIN TRANSACTION COMMITS ────────────────────────
 * Two constraints, and only one placement satisfies both.
 *
 * 1. Stripe must not run inside `repos.tx`. The client is
 *    `timeout: 60_000, maxNetworkRetries: 1` — up to 240 seconds for a
 *    cancel + retrieve pair, against a 30-second transaction budget and a
 *    pool of 10 connections. Same rule `releaseExpiredCarts` follows.
 *
 * 2. The listing cancellation is the FENCE that makes this phase's verdict
 *    stable. Only once `cancelOpenForEvent` has COMMITTED is "this PENDING
 *    resale order can never mint a ticket" true: after that, any racing
 *    finalize hits a CANCELLED listing and throws out of `commit`. Run this
 *    phase BEFORE the transaction and the verdict is a guess — we could
 *    refund a buyer whose finalize then commits, handing them a ticket they
 *    no longer paid for, while `collectRefundableOrders` (which already ran)
 *    never sees the now-SUCCEEDED order.
 *
 * Before-the-transaction satisfies (1) and violates (2). After-the-commit
 * satisfies both. So: after.
 *
 * ── What happens if the process dies mid-phase ──────────────────────────────
 * The event IS cancelled and the listings ARE cancelled — that all committed.
 * Some PENDING resale orders are simply not settled yet. Recovery:
 *
 *  - Unpaid ones self-heal. `releaseExpiredCarts` reaps PENDING orders past
 *    the cart TTL, settles the PI and releases exactly the same holds.
 *  - Paid ones do NOT self-heal, and never silently: the reaper quarantines
 *    them `permanent` and reports each refusal, and this phase reports its
 *    own before it dies. An operator refunds from the orders desk.
 *
 * `cancelEvent` cannot re-run the phase itself — a retry with the same
 * clientKey replays the cached response, and a fresh one is rejected by
 * `ensureEventCancellable` with EVENT_ALREADY_CANCELLED. That is a known
 * residual, not a silent one.
 *
 * ── Retry safety ───────────────────────────────────────────────────────────
 * Every per-order effect is individually idempotent, so ANY re-drive (this
 * phase, the reaper, an operator replay) is safe:
 *  - the cancel is `cancelPendingOrder`, a CAS on `status = PENDING`;
 *  - the refund carries a stable Stripe idempotency key derived from the
 *    cancellation's own key plus the order id, so a second attempt returns
 *    the FIRST refund rather than issuing another;
 *  - `promos.releaseHoldsForOrder`, `feeWaivers.release` and
 *    `credits.releaseForOrder` are all idempotent by contract;
 *  - the refund's status write is gated on a re-read of `status = PENDING`
 *    inside the transaction.
 *
 * ── One transaction per order ──────────────────────────────────────────────
 * A poisoned row must not roll back the orders settled before it, and the
 * whole phase must not hold one connection across every order's Stripe
 * calls. Mirrors `releaseExpiredCarts`.
 *
 * ── No seat release ────────────────────────────────────────────────────────
 * Deliberate. A resale purchase transfers an EXISTING ticket; it takes no
 * seat from the event's pool (`create-resale-checkout` never calls
 * `holdSeatsForCheckout`, and the listing's own hold is already deleted by
 * `cancelOpenForEvent`). There is nothing seat-shaped to hand back, and an
 * unfenced release here would be a double-sell.
 *
 * NEVER THROWS. See `reportError` above.
 */
export async function settleStrandedResaleOrders(
  deps: SettleStrandedResaleOrdersDeps,
  params: {
    eventId: string;
    /**
     * The cancellation's own idempotency key. Namespaces the Stripe refund
     * key so a replay of THIS cancellation cannot issue a second refund.
     */
    idempotencyKey: string;
    /** The caller's bound instant — one per cancellation, not per order. */
    now: Date;
  },
): Promise<SettleStrandedResaleOrdersResult> {
  const result: SettleStrandedResaleOrdersResult = {
    cancelledCount: 0,
    refundedCount: 0,
    strandedCount: 0,
    scanFailed: false,
  };

  const scan = await collectStrandedResaleOrders(deps, params.eventId);
  result.scanFailed = scan.failed;
  const orders = scan.orders;
  if (orders.length === 0) {
    return result;
  }

  for (const order of orders) {
    try {
      await settleOne(deps, params, order, result);
    } catch (err) {
      // Unreachable through `settleOne`'s own branches, which all return.
      // Present so a repo/port that throws where the contract says it
      // returns cannot take the whole phase — and, through it, a cancel that
      // has ALREADY COMMITTED — down with it.
      result.strandedCount++;
      deps.logger?.error("cancel_event_stranded_resale_order_failed", {
        eventId: params.eventId,
        orderId: order.id,
        error: describeError(err),
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          area: "checkout",
          useCase: "cancelEvent",
          step: "settleStrandedResaleOrders",
        },
        extra: {
          eventId: params.eventId,
          orderId: order.id,
          paymentIntentId: order.stripePaymentIntentId,
        },
      });
    }
  }

  deps.logger?.info("cancel_event_stranded_resale_orders_settled", {
    eventId: params.eventId,
    checked: orders.length,
    ...result,
  });

  return result;
}

/**
 * Reads the whole set BEFORE any of it is mutated.
 *
 * Paging with an offset while cancelling as we go would skip rows: every
 * cancelled order drops out of the `PENDING` filter and shifts the rest of
 * the result set left under the next `offset`. Mirrors
 * `collectRefundableOrders` in `cancel-event.ts`.
 *
 * A failed read returns an EMPTY list rather than throwing, for the same
 * reason the phase never throws — the cancellation has already committed.
 * The cart reaper is the backstop; the report is how anyone finds out.
 */
async function collectStrandedResaleOrders(
  deps: SettleStrandedResaleOrdersDeps,
  eventId: string,
): Promise<{ orders: StrandedResaleOrder[]; failed: boolean }> {
  const collected: StrandedResaleOrder[] = [];

  try {
    let offset = 0;
    for (;;) {
      const page = await deps.repos.orders.listAll({
        eventId,
        statuses: ["PENDING"],
        source: "RESALE",
        limit: PAGE_LIMIT,
        offset,
      });

      for (const order of page.items) {
        collected.push({
          id: order.id,
          stripePaymentIntentId: order.stripePaymentIntentId ?? null,
        });
      }

      if (page.items.length < PAGE_LIMIT || offset + PAGE_LIMIT >= page.total) {
        break;
      }
      offset += PAGE_LIMIT;
    }
  } catch (err) {
    deps.logger?.error("cancel_event_stranded_resale_scan_failed", {
      eventId,
      error: describeError(err),
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        useCase: "cancelEvent",
        step: "settleStrandedResaleOrders.scan",
      },
      extra: { eventId },
    });
    return { orders: [], failed: true };
  }

  return { orders: collected, failed: false };
}

async function settleOne(
  deps: SettleStrandedResaleOrdersDeps,
  params: { eventId: string; idempotencyKey: string; now: Date },
  order: StrandedResaleOrder,
  result: SettleStrandedResaleOrdersResult,
): Promise<void> {
  // ── Stripe, with NO transaction open ────────────────────────────────────
  // Refuses (and reports) when the PI is paid / processing, when Stripe
  // throws, or when there is no processor to ask.
  const settle = await settleCarriedOverCartPaymentIntent(order, {
    payments: deps.payments,
    logger: deps.logger,
    reportError: deps.reportError,
    caller: "cancelEvent.strandedResale",
  });

  if (settle.settled) {
    // Proven dead: `canceled`, or no PaymentIntent at all. Nobody was
    // charged, so there is nothing to refund — cancel and hand back.
    const cancelled = await deps.repos.tx(async (tx) => {
      // CAS on the PaymentIntent the settle saw (`null` = none). A resale
      // checkout links its PI after its order commits, so an order scanned
      // with no PI can gain a live one before this cancel; cancelling it then
      // would strand a payable charge on a CANCELLED order.
      const done = await releaseRetiredCartHolds(tx, order.id, {
        now: params.now,
        expectedPaymentIntentId: order.stripePaymentIntentId,
        caller: "cancelEvent.strandedResale",
        logger: deps.logger,
        reportError: deps.reportError,
      });
      if (!done) return false;

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "cancelled_on_event_cancellation",
        data: {
          eventId: params.eventId,
          source: "RESALE",
          paymentIntentId: order.stripePaymentIntentId,
          reason: "resale_listing_cancelled_with_event",
        },
        at: params.now,
      });
      return true;
    });

    if (cancelled) {
      result.cancelledCount++;
    }
    // A declined CAS means the order left PENDING between the scan and now.
    // Nothing was released and nothing is owed — not counted, not reported.
    return;
  }

  const paid =
    settle.refusal.reason === "pi_terminal_not_canceled" &&
    settle.refusal.status === "succeeded";

  if (!paid) {
    // `processing`, `no_processor`, or Stripe threw. The charge may still
    // land, so the order KEEPS everything (the conservative direction — see
    // `settleCarriedOverCartPaymentIntent`). Already reported there; counted
    // here so the caller's result says out loud that a buyer is in limbo.
    result.strandedCount++;
    deps.logger?.error("cancel_event_stranded_resale_order_unsettled", {
      eventId: params.eventId,
      orderId: order.id,
      paymentIntentId: order.stripePaymentIntentId,
      refusal: settle.refusal.reason,
    });
    return;
  }

  await refundPaidStrandedOrder(deps, params, order, result);
}

/**
 * The buyer paid and there is nothing to give them. Refund the charge.
 *
 * ── Why this does NOT go through the event-cancel refund path ───────────────
 * It cannot. `processRefunds` → `assertResaleOrderCanBeUnwound` →
 * `unwindResaleOrderAfterRefund` all assume a FINALIZED resale order: a
 * minted ticket reachable by `tickets.getByOrderItemId`, a SOLD listing to
 * unwind, a seller to transfer back to. This order has none of that —
 * finalize is precisely what failed — so the assert throws TICKET_NOT_FOUND
 * before any refund is attempted, and the in-transaction unwind would throw
 * the same inside the cancellation's own transaction and condemn it.
 *
 * ── Why NO ledger debit is written ─────────────────────────────────────────
 * `writeRefundDebitsForOrder` returns what is left of the order's
 * SETTLEMENT_CREDIT. Finalize is what writes that credit, and finalize never
 * ran: there is no credit, no split, no transfer and no payout behind this
 * order. Routing it through the debit writer would find zero credits and
 * fire the "credit write was lost" alarm — a false alarm on every single
 * one of these — while writing nothing. Money conservation holds without it:
 * the platform took `amount` and returned `amount`, and no payee was ever
 * credited a cent of it.
 *
 * ── Why the FULL PaymentIntent ─────────────────────────────────────────────
 * The buyer received nothing — no ticket, no partial delivery, no item to
 * apportion. Passing no `amountCents` refunds the charge exactly, with no
 * fee/tax arithmetic to get wrong; any under-refund here is the very
 * charged-with-no-ticket residue this exists to remove.
 */
async function refundPaidStrandedOrder(
  deps: SettleStrandedResaleOrdersDeps,
  params: { eventId: string; idempotencyKey: string; now: Date },
  order: StrandedResaleOrder,
  result: SettleStrandedResaleOrdersResult,
): Promise<void> {
  const paymentIntentId = order.stripePaymentIntentId;
  if (!paymentIntentId) {
    // Unreachable: a refusal is only produced for an order that HAS a PI.
    result.strandedCount++;
    return;
  }

  if (!deps.payments?.refundPaymentIntent) {
    // Also unreachable (`no_processor` is not a `paid` refusal), but a
    // missing processor must strand loudly rather than TypeError.
    result.strandedCount++;
    deps.logger?.error("cancel_event_stranded_resale_refund_no_processor", {
      eventId: params.eventId,
      orderId: order.id,
      paymentIntentId,
    });
    reportBestEffort(
      deps.reportError,
      new Error("cancel_event_stranded_resale_refund_no_processor"),
      {
        tags: {
          area: "checkout",
          useCase: "cancelEvent",
          step: "settleStrandedResaleOrders.refund",
        },
        extra: { eventId: params.eventId, orderId: order.id, paymentIntentId },
      },
    );
    return;
  }

  // No `withOrderRefundMutex` here, deliberately. That mutex exists so two
  // refund paths cannot both refund ONE order, and every other path gates on
  // `SUCCEEDED | PART_REFUNDED` — a PENDING order is reachable by none of
  // them. The only other writer that touches it is `releaseExpiredCarts`,
  // which settles the same PI first, sees `succeeded`, and refuses. If one
  // ever did race us, the Stripe idempotency key below returns the FIRST
  // refund rather than issuing a second, and the PENDING re-read in the
  // marking transaction turns the loser into a loud report.
  let refundId: string;
  try {
    const refund = await deps.payments.refundPaymentIntent({
      paymentIntentId,
      reason: "requested_by_customer",
      idempotencyKey: buildStrandedRefundIdempotencyKey(
        params.idempotencyKey,
        order.id,
      ),
    });

    if (refund.status !== "succeeded") {
      // `pending` / `requires_action` / `failed` alike. The money is NOT
      // provably back, so the order is not marked REFUNDED over a refund
      // that may never land — same posture as `ensureSucceededRefund` on the
      // main path. Reported with the refund id so an operator can finish it.
      throw new Error(
        `stranded_resale_refund_not_succeeded:${refund.status}:${refund.refundId}`,
      );
    }
    refundId = refund.refundId;
  } catch (err) {
    result.strandedCount++;
    deps.logger?.error("cancel_event_stranded_resale_refund_failed", {
      eventId: params.eventId,
      orderId: order.id,
      paymentIntentId,
      error: describeError(err),
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        useCase: "cancelEvent",
        step: "settleStrandedResaleOrders.refund",
      },
      extra: { eventId: params.eventId, orderId: order.id, paymentIntentId },
    });
    return;
  }

  // The refund is issued. Record it — and if THIS fails, the money is
  // already back with the buyer and only the bookkeeping is behind, which is
  // the right way round to fail.
  try {
    const marked = await deps.repos.tx(async (tx) => {
      const fresh = await tx.orders.getById(order.id);
      if (!fresh || fresh.status !== "PENDING") return false;

      await tx.orders.markRefunded(order.id);

      // Same three releases `releaseRetiredCartHolds` performs, for the same
      // reason: the buyer got nothing, so a promo code, a fee-waiver
      // allowance or spent platform credit consumed by this order must go
      // back. Not reused wholesale because that helper cancels the order,
      // and CANCELLED would hide a real refund from every money report.
      await tx.promos.releaseHoldsForOrder(order.id);
      await tx.feeWaivers.release(order.id);
      await tx.credits.releaseForOrder(order.id, { now: params.now });

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "refunded_on_event_cancellation",
        data: {
          eventId: params.eventId,
          source: "RESALE",
          paymentIntentId,
          refundId,
          reason: "resale_finalize_lost_to_event_cancellation",
        },
        at: params.now,
      });
      return true;
    });

    if (!marked) {
      // The order left PENDING between the refund and the mark. Refunding a
      // charge whose order then finalised is a real inconsistency, not a
      // no-op — say so loudly rather than counting it as a clean refund.
      throw new Error("stranded_resale_refund_order_not_pending");
    }

    result.refundedCount++;
  } catch (err) {
    result.strandedCount++;
    deps.logger?.error("cancel_event_stranded_resale_mark_failed", {
      eventId: params.eventId,
      orderId: order.id,
      paymentIntentId,
      refundId,
      error: describeError(err),
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        useCase: "cancelEvent",
        step: "settleStrandedResaleOrders.mark",
      },
      extra: {
        eventId: params.eventId,
        orderId: order.id,
        paymentIntentId,
        refundId,
      },
    });
  }
}

export function buildStrandedRefundIdempotencyKey(
  baseIdempotencyKey: string,
  orderId: string,
): string {
  return `${baseIdempotencyKey}:order:${orderId}:refund-stranded-resale`;
}

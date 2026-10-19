import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { describeError } from "../../../lib/io";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import { refundCashOrderInTx } from "../../pos/_shared/refund-cash-order-core";

export interface RefundCashOrdersForCancelledEventResult {
  /** Cash orders (comps included) this phase refunded. */
  refundedCount: number;
  /**
   * Cash orders this phase could NOT refund. Each one stays SUCCEEDED with
   * its CASH_SALE_DEBIT still owed, and each one was reported to Sentry. An
   * org member in `ORG_CASH_REFUND_ROLES` (Owner, Admin, Editor, Finance) can
   * finish it with `orgRefundCashSale`.
   */
  failedCount: number;
  /**
   * True when the scan for the event's cash orders failed outright, so the
   * counts above describe nothing rather than zero.
   */
  scanFailed: boolean;
}

export type RefundCashOrdersForCancelledEventDeps = {
  repos: Pick<Repos, "tx" | "orders">;
  logger?: LoggerPort;
  /**
   * Every failure in this phase is a deliberate swallow (the event is already
   * CANCELLED when it runs, and a throw would report a cancellation that
   * happened as a failed one), so this is the only way they reach Sentry.
   */
  reportError?: ReporterPort | null;
};

const PAGE_LIMIT = 100;

/**
 * Phase 3 of `cancelEvent`: refund the event's door cash sales (owner ruling
 * 2026-10-07, "Cancel + Editor action"). An organiser who gives people their
 * money back should not pay the tax (and, on a sale recorded before the
 * owner ruling of 2026-10-08, the platform fee) for it, so every cash
 * order of a cancelled event is refunded through `refundCashOrderInTx` — the
 * same refund the till and `orgRefundCashSale` run: order and item stamps,
 * tickets voided, any fee waiver an older sale spent back, and the
 * CASH_SALE_DEBIT reversed as recorded. No
 * platform money moves; the organiser hands the cash back.
 *
 * ── Why after the commit, one transaction per order ─────────────────────────
 *  - AFTER: nothing here can make the cancellation fail. A cash order's
 *    bookkeeping is not worth rolling back a cancellation whose card refunds
 *    have already gone out.
 *  - ONE TX PER ORDER: a failure in one order must not stop the rest, and a
 *    failed statement aborts a Postgres transaction, so it cannot be caught
 *    and continued inside a shared one. It also keeps a door with hundreds
 *    of cash sales out of the cancellation's 30-second transaction budget.
 *
 * Idempotent and safe to re-run: only SUCCEEDED orders are collected, the
 * shared refund returns early on a REFUNDED order, and the ledger reverses a
 * debit at most once. An order that fails here (counted, reported) is left
 * SUCCEEDED; the door sweep (`settleDoorOrdersOnCancelledEvents`, run by
 * the cart reaper's job) retries it, and so does a crash between the
 * cancellation's commit and this phase.
 *
 * NEVER THROWS.
 */
export async function refundCashOrdersForCancelledEvent(
  deps: RefundCashOrdersForCancelledEventDeps,
  params: {
    eventId: string;
    /**
     * The cancelling actor, recorded on each refund's audit row. Null when
     * the door sweep finishes a cancellation that did not complete.
     */
    actorHumanId: string | null;
    /** The cancellation's bound instant. */
    now: Date;
    /**
     * Which cash orders to refund.
     *  - `"all"`: every SUCCEEDED cash order, comps and pre-pricing sales
     *    included — the live cancellation, which acts at the moment the
     *    organiser cancels.
     *  - `"unreversed_debit"`: only orders still carrying an unreversed
     *    CASH_SALE_DEBIT — the door sweep, which must never reach back into
     *    an event cancelled before this change existed (code review
     *    2026-10-07). See `settleDoorOrdersOnCancelledEvents`.
     */
    scope: "all" | "unreversed_debit";
  },
): Promise<RefundCashOrdersForCancelledEventResult> {
  const result: RefundCashOrdersForCancelledEventResult = {
    refundedCount: 0,
    failedCount: 0,
    scanFailed: false,
  };

  const scan = await collectCashOrderCandidates(
    deps,
    params.eventId,
    params.scope,
  );
  result.scanFailed = scan.failed;

  for (const orderId of scan.orderIds) {
    try {
      const refunded = await deps.repos.tx((tx) =>
        refundCashOrderInTx(tx, {
          orderId,
          actorHumanId: params.actorHumanId,
          via: "event_cancel",
          now: params.now,
          // The cancellation authorized the actor for the whole event.
          // Defensive: the order must still be this event's.
          authorize: async ({ event }) => {
            if (event.id !== params.eventId) {
              throw fail("ORDER_EVENT_MISMATCH");
            }
          },
          logger: deps.logger,
          reportError: deps.reportError,
        }),
      );
      if (!refunded.alreadyRefunded) {
        result.refundedCount++;
      }
    } catch (err) {
      result.failedCount++;
      deps.logger?.error("cancel_event_cash_order_refund_failed", {
        eventId: params.eventId,
        orderId,
        error: describeError(err),
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          area: "pos",
          useCase: "cancelEvent",
          step: "refundCashOrders",
        },
        extra: { eventId: params.eventId, orderId },
      });
    }
  }

  if (scan.orderIds.length > 0 || scan.failed) {
    deps.logger?.info("cancel_event_cash_orders_refunded", {
      eventId: params.eventId,
      checked: scan.orderIds.length,
      ...result,
    });
  }

  return result;
}

/**
 * Reads the whole candidate set BEFORE any of it is refunded, one keyset page
 * (id ascending) at a time. The query asks for CASH orders only, so a
 * cancelled free event with thousands of SUCCEEDED online orders costs a
 * handful of reads, not one per order.
 *
 * A failed read returns an empty list rather than throwing — the
 * cancellation has already committed. The report is how anyone finds out.
 */
async function collectCashOrderCandidates(
  deps: RefundCashOrdersForCancelledEventDeps,
  eventId: string,
  scope: "all" | "unreversed_debit",
): Promise<{ orderIds: string[]; failed: boolean }> {
  const orderIds: string[] = [];
  try {
    let afterId: string | null = null;
    for (;;) {
      const page: string[] =
        await deps.repos.orders.listSucceededCashOrderIdsForEvent({
          eventId,
          unreversedCashSaleDebitOnly: scope === "unreversed_debit",
          afterId,
          limit: PAGE_LIMIT,
        });
      orderIds.push(...page);
      if (page.length < PAGE_LIMIT) break;
      afterId = page[page.length - 1]!;
    }
  } catch (err) {
    deps.logger?.error("cancel_event_cash_order_scan_failed", {
      eventId,
      error: describeError(err),
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "pos",
        useCase: "cancelEvent",
        step: "refundCashOrders.scan",
      },
      extra: { eventId },
    });
    return { orderIds: [], failed: true };
  }
  return { orderIds, failed: false };
}

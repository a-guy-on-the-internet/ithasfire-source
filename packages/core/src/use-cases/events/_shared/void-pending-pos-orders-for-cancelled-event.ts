import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import type { CartReapQuarantine } from "../../orders/_shared/cart-reap-quarantine";
import {
  pendingPosVoidRefusalIsPermanent,
  voidPendingPosOrder,
} from "../../pos/_shared/void-pending-pos-order";

export interface VoidPendingPosOrdersForCancelledEventResult {
  /** PENDING door card sales this phase voided (PI dead, order CANCELLED). */
  voidedCount: number;
  /**
   * PENDING door card sales this phase could not void for a reason that may
   * clear on its own (a Stripe error, a PaymentIntent still `processing`, a
   * failed transaction). Each was reported; the next sweep tries again.
   */
  failedCount: number;
  /**
   * PENDING door card sales KEPT because voiding them is not this phase's to
   * do: the buyer's PaymentIntent is paid (the order belongs to finalize and
   * its DLQ, and if it finalises it is a paid card sale on a cancelled event
   * that needs a refund by hand), or there is no payment processor. Each was
   * reported. With a quarantine they are then skipped; the daily
   * verify-ledger invariant `cancelled_event_open_door_card_sale` keeps
   * listing them until someone settles them.
   */
  keptCount: number;
  /** Orders skipped because the quarantine still holds them. */
  quarantinedCount: number;
  /** True when the scan itself failed, so the counts describe nothing. */
  scanFailed: boolean;
}

export type VoidPendingPosOrdersForCancelledEventDeps = {
  repos: Pick<Repos, "tx" | "orders">;
  /**
   * Absent = no processor configured. Every order is then KEPT (reported,
   * not voided): cancelling an order under a PaymentIntent nobody asked
   * about is the unsafe direction.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
  clock: ClockPort;
  logger?: LoggerPort;
  /** The only way this phase's failures reach Sentry (it never throws). */
  reportError?: ReporterPort | null;
  /**
   * The door sweep's memory of orders it had to keep (the cart reaper's
   * quarantine, its own instance). A kept order is held `permanent` and
   * skipped on later runs, so a paid-but-unfinalised sale is reported once
   * per process instead of every 30 minutes. `cancelEvent` passes none: it
   * runs once per event and reports every order it could not void.
   */
  quarantine?: CartReapQuarantine;
};

const PAGE_LIMIT = 100;

/**
 * Void the PENDING door card sales of a cancelled event, so a tap on a reader
 * after the cancellation cannot mint tickets for an event that is not
 * happening (code review 2026-10-07, door sales on a cancelled event). Each
 * one runs `voidPendingPosOrder` — the operator's own "cancel this sale":
 * the PaymentIntent is proven dead first, then the order is cancelled and its
 * holds and seats handed back.
 *
 * Runs after the cancellation commits (and again from the door sweep), one
 * order at a time, and NEVER THROWS: a failed void is counted and reported,
 * and the rest carry on. Idempotent: only PENDING orders are collected, and
 * the order cancel is itself a compare-and-set.
 *
 * Two kinds of "could not void", counted apart because the door sweep's job
 * treats them differently: `failedCount` (may clear on its own — the job
 * throws so the run shows as failed) and `keptCount` (cannot clear here —
 * reported once, quarantined, and left to the daily invariant).
 */
export async function voidPendingPosOrdersForCancelledEvent(
  deps: VoidPendingPosOrdersForCancelledEventDeps,
  params: { eventId: string },
): Promise<VoidPendingPosOrdersForCancelledEventResult> {
  const result: VoidPendingPosOrdersForCancelledEventResult = {
    voidedCount: 0,
    failedCount: 0,
    keptCount: 0,
    quarantinedCount: 0,
    scanFailed: false,
  };

  const scan = await collectPendingCandidates(deps, params.eventId);
  result.scanFailed = scan.failed;

  const now = deps.clock.now();
  const held = new Set(deps.quarantine?.active(now) ?? []);

  for (const orderId of scan.orderIds) {
    if (held.has(orderId)) {
      result.quarantinedCount++;
      continue;
    }
    try {
      // PENDING online carts are the cart reaper's; only door card sales
      // are this phase's.
      const order = await deps.repos.orders.getById(orderId);
      if (!order || order.paymentChannel !== "POS") {
        continue;
      }
      if (!deps.payments) {
        throw new Error("no_payment_processor");
      }
      const { cancelled } = await voidPendingPosOrder(
        {
          repos: deps.repos,
          payments: deps.payments,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          id: order.id,
          stripePaymentIntentId: order.stripePaymentIntentId ?? null,
        },
        "cancelEvent",
      );
      deps.quarantine?.forget(order.id);
      if (cancelled) {
        result.voidedCount++;
      }
    } catch (err) {
      const kept =
        (err instanceof Error && err.message === "no_payment_processor") ||
        pendingPosVoidRefusalIsPermanent(err);
      if (kept) {
        result.keptCount++;
        deps.quarantine?.hold({ orderId, now, kind: "permanent" });
      } else {
        result.failedCount++;
      }
      deps.logger?.error("cancel_event_pending_pos_void_failed", {
        eventId: params.eventId,
        orderId,
        kept,
        error: describeError(err),
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          area: "pos",
          useCase: "cancelEvent",
          step: "voidPendingPosOrders",
          outcome: kept ? "kept" : "failed",
        },
        extra: { eventId: params.eventId, orderId },
      });
    }
  }

  return result;
}

async function collectPendingCandidates(
  deps: VoidPendingPosOrdersForCancelledEventDeps,
  eventId: string,
): Promise<{ orderIds: string[]; failed: boolean }> {
  const orderIds: string[] = [];
  try {
    let offset = 0;
    for (;;) {
      const page = await deps.repos.orders.listAll({
        eventId,
        statuses: ["PENDING"],
        // Door sales are PRIMARY (channel POS); resale carts are Phase 2's.
        source: "PRIMARY",
        limit: PAGE_LIMIT,
        offset,
      });
      for (const order of page.items) {
        orderIds.push(order.id);
      }
      if (page.items.length < PAGE_LIMIT || offset + PAGE_LIMIT >= page.total) {
        break;
      }
      offset += PAGE_LIMIT;
    }
  } catch (err) {
    deps.logger?.error("cancel_event_pending_pos_scan_failed", {
      eventId,
      error: describeError(err),
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "pos",
        useCase: "cancelEvent",
        step: "voidPendingPosOrders.scan",
      },
      extra: { eventId },
    });
    return { orderIds: [], failed: true };
  }
  return { orderIds, failed: false };
}

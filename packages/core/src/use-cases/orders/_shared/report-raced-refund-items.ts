import type { LoggerPort } from "@th/ports/logger";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { ReporterPort } from "@th/ports/reporter";

/**
 * Notice — loudly — when a refund's items stopped being `active` between the
 * quote that priced them and the transaction that commits them.
 *
 * THE RACE (money audit 2026-09-08 #19). A refund classifies its items as
 * refundable (`classifyRefundItem` refuses `refunded` and `transferred`),
 * calls Stripe, and only then flips them in its transaction. A gift or an
 * email claim landing in that window used to leave both sides "successful":
 * the sender was refunded AND the recipient held a live pass, because the
 * last write won on the row. The transfer paths are now compare-and-swaps and
 * lose that race cleanly — but they can also WIN it, when the transfer
 * committed before the refund's transaction opened.
 *
 * WHY THIS ONLY REPORTS. By the time we get here Stripe has already moved the
 * money, so `refunded` is the truth of the row whatever raced us, and the
 * refund's own ticket-void step kills the pass the recipient was handed. The
 * refund must NOT fail late — throwing here would roll back the record of a
 * refund the buyer has already been paid. What is left is an operator-visible
 * anomaly: somebody was handed a pass for a ticket that was simultaneously
 * refunded, and a human has to look at it.
 *
 * Reported via `ReporterPort` per CLAUDE.md's error-reporting convention
 * (`logger.error` alone rides pino→Sentry, but this is a deliberate
 * swallow-and-continue, which the convention requires be reported explicitly),
 * and guarded so a throwing reporter can never change refund behaviour.
 *
 * ONE report per refund, not one per item: an order whose items all raced is
 * a single incident, and N events would only fragment it in Sentry.
 */
export function reportRacedRefundItems(params: {
  /** Tag value — which refund path noticed. */
  useCase: string;
  orderId: string;
  /** Items this refund is about to mark `refunded`. */
  refundedItemIds: readonly string[];
  /**
   * The order's items as re-read INSIDE the refund transaction. Reading them
   * outside it would re-open the very window this detects.
   */
  freshItems: ReadonlyArray<Pick<OrderItemRecord, "id" | "status">>;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
}): void {
  const { useCase, orderId, refundedItemIds, freshItems, logger, reportError } =
    params;

  const targeted = new Set(refundedItemIds);
  const raced = freshItems
    .filter((item) => targeted.has(item.id) && item.status !== "active")
    .map((item) => ({ orderItemId: item.id, status: item.status }));

  if (raced.length === 0) {
    return;
  }

  logger?.error("refund.item_raced_after_quote", {
    orderId,
    useCase,
    racedItems: raced,
  });

  try {
    reportError?.(new Error("refund_item_raced_after_quote"), {
      tags: {
        useCase,
        step: "markItemsRefunded",
        reason: "item_not_active_at_commit",
      },
      extra: { orderId, racedItems: raced },
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}

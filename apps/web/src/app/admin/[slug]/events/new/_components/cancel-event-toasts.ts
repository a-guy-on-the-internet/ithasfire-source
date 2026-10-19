import type { TranslationValues } from "@th/locale";

// ─────────────────────────────────────────────────────────────────────────────
// What the organiser is told after `events.cancel` returns.
//
// One toast for the cancellation, then one per thing that still needs a
// person. Each count comes from `cancelEvent` (packages/core/src/use-cases/
// events/cancel-event.ts). The door fields are `.optional()` there for
// cross-deploy replay: `undefined` means "this cancellation predates the
// phase", never zero, and is treated as nothing to say.
//
//  - failedRefundCount: card orders the cancellation could not refund.
//  - refundedCashOrderCount: door cash sales marked refunded. The platform
//    cannot hand cash back, so the organiser is told to.
//  - failedCashRefundCount / cashRefundScanFailed: cash sales still
//    SUCCEEDED. Reported to Sentry; nothing retries them. The organiser is
//    sent to Orders: only an Owner or Admin can cancel an event, Orders'
//    cash refund is theirs, and Sell lists only PUBLISHED events, so a
//    cancelled event's sales cannot be reached there.
//  - failedPendingPosVoidCount: card sales waiting on a reader that could not
//    be cancelled (failed, or kept because the buyer's PaymentIntent is
//    already paid). Reported; a paid one needs a refund by hand from Orders.
//  - pendingPosScanFailed: the scan for those card sales failed outright, so
//    the count above is meaningless rather than zero. Reported; one may still
//    be open with its buyer charged, so the organiser is told what to check.
// ─────────────────────────────────────────────────────────────────────────────

export type CancelEventResultCounts = {
  refundedOrderCount: number;
  failedRefundCount: number;
  refundedCashOrderCount?: number;
  failedCashRefundCount?: number;
  cashRefundScanFailed?: boolean;
  failedPendingPosVoidCount?: number;
  pendingPosScanFailed?: boolean;
};

export type CancelEventToast = {
  tone: "success" | "warning" | "info";
  id: string;
  title: string;
  message: string;
};

type Translate = (key: string, values?: TranslationValues) => unknown;

export function cancelEventResultToasts(
  result: CancelEventResultCounts,
  t: Translate,
): CancelEventToast[] {
  const say = (key: string, values?: TranslationValues) =>
    String(t(key, values));
  const toasts: CancelEventToast[] = [
    {
      tone: "success",
      id: "event-cancelled",
      title: say("admin.ebEventCancelledTitle"),
      message:
        result.refundedOrderCount > 0
          ? say("admin.ebEventCancelledRefunds", {
              count: result.refundedOrderCount,
            })
          : say("admin.ebEventCancelledNoRefunds"),
    },
  ];

  if (result.failedRefundCount > 0) {
    toasts.push({
      tone: "warning",
      id: "event-cancel-refund-failures",
      title: say("admin.ebRefundsFailedTitle"),
      message: say("admin.ebRefundsFailedMessage", {
        count: result.failedRefundCount,
      }),
    });
  }

  const cashRefunded = result.refundedCashOrderCount ?? 0;
  if (cashRefunded > 0) {
    toasts.push({
      tone: "info",
      id: "event-cancel-cash-refunded",
      title: say("admin.ebCashRefundedTitle"),
      message: say("admin.ebCashRefundedMessage", { count: cashRefunded }),
    });
  }

  const cashFailed = result.failedCashRefundCount ?? 0;
  if (cashFailed > 0) {
    toasts.push({
      tone: "warning",
      id: "event-cancel-cash-refund-failures",
      title: say("admin.ebCashRefundsFailedTitle"),
      message: say("admin.ebCashRefundsFailedMessage", { count: cashFailed }),
    });
  }

  // A failed scan makes the cash counts meaningless rather than zero, so it
  // gets its own line even when the counts above said nothing.
  if (result.cashRefundScanFailed === true) {
    toasts.push({
      tone: "warning",
      id: "event-cancel-cash-scan-failed",
      title: say("admin.ebCashRefundScanFailedTitle"),
      message: say("admin.ebCashRefundScanFailedMessage"),
    });
  }

  const posFailed = result.failedPendingPosVoidCount ?? 0;
  if (posFailed > 0) {
    toasts.push({
      tone: "warning",
      id: "event-cancel-pos-void-failures",
      title: say("admin.ebPosVoidsFailedTitle"),
      message: say("admin.ebPosVoidsFailedMessage", { count: posFailed }),
    });
  }

  // Same reasoning as the cash scan: a failed scan says nothing about how
  // many door card sales are still open, so it gets its own line.
  if (result.pendingPosScanFailed === true) {
    toasts.push({
      tone: "warning",
      id: "event-cancel-pos-scan-failed",
      title: say("admin.ebPosScanFailedTitle"),
      message: say("admin.ebPosScanFailedMessage"),
    });
  }

  return toasts;
}

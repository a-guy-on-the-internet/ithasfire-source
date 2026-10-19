import type { RefundUpdated } from "../guards";
import type { LoggerPort } from "@th/ports/logger";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { ReconcileStripeFullRefundOutput } from "@th/core/use-cases/orders/reconcile-stripe-full-refund";

/**
 * Handle a `charge.refund.updated` event.
 *
 * Stripe fires this when an async refund (ACH Direct Debit, bank transfer,
 * Cash App, etc.) transitions out of `pending`. The two terminal states that
 * matter are:
 *
 * - `succeeded` — the buyer's bank accepted the refund. Our DB already
 *   recorded the refund optimistically, so this is a confirmation log.
 * - `failed` — the refund bounced (NSF, closed account, etc.). This is a
 *   **money anomaly**: our DB says "refunded" but the buyer never got the
 *   funds. We write an audit log so the team can reconcile manually
 *   (re-issue via a different method, credit the buyer, etc.).
 *
 * The audit log entry uses `entity: "refund_anomaly"` so it can be queried
 * and alerted on independently from regular audit activity.
 */
export async function onRefundUpdated(
  deps: {
    logger?: LoggerPort;
    audit?: AuditRepo;
    getChargeRefundState?: (input: { chargeId: string }) => Promise<{
      amountRefundedCents: number;
      fullyRefunded: boolean;
    }>;
    reconcileStripeFullRefund?: (input: {
      paymentIntentId: string;
      amountRefundedCents: number;
      currency?: string;
      refundId?: string;
      sourceEventType: "charge.refund.updated";
      fullyRefundedHint?: boolean;
    }) => Promise<ReconcileStripeFullRefundOutput>;
  },
  refund: RefundUpdated,
): Promise<void> {
  if (refund.status === "failed") {
    // This is a money anomaly — the refund we thought succeeded has bounced.
    deps.logger?.error("onRefundUpdated.REFUND_FAILED", {
      refundId: refund.id,
      chargeId: refund.charge,
      paymentIntentId: refund.payment_intent,
      amountCents: refund.amount,
      currency: refund.currency,
      failureReason: refund.failure_reason ?? "unknown",
    });

    // Persist an audit trail so the anomaly is queryable from the DB
    // even if logs rotate or the team isn't watching in real-time.
    if (deps.audit) {
      await deps.audit.log({
        entity: "refund_anomaly",
        entityId: refund.id,
        action: "async_refund_failed",
        data: {
          chargeId: refund.charge,
          paymentIntentId: refund.payment_intent,
          amountCents: refund.amount,
          currency: refund.currency,
          failureReason: refund.failure_reason ?? "unknown",
          reason: refund.reason ?? null,
        },
      });
    }
  } else if (refund.status === "succeeded") {
    let reconcileOutcome:
      | ReconcileStripeFullRefundOutput["outcome"]
      | undefined;

    if (
      refund.payment_intent &&
      refund.charge &&
      deps.reconcileStripeFullRefund &&
      deps.getChargeRefundState
    ) {
      const chargeRefundState = await deps.getChargeRefundState({
        chargeId: refund.charge,
      });

      const result = await deps.reconcileStripeFullRefund({
        paymentIntentId: refund.payment_intent,
        amountRefundedCents: chargeRefundState.amountRefundedCents,
        currency: refund.currency,
        refundId: refund.id,
        sourceEventType: "charge.refund.updated",
        fullyRefundedHint: chargeRefundState.fullyRefunded,
      });
      reconcileOutcome = result.outcome;
    }

    deps.logger?.info("onRefundUpdated.refund_confirmed", {
      refundId: refund.id,
      chargeId: refund.charge,
      paymentIntentId: refund.payment_intent,
      amountCents: refund.amount,
      reconcileOutcome,
    });
  } else {
    // pending, requires_action, canceled — log for observability
    deps.logger?.info("onRefundUpdated.status_change", {
      refundId: refund.id,
      status: refund.status,
      chargeId: refund.charge,
      paymentIntentId: refund.payment_intent,
    });
  }
}

import type { ChargeRefunded } from "../guards";
import type { LoggerPort } from "@th/ports/logger";
import type { ReconcileStripeFullRefundOutput } from "@th/core/use-cases/orders/reconcile-stripe-full-refund";

/**
 * Handle a `charge.refunded` event.
 *
 * Stripe fires this for EVERY refund on a charge — the event name is
 * misleading; `charge.refunded === false` means the refund was PARTIAL.
 * Both arms now reconcile:
 *
 * - **Full** (`refunded: true`): order/items flip to refunded, the payees'
 *   full remaining credit comes back as REFUND_DEBITs — keyed on the
 *   resolved Stripe refund id when available so the debit collides (repo
 *   key-dedupe) with any internal refund path that already debited under
 *   the same refund, with the historical `pi:{pi}:{amount}` fallback when
 *   resolution fails.
 * - **Partial** (`refunded: false`): proportional REFUND_DEBITs keyed on
 *   the Stripe refund id (the original refund-leak door: a dashboard
 *   partial refund returned the buyer's money while the payee's credit
 *   stayed whole and paid out at maturity). The refund id comes from the
 *   charge's embedded `refunds.data[0]` when the API version still
 *   includes it, else from `getLatestRefundId` (a `refunds.list` fetch
 *   wired at the webhook route). If neither yields one, the use case
 *   reports and skips rather than guessing a key.
 */
export async function onChargeRefunded(
  deps: {
    logger?: LoggerPort;
    /**
     * Most-recent refund id for a charge (`stripe.refunds.list` limit 1).
     * Only called for partial events whose payload lacks the embedded
     * refund list. Errors propagate: the webhook DLQ replay is the right
     * retry for a transient Stripe API failure.
     */
    getLatestRefundId?: (input: {
      chargeId: string;
    }) => Promise<string | null | undefined>;
    reconcileStripeFullRefund?: (input: {
      paymentIntentId: string;
      amountRefundedCents: number;
      refundId?: string;
      sourceEventType: "charge.refunded";
      fullyRefundedHint?: boolean;
    }) => Promise<ReconcileStripeFullRefundOutput>;
  },
  charge: ChargeRefunded,
): Promise<void> {
  let reconcileOutcome: ReconcileStripeFullRefundOutput["outcome"] | undefined;

  if (charge.payment_intent && deps.reconcileStripeFullRefund) {
    // Resolve a refund id for BOTH arms. Partials NEED one (their ledger
    // idempotency key). Fulls WANT one: internal refund paths (cancel-event
    // et al.) key their debits on the Stripe refund id, so when reconcile's
    // full arm lands mid-cancel (the mutex gap between cancel's Stripe
    // phase and its final ledger tx), a matching `re_…` key makes the two
    // writes collide at the repo's key-dedupe and most orderings survive
    // with a single debit row. When resolution fails the use case falls
    // back to its amount-namespaced `pi:{pi}:{amount}` key — that fallback
    // MUST remain: rows written under it before this change (deploy
    // boundary) and events whose refund genuinely can't be resolved both
    // rely on the Σ-prior-debits arithmetic being key-shape-agnostic
    // rather than on key equality.
    const refundId =
      charge.refunds?.data[0]?.id ??
      (deps.getLatestRefundId
        ? ((await deps.getLatestRefundId({ chargeId: charge.id })) ??
          undefined)
        : undefined);

    const result = await deps.reconcileStripeFullRefund({
      paymentIntentId: charge.payment_intent,
      amountRefundedCents: charge.amount_refunded,
      ...(refundId ? { refundId } : {}),
      sourceEventType: "charge.refunded",
      fullyRefundedHint: charge.refunded,
    });
    reconcileOutcome = result.outcome;
  }

  deps.logger?.info("onChargeRefunded", {
    chargeId: charge.id,
    paymentIntentId: charge.payment_intent,
    amountRefunded: charge.amount_refunded,
    fullyRefunded: charge.refunded,
    reconcileOutcome,
  });
}

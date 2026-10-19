import type { PaymentIntentFailed } from "../guards";
import type { LoggerPort } from "@th/ports/logger";

/**
 * Handle a `payment_intent.payment_failed` event.
 *
 * The actual order-cancellation logic lives inline in the webhook route
 * (apps/api) because it needs transport-layer context (order lookup by
 * metadata, status-dependent branching). This adapter handler is reserved
 * for any future cross-cutting concerns (e.g., analytics, alerting).
 */
export async function onPaymentIntentFailed(
  deps: { logger?: LoggerPort },
  pi: PaymentIntentFailed,
): Promise<void> {
  deps.logger?.info("onPaymentIntentFailed", { paymentIntentId: pi.id });
}

import type { PaymentIntentSucceeded } from "../guards";
import type { LoggerPort } from "@th/ports/logger";

/**
 * Handle a `payment_intent.succeeded` event.
 *
 * The heavy lifting (finalization, ticket issuance, emails) lives inline
 * in the webhook route (apps/api) because it needs transport-layer deps
 * (mailer, env URLs). This adapter handler is reserved for any future
 * cross-cutting concerns (e.g., analytics, alerting).
 */
export async function onPaymentIntentSucceeded(
  deps: { logger?: LoggerPort },
  pi: PaymentIntentSucceeded,
): Promise<void> {
  deps.logger?.info("onPaymentIntentSucceeded", {
    paymentIntentId: pi.id,
    amount: pi.amount,
    currency: pi.currency,
  });
}

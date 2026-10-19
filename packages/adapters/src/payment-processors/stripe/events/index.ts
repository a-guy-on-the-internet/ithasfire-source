/**
 * Stripe event adapter dispatch.
 *
 * Each handler is a typed, Zod-validated adapter function. The webhook route
 * in `apps/api` currently dispatches events inline (with transport-layer
 * concerns like mailer/env URLs). This module re-exports the adapter handlers
 * so they can be composed into the webhook or used independently.
 *
 * See: apps/api/src/routes/stripe/webhook.ts for the live dispatch.
 */

export { onPaymentIntentSucceeded } from "./handlers/payment-intent-succeeded";
export { onPaymentIntentFailed } from "./handlers/payment-intent-payment-failed";
// `account.updated` has no adapter handler by design: deriving capability
// state is a domain rule shared with the live-read write-back, so it lives in
// core (`@th/core/use-cases/stripe-connect/sync-connect-account`). The adapter
// contributes only the Zod guard (`AccountUpdatedZ`) below.
export { onAccountDeauthorized } from "./handlers/account-deauthorized";
export { onChargeRefunded } from "./handlers/charge-refunded";
export { onRefundUpdated } from "./handlers/refund-updated";

export {
  AccountUpdatedZ,
  AccountDeauthorizedZ,
  ChargeRefundedZ,
  RefundUpdatedZ,
  PaymentIntentSucceededZ,
  PaymentIntentFailedZ,
} from "./guards";

export type {
  AccountUpdated,
  AccountDeauthorized,
  ChargeRefunded,
  RefundUpdated,
  PaymentIntentSucceeded,
  PaymentIntentFailed,
} from "./guards";

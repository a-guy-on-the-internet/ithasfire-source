import type { CheckoutPhase } from "./useCheckoutState";

/**
 * Which screen the checkout shows.
 *
 *  - "payment-received": Stripe took the payment but our confirm failed —
 *    terminal; the webhook finalizes the order.
 *  - "redirect-confirming": a Stripe redirect return being verified.
 *  - "steps": the normal stepped checkout (tickets → details → payment →
 *    confirmed).
 *
 * Neither of the first two may render the steps: a redirect return's phase is
 * "confirming", which maps to the PAYMENT step — a fresh Stripe card with
 * "Pay $45.42" from the pre-hold estimate, and the sidebar and tray quoting
 * the same estimate, for an order already paid.
 */
export type CheckoutScreen = "steps" | "redirect-confirming" | "payment-received";

export function checkoutScreen({
  phase,
  isRedirectReturnPending,
  isPaymentReceivedUnconfirmed,
}: {
  phase: CheckoutPhase;
  isRedirectReturnPending: boolean;
  isPaymentReceivedUnconfirmed: boolean;
}): CheckoutScreen {
  if (isPaymentReceivedUnconfirmed) return "payment-received";
  if (isRedirectReturnPending && phase !== "confirmed" && phase !== "done") {
    return "redirect-confirming";
  }
  return "steps";
}

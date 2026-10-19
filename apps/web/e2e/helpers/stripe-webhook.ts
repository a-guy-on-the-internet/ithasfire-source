import Stripe from "stripe";

// ── Stripe test payment method tokens ─────────────────────────────────
// See https://docs.stripe.com/testing
//
// These tokens simulate specific outcomes when confirming a PaymentIntent
// in Stripe's test mode. Each token triggers a deterministic response.
export const STRIPE_TEST_CARDS = {
  /** Visa — always succeeds, bypasses pending balance (funds available immediately). */
  success: "pm_card_bypassPending",

  /** Visa — always succeeds (normal pending-balance flow). */
  successVisa: "pm_card_visa",

  /** Generic card decline: "Your card was declined." */
  declined: "pm_card_visa_chargeDeclined",

  /** Decline — insufficient funds. */
  insufficientFunds: "pm_card_chargeDeclinedInsufficientFunds",

  /** Decline — expired card. */
  expiredCard: "pm_card_chargeDeclinedExpiredCard",

  /** Decline — incorrect CVC. */
  incorrectCvc: "pm_card_chargeDeclinedIncorrectCvc",

  /** Decline — processing error (transient). */
  processingError: "pm_card_chargeDeclinedProcessingError",

  /** Decline — flagged as fraudulent by the issuer. */
  fraudulent: "pm_card_chargeDeclinedFraudulent",

  /** Blocked by Stripe Radar for suspected fraud (before charge). */
  radarBlock: "pm_card_radarBlock",

  /** Succeeds, then triggers a dispute (charge.dispute.created). */
  createDispute: "pm_card_createDispute",

  /** Succeeds, then triggers a "product not received" dispute. */
  createDisputeProductNotReceived: "pm_card_createDisputeProductNotReceived",
} as const;

export type StripeTestCard = keyof typeof STRIPE_TEST_CARDS;

export async function confirmStripePaymentIntent({
  stripeSecretKey,
  paymentIntentId,
  returnUrl = "http://localhost:3000/checkout/success",
}: {
  stripeSecretKey: string;
  paymentIntentId: string;
  returnUrl?: string;
}) {
  const stripe = new Stripe(stripeSecretKey, {
    // Use the latest Stripe API version matching our types
    apiVersion: "2025-08-27.basil",
  });

  // Confirm the PaymentIntent in Stripe Test Mode using pm_card_bypassPending.
  // This special test card puts funds directly into the available balance
  // (bypassing pending balance), which is required for Connect transfers to
  // succeed in test mode. Without this, transfers fail with "insufficient funds".
  // See: https://docs.stripe.com/testing#available-balance
  //
  // Webhooks should be delivered by Stripe itself (e.g., via
  // `stripe listen --forward-to ...`).
  // Note: return_url is required when automatic_payment_methods is enabled.
  const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
    payment_method: "pm_card_bypassPending",
    return_url: returnUrl,
  });

  if (confirmed.status !== "succeeded") {
    throw new Error(
      `PaymentIntent ${paymentIntentId} is ${confirmed.status}, expected succeeded`,
    );
  }

  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * Attempt to confirm a PaymentIntent with the given test card.
 *
 * Unlike `confirmStripePaymentIntent`, this does NOT throw on failure.
 * Instead it returns a result object so the caller can assert on the
 * outcome (succeeded, requires_payment_method, etc.) and inspect any
 * Stripe error that was returned.
 */
export async function confirmWithTestCard({
  stripeSecretKey,
  paymentIntentId,
  card,
  returnUrl = "http://localhost:3000/checkout/success",
}: {
  stripeSecretKey: string;
  paymentIntentId: string;
  card: StripeTestCard;
  returnUrl?: string;
}): Promise<{
  status: Stripe.PaymentIntent.Status;
  paymentIntent: Stripe.PaymentIntent | null;
  error: Stripe.StripeRawError | null;
  declineCode: string | null;
}> {
  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2025-08-27.basil",
  });

  const paymentMethod = STRIPE_TEST_CARDS[card];

  try {
    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: paymentMethod,
      return_url: returnUrl,
    });

    return {
      status: confirmed.status,
      paymentIntent: confirmed,
      error: null,
      declineCode: null,
    };
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeCardError) {
      // Card-level error — the PI stays in requires_payment_method
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      return {
        status: pi.status,
        paymentIntent: pi,
        error: err.rawType
          ? (err as unknown as { raw: Stripe.StripeRawError }).raw
          : null,
        declineCode: err.decline_code ?? err.code ?? null,
      };
    }

    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      // Radar blocks surface as invalid_request_error with code "blocked"
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      return {
        status: pi.status,
        paymentIntent: pi,
        error: null,
        declineCode:
          (err as Stripe.errors.StripeInvalidRequestError).code ?? "blocked",
      };
    }

    throw err;
  }
}

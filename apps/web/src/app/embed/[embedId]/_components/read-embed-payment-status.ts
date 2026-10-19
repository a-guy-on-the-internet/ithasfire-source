import { getStripe } from "@/config/stripe";
import { STRIPE_VERIFY_TIMEOUT_MS } from "@/lib/stripe-redirect-return";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import { settledWithin } from "./embed-request-timeouts";

// Asking Stripe.js about a PaymentIntent from outside the payment form: the
// widget has no Elements of its own. Kept apart from the status predicates
// in embed-payment-status.ts, which the payment form uses without this
// module's imports.

/**
 * The PaymentIntent's status. Null when Stripe cannot be asked or does not
 * answer in time: the outcome stays unknown, it is never read as "not paid".
 */
export async function readEmbedPaymentStatus(
  clientSecret: string,
): Promise<string | null> {
  const ask = async (): Promise<string | null> => {
    const stripe = await getStripe();
    if (!stripe) {
      traceIgnoredError("embed.paymentStatusUnreadable")(
        new Error("Stripe.js is not available to read the PaymentIntent"),
      );
      return null;
    }
    const { paymentIntent } = await stripe.retrievePaymentIntent(clientSecret);
    if (!paymentIntent) {
      traceIgnoredError("embed.paymentStatusUnreadable")(
        new Error("retrievePaymentIntent answered without a PaymentIntent"),
      );
      return null;
    }
    return paymentIntent.status;
  };
  try {
    const asked = await settledWithin(
      ask().then((status) => ({ status })),
      STRIPE_VERIFY_TIMEOUT_MS,
    );
    if (asked === null) {
      traceIgnoredError("embed.paymentStatusUnreadable")(
        new Error("Stripe.js gave no PaymentIntent status in time"),
      );
      return null;
    }
    return asked.status;
  } catch (err) {
    traceIgnoredError("embed.paymentStatusUnreadable")(err);
    return null;
  }
}

import { getStripe } from "@/config/stripe";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import {
  STRIPE_VERIFY_TIMEOUT_MS,
  isDeadPaymentIntentStatus,
} from "./stripe-redirect-return";

/**
 * What Stripe.js could tell about a redirect return's PaymentIntent.
 *  - `succeeded` / `processing`: it went through (or is clearing);
 *  - `dead`: `requires_payment_method` / `canceled`, nothing taken;
 *  - `live`: any other status (`requires_action`, …), still chargeable;
 *  - `unknown`: no client secret, no Stripe.js, a retrieve error or throw,
 *    or Stripe.js / the retrieve took longer than the timeout.
 */
export type RedirectPaymentIntentVerdict =
  | {
      kind: "succeeded" | "processing" | "live";
      paymentIntentId: string;
      /** The PaymentIntent's amount, in the currency's minor unit. */
      amountCents: number | null;
      /** Lower-case ISO code, as Stripe returns it. */
      currency: string | null;
    }
  | { kind: "dead"; status: "requires_payment_method" | "canceled" }
  | { kind: "unknown" };

class StripeVerifyTimeout extends Error {
  constructor(stage: "load" | "retrieve") {
    super(`stripe.js ${stage} took longer than ${STRIPE_VERIFY_TIMEOUT_MS}ms`);
    this.name = "StripeVerifyTimeout";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  stage: "load" | "retrieve",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StripeVerifyTimeout(stage)),
      STRIPE_VERIFY_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retrieve a redirect return's PaymentIntent with Stripe.js, each step
 * bounded by {@link STRIPE_VERIFY_TIMEOUT_MS}. Never throws.
 *
 * Every `unknown` that is not "no client secret" is reported through
 * `traceIgnoredError` as `<surface>.redirectVerifyTimeout`,
 * `<surface>.redirectVerifyStripeUnavailable` (Stripe.js never loaded, often
 * an ad blocker) or `<surface>.redirectVerifyError`, so a site-wide Stripe.js stall shows up
 * in Sentry rather than only as buyers on a "couldn't confirm" screen.
 *
 * What is reported is a FRESH Error naming only the failure's kind, never
 * the Stripe object or its message: a StripeError can carry the
 * PaymentIntent (with its `client_secret`), and an IntegrationError echoes
 * a malformed secret back in its message.
 *
 * `isCancelled` (the caller unmounted) stops the work between steps; the
 * caller still checks it before acting on the answer.
 */
export async function verifyRedirectPaymentIntent(
  clientSecret: string | null,
  options: { surface: "checkout" | "embed"; isCancelled: () => boolean },
): Promise<RedirectPaymentIntentVerdict> {
  const { surface, isCancelled } = options;
  if (!clientSecret) return { kind: "unknown" };
  const report = (
    label: "Timeout" | "Error" | "StripeUnavailable",
    safeError: Error,
  ) => {
    if (isCancelled()) return;
    traceIgnoredError(`${surface}.redirectVerify${label}`)(safeError);
  };
  try {
    const stripe = await withTimeout(getStripe(), "load");
    if (isCancelled()) return { kind: "unknown" };
    if (!stripe) {
      // Ad blockers do this routinely: its own key, so it never reads as a
      // real verify error. The verdict (and the caller's screen) is the same.
      report("StripeUnavailable", new Error("stripe.js unavailable"));
      return { kind: "unknown" };
    }
    const { paymentIntent, error } = await withTimeout(
      stripe.retrievePaymentIntent(clientSecret),
      "retrieve",
    );
    if (isCancelled()) return { kind: "unknown" };
    if (error || !paymentIntent) {
      report(
        "Error",
        new Error(
          error
            ? `stripe ${String(error.type)}/${error.code ?? "none"}`
            : "stripe retrievePaymentIntent returned nothing",
        ),
      );
      return { kind: "unknown" };
    }
    const { id, status } = paymentIntent;
    if (isDeadPaymentIntentStatus(status)) return { kind: "dead", status };
    const facts = {
      paymentIntentId: id,
      amountCents:
        typeof paymentIntent.amount === "number" ? paymentIntent.amount : null,
      currency:
        typeof paymentIntent.currency === "string"
          ? paymentIntent.currency
          : null,
    };
    if (status === "succeeded" || status === "processing") {
      return { kind: status, ...facts };
    }
    return { kind: "live", ...facts };
  } catch (error) {
    if (error instanceof StripeVerifyTimeout) {
      // Our own error: names the stage and the timeout, nothing else.
      report("Timeout", error);
    } else {
      // Only the constructor name: a thrown IntegrationError's message can
      // quote the client secret.
      const name = error instanceof Error ? error.name : typeof error;
      report("Error", new Error(`stripe.js threw ${name}`));
    }
    return { kind: "unknown" };
  }
}

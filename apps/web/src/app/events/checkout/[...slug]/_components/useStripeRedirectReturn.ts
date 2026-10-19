import { useEffect, useRef } from "react";

import {
  readStripeRedirectParams,
  redirectFailureReason,
  type RedirectFailureReason,
} from "@/lib/stripe-redirect-return";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { verifyRedirectPaymentIntent } from "@/lib/verify-redirect-payment-intent";

export {
  STRIPE_VERIFY_TIMEOUT_MS,
  clearStripeRedirectParams,
  isDeadPaymentIntentStatus,
  redirectFailureReason,
  redirectPaymentIntentId,
  type RedirectFailureReason,
} from "@/lib/stripe-redirect-return";

/** What the page saw of the PaymentIntent before asking the server. */
export type RedirectPaymentSeen = "succeeded" | "processing" | "unverified";

/**
 * Handle the return from a redirect payment method (Amazon Pay, Cash App,
 * Klarna…). See `@/lib/stripe-redirect-return` for the params.
 *
 * The buyer MAY HAVE PAID. So the page only goes back to the steps (where
 * they could buy again) on a VERIFIED failure: Stripe.js retrieves the
 * PaymentIntent and it is `requires_payment_method` / `canceled`
 * → `onDefiniteFailure(reason)`. `redirect_status` is a hint and never
 * decides: `failed` only turns the reason into `declined` once a dead status
 * is verified (here, or by the server: it rides `onConfirm` as `failedHint`).
 * Everything else asks the SERVER, which retrieves the PaymentIntent with
 * the secret key and needs no Stripe.js:
 *  - Stripe.js says `succeeded` / `processing` → `onConfirm(id, that)`;
 *  - no Stripe.js, a retrieve error or throw, a timeout, `requires_action` /
 *    `requires_capture` / `requires_confirmation` / anything new →
 *    `onConfirm(id, "unverified")`, and the server's answer decides (its
 *    PAYMENT_NOT_SUCCEEDED naming a dead status is the only other way back
 *    to the steps; see useCheckoutState);
 *  - no usable id to ask about (`redirectPaymentIntentId`) →
 *    `onUnverifiable()`.
 * Whenever a PaymentIntent param is present, exactly one callback fires
 * (none after unmount), so a page seeded as "being verified" always settles.
 *
 * The params stay in the URL: the caller strips them
 * (`clearStripeRedirectParams`) once the outcome is settled.
 */
export function useStripeRedirectReturn(
  onConfirm: (
    paymentIntentId: string,
    seen: RedirectPaymentSeen,
    failedHint: boolean,
  ) => void,
  onDefiniteFailure: (reason: RedirectFailureReason) => void,
  onUnverifiable: () => void,
): void {
  // The latest callbacks: the caller's change identity on most renders (a
  // tRPC mutation object is new each render), and verification must neither
  // restart nor be cancelled for that. It reads them when it settles.
  const callbacksRef = useRef({ onConfirm, onDefiniteFailure, onUnverifiable });
  useEffect(() => {
    callbacksRef.current = { onConfirm, onDefiniteFailure, onUnverifiable };
  }, [onConfirm, onDefiniteFailure, onUnverifiable]);

  useEffect(() => {
    const redirect = readStripeRedirectParams(
      new URLSearchParams(window.location.search),
    );
    if (!redirect) return;
    const { clientSecret, paymentIntentId, failedHint } = redirect;

    // Unmounted (or StrictMode's dev unmount): nothing more is dispatched
    // and the server is not asked. `settle` is the ONE gate every callback
    // passes, and nothing reaches it before the `await` below, so a mount
    // torn down at once (StrictMode's dev double-run, which unmounts
    // synchronously) is always cancelled first, even with no client secret.
    let cancelled = false;
    let settled = false;
    const settle = (fire: () => void) => {
      if (cancelled || settled) return;
      settled = true;
      fire();
    };
    const confirm = (id: string, seen: RedirectPaymentSeen) =>
      settle(() => callbacksRef.current.onConfirm(id, seen, failedHint));
    // The page cannot tell: let the server (which can) decide.
    const askServer = () => {
      if (paymentIntentId) confirm(paymentIntentId, "unverified");
      else settle(() => callbacksRef.current.onUnverifiable());
    };

    void (async () => {
      const verdict = await verifyRedirectPaymentIntent(clientSecret, {
        surface: "checkout",
        isCancelled: () => cancelled,
      });
      switch (verdict.kind) {
        case "succeeded":
        case "processing":
          // `processing`: delayed-notification methods (ACH, bank transfer),
          // submitted, not yet settled. The webhook finalizes the order.
          confirm(verdict.paymentIntentId, verdict.kind);
          return;
        case "dead":
          settle(() =>
            callbacksRef.current.onDefiniteFailure(
              redirectFailureReason(verdict.status, failedHint),
            ),
          );
          return;
        case "live":
          // requires_action / requires_capture / requires_confirmation /
          // anything new: not something this page can call either way.
          confirm(verdict.paymentIntentId, "unverified");
          return;
        case "unknown":
          askServer();
      }
    })().catch(traceIgnoredError("checkout.redirectReturn"));

    return () => {
      cancelled = true;
    };
  }, []);
}

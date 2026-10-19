/**
 * The return from a Stripe REDIRECT payment method (Amazon Pay, Cash App
 * Pay, Klarna…). Stripe sends the buyer back with
 *   ?payment_intent=pi_xxx&payment_intent_client_secret=pi_xxx_secret_xxx&redirect_status=…
 *
 * Pure helpers shared by the checkout page (`useStripeRedirectReturn`, and
 * its server-side seed in page.tsx) and the embed widget. No Stripe.js here,
 * so a server component can import it; the Stripe.js verification lives in
 * `verify-redirect-payment-intent.ts`.
 *
 * `redirect_status` is a HINT, never a verdict: Stripe's guidance is to
 * retrieve the PaymentIntent. A `failed` return whose PaymentIntent is still
 * live (awaiting approval, say) can yet be charged, so reopening buying on
 * the param alone risks a second charge.
 */

/**
 * A PaymentIntent id the server accepts (`orders.confirmPayment`). A client
 * secret (`pi_xxx_secret_yyy`) is NOT one: the server refuses it too.
 */
const PAYMENT_INTENT_ID = /^pi_(?!.*_secret_)[A-Za-z0-9_]+$/;
/** The server's input bound on a PaymentIntent id. */
const PAYMENT_INTENT_ID_MAX_LENGTH = 255;

/** The query params Stripe appends to a redirect payment's return URL. */
export const STRIPE_REDIRECT_PARAMS = [
  "payment_intent",
  "payment_intent_client_secret",
  "redirect_status",
] as const;

/**
 * How long Stripe.js gets to load, and then to retrieve the PaymentIntent,
 * before the page stops waiting.
 */
export const STRIPE_VERIFY_TIMEOUT_MS = 5_000;

/**
 * The PaymentIntent statuses that mean the payment can no longer complete:
 * nothing was taken and nothing will be. These are the only statuses that
 * send a redirect return back to buying. Every other status
 * (`requires_action`, a Cash App approval still pending; `requires_capture`;
 * `requires_confirmation`; anything Stripe adds) can still end in a charge.
 */
export function isDeadPaymentIntentStatus(
  status: unknown,
): status is "requires_payment_method" | "canceled" {
  return status === "requires_payment_method" || status === "canceled";
}

/** Why a VERIFIED-dead redirect payment failed: picks the copy. */
export type RedirectFailureReason = "declined" | "not_completed" | "canceled";

/**
 * The copy reason for a dead PaymentIntent. `redirect_status=failed` (the
 * hint) only sharpens `requires_payment_method` into "declined"; it is never
 * consulted until the status is verified dead.
 */
export function redirectFailureReason(
  status: "requires_payment_method" | "canceled",
  failedHint: boolean,
): RedirectFailureReason {
  if (status === "canceled") return "canceled";
  return failedHint ? "declined" : "not_completed";
}

function isPaymentIntentId(value: string): boolean {
  return (
    value.length <= PAYMENT_INTENT_ID_MAX_LENGTH && PAYMENT_INTENT_ID.test(value)
  );
}

/**
 * The PaymentIntent id a redirect return is about: the `payment_intent`
 * param, or, when that is missing or malformed, the part of the client
 * secret (`pi_XXX_secret_YYY`) before `_secret_`. Either must pass the id
 * shape the server accepts; otherwise `null` (nothing to ask the server).
 */
export function redirectPaymentIntentId(
  idParam: string | null,
  clientSecret: string | null,
): string | null {
  if (idParam && isPaymentIntentId(idParam)) return idParam;
  if (!clientSecret) return null;
  const at = clientSecret.indexOf("_secret_");
  if (at <= 0) return null;
  const fromSecret = clientSecret.slice(0, at);
  return isPaymentIntentId(fromSecret) ? fromSecret : null;
}

/**
 * Whether a request is a redirect return at all: either PaymentIntent param
 * is PRESENT, whatever its value. Key presence, not value, so the server
 * seed (page.tsx, where a repeated param arrives as an array) and the client
 * (`URLSearchParams`, which reads the first value) can never disagree. A
 * present-but-unusable param still settles: as "unverifiable".
 */
export function hasStripeRedirectParams(has: (key: string) => boolean): boolean {
  return has("payment_intent") || has("payment_intent_client_secret");
}

/** What a redirect return's URL says, read once. */
export type StripeRedirectReturnParams = {
  /** The client secret, for Stripe.js (`null` when absent or empty). */
  clientSecret: string | null;
  /** A usable PaymentIntent id ({@link redirectPaymentIntentId}), or `null`. */
  paymentIntentId: string | null;
  /** `redirect_status=failed`: a hint for the copy only. */
  failedHint: boolean;
};

/** The first non-empty value of a (possibly repeated) param. */
function firstValue(params: URLSearchParams, key: string): string | null {
  return params.getAll(key).find((value) => value !== "") ?? null;
}

/** Read a redirect return's params; `null` when this is not one. */
export function readStripeRedirectParams(
  params: URLSearchParams,
): StripeRedirectReturnParams | null {
  if (!hasStripeRedirectParams((key) => params.has(key))) return null;
  const clientSecret = firstValue(params, "payment_intent_client_secret");
  return {
    clientSecret,
    paymentIntentId: redirectPaymentIntentId(
      firstValue(params, "payment_intent"),
      clientSecret,
    ),
    failedHint: params.get("redirect_status") === "failed",
  };
}

/**
 * Drop Stripe's redirect params from the address bar.
 *
 * When to call it is the caller's policy. The checkout page calls it once
 * the outcome is SETTLED, so a reload of an unsettled return arrives as a
 * redirect return and is checked again. The embed widget calls it as soon as
 * it has read them (the client secret is its guest's proof of payment) and
 * keeps the return in per-embed sessionStorage instead
 * (`useEmbedRedirectReturn`).
 */
export function clearStripeRedirectParams(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!STRIPE_REDIRECT_PARAMS.some((key) => url.searchParams.has(key))) {
      return;
    }
    for (const key of STRIPE_REDIRECT_PARAMS) url.searchParams.delete(key);
    // `null`, not the current history state: the App Router's patched
    // `replaceState` then tells the router, so `useSearchParams` (and the
    // cart URL sync that merges onto it) stops carrying the params.
    window.history.replaceState(null, "", url.toString());
    // The router patches `replaceState` in an effect of its own, which on
    // the first mount can run AFTER the caller's effect. An unpatched call
    // leaves the router's URL holding the params (its next history write
    // would put them back) and drops its history state (`__NA`, which the
    // patched call copies over). Tell it again once it is listening.
    //
    // Checked against next 16.3.0-preview.8 (dist/client/components/
    // app-router.js: `HistoryUpdater` writes `{__NA, tree}` in a
    // useInsertionEffect, and `Router` patches `replaceState` in a later
    // effect). A Next bump re-checks both, and stripe-redirect-return.test.ts.
    if (!(window.history.state as { __NA?: unknown } | null)?.__NA) {
      window.setTimeout(() => {
        try {
          window.history.replaceState(null, "", window.location.href);
        } catch {
          // As below.
        }
      }, 0);
    }
  } catch {
    // Safari throttles history writes; the params only cost a re-check.
  }
}

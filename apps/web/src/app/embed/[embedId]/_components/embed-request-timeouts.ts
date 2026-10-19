// ─────────────────────────────────────────────────────────────────────────────
// How long the embed checkout waits on a request before it stops waiting
//
// The checkout locks its Back button while an order is being created and
// while a payment confirms (see EmbedCheckoutHeader). No request here has a
// deadline of its own, so one that never answers would hold that lock, and a
// spinner, until the buyer reloaded the host page. After these waits the
// checkout lets go. It never decides what the request did: the request may
// still land, and each caller says what that means for it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `createGuestCheckout`. On silence the checkout frees its button and KEEPS
 * its checkout key, so the buyer's retry replays the order the first request
 * made (or is told it is still running) instead of making a second one.
 */
export const CREATE_CHECKOUT_TIMEOUT_MS = 45_000;

/**
 * The bot check's token, when the buyer presses Continue before it has
 * arrived. The checkout shows the button as working and goes on by itself
 * when the token comes. After this long it stops waiting and points at the
 * verification, which may be asking the buyer to do something.
 */
export const VERIFICATION_WAIT_MS = 15_000;

/**
 * `stripe.confirmPayment`. On silence the payment form asks Stripe what the
 * PaymentIntent is, and waits again only for a buyer who is with their bank.
 */
export const CONFIRM_WATCHDOG_MS = 60_000;

/**
 * `embeds.confirmGuestPayment`, the server's word on an order Stripe's
 * browser side says is paid. On silence the widget asks once more, and then
 * stops waiting. Silence is never "not paid": the buyer has paid as far as
 * Stripe.js knows, so the widget says the payment went through, that the
 * order is not confirmed yet, and offers to check again. The request may
 * still land (it finalizes the order whether or not anyone is waiting), and
 * the Stripe webhook finalizes it too.
 */
export const CONFIRM_ORDER_TIMEOUT_MS = 20_000;

/**
 * The pause before that second ask when the first one failed outright. A
 * finalize already running for the order (the webhook's, or the first ask's)
 * refuses a second one for as long as it runs, and this gives it time to end.
 */
export const CONFIRM_ORDER_RETRY_DELAY_MS = 2_000;

/**
 * How long "Check again" rests after an ask that came back without a
 * confirmation, before it takes another press.
 */
export const CHECK_AGAIN_REST_MS = 5_000;

/**
 * `embeds.releaseGuestOrder`, giving back the tickets of an order the buyer
 * left. On silence the widget stops waiting and tells the buyer what it
 * would have told them with no release at all: the tickets can stay reserved
 * until the server's own clean-up. The buyer's next Continue waits on a
 * release that is still out, so this is also the longest that wait can be.
 */
export const RELEASE_ORDER_TIMEOUT_MS = 10_000;

/**
 * What `request` settles with, or null once `ms` pass without it settling.
 * A rejection inside the wait rejects; one after it is the caller's to
 * handle on `request` itself.
 */
export function settledWithin<T>(
  request: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: number | undefined;
  const silence = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), ms);
  });
  return Promise.race([request, silence]).finally(() =>
    window.clearTimeout(timer),
  );
}

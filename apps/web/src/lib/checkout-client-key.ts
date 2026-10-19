import { getAppErrorCode } from "./app-error";

/**
 * Whether a failed checkout call should keep its `clientKey` for the buyer's
 * next attempt. Used by both checkouts: the ticket checkout and embed
 * (`orders.createCheckout`, `createCheckout` in core) and the resale checkout
 * (`resale.createCheckout`, `createResaleCheckout` in core,
 * apps/web/src/app/events/resale/[listingId]/_components/ResaleCheckout.tsx).
 *
 * Keep it whenever the server may have done the work:
 *  - no server app code (a dropped connection, a lost response, a gateway
 *    5xx): the request may have committed an order holding the buyer's
 *    seats, credit and capacity (or, for resale, the listing). The same key replays that stored result; a
 *    fresh key would price a second order beside it and collide with the
 *    first one's holds until the reaper frees them;
 *  - `IDEMPOTENCY_LOCK_IN_PROGRESS`: the first attempt is still running under
 *    this key, and the retry picks up its result.
 *
 * Rotate on any other server refusal. The server has already released the
 * claim (`abandonClaim` in create-checkout.ts and create-resale-checkout.ts),
 * or, for a deterministic
 * `INVALID_INPUT`, marked it failed for 15 minutes, so a fresh key is what
 * lets the corrected cart through.
 *
 * Trade-off: a request that dies mid-flight (SIGTERM, OOM) never releases its
 * lock, which lasts up to 900 s (`IDEMPOTENCY_TTL_SECONDS` in
 * packages/core/src/use-cases/orders/create-checkout.ts and
 * resale/create-resale-checkout.ts). Retries then answer
 * `IDEMPOTENCY_LOCK_IN_PROGRESS` until it lapses or the buyer reloads (a
 * reload mints a new key).
 */
export function keepsCheckoutClientKey(error: unknown): boolean {
  const code = getAppErrorCode(error);
  return code === null || code === "IDEMPOTENCY_LOCK_IN_PROGRESS";
}

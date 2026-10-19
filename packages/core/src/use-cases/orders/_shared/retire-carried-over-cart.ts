import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";

import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import { releaseResaleListingHoldsForOrder } from "./release-resale-listing-holds";

/** The only fields retirement needs off the carried-over order. */
export type CarriedOverCart = {
  id: string;
  stripePaymentIntentId: string | null;
};

/**
 * Why the PaymentIntent could not be proven dead. Returned rather than merely
 * logged so a caller that runs on a loop (the expired-cart reaper) can tell a
 * refusal that will NEVER resolve from one that might, and stop re-probing the
 * former. See `carriedOverCartRefusalIsPermanent`.
 */
export type CarriedOverCartRefusal =
  | { reason: "no_processor" }
  | { reason: "pi_terminal_not_canceled"; status: string }
  | { reason: "pi_settle_failed"; error: unknown };

/**
 * Stripe PaymentIntent statuses that can never become `canceled` afterwards.
 *
 * `succeeded` is the whole list: the buyer has paid, that order belongs to
 * finalize (and, when finalize fails, to its DLQ), and no amount of retrying
 * the cancel will change the answer. `processing` is deliberately NOT here —
 * it resolves to `succeeded` or back to `requires_payment_method`, so it is
 * worth another look later. (`canceled` never reaches a refusal at all: it is
 * the proven-dead path.)
 */
const TERMINAL_PI_STATUSES = new Set(["succeeded"]);

/**
 * Whether a refusal can resolve on its own within this process.
 *
 * `no_processor` counts as permanent because the composition root builds the
 * payment processor once at boot — an environment with no Stripe key at
 * 12:00 still has none at 12:05.
 */
export function carriedOverCartRefusalIsPermanent(
  refusal: CarriedOverCartRefusal,
): boolean {
  if (refusal.reason === "no_processor") return true;
  if (refusal.reason === "pi_terminal_not_canceled") {
    return TERMINAL_PI_STATUSES.has(refusal.status);
  }
  return false;
}

export type SettleCarriedOverCartDeps = {
  /**
   * Needed ONLY to settle the status of a carried-over order's PaymentIntent.
   * `retrievePaymentIntent` is required alongside `cancelPaymentIntent`
   * because a successful-looking cancel does NOT prove the PI is dead — see
   * the terminal-state rule below. Optional so a caller with no processor
   * still compiles, but its absence makes the settle REFUSE rather than
   * proceed, because de-holding a live PI is the unsafe direction.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
  /**
   * Which use case is settling the PI. Every caller (the cart reaper,
   * `releaseCartHold`, finalize's sibling retire, the event cancel's
   * stranded-resale settle, cancelPosSale, createCheckout, claimFreeTickets)
   * has its refusals reported under `area: "checkout"`, so without this a
   * reaper refusal is indistinguishable in Sentry from a createCheckout one.
   */
  caller?: string;
};

/**
 * Settles the carried-over cart's PaymentIntent and reports every refusal.
 *
 * ── The PaymentIntent rule ──────────────────────────────────────────────────
 * A PENDING order's PI is NOT terminal after a decline: Stripe returns it to
 * `requires_payment_method`, where it stays confirmable. The web client also
 * overwrites `state.orderId` with the PAID order id on CHECKOUT_SUCCEEDED, so
 * a retry-after-decline genuinely arrives here carrying a live PI.
 *
 * Handing that cart's inventory to somebody else while its PI can still be
 * confirmed recreates the exact failure this whole guard exists to prevent —
 * the charge lands and there is nothing left to mint (see the reasoning in
 * `pos/assert-pos-capacity.ts` on why a hold must outlive the charge it
 * protects).
 *
 * So the PI is settled FIRST, and the de-hold happens ONLY if the PI is proven
 * dead — cancelled by us, or already `canceled`. A cancel that returns
 * `{ canceled: false }` proves nothing on its own and is disambiguated by
 * reading the status back. The asymmetry is deliberate: FAILING to settle is
 * safe (the stale hold merely expires on its own, which is today's behaviour),
 * while retiring an order whose PI succeeded is a charge with no ticket. When
 * in doubt, keep the hold.
 *
 * Cancelling the superseded PI is also correct independently of capacity: it
 * stops a buyer who still has the old client secret from being charged twice
 * for one cart.
 *
 * ── Runs with no transaction open ───────────────────────────────────────────
 * This is TWO network calls with a worst case of 240 seconds (the Stripe
 * client is `timeout: 60_000, maxNetworkRetries: 1`), against a `repos.tx`
 * budget of 30 seconds and a connection pool of 10. Callers run it BEFORE
 * opening their transaction and open it only with the verdict in hand, then
 * call `releaseRetiredCartHolds` inside it with the settled PI as
 * `expectedPaymentIntentId`. Every production caller does: the expired-cart
 * reaper, `releaseCartHold`, finalize's sibling retire, the event cancel's
 * stranded-resale settle, and the two checkouts (createCheckout and
 * claimFreeTickets, through `settle-carried-over-cart-before-tx.ts`). Never
 * call it with a transaction open.
 *
 * Refusals are reported with `step: "retireCarriedOverCart"`, the name of the
 * in-transaction helper this was split out of (deleted 2026-10-04). The tag
 * value is kept so existing Sentry searches and alerts keep matching.
 */
export async function settleCarriedOverCartPaymentIntent(
  cart: CarriedOverCart,
  deps: SettleCarriedOverCartDeps,
): Promise<{ settled: true } | { settled: false; refusal: CarriedOverCartRefusal }> {
  if (!cart.stripePaymentIntentId) return { settled: true };

  if (!deps.payments) {
    deps.logger?.error("checkout.carried_over_cart.no_processor", {
      orderId: cart.id,
      paymentIntentId: cart.stripePaymentIntentId,
      caller: deps.caller,
    });
    reportBestEffort(
      deps.reportError,
      new Error("carried_over_cart_pi_uncancellable_no_processor"),
      {
        tags: {
          area: "checkout",
          step: "retireCarriedOverCart",
          caller: deps.caller,
        },
        extra: {
          orderId: cart.id,
          paymentIntentId: cart.stripePaymentIntentId,
        },
      },
    );
    return { settled: false, refusal: { reason: "no_processor" } };
  }

  const paymentIntentId = cart.stripePaymentIntentId;

  try {
    const { canceled } = await deps.payments.cancelPaymentIntent({
      paymentIntentId,
    });

    if (!canceled) {
      // NOT a failure signal, and NOT a success signal — the port contract
      // makes `cancelPaymentIntent` a graceful no-op for a PI that is
      // ALREADY TERMINAL, returning `{ canceled: false }` without throwing
      // (the Stripe adapter swallows `payment_intent_unexpected_state`).
      //
      // "Already terminal" covers two opposite worlds:
      //   - `canceled`  — someone already killed it. Safe, and retiring is
      //                   exactly right; this is the idempotent-replay path.
      //   - `succeeded` / `processing` — THE BUYER HAS PAID. Cancelling the
      //                   order here would strand a real charge: the webhook
      //                   would later hit finalize's terminal-status guard,
      //                   throw ORDER_NOT_PROCESSABLE into the DLQ, mint zero
      //                   tickets and create no splits — while the buyer pays
      //                   again for the replacement order.
      //
      // That second case is reachable without any exotic race: pay, close the
      // tab before `confirmPayment` fires, come back and hit Resume. Cart
      // recovery lists the order purely on PENDING + unexpired hold and never
      // inspects PI state, so it arrives here as a perfectly ordinary
      // `pendingOrderId`. So the status has to be read, not assumed.
      const pi = await deps.payments.retrievePaymentIntent({
        paymentIntentId,
      });

      if (pi.status !== "canceled") {
        deps.logger?.error("checkout.carried_over_cart.pi_not_cancellable", {
          orderId: cart.id,
          paymentIntentId,
          status: pi.status,
          caller: deps.caller,
        });
        reportBestEffort(
          deps.reportError,
          new Error(`carried_over_cart_pi_terminal_not_canceled:${pi.status}`),
          {
            tags: {
              area: "checkout",
              step: "retireCarriedOverCart",
              caller: deps.caller,
            },
            extra: { orderId: cart.id, paymentIntentId, status: pi.status },
          },
        );
        return {
          settled: false,
          refusal: { reason: "pi_terminal_not_canceled", status: pi.status },
        };
      }
    }
  } catch (err) {
    // Keep the hold. This is the branch where being conservative costs a
    // slightly over-counted tier for <=15 minutes, and being optimistic
    // costs a real buyer a real charge for a ticket that no longer exists.
    // A throwing `retrievePaymentIntent` lands here too: unknown status is
    // treated exactly like unsafe status.
    deps.logger?.error("checkout.carried_over_cart.pi_cancel_failed", {
      orderId: cart.id,
      paymentIntentId,
      err,
      caller: deps.caller,
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        step: "retireCarriedOverCart",
        caller: deps.caller,
      },
      extra: { orderId: cart.id, paymentIntentId },
    });
    return { settled: false, refusal: { reason: "pi_settle_failed", error: err } };
  }

  return { settled: true };
}

/**
 * Which status the cancel CAS is allowed to move from. It selects the CAS and
 * NOTHING else: the PaymentIntent must have been proven dead first
 * (`settleCarriedOverCartPaymentIntent`) for BOTH statuses.
 *
 * `PENDING` is the carried-over / expired cart. `PROCESSING` is a delayed
 * payment (ACH, bank transfer) whose debit Stripe reported as failed via
 * `payment_intent.payment_failed` — and a "failed" PI is NOT a dead one. It
 * goes back to `requires_payment_method`, where anyone holding the client
 * secret can still confirm it with another bank account; de-holding before
 * the PI is settled recreates the charge-with-no-ticket failure this whole
 * helper exists to prevent.
 */
export type ReleasableCartStatus = "PENDING" | "PROCESSING";

/**
 * Cancels the (PI-settled) cart and hands back everything it was holding.
 *
 * Every statement here is a database write on `tx`; the PaymentIntent must
 * already be proven dead before this is called. Returns whether the CAS
 * actually cancelled the order.
 *
 * `from` selects the CAS (default `PENDING`). The releases are the same
 * either way: a CANCELLED order is invisible to the cart reaper whichever
 * status it came from, so a promo hold, fee-waiver allowance, spent credit
 * or resale listing hold that is not returned HERE is leaked for good.
 *
 * Every canceller of a PENDING order that can be a resale order goes through
 * here (the cart reaper, `releaseCartHold`, the `payment_failed` webhook,
 * finalize's sibling retire, a checkout's carried-over cart, the event
 * cancel's stranded-resale settle), so this is where a resale order's
 * listing hold is given back. Pass a transaction: the cancel and the
 * listing release must commit together.
 */
export async function releaseRetiredCartHolds(
  tx: Pick<
    TxRepos,
    "orders" | "promos" | "feeWaivers" | "credits" | "resaleListings"
  >,
  cartId: string,
  opts: {
    now?: Date;
    from?: ReleasableCartStatus;
    /** Who is cancelling, for the resale-release log and report tags. */
    caller?: string;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
    /**
     * The PaymentIntent the caller settled (`null` = the cart had none). When
     * given, the PENDING cancel CAS also requires the order to still carry
     * exactly this PI. `createCheckout` links its PaymentIntent AFTER the
     * order commits, so a cart read with no PI can gain a live one between
     * the settle and this cancel; cancelling it then strands a payable charge
     * on a CANCELLED order. Omitted → status-only CAS (callers that own the
     * PI themselves, e.g. a checkout unwinding its own order).
     */
    expectedPaymentIntentId?: string | null;
  } = {},
): Promise<boolean> {
  // CAS on the expected status, so a cart that finalised between the PI
  // settle and here is left alone rather than cancelled out from under a real
  // payment.
  const cancelled =
    opts.from === "PROCESSING"
      ? await tx.orders.cancelProcessingOrder(cartId)
      : opts.expectedPaymentIntentId !== undefined
        ? await tx.orders.cancelPendingOrder(cartId, {
            expectedPaymentIntentId: opts.expectedPaymentIntentId,
          })
        : await tx.orders.cancelPendingOrder(cartId);

  if (cancelled) {
    // Promo redemptions were reserved against the superseded order. Leaving
    // them held would burn a single-use code on an attempt that no longer
    // exists — the new order takes its own holds.
    await tx.promos.releaseHoldsForOrder(cartId);

    // Same for fee-waiver allowance: `feeWaivers.reserve` bumped `ticketsUsed`
    // when the superseded cart was quoted. A CANCELLED order is invisible to
    // the expiry reaper (it only reads PENDING rows), so if the reservation is
    // not returned here it is gone for good. `release` is idempotent.
    //
    // NOTE for callers: this only benefits the order that is superseding the
    // cart if retirement runs BEFORE that order's own waiver lookup (see the
    // ordering note in `create-checkout.ts`). Run after it, the allowance
    // comes back for the buyer's NEXT order and the retry still pays the fee.
    await tx.feeWaivers.release(cartId);

    // Platform credit is SPENT at checkout, not held: `applyAvailableCredits`
    // debits `balanceCents` (REDEEMED at zero) and pins a redemption row to
    // this order. With the order now CANCELLED that row points at money that
    // will never be charged, so give it back. Idempotent — a replay finds the
    // redemptions already stamped `releasedAt` and restores nothing.
    //
    // Pass the options object ONLY when a clock was supplied. The adapter
    // would fall back to its own wall clock on `{ now: undefined }` anyway,
    // but the call SHAPE is asserted by the checkout and finalize suites, and
    // handing them an extra argument breaks those for no behavioural gain.
    if (opts.now) {
      await tx.credits.releaseForOrder(cartId, { now: opts.now });
    } else {
      await tx.credits.releaseForOrder(cartId);
    }

    // A resale order holds its listing (HELD + a `ListingHold` row) until
    // finalize sells it. The cancel above matched in THIS transaction, so the
    // order can no longer finalize, and the listing goes back on sale. Fenced
    // on this order's own hold, so a newer hold is never freed. Read back
    // here rather than taken from the caller because only the CAS proves the
    // order is ours to release.
    const order = await tx.orders.getById(cartId);
    if (order && order.source === "RESALE") {
      await releaseResaleListingHoldsForOrder(tx, order, {
        caller: opts.caller ?? "releaseRetiredCartHolds",
        logger: opts.logger,
        reportError: opts.reportError,
        now: opts.now,
      });
    }
  }

  return cancelled;
}

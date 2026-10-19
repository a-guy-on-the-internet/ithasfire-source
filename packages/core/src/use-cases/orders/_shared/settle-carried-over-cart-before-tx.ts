import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
} from "./retire-carried-over-cart";

/**
 * Settle-then-retire for a checkout that supersedes the buyer's carried-over
 * cart (`pendingOrderId`), with no Stripe call inside the transaction.
 *
 * Shared by `createCheckout` (paid path) and `claimFreeTickets` (free path).
 * The design is `docs/decisions/create-checkout-payment-intent-outside-tx.md`,
 * step 1:
 *
 *   1. `settleCarriedOverCartBeforeTx` reads the cart with no transaction open
 *      (buyer + event + PENDING, the same predicate as the in-transaction
 *      read) and settles its PaymentIntent (`settleCarriedOverCartPaymentIntent`,
 *      up to two Stripe calls).
 *   2. `withSettledCarriedOverCart` opens the caller's transaction with that
 *      verdict.
 *   3. Inside it, `retireSettledCarriedOverCart` cancels the cart only through
 *      a CAS on the PaymentIntent the settle observed. If the cart now carries
 *      a different one (another tab linked it after the settle), it throws
 *      `CarriedOverCartChangedError`, the transaction rolls back, and step 1
 *      runs again. The last attempt never throws: the cart stays live.
 */

/**
 * What the pre-transaction settle saw and did. `observedPaymentIntentId` is
 * the PI the cart carried when it was read (`null` = none); `settled` says
 * whether that PI is proven dead (or there was none), i.e. whether the cart
 * may be retired.
 */
export interface SettledCarriedOverCart {
  cartId: string;
  observedPaymentIntentId: string | null;
  settled: boolean;
}

/** Thrown inside the checkout transaction to roll it back and re-settle. */
export class CarriedOverCartChangedError extends Error {
  constructor(readonly cartId: string) {
    super("carried_over_cart_payment_intent_changed");
  }
}

/** Settle + transaction attempts; the last attempt never throws the sentinel. */
export const CARRIED_OVER_CART_SETTLE_ATTEMPTS = 2;

export type SettleCarriedOverCartBeforeTxDeps = {
  repos: Pick<Repos, "orders">;
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
  /** Use case name, for the settle helper's log and report tags. */
  caller: string;
  /**
   * The caller's event-level refusals, re-run with no transaction open. Runs
   * only when there is a cart to settle, and BEFORE the settle, so a checkout
   * that will be refused never cancels the other tab's live PaymentIntent.
   * Throw to refuse.
   */
  beforeSettle?: () => Promise<void>;
};

/**
 * Settles the carried-over cart's PaymentIntent with no transaction open.
 *
 * Same ownership predicate as the in-transaction read (buyer + event +
 * PENDING), so an unvalidated `pendingOrderId` never makes this cancel a
 * stranger's PaymentIntent. Returns `null` when there is no cart to retire;
 * otherwise what was observed and whether it settled (the helper logs and
 * reports every refusal itself).
 *
 * The transaction re-reads the cart and retires it only through a cancel CAS
 * on the observed PI, so anything that changed in between (the cart
 * finalised, or gained a PaymentIntent) leaves it live — the conservative
 * direction.
 */
export async function settleCarriedOverCartBeforeTx(
  deps: SettleCarriedOverCartBeforeTxDeps,
  input: {
    pendingOrderId?: string | null;
    buyerHumanId: string;
    eventId: string;
  },
): Promise<SettledCarriedOverCart | null> {
  if (!input.pendingOrderId) return null;

  const cart = await deps.repos.orders.getById(input.pendingOrderId);
  if (
    !cart ||
    cart.buyerHumanId !== input.buyerHumanId ||
    cart.eventId !== input.eventId ||
    cart.status !== "PENDING"
  ) {
    return null;
  }

  await deps.beforeSettle?.();

  const observedPaymentIntentId = cart.stripePaymentIntentId ?? null;
  const settle = await settleCarriedOverCartPaymentIntent(
    { id: cart.id, stripePaymentIntentId: observedPaymentIntentId },
    {
      payments: deps.payments,
      logger: deps.logger,
      reportError: deps.reportError,
      caller: deps.caller,
    },
  );

  return { cartId: cart.id, observedPaymentIntentId, settled: settle.settled };
}

/**
 * Runs the checkout transaction with the carried-over cart settled first.
 *
 * The tab race this exists for: tab B reads cart O with no PI and settles
 * nothing; tab A's checkout of O links PaymentIntent P; B's retire CAS (on
 * "no PI") loses. Before the settle moved out of the transaction, B's
 * in-transaction read would have seen P and cancelled it. Now B's
 * transaction throws `CarriedOverCartChangedError`, rolls back everything,
 * and this settles P (cancelling it if still cancellable — the same
 * supersede semantics as before) and reruns. The final attempt does not
 * throw: if the cart changes yet again, B proceeds without retiring it (the
 * cart keeps its reservation; nothing is double-sold), which is the
 * conservative direction.
 */
export async function withSettledCarriedOverCart<T>(
  deps: {
    repos: Pick<Repos, "tx">;
    logger?: LoggerPort;
    caller: string;
  },
  settle: () => Promise<SettledCarriedOverCart | null>,
  run: (
    tx: TxRepos,
    settled: SettledCarriedOverCart | null,
    mayRetry: boolean,
  ) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const settled = await settle();
    const mayRetry = attempt < CARRIED_OVER_CART_SETTLE_ATTEMPTS;
    try {
      return await deps.repos.tx((tx) => run(tx, settled, mayRetry));
    } catch (err) {
      if (err instanceof CarriedOverCartChangedError && mayRetry) {
        deps.logger?.info(
          `${deps.caller}.carried_over_cart_changed_resettling`,
          { cartId: err.cartId, attempt },
        );
        continue;
      }
      throw err;
    }
  }
}

/**
 * The database half of the retirement, inside the caller's transaction.
 *
 * Retires `carriedOverCart` (the cart as re-read in this transaction) only if
 * the pre-transaction settle covered this same cart and proved its PI dead,
 * and only through a cancel CAS on the PI that settle observed
 * (`releaseRetiredCartHolds` with `expectedPaymentIntentId`), which also
 * releases its promo holds, fee-waiver allowance, credit and resale listing
 * holds in this transaction.
 *
 * When the cart was not retired and it now carries a different PaymentIntent
 * than the one settled, that PI was never cancelled:
 *   - `mayRetry` → throws `CarriedOverCartChangedError` (the caller's
 *     `withSettledCarriedOverCart` rolls back and settles again);
 *   - last attempt → leaves the cart live and reports it. The cart keeps its
 *     reservation, so nothing is double-sold, and the PI it now carries (the
 *     other tab's) stays live and payable, because it was never settled.
 *     claimFreeTickets creates no PI, so the buyer is left with that one.
 *     createCheckout creates its own PI after this transaction commits, for
 *     its new order, so the buyer then holds two payable PIs for two orders,
 *     each backed by its own reservation; paying both buys both. The cart
 *     resolves when its PI is paid (finalize) or the cart reaper settles it.
 *
 * @returns whether the cart was retired. CALLERS MUST HONOUR IT. A `false`
 * means the superseded order is still live and still owns its reservation,
 * including its SEATS: do not release them (`mintTicketsForOrder` reads
 * `meta.seatIds`, so the new order would double-assign them), and do not
 * exclude the cart from the capacity gate (it mints against its own lines).
 */
export async function retireSettledCarriedOverCart(
  tx: Pick<
    TxRepos,
    "orders" | "promos" | "feeWaivers" | "credits" | "resaleListings"
  >,
  carriedOverCart: { id: string } | null,
  settled: SettledCarriedOverCart | null,
  mayRetry: boolean,
  opts: {
    caller: string;
    /**
     * Forwarded to the credit release and the resale listing release; omit
     * to use the adapter's clock.
     */
    now?: Date;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
): Promise<boolean> {
  if (!carriedOverCart || !settled || settled.cartId !== carriedOverCart.id) {
    return false;
  }

  let retired = false;
  if (settled.settled) {
    retired = await releaseRetiredCartHolds(tx, carriedOverCart.id, {
      ...(opts.now ? { now: opts.now } : {}),
      expectedPaymentIntentId: settled.observedPaymentIntentId,
      caller: opts.caller,
      logger: opts.logger,
      reportError: opts.reportError,
    });
  }
  if (retired) return true;

  // The cart is still live. Re-read here, not the caller's copy: the link can
  // land between that read and the cancel CAS above.
  const fresh = await tx.orders.getById(carriedOverCart.id);
  if (
    !fresh ||
    fresh.status !== "PENDING" ||
    (fresh.stripePaymentIntentId ?? null) === settled.observedPaymentIntentId
  ) {
    return false;
  }

  if (mayRetry) throw new CarriedOverCartChangedError(carriedOverCart.id);

  opts.logger?.error("checkout.carried_over_cart.changed_after_final_settle", {
    orderId: carriedOverCart.id,
    observedPaymentIntentId: settled.observedPaymentIntentId,
    currentPaymentIntentId: fresh.stripePaymentIntentId ?? null,
    caller: opts.caller,
  });
  reportBestEffort(
    opts.reportError,
    new Error("carried_over_cart_changed_after_final_settle"),
    {
      tags: {
        area: "checkout",
        step: "retireSettledCarriedOverCart",
        caller: opts.caller,
      },
      extra: {
        orderId: carriedOverCart.id,
        observedPaymentIntentId: settled.observedPaymentIntentId,
        currentPaymentIntentId: fresh.stripePaymentIntentId ?? null,
      },
    },
  );
  return false;
}

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail, isAppError } from "@th/errors";

import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import {
  collectSeatIds,
  resolveSeatHoldFence,
} from "../../orders/_shared/cart-seat-release";
import {
  carriedOverCartRefusalIsPermanent,
  settleCarriedOverCartPaymentIntent,
} from "../../orders/_shared/retire-carried-over-cart";

export type VoidPendingPosOrderDeps = {
  repos: Pick<Repos, "tx">;
  payments: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

/**
 * Void a PENDING door card sale: prove its PaymentIntent dead, then cancel
 * the order and hand back its promo holds, fee-waiver allowance and seats in
 * one transaction. The body of `cancelPosSale` (the operator's "never mind"),
 * shared with the event cancellation and the door sweep, which void the
 * PENDING card sales of a cancelled event so a tap after the cancel cannot
 * mint tickets for it.
 *
 * Throws, exactly as `cancelPosSale` always has, when the charge cannot be
 * proven dead: ORDER_NOT_PROCESSABLE (`meta.reason`: the PI is paid,
 * processing, or there is no processor) or the Stripe error itself.
 * Returns `{ cancelled: false }` when the order had already left PENDING.
 */
export async function voidPendingPosOrder(
  deps: VoidPendingPosOrderDeps,
  order: { id: string; stripePaymentIntentId: string | null },
  caller: string,
): Promise<{ cancelled: boolean }> {
  // ── The charge dies before the order does, and it must be PROVEN dead ──
  // This used to be a bare `cancelPaymentIntent` whose RESULT was discarded,
  // and that discarded result is the whole bug. The port contract makes
  // `cancelPaymentIntent` a graceful no-op returning `{ canceled: false }`
  // when the PI is already terminal (the Stripe adapter swallows
  // `payment_intent_unexpected_state`), and "already terminal" covers both
  // `canceled` — fine, that is the idempotent replay — and `succeeded` /
  // `processing`, which means THE BUYER HAS ALREADY TAPPED. This is a
  // card-present sale on a reader: the operator hitting "cancel" while the tap
  // settles is an ordinary race at a door, not an exotic one. Cancelling the
  // order in that window strands a real charge — finalize hits its
  // terminal-status guard, throws ORDER_NOT_PROCESSABLE into the DLQ and mints
  // nothing, while this call has already handed the seats back to the pool.
  //
  // So the status is read back rather than assumed, by the same helper the
  // checkout paths use. Outside any transaction, because the cancel + retrieve
  // pair is 240s worst case (`timeout: 60_000, maxNetworkRetries: 1`) against a
  // `repos.tx` budget of 30s and a pool of 10.
  const settle = await settleCarriedOverCartPaymentIntent(
    {
      id: order.id,
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
    },
    {
      payments: deps.payments,
      logger: deps.logger,
      reportError: deps.reportError,
      caller,
    },
  );

  if (!settle.settled) {
    // Every refusal is already logged and reported by the helper; this adds the
    // POS-namespaced line and refuses. Leaving a confirmable — or paid — PI
    // attached to an order we cancelled is the one outcome worse than not
    // cancelling at all, so this throws rather than degrading: the operator
    // retries, or the cart reaper gets it at the window's end.
    deps.logger?.error("pos.cancel_sale.pi_not_settled", {
      orderId: order.id,
      paymentIntentId: order.stripePaymentIntentId,
      reason: settle.refusal.reason,
    });

    if (settle.refusal.reason === "pi_settle_failed") {
      // Unchanged behaviour: surface Stripe's own error to the till.
      throw settle.refusal.error;
    }

    // The PI is terminal and NOT cancelled: the sale is paid (or settling).
    //
    // NOT `ORDER_NOT_PENDING`, deliberately. The till treats that code as
    // proof the order is no longer holding stock and proceeds to ring the same
    // tickets up as a cash sale (`closeOpenOrder` in `SellView.tsx`), which
    // against a paid card sale is a double-sell dressed as error handling.
    // `ORDER_NOT_PROCESSABLE` falls through to the generic failure toast, so
    // the operator is told the void did not happen and the sale stays intact
    // for the webhook to finalise.
    throw fail("ORDER_NOT_PROCESSABLE", {
      meta: {
        orderId: order.id,
        reason: settle.refusal.reason,
        ...(settle.refusal.reason === "pi_terminal_not_canceled"
          ? { paymentIntentStatus: settle.refusal.status }
          : {}),
      },
    });
  }

  // ── Everything else is ONE transaction ─────────────────────────────────
  // These were three bare `deps.repos` calls with the last two swallowing
  // their own errors, so a failure between them left the order CANCELLED with
  // its promo codes still burnt and its seats still HELD — invisibly, and with
  // no way to retry the half that failed. Now a throw rolls the cancel back
  // too and the operator simply hits cancel again (the PI settle above is
  // idempotent: a second pass finds it `canceled` and proceeds).
  //
  // Deliberately NOT `releaseRetiredCartHolds`: that also releases platform
  // credits, which a POS sale cannot spend — its buyer is a per-sale phantom
  // Human created inside `startPosSale`. Fee-waiver allowance it CAN reserve
  // (an organiser-side waiver applies at the door as online, spec 2026-10-07
  // FR-002), so that is released below.
  const cancelled = await deps.repos.tx(async (tx) => {
    // CAS on status=PENDING. A sale that finalised between the PI settle and
    // here is left alone rather than cancelled out from under a real payment.
    const didCancel = await tx.orders.cancelPendingOrder(order.id);
    if (!didCancel) return false;

    await tx.promos.releaseHoldsForOrder(order.id);
    // A CANCELLED order is invisible to the expiry reaper, so the allowance
    // comes back here or never. Idempotent.
    await tx.feeWaivers.release(order.id);

    // Re-read INSIDE the transaction. The copy above was fetched before an RBAC
    // check and a Stripe round-trip that can take minutes.
    const fresh = await tx.orders.getById(order.id);

    if (!fresh) {
      // Unreachable in practice: the CAS above just updated this row in this
      // transaction. If it ever happens the seats stay HELD until the seat
      // reaper's TTL — safe, but silent, so say so.
      deps.logger?.error("pos.cancel_sale.order_vanished", {
        orderId: order.id,
      });
      reportBestEffort(
        deps.reportError,
        new Error("pos_cancel_sale_order_vanished"),
        {
          tags: { useCase: caller, step: "releaseSeats" },
          extra: { orderId: order.id },
        },
      );
      return true;
    }

    const seatIds = collectSeatIds(fresh.items);

    if (seatIds.length > 0) {
      // ── Fenced, because these seats may no longer be ours ──────────────
      // A PENDING POS order reserves capacity for `CAPACITY_HELD_WINDOW_SECONDS`
      // (cart TTL plus two cron periods) while the seat-hold reaper frees HELD
      // seats after only 900s — and that reaper is order-agnostic. So a POS
      // order old enough to be cancelled by hand can easily have had its seats
      // freed and re-let to the next buyer, whose hold is HELD too. An unfenced
      // release — which is what this was — hands that seat back to the pool
      // under somebody else's live PaymentIntent.
      //
      // `resolveSeatHoldFence` reads `meta.holdExpiresAt` where it exists and
      // falls back to `occurredAt`. POS items deliberately carry no hold stamp
      // (the PENDING order's own age IS the reservation — see
      // `assertPosCapacity`) and no POS path ever re-holds an existing order's
      // seats, so `occurredAt` is the exact hold instant here: `startPosSale`
      // stamps the seats HELD and inserts the order in one transaction.
      const heldBefore = resolveSeatHoldFence(fresh);

      if (heldBefore) {
        await tx.seats.releaseSeats({
          seatIds,
          releasedAt: deps.clock.now(),
          heldBefore,
        });
      } else {
        // Unreachable through the Prisma repo (`occurredAt` is NOT NULL and
        // always mapped). Reported rather than released unfenced: an
        // ownership-blind release is the double-sell above, and the seat reaper
        // frees these seats anyway.
        deps.logger?.error("pos.cancel_sale.seat_fence_missing", {
          orderId: order.id,
          seatCount: seatIds.length,
        });
        reportBestEffort(
          deps.reportError,
          new Error("pos_cancel_sale_seat_fence_missing"),
          {
            tags: { useCase: caller, step: "releaseSeats" },
            extra: { orderId: order.id, seatCount: seatIds.length },
          },
        );
      }
    }

    return true;
  });

  return { cancelled };
}

/**
 * Whether an error thrown by `voidPendingPosOrder` is a refusal no retry in
 * this process can resolve: the PaymentIntent is terminal and NOT cancelled
 * (the buyer paid — the order belongs to finalize and its DLQ), or there is
 * no payment processor at all. The cart reaper's rule
 * (`carriedOverCartRefusalIsPermanent`), read back off the
 * ORDER_NOT_PROCESSABLE the void throws. Everything else — a Stripe error,
 * a PaymentIntent still `processing`, a failed transaction — may resolve on
 * its own and is not permanent.
 */
export function pendingPosVoidRefusalIsPermanent(err: unknown): boolean {
  if (!isAppError(err) || err.code !== "ORDER_NOT_PROCESSABLE") return false;
  const reason = err.meta?.reason;
  if (reason === "no_processor") return true;
  const status = err.meta?.paymentIntentStatus;
  return (
    reason === "pi_terminal_not_canceled" &&
    typeof status === "string" &&
    carriedOverCartRefusalIsPermanent({ reason, status })
  );
}

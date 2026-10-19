import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { fail } from "@th/errors";
import {
  collectSeatIds,
  resolveSeatHoldFence,
} from "./_shared/cart-seat-release";
import {
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
} from "./_shared/retire-carried-over-cart";

export const releaseCartHoldInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orderId: z.string().uuid(),
  })
  .strict();

export const releaseCartHoldOutputSchema = z
  .object({
    released: z.boolean(),
    /**
     * Set (to `true`) only with `released: false`, when there was no cart left
     * to release: the order does not exist, or it is CANCELLED (released
     * already, reaped on expiry, or retired by a carry-over, whose seats now
     * belong to its successor). This order holds nothing, so releasing it
     * frees nothing and the buyer can hold afresh. Absent on every other
     * `released: false`: the cart is KEPT (its PaymentIntent would not settle,
     * a CAS lost a race) or it was paid. Optional, so a client reading an
     * older API sees "kept".
     */
    gone: z.literal(true).optional(),
  })
  .strict();

export type ReleaseCartHoldInput = z.infer<typeof releaseCartHoldInputSchema>;
export type ReleaseCartHoldOutput = z.infer<typeof releaseCartHoldOutputSchema>;

export type ReleaseCartHoldDeps = {
  /**
   * Deliberately narrow, matching `releaseExpiredCarts`. Only the ownership
   * read happens outside the transaction; every WRITE is on the `tx` handle,
   * and a wide `Pick<Repos, …>` here is an open invitation to the regression
   * this use case just had — a seat release that escaped the transaction and
   * could not be rolled back. If you need a repo outside `tx`, add it on
   * purpose.
   */
  repos: {
    tx: Repos["tx"];
    orders: Pick<Repos["orders"], "getById">;
  };
  /**
   * Required in practice, optional in the type so a caller with no processor
   * still compiles. Its ABSENCE makes a PI-bearing cart REFUSE to release
   * (see `settleCarriedOverCartPaymentIntent`) rather than de-hold under a
   * live PaymentIntent. Carts with no PI release regardless.
   *
   * Needs `retrievePaymentIntent` as well as `cancelPaymentIntent`: a cancel
   * that returns `{ canceled: false }` proves nothing on its own.
   */
  payments?: PaymentProcessorPort | null;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry hook for the branches that swallow. Every refusal here
   * is a cart KEPT under a possibly-paid PaymentIntent, which is precisely the
   * thing that must not be invisible — and `logger.warn`, which this use case
   * used to report it with, is NOT captured (CLAUDE.md).
   */
  reportError?: ReporterPort | null;
};

/**
 * Releases a cart hold: cancels a PENDING order and hands back its seat,
 * promo, fee-waiver and credit holds.
 *
 * Called when the buyer explicitly abandons checkout — in practice from
 * `navigator.sendBeacon` on page close (`POST /api/cart/release`) and from the
 * cart-recovery UI. That origin is the whole design constraint: it fires while
 * the order is still PENDING and its PaymentIntent may ALREADY BE PAID, and
 * the request can be aborted at any point mid-flight.
 *
 * ── The PaymentIntent is settled FIRST, outside any transaction ────────────
 * A PENDING order's PI stays confirmable until something cancels it. Pay,
 * close the tab, and the beacon can reach here before Stripe's webhook does.
 * Cancelling the order in that window strands a real charge: finalize hits its
 * terminal-status guard, throws ORDER_NOT_PROCESSABLE into the DLQ, mints zero
 * tickets — the buyer is charged, has no ticket, and nothing was refunded. So
 * the PI is settled first and the cart is only retired once that proved the PI
 * dead. A refusal KEEPS everything, seats included: the order is still payable
 * and `mintTicketsForOrder` still mints against `meta.seatIds`. Failing to
 * release is a hold that expires on its own; releasing under a live PI is a
 * double-sell. When in doubt, keep the hold.
 *
 * Stripe runs with no transaction open for the same reason the expired-cart
 * reaper does: the client is `timeout: 60_000, maxNetworkRetries: 1`, so the
 * cancel + retrieve pair is 240 seconds worst case against a `repos.tx` budget
 * of 30 and a pool of 10.
 *
 * ── Everything else is ONE transaction ─────────────────────────────────────
 * The cancel, the promo / fee-waiver / credit releases and the seat release
 * are one `repos.tx`. Before this they were bare `deps.repos` calls with the
 * SEATS FREED FIRST, so a declined CAS — or any throw — left the order PENDING
 * with its seats already handed to somebody else. It could still be paid, and
 * mint would still claim those seats. That is a double-sell with no reaper
 * involved.
 *
 * ── Idempotent, and safe to abort ──────────────────────────────────────────
 * Re-entry is cheap and harmless at every point:
 *  - after a completed run, the order is CANCELLED and the status check
 *    returns before any write;
 *  - aborted between the PI settle and the transaction, a second call
 *    re-settles — `cancelPaymentIntent` on an already-`canceled` PI is the
 *    graceful `{ canceled: false }` no-op, and the status probe confirms
 *    `canceled` — then completes the transaction;
 *  - aborted inside the transaction, it rolls back and the cart is untouched;
 *  - two beacons racing both settle, then `cancelPendingOrder`'s CAS lets
 *    exactly one proceed, so the seats are never released twice.
 */
export async function releaseCartHold(
  deps: ReleaseCartHoldDeps,
  rawInput: unknown,
): Promise<ReleaseCartHoldOutput> {
  const logger = deps.logger?.child({ useCase: "releaseCartHold" });

  const execute = async () => {
    const input = parseInput(releaseCartHoldInputSchema, rawInput);

    // Ownership first, and outside the transaction: a stranger's order id must
    // not open one, and this read decides only whether to proceed.
    const order = await deps.repos.orders.getById(input.orderId);

    if (!order) {
      // Order doesn't exist: nothing holds seats under it.
      return { released: false, gone: true as const };
    }

    if (order.buyerHumanId !== input.actorHumanId) {
      // Not the owner - unauthorized
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "order" } });
    }

    if (order.status !== "PENDING") {
      // Already finalized (succeeded, cancelled, refunded) — nothing to
      // release, and this is the fast path for a repeated beacon. Only a
      // CANCELLED cart is `gone`: a paid one must never be held afresh.
      return order.status === "CANCELLED"
        ? { released: false, gone: true as const }
        : { released: false };
    }

    const now = deps.clock.now();

    // ── Stripe, with no transaction open ─────────────────────────────────
    // Logs and reports every refusal itself, so the swallow below stays a
    // plain early return.
    const settle = await settleCarriedOverCartPaymentIntent(
      {
        id: order.id,
        stripePaymentIntentId: order.stripePaymentIntentId ?? null,
      },
      {
        payments: deps.payments,
        logger,
        reportError: deps.reportError,
        caller: "releaseCartHold",
      },
    );

    if (!settle.settled) {
      // The buyer has paid (or Stripe would not answer). The cart keeps its
      // order row, its PaymentIntent and — critically — its seats, and
      // finalize takes it from here.
      return { released: false };
    }

    const released = await deps.repos.tx(async (tx) => {
      // CAS on status=PENDING AND the PI settled above, then the promo,
      // fee-waiver and credit holds. A cart that finalised between the PI
      // settle and here is left alone, and so is one that gained a PI:
      // createCheckout links its PaymentIntent after the order commits.
      const cancelled = await releaseRetiredCartHolds(tx, order.id, {
        now,
        expectedPaymentIntentId: order.stripePaymentIntentId ?? null,
        caller: "releaseCartHold",
        logger,
        reportError: deps.reportError,
      });
      if (!cancelled) return false;

      // Re-read INSIDE the transaction. The copy above was fetched before a
      // network round-trip that can take minutes, and `updateOrderItems` may
      // have re-held different seats in the meantime — releasing the stale
      // list would free seats this order no longer owns and leave the ones it
      // does.
      const fresh = await tx.orders.getById(order.id);

      if (!fresh) {
        // Unreachable in practice: the CAS above just updated this row in
        // this transaction. If it ever happens the seats stay HELD until the
        // seat reaper's TTL, which is safe but silent — so say so.
        logger?.error("release_cart_hold_order_vanished", {
          orderId: order.id,
        });
        reportBestEffort(
          deps.reportError,
          new Error("release_cart_hold_order_vanished"),
          {
            tags: {
              area: "checkout",
              step: "releaseCartHold",
              useCase: "releaseCartHold",
            },
            extra: { orderId: order.id },
          },
        );
        return true;
      }

      const seatIds = collectSeatIds(fresh.items);

      if (seatIds.length > 0) {
        // Both fences matter (see `resolveSeatHoldFence`): `releaseSeats`
        // carries `status = "HELD"` so a seat the next buyer already PAID for
        // cannot be flipped back, and `heldBefore` stops the other half — a
        // seat the next buyer is holding RIGHT NOW is HELD too. The old code
        // used `seats.updateStatuses`, which carries neither.
        const heldBefore = resolveSeatHoldFence(fresh);

        if (heldBefore) {
          await tx.seats.releaseSeats({
            seatIds,
            releasedAt: now,
            heldBefore,
          });
        } else {
          // Unreachable through the Prisma repo (`occurredAt` is NOT NULL and
          // always mapped). Reported rather than released unfenced: an
          // ownership-blind release here is a double-sell, and the seat
          // reaper frees these seats anyway.
          logger?.error("release_cart_hold_seat_fence_missing", {
            orderId: order.id,
            seatCount: seatIds.length,
          });
          reportBestEffort(
            deps.reportError,
            new Error("release_cart_hold_seat_fence_missing"),
            {
              tags: {
                area: "checkout",
                step: "releaseCartHold",
                useCase: "releaseCartHold",
              },
              extra: { orderId: order.id, seatCount: seatIds.length },
            },
          );
        }
      }

      return true;
    });

    return { released };
  };

  if (logger) {
    return logger.withTime("releaseCartHold", execute);
  }

  return execute();
}

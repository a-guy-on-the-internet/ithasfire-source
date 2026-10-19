import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import type { CartReapQuarantine } from "./_shared/cart-reap-quarantine";
import {
  SEAT_FENCE_SLACK_SECONDS,
  collectSeatIds,
} from "./_shared/cart-seat-release";
import {
  carriedOverCartRefusalIsPermanent,
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
} from "./_shared/retire-carried-over-cart";

/**
 * Default: expire orders older than 20 minutes.
 *
 * Exported because capacity accounting depends on it: a PENDING order's
 * PaymentIntent stays confirmable until this job cancels it, so anything that
 * reserves capacity for an in-flight charge must cover at least this long.
 * See `assertPosCapacity`.
 */
export const DEFAULT_CART_TTL_SECONDS = 20 * 60;

/**
 * How often the job actually runs — recorded, and drift-guarded against the
 * manifest, in `./_shared/cart-reaper-cycle.ts`.
 *
 * Eligibility is not the same as reaping: an order becomes eligible at
 * `DEFAULT_CART_TTL_SECONDS` but is only cancelled on the next successful pass,
 * so the true upper bound on a live PaymentIntent is TTL + at least one cron
 * period. Consumers reasoning about "how long can this charge still land"
 * must add this.
 */
export { CART_REAPER_PERIOD_SECONDS } from "./_shared/cart-reaper-cycle";

/** Carts per scan. A pass takes pages of this size until it runs dry. */
export const DEFAULT_REAPER_PAGE_SIZE = 100;

/**
 * Wall-clock budget for one pass: no cart STARTS after it. See
 * `PI_CART_RESERVE_MS` for the carts that carry a PaymentIntent.
 *
 * THROUGHPUT IS MONEY HERE. A cart the reaper has not reached reserves its
 * tickets only for `CAPACITY_HELD_WINDOW_SECONDS` (80 min), while its
 * PaymentIntent stays confirmable until the reaper cancels it, so a backlog
 * that outgrows the reaper is an oversell. Until 2026-10-08 a pass took ONE
 * page of 100 every 15 minutes (400 carts/h); every 30 minutes, one page
 * would halve that. So a pass now keeps taking pages until one comes back
 * short.
 *
 * Why a time budget and not simply a bigger page: each cart costs one or two
 * Stripe round-trips, so a fixed count has no fixed duration. The door sweep
 * runs after the reaper in the same request, inside the job's 300s attempt
 * deadline (manifest) and Cloud Run's 300s request timeout, so the reaper
 * must leave it room.
 *
 * WHAT THE BUDGET GUARANTEES. A check before each cart cannot stop a cart
 * already running, and one Stripe call can take up to 120s (the adapter's
 * 60s timeout plus one retry). Hence two cutoffs:
 *   - no cart with a PaymentIntent starts in the last `PI_CART_RESERVE_MS`
 *     (120s) of the budget, i.e. after 90s;
 *   - no cart at all starts after 210s. A cart without a PaymentIntent is
 *     one DB transaction (30s budget at most).
 * A Stripe call that runs to its 120s limit THROWS, which ends that cart's
 * Stripe work (the status read only follows a cancel that answered). So the
 * reaper is done by about 210s plus one transaction, and the door sweep keeps
 * at least ~60s. The one path past that: a cancel that takes nearly its full
 * 120s, then answers `{ canceled: false }`, then a status read that also runs
 * to its limit, started at 90s: up to ~330s. Money stays safe on that path;
 * only the door sweep loses its turn until the next tick.
 *
 * At ~0.5s a PaymentIntent cart, 90s is ~180 of them a pass (~360/h), plus
 * every cart without one until 210s. A pass that stops on a cutoff with
 * carts left reports it (`hasMore`, plus `reportError`), because a backlog
 * that outlasts a full pass is the oversell risk this exists for.
 */
export const DEFAULT_REAPER_TIME_BUDGET_MS = 210_000;

/**
 * The end of the budget that no PaymentIntent cart may START in: one Stripe
 * call's worst case (60s timeout × (1 + 1 retry), stripe-adapter.ts). Lowering
 * the Stripe timeout for this caller would let the reserve shrink, but the
 * port has no per-call timeout and a shorter one turns slow-Stripe minutes
 * into refusals (safe, but more quarantine churn), so the reserve stays here.
 */
export const PI_CART_RESERVE_MS = 120_000;

/**
 * When a page has this much DEPENDENCY trouble, the pass stops: at least
 * `MIN_TROUBLE_PER_PAGE` carts, or 10% of the page, whichever is more.
 *
 * Trouble = Stripe threw (`pi_settle_failed`) or the cart's transaction threw.
 * NOT trouble: Stripe answering with a status (`pi_terminal_not_canceled`, a
 * `processing` or paid PI) — that is Stripe working, about one cart.
 *
 * Why not "any one failure stops the pass": a single poisoned cart (a PI id
 * Stripe always 404s on, a row whose transaction always throws) sits among the
 * OLDEST rows, so it is on page 1 of every pass, and its quarantine does not
 * outlive a tick (the base cooldown is 5 minutes on purpose, see
 * cart-reap-quarantine.ts, and the jobs service scales to zero, which empties
 * it). One bad row would cap the reaper at one page a pass. The threshold is
 * max(3, 10% of the page): 3 on a page of up to 30 carts, 10 on a full page
 * of 100. That many distinct failures is a failing dependency rather than a
 * bad row, and stopping then spares it the rest of the backlog. The pass
 * stops AS SOON AS the threshold is reached, so an outage costs that many
 * calls, not a page of timeouts.
 */
export const MIN_TROUBLE_PER_PAGE = 3;
const TROUBLE_FRACTION_PER_PAGE = 0.1;

/** Belt to the time budget's braces: pages one pass may take. */
export const DEFAULT_REAPER_MAX_PAGES = 10;

export const releaseExpiredCartsInputSchema = z
  .object({
    ttlSeconds: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(500).optional(),
    maxPages: z.number().int().positive().max(50).optional(),
    timeBudgetMs: z.number().int().positive().max(240_000).optional(),
  })
  .strict();

export const releaseExpiredCartsOutputSchema = z
  .object({
    cancelledCount: z.number().int().min(0),
    /**
     * Retired carts that carried a PaymentIntent. Retirement only proceeds
     * once the PI is proven terminal-`canceled`, so this is the number of
     * PIs this pass took (or confirmed) out of play — a subset of
     * `cancelledCount`.
     */
    piCancelledCount: z.number().int().min(0),
    /**
     * Carts this pass KEPT because their PaymentIntent could not be proven
     * dead, or because their transaction threw. Each is now in quarantine.
     */
    refusedCount: z.number().int().min(0),
    /**
     * Carts excluded from this pass's scan because a previous refusal is
     * still in cooldown. A number that only ever grows is the signal that
     * carts are wedging (almost always: paid PI, failed finalize).
     */
    quarantinedCount: z.number().int().min(0),
    /** Scans this pass took (each up to `limit` carts). */
    pages: z.number().int().min(0),
    /**
     * True when the pass stopped before its scan ran dry: on the time budget
     * (or the PaymentIntent reserve), on `maxPages`, or on a page whose
     * dependency trouble reached the threshold (`MIN_TROUBLE_PER_PAGE`) while
     * carts may remain. The next pass takes the rest. Carts REFUSED this pass
     * are not "left over": they are in quarantine and counted in
     * `refusedCount`, so a short page that refused some still reports false.
     */
    hasMore: z.boolean(),
  })
  .strict();

export type ReleaseExpiredCartsInput = z.infer<
  typeof releaseExpiredCartsInputSchema
>;
export type ReleaseExpiredCartsOutput = z.infer<
  typeof releaseExpiredCartsOutputSchema
>;

export type ReleaseExpiredCartsDeps = {
  /**
   * Deliberately narrow. Everything except the expired-order scan happens on
   * the transaction handle, and a wide `Pick<Repos, …>` here invites exactly
   * the regression this job cannot afford — a write that escapes the
   * transaction and cannot be rolled back. If you need a repo outside `tx`,
   * add it here on purpose.
   */
  repos: {
    tx: Repos["tx"];
    orders: Pick<Repos["orders"], "listExpiredPending">;
  };
  /**
   * Optional so a caller with no processor still compiles, but its absence
   * makes every PI-bearing cart REFUSE to retire (see
   * `settleCarriedOverCartPaymentIntent`): de-holding under a live PI is the
   * unsafe direction. Carts with no PI are reaped regardless.
   *
   * A composition root whose processor is an always-throwing stub (no Stripe
   * key) must pass `undefined` rather than the stub — the refusal is then the
   * documented, quarantined `no_processor` one instead of an exception on
   * every cart, every pass, forever.
   */
  payments?: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort Sentry hook for carts the reaper had to KEEP. */
  reportError?: ReporterPort | null;
  /**
   * REQUIRED, not optional: without it a permanently-refusing cart is retried
   * every pass forever, which starves every reapable cart behind it and emits
   * 288 Sentry events a day. See `_shared/cart-reap-quarantine.ts`. Build one
   * per process at the composition root, not per call.
   */
  quarantine: CartReapQuarantine;
};

/**
 * Cancels PENDING orders that have been open longer than the TTL, cancels
 * their Stripe PaymentIntents, and releases their seat / promo / fee-waiver /
 * credit holds.
 *
 * A RESALE order's listing hold is released in the same transaction as its
 * cancel (`releaseRetiredCartHolds`, fenced on the order's own hold), so the
 * listing goes back on sale. A hold this reaper never reaches (its order was
 * already CANCELLED by a process that died before releasing it) is freed by
 * the stale-hold sweep in `resale/expire-resale-listings.ts`.
 *
 * ── Order of operations (money audit #26) ──────────────────────────────────
 * The PaymentIntent is settled FIRST, and the order is cancelled ONLY once
 * the PI is proven dead. A PENDING order's PI stays confirmable until it is
 * cancelled, so cancelling the order first and then failing (or no-op'ing)
 * the PI cancel leaves a window where the buyer's charge lands against a
 * CANCELLED order: the webhook hits finalize's terminal-status guard, throws
 * ORDER_NOT_PROCESSABLE into the DLQ, and the buyer is charged with no
 * ticket — the failure 0479f975 fixed for finalize's stale-cart path.
 * `settleCarriedOverCartPaymentIntent` owns that rule; a refusal from it
 * means the cart is still live and KEEPS everything, seats included.
 *
 * ── Stripe runs OUTSIDE the transaction ────────────────────────────────────
 * The Stripe client is `timeout: 60_000, maxNetworkRetries: 1` — 120 seconds
 * worst case per call, 240 for the cancel + retrieve pair — against a
 * `repos.tx` budget of 30 seconds and a pool of 10 connections. Settling
 * inside the transaction would hold a pooled connection across all of that
 * for every expired cart. So the PI is settled first with no transaction
 * open, and the transaction is opened only with the proven-`canceled`
 * verdict in hand. The gap that creates is safe in both directions: a PI that
 * is `canceled` cannot come back to life, and `cancelPendingOrder` is a CAS
 * on PENDING, so an order that finalised in the gap is left alone.
 *
 * `create-checkout.ts` and `create-resale-checkout.ts` follow the same rule:
 * they create their PI after the order commits, and createCheckout and
 * claimFreeTickets settle a superseded cart's PI before opening their
 * transaction (docs/decisions/create-checkout-payment-intent-outside-tx.md).
 *
 * ── One transaction per cart ───────────────────────────────────────────────
 * The order cancel, the hold releases and the seat release run in one
 * `repos.tx`. A CANCELLED order is never revisited (`listExpiredPending`
 * reads PENDING only), so a throw AFTER `cancelPendingOrder` outside a
 * transaction would leave the credit and fee-waiver allowance leaked for
 * good, with nothing to retry. Inside one, it is a rollback: the cart stays
 * PENDING and the next pass takes it again.
 *
 * ── Refusals are quarantined ───────────────────────────────────────────────
 * A cart whose PI succeeded can never be retired, and it is one of the OLDEST
 * PENDING rows, so it sits at the head of every page forever: two Stripe
 * calls and one Sentry event every pass, and one fewer slot for a cart that
 * could actually be reaped. Every refusal therefore goes into
 * `deps.quarantine` and is excluded from the next scan until its cooldown
 * lapses (never, for a terminal PI status — that order belongs to finalize
 * and its DLQ). Excluding it from the scan is also what rate-limits the
 * report, since the report happens at probe time.
 *
 * Designed to be called by a cron job.
 */
export async function releaseExpiredCarts(
  deps: ReleaseExpiredCartsDeps,
  rawInput: unknown,
): Promise<ReleaseExpiredCartsOutput> {
  const logger = deps.logger?.child({ useCase: "releaseExpiredCarts" });

  const execute = async () => {
    const input = parseInput(releaseExpiredCartsInputSchema, rawInput);
    // ONE instant for the whole pass, deliberately: the scan cutoff, every
    // `releasedAt` and every quarantine cooldown are stamped from it. A long
    // pass therefore opens each cooldown up to its own length (minutes) in
    // the past. Harmless: inside the pass `seen` already skips the cart, and
    // the 5-minute base cooldown is meant to lapse well before the next tick
    // anyway (cart-reap-quarantine.ts). The alternative (re-reading the clock
    // per cart) would make the cutoff drift under the scan it selected from.
    // Not a bug; do not "fix" it by moving the call into the loop.
    const now = deps.clock.now();
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_CART_TTL_SECONDS;
    const cutoff = new Date(now.getTime() - ttlSeconds * 1000);
    const limit = input.limit ?? DEFAULT_REAPER_PAGE_SIZE;
    const maxPages = input.maxPages ?? DEFAULT_REAPER_MAX_PAGES;
    // The deadline is the ONE thing that reads the clock afresh: it measures
    // how long this pass has run, not when the pass happened, so it cannot
    // share `now`. Every stamp above still comes from `now`.
    const deadlineAt =
      now.getTime() + (input.timeBudgetMs ?? DEFAULT_REAPER_TIME_BUDGET_MS);
    const pastDeadline = () => deps.clock.now().getTime() >= deadlineAt;
    const pastPiCutoff = () =>
      deps.clock.now().getTime() >= deadlineAt - PI_CART_RESERVE_MS;

    // Carts still in cooldown are excluded IN THE QUERY, not filtered after
    // it. Filtering afterwards would leave them occupying page slots, which
    // is the head-of-line starvation this exists to prevent.
    const quarantined = deps.quarantine.active(now);

    // Every cart this pass has already handled is excluded from its later
    // pages too. Each one either left PENDING or went into quarantine, but
    // the quarantine sheds entries when it is full, and a page that served
    // the same carts again would loop until the budget ran out.
    const seen = new Set<string>();

    let cancelledCount = 0;
    let piCancelledCount = 0;
    let refusedCount = 0;
    let pages = 0;
    let checked = 0;
    let hasMore = false;
    let stoppedOnBound: "time_budget" | "max_pages" | "trouble" | null = null;

    pageLoop: for (;;) {
      const expiredOrders = await deps.repos.orders.listExpiredPending({
        createdBefore: cutoff,
        limit,
        excludeOrderIds: [...quarantined, ...seen],
      });
      pages++;
      // Dependency trouble on this page (see MIN_TROUBLE_PER_PAGE): enough of
      // it stops the pass at once, like the outbox drains, because hammering
      // a failing dependency with the rest of the backlog only burns it
      // faster. One or two bad rows do not.
      let pageTrouble = 0;
      const troubleThreshold = Math.max(
        MIN_TROUBLE_PER_PAGE,
        Math.ceil(expiredOrders.length * TROUBLE_FRACTION_PER_PAGE),
      );

      for (const order of expiredOrders) {
        if (pageTrouble >= troubleThreshold) {
          // Stopped mid-page: the rest of this page is still waiting.
          hasMore = true;
          stoppedOnBound = "trouble";
          break pageLoop;
        }
        if (pastDeadline()) {
          hasMore = true;
          stoppedOnBound = "time_budget";
          break pageLoop;
        }
        if (order.stripePaymentIntentId && pastPiCutoff()) {
          // Held back for the next pass (PI_CART_RESERVE_MS): one Stripe call
          // could outrun the budget. Carts WITHOUT a PaymentIntent behind it
          // still run until the full budget, so the pass goes on. `seen`
          // keeps later pages from serving this cart again.
          seen.add(order.id);
          hasMore = true;
          if (!stoppedOnBound) stoppedOnBound = "time_budget";
          continue;
        }
        seen.add(order.id);
        checked++;
        const cart = {
          id: order.id,
          stripePaymentIntentId: order.stripePaymentIntentId ?? null,
        };

        try {
          // ── Stripe, with no transaction open ───────────────────────────
          // Refuses (returns a reason, logs, reports) when the PI is paid /
          // processing, when Stripe throws, or when there is no processor to
          // ask. A refused cart keeps its whole reservation — seats included,
          // because `mintTicketsForOrder` reads `meta.seatIds` and the order
          // is still payable.
          const settle = await settleCarriedOverCartPaymentIntent(cart, {
            payments: deps.payments,
            logger,
            reportError: deps.reportError,
            caller: "releaseExpiredCarts",
          });

          if (!settle.settled) {
            const kind = carriedOverCartRefusalIsPermanent(settle.refusal)
              ? "permanent"
              : "backoff";
            deps.quarantine.hold({ orderId: cart.id, now, kind });
            // Only "Stripe threw" is trouble. A refusal that carries a status
            // is Stripe answering about one cart (a `processing` PI, a paid
            // one), and no-processor is configuration, not an outage.
            if (settle.refusal.reason === "pi_settle_failed") pageTrouble++;
            refusedCount++;
            continue;
          }

          const retired = await deps.repos.tx(async (tx) => {
            // CAS on PENDING AND the PI settled above, then promo, fee-waiver
            // and credit holds. The PI half matters because createCheckout
            // links its PaymentIntent after the order commits: a cart read
            // with no PI may carry a live one by now.
            const cancelled = await releaseRetiredCartHolds(tx, cart.id, {
              now,
              expectedPaymentIntentId: cart.stripePaymentIntentId,
              caller: "releaseExpiredCarts",
              logger,
              reportError: deps.reportError,
            });
            if (!cancelled) return false;

            const fullOrder = await tx.orders.getById(cart.id);

            if (!fullOrder) {
              // Unreachable in practice — the CAS above just updated this row
              // in this transaction. If it ever happens the cart's seats stay
              // HELD until the seat reaper's own TTL, which is safe but silent,
              // so say so rather than skipping quietly.
              logger?.error("release_expired_cart_order_vanished", {
                orderId: cart.id,
              });
              reportBestEffort(
                deps.reportError,
                new Error("release_expired_cart_order_vanished"),
                {
                  tags: {
                    area: "checkout",
                    step: "releaseExpiredCarts",
                    useCase: "releaseExpiredCarts",
                  },
                  extra: { orderId: cart.id },
                },
              );
              return true;
            }

            const seatIds = collectSeatIds(fullOrder.items);
            if (seatIds.length > 0) {
              // ── Why this release is BOTH status- and time-fenced ──────────
              //
              // `meta.seatIds` is stale by construction, and the staleness is
              // guaranteed by configuration rather than won by a race: the
              // seat-hold TTL (900s, `tickets/release-expired-holds`) is
              // SHORTER than the cart TTL (1200s) plus a cron period (1800s,
              // `_shared/cart-reaper-cycle.ts`), so this cart's seats are
              // ALWAYS freed 5-35 minutes before the reaper arrives, and
              // another buyer can hold and pay for one in that window. Both fences are answers to that same window:
              //
              //  - `status = "HELD"` (inside `releaseSeats`, unlike the blind
              //    `updateStatuses`) stops a seat the next buyer has already
              //    PAID for — SOLD, with a Ticket attached — being flipped
              //    back to AVAILABLE.
              //  - `heldBefore` stops the other half: a seat the next buyer is
              //    holding RIGHT NOW is HELD, so the status predicate waves it
              //    through. `Seat` has no holder column, so "is this hold
              //    mine?" can only be asked of `updatedAt`.
              //
              // The fence is this order's OWN `occurredAt` (plus a small
              // slack, see `SEAT_FENCE_SLACK_SECONDS`) and NOT the pass's
              // `cutoff`. Two reasons:
              //
              //  - It brackets this cart's hold. `create-checkout` stamps the
              //    seats and inserts the order in one transaction, and
              //    `update-order-items` re-holds on every edit without ever
              //    rewriting `occurredAt`; nothing else writes the column. So
              //    an untouched cart's seats sit within a transaction's width
              //    of `occurredAt`, and an EDITED cart's sit further out and
              //    are simply left to the seat reaper — a leak that self-heals,
              //    not a theft.
              //  - Another buyer's hold is provably outside it.
              //    `holdSeatsForCheckout` only takes AVAILABLE seats, so a
              //    competing hold cannot be stamped until ours is released,
              //    which is at least 900s (the seat-hold TTL) after ours.
              //
              // `cutoff` (now − TTL) has neither property: it is pass-relative,
              // not cart-relative. Let the reaper fall behind — a backlog past
              // `limit`, or the job down for an hour — and `cutoff` marches
              // past a competing hold taken long after this cart died, which
              // is exactly the theft this fence exists to prevent.
              if (fullOrder.occurredAt instanceof Date) {
                await tx.seats.releaseSeats({
                  seatIds,
                  releasedAt: now,
                  heldBefore: new Date(
                    fullOrder.occurredAt.getTime() +
                      SEAT_FENCE_SLACK_SECONDS * 1000,
                  ),
                });
              } else {
                // Unreachable through the Prisma repo (`occurredAt` is NOT NULL
                // and always mapped). Reported rather than released unfenced:
                // an ownership-blind release here is a double-sell, and the
                // seats are freed by the seat reaper anyway.
                logger?.error("release_expired_cart_seat_fence_missing", {
                  orderId: cart.id,
                  seatCount: seatIds.length,
                });
                reportBestEffort(
                  deps.reportError,
                  new Error("release_expired_cart_seat_fence_missing"),
                  {
                    tags: {
                      area: "checkout",
                      step: "releaseExpiredCarts",
                      useCase: "releaseExpiredCarts",
                    },
                    extra: { orderId: cart.id, seatCount: seatIds.length },
                  },
                );
              }
            }

            return true;
          });

          if (!retired) {
            // The CAS declined: the order left PENDING between the scan and
            // now (finalize took it, or an operator cancelled it). It will not
            // come back from `listExpiredPending`, so there is nothing to
            // quarantine and nothing was released.
            continue;
          }

          deps.quarantine.forget(cart.id);
          cancelledCount++;
          if (cart.stripePaymentIntentId) piCancelledCount++;
        } catch (err) {
          // The tx has rolled back, so the cart is still PENDING. Quarantine it
          // on a backoff: a cart that throws every pass (a poisoned row, a
          // constraint that will not clear) would otherwise sit at the head of
          // the page forever, exactly like a refusing PI. Report as well as
          // log: the jobs process has no pino→Sentry bridge, so `logger.error`
          // alone is invisible.
          deps.quarantine.hold({ orderId: cart.id, now, kind: "backoff" });
          pageTrouble++;
          refusedCount++;

          logger?.error("release_expired_cart_failed", {
            orderId: order.id,
            error: String(err),
          });
          reportBestEffort(deps.reportError, err, {
            tags: {
              area: "checkout",
              step: "releaseExpiredCarts",
              useCase: "releaseExpiredCarts",
              caller: "releaseExpiredCarts",
            },
            extra: {
              orderId: cart.id,
              paymentIntentId: cart.stripePaymentIntentId,
            },
          });
        }
      }

      // A short page means the scan ran dry: nothing left to take, whatever
      // went wrong on it (its refused carts are quarantined, not left over).
      if (expiredOrders.length < limit) break;
      if (pageTrouble >= troubleThreshold) {
        // A FULL page that reached the threshold on its last cart.
        hasMore = true;
        stoppedOnBound = "trouble";
        break;
      }
      if (pages >= maxPages) {
        hasMore = true;
        stoppedOnBound = "max_pages";
        break;
      }
      if (pastDeadline()) {
        hasMore = true;
        stoppedOnBound = "time_budget";
        break;
      }
    }

    if (stoppedOnBound) {
      // Not a swallow — nothing failed — but the one signal that the reaper
      // is falling behind the 80-minute capacity window, and the jobs process
      // has no pino→Sentry bridge, so it is reported rather than only logged.
      const backlog = new Error("cart_reaper_backlog");
      logger?.error("release_expired_carts_backlog", {
        reason: stoppedOnBound,
        pages,
        checked,
        limit,
      });
      reportBestEffort(deps.reportError, backlog, {
        tags: {
          area: "checkout",
          step: "releaseExpiredCarts",
          useCase: "releaseExpiredCarts",
          caller: "releaseExpiredCarts",
          reason: stoppedOnBound,
        },
        extra: { pages, checked, limit, cancelledCount, refusedCount },
      });
    }

    logger?.info("release_expired_carts_complete", {
      checked,
      pages,
      hasMore,
      cancelledCount,
      piCancelledCount,
      refusedCount,
      quarantinedCount: quarantined.length,
    });

    return releaseExpiredCartsOutputSchema.parse({
      cancelledCount,
      piCancelledCount,
      refusedCount,
      quarantinedCount: quarantined.length,
      pages,
      hasMore,
    });
  };

  if (logger) {
    return logger.withTime("releaseExpiredCarts", execute);
  }

  return execute();
}

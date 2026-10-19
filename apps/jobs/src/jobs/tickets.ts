/**
 * Ticketing Jobs
 *
 * Background work related to ticket lifecycle:
 * - Releasing expired seat holds
 * - Releasing expired carts (cancel stale PENDING orders + PIs), then the
 *   door sweep: finish any cancelled event's door orders
 *   (settleDoorOrdersOnCancelledEvents)
 * - Expiring stale resale listings
 *
 * There is no claim-expiry job: a resale claim is never closed automatically,
 * staff review every one (owner ruling Q9, 2026-10-06).
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { releaseExpiredSeatHolds } from "@th/core/use-cases/tickets/release-expired-holds";
import { releaseExpiredCarts } from "@th/core/use-cases/orders/release-expired-carts";
import { createCartReapQuarantine } from "@th/core/use-cases/orders/_shared/cart-reap-quarantine";
import { expireResaleListings } from "@th/core/use-cases/resale";
import { settleDoorOrdersOnCancelledEvents } from "@th/core/use-cases/events/settle-door-orders-on-cancelled-events";

// ─────────────────────────────────────────────────────────────────────────────
// tickets.release-expired-holds - Cron job to clean up stale holds
// ─────────────────────────────────────────────────────────────────────────────
export const releaseExpiredHolds = defineScheduledTask({
  name: "tickets.release-expired-holds",
  description:
    "Release orphaned seat holds that have exceeded their TTL (open carts belong to release-expired-carts).",
  input: z.object({
    ttlSeconds: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  schedule: getSchedule("tickets.release-expired-holds"),
  handler: async ({ input, ctx }) => {
    const result = await releaseExpiredSeatHolds(
      {
        repos: { seats: ctx.repos.seats },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );
    ctx.logger.info("tickets.release-expired-holds.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// tickets.release-expired-carts - Cron job to cancel stale PENDING orders + PIs
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Process-lifetime memory of carts the reaper refused to retire. Built ONCE,
 * at module scope, on purpose: a per-invocation instance remembers nothing,
 * and a cart whose PaymentIntent succeeded but whose finalize DLQ'd would then
 * be re-probed every pass forever — 48 Sentry events a day, and one
 * fewer slot in an oldest-first page for a cart that could actually be reaped.
 * See `_shared/cart-reap-quarantine.ts` for why this is memory and not a
 * column.
 */
const cartReapQuarantine = createCartReapQuarantine();

/**
 * The door sweep's own memory of door card sales it had to keep on a
 * cancelled event (PaymentIntent already paid, finalize in the DLQ). Same
 * module, separate instance: the sweep's orders are not the reaper's, and
 * sharing one would let either evict the other's entries. A kept sale is
 * reported once per process and then skipped, instead of failing this job
 * and paging Sentry every 30 minutes; the daily verify-ledger invariant
 * `cancelled_event_open_door_card_sale` is its durable signal.
 */
const doorSweepQuarantine = createCartReapQuarantine();

export const releaseExpiredCartsJob = defineScheduledTask({
  name: "tickets.release-expired-carts",
  description:
    "Cancel stale PENDING orders and their Stripe PaymentIntents, releasing held seats.",
  input: z.object({
    ttlSeconds: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  schedule: getSchedule("tickets.release-expired-carts"),
  handler: async ({ input, ctx }) => {
    const result = await releaseExpiredCarts(
      {
        repos: {
          // One transaction per cart: cancel + hold releases + seat release
          // roll back together, so a CANCELLED order can never outlive a
          // failed release (a cancelled order is never revisited). Seats,
          // promos, fee waivers and credits are reached through the tx
          // handle, so they are deliberately NOT passed here.
          tx: ctx.repos.tx,
          orders: ctx.repos.orders,
        },
        // The stub the container hands out when STRIPE_SECRET_KEY is unset
        // throws on every call, which the use case would read as a Stripe
        // outage and retry forever. `undefined` gets the documented
        // no-processor refusal instead: still conservative (a PI-bearing cart
        // is KEPT, because this process cannot prove the charge is dead), but
        // reported once and then quarantined rather than every pass.
        payments: ctx.paymentsConfigured ? ctx.payments : undefined,
        clock: ctx.clock,
        logger: ctx.logger,
        // A cart the reaper had to KEEP (PI paid / processing, Stripe down)
        // is a real charge that still needs finalizing — surface it.
        reportError: ctx.reportError,
        quarantine: cartReapQuarantine,
      },
      input,
    );
    ctx.logger.info("tickets.release-expired-carts.completed", result);

    // ── The door sweep (event cancellation, owner ruling 2026-10-07) ────────
    // `cancelEvent` refunds a cancelled event's door cash sales (reversing
    // their fee + tax debits) and voids its PENDING door card sales AFTER its
    // commit, and nothing there re-runs that step. This does, every run
    // (every 30 minutes): same phases, idempotent, so a crash or a failed
    // order costs minutes, not money.
    // Rides this job rather than a new one: same cadence the door needs (a
    // reader tap must not outlive a cancellation for long), no new manifest
    // entry. Runs after the reaper so the reaper's work is logged either way.
    const doorSweep = await settleDoorOrdersOnCancelledEvents(
      {
        repos: { tx: ctx.repos.tx, orders: ctx.repos.orders },
        payments: ctx.paymentsConfigured ? ctx.payments : undefined,
        clock: ctx.clock,
        logger: ctx.logger,
        // Every failed order is reported here, by the phase that failed it.
        reportError: ctx.reportError,
        quarantine: doorSweepQuarantine,
      },
      {},
    );
    ctx.logger.info("tickets.door-sweep.completed", doorSweep);

    // apps/jobs answers 200 unless the handler THROWS, so a sweep that left
    // an organiser owing fee + tax on returned cash (or a live card sale on a
    // cancelled event) must throw to show up as a failed run. Each order was
    // already reported with its own context; this is the run-level alarm.
    // KEPT card sales (paid PaymentIntent) are deliberately not counted: the
    // sweep did the right thing by keeping them, they were reported once and
    // quarantined, and failing every run over them would bury real reaper
    // failures. Only what may clear on its own fails the run.
    const unsettled =
      doorSweep.failedCashRefundCount +
      doorSweep.failedPendingPosVoidCount +
      doorSweep.scanFailedEventCount;
    if (unsettled > 0) {
      throw new Error(
        `door_sweep_incomplete: ${doorSweep.failedCashRefundCount} cash refund(s), ` +
          `${doorSweep.failedPendingPosVoidCount} card sale void(s), ` +
          `${doorSweep.scanFailedEventCount} event scan(s) failed`,
      );
    }

    return { ...result, doorSweep };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// tickets.expire-resale-listings - Hourly job: release stale listing holds, then expire listings
// ─────────────────────────────────────────────────────────────────────────────
export const expireResaleListingsJob = defineScheduledTask({
  name: "tickets.expire-resale-listings",
  description:
    "Expire ACTIVE resale listings past their expiry or event end, and release stale HELD listings.",
  input: z.object({}),
  schedule: getSchedule("tickets.expire-resale-listings"),
  handler: async ({ ctx }) => {
    const result = await expireResaleListings({
      repos: ctx.repos,
      clock: ctx.clock,
      logger: ctx.logger,
      // The stale-hold sweep reports a paid order on a HELD listing, a HELD
      // listing with no hold, and any listing it failed to release.
      reportError: ctx.reportError,
    });
    ctx.logger.info("tickets.expire-resale-listings.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all ticket jobs
// ─────────────────────────────────────────────────────────────────────────────
export const ticketJobs = [
  releaseExpiredHolds,
  releaseExpiredCartsJob,
  expireResaleListingsJob,
];

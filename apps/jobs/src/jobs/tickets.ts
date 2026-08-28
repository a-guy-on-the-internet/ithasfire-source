/**
 * Ticketing Jobs
 *
 * Background work related to ticket lifecycle:
 * - Releasing expired seat holds
 * - Releasing expired carts (cancel stale PENDING orders + PIs)
 * - Expiring stale resale listings
 * - Expiring open resale claims past their deadline
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { releaseExpiredSeatHolds } from "@th/core/use-cases/tickets/release-expired-holds";
import { releaseExpiredCarts } from "@th/core/use-cases/orders/release-expired-carts";
import { expireResaleListings } from "@th/core/use-cases/resale";
import { expireClaims } from "@th/core/use-cases/resale";

// ─────────────────────────────────────────────────────────────────────────────
// tickets.release-expired-holds - Cron job to clean up stale holds
// ─────────────────────────────────────────────────────────────────────────────
export const releaseExpiredHolds = defineScheduledTask({
  name: "tickets.release-expired-holds",
  description:
    "Release seat holds that have exceeded their TTL, making seats available for purchase again.",
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
          orders: ctx.repos.orders,
          seats: ctx.repos.seats,
          promos: ctx.repos.promos,
          // Required: the use case returns any fee-waiver allowance the
          // abandoned cart was holding. Reservations are taken at checkout
          // (the fee is quoted into the PaymentIntent), so omitting this
          // would burn the allowance permanently on every expired cart.
          feeWaivers: ctx.repos.feeWaivers,
        },
        payments: ctx.payments,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );
    ctx.logger.info("tickets.release-expired-carts.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// tickets.expire-resale-listings - Hourly job to expire stale listings & held listings
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
    });
    ctx.logger.info("tickets.expire-resale-listings.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// tickets.expire-resale-claims - Daily job to expire open claims past deadline
// ─────────────────────────────────────────────────────────────────────────────
export const expireResaleClaimsJob = defineScheduledTask({
  name: "tickets.expire-resale-claims",
  description:
    "Transition all open resale claims past their deadline to expired status.",
  input: z.object({}),
  schedule: getSchedule("tickets.expire-resale-claims"),
  handler: async ({ ctx }) => {
    const result = await expireClaims({
      repos: ctx.repos,
      clock: ctx.clock,
      logger: ctx.logger,
    });
    ctx.logger.info("tickets.expire-resale-claims.completed", result);
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
  expireResaleClaimsJob,
];

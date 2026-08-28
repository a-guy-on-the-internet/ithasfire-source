/**
 * Booking-request Jobs
 *
 * Background work for the performer→venue booking-request lifecycle:
 * - Auto-expiring open requests past their TTL (default 14d, stamped at
 *   creation by create-booking-request).
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { expireBookingRequests } from "@th/core/use-cases/booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// booking-requests.auto-expire - Daily job to expire stale booking requests
// ─────────────────────────────────────────────────────────────────────────────
export const autoExpireBookingRequestsJob = defineScheduledTask({
  name: "booking-requests.auto-expire",
  description:
    "Transition open (PENDING/VIEWED) booking requests past their expiry to EXPIRED.",
  input: z.object({}),
  schedule: getSchedule("booking-requests.auto-expire"),
  handler: async ({ ctx }) => {
    const result = await expireBookingRequests({
      repos: ctx.repos,
      clock: ctx.clock,
      logger: ctx.logger,
      // Deliberate-swallow reporter for the per-request ledger append: a
      // failed entry must not abort the sweep, but it must not vanish either.
      reportError: ctx.reportError,
    });
    ctx.logger.info("booking-requests.auto-expire.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all booking-request jobs
// ─────────────────────────────────────────────────────────────────────────────
export const bookingRequestJobs = [autoExpireBookingRequestsJob];

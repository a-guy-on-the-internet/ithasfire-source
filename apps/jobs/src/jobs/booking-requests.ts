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
import {
  expireBookingRequests,
  notifyBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedArgs,
} from "@th/core/use-cases/booking-requests";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

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
    // notify() with the jobs container's ports (null-safe when a channel is
    // unconfigured) — the same composition the community / events jobs use.
    const notify = (payload: Parameters<typeof notifyUseCase>[1]) =>
      notifyUseCase(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          mailer: ctx.mailer ?? undefined,
          sms: ctx.sms ?? undefined,
          push: ctx.push ?? undefined,
          logger: ctx.logger,
          reportError: ctx.reportError,
        },
        payload,
      );
    const result = await expireBookingRequests({
      repos: ctx.repos,
      clock: ctx.clock,
      logger: ctx.logger,
      // Deliberate-swallow reporter for the per-request ledger append: a
      // failed entry must not abort the sweep, but it must not vanish either.
      reportError: ctx.reportError,
      // Lineup v3 (L7): acts that JOINED an expired request's bill hear it
      // isn't going ahead. Fired per request by the use case, swallowed +
      // reported there.
      notifyBookingLineupRequestClosed: (
        args: NotifyBookingLineupRequestClosedArgs,
      ) =>
        notifyBookingLineupRequestClosed(
          {
            repos: ctx.repos,
            notify,
            logger: ctx.logger,
            reportError: ctx.reportError,
            publicAppUrl: ctx.appBaseUrl,
          },
          args,
        ),
    });
    ctx.logger.info("booking-requests.auto-expire.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all booking-request jobs
// ─────────────────────────────────────────────────────────────────────────────
export const bookingRequestJobs = [autoExpireBookingRequestsJob];

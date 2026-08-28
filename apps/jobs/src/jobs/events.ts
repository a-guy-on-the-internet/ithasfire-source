/**
 * Event Jobs
 *
 * Scheduled tasks that operate on the event lifecycle.
 * - events.dispatch-change-notifications: drains the event-change notification
 *   outbox (cancel / reschedule / venue-change) and fans each notice out to its
 *   watchers (savers + RSVPers) and refunded buyers over in-app + email.
 * - events.address-reveal-notify: fans out the "location revealed" notification
 *   to active ticket holders of OBSCURED events whose addressRevealAt crossed.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  dispatchAddressRevealNotifications,
  dispatchAddressRevealNotificationsInputSchema,
  dispatchEventChangeNotifications,
  dispatchEventChangeNotificationsInputSchema,
  expireEventApplications,
  expireEventApplicationsInputSchema,
  purgeDispatchedChangeNotices,
} from "@th/core/use-cases/events";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// events.dispatch-change-notifications
// Drains the event-change notification outbox and fans out notifications with
// per-notice retry + dead-lettering.
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchEventChangeNotificationsJob = defineScheduledTask({
  name: "events.dispatch-change-notifications",
  description:
    "Drain the event-change notification outbox (cancel / reschedule / " +
    "venue-change) and fan each notice out to its watchers (savers + RSVPers) " +
    "and refunded buyers over in-app + email, retrying and dead-lettering " +
    "notices that exhaust their attempts.",
  input: dispatchEventChangeNotificationsInputSchema,
  schedule: getSchedule("events.dispatch-change-notifications"),
  handler: async ({ input, ctx }) => {
    // Best-effort fan-out notifier. Built here so the drain stays decoupled
    // from the comms wiring. `notify` persists the in-app notification and
    // dispatches email/SMS/push via the same ports other notification jobs
    // use (mailer/sms are null when unconfigured — notify degrades gracefully
    // per channel), so EMAIL actually fires here.
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
        },
        payload,
      );

    const result = await dispatchEventChangeNotifications(
      {
        repos: {
          eventChangeNotices: ctx.repos.eventChangeNotices,
          eventSaves: ctx.repos.eventSaves,
          eventRsvps: ctx.repos.eventRsvps,
        },
        notify,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info(
      "events.dispatch-change-notifications.completed",
      result,
    );
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// events.purge-dispatched-change-notices
// Retention purge: delete DISPATCHED change-notices older than the window so the
// buyer humanIds + refund cents persisted in CANCELLED payloads don't live at
// rest indefinitely. Undispatched/in-flight notices are never touched.
// ─────────────────────────────────────────────────────────────────────────────

export const purgeDispatchedChangeNoticesJob = defineScheduledTask({
  name: "events.purge-dispatched-change-notices",
  description:
    "Delete dispatched event-change notices past the retention window so the " +
    "buyer humanIds and refund amounts persisted in CANCELLED payloads don't " +
    "live at rest indefinitely. Never deletes undispatched/in-flight notices.",
  input: z.object({
    /** Override the default retention window for a one-off catch-up run. */
    retentionDays: z.coerce.number().int().min(1).optional(),
  }),
  schedule: getSchedule("events.purge-dispatched-change-notices"),
  handler: async ({ input, ctx }) => {
    // Forward retentionDays only when provided so the use-case schema applies
    // its own default (no duplicated default that could drift).
    const result = await purgeDispatchedChangeNotices(
      {
        repos: { eventChangeNotices: ctx.repos.eventChangeNotices },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      {
        ...(input.retentionDays !== undefined
          ? { retentionDays: input.retentionDays }
          : {}),
      },
    );

    ctx.logger.info(
      "events.purge-dispatched-change-notices.completed",
      result,
    );
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// events.address-reveal-notify
// Fans out the `event.location-revealed` notification (in-app forced on +
// email/push per preference — the Expo PushPort is wired server-side and
// delivers to holders with registered device tokens) to every active ticket
// holder of a PUBLISHED OBSCURED event whose addressRevealAt crossed inside
// the scan window.
// ─────────────────────────────────────────────────────────────────────────────

export const addressRevealNotifyJob = defineScheduledTask({
  name: "events.address-reveal-notify",
  description:
    "Notify active ticket holders of OBSCURED events whose addressRevealAt " +
    "just crossed that the exact address is now live (in-app forced on + " +
    "email/push per preference; push delivers to registered devices — " +
    "mobile-side token registration still pending). Duplicate-safe " +
    "via the at-most-once addressRevealNotifiedAt cursor, durable " +
    "notification-ledger subtraction, and per-recipient notify keys. An " +
    "explicit eventId run is the ops re-drive path for a partially-failed " +
    "fan-out (re-notifies only the gap).",
  // Reuse the use case's schema (strict, offset-tolerant datetimes,
  // start<end refinement) so the job contract can't drift from it.
  input: dispatchAddressRevealNotificationsInputSchema,
  schedule: getSchedule("events.address-reveal-notify"),
  handler: async ({ input, ctx }) => {
    // Same decoupled notifier the change-notification drain builds: notify
    // persists the in-app notification and dispatches email/SMS/push over
    // the bound ports (mailer/sms degrade gracefully per channel when null;
    // push degrades to `no_devices` until clients register tokens).
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
        },
        payload,
      );

    // Window defaults live in the use case: (now - 24h, now] with the end
    // clamped to now. The lookback is deliberately much wider than the 15-min
    // tick — cron drift/outages can't silently skip a reveal, and the
    // addressRevealNotifiedAt cursor makes the overlap free (a notified event
    // is never re-picked by the scheduled scan).
    const result = await dispatchAddressRevealNotifications(
      {
        repos: {
          events: ctx.repos.events,
          tickets: ctx.repos.tickets,
          // Durable per-recipient ledger (persisted in-app notifications) —
          // lets overlapping ticks / explicit re-drives subtract
          // already-notified holders.
          notifications: ctx.repos.notifications,
        },
        notify,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info("events.address-reveal-notify.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// events.expire-applications
// Nightly sweep (spec Phase 2, analogue of booking-requests.auto-expire):
// PENDING application submissions whose form closed more than the grace
// window ago flip to EXPIRED. One batch repo update + one batch audit row —
// no per-row emails; expiry is housekeeping, not a decision.
// ─────────────────────────────────────────────────────────────────────────────

export const expireEventApplicationsJob = defineScheduledTask({
  name: "events.expire-applications",
  description:
    "Transition PENDING event-application submissions whose application " +
    "form closed more than the grace window (default 7 days) ago to " +
    "EXPIRED. Batch update, batch audit row, no emails.",
  // Reuse the use case's schema (strict, defaulted graceDays) so the job
  // contract can't drift from it.
  input: expireEventApplicationsInputSchema,
  schedule: getSchedule("events.expire-applications"),
  handler: async ({ input, ctx }) => {
    const result = await expireEventApplications(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      input,
    );
    ctx.logger.info("events.expire-applications.completed", result);
    return result;
  },
});

export const eventJobs = [
  dispatchEventChangeNotificationsJob,
  purgeDispatchedChangeNoticesJob,
  addressRevealNotifyJob,
  expireEventApplicationsJob,
];

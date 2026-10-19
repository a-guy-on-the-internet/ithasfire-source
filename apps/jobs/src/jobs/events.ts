import { dispatchFollowNotifications, dispatchFollowNotificationsInputSchema, purgeFollowNotices } from "@th/core/use-cases/follows";
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

import { defineScheduledTask, type JobContext } from "../lib/define-job";
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
import { makeOpenCallNotices } from "@th/core/use-cases/events/open-calls/notify-open-call-notices";
import {
  sweepOpenCalls,
  sweepOpenCallsInputSchema,
} from "@th/core/use-cases/events/open-calls/sweep-open-calls";

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
          reportError: ctx.reportError,
        },
        payload,
      );

    const result = await dispatchEventChangeNotifications(
      {
        repos: {
          eventChangeNotices: ctx.repos.eventChangeNotices,
          eventSaves: ctx.repos.eventSaves,
          eventRsvps: ctx.repos.eventRsvps,
          // Read-only: the notice links the event's public (slug) page.
          events: ctx.repos.events,
          // Which recipients proved their email: the others get the notice by
          // email only (B2, account squatting through guest checkout).
          humans: ctx.repos.humans,
        },
        notify,
        clock: ctx.clock,
        logger: ctx.logger,
        appBaseUrl: ctx.appBaseUrl,
        reportError: ctx.reportError,
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
          reportError: ctx.reportError,
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
          // The true address of an event at a venue that withholds it lives
          // on the Place, not the Event row.
          places: ctx.repos.places,
          // Which holders proved their email: the others get the reveal by
          // email only (B2, account squatting through guest checkout).
          humans: ctx.repos.humans,
        },
        notify,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
        reportError: ctx.reportError,
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

// ─────────────────────────────────────────────────────────────────────────────
// events.sweep-open-calls
// Open calls v1 step 8 (core `sweep-open-calls.ts`): the FR-021 backstop, the
// FR-022 pulled-call expiry, and the reconcile of every not-this-time /
// pulled / received notice that never went out. The close procedure sends at
// most 25 notices in-request and leaves the rest to this job.
// ─────────────────────────────────────────────────────────────────────────────

function refuseSweep(
  ctx: JobContext,
  reason: string,
  message: string,
): never {
  // THROW, never return `{ success: false }`: app.ts answers 200 for any
  // returned value, so only a throw makes the run fail and show. No row was
  // touched, so the next run is safe.
  const err = new Error(`events.sweep-open-calls: ${message}`);
  ctx.logger.error("events.sweep_open_calls_unavailable", { reason });
  try {
    ctx.reportError(err, { tags: { job: "events.sweep-open-calls", reason } });
  } catch {
    // Best-effort: a throwing reporter must not change the outcome.
  }
  throw err;
}

export const sweepOpenCallsJob = defineScheduledTask({
  name: "events.sweep-open-calls",
  description:
    "Open calls: set PENDING applications whose last chosen date has started " +
    "to not-this-time (FR-021), expire those whose event or nights were " +
    "called off with a call-pulled notice (FR-022), and re-send any " +
    "not-this-time, pulled or received notice that never went out (last 14 " +
    "days). Idempotent; returns counts.",
  input: sweepOpenCallsInputSchema,
  schedule: getSchedule("events.sweep-open-calls"),
  handler: async ({ input, ctx }) => {
    // The notice ledger is the API's (namespace "api"); `ctx.idempotency`
    // is namespaced "jobs" and would read every notice as unsent.
    const ledger = ctx.lineupNoticeLedger;
    if (!ledger) {
      refuseSweep(ctx, "no_ledger", "the API notice ledger is not wired; nothing swept");
    }
    // Without a mailer a signed-in notice still settles (in-app only, its
    // email leg skipped) and its ledger key is kept for 10 years: those
    // people would never get the email. Refuse instead, as the lineup sweep.
    const mailer = ctx.mailer;
    if (!mailer) {
      refuseSweep(ctx, "no_mailer", "mailer not configured; nothing swept");
    }

    const notify = (payload: Parameters<typeof notifyUseCase>[1]) =>
      notifyUseCase(
        {
          repos: ctx.repos,
          clock: ctx.clock,
          idempotency: ctx.idempotency,
          mailer,
          sms: ctx.sms ?? undefined,
          push: ctx.push ?? undefined,
          logger: ctx.logger,
          reportError: ctx.reportError,
        },
        payload,
      );
    const notices = makeOpenCallNotices({
      repos: ctx.repos,
      notify,
      mailer,
      idempotency: ledger,
      publicAppUrl: ctx.appBaseUrl,
      statusTokenSecret: ctx.openCallStatusTokenSecret,
      logger: ctx.logger,
      reportError: ctx.reportError,
    });

    const result = await sweepOpenCalls(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        idempotency: ledger,
        notices,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );
    ctx.logger.info("events.sweep-open-calls.completed", result);
    return result;
  },
});

export const dispatchFollowNotificationsJob = defineScheduledTask({
  name: "events.dispatch-follow-notifications",
  description: "Deliver new event alerts to entity followers using the durable per-channel outbox.",
  input: dispatchFollowNotificationsInputSchema,
  schedule: getSchedule("events.dispatch-follow-notifications"),
  handler: async ({input, ctx}) => dispatchFollowNotifications({
    repos: ctx.repos, clock: ctx.clock, appBaseUrl: ctx.appBaseUrl, reportError: ctx.reportError,
    notify: input => notifyUseCase({repos: ctx.repos, clock: ctx.clock, idempotency: ctx.idempotency,
      mailer: ctx.mailer ?? undefined, push: ctx.push ?? undefined, logger: ctx.logger,
      reportError: ctx.reportError}, input),
  }, input),
});

export const purgeFollowNoticesJob = defineScheduledTask({
  name: "events.purge-follow-notices",
  description: "Delete follow-notification notices and deliveries for events that started more than the retention window ago (default 30 days).",
  input: z.object({
    /** Override the default retention window for a one-off catch-up run. */
    retentionDays: z.coerce.number().int().min(1).optional(),
  }),
  schedule: getSchedule("events.purge-follow-notices"),
  handler: async ({ input, ctx }) => {
    const result = await purgeFollowNotices(
      { repos: { entityEventNotices: ctx.repos.entityEventNotices }, clock: ctx.clock, logger: ctx.logger },
      input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {},
    );
    ctx.logger.info("events.purge-follow-notices.completed", result);
    return result;
  },
});

export const eventJobs = [
  dispatchFollowNotificationsJob,
  purgeFollowNoticesJob,
  dispatchEventChangeNotificationsJob,
  purgeDispatchedChangeNoticesJob,
  addressRevealNotifyJob,
  expireEventApplicationsJob,
  sweepOpenCallsJob,
];

/**
 * Community Jobs
 *
 * Scheduled tasks for community (ownerless, RSVP-attendance) listings.
 * - community.dispatch-rsvp-confirmations: drains the RSVP-confirmation
 *   outbox (RsvpNotice) and sends each new RSVPer an in-app + email
 *   confirmation with event details and cancel/manage links.
 * - community.rsvp-reminders-24h: sweeps RSVPs whose date is ~24h out and
 *   sends one reminder each, claimed PER CHANNEL against the RsvpReminder
 *   ledger so an overlapping tick can never double-send and a failed email
 *   retries without re-firing the in-app row that already landed. Gated on the
 *   user-controllable `reminders` notification category (GLOBAL and per-EVENT).
 * - community.purge-dispatched-rsvp-notices: retention purge for dispatched
 *   notices (mirrors events.purge-dispatched-change-notices).
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  dispatchRsvpNotifications,
  dispatchRsvpNotificationsInputSchema,
  purgeDispatchedRsvpNotices,
  sendRsvpReminders,
  sendRsvpRemindersInputSchema,
} from "@th/core/use-cases/community";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// community.dispatch-rsvp-confirmations
// Drains the RSVP-confirmation outbox with per-notice retry + dead-lettering.
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchRsvpConfirmationsJob = defineScheduledTask({
  name: "community.dispatch-rsvp-confirmations",
  description:
    "Drain the RSVP-confirmation outbox and send each newly-RSVP'd attendee " +
    "an in-app + email confirmation with event details and links to the " +
    "event page and /my-rsvps, retrying and dead-lettering notices that " +
    "exhaust their attempts.",
  input: dispatchRsvpNotificationsInputSchema,
  schedule: getSchedule("community.dispatch-rsvp-confirmations"),
  handler: async ({ input, ctx }) => {
    // Best-effort notifier, mirroring events.dispatch-change-notifications:
    // `notify` persists the in-app notification and dispatches email via the
    // mailer port bound in the jobs container (null-safe when unconfigured),
    // which is exactly why confirmations go through this outbox rather than
    // inline in the tRPC path (web/api ctx has no mailer).
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

    const result = await dispatchRsvpNotifications(
      {
        repos: {
          rsvpNotices: ctx.repos.rsvpNotices,
          eventRsvps: ctx.repos.eventRsvps,
          events: ctx.repos.events,
          // Per-date notices (recurring listings) resolve the occurrence and
          // its per-date RSVP row at dispatch time.
          eventDates: ctx.repos.eventDates,
          eventDateRsvps: ctx.repos.eventDateRsvps,
          // The confirmation's address is gated like a ticket holder's; the
          // venue row holds the truth and floors the event's privacy.
          places: ctx.repos.places,
        },
        notify,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );

    ctx.logger.info("community.dispatch-rsvp-confirmations.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// community.rsvp-reminders-24h
// Derived due set (no outbox) + a durable claim ledger for idempotency.
// ─────────────────────────────────────────────────────────────────────────────

export const rsvpReminders24hJob = defineScheduledTask({
  name: "community.rsvp-reminders-24h",
  // MUST stay byte-identical to jobs.manifest.json's description for this
  // job: the generated registry carries this string and Terraform carries the
  // manifest one, and nothing compares them.
  description:
    "Remind community RSVPers ~24h before the date they said they are going " +
    "to - per DATE on recurring listings, per EVENT on single-date ones. " +
    "Window is startsAt-24h to startsAt-22h, so the */30 tick lands within " +
    "30 min of the mark and the 2h tail survives an outage. Idempotent via " +
    "the RsvpReminder ledger's per-channel claim; a failed channel releases " +
    "its claim and retries next tick. User-controllable: the 'reminders' " +
    "notification category, GLOBAL and per-EVENT.",
  input: sendRsvpRemindersInputSchema,
  schedule: getSchedule("community.rsvp-reminders-24h"),
  handler: async ({ input, ctx }) => {
    // Same best-effort notifier as the confirmation drain: `notify` persists
    // the in-app row and dispatches email/push through the ports bound in the
    // jobs container (null-safe when unconfigured). This is exactly why
    // reminders live in the jobs service — the web/api ctx has no mailer.
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

    // What this PROCESS can actually deliver on. The use case intersects this
    // with the recipient's enabled channels BEFORE claiming a ledger row, so a
    // deploy with RESEND_API_KEY unset (or shadowed to empty) drops the email
    // channel instead of claiming it, getting `skipped: port_unavailable`
    // back, and settling every email reminder in the window forever. The
    // container announces a missing mailer with `logger.warn`, which Sentry
    // does not capture — so the ONLY thing standing between that env var and a
    // silent total loss is this set.
    //   • in_app — a notification row via `repos`; always available.
    //   • push   — ExpoPushAdapter is constructed unconditionally (Expo's
    //     public push API needs no credential); it degrades per-recipient to
    //     `no_devices`, which is a genuine decline.
    const availableChannels = new Set<"in_app" | "push" | "email" | "sms">([
      "in_app",
      "push",
    ]);
    if (ctx.mailer) availableChannels.add("email");
    if (ctx.sms) availableChannels.add("sms");

    const result = await sendRsvpReminders(
      {
        repos: {
          rsvpReminders: ctx.repos.rsvpReminders,
          events: ctx.repos.events,
          // Send-time re-checks: a moderator calling off ONE night flips
          // EventDate.status (never Event.status), and an RSVP withdrawn
          // mid-batch is a deleted row — both land inside the read-to-send gap.
          eventDates: ctx.repos.eventDates,
          eventDateRsvps: ctx.repos.eventDateRsvps,
          eventRsvps: ctx.repos.eventRsvps,
          notificationPrefs: ctx.repos.notificationPrefs,
          // Address gate (same as a ticket holder's): venue privacy + truth.
          places: ctx.repos.places,
        },
        notify,
        availableChannels,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );

    ctx.logger.info("community.rsvp-reminders-24h.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// community.purge-dispatched-rsvp-notices
// Retention purge: delete DISPATCHED RSVP notices older than the window.
// Undispatched/in-flight notices are never touched.
// ─────────────────────────────────────────────────────────────────────────────

export const purgeDispatchedRsvpNoticesJob = defineScheduledTask({
  name: "community.purge-dispatched-rsvp-notices",
  description:
    "Delete dispatched RSVP-confirmation notices past the retention window " +
    "so (eventId, humanId) linkage rows don't accumulate at rest " +
    "indefinitely. Never deletes undispatched/in-flight notices.",
  input: z.object({
    /** Override the default retention window for a one-off catch-up run. */
    retentionDays: z.coerce.number().int().min(1).optional(),
  }),
  schedule: getSchedule("community.purge-dispatched-rsvp-notices"),
  handler: async ({ input, ctx }) => {
    // Forward retentionDays only when provided so the use-case schema applies
    // its own default (no duplicated default that could drift).
    const result = await purgeDispatchedRsvpNotices(
      {
        repos: { rsvpNotices: ctx.repos.rsvpNotices },
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
      "community.purge-dispatched-rsvp-notices.completed",
      result,
    );
    return result;
  },
});

export const communityJobs = [
  dispatchRsvpConfirmationsJob,
  rsvpReminders24hJob,
  purgeDispatchedRsvpNoticesJob,
];

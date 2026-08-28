/**
 * Community Jobs
 *
 * Scheduled tasks for community (ownerless, RSVP-attendance) listings.
 * - community.dispatch-rsvp-confirmations: drains the RSVP-confirmation
 *   outbox (RsvpNotice) and sends each new RSVPer an in-app + email
 *   confirmation with event details and cancel/manage links.
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
        },
        notify,
        clock: ctx.clock,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
      },
      input,
    );

    ctx.logger.info("community.dispatch-rsvp-confirmations.completed", result);
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
  purgeDispatchedRsvpNoticesJob,
];

/**
 * Announcement Jobs
 *
 * Background work related to announcement lifecycle:
 * - Dispatching in-app / push notifications for large audiences
 */
import { defineJob } from "../lib/define-job";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";
import { announcementNotifyJobInputSchema } from "@th/core/use-cases/announcements";

// ─────────────────────────────────────────────────────────────────────────────
// announcements.dispatch-notifications
//
// Receives a batch of humanIds + announcement metadata and sends in-app/push
// notifications one at a time. Failures for individual recipients are logged
// but do not fail the job.
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchNotifications = defineJob({
  name: "announcements.dispatch-notifications",
  description:
    "Dispatches in-app / push notifications for an announcement to a batch of human recipients.",
  input: announcementNotifyJobInputSchema,
  handler: async ({ input, ctx }) => {
    const { announcementId, orgId, subject, eventId, humanIds } = input;

    ctx.logger.info("announcements.dispatch-notifications.start", {
      announcementId,
      humanCount: humanIds.length,
    });

    let notifiedCount = 0;
    let failedCount = 0;

    for (const humanId of humanIds) {
      try {
        await notifyUseCase(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            idempotency: ctx.idempotency,
            push: ctx.push ?? undefined,
            logger: ctx.logger,
          },
          {
            humanId,
            variant: "notification.generic",
            payload: {
              category: "organizerMessages",
              body: subject,
              kind: "INFO",
              action: eventId
                ? { label: "View event", route: `/events/${eventId}` }
                : undefined,
              metadata: {
                announcementId,
                orgId,
              },
              tags: ["announcement"],
            },
            scope: { kind: "ORG", orgId },
          },
        );
        notifiedCount++;
      } catch (notifyError) {
        failedCount++;
        ctx.logger.warn(
          "announcements.dispatch-notifications.recipient_failed",
          {
            announcementId,
            humanId,
            error:
              notifyError instanceof Error
                ? notifyError.message
                : String(notifyError),
          },
        );
      }
    }

    ctx.logger.info("announcements.dispatch-notifications.completed", {
      announcementId,
      humanCount: humanIds.length,
      notifiedCount,
      failedCount,
    });

    return { notifiedCount, failedCount };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all announcement jobs
// ─────────────────────────────────────────────────────────────────────────────
export const announcementJobs = [dispatchNotifications];

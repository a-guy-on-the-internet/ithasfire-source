/**
 * Post-Event Prompt Jobs
 *
 * The SHARED post-event solicitation pipeline (booking-review-data-weave WS3
 * + attendee-reviews FR-006): one PostEventPrompt outbox, audience-
 * discriminated — never two pipelines.
 * - post-event-prompts.enqueue: daily sweep that inserts PENDING prompts for
 *   completed platform gigs (PERFORMER) and ended scanned-ticket events
 *   (ATTENDEE). The performer sweep runs FIRST so the attendee sweep's
 *   audience-precedence check (performers never get the attendee ask) sees
 *   its rows.
 * - post-event-prompts.dispatch: drains PENDING prompts through the notify
 *   pipeline (in-app + email). ATTENDEE is dispatch-gated behind
 *   DISPATCH_ENABLED_AUDIENCES until the attendee review form ships.
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  dispatchPostEventPrompts,
  dispatchPostEventPromptsInputSchema,
  enqueueAttendeePostEventPrompts,
  enqueuePerformerPostEventPrompts,
} from "@th/core/use-cases/post-event-prompts";
import { notify as notifyUseCase } from "@th/core/use-cases/comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// post-event-prompts.enqueue
// Daily idempotent sweep (unique index dedupes re-runs). Performer first —
// audience precedence depends on it.
// ─────────────────────────────────────────────────────────────────────────────

export const enqueuePostEventPromptsJob = defineScheduledTask({
  name: "post-event-prompts.enqueue",
  description:
    "Daily sweep that enqueues post-event prompts: one PERFORMER prompt per " +
    "performer human on a completed platform-booked gig, then one ATTENDEE " +
    "prompt per scanned ticket holder of an ended event (performer-prompted " +
    "humans excluded). Idempotent via the (eventId, humanId, audience) " +
    "unique index.",
  input: z.object({
    /** Override the sweep window for a one-off catch-up run. */
    lookbackDays: z.coerce.number().int().min(1).max(90).optional(),
  }),
  schedule: getSchedule("post-event-prompts.enqueue"),
  handler: async ({ input, ctx }) => {
    // Forward lookbackDays only when provided so the use-case schemas apply
    // their own default (no duplicated default that could drift).
    const sweepInput =
      input.lookbackDays !== undefined
        ? { lookbackDays: input.lookbackDays }
        : {};

    // PERFORMER FIRST (audience precedence): the attendee sweep excludes
    // humans that already hold a PERFORMER prompt for the event.
    const performer = await enqueuePerformerPostEventPrompts(
      {
        repos: { postEventPrompts: ctx.repos.postEventPrompts },
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      sweepInput,
    );

    const attendee = await enqueueAttendeePostEventPrompts(
      {
        repos: { postEventPrompts: ctx.repos.postEventPrompts },
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      sweepInput,
    );

    const result = { performer, attendee };
    ctx.logger.info("post-event-prompts.enqueue.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// post-event-prompts.dispatch
// Drains the outbox with per-prompt retry + dead-lettering. Scheduled after
// the enqueue sweep so prompts land the same day they become eligible.
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchPostEventPromptsJob = defineScheduledTask({
  name: "post-event-prompts.dispatch",
  description:
    "Drain the post-event prompt outbox and send each performer a one-time " +
    "in-app + email post-gig review prompt deep-linking to /review-a-place, " +
    "retrying and dead-lettering prompts that exhaust their attempts. " +
    "ATTENDEE prompts stay pending (dispatch-gated) until the attendee " +
    "review form ships.",
  input: dispatchPostEventPromptsInputSchema,
  schedule: getSchedule("post-event-prompts.dispatch"),
  handler: async ({ input, ctx }) => {
    // Best-effort notifier, mirroring community.dispatch-rsvp-confirmations:
    // `notify` persists the in-app notification and dispatches email via the
    // mailer port bound in the jobs container (null-safe when unconfigured).
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

    const result = await dispatchPostEventPrompts(
      {
        repos: {
          postEventPrompts: ctx.repos.postEventPrompts,
          events: ctx.repos.events,
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

    ctx.logger.info("post-event-prompts.dispatch.completed", result);
    return result;
  },
});

export const postEventPromptJobs = [
  enqueuePostEventPromptsJob,
  dispatchPostEventPromptsJob,
];

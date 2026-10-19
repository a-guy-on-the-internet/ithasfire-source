import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  ApplicationSubmissionStatus,
  EventApplicationSubmissionRecord,
  EventGateType,
  EventRecord,
  EventVisibility,
} from "@th/ports/repos/events";

import { describeError, parseInput } from "../../lib/io";
import {
  APPLICATION_BACK_IN_REVIEW_VARIANT,
  applicationBackInReviewEmail,
} from "../comms/application-renderers";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  resolveApplicantEmailContext,
  sendApplicantGuestEmail,
} from "./_shared/applicant-emails";
import { applyRescindDecision } from "./_shared/apply-rescind-decision";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { isStatusConflict } from "./_shared/status-conflict";
import { eventApplicationSubmissionRecordSchema } from "./_shared/event-application-submission-schema";
import { fail } from "@th/errors";

export const rescindEventApplicationDecisionInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

export const rescindEventApplicationDecisionOutputSchema = z.object({
  eventId: z.string().uuid(),
  submission: eventApplicationSubmissionRecordSchema,
});

export type RescindEventApplicationDecisionInput = z.infer<
  typeof rescindEventApplicationDecisionInputSchema
>;
export type RescindEventApplicationDecisionOutput = z.infer<
  typeof rescindEventApplicationDecisionOutputSchema
>;

export type RescindEventApplicationDecisionDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Back-in-review notice when an APPROVED decision is rescinded
   * (owner decision 2026-09-30). Optional: without it the rescind still
   * lands, the applicant just isn't told.
   */
  notify?: (input: NotifyInput) => Promise<NotifyOutput>;
  /** Direct mailer for the GUEST applicant (no humanId to key notify on). */
  mailer?: MailerPort;
  /** Web app base URL, used to build the event page link. */
  appBaseUrl?: string;
  /** Sentry reporter for the best-effort notification swallow branches. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/**
 * Server-side guards for an INTERNAL caller (the invite revoke). Never part
 * of the input schema, so no client can set them. A guard that doesn't hold
 * fails INVALID_STATUS before anything is written: the row moved on.
 */
export type RescindEventApplicationDecisionGuard = {
  /** Only rescind while the submission still carries this invite stamp. */
  expectedInviteId?: string;
  /** Only rescind from these statuses; forwarded as the write's status CAS. */
  expectedFromStatuses?: ApplicationSubmissionStatus[];
};

export async function rescindEventApplicationDecision(
  deps: RescindEventApplicationDecisionDeps,
  rawInput: unknown,
  guard: RescindEventApplicationDecisionGuard = {},
): Promise<RescindEventApplicationDecisionOutput> {
  const input = parseInput(
    rescindEventApplicationDecisionInputSchema,
    rawInput,
  );

  const { event, submission, previousStatus, rescindedAt } = await deps.repos.tx(
    async (tx) => {
      const editableEvent = await ensureActorCanEditEvent(
        tx,
        input.eventId,
        input.actorHumanId,
      );

      if (editableEvent.gateType !== "APPLICATION") {
        throw fail("EVENT_NOT_APPLICATION_GATED");
      }

      const existingSubmission = await tx.eventApplications.getSubmissionById(
        input.submissionId,
      );
      // Open calls v1: attendee path only; a PERFORM submission is not found.
      if (!existingSubmission || existingSubmission.purpose !== "ATTEND") {
        throw fail("SUBMISSION_NOT_FOUND");
      }

      if (existingSubmission.eventId !== editableEvent.id) {
        throw fail("SUBMISSION_EVENT_MISMATCH");
      }

      if (
        (guard.expectedInviteId !== undefined &&
          existingSubmission.inviteId !== guard.expectedInviteId) ||
        (guard.expectedFromStatuses !== undefined &&
          !guard.expectedFromStatuses.includes(existingSubmission.status))
      ) {
        throw fail("INVALID_STATUS");
      }

      if (existingSubmission.status === "PENDING") {
        throw fail("SUBMISSION_NOT_REVIEWED");
      }

      // Rescind unwinds ORGANIZER decisions only (APPROVED / REJECTED /
      // WAITLISTED). WITHDRAWN is applicant-owned — resurrecting it to
      // PENDING would put a submission back in the queue against the
      // applicant's expressed intent. EXPIRED is the sweep's terminal
      // housekeeping state, not a decision — there is nothing to rescind
      // (the late-approval escape hatch is reviewing the EXPIRED submission
      // directly, which review deliberately allows).
      if (
        existingSubmission.status === "WITHDRAWN" ||
        existingSubmission.status === "EXPIRED"
      ) {
        throw fail("INVALID_STATUS");
      }

      const rescindedAt = deps.clock.now();

      // The durable writes (PENDING + approval fields cleared, unlocks
      // revoked by submission, WAITLISTED linkage unwound, audit row) live
      // in `_shared/apply-rescind-decision.ts`, shared with the invite-revoke
      // path. See there for why each step is shaped as it is.
      let updatedSubmission: EventApplicationSubmissionRecord;
      try {
        ({ submission: updatedSubmission } = await applyRescindDecision(tx, {
          eventId: editableEvent.id,
          submission: existingSubmission,
          actorHumanId: input.actorHumanId,
          at: rescindedAt,
          ...(guard.expectedFromStatuses
            ? { expectedFromStatuses: guard.expectedFromStatuses }
            : {}),
          // The read above is unlocked; the write re-checks the stamp.
          ...(guard.expectedInviteId !== undefined
            ? { expectedInviteId: guard.expectedInviteId }
            : {}),
        }));
      } catch (error) {
        // Lost the guarded write (status or invite stamp): a decision or a
        // re-approval committed after our read.
        if (isStatusConflict(error)) throw fail("INVALID_STATUS");
        throw error;
      }

      return {
        event: editableEvent,
        submission: updatedSubmission,
        previousStatus: existingSubmission.status,
        rescindedAt,
      } as const;
    },
  );

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    action: "application_decision_rescinded",
    result: "success",
    actorHumanId: input.actorHumanId,
    metadata: {
      submissionId: submission.id,
      fromStatus: previousStatus,
    },
  });

  // Only a withdrawn APPROVAL is news to the applicant: they were told
  // they're in. Rescinding REJECTED / WAITLISTED sends nothing (owner
  // deferred that).
  if (previousStatus === "APPROVED") {
    await notifyApplicationBackInReview(deps, {
      event,
      submission,
      rescindedAt,
    });
  }

  return rescindEventApplicationDecisionOutputSchema.parse({
    eventId: event.id,
    submission,
  });
}

/**
 * Back-in-review notice, post-commit and best-effort (the PENDING row is
 * authoritative). Same channel split as the decision emails:
 *  - signed-in applicant → notify() variant `event.application-back-in-review`;
 *  - guest applicant → the same ui-email template via the mailer.
 * Idempotency key `application-back-in-review:${submissionId}:${rescindedAt ms}`
 * — an approval can be granted and rescinded more than once, and each
 * rescind is its own notice. The copy never says the guest lost access. That
 * wording predates the application grant: guest access DOES now end on
 * rescind (the grant is re-checked against the submission's status), so the
 * copy is merely conservative, not wrong.
 * Both legs are deliberate swallows — logged AND reported.
 */
async function notifyApplicationBackInReview(
  deps: RescindEventApplicationDecisionDeps,
  context: {
    event: EventRecord;
    submission: Pick<
      EventApplicationSubmissionRecord,
      "id" | "humanId" | "contactEmail"
    >;
    rescindedAt: Date;
  },
): Promise<void> {
  const { event, submission } = context;
  const guestEmail = submission.humanId ? null : submission.contactEmail;
  if (submission.humanId ? !deps.notify : !(guestEmail && deps.mailer)) {
    return;
  }

  const idempotencyKey = `application-back-in-review:${submission.id}:${context.rescindedAt.getTime()}`;
  const emailContext = await resolveApplicantEmailContext(
    { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
    {
      event,
      appBaseUrl: deps.appBaseUrl,
      useCase: "rescindEventApplicationDecision",
    },
  );

  // ── Signed-in applicant ──────────────────────────────────────────────
  if (submission.humanId && deps.notify) {
    try {
      await deps.notify({
        humanId: submission.humanId,
        variant: APPLICATION_BACK_IN_REVIEW_VARIANT,
        payload: {
          eventId: event.id,
          eventTitle: event.title,
          submissionId: submission.id,
          ...(emailContext.eventUrl ? { eventUrl: emailContext.eventUrl } : {}),
          ...(emailContext.organizerContactEmail
            ? { organizerContactEmail: emailContext.organizerContactEmail }
            : {}),
        },
        scope: { kind: "EVENT", eventId: event.id },
        idempotencyKey,
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      deps.logger?.error(
        "events.rescindEventApplicationDecision.backInReviewNotify_failed",
        {
          submissionId: submission.id,
          humanId: submission.humanId,
          err: error,
          error: describeError(error),
        },
      );
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "rescindEventApplicationDecision",
            channel: "backInReviewNotify",
          },
          extra: { submissionId: submission.id, eventId: event.id },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn
        // the swallow into a thrown error.
      }
    }
    return;
  }

  // ── Guest applicant ──────────────────────────────────────────────────
  if (!guestEmail) return;
  await sendApplicantGuestEmail(
    { mailer: deps.mailer, logger: deps.logger, reportError: deps.reportError },
    {
      to: guestEmail,
      content: applicationBackInReviewEmail({
        eventTitle: event.title,
        eventUrl: emailContext.eventUrl,
        // The event page can't show an anonymous viewer their status, so
        // the template drops its "check status" link.
        isGuest: true,
        organizerContactEmail: emailContext.organizerContactEmail,
      }),
      replyTo: emailContext.organizerContactEmail,
      // Mirrors the `{key}:email` suffix notify() derives for its channel.
      idempotencyKey: `${idempotencyKey}:email`,
      logMessage:
        "events.rescindEventApplicationDecision.backInReviewAnonEmail_failed",
      useCase: "rescindEventApplicationDecision",
      channel: "backInReviewAnonEmail",
      extra: { submissionId: submission.id, eventId: event.id },
    },
  );
}

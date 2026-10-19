import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EventGateType,
  EventRecord,
  EventVisibility,
} from "@th/ports/repos/events";

import { describeError, parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  APPLICATION_REJECTED_VARIANT,
  APPLICATION_WAITLISTED_VARIANT,
  applicationRejectedEmail,
  applicationWaitlistedEmail,
} from "../comms/application-renderers";
import {
  resolveApplicantEmailContext,
  sendApplicantGuestEmail,
} from "./_shared/applicant-emails";
import { linkWaitlistEntryForSubmission } from "./_shared/application-waitlist-link";
import {
  applyApprovalDecision,
  DEFAULT_TOKEN_TTL_MINUTES,
  generateApprovalToken,
  sendApprovalNotification,
  type NotifyFn,
} from "./_shared/approve-submission";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { eventApplicationSubmissionRecordSchema } from "./_shared/event-application-submission-schema";
import {
  isDuplicateOpenApplication,
  isStatusConflict,
} from "./_shared/status-conflict";
import { fail } from "@th/errors";
import { ensureDelegateNotSelfRecipient } from "../../lib/event-edit-rights";

const decisions = ["APPROVED", "REJECTED", "WAITLISTED"] as const;

const DECISION_REASON_MAX_LENGTH = 500;

const MIN_TOKEN_TTL_MINUTES = 5;
const MAX_TOKEN_TTL_MINUTES = 60 * 24 * 7; // 7 days

const approvalControlsSchema = z.object({
  approvalTokenTtlMinutes: z
    .number()
    .int()
    .min(MIN_TOKEN_TTL_MINUTES)
    .max(MAX_TOKEN_TTL_MINUTES)
    .optional(),
  approvalTokenExpiresAt: z.date().optional(),
});

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const reviewEventApplicationSubmissionInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    submissionId: z.string().uuid(),
    decision: z.enum(decisions),
    /**
     * Optional attendee-facing reason for a REJECTED decision (not required —
     * unlike booking decline — because the tone differs; spec Phase 1 item
     * 3). Sanitized BEFORE the length check (plainText convention); included
     * in the rejection email when present. Not accepted for APPROVED or
     * WAITLISTED (the waitlist email is deliberately neutral).
     */
    decisionReason: plainTextMultilineOptional(
      DECISION_REASON_MAX_LENGTH,
    ).optional(),
  })
  .merge(approvalControlsSchema);

export const reviewEventApplicationSubmissionInputSchema =
  reviewEventApplicationSubmissionInputSchemaBase.superRefine((value, ctx) => {
    if (value.decision !== "APPROVED") {
      if (value.approvalTokenTtlMinutes !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvalTokenTtlMinutes"],
          message: "ttl_only_allowed_for_approval",
        });
      }
      if (value.approvalTokenExpiresAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvalTokenExpiresAt"],
          message: "expiration_only_allowed_for_approval",
        });
      }
    }

    if (value.decision !== "REJECTED" && value.decisionReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionReason"],
        message: "reason_only_allowed_for_rejection",
      });
    }

    if (
      value.approvalTokenTtlMinutes !== undefined &&
      value.approvalTokenExpiresAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvalTokenExpiresAt"],
        message: "ttl_and_expiration_conflict",
      });
    }
  });

export const reviewEventApplicationSubmissionOutputSchema = z.object({
  eventId: z.string().uuid(),
  submission: eventApplicationSubmissionRecordSchema,
});

export type ReviewEventApplicationSubmissionInput = z.infer<
  typeof reviewEventApplicationSubmissionInputSchema
>;
export type ReviewEventApplicationSubmissionOutput = z.infer<
  typeof reviewEventApplicationSubmissionOutputSchema
>;

export type ReviewEventApplicationSubmissionDeps = {
  repos: Repos;
  clock: ClockPort;
  notify: NotifyFn;
  /**
   * Direct mailer for the ANONYMOUS applicant path (no humanId to key
   * `notify` on). Best-effort — the status/token row is authoritative.
   */
  mailer?: MailerPort;
  /** Web app base URL, used to build the applicant's claim link. */
  appBaseUrl?: string;
  /** Sentry reporter for the best-effort email swallow branches. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

export async function reviewEventApplicationSubmission(
  deps: ReviewEventApplicationSubmissionDeps,
  rawInput: unknown,
): Promise<ReviewEventApplicationSubmissionOutput> {
  const input = parseInput(
    reviewEventApplicationSubmissionInputSchema,
    rawInput,
  );

  const { event, submission, reviewedAt } = await deps.repos.tx(async (tx) => {
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
    // Open calls v1: this is the ATTENDEE review path. A PERFORM (open-call)
    // submission answers like a missing one, whatever id the caller holds.
    if (!existingSubmission || existingSubmission.purpose !== "ATTEND") {
      throw fail("SUBMISSION_NOT_FOUND");
    }

    if (existingSubmission.eventId !== editableEvent.id) {
      throw fail("SUBMISSION_EVENT_MISMATCH");
    }

    // ── Reviewable from-statuses: PENDING | EXPIRED, nothing else ────────
    // WITHDRAWN is applicant-owned: the applicant pulled the submission
    // back, and a decision against it would mint access + send emails
    // against their expressed intent. EXPIRED is DELIBERATELY reviewable —
    // that is the late-approval escape hatch for a queue the organizer got
    // to after the sweep ran (approving an EXPIRED submission works exactly
    // like approving a PENDING one).
    //
    // ALREADY-DECIDED rows (APPROVED / REJECTED / WAITLISTED) are refused:
    // changing a decision is RESCIND-THEN-DECIDE. Deciding straight over a
    // decision performs no unwind — an APPROVED→REJECTED would clear the
    // token while leaving the durable EventUnlock intact (rejected applicant
    // keeps access), and a WAITLISTED→REJECTED would strand the waitlist
    // entry's linkback. `rescindEventApplicationDecision` is the operation
    // that owns those unwinds; it returns the row to PENDING, after which
    // any decision is valid again.
    if (
      existingSubmission.status !== "PENDING" &&
      existingSubmission.status !== "EXPIRED"
    ) {
      throw fail("INVALID_STATUS");
    }

    // A DELEGATE may not approve THEIR OWN application to the principal's
    // gated event (owner ruling 2026-09-28) — matched by humanId and by the
    // submission's contact email. Rejecting / waitlisting it is not a
    // benefit and stays allowed; owners and org members are unaffected.
    if (input.decision === "APPROVED") {
      await ensureDelegateNotSelfRecipient(tx.humans, {
        eventOwner: {
          orgId: editableEvent.orgId,
          humanId: editableEvent.humanId,
        },
        actorHumanId: input.actorHumanId,
        recipientHumanId: existingSubmission.humanId,
        recipientEmail: existingSubmission.contactEmail,
      });
    }

    const reviewedAt = deps.clock.now();
    let updatedSubmission;
    let waitlistEntryId: string | null = null;

    // Compare-and-swap guard on EVERY decision write. The status read above
    // happens earlier in this transaction, but under READ COMMITTED a
    // withdraw (or another reviewer) can commit in between — an unguarded
    // write would then apply anyway and produce exactly what the from-status
    // guard exists to prevent (WITHDRAWN → APPROVED with a live token, an
    // EventUnlock and an approval email). A lost CAS throws before any
    // unlock/waitlist side effect runs and surfaces as INVALID_STATUS.
    const expectedFromStatuses = ["PENDING", "EXPIRED"] as const;

    try {
      if (input.decision === "APPROVED") {
        // Shared approval path (also used by submit's auto-approve): status
        // flip + token mint + EventUnlock upsert.
        updatedSubmission = await applyApprovalDecision(tx, {
          submissionId: existingSubmission.id,
          eventId: editableEvent.id,
          applicantHumanId: existingSubmission.humanId,
          reviewerHumanId: input.actorHumanId,
          reviewedAt,
          tokenExpiresAt: resolveTokenExpiration(input, reviewedAt),
          expectedFromStatuses: [...expectedFromStatuses],
          // A hand approval is not an invite approval: clear any stamp a
          // rescinded invite approval left behind.
          inviteId: null,
        });
      } else {
        // Sanitized by the input schema; empty-after-sanitize collapses to
        // null. Only a REJECTED decision carries a reason; WAITLISTED stays
        // neutral and both clear any stale reason from a prior decision.
        const decisionReason =
          input.decision === "REJECTED" && input.decisionReason
            ? input.decisionReason
            : null;

        updatedSubmission = await tx.eventApplications.updateSubmissionStatus({
          submissionId: existingSubmission.id,
          status: input.decision,
          reviewerHumanId: input.actorHumanId,
          reviewedAt,
          approvalToken: null,
          tokenExpiresAt: null,
          decisionReason,
          expectedFromStatuses: [...expectedFromStatuses],
        });

        if (input.decision === "WAITLISTED") {
          const entry = await linkWaitlistEntryForSubmission(tx, {
            eventId: editableEvent.id,
            submission: existingSubmission,
            at: reviewedAt,
          });
          waitlistEntryId = entry.id;
        }
      }
    } catch (error) {
      if (isStatusConflict(error)) {
        throw fail("INVALID_STATUS");
      }
      // The decision write moves the row back INTO the open set, so it can
      // collide with an application the SAME applicant already re-submitted
      // (guest applies -> window closes -> sweep EXPIREs -> guest legitimately
      // re-applies -> organizer approves the stale row). Surface the DB
      // backstop as the user-facing duplicate code instead of letting a raw
      // P2002 500 and roll back the whole review.
      if (isDuplicateOpenApplication(error)) {
        throw fail("APPLICATION_ALREADY_SUBMITTED", { cause: error });
      }
      throw error;
    }

    await tx.audit.log({
      entity: "event",
      entityId: editableEvent.id,
      action: "event_application_submission_reviewed",
      data: {
        actorHumanId: input.actorHumanId,
        submissionId: existingSubmission.id,
        fromStatus: existingSubmission.status,
        toStatus: input.decision,
        approvalTokenIssued: Boolean(updatedSubmission.approvalToken),
        tokenExpiresAt: updatedSubmission.tokenExpiresAt,
        hasDecisionReason: Boolean(updatedSubmission.decisionReason),
        ...(waitlistEntryId ? { waitlistEntryId } : {}),
      },
      at: reviewedAt,
    });

    return {
      event: editableEvent,
      submission: updatedSubmission,
      reviewedAt,
    } as const;
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    action: "application_submission_reviewed",
    result: "success",
    actorHumanId: input.actorHumanId,
    metadata: {
      submissionId: submission.id,
      decision: input.decision,
      approvalTokenIssued: Boolean(submission.approvalToken),
    },
  });

  if (input.decision === "APPROVED") {
    await sendApprovalNotification(
      {
        notify: deps.notify,
        repos: deps.repos,
        mailer: deps.mailer,
        appBaseUrl: deps.appBaseUrl,
        reportError: deps.reportError,
        logger: deps.logger,
      },
      {
        event,
        submission,
        useCase: "reviewEventApplicationSubmission",
      },
    );
  }

  if (input.decision === "REJECTED") {
    await notifyApplicationRejection(deps, { event, submission, reviewedAt });
  }

  if (input.decision === "WAITLISTED") {
    await notifyApplicationWaitlisted(deps, { event, submission, reviewedAt });
  }

  return reviewEventApplicationSubmissionOutputSchema.parse({
    eventId: event.id,
    submission,
  });
}

function resolveTokenExpiration(
  input: ReviewEventApplicationSubmissionInput,
  reviewedAt: Date,
): Date {
  if (input.approvalTokenExpiresAt) {
    if (input.approvalTokenExpiresAt.getTime() <= reviewedAt.getTime()) {
      throw fail("TOKEN_EXPIRATION_IN_PAST");
    }
    return input.approvalTokenExpiresAt;
  }

  const ttlMinutes = input.approvalTokenTtlMinutes ?? DEFAULT_TOKEN_TTL_MINUTES;
  const ttlMs = ttlMinutes * 60 * 1000;
  return new Date(reviewedAt.getTime() + ttlMs);
}

/**
 * notify() idempotency keys for ONE rejection / waitlist DECISION INSTANCE.
 * Keyed on the decision's `reviewedAt` (ms) as well as the submission: a
 * decision can be rescinded and re-made, and a submission-only key would
 * collide with the first decision's record (notify()'s replay window, then
 * the ESP's 24h dedupe on the derived `:email` key), dropping the newer
 * email. A retry of the SAME decision carries the same reviewedAt and still
 * replays. Same shape as back-in-review's `rescindedAt` key. Exported for
 * tests.
 */
export function rejectionNotifyIdempotencyKey(
  submissionId: string,
  reviewedAt: Date,
): string {
  return `application-rejected:${submissionId}:${reviewedAt.getTime()}`;
}

export function waitlistNotifyIdempotencyKey(
  submissionId: string,
  reviewedAt: Date,
): string {
  return `application-waitlisted:${submissionId}:${reviewedAt.getTime()}`;
}

type DecisionNotificationContext = {
  /** The decision's timestamp — identifies the decision instance. */
  reviewedAt: Date;
  event: Pick<
    EventRecord,
    "id" | "title" | "slug" | "orgId" | "timezone" | "startsAt" | "endsAt"
  >;
  submission: {
    id: string;
    humanId: string | null;
    contactEmail: string | null;
  };
};

/** Someone to tell: a signed-in applicant, or a guest address + a mailer. */
function hasRecipient(
  deps: ReviewEventApplicationSubmissionDeps,
  submission: DecisionNotificationContext["submission"],
): boolean {
  return Boolean(
    submission.humanId || (submission.contactEmail && deps.mailer),
  );
}

/**
 * Rejection decision notification (spec Phase 1, notification triple leg c).
 * Includes `decisionReason` when the reviewer provided one, and a link to the
 * organizing org's public page when it has one. Same channel split as
 * approval:
 *  - signed-in applicant → humanId-keyed notify() (in-app + email), variant
 *    `event.application-rejected`, idempotency key
 *    {@link rejectionNotifyIdempotencyKey} — one per decision instance
 *    (notify()'s channels derive
 *    their `{key}:email` suffixed keys — duplicate sends are
 *    idempotency-conflict-safe);
 *  - guest applicant → the same ui-email template via the mailer.
 * Both legs are deliberate swallows (the status row is authoritative) —
 * logged AND reported per the ReporterPort convention.
 */
async function notifyApplicationRejection(
  deps: ReviewEventApplicationSubmissionDeps,
  context: DecisionNotificationContext & {
    submission: { decisionReason: string | null };
  },
): Promise<void> {
  const { event, submission } = context;
  if (!hasRecipient(deps, submission)) return;
  const decisionReason = submission.decisionReason;

  const emailContext = await resolveApplicantEmailContext(
    { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
    {
      event,
      appBaseUrl: deps.appBaseUrl,
      useCase: "reviewEventApplicationSubmission",
      includeOrganizerEventsUrl: true,
    },
  );

  // ── Signed-in applicant ──────────────────────────────────────────────
  if (submission.humanId) {
    try {
      await deps.notify({
        humanId: submission.humanId,
        variant: APPLICATION_REJECTED_VARIANT,
        payload: {
          eventId: event.id,
          eventTitle: event.title,
          submissionId: submission.id,
          decisionReason,
          ...(emailContext.organizerEventsUrl
            ? { organizerEventsUrl: emailContext.organizerEventsUrl }
            : {}),
          ...(emailContext.organizerContactEmail
            ? { organizerContactEmail: emailContext.organizerContactEmail }
            : {}),
        },
        scope: { kind: "EVENT", eventId: event.id },
        idempotencyKey: rejectionNotifyIdempotencyKey(
          submission.id,
          context.reviewedAt,
        ),
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      deps.logger?.error(
        "events.reviewEventApplicationSubmission.rejectionNotify_failed",
        {
          submissionId: submission.id,
          humanId: submission.humanId,
          err: error,
          error: describeError(error),
        },
      );
      // Deliberate swallow (the status row is authoritative) — surface to
      // Sentry so a silently-failing rejection notification is visible.
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "reviewEventApplicationSubmission",
            channel: "rejectionNotify",
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
  if (!submission.contactEmail) return;
  await sendApplicantGuestEmail(
    { mailer: deps.mailer, logger: deps.logger, reportError: deps.reportError },
    {
      to: submission.contactEmail,
      content: applicationRejectedEmail({
        eventTitle: event.title,
        decisionReason,
        organizerEventsUrl: emailContext.organizerEventsUrl,
        organizerContactEmail: emailContext.organizerContactEmail,
      }),
      replyTo: emailContext.organizerContactEmail,
      logMessage:
        "events.reviewEventApplicationSubmission.rejectionAnonEmail_failed",
      useCase: "reviewEventApplicationSubmission",
      channel: "rejectionAnonEmail",
      extra: { submissionId: submission.id, eventId: event.id },
    },
  );
}

/**
 * WAITLISTED decision notification (spec Phase 2 item 2). No reason; the
 * copy promises only an email if a spot opens. Same channel split and
 * swallow discipline as the rejection leg; idempotency key
 * {@link waitlistNotifyIdempotencyKey} — one per decision instance.
 */
async function notifyApplicationWaitlisted(
  deps: ReviewEventApplicationSubmissionDeps,
  context: DecisionNotificationContext,
): Promise<void> {
  const { event, submission } = context;
  if (!hasRecipient(deps, submission)) return;

  const emailContext = await resolveApplicantEmailContext(
    { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
    {
      event,
      appBaseUrl: deps.appBaseUrl,
      useCase: "reviewEventApplicationSubmission",
    },
  );

  // ── Signed-in applicant ──────────────────────────────────────────────
  if (submission.humanId) {
    try {
      await deps.notify({
        humanId: submission.humanId,
        variant: APPLICATION_WAITLISTED_VARIANT,
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
        idempotencyKey: waitlistNotifyIdempotencyKey(
          submission.id,
          context.reviewedAt,
        ),
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      deps.logger?.error(
        "events.reviewEventApplicationSubmission.waitlistNotify_failed",
        {
          submissionId: submission.id,
          humanId: submission.humanId,
          err: error,
          error: describeError(error),
        },
      );
      // Deliberate swallow (the status + waitlist rows are authoritative) —
      // surface to Sentry per the ReporterPort convention.
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "reviewEventApplicationSubmission",
            channel: "waitlistNotify",
          },
          extra: { submissionId: submission.id, eventId: event.id },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
    return;
  }

  // ── Guest applicant ──────────────────────────────────────────────────
  if (!submission.contactEmail) return;
  await sendApplicantGuestEmail(
    { mailer: deps.mailer, logger: deps.logger, reportError: deps.reportError },
    {
      to: submission.contactEmail,
      content: applicationWaitlistedEmail({
        eventTitle: event.title,
        eventUrl: emailContext.eventUrl,
        // The event page can't show an anonymous viewer their status, so
        // the template drops its "check status" link.
        isGuest: true,
        organizerContactEmail: emailContext.organizerContactEmail,
      }),
      replyTo: emailContext.organizerContactEmail,
      logMessage:
        "events.reviewEventApplicationSubmission.waitlistAnonEmail_failed",
      useCase: "reviewEventApplicationSubmission",
      channel: "waitlistAnonEmail",
      extra: { submissionId: submission.id, eventId: event.id },
    },
  );
}

export const __test__ = {
  resolveTokenExpiration,
  generateApprovalToken,
  DEFAULT_TOKEN_TTL_MINUTES,
};

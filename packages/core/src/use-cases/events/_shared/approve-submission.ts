import { createHash, randomUUID } from "node:crypto";

import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  ApplicationSubmissionStatus,
  EventApplicationSubmissionRecord,
  EventRecord,
} from "@th/ports/repos/events";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";

import { describeError } from "../../../lib/io";
import {
  APPLICATION_APPROVED_VARIANT,
  applicationApprovedEmail,
} from "../../comms/application-renderers";
import {
  resolveApplicantEmailContext,
  sendApplicantGuestEmail,
} from "./applicant-emails";

/**
 * SHARED approval path for event-application submissions (spec Phase 2).
 *
 * Two callers, one code path (extracted from
 * review-event-application-submission so auto-approve can't drift):
 *  - `reviewEventApplicationSubmission` — reviewer decision APPROVED;
 *  - `submitEventApplication` — form.autoApprove creates the submission
 *    APPROVED (reviewer null) and mints the same unlock + token.
 *
 * Split in two because the durable part must run INSIDE the caller's
 * transaction while the notification is post-commit best-effort:
 *  - {@link applyApprovalDecision} — status/token update + EventUnlock upsert
 *    (tx-scoped; audit logging stays with the caller, whose audit actions
 *    differ);
 *  - {@link sendApprovalNotification} — approval email/in-app fan-out
 *    (deliberate swallow + ReporterPort, the token row is authoritative).
 */

/**
 * Default lifetime of the applicant's claim link (owner decision 2026-09-30:
 * 7 days, so an applicant who doesn't check email daily isn't locked out).
 * Organizers can still pick a shorter or explicit expiry when approving.
 * Unrelated to the anonymous unlock COOKIE's own lifetime.
 */
export const DEFAULT_TOKEN_TTL_MINUTES = 60 * 24 * 7; // 7 days

export type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

/**
 * notify() idempotency key for ONE approval instance (see
 * {@link sendApprovalNotification}). Exported for tests.
 *
 * The approval token is a 7-day bearer secret and this key is NOT secret:
 * notify() derives the mailer's `:email` key from it, which the mailers log
 * and send as the `X-Idempotency-Key` header to the ESP. So the instance is
 * identified by a truncated SHA-256 of the token, never the token itself.
 * 64 bits is plenty to tell one submission's approvals apart and is not a
 * usable preimage of the 128-bit token.
 */
export function approvalNotifyIdempotencyKey(
  submissionId: string,
  approvalToken: string,
): string {
  const instance = createHash("sha256")
    .update(approvalToken)
    .digest("hex")
    .slice(0, 16);
  return `application-approved:${submissionId}:${instance}`;
}

export function generateApprovalToken(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * The applicant's claim link (`/api/events/{id}/claim?token=`), or null when
 * no base URL / token is available.
 */
export function buildClaimUrl(
  appBaseUrl: string | null | undefined,
  eventId: string,
  approvalToken: string | null,
): string | null {
  if (!appBaseUrl || !approvalToken) {
    return null;
  }
  return `${appBaseUrl.replace(/\/+$/, "")}/api/events/${eventId}/claim?token=${approvalToken}`;
}

export type ApplyApprovalDecisionInput = {
  submissionId: string;
  eventId: string;
  /** The applicant (unlock target). Null for anonymous submissions. */
  applicantHumanId: string | null;
  /** Reviewing human, or NULL for auto-approve (no reviewer). */
  reviewerHumanId: string | null;
  /**
   * Must be FRESH for every approval (both callers pass `clock.now()`): it is
   * the approval-instance id the application grant cookie is bound to
   * (`_shared/application-gate-grant.ts`). Rescind nulls it, so a grant from
   * an earlier approval never matches a later one.
   */
  reviewedAt: Date;
  tokenExpiresAt: Date;
  /**
   * Optional compare-and-swap guard forwarded to the repo: the write only
   * lands if the row's CURRENT status is in this set, otherwise the adapter
   * throws a `{ code: "conflict" }` error for the caller to map. The REVIEW
   * path passes it so a withdraw committing mid-review can't be overwritten
   * with APPROVED + a live token; the auto-approve path omits it (it created
   * the row microseconds earlier inside the same transaction).
   */
  expectedFromStatuses?: ApplicationSubmissionStatus[];
  /**
   * The invite link approving this submission (gated-event invite links
   * FR-005). Stamped on the submission ("Via invite", cap-exempt, rescinded
   * when the invite is revoked) and on the applicant's EventUnlock.
   * Absent = the submission's column is left as it is and the unlock gets
   * none. `null` = the column is CLEARED: the organizer-review path passes it
   * so a hand approval of a once-invited (then rescinded) submission stops
   * reading "Via invite", counts against the cap again, and is not
   * rescinded by a later revoke of the old invite.
   */
  inviteId?: string | null;
};

/**
 * The durable half of an approval, run inside the caller's transaction:
 * flips the submission APPROVED with a freshly-minted approval token and —
 * for signed-in applicants — upserts the EventUnlock so access is immediate.
 * Always clears any stale decisionReason (e.g. from a rescinded rejection).
 *
 * ORDER MATTERS: the guarded status write runs FIRST, so a lost CAS throws
 * before any unlock is minted — an approval that loses the race leaves no
 * durable access behind.
 */
export async function applyApprovalDecision(
  tx: Pick<TxRepos, "eventApplications" | "eventUnlocks">,
  input: ApplyApprovalDecisionInput,
): Promise<EventApplicationSubmissionRecord> {
  const approvalToken = generateApprovalToken();

  const updatedSubmission = await tx.eventApplications.updateSubmissionStatus({
    submissionId: input.submissionId,
    status: "APPROVED",
    reviewerHumanId: input.reviewerHumanId,
    reviewedAt: input.reviewedAt,
    approvalToken,
    tokenExpiresAt: input.tokenExpiresAt,
    decisionReason: null,
    ...(input.inviteId !== undefined ? { inviteId: input.inviteId } : {}),
    ...(input.expectedFromStatuses
      ? { expectedFromStatuses: input.expectedFromStatuses }
      : {}),
  });

  if (input.applicantHumanId) {
    await tx.eventUnlocks.upsert({
      eventId: input.eventId,
      humanId: input.applicantHumanId,
      source: "APPLICATION",
      applicationSubmissionId: input.submissionId,
      // Invite approvals: lets revokeByInvite remove this holder inside the
      // revoke transaction, whatever the event's gate type is by then.
      ...(input.inviteId ? { inviteId: input.inviteId } : {}),
    });
  }

  return updatedSubmission;
}

export type ApprovalNotificationDeps = {
  notify: NotifyFn;
  /**
   * Post-commit reads for the template context (organizer contact email).
   * Optional: without it that prop is omitted.
   */
  repos?: Partial<Pick<Repos, "organizations">>;
  /**
   * Direct mailer for the ANONYMOUS applicant path (no humanId to key
   * `notify` on). Best-effort — the token row is authoritative.
   */
  mailer?: MailerPort;
  /** Web app base URL, used to build the applicant's claim link. */
  appBaseUrl?: string;
  /** Sentry reporter for the best-effort email swallow branches. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

export type ApprovalNotificationContext = {
  event: Pick<
    EventRecord,
    "id" | "title" | "slug" | "orgId" | "timezone" | "startsAt" | "endsAt"
  >;
  submission: Pick<
    EventApplicationSubmissionRecord,
    "id" | "humanId" | "contactEmail" | "approvalToken" | "tokenExpiresAt"
  >;
  /** Calling use case — tags the swallow-branch logs/Sentry reports. */
  useCase: string;
};

/**
 * Approval notification, post-commit and best-effort. Same channel split for
 * both callers:
 *  - signed-in applicant → humanId-keyed notify() (in-app + email), variant
 *    `event.application-approved`, idempotency key
 *    {@link approvalNotifyIdempotencyKey} (submission id + a hash of the
 *    token, never the token itself) — one key per APPROVAL INSTANCE. Every
 *    approval mints a fresh token, so a retry of the same approval replays, while approve → rescind → re-approve sends a new
 *    notice (a submission-only key would collide with the first approval's
 *    record: the renderer fingerprint carries the token, so notify() would
 *    throw IDEMPOTENCY_KEY_CONFLICT, or the ESP would drop it as a 24h
 *    duplicate);
 *  - guest applicant → the same ui-email template straight through the
 *    mailer, carrying the claim link.
 * Both legs are deliberate swallows (the token row is authoritative) —
 * logged AND reported per the ReporterPort convention.
 */
export async function sendApprovalNotification(
  deps: ApprovalNotificationDeps,
  context: ApprovalNotificationContext,
): Promise<void> {
  if (!context.submission.approvalToken) {
    return;
  }

  const claimUrl = buildClaimUrl(
    deps.appBaseUrl,
    context.event.id,
    context.submission.approvalToken,
  );
  const expiresAtIso = context.submission.tokenExpiresAt?.toISOString() ?? null;

  const isGuest = !context.submission.humanId;
  // A guest needs the claim link (it sets their unlock cookie); without one
  // there is nothing useful to send them.
  if (isGuest && !(context.submission.contactEmail && claimUrl && deps.mailer)) {
    return;
  }

  // Event page, dates, zone and organizer contact for the template. Never
  // throws (a failed lookup costs the prop, not the email).
  const emailContext = await resolveApplicantEmailContext(
    {
      repos: deps.repos,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      event: context.event,
      appBaseUrl: deps.appBaseUrl,
      useCase: context.useCase,
    },
  );

  // ── Signed-in applicant ──────────────────────────────────────────────
  // `notify` is humanId-keyed (in-app + email). The renderer always emits
  // the template; the claim link rides along when we have one.
  if (context.submission.humanId) {
    const scope = { kind: "EVENT", eventId: context.event.id } as const;
    const payload = {
      eventId: context.event.id,
      eventTitle: context.event.title,
      submissionId: context.submission.id,
      approvalToken: context.submission.approvalToken,
      expiresAtIso,
      ...(claimUrl ? { approvalUrl: claimUrl } : {}),
      ...(emailContext.eventUrl ? { eventUrl: emailContext.eventUrl } : {}),
      ...(emailContext.startsAtIso
        ? { startsAtIso: emailContext.startsAtIso }
        : {}),
      ...(emailContext.endsAtIso ? { endsAtIso: emailContext.endsAtIso } : {}),
      ...(emailContext.timezone ? { timezone: emailContext.timezone } : {}),
      ...(emailContext.organizerContactEmail
        ? { organizerContactEmail: emailContext.organizerContactEmail }
        : {}),
    } as const;

    try {
      await deps.notify({
        humanId: context.submission.humanId,
        variant: APPLICATION_APPROVED_VARIANT,
        payload,
        scope,
        idempotencyKey: approvalNotifyIdempotencyKey(
          context.submission.id,
          context.submission.approvalToken,
        ),
      });
    } catch (error) {
      deps.logger?.error(`events.${context.useCase}.notify_failed`, {
        submissionId: context.submission.id,
        humanId: context.submission.humanId,
        err: error,
        error: describeError(error),
      });
      // Deliberate swallow (the token row is authoritative) — surface to
      // Sentry so a silently-failing approval notification is visible.
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: context.useCase,
            channel: "notify",
          },
          extra: {
            submissionId: context.submission.id,
            eventId: context.event.id,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn
        // the swallow into a thrown error.
      }
    }
    return;
  }

  // ── Guest applicant ──────────────────────────────────────────────────
  // No humanId to key `notify` on: the same branded template straight
  // through the mailer, carrying the claim link. Best-effort: the token row
  // is authoritative. (The guard above guarantees address + link + mailer.)
  const guestEmail = context.submission.contactEmail;
  if (!guestEmail || !claimUrl) return;
  await sendApplicantGuestEmail(
    { mailer: deps.mailer, logger: deps.logger, reportError: deps.reportError },
    {
      to: guestEmail,
      content: applicationApprovedEmail({
        eventTitle: context.event.title,
        approvalUrl: claimUrl,
        eventUrl: emailContext.eventUrl,
        expiresAtIso,
        startsAtIso: emailContext.startsAtIso,
        endsAtIso: emailContext.endsAtIso,
        timezone: emailContext.timezone,
        organizerContactEmail: emailContext.organizerContactEmail,
      }),
      replyTo: emailContext.organizerContactEmail,
      logMessage: `events.${context.useCase}.anonEmail_failed`,
      useCase: context.useCase,
      channel: "anonEmail",
      extra: {
        submissionId: context.submission.id,
        eventId: context.event.id,
      },
    },
  );
}

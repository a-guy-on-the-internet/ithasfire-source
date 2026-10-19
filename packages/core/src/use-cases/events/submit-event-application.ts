import { z } from "zod";
import escapeHtml from "escape-html";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EventApplicationSubmissionRecord,
  EventGateType,
  EventVisibility,
} from "@th/ports/repos/events";
import type { TurnstilePort } from "@th/ports/turnstile";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { describeError, parseInput } from "../../lib/io";
import {
  applyApprovalDecision,
  DEFAULT_TOKEN_TTL_MINUTES,
  sendApprovalNotification,
  type NotifyFn,
} from "./_shared/approve-submission";
import { canViewerBypassEventGate } from "./_shared/ensure-actor-can-edit-event";
import {
  answersSchema,
  buildQuestionsSnapshot,
  hasMissingRequiredAnswers,
} from "./_shared/application-answers";
import { isDuplicateOpenApplication } from "./_shared/status-conflict";
import { fail } from "@th/errors";
import type { NotifyEventApplicationReceivedFn } from "./notify-event-application-received";
import type { MailerPort } from "@th/ports/comms/mailer";
import {
  contactPhoneSchema,
  lowercasedContactEmailSchema,
} from "./_shared/viewer-contact-schema";
import { sanitizeSubject } from "../comms/channels/send-email";
import { ensureEventOpenToPublic } from "./_shared/event-open-to-public";

/**
 * Statuses that consume a slot under `maxSubmissions` (spec Phase 2):
 * everything except WITHDRAWN and EXPIRED — a withdrawn or swept submission
 * frees its slot.
 */
const CAP_COUNTED_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WAITLISTED",
] as const;

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const submitEventApplicationInputSchemaBase = z.object({
  eventId: z.string().uuid(),
  viewerHumanId: z.string().uuid().nullable().optional(),
  /**
   * LOWERCASED at the boundary — this address is the guest's dedupe identity
   * (spec Phase 3 item 2), matched by the `lower(contactEmail)` partial
   * unique index, so it must be lowercased at rest.
   */
  contactEmail: lowercasedContactEmailSchema,
  contactPhone: contactPhoneSchema,
  answers: answersSchema,
  /**
   * Cloudflare Turnstile token for bot protection. Only enforced for
   * UNAUTHENTICATED submitters (anonymous-applicant prep, spec Phase 3);
   * signed-in applicants skip the check entirely. Same shape as
   * createBookingInquiry's token.
   */
  turnstileToken: z.string().min(1).max(4096).optional(),
  /**
   * Server-observed client IP, supplied by trusted transports only (the
   * router omits it from the client-facing schema and injects ctx.clientIp).
   */
  requestIp: z.string().trim().min(1).max(128).nullable().optional(),
});

/**
 * A GUEST must supply `contactEmail` (spec Phase 3 item 2) — it is the only
 * identity an anonymous application has, and it is what the decision email,
 * the claim link and the one-open-per-applicant dedupe all key on. A
 * phone-only guest submission would be undeliverable AND slip the dedupe
 * index (whose entries over NULL are all distinct), so it is rejected at the
 * boundary. Signed-in applicants pass trivially — their humanId is the key.
 */
export const submitEventApplicationInputSchema =
  submitEventApplicationInputSchemaBase
    .refine((value) => Boolean(value.viewerHumanId ?? value.contactEmail), {
      message: "contact_email_required",
      path: ["contactEmail"],
    })
    .strict();

export const submitEventApplicationOutputSchema = z.object({
  eventId: z.string().uuid(),
  submissionId: z.string().uuid().nullable(),
  status: applicationSubmissionStatusSchema.nullable(),
  bypassed: z.boolean(),
});

export type SubmitEventApplicationInput = z.infer<
  typeof submitEventApplicationInputSchema
>;
export type SubmitEventApplicationOutput = z.infer<
  typeof submitEventApplicationOutputSchema
>;

export type SubmitEventApplicationDeps = {
  /**
   * `tx` + unlock/audit repos are exercised by the autoApprove path only;
   * `organizations` feeds the approval email's organizer contact.
   */
  repos: Pick<
    Repos,
    "events" | "authz" | "eventApplications" | "tx" | "organizations"
  >;
  clock: ClockPort;
  /**
   * Turnstile adapter for bot protection. When enabled, a valid token is
   * required for UNAUTHENTICATED submitters only (signed-in applicants skip).
   */
  turnstile?: TurnstilePort | null;
  /**
   * Post-commit notification fan-out (applicant ack + organizer notify),
   * composed at the transport layer (notify-event-application-received).
   * Best-effort: failures are swallowed + reported, never failing the
   * committed submission. On autoApprove the applicant-ack leg is suppressed
   * (`applicantAck: false`) — the applicant gets the APPROVAL email instead,
   * never both.
   */
  notifyApplicationReceived?: NotifyEventApplicationReceivedFn;
  /**
   * Approval notification pipeline for the autoApprove path — the SAME
   * `sendApprovalNotification` the review flow uses (in-app + email for
   * signed-in applicants, direct claim email for guests). Optional: without
   * it the approval + token rows are still authoritative.
   */
  notify?: NotifyFn;
  /** Direct mailer for the anonymous-applicant approval email. */
  mailer?: MailerPort;
  /** Web app base URL, used to build the applicant's claim link. */
  appBaseUrl?: string;
  /** Sentry reporter for the best-effort notification swallow branch. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

export async function submitEventApplication(
  deps: SubmitEventApplicationDeps,
  rawInput: unknown,
): Promise<SubmitEventApplicationOutput> {
  const input = parseInput(submitEventApplicationInputSchema, rawInput);
  // A banned owner's event takes no applications (ban-that-sticks): it
  // answers EVENT_NOT_FOUND, the same as an unpublished one (below).
  const event = await ensureEventOpenToPublic(deps.repos, input.eventId);

  const bypassed = await canViewerBypassEventGate(
    deps.repos.authz,
    event,
    input.viewerHumanId ?? null,
  );

  if (bypassed) {
    logApplicationEvent(
      deps.logger,
      event.visibility as EventVisibility,
      event.gateType as EventGateType,
      {
        eventId: event.id,
        action: "application_submitted",
        result: "bypassed",
        viewerHumanId: input.viewerHumanId ?? null,
      },
    );

    return submitEventApplicationOutputSchema.parse({
      eventId: event.id,
      submissionId: null,
      status: null,
      bypassed: true,
    });
  }

  // ── Only a PUBLISHED event accepts applications ────────────────────────
  // Deliberately AFTER the organizer-bypass early-return above, so an
  // organizer previewing their own draft still short-circuits harmlessly.
  //
  // Without this an unauthenticated caller holding only the event UUID could
  // submit against a DRAFT / CANCELLED / COMPLETED / ARCHIVED gated event:
  // `getPublicApplicationForm` refuses to SHOW those forms, but this write
  // happily accepted them, created a queue row and fanned out organizer
  // notifications. Collapses to EVENT_NOT_FOUND — the same code the public
  // form read returns — so the pair can't be diffed into a status oracle.
  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.gateType !== "APPLICATION") {
    throw fail("EVENT_NOT_APPLICATION_GATED");
  }

  // ── Turnstile (bot protection) — anonymous submitters only ─────────────
  // Signed-in applicants skip the check entirely; today the applicant is
  // effectively always authed, so this is inert prep for the anonymous
  // phase (spec Phase 3). Same enforcement shape as createBookingInquiry.
  if (!input.viewerHumanId && deps.turnstile?.enabled) {
    if (!input.turnstileToken) {
      throw fail("TURNSTILE_TOKEN_REQUIRED");
    }
    const valid = await deps.turnstile.verify(
      input.turnstileToken,
      input.requestIp ?? undefined,
    );
    if (!valid) {
      deps.logger?.warn("submitEventApplication.turnstileFailed", {
        eventId: event.id,
      });
      throw fail("TURNSTILE_VERIFICATION_FAILED");
    }
  }

  // ── Question snapshot at submit time (spec D3) ─────────────────────────
  // The review queue renders answers from this snapshot, never from live
  // questions, so later edits/deletes can't orphan historical answers.
  // The attendee gate submits to the event's ATTEND form only — never its
  // open call (PERFORM), which takes applications through its own path.
  const form = await deps.repos.eventApplications.getForm(event.id, "ATTEND");
  const questions = form
    ? await deps.repos.eventApplications.listQuestions(form.id)
    : [];
  const questionsSnapshot = buildQuestionsSnapshot(questions);

  const now = deps.clock.now();

  // ── Application window + cap (spec Phase 2) ────────────────────────────
  // The gate shows "applications open {date}" / "closed" states client-side;
  // this is the server-side enforcement. Boundary semantics: exactly-at
  // opensAt is OPEN, exactly-at closesAt is still open — only strictly
  // outside the window rejects.
  if (form) {
    if (form.opensAt && now.getTime() < form.opensAt.getTime()) {
      throw fail("APPLICATION_WINDOW_NOT_OPEN");
    }
    if (form.closesAt && now.getTime() > form.closesAt.getTime()) {
      throw fail("APPLICATION_WINDOW_CLOSED");
    }
    if (form.maxSubmissions !== null) {
      // Dedicated COUNT (never list-and-count). WITHDRAWN + EXPIRED free
      // their slot, so only the remaining statuses consume the cap.
      //
      // SOFT cap, deliberately: this is read-then-create with no
      // serialization, so N submits racing the last slot can overshoot by
      // up to N-1. That is acceptable for an application queue — the cap
      // is an organizer workload valve, not ticket inventory, and every
      // submission still passes human review (or, on autoApprove, the
      // organizer sees the true count in the queue). A HARD cap would need
      // a serializable transaction or an advisory lock on the form row;
      // revisit only if a real event needs exactness.
      const submissionCount =
        await deps.repos.eventApplications.countSubmissions({
          eventId: event.id,
          purpose: "ATTEND",
          statuses: [...CAP_COUNTED_STATUSES],
          // R11 (gated-event invite links): invite approvals don't count.
          excludeInvited: true,
        });
      if (submissionCount >= form.maxSubmissions) {
        throw fail("APPLICATION_CAP_REACHED");
      }
    }
  }

  // ── Server-side required-answer enforcement ────────────────────────────
  // The gate enforces this client-side (EventApplicationGate's
  // hasMissingRequiredAnswers), but a direct tRPC call could otherwise
  // create an empty submission against an all-required form. Answers keyed
  // by question ids that no longer exist are simply ignored; required
  // questions added after the applicant loaded the form correctly reject.
  if (hasMissingRequiredAnswers(questions, input.answers)) {
    throw fail("APPLICATION_ANSWERS_INCOMPLETE");
  }

  // ── One OPEN application per applicant per FORM (spec Phase 3 item 2) ──
  // Per form since open calls v1: the same person may hold an open ATTEND
  // and an open PERFORM application on one event. No form row yet means no
  // submission can exist on it, so the pre-check has nothing to find.
  // "Open" = PENDING | APPROVED | WAITLISTED; WITHDRAWN / REJECTED / EXPIRED
  // free the applicant to apply again. The identity is the humanId for
  // signed-in applicants and the (lowercased) contactEmail for guests — the
  // schema above guarantees a guest has one.
  //
  // This pre-check RACES (read-then-create, no serialization). The two
  // SQL-only partial unique indexes (migration 20260811140000, re-keyed to
  // formId by 20261005120000_open_calls) are the authoritative backstop; the adapter maps their P2002 to
  // `duplicate_open_application`, which the create below funnels into the
  // SAME two-branch response so the pre-check and the race are identical
  // from outside.
  //
  // ── THE ENUMERATION SPLIT ───────────────────────────────────────────────
  // The two identities have OPPOSITE disclosure properties, so they get
  // opposite responses:
  //
  //  * AUTHED (key = humanId, proven by the session): a distinguishable
  //    APPLICATION_ALREADY_SUBMITTED tells you only about YOURSELF. Keep it —
  //    it is the actionable, honest answer.
  //
  //  * GUEST (key = a SELF-ASSERTED email): a distinguishable error is an
  //    oracle — anyone could ask "has alice@example.com applied to this
  //    event?" and read the answer off the status code. So the guest branch
  //    returns the SAME success shape a first-time submit returns and tells
  //    the ADDRESS OWNER instead, by email. A prober learns nothing; the real
  //    applicant learns exactly what they need to know, in the one channel
  //    that proves they own the address.
  //
  // Explicitly NOT chosen: "silently return the existing submission". That
  // hands the prober the real submissionId and status — it upgrades a boolean
  // oracle into data disclosure. The duplicate response carries NEITHER
  // (submissionId: null, status: null — the shape the bypass branch already
  // establishes as a legal "nothing was created" result).
  if (form && input.viewerHumanId) {
    const open = await deps.repos.eventApplications.findOpenSubmission({
      formId: form.id,
      humanId: input.viewerHumanId,
    });
    if (open) {
      throw fail("APPLICATION_ALREADY_SUBMITTED");
    }
  } else if (form && input.contactEmail) {
    const open = await deps.repos.eventApplications.findOpenSubmission({
      formId: form.id,
      contactEmail: input.contactEmail,
    });
    if (open) {
      return respondToGuestDuplicate(deps, {
        event,
        contactEmail: input.contactEmail,
      });
    }
  }

  // `formId` is added at create time: an APPLICATION-gated event whose
  // organizer never saved a form has no ATTEND form row yet, and a
  // submission needs one (open calls v1 made formId required).
  const submissionInput = {
    eventId: event.id,
    humanId: input.viewerHumanId ?? null,
    contactEmail: input.contactEmail ?? null,
    contactPhone: input.contactPhone ?? null,
    answers: input.answers,
    questionsSnapshot,
    submittedAt: now,
  };

  const autoApprove = form?.autoApprove === true;

  // ── Create — instantly APPROVED when the form auto-approves ────────────
  // autoApprove = "registration with questions" mode (spec Phase 2, parity
  // with volunteerAutoApprove): the submission lands APPROVED with the SAME
  // unlock + approval-token mint the review flow performs
  // (_shared/approve-submission), reviewer NULL, reviewedAt = now. One
  // transaction: a submission must never commit APPROVED without its unlock/
  // token, and the audit row rides the same commit.
  //
  // The DB race loser (P2002 from a partial unique index) funnels into the
  // exact same two-branch response as the pre-check above — the authed
  // applicant gets the typed error, the guest gets the indistinguishable
  // success shape + an email to the address owner. If the two disagreed, the
  // race would itself become the oracle the split exists to close.
  let submission: EventApplicationSubmissionRecord;
  try {
    submission = await (autoApprove && form
      ? deps.repos.tx(async (tx) => {
          const created =
            await tx.eventApplications.createSubmission({
              ...submissionInput,
              formId: form.id,
            });
          const approved = await applyApprovalDecision(tx, {
            submissionId: created.id,
            eventId: event.id,
            applicantHumanId: created.humanId,
            reviewerHumanId: null,
            reviewedAt: now,
            tokenExpiresAt: new Date(
              now.getTime() + DEFAULT_TOKEN_TTL_MINUTES * 60 * 1000,
            ),
          });
          await tx.audit.log({
            entity: "event",
            entityId: event.id,
            action: "event_application_auto_approved",
            data: {
              submissionId: created.id,
              humanId: created.humanId,
              approvalTokenIssued: Boolean(approved.approvalToken),
              tokenExpiresAt: approved.tokenExpiresAt,
            },
            at: now,
          });
          return approved;
        })
      : form
        ? deps.repos.eventApplications.createSubmission({
            ...submissionInput,
            formId: form.id,
          })
        : // No ATTEND form saved yet: create the default one and the
          // submission in ONE transaction, so a failed create leaves no
          // half-written state behind.
          deps.repos.tx(async (tx) => {
            const attendForm = await tx.eventApplications.ensureForm({
              eventId: event.id,
              purpose: "ATTEND",
            });
            return tx.eventApplications.createSubmission({
              ...submissionInput,
              formId: attendForm.id,
            });
          }));
  } catch (error) {
    if (!isDuplicateOpenApplication(error)) {
      throw error;
    }
    if (input.viewerHumanId) {
      throw fail("APPLICATION_ALREADY_SUBMITTED", { cause: error });
    }
    return respondToGuestDuplicate(deps, {
      event,
      // A guest reaching the DB gate always has an email (schema-enforced);
      // the fallback keeps the type honest and simply skips the notice.
      contactEmail: input.contactEmail ?? null,
    });
  }

  // ── Notification fan-out — post-commit, best-effort ────────────────────
  // The submission is durably committed above; a notification failure must
  // never fail the submit. Deliberate swallow → keep the log AND report via
  // ReporterPort so the branch stays visible in Sentry (CLAUDE.md
  // convention; mirrors createBookingInquiry).
  //
  // Auto-approved submissions get the APPROVAL email (shared code path with
  // the review flow) INSTEAD of the received ack — never both. Its
  // idempotency key is per approval instance (`approvalNotifyIdempotencyKey`:
  // submission id + a truncated SHA-256 of the token, never the token):
  // review only accepts PENDING/EXPIRED rows, so a manual approve can only
  // follow a rescind, which is a new approval and a new notice by design.
  // The organizer "new submission" leg still fires either way.
  if (autoApprove && deps.notify) {
    await sendApprovalNotification(
      {
        notify: deps.notify,
        repos: deps.repos,
        mailer: deps.mailer,
        appBaseUrl: deps.appBaseUrl,
        reportError: deps.reportError,
        logger: deps.logger,
      },
      { event, submission, useCase: "submitEventApplication" },
    );
  }

  if (deps.notifyApplicationReceived) {
    try {
      await deps.notifyApplicationReceived({
        event,
        submission,
        // Auto-approve: applicant gets the APPROVAL email instead of the
        // ack (never both), and the organizer leg goes email-free — a
        // high-volume registration event must not email every edit-role
        // member per registrant (in-app + push still deliver).
        ...(autoApprove
          ? { applicantAck: false, muteOrganizerEmail: true }
          : {}),
      });
    } catch (error) {
      deps.logger?.error("events.submitApplication.notify_failed", {
        submissionId: submission.id,
        eventId: event.id,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "submitEventApplication" },
          extra: { submissionId: submission.id, eventId: event.id },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail
        // the committed submission.
      }
    }
  }

  logApplicationEvent(
    deps.logger,
    event.visibility as EventVisibility,
    event.gateType as EventGateType,
    {
      eventId: event.id,
      action: "application_submitted",
      result: "success",
      viewerHumanId: input.viewerHumanId ?? null,
      metadata: { submissionId: submission.id, autoApproved: autoApprove },
    },
  );

  return submitEventApplicationOutputSchema.parse({
    eventId: event.id,
    submissionId: submission.id,
    status: submission.status,
    bypassed: false,
  });
}

/**
 * The GUEST duplicate response (see "THE ENUMERATION SPLIT" above).
 *
 * Byte-identical to what a first-time guest submit returns on the
 * organizer-bypass shape — `submissionId: null`, `status: null`,
 * `bypassed: false` — so a prober cannot distinguish "this address has an
 * open application" from "this address does not". Nothing about the existing
 * submission (its id, status, dates or answers) crosses the wire.
 *
 * The real applicant is told through the ONE channel that proves they own the
 * address: an email to it. Best-effort and deliberately swallowed — the
 * indistinguishability of the response must not depend on the mailer being
 * up, and a mail failure must never turn into a distinguishable 5xx.
 */
async function respondToGuestDuplicate(
  deps: SubmitEventApplicationDeps,
  args: { event: { id: string; title: string }; contactEmail: string | null },
): Promise<SubmitEventApplicationOutput> {
  if (args.contactEmail && deps.mailer) {
    const safeTitle = escapeHtml(args.event.title);
    try {
      await deps.mailer.send({
        to: { to: args.contactEmail },
        // This path skips notify()'s sendEmail, so apply its header-injection
        // sanitizer here too (same as the applicant guest legs).
        subject: sanitizeSubject(
          `You already have an application in progress for ${args.event.title}`,
        ),
        text: [
          `You already have an application in progress for ${args.event.title}, so we didn't create a second one.`,
          "",
          "The organizer will review the application you already sent and you'll hear back by email either way.",
          "",
          "Didn't apply? Ignore this email. Someone may have typed your address by mistake. Nothing new was created.",
        ].join("\n"),
        html: [
          `<p>You already have an application in progress for <strong>${safeTitle}</strong>, so we didn't create a second one.</p>`,
          `<p>The organizer will review the application you already sent and you'll hear back by email either way.</p>`,
          `<p>Didn't apply? Ignore this email. Someone may have typed your address by mistake. Nothing new was created.</p>`,
        ].join("\n"),
      });
    } catch (error) {
      deps.logger?.error("events.submitApplication.duplicate_notice_failed", {
        eventId: args.event.id,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "submitEventApplication",
            channel: "guestDuplicateNotice",
          },
          extra: { eventId: args.event.id },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
  }

  return submitEventApplicationOutputSchema.parse({
    eventId: args.event.id,
    submissionId: null,
    status: null,
    bypassed: false,
  });
}

type ApplicationLogPayload = {
  eventId: string;
  action: "application_submitted";
  result: "success" | "bypassed";
  viewerHumanId: string | null;
  metadata?: Record<string, unknown>;
};

function logApplicationEvent(
  logger: LoggerPort | undefined,
  visibility: EventVisibility,
  gateType: EventGateType,
  payload: ApplicationLogPayload,
): void {
  logger?.info("event_gate", {
    category: "event_gate",
    visibility,
    gateType,
    ...payload,
  });
}

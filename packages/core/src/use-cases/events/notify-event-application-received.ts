import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EventApplicationSubmissionRecord,
  EventRecord,
} from "@th/ports/repos/events";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  APPLICATION_RECEIVED_VARIANT,
  applicationReceivedEmail,
} from "../comms/application-renderers";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  resolveApplicantEmailContext,
  sendApplicantGuestEmail,
} from "./_shared/applicant-emails";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applicant acknowledgement variant (registered in comms/renderers.ts).
 * Defined once in application-renderers.ts; re-exported for the events
 * barrel.
 */
export { APPLICATION_RECEIVED_VARIANT };

/** Organizer "new submission" variant (registered in comms/renderers.ts). */
export const APPLICATION_SUBMISSION_RECEIVED_VARIANT =
  "event.application-submission-received";

/**
 * Org roles notified about a new application — the same bar as who can
 * REVIEW one (`review-event-application-submission` requires edit access via
 * `ensureActorCanEditEvent`, i.e. `ORG_EDIT_ROLES` for org events).
 * Viewers/finance/scanners are deliberately not spammed about queue items
 * they can't act on. Mirrors notify-booking-request-received.
 */
const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

/**
 * Guaranteed-non-empty applicant display name. `applicantName` must NEVER be
 * empty: the renderer schema rejects it (failing notify() up front, before
 * its idempotency claim), and a value that slipped past the renderer would
 * hit the email template's own props schema inside the mail adapter — AFTER
 * the adapter claims its derived `{key}:email`, silently losing that send.
 */
const APPLICANT_NAME_FALLBACK = "Someone";

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyEventApplicationReceivedDeps = {
  repos: Pick<Repos, "humans" | "organizations" | "entityPages">;
  notify: NotifyFn;
  /**
   * Direct mailer for the ANONYMOUS applicant acknowledgement (no humanId to
   * key `notify` on). Best-effort — the submission row is authoritative.
   * Optional: today the applicant is effectively always signed in; this is
   * inert prep for the anonymous phase (spec Phase 3).
   */
  mailer?: MailerPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for per-recipient delivery failures (the loop keeps
   * going — one bad recipient must not sink the rest). ReporterPort
   * convention: a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app (e.g. https://ithasfire.com) used to build the
   * absolute review-queue deep link. Required — without it there is no valid
   * `queueUrl` and the whole step throws (the CALLER's swallow reports it).
   */
  publicAppUrl?: string | null;
};

export type NotifyEventApplicationReceivedArgs = {
  event: Pick<
    EventRecord,
    | "id"
    | "title"
    | "humanId"
    | "orgId"
    | "slug"
    | "timezone"
    | "startsAt"
    | "endsAt"
  >;
  submission: EventApplicationSubmissionRecord;
  /**
   * When false, the applicant-acknowledgement leg is SKIPPED and only the
   * organizer "new submission" leg fires. Used by autoApprove submissions
   * (spec Phase 2): the applicant gets the APPROVAL email instead of the
   * received ack — never both. Default true.
   */
  applicantAck?: boolean;
  /**
   * When true, the organizer leg's EMAIL channel is disabled via notify()'s
   * per-call channel override (in-app + push still deliver, subject to the
   * recipient's preferences). Used by autoApprove submissions: a
   * high-volume "registration with questions" event would otherwise email
   * every edit-role member once per registrant with nothing to act on —
   * auto-approved rows need no review. The queue + in-app feed keep the
   * visibility. Default false.
   */
  muteOrganizerEmail?: boolean;
};

/**
 * Shape of the caller-facing hook injected into `submitEventApplication` —
 * composed at the transport/composition layer so the submit use case stays
 * decoupled from the notify pipeline's deps (exactly the
 * `NotifyBookingRequestReceivedFn` pattern).
 */
export type NotifyEventApplicationReceivedFn = (
  args: NotifyEventApplicationReceivedArgs,
) => Promise<void>;

type Recipient = { humanId: string; queueUrl: string };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-submit notification fan-out for an event application (spec Phase 1
 * "notification triple", legs a + b):
 *
 *  a. Applicant acknowledgement — signed-in applicants get an in-app + email
 *     notify() (`event.application-received`); anonymous applicants (Phase 3
 *     prep) get a best-effort direct email when a mailer is bound.
 *  b. Organizer notify — in-app + email to everyone who can review the
 *     queue: the owning human, or edit-role members (OWNER/ADMIN/EDITOR) of
 *     the owning org, paged + deduped. Mirrors
 *     notify-booking-request-received.
 *
 * Fired post-commit by `submitEventApplication`; the CALLER wraps this in a
 * swallow (logger.error + reportError) so a throwing notifier never fails
 * the already-committed submission. Inside, each recipient is additionally
 * isolated so one failed delivery doesn't block the others.
 *
 * Idempotency keys (notify() channels derive their own `{key}:email` /
 * `{key}:sms` suffixed keys from these):
 *  - applicant ack:   `application-received:${submissionId}`
 *  - organizer leg:   `application-submission-received:${submissionId}:${humanId}`
 *
 * The queue deep link is per-recipient because the admin slug differs by how
 * the recipient owns the event (mirrors notify-booking-request-received):
 *  - owning human    → `/admin/@{username | pageSlug | humanId}/events/{id}/applications`
 *  - org edit member → `/admin/{orgSlug | orgId}/events/{id}/applications`
 *
 * SMS is explicitly disabled (renderers emit no SMS payload; the channel
 * override is belt-and-braces). In-app / email / push stay
 * preference-driven; the `transactional` category defaults them ON.
 */
export async function notifyEventApplicationReceived(
  deps: NotifyEventApplicationReceivedDeps,
  args: NotifyEventApplicationReceivedArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyEventApplicationReceived",
  });
  const { event, submission } = args;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    // No base URL → no valid absolute queueUrl → every organizer notify()
    // would fail its renderer parse. Fail the whole step once, loudly,
    // instead; the caller's swallow reports it.
    throw new Error(
      "notifyEventApplicationReceived: publicAppUrl is required to build the review-queue link",
    );
  }

  // Resolve everything the renderers/templates need BEFORE any notify()
  // call — a prop that passes the renderer schema but fails the ui-email
  // template's own schema surfaces inside mailer.send, AFTER the mail
  // adapter claims its derived `{key}:email` key, losing that email
  // permanently. Pre-resolving valid props closes both paths.
  const applicantName = await resolveApplicantName(deps.repos, submission);
  const recipients = await resolveRecipients(deps.repos, event, baseUrl);

  // Auto-approved submissions suppress the ack (`applicantAck: false`) —
  // the applicant gets the approval email via the shared approval path, and
  // sending both would be noise.
  if (args.applicantAck !== false) {
    await sendApplicantAck(deps, logger, { event, submission, baseUrl });
  }

  if (recipients.length === 0) {
    // An application-gated event that resolves to zero notifiable reviewers
    // means every submission lands in a queue nobody hears about. Deliberate
    // swallow (the submission already committed; we return, not throw) — and
    // warn is NOT Sentry-captured, so log at error AND report per the
    // ReporterPort convention.
    logger?.error("events.notify_application_received.no_recipients", {
      submissionId: submission.id,
      eventId: event.id,
    });
    try {
      deps.reportError?.(new Error("event_application_notify_no_recipients"), {
        tags: { useCase: "notifyEventApplicationReceived" },
        extra: { submissionId: submission.id, eventId: event.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // no-recipients no-op into a thrown error.
    }
    return;
  }

  for (const recipient of recipients) {
    try {
      await deps.notify({
        humanId: recipient.humanId,
        variant: APPLICATION_SUBMISSION_RECEIVED_VARIANT,
        idempotencyKey: `application-submission-received:${submission.id}:${recipient.humanId}`,
        payload: {
          eventId: event.id,
          eventTitle: event.title,
          submissionId: submission.id,
          applicantName,
          queueUrl: recipient.queueUrl,
        },
        scope: { kind: "EVENT", eventId: event.id },
        // In-app / email / push follow the recipient's preferences
        // (transactional defaults: all ON). SMS is out of scope for this
        // variant — disabled explicitly even though the renderer emits no
        // SMS payload. Auto-approved submissions additionally mute the
        // EMAIL leg (see muteOrganizerEmail) — nothing to review, in-app
        // and push keep the visibility.
        channels: {
          sms: { enabled: false },
          ...(args.muteOrganizerEmail ? { email: { enabled: false } } : {}),
        },
      });
    } catch (error) {
      logger?.error(
        "events.notify_application_received.recipient_failed",
        {
          submissionId: submission.id,
          eventId: event.id,
          humanId: recipient.humanId,
          err: error,
          error: describeError(error),
        },
      );
      try {
        deps.reportError?.(error, {
          tags: { useCase: "notifyEventApplicationReceived" },
          extra: {
            submissionId: submission.id,
            eventId: event.id,
            humanId: recipient.humanId,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // per-recipient swallow into a thrown error.
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Applicant acknowledgement (leg a)
// ─────────────────────────────────────────────────────────────────────────────

async function sendApplicantAck(
  deps: NotifyEventApplicationReceivedDeps,
  logger: LoggerPort | undefined,
  context: {
    event: NotifyEventApplicationReceivedArgs["event"];
    submission: EventApplicationSubmissionRecord;
    baseUrl: string;
  },
): Promise<void> {
  const { event, submission } = context;
  const guestEmail = submission.humanId ? null : submission.contactEmail;
  // Nobody to tell: a guest with no address, or no mailer bound.
  if (!submission.humanId && !(guestEmail && deps.mailer)) return;

  // Event page, zone and organizer contact for the template. Never throws
  // (a failed lookup costs the prop, not the email).
  const emailContext = await resolveApplicantEmailContext(
    { repos: deps.repos, logger, reportError: deps.reportError },
    {
      event,
      appBaseUrl: context.baseUrl,
      useCase: "notifyEventApplicationReceived",
    },
  );
  const appliedAtIso =
    submission.createdAt instanceof Date &&
    !Number.isNaN(submission.createdAt.getTime())
      ? submission.createdAt.toISOString()
      : undefined;

  // ── Signed-in applicant ─────────────────────────────────────────────────
  if (submission.humanId) {
    try {
      await deps.notify({
        humanId: submission.humanId,
        variant: APPLICATION_RECEIVED_VARIANT,
        idempotencyKey: `application-received:${submission.id}`,
        payload: {
          eventId: event.id,
          eventTitle: event.title,
          submissionId: submission.id,
          ...(emailContext.eventUrl ? { eventUrl: emailContext.eventUrl } : {}),
          ...(appliedAtIso ? { appliedAtIso } : {}),
          ...(emailContext.timezone ? { timezone: emailContext.timezone } : {}),
          ...(emailContext.organizerContactEmail
            ? { organizerContactEmail: emailContext.organizerContactEmail }
            : {}),
        },
        scope: { kind: "EVENT", eventId: event.id },
        channels: { sms: { enabled: false } },
      });
    } catch (error) {
      logger?.error("events.notify_application_received.ack_failed", {
        submissionId: submission.id,
        eventId: event.id,
        humanId: submission.humanId,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "notifyEventApplicationReceived",
            channel: "applicantAck",
          },
          extra: { submissionId: submission.id, eventId: event.id },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
    return;
  }

  // ── Guest applicant ─────────────────────────────────────────────────────
  // No humanId to key `notify` on: the same branded template straight
  // through the mailer (`isGuest` adds the "didn't apply?" line, since
  // anonymous submit only needs a Turnstile token). Best-effort: the
  // submission row is authoritative.
  if (!guestEmail) return;
  await sendApplicantGuestEmail(
    { mailer: deps.mailer, logger, reportError: deps.reportError },
    {
      to: guestEmail,
      content: applicationReceivedEmail({
        eventTitle: event.title,
        eventUrl: emailContext.eventUrl,
        appliedAtIso,
        timezone: emailContext.timezone,
        isGuest: true,
        organizerContactEmail: emailContext.organizerContactEmail,
      }),
      replyTo: emailContext.organizerContactEmail,
      logMessage: "events.notify_application_received.anon_ack_failed",
      useCase: "notifyEventApplicationReceived",
      channel: "anonAckEmail",
      extra: { submissionId: submission.id, eventId: event.id },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Trim trailing slashes so URL joins never emit `//admin/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Reviewer recipients: the owning human (personal events) or edit-role
 * members of the owning org, paged via `organizations.listMembers` and
 * deduped (mirrors notify-booking-request-received / notify-payout-completed).
 */
async function resolveRecipients(
  repos: NotifyEventApplicationReceivedDeps["repos"],
  event: NotifyEventApplicationReceivedArgs["event"],
  baseUrl: string,
): Promise<Recipient[]> {
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const queueUrl = (adminSlug: string) =>
    `${baseUrl}/admin/${adminSlug}/events/${event.id}/applications`;

  if (event.orgId) {
    const org = await repos.organizations.getById(event.orgId);
    // Org admin slug rule mirrors `toOrgAdminSlug` (web): slug, else raw id.
    const orgSlug = encodeURIComponent(org?.slug || event.orgId);
    const orgQueueUrl = queueUrl(orgSlug);

    const limit = 100;
    let offset = 0;
    let total = 0;
    do {
      const page = await repos.organizations.listMembers({
        orgId: event.orgId,
        limit,
        offset,
      });
      total = page.total;

      for (const member of page.items) {
        if (!NOTIFY_ORG_ROLES.has(member.role)) continue;
        if (seen.has(member.humanId)) continue;
        seen.add(member.humanId);
        recipients.push({ humanId: member.humanId, queueUrl: orgQueueUrl });
      }

      offset += page.items.length;
      if (page.items.length === 0) break;
    } while (offset < total);

    return recipients;
  }

  if (event.humanId) {
    const slug = await resolveHumanAdminSlug(repos, event.humanId);
    recipients.push({ humanId: event.humanId, queueUrl: queueUrl(slug) });
  }

  return recipients;
}

/**
 * Human admin slug — mirrors the web's `toHumanAdminSlug`
 * (apps/web/src/hooks/useEventOwnerEntities.ts): `@username`, else the
 * entity page's `@slug`, else `@humanId`. The admin layout treats `@x` and
 * `%40x` as equivalent, so encoding the tail is safe either way.
 */
async function resolveHumanAdminSlug(
  repos: NotifyEventApplicationReceivedDeps["repos"],
  humanId: string,
): Promise<string> {
  const withIdentity = await repos.humans.getByIdWithIdentity(humanId);
  const username = withIdentity?.identity.username ?? null;
  if (username) return `@${encodeURIComponent(username)}`;

  const page = await repos.entityPages.getByOwner("HUMAN", humanId);
  if (page?.slug) return `@${encodeURIComponent(page.slug)}`;

  return `@${humanId}`;
}

/**
 * Always-non-empty display name for the applicant (same template hazard as
 * notify-booking-request-received's actName — see APPLICANT_NAME_FALLBACK).
 */
async function resolveApplicantName(
  repos: NotifyEventApplicationReceivedDeps["repos"],
  submission: EventApplicationSubmissionRecord,
): Promise<string> {
  if (submission.humanId) {
    const [human] = await repos.humans.getByIds([submission.humanId]);
    if (human?.name && human.name.trim().length > 0) return human.name;
  }

  if (submission.contactEmail && submission.contactEmail.trim().length > 0) {
    return submission.contactEmail;
  }

  return APPLICANT_NAME_FALLBACK;
}

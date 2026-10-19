import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { describeError } from "../../../lib/io";
import { eventPublicUrl, normalizeAppBaseUrl } from "../../../lib/public-urls";
import { orgPageUrlFor } from "../../booking-requests/_shared/bill-items";
import { sanitizeSubject } from "../../comms/channels/send-email";
import type { ApplicationEmailContent } from "../../comms/application-renderers";

/**
 * Shared plumbing for the applicant emails of APPLICATION-gated events
 * (received / approved / rejected / waitlisted / back-in-review): the
 * context every template wants, and the guest-leg send with its swallow.
 */

const emailSchema = z.string().email();
const urlSchema = z.string().url();

export type ApplicantEmailEvent = Pick<
  EventRecord,
  "id" | "slug" | "orgId" | "timezone" | "startsAt" | "endsAt"
>;

/** Props derived from the event + its organizer. Absent ⇒ undefined. */
export type ApplicantEmailContext = {
  /** Public event page (`/events/<slug>`); slug-based, never the id. */
  eventUrl?: string;
  /** The event's IANA zone. */
  timezone?: string;
  startsAtIso?: string;
  endsAtIso?: string;
  /** The owning org's public contact email (validated). Org events only. */
  organizerContactEmail?: string;
  /** The owning org's PUBLIC page. Only when `includeOrganizerEventsUrl`. */
  organizerEventsUrl?: string;
};

export type ApplicantEmailContextDeps = {
  /**
   * Optional and post-commit (non-tx) reads. Without it the org-derived
   * props are simply omitted.
   */
  repos?: Partial<Pick<Repos, "organizations" | "entityPages">>;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Resolves the template context for one applicant email. Never throws: a
 * failed org/page lookup costs that prop, not the email (deliberate swallow,
 * logged at error AND reported per the ReporterPort convention). Every value
 * is validated against the same `.email()` / `.url()` rules the renderer and
 * ui-email schemas apply, because a value that fails THEIR parse sinks the
 * whole notice (renderer) or loses the email after its idempotency claim
 * (template).
 */
export async function resolveApplicantEmailContext(
  deps: ApplicantEmailContextDeps,
  args: {
    event: ApplicantEmailEvent;
    appBaseUrl: string | null | undefined;
    /** Tags the swallow-branch logs/Sentry reports. */
    useCase: string;
    includeOrganizerEventsUrl?: boolean;
  },
): Promise<ApplicantEmailContext> {
  const { event } = args;
  const context: ApplicantEmailContext = {};

  const eventUrl = eventPublicUrl({ baseUrl: args.appBaseUrl, slug: event.slug });
  if (eventUrl) context.eventUrl = eventUrl;
  if (event.timezone) context.timezone = event.timezone;
  if (isValidDate(event.startsAt)) context.startsAtIso = event.startsAt.toISOString();
  if (isValidDate(event.endsAt)) context.endsAtIso = event.endsAt.toISOString();

  if (!event.orgId) {
    // Personal (human-owned) events have no organizer contact or org page.
    return context;
  }
  const orgId = event.orgId;

  const swallow = (error: unknown, lookup: string) => {
    deps.logger?.error(`events.${args.useCase}.applicant_email_context_failed`, {
      eventId: event.id,
      lookup,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: args.useCase, channel: "applicantEmailContext" },
        extra: { eventId: event.id, lookup },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // swallow into a thrown error.
    }
  };

  if (deps.repos?.organizations) {
    try {
      const org = await deps.repos.organizations.getById(orgId);
      const contact = org?.contactEmail?.trim();
      if (contact && emailSchema.safeParse(contact).success) {
        context.organizerContactEmail = contact;
      }
    } catch (error) {
      swallow(error, "organization");
    }
  }

  if (args.includeOrganizerEventsUrl && deps.repos?.entityPages) {
    const base = normalizeAppBaseUrl(args.appBaseUrl);
    if (base) {
      try {
        const page = await deps.repos.entityPages.getByOwner(
          "ORGANIZATION",
          orgId,
        );
        // Only a PUBLIC page is somewhere to send a stranger.
        const path =
          page && page.visibility === "PUBLIC"
            ? orgPageUrlFor(page.slug ?? null)
            : null;
        const url = path ? `${base}${path}` : null;
        if (url && urlSchema.safeParse(url).success) {
          context.organizerEventsUrl = url;
        }
      } catch (error) {
        swallow(error, "organizerPage");
      }
    }
  }

  return context;
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Guest-leg send: the same subject / plain text / template the signed-in
 * notify() path sends, straight through the mailer (no humanId to key notify
 * on). Deliberate swallow — the status row is authoritative — logged at error
 * AND reported; a throwing reporter changes nothing.
 */
export async function sendApplicantGuestEmail(
  deps: {
    mailer?: MailerPort;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  args: {
    to: string;
    content: ApplicationEmailContent;
    replyTo?: string;
    idempotencyKey?: string;
    /** Log message for the failure branch. */
    logMessage: string;
    useCase: string;
    channel: string;
    extra: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.mailer) return;
  try {
    await deps.mailer.send({
      to: { to: args.to },
      // This path skips notify()'s sendEmail, so apply its header-injection
      // sanitizer here too.
      subject: sanitizeSubject(args.content.subject),
      text: args.content.text,
      template: args.content.template,
      ...(args.replyTo ? { replyTo: { to: args.replyTo } } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    });
  } catch (error) {
    deps.logger?.error(args.logMessage, {
      ...args.extra,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: args.useCase, channel: args.channel },
        extra: args.extra,
      });
    } catch {
      // Reporting is best-effort.
    }
  }
}

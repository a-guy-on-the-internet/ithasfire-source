import { z } from "zod";

import type { NotificationAction } from "@th/ports/repos/notifications";

import { resolveTimeZone } from "../../lib/venue-local-time";
import type { NotificationCategory } from "./categories";
import { COMMON_COPY } from "./copy/common";
import {
  APPLICATION_APPROVED_COPY,
  APPLICATION_BACK_IN_REVIEW_COPY,
  APPLICATION_RECEIVED_COPY,
  APPLICATION_REJECTED_COPY,
  APPLICATION_WAITLISTED_COPY,
  applicationRejectedBody,
} from "./copy/applications";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// Applicant emails for APPLICATION-gated events (owner decisions 2026-09-30).
//
// One source for the applicant-facing copy and the ui-email template refs, used
// by TWO delivery paths:
//  - signed-in applicants → notify() → the renderers below (registered in
//    `renderers.ts`'s registry);
//  - guest applicants (no humanId, just a contact email) → the use cases call
//    the `*Email` builders directly and hand the result to `mailer.send`.
// Both paths therefore send the same subject, plain text and template, and a
// copy change lands in both at once.
//
// In-app text is written in the reader's language (copy/applications.ts);
// the EMAIL builders below stay English (`.en` of the same copy), so guest and
// signed-in emails never diverge from each other.
//
// Template VARIABLES omit absent values instead of sending null: the ui-email
// prop schemas type the new fields as optional, and `.optional()` alone
// rejects null. A prop the template rejects fails inside the mail adapter
// AFTER it claims its idempotency key, so that email is lost; omitting is
// the safe direction.
//
// Copy is the owner's (direct, no hedging). The guest copy must never claim
// the guest lost access: anonymous unlock cookies can't be revoked
// server-side.
// ─────────────────────────────────────────────────────────────────────────────

type Tags = string[];
type Metadata = Record<string, string>;

type ApplicationRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

export const APPLICATION_RECEIVED_VARIANT = "event.application-received" as const;
export const APPLICATION_APPROVED_VARIANT = "event.application-approved" as const;
export const APPLICATION_REJECTED_VARIANT = "event.application-rejected" as const;
export const APPLICATION_WAITLISTED_VARIANT =
  "event.application-waitlisted" as const;
export const APPLICATION_BACK_IN_REVIEW_VARIANT =
  "event.application-back-in-review" as const;

export const APPLICATION_RECEIVED_TEMPLATE = "event.application_received";
export const APPLICATION_APPROVED_TEMPLATE = "event.application_approved";
export const APPLICATION_REJECTED_TEMPLATE = "event.application_rejected";
export const APPLICATION_WAITLISTED_TEMPLATE = "event.application_waitlisted";
export const APPLICATION_BACK_IN_REVIEW_TEMPLATE =
  "event.application_back_in_review";

/** Subject + plain text + template ref for ONE applicant email. */
export type ApplicationEmailContent = {
  /** In-app title; also the email subject. */
  title: string;
  /** In-app body (the first paragraph of the plain text). */
  body: string;
  subject: string;
  text: string;
  template: { key: string; variables: Record<string, unknown> };
};

type Optional<T> = T | null | undefined;

/** Drops null/undefined entries so absent props are OMITTED, never null. */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * "Oct 4, 2026, 5:00 PM CDT" in the EVENT's timezone, falling back to the
 * platform default (`resolveTimeZone`) when the zone is missing or unknown,
 * never UTC: UTC is the server's zone and put an evening deadline on the next
 * day. resolveTimeZone validates the id, so formatting cannot throw on it.
 * Null for an unparseable instant so the line is dropped, not "Invalid Date".
 */
function formatInZone(
  iso: string,
  timezone: Optional<string>,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: resolveTimeZone(timezone),
    })
      .format(date)
      // Some ICU builds put a narrow no-break space before AM/PM; plain text
      // wants an ordinary space.
      .replace(/[  ]/g, " ")
  );
}

/**
 * The in-app "View event" route for an absolute public event URL (path +
 * query + hash), or null. Mirrors `eventRouteAction` in renderers.ts, which
 * can't be imported here without a value-level import cycle.
 */
function eventRouteAction(
  eventUrl: Optional<string>,
  label = "View event",
): NotificationAction | null {
  if (!eventUrl) return null;
  try {
    const url = new URL(eventUrl);
    return { label, route: `${url.pathname}${url.search}${url.hash}` };
  } catch {
    return null;
  }
}

/**
 * Closing plain-text line when the organizer has a contact address: Reply-To
 * is set to it, so a reply reaches them. Mirrors the templates' footer.
 */
function withOrganizerContactLine(
  lines: string[],
  organizerContactEmail: Optional<string>,
): string[] {
  if (organizerContactEmail) {
    lines.push("Questions? Reply to this email to reach the organizer.");
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email builders (shared by the renderers and the guest legs)
// ─────────────────────────────────────────────────────────────────────────────

export type ApplicationReceivedEmailInput = {
  eventTitle: string;
  eventUrl?: Optional<string>;
  appliedAtIso?: Optional<string>;
  timezone?: Optional<string>;
  /** Guest leg only: anonymous submit needs just a Turnstile token. */
  isGuest?: boolean;
  organizerContactEmail?: Optional<string>;
};

export function applicationReceivedEmail(
  input: ApplicationReceivedEmailInput,
): ApplicationEmailContent {
  const title = APPLICATION_RECEIVED_COPY.en.title(input);
  const body = APPLICATION_RECEIVED_COPY.en.body;
  const lines = [body];
  if (input.eventUrl) lines.push(`Event page: ${input.eventUrl}`);
  if (input.isGuest) {
    // Someone else can type YOUR address into an anonymous form. Say so
    // plainly so an unexpected email doesn't read as "an account was made".
    // Must not claim the address stays private: organizers see a guest's
    // contact email in their "New application" email and the review queue.
    lines.push(
      "Didn't apply? Ignore this email. Someone may have typed your address by mistake. No account was created.",
    );
  }
  withOrganizerContactLine(lines, input.organizerContactEmail);
  return {
    title,
    body,
    subject: title,
    text: lines.join("\n\n"),
    template: {
      key: APPLICATION_RECEIVED_TEMPLATE,
      variables: compact({
        eventTitle: input.eventTitle,
        eventUrl: input.eventUrl,
        appliedAtISO: input.appliedAtIso,
        // The zone the text part reads in, so the HTML shows the same clock.
        timezone: resolveTimeZone(input.timezone),
        isGuest: input.isGuest ? true : undefined,
        organizerContactEmail: input.organizerContactEmail,
      }),
    },
  };
}

export type ApplicationApprovedEmailInput = {
  eventTitle: string;
  /** The claim link (`/api/events/{id}/claim?token=`). */
  approvalUrl?: Optional<string>;
  eventUrl?: Optional<string>;
  expiresAtIso?: Optional<string>;
  startsAtIso?: Optional<string>;
  endsAtIso?: Optional<string>;
  timezone?: Optional<string>;
  organizerContactEmail?: Optional<string>;
};

export function applicationApprovedEmail(
  input: ApplicationApprovedEmailInput,
): ApplicationEmailContent {
  const title = APPLICATION_APPROVED_COPY.en.title(input);
  const body = APPLICATION_APPROVED_COPY.en.body;
  const lines = [body];
  // The claim link opens the page for guests (it sets the unlock cookie) and
  // also works for signed-in applicants; the plain event page is the fallback.
  const link = input.approvalUrl ?? input.eventUrl;
  if (link) lines.push(`Open the event: ${link}`);
  if (input.approvalUrl && input.expiresAtIso) {
    const expires = formatInZone(input.expiresAtIso, input.timezone);
    if (expires) lines.push(`This link works until ${expires}.`);
  }
  withOrganizerContactLine(lines, input.organizerContactEmail);
  return {
    title,
    body,
    subject: title,
    text: lines.join("\n\n"),
    template: {
      key: APPLICATION_APPROVED_TEMPLATE,
      variables: compact({
        eventTitle: input.eventTitle,
        approvalUrl: input.approvalUrl,
        eventUrl: input.eventUrl,
        expiresAtISO: input.expiresAtIso,
        startsAtISO: input.startsAtIso,
        endsAtISO: input.endsAtIso,
        // The zone the text part reads in, so the HTML shows the same clock.
        timezone: resolveTimeZone(input.timezone),
        // calendarUrl stays unset until its page exists.
        organizerContactEmail: input.organizerContactEmail,
      }),
    },
  };
}

export type ApplicationRejectedEmailInput = {
  eventTitle: string;
  decisionReason?: Optional<string>;
  /** The organizing org's PUBLIC page, when it has one. */
  organizerEventsUrl?: Optional<string>;
  organizerContactEmail?: Optional<string>;
};

export function applicationRejectedEmail(
  input: ApplicationRejectedEmailInput,
): ApplicationEmailContent {
  const copy = APPLICATION_REJECTED_COPY.en;
  const title = copy.title(input);
  const lead = copy.lead;
  const reasonLine = input.decisionReason
    ? copy.note(input.decisionReason)
    : null;
  const body = applicationRejectedBody(copy, input.decisionReason);
  const lines = [lead];
  if (reasonLine) lines.push(reasonLine);
  if (input.organizerEventsUrl) {
    lines.push(`Other events from this organizer: ${input.organizerEventsUrl}`);
  }
  withOrganizerContactLine(lines, input.organizerContactEmail);
  return {
    title,
    body,
    subject: title,
    text: lines.join("\n\n"),
    template: {
      key: APPLICATION_REJECTED_TEMPLATE,
      variables: compact({
        eventTitle: input.eventTitle,
        decisionReason: input.decisionReason,
        organizerEventsUrl: input.organizerEventsUrl,
        organizerContactEmail: input.organizerContactEmail,
      }),
    },
  };
}

export type ApplicationWaitlistedEmailInput = {
  eventTitle: string;
  eventUrl?: Optional<string>;
  /**
   * Guest leg only: the event page can't show an anonymous viewer their
   * application status, so the template hides its status link.
   */
  isGuest?: boolean;
  organizerContactEmail?: Optional<string>;
};

export function applicationWaitlistedEmail(
  input: ApplicationWaitlistedEmailInput,
): ApplicationEmailContent {
  const title = APPLICATION_WAITLISTED_COPY.en.title(input);
  const body = APPLICATION_WAITLISTED_COPY.en.body;
  const lines = [body];
  if (input.eventUrl) lines.push(`Event page: ${input.eventUrl}`);
  withOrganizerContactLine(lines, input.organizerContactEmail);
  return {
    title,
    body,
    subject: title,
    text: lines.join("\n\n"),
    template: {
      key: APPLICATION_WAITLISTED_TEMPLATE,
      variables: compact({
        eventTitle: input.eventTitle,
        eventUrl: input.eventUrl,
        isGuest: input.isGuest ? true : undefined,
        organizerContactEmail: input.organizerContactEmail,
      }),
    },
  };
}

export type ApplicationBackInReviewEmailInput = {
  eventTitle: string;
  eventUrl?: Optional<string>;
  /**
   * Guest leg only: the event page can't show an anonymous viewer their
   * application status, so the template hides its status link.
   */
  isGuest?: boolean;
  organizerContactEmail?: Optional<string>;
};

export function applicationBackInReviewEmail(
  input: ApplicationBackInReviewEmailInput,
): ApplicationEmailContent {
  const title = APPLICATION_BACK_IN_REVIEW_COPY.en.title(input);
  // Deliberately silent on access (see copy/applications.ts).
  const body = APPLICATION_BACK_IN_REVIEW_COPY.en.body;
  const lines = [body];
  if (input.eventUrl) lines.push(`Event page: ${input.eventUrl}`);
  withOrganizerContactLine(lines, input.organizerContactEmail);
  return {
    title,
    body,
    subject: title,
    text: lines.join("\n\n"),
    template: {
      key: APPLICATION_BACK_IN_REVIEW_TEMPLATE,
      variables: compact({
        eventTitle: input.eventTitle,
        eventUrl: input.eventUrl,
        isGuest: input.isGuest ? true : undefined,
        organizerContactEmail: input.organizerContactEmail,
      }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared schema fragments
// ─────────────────────────────────────────────────────────────────────────────

// Titles are capped at 140 chars at input; 200 is deliberate slack.
const eventTitleSchema = z.string().min(1).max(200);
const optionalUrl = z.string().url().nullable().optional();
const optionalIso = z.string().datetime({ offset: true }).nullable().optional();
const optionalTimezone = z.string().min(1).max(64).nullable().optional();
/** Organizer contact email — populates Reply-To and the template footer. */
const optionalContactEmail = z.string().email().nullable().optional();

function replyToOf(email: Optional<string>) {
  return email ? { to: email } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers (signed-in applicants, via notify())
// ─────────────────────────────────────────────────────────────────────────────

const eventApplicationReceivedSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: eventTitleSchema,
    submissionId: z.string().uuid(),
    eventUrl: optionalUrl,
    appliedAtIso: optionalIso,
    timezone: optionalTimezone,
    organizerContactEmail: optionalContactEmail,
  })
  .strict();

/**
 * Applicant acknowledgement: the application is in. Sent post-commit by
 * submitEventApplication via notify-event-application-received.
 */
export const eventApplicationReceivedRenderer: ApplicationRendererDefinition<
  typeof eventApplicationReceivedSchema
> = {
  variant: APPLICATION_RECEIVED_VARIANT,
  category: "transactional",
  schema: eventApplicationReceivedSchema,
  render(input, ctx) {
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };
    const tags: Tags = ["event", "application", "received"];
    const email = applicationReceivedEmail(input);
    const copy = APPLICATION_RECEIVED_COPY[ctx.locale];

    return {
      category: "transactional",
      fingerprint: {
        variant: APPLICATION_RECEIVED_VARIANT,
        eventId: input.eventId,
        submissionId: input.submissionId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body,
        kind: "INFO",
        action: eventRouteAction(input.eventUrl, COMMON_COPY[ctx.locale].viewEvent),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: email.subject,
        text: email.text,
        template: email.template,
        replyTo: replyToOf(input.organizerContactEmail),
        tags,
        metadata,
      },
    };
  },
};

const eventApplicationApprovedSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: eventTitleSchema,
    submissionId: z.string().uuid(),
    approvalToken: z.string().min(1),
    approvalUrl: z.string().url().optional(),
    expiresAtIso: optionalIso,
    eventUrl: optionalUrl,
    startsAtIso: optionalIso,
    endsAtIso: optionalIso,
    timezone: optionalTimezone,
    organizerContactEmail: optionalContactEmail,
  })
  .strict();

/**
 * Approval. ALWAYS carries the template (owner decision 5): without a claim
 * link the template still renders, pointing at the event page when there is
 * one.
 */
export const eventApplicationApprovedRenderer: ApplicationRendererDefinition<
  typeof eventApplicationApprovedSchema
> = {
  variant: APPLICATION_APPROVED_VARIANT,
  category: "transactional",
  schema: eventApplicationApprovedSchema,
  render(input, ctx) {
    const expiresAt = input.expiresAtIso ? new Date(input.expiresAtIso) : null;
    // The approval token / claim URL is a BEARER SECRET: it stays out of
    // metadata, which the mail adapter forwards to the ESP as tags/headers
    // (and which the in-app row would persist for no reader; no UI consumes
    // it). The fingerprint below still carries it to key the notice.
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };
    if (input.expiresAtIso) metadata.expiresAtIso = input.expiresAtIso;

    const tags: Tags = ["event", "application", "approval"];
    const email = applicationApprovedEmail(input);
    const copy = APPLICATION_APPROVED_COPY[ctx.locale];
    // Signed-in applicants already hold a durable unlock, so the in-app
    // button goes to the event page (never expires). No claim-link fallback:
    // the in-app row is persisted, and the claim URL is a bearer secret.
    const action: NotificationAction | null = eventRouteAction(
      input.eventUrl,
      COMMON_COPY[ctx.locale].viewEvent,
    );

    return {
      category: "transactional",
      fingerprint: {
        variant: APPLICATION_APPROVED_VARIANT,
        eventId: input.eventId,
        submissionId: input.submissionId,
        approvalToken: input.approvalToken,
        approvalUrl: input.approvalUrl ?? null,
        expiresAtIso: input.expiresAtIso ?? null,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body,
        kind: "SUCCESS",
        action,
        expiresAt,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: email.subject,
        text: email.text,
        template: email.template,
        replyTo: replyToOf(input.organizerContactEmail),
        tags,
        metadata,
      },
    };
  },
};

const eventApplicationRejectedSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: eventTitleSchema,
    submissionId: z.string().uuid(),
    /** Reviewer's note — input-capped at 500; slack for edge rows. */
    decisionReason: z.string().min(1).max(1000).nullable().optional(),
    organizerEventsUrl: optionalUrl,
    organizerContactEmail: optionalContactEmail,
  })
  .strict();

/** Rejection, with the reviewer's note when there is one. */
export const eventApplicationRejectedRenderer: ApplicationRendererDefinition<
  typeof eventApplicationRejectedSchema
> = {
  variant: APPLICATION_REJECTED_VARIANT,
  category: "transactional",
  schema: eventApplicationRejectedSchema,
  render(input, ctx) {
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };
    const tags: Tags = ["event", "application", "decision"];
    const email = applicationRejectedEmail(input);
    const copy = APPLICATION_REJECTED_COPY[ctx.locale];

    return {
      category: "transactional",
      fingerprint: {
        variant: APPLICATION_REJECTED_VARIANT,
        eventId: input.eventId,
        submissionId: input.submissionId,
      },
      inApp: {
        title: copy.title(input),
        body: applicationRejectedBody(copy, input.decisionReason),
        kind: "INFO",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: email.subject,
        text: email.text,
        template: email.template,
        replyTo: replyToOf(input.organizerContactEmail),
        tags,
        metadata,
      },
    };
  },
};

const eventApplicationWaitlistedSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: eventTitleSchema,
    submissionId: z.string().uuid(),
    eventUrl: optionalUrl,
    organizerContactEmail: optionalContactEmail,
  })
  .strict();

/** WAITLISTED decision. No reason, no promises beyond the email. */
export const eventApplicationWaitlistedRenderer: ApplicationRendererDefinition<
  typeof eventApplicationWaitlistedSchema
> = {
  variant: APPLICATION_WAITLISTED_VARIANT,
  category: "transactional",
  schema: eventApplicationWaitlistedSchema,
  render(input, ctx) {
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };
    const tags: Tags = ["event", "application", "decision"];
    const email = applicationWaitlistedEmail(input);
    const copy = APPLICATION_WAITLISTED_COPY[ctx.locale];

    return {
      category: "transactional",
      fingerprint: {
        variant: APPLICATION_WAITLISTED_VARIANT,
        eventId: input.eventId,
        submissionId: input.submissionId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body,
        kind: "INFO",
        action: eventRouteAction(input.eventUrl, COMMON_COPY[ctx.locale].viewEvent),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: email.subject,
        text: email.text,
        template: email.template,
        replyTo: replyToOf(input.organizerContactEmail),
        tags,
        metadata,
      },
    };
  },
};

const eventApplicationBackInReviewSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: eventTitleSchema,
    submissionId: z.string().uuid(),
    eventUrl: optionalUrl,
    organizerContactEmail: optionalContactEmail,
  })
  .strict();

/**
 * An organizer rescinded an APPROVED decision; the application is PENDING
 * again. Sent post-commit by rescindEventApplicationDecision. (Rescinding a
 * REJECTED / WAITLISTED decision sends nothing — owner deferred that.)
 */
export const eventApplicationBackInReviewRenderer: ApplicationRendererDefinition<
  typeof eventApplicationBackInReviewSchema
> = {
  variant: APPLICATION_BACK_IN_REVIEW_VARIANT,
  category: "transactional",
  schema: eventApplicationBackInReviewSchema,
  render(input, ctx) {
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };
    const tags: Tags = ["event", "application", "decision"];
    const email = applicationBackInReviewEmail(input);
    const copy = APPLICATION_BACK_IN_REVIEW_COPY[ctx.locale];

    return {
      category: "transactional",
      fingerprint: {
        variant: APPLICATION_BACK_IN_REVIEW_VARIANT,
        eventId: input.eventId,
        submissionId: input.submissionId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body,
        kind: "INFO",
        action: eventRouteAction(input.eventUrl, COMMON_COPY[ctx.locale].viewEvent),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: email.subject,
        text: email.text,
        template: email.template,
        replyTo: replyToOf(input.organizerContactEmail),
        tags,
        metadata,
      },
    };
  },
};

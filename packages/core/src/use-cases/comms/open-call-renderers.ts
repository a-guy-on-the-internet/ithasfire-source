import { z } from "zod";

import { clipUtf16WithEllipsis } from "../../lib/clip-utf16";
import type { NotificationCategory } from "./categories";
import { formatEventStart } from "./copy/common";
import { OPEN_CALL_NOTICES_COPY, openCallPayText } from "./copy/open-calls";
import { formatLineupFullWhen, formatLineupShortDateTime } from "./lineup-renderers";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// Open-call notices (spec 2026-10-05, step 7). Registered in `renderers.ts`'s
// registry; the producer is events/open-calls/notify-open-call-notices.ts.
//
// Signed-in recipients get these through notify() (in-app + email + push).
// The in-app text re-renders in the reader's language at read time (the
// variants are in LOCALIZED_VARIANTS). The email is built by the
// `build*Email` functions below from the same copy: notify() renders "en"
// (the stored text, like every other variant today), and a GUEST's email,
// which goes straight to the mailer, is built in the guest's locale
// (`resolveGuestNoticeLocale` in the producer).
//
// NO TOKEN EVER GOES THROUGH notify() (NFR-001): notify() stores its payload
// and the rendered action route. A signed-in recipient's links are the
// applicant hub / their lineups / the organizer queue. Only a GUEST's email
// carries the status link (`/call/<publicId>/application/<token>`), built at
// send time and handed straight to the mailer (audience "guest" below).
//
// Every email uses ONE layout template, `open_call.notice` in
// packages/ui-email, whose props are the already-written strings
// ({@link OpenCallEmailContent}). The copy lives here, never in the template,
// so a Spanish email needs nothing from @th/locale.
//
// STORED PAYLOADS ARE A CONTRACT (see `renderNotification`): add fields as
// optional, never tighten or rename.
// ─────────────────────────────────────────────────────────────────────────────

export const OPEN_CALL_PICKED_VARIANT = "open-call.picked" as const;
export const OPEN_CALL_NOT_THIS_TIME_VARIANT = "open-call.not-this-time" as const;
export const OPEN_CALL_PULLED_VARIANT = "open-call.pulled" as const;
export const OPEN_CALL_MESSAGE_VARIANT = "open-call.message-received" as const;
export const OPEN_CALL_DROPPED_OUT_VARIANT = "open-call.dropped-out" as const;
export const OPEN_CALL_RECEIVED_VARIANT = "open-call.application-received" as const;

/** The ui-email layout every open-call email uses. */
export const OPEN_CALL_EMAIL_TEMPLATE_KEY = "open_call.notice" as const;

/** Most dates listed before "+N more" (a series pick can hold many). */
const MAX_LISTED_DATES = 6;
/** Message preview clip, like booking.message-received. */
export const OPEN_CALL_MESSAGE_PREVIEW_MAX = 240;

type Tags = string[];
type Metadata = Record<string, string>;

type OpenCallRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

// ── Email content (the props of ui-email's `open_call.notice`) ───────────────

export type OpenCallEmailLink = { label: string; url: string };

/**
 * Everything the email says, already written in one locale. Mirrors the
 * ui-email `open_call.notice` schema; keep the two in step.
 */
export type OpenCallEmailContent = {
  locale: NotificationLocale;
  subject: string;
  heading: string;
  rows: Array<{ label: string; value: string }>;
  paragraphs: string[];
  /** Quoted free text (the organizer's note, a message), verbatim. */
  quote: { label: string; text: string } | null;
  /** The button. */
  action: OpenCallEmailLink | null;
  /** Plain links under the button ("Drop out", "Make a page"). */
  links: OpenCallEmailLink[];
  footer: string;
};

/** The plain-text part of an open-call email (same content as the HTML). */
export function openCallEmailText(content: OpenCallEmailContent): string {
  const parts: string[] = [content.heading];
  if (content.rows.length > 0) {
    parts.push(content.rows.map((r) => `${r.label}: ${r.value}`).join("\n"));
  }
  parts.push(...content.paragraphs);
  if (content.quote) parts.push(`${content.quote.label}:\n${content.quote.text}`);
  if (content.action) parts.push(`${content.action.label}: ${content.action.url}`);
  for (const link of content.links) parts.push(`${link.label}: ${link.url}`);
  parts.push(content.footer);
  return parts.join("\n\n");
}

function emailPayload(
  content: OpenCallEmailContent,
  tags: Tags,
  metadata: Metadata,
): NonNullable<RenderNotificationResult["email"]> {
  return {
    subject: content.subject,
    text: openCallEmailText(content),
    template: { key: OPEN_CALL_EMAIL_TEMPLATE_KEY, variables: content },
    replyTo: null,
    tags,
    metadata,
  };
}

// ── Shared schema pieces ─────────────────────────────────────────────────────

/** http(s) only: these become hrefs in the email and the inbox. */
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "http(s) URL required");

const callTitle = z.string().min(1).max(300);
const name = z.string().min(1).max(200).nullable();
const noticeDate = z
  .object({
    startsAtIso: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).nullable(),
  })
  .strict();
const payKind = z.enum([
  "FIXED",
  "DOOR_SPLIT",
  "TICKET_SHARE",
  "TICKET_QUOTA",
  "UNPAID",
  "DISCUSSED_AFTER",
]);

type NoticeDate = z.infer<typeof noticeDate>;

/** Path + query of an absolute URL, for in-app routes. Null if unparseable. */
function pathOf(absoluteUrl: string): string | null {
  try {
    const url = new URL(absoluteUrl);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function inAppAction(label: string, url: string) {
  const route = pathOf(url);
  return route ? { label, route } : null;
}

const MORE_DATES: { readonly [L in NotificationLocale]: (n: number) => string } = {
  en: (n) => `+${n} more`,
  es: (n) => `y ${n} más`,
};

/** "Sat, Oct 4, 5:00 PM; Sat, Oct 11, 5:00 PM" in the render locale; null = none. */
function shortDates(locale: NotificationLocale, dates: readonly NoticeDate[]): string | null {
  const format = (d: NoticeDate) =>
    locale === "en"
      ? formatLineupShortDateTime(d.startsAtIso, d.timezone)
      : formatEventStart(locale, d.startsAtIso, d.timezone);
  return listDates(locale, dates, format);
}

/** The email's When row: full dates (English names the zone's city). */
function fullDates(locale: NotificationLocale, dates: readonly NoticeDate[]): string | null {
  const format = (d: NoticeDate) =>
    locale === "en"
      ? formatLineupFullWhen(d.startsAtIso, d.timezone)
      : formatEventStart(locale, d.startsAtIso, d.timezone);
  return listDates(locale, dates, format);
}

function listDates(
  locale: NotificationLocale,
  dates: readonly NoticeDate[],
  format: (d: NoticeDate) => string | null,
): string | null {
  const formatted = dates.map(format).filter((d): d is string => Boolean(d));
  if (formatted.length === 0) return null;
  const shown = formatted.slice(0, MAX_LISTED_DATES).join("; ");
  const rest = formatted.length - MAX_LISTED_DATES;
  return rest > 0 ? `${shown} ${MORE_DATES[locale](rest)}` : shown;
}

/**
 * Clip a message body for a preview. Measured in UTF-16 units, like the
 * payload schema's `.max()`, without splitting a surrogate pair, so a long
 * message full of emoji still renders.
 */
export function clipOpenCallMessagePreview(body: string): string {
  return clipUtf16WithEllipsis(body.trim(), OPEN_CALL_MESSAGE_PREVIEW_MAX);
}

/**
 * Who an email is built for. "signed_in": rendered through notify() (stored;
 * hub links only). "guest": sent straight to the mailer, with the status
 * link and its one-tap Drop out.
 */
export type OpenCallEmailAudience = "signed_in" | "guest";

// ── open-call.picked (FR-017) ────────────────────────────────────────────────

export const openCallPickedPayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    callTitle,
    /** The organisation, when the reader is one of its members; else null. */
    actName: name,
    firstPick: z.boolean(),
    /** The dates this pick puts the act on (all of them on a first pick). */
    dates: z.array(noticeDate).max(100),
    payKind: payKind.nullable(),
    payDetails: z.string().max(500).nullable(),
    /** Their application: the hub (signed in) or, in a guest email, the status page. */
    actionUrl: httpUrl,
    /** Where to drop out: their lineups / the hub, or a guest's status page; null = none. */
    dropOutUrl: httpUrl.nullable(),
    /** Guests only (Q34): make a page and this application moves to it. */
    makePageUrl: httpUrl.nullable(),
  })
  .strict();
export type OpenCallPickedPayload = z.infer<typeof openCallPickedPayloadSchema>;

export function buildOpenCallPickedEmail(
  input: OpenCallPickedPayload,
  locale: NotificationLocale,
  audience: OpenCallEmailAudience = "signed_in",
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  const when = fullDates(locale, input.dates);
  const paragraphs = [copy.picked.lead(input), copy.picked.noContract];
  if (input.dropOutUrl) {
    paragraphs.push(audience === "guest" ? copy.picked.dropOutOneTap : copy.picked.dropOutFromPage);
  }
  if (input.makePageUrl) paragraphs.push(copy.picked.makePageInvite);
  const links: OpenCallEmailLink[] = [];
  if (input.dropOutUrl) links.push({ label: copy.common.dropOut, url: input.dropOutUrl });
  if (input.makePageUrl) links.push({ label: copy.common.makePage, url: input.makePageUrl });
  return {
    locale,
    subject: copy.picked.title(input),
    heading: copy.picked.heading(input),
    rows: [
      { label: copy.common.rowEvent, value: input.callTitle },
      ...(when ? [{ label: copy.common.rowWhen, value: when }] : []),
      {
        label: copy.common.rowPay,
        value: openCallPayText(locale, input.payKind, input.payDetails),
      },
    ],
    paragraphs,
    quote: null,
    action: { label: copy.common.openApplication, url: input.actionUrl },
    links,
    footer: copy.common.applicantFooter,
  };
}

export const openCallPickedRenderer: OpenCallRendererDefinition<
  typeof openCallPickedPayloadSchema
> = {
  variant: OPEN_CALL_PICKED_VARIANT,
  category: "transactional",
  schema: openCallPickedPayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "picked"];
    const metadata: Metadata = { submissionId: input.submissionId, formId: input.formId };
    const email = buildOpenCallPickedEmail(input, "en");
    const body = (locale: NotificationLocale) =>
      OPEN_CALL_NOTICES_COPY[locale].picked.body({
        dates: shortDates(locale, input.dates),
        payLine: OPEN_CALL_NOTICES_COPY[locale].common.payLine(
          openCallPayText(locale, input.payKind, input.payDetails),
        ),
      });
    return {
      category: "transactional",
      fingerprint: {
        variant: OPEN_CALL_PICKED_VARIANT,
        submissionId: input.submissionId,
        firstPick: input.firstPick,
        dates: input.dates.map((d) => d.startsAtIso),
      },
      inApp: {
        title: copy.picked.title(input),
        body: body(ctx.locale),
        kind: "SUCCESS",
        action: inAppAction(copy.common.openApplication, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: email.subject,
        body: body("en"),
        collapseKey: `open-call-picked-${input.submissionId}`,
        data: { submissionId: input.submissionId, url: input.actionUrl },
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── open-call.not-this-time (FR-018, FR-020, FR-021) ─────────────────────────

export const openCallNotThisTimePayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    callTitle,
    actName: name,
    /** The organizer's note, verbatim; null = the standard reply. */
    note: z.string().max(500).nullable(),
    actionUrl: httpUrl,
  })
  .strict();
export type OpenCallNotThisTimePayload = z.infer<typeof openCallNotThisTimePayloadSchema>;

export function buildOpenCallNotThisTimeEmail(
  input: OpenCallNotThisTimePayload,
  locale: NotificationLocale,
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: copy.notThisTime.title(input),
    heading: copy.notThisTime.title(input),
    rows: [],
    paragraphs: [copy.notThisTime.lead(input), copy.notThisTime.after],
    quote: input.note ? { label: copy.notThisTime.noteLabel, text: input.note } : null,
    action: { label: copy.common.openApplication, url: input.actionUrl },
    links: [],
    footer: copy.common.applicantFooter,
  };
}

export const openCallNotThisTimeRenderer: OpenCallRendererDefinition<
  typeof openCallNotThisTimePayloadSchema
> = {
  variant: OPEN_CALL_NOT_THIS_TIME_VARIANT,
  category: "transactional",
  schema: openCallNotThisTimePayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "not-this-time"];
    const metadata: Metadata = { submissionId: input.submissionId, formId: input.formId };
    const body = (locale: NotificationLocale) => {
      const c = OPEN_CALL_NOTICES_COPY[locale].notThisTime;
      return input.note ? `${c.lead(input)} ${c.note(input.note)}` : c.lead(input);
    };
    const email = buildOpenCallNotThisTimeEmail(input, "en");
    return {
      category: "transactional",
      fingerprint: { variant: OPEN_CALL_NOT_THIS_TIME_VARIANT, submissionId: input.submissionId },
      inApp: {
        title: copy.notThisTime.title(input),
        body: body(ctx.locale),
        kind: "INFO",
        action: inAppAction(copy.common.openApplication, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: email.subject,
        body: body("en"),
        collapseKey: `open-call-decision-${input.submissionId}`,
        data: { submissionId: input.submissionId, url: input.actionUrl },
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── open-call.pulled (FR-022) ────────────────────────────────────────────────

export const openCallPulledPayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    callTitle,
    actionUrl: httpUrl,
  })
  .strict();
export type OpenCallPulledPayload = z.infer<typeof openCallPulledPayloadSchema>;

export function buildOpenCallPulledEmail(
  input: OpenCallPulledPayload,
  locale: NotificationLocale,
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: copy.pulled.title(input),
    heading: copy.pulled.title(input),
    rows: [],
    paragraphs: [copy.pulled.body, copy.pulled.after],
    quote: null,
    action: { label: copy.common.openApplication, url: input.actionUrl },
    links: [],
    footer: copy.common.applicantFooter,
  };
}

export const openCallPulledRenderer: OpenCallRendererDefinition<
  typeof openCallPulledPayloadSchema
> = {
  variant: OPEN_CALL_PULLED_VARIANT,
  category: "transactional",
  schema: openCallPulledPayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "pulled"];
    const metadata: Metadata = { submissionId: input.submissionId, formId: input.formId };
    const email = buildOpenCallPulledEmail(input, "en");
    return {
      category: "transactional",
      fingerprint: { variant: OPEN_CALL_PULLED_VARIANT, submissionId: input.submissionId },
      inApp: {
        title: copy.pulled.title(input),
        body: copy.pulled.body,
        kind: "INFO",
        action: inAppAction(copy.common.openApplication, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: email.subject,
        body: OPEN_CALL_NOTICES_COPY.en.pulled.body,
        collapseKey: `open-call-decision-${input.submissionId}`,
        data: { submissionId: input.submissionId, url: input.actionUrl },
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── open-call.message-received (FR-015) ──────────────────────────────────────

export const openCallMessagePayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    messageId: z.string().uuid(),
    callTitle,
    /** Who is being told: the applicant, or the organizer side. */
    recipientSide: z.enum(["APPLICANT", "ORGANIZER"]),
    /** The applicant's name, on organizer-side notices; null otherwise / unknown. */
    authorName: name,
    /** The message, clipped, verbatim. */
    preview: z.string().min(1).max(OPEN_CALL_MESSAGE_PREVIEW_MAX),
    actionUrl: httpUrl,
  })
  .strict();
export type OpenCallMessagePayload = z.infer<typeof openCallMessagePayloadSchema>;

function messageTitle(input: OpenCallMessagePayload, locale: NotificationLocale): string {
  const copy = OPEN_CALL_NOTICES_COPY[locale].message;
  return input.recipientSide === "APPLICANT"
    ? copy.titleToApplicant(input)
    : copy.titleToOrganizer(input);
}

export function buildOpenCallMessageEmail(
  input: OpenCallMessagePayload,
  locale: NotificationLocale,
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: messageTitle(input, locale),
    heading: messageTitle(input, locale),
    rows: [],
    paragraphs: [copy.message.replyHint],
    quote: { label: copy.message.messageLabel, text: input.preview },
    action: { label: copy.message.openConversation, url: input.actionUrl },
    links: [],
    footer:
      input.recipientSide === "APPLICANT"
        ? copy.common.applicantFooter
        : copy.common.organizerFooter,
  };
}

export const openCallMessageRenderer: OpenCallRendererDefinition<
  typeof openCallMessagePayloadSchema
> = {
  variant: OPEN_CALL_MESSAGE_VARIANT,
  category: "transactional",
  schema: openCallMessagePayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "message"];
    const metadata: Metadata = {
      submissionId: input.submissionId,
      formId: input.formId,
      messageId: input.messageId,
    };
    const email = buildOpenCallMessageEmail(input, "en");
    return {
      category: "transactional",
      fingerprint: { variant: OPEN_CALL_MESSAGE_VARIANT, messageId: input.messageId },
      inApp: {
        title: messageTitle(input, ctx.locale),
        // The sender's own words: verbatim in every locale.
        body: input.preview,
        kind: "INFO",
        action: inAppAction(copy.message.openConversation, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: email.subject,
        body: input.preview,
        collapseKey: `open-call-message-${input.submissionId}`,
        data: { submissionId: input.submissionId, url: input.actionUrl },
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── open-call.dropped-out (FR-017) ───────────────────────────────────────────

export const openCallDroppedOutPayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    callTitle,
    actName: name,
    /** The nights the act came off (empty when no row was left to remove). */
    dates: z.array(noticeDate).max(100),
    /** The call's applications queue. */
    actionUrl: httpUrl,
  })
  .strict();
export type OpenCallDroppedOutPayload = z.infer<typeof openCallDroppedOutPayloadSchema>;

export function buildOpenCallDroppedOutEmail(
  input: OpenCallDroppedOutPayload,
  locale: NotificationLocale,
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: copy.droppedOut.title(input),
    heading: copy.droppedOut.title(input),
    rows: [],
    paragraphs: [copy.droppedOut.body({ dates: fullDates(locale, input.dates) })],
    quote: null,
    action: { label: copy.droppedOut.openApplications, url: input.actionUrl },
    links: [],
    footer: copy.common.organizerFooter,
  };
}

export const openCallDroppedOutRenderer: OpenCallRendererDefinition<
  typeof openCallDroppedOutPayloadSchema
> = {
  variant: OPEN_CALL_DROPPED_OUT_VARIANT,
  category: "transactional",
  schema: openCallDroppedOutPayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "dropped-out"];
    const metadata: Metadata = { submissionId: input.submissionId, formId: input.formId };
    const email = buildOpenCallDroppedOutEmail(input, "en");
    const body = (locale: NotificationLocale) =>
      OPEN_CALL_NOTICES_COPY[locale].droppedOut.body({ dates: shortDates(locale, input.dates) });
    return {
      category: "transactional",
      fingerprint: { variant: OPEN_CALL_DROPPED_OUT_VARIANT, submissionId: input.submissionId },
      inApp: {
        title: copy.droppedOut.title(input),
        body: body(ctx.locale),
        kind: "WARNING",
        action: inAppAction(copy.droppedOut.openApplications, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: email.subject,
        body: body("en"),
        collapseKey: `open-call-dropped-out-${input.submissionId}`,
        data: { submissionId: input.submissionId, url: input.actionUrl },
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── open-call.application-received (FR-009) ──────────────────────────────────

export const openCallReceivedPayloadSchema = z
  .object({
    submissionId: z.string().uuid(),
    formId: z.string().uuid(),
    callTitle,
    /**
     * Their application: the hub for a signed-in submitter (the stored
     * payload); the status page only in a guest's email, never stored.
     */
    actionUrl: httpUrl,
  })
  .strict();
export type OpenCallReceivedPayload = z.infer<typeof openCallReceivedPayloadSchema>;

export function buildOpenCallReceivedEmail(
  input: OpenCallReceivedPayload,
  locale: NotificationLocale,
  audience: OpenCallEmailAudience = "signed_in",
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: copy.received.title(input),
    heading: copy.received.title(input),
    rows: [],
    paragraphs: [
      copy.received.body,
      audience === "guest" ? copy.received.keepLink : copy.received.inHub,
    ],
    quote: null,
    action: { label: copy.common.openApplication, url: input.actionUrl },
    links: [],
    footer: copy.common.applicantFooter,
  };
}

export const openCallReceivedRenderer: OpenCallRendererDefinition<
  typeof openCallReceivedPayloadSchema
> = {
  variant: OPEN_CALL_RECEIVED_VARIANT,
  category: "transactional",
  schema: openCallReceivedPayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = OPEN_CALL_NOTICES_COPY[ctx.locale];
    const tags: Tags = ["open-call", "received"];
    const metadata: Metadata = { submissionId: input.submissionId, formId: input.formId };
    const email = buildOpenCallReceivedEmail(input, "en");
    return {
      category: "transactional",
      fingerprint: { variant: OPEN_CALL_RECEIVED_VARIANT, submissionId: input.submissionId },
      inApp: {
        title: copy.received.title(input),
        body: copy.received.body,
        kind: "INFO",
        action: inAppAction(copy.common.openApplication, input.actionUrl),
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: emailPayload(email, tags, metadata),
    };
  },
};

// ── Guest duplicate (FR-011 enumeration split): email only, never notify() ───

export type OpenCallGuestDuplicateInput = { callTitle: string; callUrl: string };

export function buildOpenCallGuestDuplicateEmail(
  input: OpenCallGuestDuplicateInput,
  locale: NotificationLocale,
): OpenCallEmailContent {
  const copy = OPEN_CALL_NOTICES_COPY[locale];
  return {
    locale,
    subject: copy.guestDuplicate.title(input),
    heading: copy.guestDuplicate.title(input),
    rows: [],
    paragraphs: [copy.guestDuplicate.body],
    quote: null,
    action: { label: copy.guestDuplicate.openCall, url: input.callUrl },
    links: [],
    footer: copy.common.applicantFooter,
  };
}

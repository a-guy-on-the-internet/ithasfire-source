import { z } from "zod";

import type { NotificationCategory } from "./categories";
import { formatEventDate } from "./copy/common";
import {
  BOOKING_LINEUP_ANSWERED_COPY,
  BOOKING_LINEUP_REMOVED_COPY,
  BOOKING_LINEUP_REQUEST_CLOSED_COPY,
} from "./copy/lineup";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// The bill's notices after the invite (lineup-booking-requests v3, FR-012;
// the invite itself is `booking.lineup-invited` in renderers.ts):
//
//   · booking.lineup-answered       — a tagged act joined / passed / left →
//     the SENDER. In-app only, transactional (L6).
//   · booking.lineup-request-closed — the request was declined, withdrawn or
//     expired → each act that JOINED. In-app + email, "Bills you're on"
//     (L7, L8). Never carries the venue's reason.
//   · booking.lineup-removed        — the sender took a JOINED act off the
//     bill → that act. In-app + email, "Bills you're on" (L5, L8).
//
// Registered in `renderers.ts`'s registry; kept in their own file so the
// bill notices splice in and out as one piece (as lineup-renderers.ts does).
// Copy speaks the booking vocabulary (CONTEXT.md): bill, join, pass — never
// "confirm"; gender-neutral (the act's name, or they/them).
// ─────────────────────────────────────────────────────────────────────────────

type Tags = string[];
type Metadata = Record<string, string>;

type BookingLineupNoticeRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

export const BOOKING_LINEUP_ANSWERED_VARIANT = "booking.lineup-answered" as const;
export const BOOKING_LINEUP_REQUEST_CLOSED_VARIANT =
  "booking.lineup-request-closed" as const;
export const BOOKING_LINEUP_REMOVED_VARIANT = "booking.lineup-removed" as const;

const NAME = z.string().min(1).max(200);
/**
 * The request's nights as stored (`YYYY-MM-DD`, optionally `THH:MM` wall
 * clock). Loose on purpose: an unparseable value is shown verbatim.
 */
const PREFERRED_DATES = z.array(z.string().min(1).max(40)).max(20).optional();

const NIGHT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;

/**
 * "Fri, Aug 14, 2026" / "Fri, Aug 14, 2026 at 8:00 PM" from a stored night —
 * the same rendering `booking.lineup-invited` uses. The time is a venue wall
 * clock with no offset: printed as written, never shifted through a zone.
 */
export function formatBookingNight(
  value: string,
  locale: NotificationLocale = "en",
): string {
  const match = NIGHT_RE.exec(value);
  if (!match) return value;
  const instant = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  );
  if (Number.isNaN(instant.getTime())) return value;
  if (locale === "es") {
    const day = formatEventDate("es", instant.toISOString(), "UTC");
    if (day === null) return value;
    if (match[4] === undefined || match[5] === undefined) return day;
    // 24-hour wall clock, as written: "a las 20:00", "a la 1:30".
    const hour = Number(match[4]);
    return `${day} ${hour === 1 ? "a la" : "a las"} ${hour}:${match[5]}`;
  }
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(instant);
  if (match[4] === undefined || match[5] === undefined) return day;
  const hour24 = Number(match[4]);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${day} at ${hour12}:${match[5]} ${hour24 < 12 ? "AM" : "PM"}`;
}

// ── booking.lineup-answered ──────────────────────────────────────────────────

const lineupAnsweredSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    actId: z.string().uuid(),
    /** The RECIPIENT (the sender, or one of an org sender's editors). */
    humanId: z.string().uuid(),
    /** The act's snapshot name — the ledger entry's. */
    actName: NAME,
    venueName: NAME,
    answer: z.enum(["joined", "passed", "left"]),
    /** Absolute link to the sender's bookings (`/admin/{slug}/bookings`). */
    targetUrl: z.string().url(),
  })
  .strict();

export const bookingLineupAnsweredRenderer: BookingLineupNoticeRendererDefinition<
  typeof lineupAnsweredSchema
> = {
  variant: BOOKING_LINEUP_ANSWERED_VARIANT,
  category: "transactional",
  schema: lineupAnsweredSchema,
  render(input, ctx): RenderNotificationResult {
    // In-ONLY notice: no email/push, so the render locale is all there is.
    const copy = BOOKING_LINEUP_ANSWERED_COPY[ctx.locale];
    const title = copy.title(input);
    const body = copy.body(input.answer);
    const tags: Tags = ["booking", "lineup", `lineup-${input.answer}`];
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      actId: input.actId,
    };
    return {
      category: "transactional",
      fingerprint: {
        variant: BOOKING_LINEUP_ANSWERED_VARIANT,
        bookingRequestId: input.bookingRequestId,
        actId: input.actId,
        humanId: input.humanId,
        answer: input.answer,
      },
      // In-app ONLY (L6): no push, email or SMS payload.
      inApp: {
        title,
        body,
        kind: "INFO",
        action: { label: copy.openLabel, href: input.targetUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
    };
  },
};

// ── booking.lineup-request-closed ────────────────────────────────────────────

const lineupRequestClosedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    actId: z.string().uuid(),
    /** The RECIPIENT — the joined person, or one of a joined group's editors. */
    humanId: z.string().uuid(),
    senderName: NAME,
    venueName: NAME,
    /** The group the recipient edits, when the joined act is a group. */
    asGroupName: NAME.optional(),
    preferredDates: PREFERRED_DATES,
    /** Absolute link to the invite page, which shows the request closed. */
    targetUrl: z.string().url(),
  })
  .strict();

/** Shared with the ui-email subject (`booking.lineup_request_closed`). */
export function lineupRequestClosedTitle(input: { venueName: string }): string {
  return BOOKING_LINEUP_REQUEST_CLOSED_COPY.en.title(input);
}

export const bookingLineupRequestClosedRenderer: BookingLineupNoticeRendererDefinition<
  typeof lineupRequestClosedSchema
> = {
  variant: BOOKING_LINEUP_REQUEST_CLOSED_VARIANT,
  category: "billsYoureOn",
  schema: lineupRequestClosedSchema,
  render(input, ctx): RenderNotificationResult {
    // English feeds the email (subject, text, template); the in-app row reads
    // the render locale. NO reason, ever (L7).
    const dateLabels = (input.preferredDates ?? []).map((d) =>
      formatBookingNight(d),
    );
    const title = lineupRequestClosedTitle(input);
    const body = BOOKING_LINEUP_REQUEST_CLOSED_COPY.en.body({
      senderName: input.senderName,
      venueName: input.venueName,
      dateLabels,
      asGroupName: input.asGroupName,
    });
    const copy = BOOKING_LINEUP_REQUEST_CLOSED_COPY[ctx.locale];
    const tags: Tags = ["booking", "lineup", "lineup-request-closed"];
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      actId: input.actId,
    };
    return {
      category: "billsYoureOn",
      fingerprint: {
        variant: BOOKING_LINEUP_REQUEST_CLOSED_VARIANT,
        bookingRequestId: input.bookingRequestId,
        actId: input.actId,
        humanId: input.humanId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body({
          senderName: input.senderName,
          venueName: input.venueName,
          dateLabels: (input.preferredDates ?? []).map((d) =>
            formatBookingNight(d, ctx.locale),
          ),
          asGroupName: input.asGroupName,
        }),
        kind: "INFO",
        action: { label: copy.viewLabel, href: input.targetUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [body, `View the request: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.lineup_request_closed",
          variables: {
            senderName: input.senderName,
            venueName: input.venueName,
            ...(input.asGroupName ? { asGroupName: input.asGroupName } : {}),
            dateLabels,
            targetUrl: input.targetUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

// ── booking.lineup-removed ───────────────────────────────────────────────────

const lineupRemovedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    actId: z.string().uuid(),
    humanId: z.string().uuid(),
    senderName: NAME,
    venueName: NAME,
    asGroupName: NAME.optional(),
    preferredDates: PREFERRED_DATES,
  })
  .strict();

/** Shared with the ui-email subject (`booking.lineup_removed`). */
export function lineupRemovedTitle(input: {
  senderName: string;
  venueName: string;
  asGroupName?: string;
}): string {
  return BOOKING_LINEUP_REMOVED_COPY.en.title(input);
}

export const bookingLineupRemovedRenderer: BookingLineupNoticeRendererDefinition<
  typeof lineupRemovedSchema
> = {
  variant: BOOKING_LINEUP_REMOVED_VARIANT,
  category: "billsYoureOn",
  schema: lineupRemovedSchema,
  render(input, ctx): RenderNotificationResult {
    // English feeds the email; the in-app row reads the render locale.
    const dateLabels = (input.preferredDates ?? []).map((d) =>
      formatBookingNight(d),
    );
    const title = lineupRemovedTitle(input);
    const body = BOOKING_LINEUP_REMOVED_COPY.en.body({
      senderName: input.senderName,
      venueName: input.venueName,
      dateLabels,
      asGroupName: input.asGroupName,
    });
    const copy = BOOKING_LINEUP_REMOVED_COPY[ctx.locale];
    const tags: Tags = ["booking", "lineup", "lineup-removed"];
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      actId: input.actId,
    };
    return {
      category: "billsYoureOn",
      fingerprint: {
        variant: BOOKING_LINEUP_REMOVED_VARIANT,
        bookingRequestId: input.bookingRequestId,
        actId: input.actId,
        humanId: input.humanId,
      },
      // No action: off the bill, the invite page no longer opens for them.
      inApp: {
        title: copy.title(input),
        body: copy.body({
          senderName: input.senderName,
          venueName: input.venueName,
          dateLabels: (input.preferredDates ?? []).map((d) =>
            formatBookingNight(d, ctx.locale),
          ),
          asGroupName: input.asGroupName,
        }),
        kind: "INFO",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: body,
        template: {
          key: "booking.lineup_removed",
          variables: {
            senderName: input.senderName,
            venueName: input.venueName,
            ...(input.asGroupName ? { asGroupName: input.asGroupName } : {}),
            dateLabels,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

import { z } from "zod";

import type {
  NotificationKind,
  NotificationAction,
} from "@th/ports/repos/notifications";
import { notificationKindSchema } from "@th/schema";

import { plainTextRequired } from "../../lib/sanitize-plain-text";

import { formatCents } from "../../lib/currency-utils";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { BOOKING_REASON_MAX } from "../booking-requests/messages/_shared/system-entries";
import {
  LEGACY_OWNER_SIDE,
  normalizeCancellerSide,
} from "../../lib/legacy-place-values";
import { IMAGE_MODERATION_SUBJECT_TITLE_MAX_LENGTH } from "../moderation/image-moderation-subject";
import {
  notificationCategorySchema,
  type NotificationCategory,
} from "./categories";
import type { ChannelTemplateRef } from "./shared";
import {
  DEFAULT_NOTIFICATION_LOCALE,
  type NotificationLocale,
} from "./locale";
import {
  COMMON_COPY,
  formatEventDate,
  formatEventStart,
} from "./copy/common";
import {
  RSVP_CONFIRMED_COPY,
  RSVP_DATE_CANCELLED_COPY,
  RSVP_REMINDER_COPY,
} from "./copy/rsvp";
import {
  ORDER_CONFIRMED_COPY,
  ORDER_REFUND_PROCESSED_COPY,
  ORDER_TICKET_RETURNED_COPY,
  PAYOUT_COMPLETED_COPY,
  RESALE_PURCHASE_CONFIRMED_COPY,
} from "./copy/money";
import {
  BOOKING_ASK_ANSWERED_COPY,
  BOOKING_ASK_RECEIVED_COPY,
  BOOKING_CANCELLED_COPY,
  BOOKING_LINEUP_INVITED_COPY,
  BOOKING_MESSAGE_RECEIVED_COPY,
  BOOKING_REQUEST_RECEIVED_COPY,
  BOOKING_REQUEST_RESPONDED_COPY,
  ORGANIZER_BOOKING_REQUEST_RECEIVED_COPY,
  ORGANIZER_BOOKING_REQUEST_RESPONDED_COPY,
} from "./copy/booking";
import {
  BOOKING_HOLD_CHALLENGE_ANSWERED_COPY,
  BOOKING_HOLD_CHALLENGE_COPY,
  BOOKING_HOLD_COMMON_COPY,
  BOOKING_HOLD_CONFIRMED_COPY,
  BOOKING_HOLD_EXPIRED_COPY,
  BOOKING_HOLD_LOST_DATE_COPY,
  BOOKING_HOLD_PLACED_BATCH_COPY,
  BOOKING_HOLD_PLACED_COPY,
  BOOKING_HOLD_POSITION_CHANGED_COPY,
  BOOKING_HOLD_RELEASED_COPY,
} from "./copy/booking-holds";
import {
  ENTITY_NEW_EVENT_COPY,
  EVENT_APPLICATION_SUBMISSION_RECEIVED_COPY,
  EVENT_ATTENDEE_FEEDBACK_REQUEST_COPY,
  EVENT_CANCELLED_COPY,
  EVENT_CHANGED_COPY,
  EVENT_LOCATION_REVEALED_COPY,
  EVENT_UNLISTED_COPY,
  EVENT_VENUE_CONFIRMATION_WITHDRAWN_COPY,
  EVENT_VENUE_CONFIRMED_COPY,
  PLACE_AVAILABILITY_SETUP_NEEDED_COPY,
  POST_EVENT_ATTENDEE_REVIEW_PROMPT_COPY,
  POST_EVENT_PERFORMER_REVIEW_PROMPT_COPY,
} from "./copy/events";
import {
  IMAGE_MODERATION_APPROVED_COPY,
  IMAGE_MODERATION_HELD_COPY,
  IMAGE_MODERATION_REJECTED_COPY,
} from "./copy/moderation";
import { fail } from "@th/errors";
import {
  eventLineupAddedRenderer,
  eventLineupLeftRenderer,
} from "./lineup-renderers";
import { dealFrozenChangeRenderer } from "./deal-change-renderers";
import {
  openCallDroppedOutRenderer,
  openCallMessageRenderer,
  openCallNotThisTimeRenderer,
  openCallPickedRenderer,
  openCallPulledRenderer,
  openCallReceivedRenderer,
} from "./open-call-renderers";
import {
  bookingLineupAnsweredRenderer,
  bookingLineupRemovedRenderer,
  bookingLineupRequestClosedRenderer,
} from "./booking-lineup-notice-renderers";
import {
  eventApplicationApprovedRenderer,
  eventApplicationBackInReviewRenderer,
  eventApplicationReceivedRenderer,
  eventApplicationRejectedRenderer,
  eventApplicationWaitlistedRenderer,
} from "./application-renderers";
import {
  disputeRiskOwnerNoticeRenderer,
  entityReportReviewedRenderer,
  entityReportSubmittedRenderer,
  resaleClaimOpenedRenderer,
  resaleClaimRefundedRenderer,
  resaleClaimResolvedRenderer,
  resaleListingClosedRelistRenderer,
  resaleListingCreatedRenderer,
  resaleSaleRefundedListingClosedRenderer,
  resaleSellerSoldRenderer,
} from "./direct-money-safety-renderers";
import {
  VOLUNTEER_GROUP_COORDINATOR_ASSIGNED_COPY,
  VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY,
  VOLUNTEER_OCCURRENCE_CANCELLED_COPY,
  VOLUNTEER_POOL_SIGNUP_RECEIVED_COPY,
  VOLUNTEER_SIGNUP_APPROVED_COPY,
  VOLUNTEER_SIGNUP_RECEIVED_COPY,
  VOLUNTEER_SIGNUP_REJECTED_COPY,
  VOLUNTEER_SPOT_OPENED_COPY,
} from "./copy/volunteer-signups";
import {
  placeClaimDecidedRenderer,
  placeClaimReceivedRenderer,
  placeDisputeDecidedRenderer,
  placeDisputeFiledRenderer,
  placeOwnershipTransferredRenderer,
  suggestionReceivedRenderer,
  suggestionReviewedRenderer,
  volunteerShiftReminderInAppRenderer,
  volunteerStartReminderInAppRenderer,
} from "./direct-community-renderers";
import {
  invitePauseDecidedRenderer,
  invitePauseOpenedRenderer,
} from "./invite-pause-renderers";
import { SMS_BRAND_PREFIX } from "../../lib/comms/sms-brand";

type Tags = string[];
type Metadata = Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// Shared action helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduces an absolute URL to its in-app route (path + query + hash). Returns
 * null for anything unparseable — the schemas enforce `.url()`, so this is
 * belt-and-braces rather than an expected branch.
 */
function pathAndQueryOf(absoluteUrl: string): string | null {
  try {
    const url = new URL(absoluteUrl);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * The standard "View event" in-app action, derived from the event's ABSOLUTE
 * public URL.
 *
 * Every event action goes through here so the in-app route and the emailed
 * link are the same target by construction. Deriving the route from the URL
 * also makes an id-based route unrepresentable: these renderers used to build
 * the route from the event id, and because the public page resolves by slug
 * (or slug history) only, every one of those buttons pointed at a 404.
 *
 * No URL → NO ACTION. A labelled button that goes nowhere is worse than no
 * button, and the inbox hides an action whose href is null anyway.
 */
function eventRouteAction(
  eventUrl: string | null | undefined,
  label = "View event",
): NotificationAction | null {
  if (!eventUrl) return null;
  const route = pathAndQueryOf(eventUrl);
  return route ? { label, route } : null;
}

export type InAppChannelPayload = {
  title: string | null;
  body: string;
  kind: NotificationKind;
  action: NotificationAction | null;
  expiresAt: Date | null;
  tags: Tags;
  metadata: Metadata;
  template: ChannelTemplateRef;
};

export type PushChannelPayload = {
  title: string | null;
  body: string;
  data?: Record<string, unknown>;
  collapseKey?: string;
  tags: Tags;
  metadata: Metadata;
  template: ChannelTemplateRef;
};

export type EmailChannelPayload = {
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  template?: ChannelTemplateRef;
  /** When set, overrides Reply-To header (e.g. organizer contact email). */
  replyTo?: { to: string; name?: string } | null;
  tags: Tags;
  metadata: Metadata;
};

export type SmsChannelPayload = {
  body?: string;
  template?: ChannelTemplateRef;
  tags: Tags;
  metadata: Metadata;
};

export type RenderNotificationResult = {
  category: NotificationCategory;
  fingerprint: Record<string, unknown>;
  inApp?: InAppChannelPayload;
  push?: PushChannelPayload;
  email?: EmailChannelPayload;
  sms?: SmsChannelPayload;
};

/**
 * What a renderer sees. `locale` is always set here; callers of
 * `renderNotification` may omit it (→ English), see `RenderNotificationContext`.
 */
type RendererContext = {
  now: Date;
  /**
   * The language to write in-app copy in. Write-time `notify` always renders
   * "en" (the stored text); the inbox re-renders in the reader's language at
   * read time (`render-stored-notification.ts`). Email and push stay English
   * for now regardless of this value.
   */
  locale: NotificationLocale;
};

/** `renderNotification`'s context: `locale` defaults to English. */
export type RenderNotificationContext = {
  now: Date;
  locale?: NotificationLocale;
};

type NotificationRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: RendererContext,
  ): RenderNotificationResult;
};

const notificationActionSchema = z
  .object({
    label: z.string().min(1),
    href: z.string().url().optional(),
    route: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.href ?? value.route), {
    message: "Either href or route is required for the action",
    path: ["href"],
  });

const genericNotificationSchema = z
  .object({
    category: notificationCategorySchema.optional().default("transactional"),
    title: z.string().min(1).optional(),
    body: z.string().min(1),
    kind: notificationKindSchema.default("INFO"),
    action: notificationActionSchema.nullish(),
    expiresInMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .nullish(),
    tags: z.array(z.string().min(1)).max(10).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    template: z
      .object({
        key: z.string().min(1),
        version: z.string().min(1).optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    push: z
      .object({
        title: z.string().min(1).optional(),
        body: z.string().min(1),
        collapseKey: z.string().min(1).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        tags: z.array(z.string().min(1)).max(10).optional(),
      })
      .optional(),
  })
  .strict();

type GenericNotificationInput = z.infer<typeof genericNotificationSchema>;

export const GENERIC_VARIANT = "notification.generic" as const;
const GENERIC_DEFAULT_CATEGORY: NotificationCategory = "transactional";

const genericRenderer: NotificationRendererDefinition<
  typeof genericNotificationSchema
> = {
  variant: GENERIC_VARIANT,
  category: GENERIC_DEFAULT_CATEGORY,
  schema: genericNotificationSchema,
  render(
    input: GenericNotificationInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const category = input.category ?? GENERIC_DEFAULT_CATEGORY;
    notificationCategorySchema.parse(category);

    const baseTags = input.tags ?? [];
    const baseMetadata = input.metadata ?? {};
    const expiresAt = input.expiresInMinutes
      ? new Date(ctx.now.getTime() + input.expiresInMinutes * 60_000)
      : null;

    const inAppTemplate = input.template
      ? {
          key: input.template.key,
          ...(typeof input.template.version !== "undefined" &&
          input.template.version !== null
            ? { version: input.template.version }
            : {}),
          ...(typeof input.template.variables !== "undefined"
            ? { variables: input.template.variables }
            : {}),
        }
      : null;

    const inApp: InAppChannelPayload = {
      title: input.title ?? null,
      body: input.body,
      kind: input.kind,
      action: input.action ?? null,
      expiresAt,
      tags: baseTags,
      metadata: { ...baseMetadata },
      template: inAppTemplate,
    };

    const push: PushChannelPayload | undefined = input.push
      ? {
          title: input.push.title ?? input.title ?? null,
          body: input.push.body,
          collapseKey: input.push.collapseKey ?? undefined,
          data: input.push.data,
          tags: input.push.tags ? [...input.push.tags] : baseTags,
          metadata: { ...(input.push.metadata ?? baseMetadata) },
          template: inAppTemplate,
        }
      : undefined;

    return {
      category,
      fingerprint: {
        variant: GENERIC_VARIANT,
        category,
        title: input.title ?? null,
        body: input.body,
        kind: input.kind,
        action: input.action ?? null,
        expiresInMinutes: input.expiresInMinutes ?? null,
        tags: baseTags,
        metadata: baseMetadata,
        template: inAppTemplate,
        push: input.push
          ? {
              title: input.push.title ?? null,
              body: input.push.body,
              collapseKey: input.push.collapseKey ?? null,
              data: input.push.data ?? null,
              metadata: input.push.metadata ?? null,
              tags: input.push.tags ?? null,
            }
          : null,
        email: null,
      },
      inApp,
      push,
    };
  },
};

type AttendeeReminderInput = z.infer<typeof attendeeReminderSchema>;

const attendeeReminderSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    eventId: z.string().uuid(),
    organizerId: z.string().uuid(),
    startsAtIso: z.string().min(1),
    action: notificationActionSchema.optional(),
    pushBody: z.string().min(1).optional(),
  })
  .strict();

const attendeeReminderRenderer: NotificationRendererDefinition<
  typeof attendeeReminderSchema
> = {
  variant: "event.attendee-reminder",
  category: "organizerMessages",
  schema: attendeeReminderSchema,
  render(
    input: AttendeeReminderInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      organizerId: input.organizerId,
    };

    const tags: Tags = ["event", "reminder"];

    return {
      category: "organizerMessages",
      fingerprint: {
        variant: "event.attendee-reminder",
        eventId: input.eventId,
        organizerId: input.organizerId,
        startsAtIso: input.startsAtIso,
        title: input.title,
        body: input.body,
        action: input.action ?? null,
        pushBody: input.pushBody ?? null,
      },
      inApp: {
        title: input.title,
        body: input.body,
        kind: "INFO",
        action: input.action ?? null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: input.pushBody
        ? {
            title: input.title,
            body: input.pushBody,
            collapseKey: `event-${input.eventId}`,
            data: {
              eventId: input.eventId,
              startsAtIso: input.startsAtIso,
            },
            tags,
            metadata,
            template: null,
          }
        : undefined,
    };
  },
};

const attendeeFeedbackRequestSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    eventEndsAtIso: z.string().datetime({ offset: true }).nullable().optional(),
    organizerName: z.string().min(1).nullable().optional(),
    orderId: z.string().uuid(),
    requestId: z.string().uuid(),
    feedbackUrl: z.string().url().optional(),
  })
  .strict();

type AttendeeFeedbackRequestInput = z.infer<
  typeof attendeeFeedbackRequestSchema
>;

const attendeeFeedbackRequestRenderer: NotificationRendererDefinition<
  typeof attendeeFeedbackRequestSchema
> = {
  variant: "event.attendee-feedback-request",
  category: "marketing",
  schema: attendeeFeedbackRequestSchema,
  render(
    input: AttendeeFeedbackRequestInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      orderId: input.orderId,
      requestId: input.requestId,
    };

    if (input.feedbackUrl) {
      metadata.feedbackUrl = input.feedbackUrl;
    }

    const tags: Tags = ["event", "feedback"];
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = EVENT_ATTENDEE_FEEDBACK_REQUEST_COPY[ctx.locale];
    const english = EVENT_ATTENDEE_FEEDBACK_REQUEST_COPY.en;
    const copyValues = {
      eventTitle: input.eventTitle,
      organizerName: input.organizerName ?? null,
    };
    const subject = english.title(copyValues);
    const body = english.body(copyValues);
    const feedbackCta = input.feedbackUrl
      ? `Share your thoughts: ${input.feedbackUrl}`
      : "Log in to your Ithas Fire account to leave feedback.";

    return {
      category: "marketing",
      fingerprint: {
        variant: "event.attendee-feedback-request",
        eventId: input.eventId,
        orderId: input.orderId,
        requestId: input.requestId,
        eventTitle: input.eventTitle,
        eventEndsAtIso: input.eventEndsAtIso ?? null,
        organizerName: input.organizerName ?? null,
        feedbackUrl: input.feedbackUrl ?? null,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body(copyValues),
        kind: "INFO",
        action: input.feedbackUrl
          ? {
              label: copy.leaveFeedbackLabel,
              href: input.feedbackUrl,
            }
          : null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: `${body}\n\n${feedbackCta}`,
        tags,
        metadata,
      },
    };
  },
};

const eventApplicationSubmissionReceivedSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1).max(200),
    submissionId: z.string().uuid(),
    /**
     * Applicant display name. The CALLER
     * (notify-event-application-received) guarantees non-empty; the
     * `.min(1)` fails notify() BEFORE its idempotency claim (same hazard
     * note as bookingRequestReceivedSchema.actName).
     */
    applicantName: z.string().min(1).max(320),
    /**
     * Absolute, PER-RECIPIENT review-queue link — the admin slug differs by
     * whether the recipient owns the event directly (`/admin/@human/…`) or
     * via an org (`/admin/org-slug/…`).
     */
    queueUrl: z.string().url(),
  })
  .strict();

type EventApplicationSubmissionReceivedInput = z.infer<
  typeof eventApplicationSubmissionReceivedSchema
>;

/**
 * Organizer-facing: a new application landed in the event's review queue
 * (spec Phase 1 notification triple, leg b). Sent inline post-commit by
 * submitEventApplication via notify-event-application-received to everyone
 * who can review (owning human / org edit roles). In-app + email + push;
 * deliberately NO SMS payload (the dispatcher also disables the channel).
 */
const eventApplicationSubmissionReceivedRenderer: NotificationRendererDefinition<
  typeof eventApplicationSubmissionReceivedSchema
> = {
  variant: "event.application-submission-received",
  category: "transactional",
  schema: eventApplicationSubmissionReceivedSchema,
  render(
    input: EventApplicationSubmissionReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      submissionId: input.submissionId,
    };

    const tags: Tags = ["event", "application", "submission-received"];
    const title = `New application for ${input.eventTitle}`;
    const body = `${input.applicantName} applied to ${input.eventTitle}.`;
    // In-app copy is in the render locale (copy/events.ts); push and email
    // stay English.
    const copy = EVENT_APPLICATION_SUBMISSION_RECEIVED_COPY[ctx.locale];
    const copyValues = {
      eventTitle: input.eventTitle,
      applicantName: input.applicantName,
    };
    const action: NotificationAction = {
      label: copy.reviewLabel,
      href: input.queueUrl,
    };

    return {
      category: "transactional",
      fingerprint: {
        variant: "event.application-submission-received",
        submissionId: input.submissionId,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        collapseKey: `event-application-${input.submissionId}`,
        data: {
          eventId: input.eventId,
          submissionId: input.submissionId,
          url: input.queueUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        // Kept in sync with the template registry's subjectTemplate
        // ("New application for {{eventTitle}}").
        subject: title,
        text: [body, `Review applications: ${input.queueUrl}`].join("\n\n"),
        template: {
          key: "event.application_submission_received",
          variables: {
            eventTitle: input.eventTitle,
            applicantName: input.applicantName,
            queueUrl: input.queueUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const eventCancelledSchema = z
  .object({
    eventId: z.string().uuid(),
    // Titles are capped at 140 chars at input; 200 is deliberate slack so a
    // hostile/oversized title can't bloat notifications or emails.
    eventTitle: z.string().min(1).max(200),
    startsAt: z.string().nullable(),
    // Three refund states on a cancellation:
    //   - refunded: paid buyer, money already returned;
    //   - pending: paid buyer whose refund FAILED (money still stuck) — told
    //     it's being worked on;
    //   - null: no money involved (RSVPer / saver).
    refund: z
      .discriminatedUnion("status", [
        z.object({
          status: z.literal("refunded"),
          amountCents: z.number().int().nonnegative(),
          currency: z.string(),
        }),
        z.object({ status: z.literal("pending") }),
      ])
      .nullable(),
    /**
     * Absolute URL of the public event page (slug-based), or null when it
     * can't be built. Optional so an emitter that predates this field can't
     * have its notice rejected by the strict schema — a cancellation is a
     * money-adjacent notice and must never fail to send over a link.
     */
    eventUrl: z.string().url().nullable().optional(),
  })
  .strict();

type EventCancelledInput = z.infer<typeof eventCancelledSchema>;

/**
 * Attendee-facing: an event was cancelled. Buyers who were refunded get a
 * refund-aware message; buyers whose refund FAILED get a "refund in progress"
 * notice; RSVPers get a plain cancellation notice. Email is essential here —
 * cancelled-event attendees are rarely watching in-app.
 */
const eventCancelledRenderer: NotificationRendererDefinition<
  typeof eventCancelledSchema
> = {
  variant: "event.cancelled",
  category: "transactional",
  schema: eventCancelledSchema,
  render(
    input: EventCancelledInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
    };

    const tags: Tags = ["event", "cancelled"];
    // Route derived from the SLUG-based URL, never the id (an id route 404s).
    // No URL → no action at all, rather than a button to a dead page. The
    // cancelled event's page still renders (with a cancellation banner), so
    // this link stays useful after cancellation.
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = EVENT_CANCELLED_COPY[ctx.locale];
    const action = eventRouteAction(input.eventUrl, copy.viewEventLabel);

    const refund = input.refund?.status ?? null;
    const amount =
      input.refund?.status === "refunded"
        ? formatCents(input.refund.amountCents, input.refund.currency)
        : null;
    const copyValues = { eventTitle: input.eventTitle, refund, amount };
    const title = copy.title(copyValues);
    const english = EVENT_CANCELLED_COPY.en;
    const body = english.body(copyValues);
    let subject: string;
    if (refund === "refunded") {
      subject = `${input.eventTitle} was cancelled — you've been refunded`;
    } else if (refund === "pending") {
      subject = `${input.eventTitle} was cancelled — refund in progress`;
    } else {
      subject = `${input.eventTitle} was cancelled`;
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "event.cancelled",
        eventId: input.eventId,
        refund: input.refund?.status ?? "none",
      },
      inApp: {
        title,
        body: copy.body(copyValues),
        kind: "WARNING",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: body,
        tags,
        metadata,
      },
    };
  },
};

const eventChangedSchema = z
  .object({
    eventId: z.string().uuid(),
    // Titles are capped at 140 chars at input; 200 is deliberate slack so a
    // hostile/oversized title can't bloat notifications or emails.
    eventTitle: z.string().min(1).max(200),
    changeType: z.enum(["RESCHEDULED", "VENUE_CHANGED"]),
    newStartsAt: z.string().nullable(),
    newEndsAt: z.string().nullable(),
    /** Absolute URL of the public event page (slug-based), or null. */
    eventUrl: z.string().url().nullable().optional(),
    /**
     * The event's IANA zone, so the new start reads in local time. Optional:
     * rows stored before it existed (and a failed event lookup) render in the
     * platform default zone.
     */
    timezone: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();

type EventChangedInput = z.infer<typeof eventChangedSchema>;

/**
 * Attendee-facing: an event changed in a way attendees must know about
 * (rescheduled to a new date, or moved to a new venue). Email is essential —
 * attendees need the update whether or not they're in the app.
 */
const eventChangedRenderer: NotificationRendererDefinition<
  typeof eventChangedSchema
> = {
  variant: "event.changed",
  category: "transactional",
  schema: eventChangedSchema,
  render(
    input: EventChangedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      changeType: input.changeType,
    };

    const tags: Tags = ["event", "changed"];
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = EVENT_CHANGED_COPY[ctx.locale];
    const action = eventRouteAction(input.eventUrl, copy.viewEventLabel);

    // The event's own zone when the payload has one; older rows (no
    // `timezone`) read in the platform default (formatEventStart's
    // fallback). UTC was the server's zone, not the event's, and put an
    // evening start on the next day.
    const startsAtFor = (locale: NotificationLocale): string | null =>
      input.newStartsAt
        ? formatEventStart(locale, input.newStartsAt, input.timezone)
        : null;
    const copyValues = {
      eventTitle: input.eventTitle,
      changeType: input.changeType,
    };
    const title = copy.title(copyValues);
    const inAppBody = copy.body({
      ...copyValues,
      newStartsAt: startsAtFor(ctx.locale),
    });
    const body = EVENT_CHANGED_COPY.en.body({
      ...copyValues,
      newStartsAt: startsAtFor("en"),
    });
    const subject =
      input.changeType === "RESCHEDULED"
        ? `${input.eventTitle} was rescheduled`
        : `${input.eventTitle} moved to a new location`;

    return {
      category: "transactional",
      fingerprint: {
        variant: "event.changed",
        eventId: input.eventId,
        changeType: input.changeType,
        newStartsAt: input.newStartsAt,
      },
      inApp: {
        title,
        body: inAppBody,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: body,
        tags,
        metadata,
      },
    };
  },
};

const eventUnlistedSchema = z
  .object({
    eventId: z.string().uuid(),
    // Titles are capped at 140 chars at input; 200 is deliberate slack so a
    // hostile/oversized title can't bloat notifications or emails.
    eventTitle: z.string().min(1).max(200),
  })
  .strict();

type EventUnlistedInput = z.infer<typeof eventUnlistedSchema>;

/**
 * Attendee-facing: an event a watcher was following was pulled from public
 * listing — either ARCHIVED or UNPUBLISHED. To the attendee both mean the same
 * thing ("the event you were watching is no longer listed"), so one variant
 * serves both. Deliberately `action: null` — the event is no longer public, so
 * an id-based event link would 404. Email is essential: watchers are
 * rarely in-app when an event they saved/RSVP'd to disappears.
 */
const eventUnlistedRenderer: NotificationRendererDefinition<
  typeof eventUnlistedSchema
> = {
  variant: "event.unlisted",
  category: "transactional",
  schema: eventUnlistedSchema,
  render(
    input: EventUnlistedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
    };

    const tags: Tags = ["event", "unlisted"];
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = EVENT_UNLISTED_COPY[ctx.locale];
    const english = EVENT_UNLISTED_COPY.en;
    const body = english.body({ eventTitle: input.eventTitle });
    const subject = `${input.eventTitle} is no longer available`;

    return {
      category: "transactional",
      fingerprint: {
        variant: "event.unlisted",
        eventId: input.eventId,
      },
      inApp: {
        title: copy.title,
        body: copy.body({ eventTitle: input.eventTitle }),
        kind: "WARNING",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: body,
        tags,
        metadata,
      },
    };
  },
};

const eventLocationRevealedSchema = z
  .object({
    eventId: z.string().uuid(),
    // Titles are capped at 140 chars at input; 200 is deliberate slack so a
    // hostile/oversized title can't bloat notifications or emails.
    eventTitle: z.string().min(1).max(200),
    /** Exact street address, unlocked at `addressRevealAt`. */
    address: z.string().min(1).max(500),
    venueName: z.string().min(1).max(200).nullable().optional(),
    startsAtIso: z.string().min(1),
    /** IANA timezone used to format the event time. Null → UTC fallback. */
    timezone: z.string().nullable().optional(),
    /** Google Maps place link for the revealed coordinates. */
    mapUrl: z.string().url().nullable().optional(),
    /** Google Maps directions deep-link for the revealed coordinates. */
    directionsUrl: z.string().url().nullable().optional(),
    /**
     * Absolute URL of the public event page, or null when the event has no
     * slug (no resolvable page). NULLABLE on purpose: the payload IS the
     * address, so a missing link must never suppress the reveal — a required
     * URL here would throw inside `notify()` and the event would lose its
     * reveal permanently once it aged out of the lookback window.
     */
    eventUrl: z.string().url().nullable().optional(),
    /**
     * Absolute SHORT link of the event (`/e/<shortId>`), used by the SMS leg
     * ONLY. The dispatcher sets it only when the link will resolve (the event
     * has a short ID and is publicly readable); absent, the SMS falls back to
     * `eventUrl`. Email and in-app always use `eventUrl`.
     */
    eventShortUrl: z.string().url().nullable().optional(),
  })
  .strict();

type EventLocationRevealedInput = z.infer<typeof eventLocationRevealedSchema>;

/**
 * Attendee-facing: an OBSCURED event's `addressRevealAt` crossed and the
 * exact address is now live for ticket holders. Sent by the
 * events.address-reveal-notify job via dispatch-address-reveal-notifications.
 * Transactional — this is "where do I go?", not marketing. The dispatcher
 * forces the in-app channel on (non-suppressible); email/push stay
 * preference-driven.
 */
const eventLocationRevealedRenderer: NotificationRendererDefinition<
  typeof eventLocationRevealedSchema
> = {
  variant: "event.location-revealed",
  category: "transactional",
  schema: eventLocationRevealedSchema,
  render(
    input: EventLocationRevealedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
    };
    if (input.directionsUrl) {
      metadata.directionsUrl = input.directionsUrl;
    }

    const tags: Tags = ["event", "location-revealed"];
    const venueFragment = input.venueName ? `${input.venueName} — ` : "";
    // In-app copy is in the render locale (copy/events.ts); push, email and
    // SMS stay English.
    const copy = EVENT_LOCATION_REVEALED_COPY[ctx.locale];
    const copyValues = {
      eventTitle: input.eventTitle,
      venueName: input.venueName ?? null,
      address: input.address,
    };
    const title = EVENT_LOCATION_REVEALED_COPY.en.title(copyValues);
    const body = EVENT_LOCATION_REVEALED_COPY.en.body(copyValues);
    const subject = `The location for ${input.eventTitle} is now live`;
    // Same absolute URL the email leg links, so the in-app route and the
    // emailed link can never diverge. (The SMS may carry the short link to the
    // same page instead; see below.)
    const action = eventRouteAction(input.eventUrl, copy.viewEventLabel);

    const textLines: string[] = [body];
    if (input.directionsUrl) {
      textLines.push(`Get directions: ${input.directionsUrl}`);
    }
    if (input.eventUrl) {
      textLines.push(`View the event: ${input.eventUrl}`);
    }

    // SMS leg (FR-006): minimal transactional body — event title + revealed
    // address + event URL, no marketing fluff. Hard-capped at 320 chars: the
    // event URL is always preserved and the lead text is truncated instead.
    // Truncation is code-point-aware, so an astral char (emoji) straddling
    // the cut can never leave a lone surrogate in the payload.
    // Preference gating (transactional×sms, default OFF) happens in notify();
    // the consent-ledger gate (STOP replies) lives in channels/send-sms.
    const SMS_MAX_LENGTH = 320;
    // The SMS links the SHORT URL when the dispatcher supplied one: SMS is
    // billed per segment (160 GSM-7 chars; 70 once any char needs UCS-2), and
    // the canonical slug URL (~125 chars) alone pushes a typical reveal into a
    // second segment. Every char the link doesn't use is budget left for the
    // title and address, which are what get truncated. Email and in-app keep
    // the canonical `eventUrl`.
    const smsLink = input.eventShortUrl ?? input.eventUrl;
    // No link → no suffix; the address still gets its full budget.
    const smsSuffix = smsLink ? ` ${smsLink}` : "";
    // GSM-7 only in the text WE add to the SMS: one non-GSM char (the shared
    // fragment's " — ", the "…" ellipsis) flips the whole message to UCS-2
    // and 70-char segments. So the SMS gets its own ", " venue separator and
    // an ASCII "..." below; email/in-app keep `venueFragment` unchanged. The
    // title, venue name and address are user content and are NOT
    // transliterated — an accent or emoji there still makes the SMS UCS-2.
    const smsVenueFragment = input.venueName ? `${input.venueName}, ` : "";
    let smsLead = `${SMS_BRAND_PREFIX}Location revealed for ${input.eventTitle}: ${smsVenueFragment}${input.address}.`;
    const smsLeadMax = SMS_MAX_LENGTH - smsSuffix.length;
    if (smsLead.length > smsLeadMax) {
      // Budget stays in UTF-16 units (what `.length` / the 320 cap measure),
      // but the cut only ever lands on code-point boundaries.
      const budget = Math.max(0, smsLeadMax - 3); // reserve 3 for the "..."
      let truncated = "";
      for (const codePoint of smsLead) {
        if (truncated.length + codePoint.length > budget) break;
        truncated += codePoint;
      }
      // ASCII "...", not "…" (U+2026, outside GSM-7): see smsVenueFragment.
      smsLead = `${truncated.trimEnd()}...`;
    }
    const smsBody = `${smsLead}${smsSuffix}`;

    return {
      category: "transactional",
      fingerprint: {
        variant: "event.location-revealed",
        eventId: input.eventId,
        address: input.address,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body: `${venueFragment}${input.address}. Tap for directions.`,
        collapseKey: `event-location-${input.eventId}`,
        data: {
          eventId: input.eventId,
          ...(input.directionsUrl
            ? { directionsUrl: input.directionsUrl }
            : {}),
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "event.location_revealed",
          variables: {
            eventTitle: input.eventTitle,
            startsAtISO: input.startsAtIso,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            venueName: input.venueName ?? null,
            address: input.address,
            mapUrl: input.mapUrl ?? null,
            directionsUrl: input.directionsUrl ?? null,
            eventUrl: input.eventUrl ?? null,
          },
        },
        tags,
        metadata,
      },
      sms: {
        body: smsBody,
        tags,
        metadata,
      },
    };
  },
};

const rsvpConfirmedSchema = z
  .object({
    eventId: z.string().uuid(),
    // Titles are capped at 140 chars at input; 200 is deliberate slack so a
    // hostile/oversized title can't bloat notifications or emails.
    eventTitle: z.string().min(1).max(200),
    startsAtIso: z.string(),
    endsAtIso: z.string().nullable().optional(),
    /** IANA timezone used to format the event time. Null → UTC fallback. */
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    addressText: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    /**
     * Absolute URL of the event page — where the RSVP toggle (= cancel) lives.
     * NULLABLE: an event with no slug has no resolvable public page, and a
     * required URL here would throw inside `notify()` (the renderer runs before
     * the idempotency claim), dead-lettering the confirmation after burning its
     * retries. Losing the link beats losing the confirmation.
     */
    eventUrl: z.string().url().nullable().optional(),
    /** Absolute URL of the viewer's /my-rsvps list. Nullable for the same reason. */
    manageRsvpsUrl: z.string().url().nullable().optional(),
  })
  .strict();

type RsvpConfirmedInput = z.infer<typeof rsvpConfirmedSchema>;

/**
 * Attendee-facing RSVP confirmation for community (attendanceMode=RSVP)
 * events. Sent by the dispatch-rsvp-notifications drain — never inline from
 * the tRPC path (the web/api ctx has no mailer bound). The event page hosts
 * the RSVP toggle, so "cancel" = the event link; /my-rsvps is the list view.
 */
const rsvpConfirmedRenderer: NotificationRendererDefinition<
  typeof rsvpConfirmedSchema
> = {
  variant: "rsvp.confirmed",
  category: "transactional",
  schema: rsvpConfirmedSchema,
  render(
    input: RsvpConfirmedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
    };

    const tags: Tags = ["rsvp", "confirmed"];

    // In-app copy is in the render locale (copy/rsvp.ts). Email below stays
    // English until email gets its own locale (separate task).
    const copy = RSVP_CONFIRMED_COPY[ctx.locale];
    // Same absolute URL the email links (the event page hosts the RSVP toggle).
    const action = eventRouteAction(input.eventUrl, copy.viewEventLabel);
    const title = copy.title({ eventTitle: input.eventTitle });
    const inAppBody = copy.body({
      eventTitle: input.eventTitle,
      startsAt: formatEventStart(
        ctx.locale,
        input.startsAtIso,
        input.timezone,
      ),
    });

    // The email's sentences are the English in-app ones, as they always were.
    const english = RSVP_CONFIRMED_COPY.en;
    const emailBody = english.body({
      eventTitle: input.eventTitle,
      startsAt: formatEventStart("en", input.startsAtIso, input.timezone),
    });
    const subject = english.title({ eventTitle: input.eventTitle });

    const textLines: string[] = [emailBody];
    if (input.venueName) {
      textLines.push(`Where: ${input.venueName}`);
    }
    if (input.addressText) {
      textLines.push(`Address: ${input.addressText}`);
    }
    if (input.eventUrl) {
      textLines.push(`View the event: ${input.eventUrl}`);
    }
    if (input.manageRsvpsUrl) {
      textLines.push(
        `Changed your plans? Manage your RSVPs: ${input.manageRsvpsUrl}`,
      );
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "rsvp.confirmed",
        eventId: input.eventId,
        startsAtIso: input.startsAtIso,
      },
      inApp: {
        title,
        body: inAppBody,
        kind: "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "rsvp.confirmed",
          variables: {
            eventTitle: input.eventTitle,
            startsAtISO: input.startsAtIso,
            endsAtISO: input.endsAtIso ?? null,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            venueName: input.venueName ?? null,
            addressText: input.addressText ?? null,
            heroImageUrl: input.heroImageUrl ?? null,
            eventUrl: input.eventUrl ?? null,
            manageRsvpsUrl: input.manageRsvpsUrl ?? null,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const rsvpDateCancelledSchema = z
  .object({
    eventId: z.string().uuid(),
    /** The occurrence that is off. Always set — this variant is per-DATE only. */
    eventDateId: z.string().uuid(),
    // Same 200-char slack as rsvp.confirmed.
    eventTitle: z.string().min(1).max(200),
    /** Start of the occurrence that was called off, ISO 8601. */
    startsAtIso: z.string(),
    /** IANA timezone used to format the occurrence time. Null → UTC fallback. */
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    /**
     * Absolute URL of the event page — where the REST of the schedule lives,
     * which is the whole reason this message links anywhere. NULLABLE for the
     * same reason as rsvp.confirmed: the renderer runs before the idempotency
     * claim, so a required URL would dead-letter the message for a slugless
     * event. Losing the link beats losing the notice.
     */
    eventUrl: z.string().url().nullable().optional(),
    /**
     * The WHOLE listing is off (cancelled, archived, or completed with nights
     * still ahead), not just this night.
     * Set by the RSVP drain from the event's status at dispatch time; absent
     * on every one-night call-off and on every row stored before it existed.
     * Switches to the whole-listing copy: no "other dates" link (there are
     * none), but a plain "View event" link when `eventUrl` is set. The drain
     * sets `eventUrl` only for a CANCELLED listing, whose page says "Event
     * cancelled"; `listingCancelled` is set for CANCELLED, ARCHIVED or
     * COMPLETED, and the last two arrive with no `eventUrl`.
     */
    listingCancelled: z.boolean().optional(),
  })
  .strict();

type RsvpDateCancelledInput = z.infer<typeof rsvpDateCancelledSchema>;

/**
 * "That night is off." Sent to everyone holding a live RSVP on ONE occurrence
 * of a recurring community listing when a moderator calls it off.
 *
 * `transactional`, matching `event.cancelled`: this is not a nudge about
 * something that might happen, it is the withdrawal of a specific commitment
 * the recipient made. Someone who muted day-before reminders still has to
 * learn that the night they planned around is not happening.
 *
 * DELIBERATELY NOT A `push` CHANNEL. The listing's OTHER nights are unaffected,
 * so the useful version of this message is "this one night is off, here is the
 * rest of the schedule" — which does not survive a lock-screen line, and a
 * truncated "Weekly Open Mic is cancelled" is a materially worse lie than
 * silence. In-app and email carry it.
 *
 * The copy names the DATE, every time. "Weekly Open Mic has been cancelled" is
 * exactly the sentence this feature exists to avoid sending — while the
 * listing runs. When the listing itself is cancelled, archived or completed
 * (`listingCancelled`), that sentence is the true one: the whole-listing copy
 * says so, once per person, with no link to other dates (only a "View event"
 * link when the drain sent one).
 */
const rsvpDateCancelledRenderer: NotificationRendererDefinition<
  typeof rsvpDateCancelledSchema
> = {
  variant: "rsvp.date_cancelled",
  category: "transactional",
  schema: rsvpDateCancelledSchema,
  render(
    input: RsvpDateCancelledInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      eventDateId: input.eventDateId,
    };

    const tags: Tags = ["rsvp", "date-cancelled"];
    // In-app copy is in the render locale (copy/rsvp.ts); email stays English.
    const copy = RSVP_DATE_CANCELLED_COPY[ctx.locale];
    const english = RSVP_DATE_CANCELLED_COPY.en;
    const listingCancelled = input.listingCancelled === true;

    let title: string;
    let inAppBody: string;
    let subject: string;
    let body: string;
    let action: NotificationAction | null;
    const textLines: string[] = [];

    if (listingCancelled) {
      // The whole listing is off: no date to lead with (one message covers
      // every night the person held), no place, no "other dates" link. The
      // event link rides only when the drain sent one (a CANCELLED listing,
      // whose page says so).
      title = copy.listingTitle({ eventTitle: input.eventTitle });
      inAppBody = copy.listingBody;
      subject = english.listingTitle({ eventTitle: input.eventTitle });
      body = english.listingBody;
      action = eventRouteAction(input.eventUrl, copy.viewEventLabel);
      textLines.push(body);
      if (input.eventUrl) {
        textLines.push(`View the event: ${input.eventUrl}`);
      }
    } else {
      action = eventRouteAction(input.eventUrl, copy.seeOtherDatesLabel);

      // The date leads, not the title: the recipient RSVP'd to ONE night of
      // something that is still running, and the only question they have is
      // which night.
      const inAppCopy = {
        eventTitle: input.eventTitle,
        startsAt: formatEventStart(ctx.locale, input.startsAtIso, input.timezone),
      };
      title = copy.title(inAppCopy);
      inAppBody = copy.body(inAppCopy);

      const emailCopy = {
        eventTitle: input.eventTitle,
        startsAt: formatEventStart("en", input.startsAtIso, input.timezone),
      };
      subject = english.title(emailCopy);
      body = english.body(emailCopy);

      textLines.push(body);
      if (input.venueName) {
        textLines.push(`Where it would have been: ${input.venueName}`);
      }
      if (input.eventUrl) {
        textLines.push(`See the other dates: ${input.eventUrl}`);
      }
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "rsvp.date_cancelled",
        eventId: input.eventId,
        eventDateId: input.eventDateId,
        startsAtIso: input.startsAtIso,
        // Only when set, so a one-night call-off's fingerprint is unchanged.
        ...(listingCancelled ? { listingCancelled: true } : {}),
      },
      inApp: {
        title,
        body: inAppBody,
        // WARNING, not ERROR: nothing went wrong, but this is a plan the
        // recipient has to change.
        kind: "WARNING",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "rsvp.date_cancelled",
          variables: {
            eventTitle: input.eventTitle,
            startsAtISO: input.startsAtIso,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            venueName: input.venueName ?? null,
            heroImageUrl: input.heroImageUrl ?? null,
            eventUrl: input.eventUrl ?? null,
            ...(listingCancelled ? { listingCancelled: true } : {}),
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const rsvpReminderSchema = z
  .object({
    eventId: z.string().uuid(),
    /**
     * The occurrence this reminder is about, for a per-date RSVP on a recurring
     * listing. NULL for an event-level RSVP. Part of the fingerprint so two
     * dates of the same listing never collapse into one notification.
     */
    eventDateId: z.string().uuid().nullable().optional(),
    // Same 200-char slack as rsvp.confirmed: titles are capped at 140 on
    // input, so a hostile/oversized one can't bloat the notification.
    eventTitle: z.string().min(1).max(200),
    startsAtIso: z.string(),
    endsAtIso: z.string().nullable().optional(),
    /** IANA timezone the date/time is rendered in. Null → platform default. */
    timezone: z.string().nullable().optional(),
    venueName: z.string().nullable().optional(),
    addressText: z.string().nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    /**
     * Absolute URL of the event page — where the RSVP toggle (= cancel) lives.
     * NULLABLE for the same reason as rsvp.confirmed: the renderer runs BEFORE
     * notify's idempotency claim, so a required `.url()` on a slugless event
     * would throw and lose the reminder entirely. Losing the link beats losing
     * the reminder.
     */
    eventUrl: z.string().url().nullable().optional(),
    /** Absolute URL of the recipient's /my-rsvps list. Nullable, same reason. */
    manageRsvpsUrl: z.string().url().nullable().optional(),
  })
  .strict();

type RsvpReminderInput = z.infer<typeof rsvpReminderSchema>;

/**
 * Local calendar-day parts of an instant in a given IANA zone.
 *
 * Deliberately `Intl.DateTimeFormat.formatToParts` rather than arithmetic on
 * the epoch: "is this the next calendar day" is a WALL-CLOCK question in the
 * LISTING's timezone, and a fixed 86_400_000ms offset gets it wrong across a
 * DST boundary and across every zone that is not the server's. Returns null
 * for an unparseable instant so callers can fall back to the plain date.
 */
function localCalendarDay(
  date: Date,
  timezone: string | null | undefined,
): string | null {
  if (Number.isNaN(date.getTime())) return null;
  // A missing or unknown IANA id reads in the platform default, the same
  // zone formatEventStart falls back to, so "Tomorrow" and the printed date
  // always agree. resolveTimeZone validates the id: the formatter cannot throw.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * "Today" / "Tomorrow" / null, measured in the LISTING's timezone.
 *
 * A 24h lead almost always lands on "tomorrow", but the job's catch-up window
 * means a reminder can legitimately go out with an 18–24h lead, and an event
 * just after midnight local is then TODAY. Saying "tomorrow" to someone whose
 * show is tonight is the kind of wrong that erodes trust in the whole channel,
 * so the label is derived rather than assumed.
 */
function rsvpReminderDayLabel(
  now: Date,
  startsAt: Date,
  timezone: string | null | undefined,
): "Today" | "Tomorrow" | null {
  const today = localCalendarDay(now, timezone);
  const start = localCalendarDay(startsAt, timezone);
  if (!today || !start) return null;
  if (today === start) return "Today";
  // "Tomorrow" = the local calendar date one day after today's. Both sides are
  // Y-M-D strings from the SAME zone-aware formatter, so stepping the triple
  // forward is plain Gregorian calendar arithmetic with no timezone and no DST
  // in it — which is the only way this comparison is correct in every zone.
  const [y, m, d] = today.split("-").map((part) => Number(part));
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d)
  ) {
    return null;
  }
  // Date.UTC + getUTC* does pure calendar arithmetic on the already-localized
  // Y-M-D triple — no timezone is involved, so no DST can perturb it.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextKey = `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(
    next.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return start === nextKey ? "Tomorrow" : null;
}

/**
 * Attendee-facing 24h-before reminder for a community RSVP — per DATE on a
 * recurring listing, per EVENT on a single-date one. Sent by the
 * `community.rsvp-reminders-24h` job.
 *
 * Category is `reminders`, NOT `transactional`: the point of the feature is
 * that a person can keep their RSVP confirmation and still switch the
 * day-before nudge off (globally, or for one listing via the EVENT-scoped
 * preference).
 */
const rsvpReminderRenderer: NotificationRendererDefinition<
  typeof rsvpReminderSchema
> = {
  variant: "rsvp.reminder",
  category: "reminders",
  schema: rsvpReminderSchema,
  render(
    input: RsvpReminderInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      ...(input.eventDateId ? { eventDateId: input.eventDateId } : {}),
    };

    const tags: Tags = ["rsvp", "reminder"];
    // In-app copy is in the render locale (copy/rsvp.ts); email and push stay
    // English, built from the same copy's English entry.
    const copy = RSVP_REMINDER_COPY[ctx.locale];
    const action = eventRouteAction(
      input.eventUrl,
      COMMON_COPY[ctx.locale].viewEvent,
    );

    const startsAt = new Date(input.startsAtIso);
    const dayLabel = rsvpReminderDayLabel(ctx.now, startsAt, input.timezone);
    const formatted = formatEventStart(
      "en",
      input.startsAtIso,
      input.timezone,
    );

    const inAppTitle = copy.title({ eventTitle: input.eventTitle, dayLabel });
    const inAppBody = copy.body({
      eventTitle: input.eventTitle,
      dayLabel,
      startsAt: formatEventStart(ctx.locale, input.startsAtIso, input.timezone),
    });
    const english = RSVP_REMINDER_COPY.en;
    const title = english.title({ eventTitle: input.eventTitle, dayLabel });
    const body = english.body({
      eventTitle: input.eventTitle,
      dayLabel,
      startsAt: formatted,
    });
    const subject = title;

    const textLines: string[] = [
      `${body} You said you're going.`,
    ];
    if (input.venueName) {
      textLines.push(`Where: ${input.venueName}`);
    }
    if (input.addressText) {
      textLines.push(`Address: ${input.addressText}`);
    }
    if (input.eventUrl) {
      textLines.push(`View the event: ${input.eventUrl}`);
    }
    if (input.manageRsvpsUrl) {
      textLines.push(
        `Plans changed? Manage your RSVPs: ${input.manageRsvpsUrl}`,
      );
    }

    return {
      category: "reminders",
      fingerprint: {
        variant: "rsvp.reminder",
        eventId: input.eventId,
        eventDateId: input.eventDateId ?? null,
        startsAtIso: input.startsAtIso,
      },
      inApp: {
        title: inAppTitle,
        body: inAppBody,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body: formatted ? `Starts ${formatted}. Tap for details.` : body,
        // One reminder per subject, so the collapse key is the subject: a
        // re-delivery replaces rather than stacks on the lock screen.
        collapseKey: `rsvp-reminder-${input.eventDateId ?? input.eventId}`,
        data: {
          eventId: input.eventId,
          ...(input.eventDateId ? { eventDateId: input.eventDateId } : {}),
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "rsvp.reminder",
          variables: {
            eventTitle: input.eventTitle,
            dayLabel: dayLabel ?? null,
            startsAtISO: input.startsAtIso,
            endsAtISO: input.endsAtIso ?? null,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            venueName: input.venueName ?? null,
            addressText: input.addressText ?? null,
            heroImageUrl: input.heroImageUrl ?? null,
            eventUrl: input.eventUrl ?? null,
            manageRsvpsUrl: input.manageRsvpsUrl ?? null,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const settlementPayoutCompletedSchema = z
  .object({
    payeeId: z.string().uuid(),
    payoutId: z.string().uuid(),
    payoutItemId: z.string().uuid(),
    /**
     * For `kind: "payout"` (default), the NET cents that landed in the
     * payee's account. For `kind: "applied_to_balance"`, the cents withheld
     * and applied against their outstanding lost-dispute balance. For
     * `kind: "reserved"`, the cents deferred into the rolling reserve.
     */
    amountCents: z.number().int(),
    currency: z.string().min(1),
    settlementCount: z.number().int(),
    /**
     * `applied_to_balance` = debt recovery consumed the whole payout;
     * `reserved` = the rolling reserve deferred the whole payout. In both,
     * no bank transfer was sent, so the copy must never say "you've been
     * paid" — it says "applied to your balance" / "held in reserve" instead.
     * Optional; omitted behaves as "payout" so existing senders are
     * untouched.
     */
    kind: z.enum(["payout", "applied_to_balance", "reserved"]).optional(),
    payoutDateIso: z.string().datetime({ offset: true }).optional(),
    payoutsUrl: z.string().url().optional(),
    // ── Enrichment (all optional) ─────────────────────────────────────────
    // Everything below feeds the `settlement.payout_sent` email template and
    // the plain-text fallback. Optional AND nullable so a legacy payload
    // (the six fields above) still parses and renders with defaults, and
    // the fingerprint — which never reads these — stays byte-identical.
    /** ORGANIZATION payee's name; null for a HUMAN payee. */
    orgName: z.string().max(200).nullable().optional(),
    /** IANA zone the email's dates are shown in. Defaults to UTC. */
    displayTimezone: z.string().min(1).max(64).optional(),
    /** One row per consumed credit — "where it came from". */
    lines: z
      .array(
        z
          .object({
            eventTitle: z.string().max(200).nullable(),
            eventStartsAtIso: z.string().datetime({ offset: true }).nullable(),
            eventTimezone: z.string().min(1).max(64).nullable(),
            ticketCount: z.number().int().nonnegative().nullable(),
            amountCents: z.number().int(),
            orderId: z.string().nullable(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    recoveredDebtCents: z.number().int().nonnegative().optional(),
    connectAccountFeeCents: z.number().int().nonnegative().optional(),
    reserveHeldCents: z.number().int().nonnegative().optional(),
    /** Matured reserve returned on this payout — rides the transfer. */
    reserveReleasedCents: z.number().int().nonnegative().optional(),
    /** Credits the line cap dropped, and their total, so sales still sum. */
    otherSalesCount: z.number().int().nonnegative().optional(),
    otherSalesCents: z.number().int().nonnegative().optional(),
    /** Ledger balance still owed AFTER this payout; null = read failed. */
    balanceAfterCents: z.number().int().nullable().optional(),
    nextPayableAtIso: z.string().datetime({ offset: true }).nullable().optional(),
    /** Connected account's Stripe payout delay; null = say nothing. */
    bankDelayDays: z.number().int().nonnegative().nullable().optional(),
    stripeDashboardUrl: z.string().url().optional(),
  })
  .strict();

type SettlementPayoutCompletedInput = z.infer<
  typeof settlementPayoutCompletedSchema
>;

/**
 * Props of @th/ui-email's `settlement.payout_sent` template. Mirrored here
 * (rather than imported) so core never depends on the email package; the
 * renderer tests pin the exact shape and a mismatch fails there, not as a
 * `render_failed` after the idempotency key is claimed.
 */
type PayoutSentTemplateVariables = {
  kind: "payout" | "reserved" | "applied_to_balance";
  amountCents: number;
  currency: string;
  orgName: string | null;
  payoutDateIso: string;
  displayTimezone: string;
  lines: Array<{
    eventTitle: string | null;
    eventStartsAtIso: string | null;
    eventTimezone: string | null;
    ticketCount: number | null;
    amountCents: number;
    orderId: string | null;
  }>;
  recoveredDebtCents: number;
  connectAccountFeeCents: number;
  reserveHeldCents: number;
  reserveReleasedCents: number;
  otherSalesCount: number;
  otherSalesCents: number;
  /**
   * SIGNED residual that makes the statement reconcile exactly (a refund
   * debit shrinks the payable but not the credit rows, so Σsales can exceed
   * what was sent). 0 = the template omits the row.
   */
  adjustmentsCents: number;
  balanceAfterCents: number | null;
  nextPayableAtIso: string | null;
  bankDelayDays: number | null;
  payoutsUrl: string | null;
  stripeDashboardUrl: string;
  settlementCount: number;
};

const PAYOUT_SENT_TEMPLATE_KEY = "settlement.payout_sent";

/**
 * Stripe Express accounts have no per-account dashboard URL; this login
 * endpoint is the one Stripe documents for "open your dashboard".
 */
const STRIPE_EXPRESS_DASHBOARD_URL = "https://connect.stripe.com/express_login";

/**
 * "Sun 20 Sep" (short) / "Sunday 20 September" (long) in the given zone —
 * day-month order to match the HTML template. Built from parts because
 * `format()` for "en" is month-day. An unknown zone falls back to UTC; the
 * notifier probes zones (and reports) before they get here, so this catch
 * is belt-and-braces only.
 */
function formatPayoutDate(
  iso: string,
  timeZone: string,
  style: "short" | "long" = "short",
): string {
  const options: Intl.DateTimeFormatOptions =
    style === "short"
      ? { weekday: "short", day: "numeric", month: "short" }
      : { weekday: "long", day: "numeric", month: "long" };
  const date = new Date(iso);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en", { ...options, timeZone }).formatToParts(
      date,
    );
  } catch {
    parts = new Intl.DateTimeFormat("en", {
      ...options,
      timeZone: "UTC",
    }).formatToParts(date);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

/** Longest label the dot leaders align to; a longer one just gets 2 dots. */
const LEADER_LABEL_MAX = 40;

/**
 * Plain-text statement rows: `label ...... value`, dots padded so the values
 * line up down the block (the text fallback has no table). Event titles run
 * to 140 chars, so the alignment column is capped rather than letting one
 * long title push every other value off the right edge.
 */
function dotLeaderRows(rows: Array<[label: string, value: string]>): string[] {
  const width =
    Math.min(
      LEADER_LABEL_MAX,
      Math.max(0, ...rows.map(([label]) => label.length)),
    ) + 2;
  return rows.map(
    ([label, value]) =>
      `${label} ${".".repeat(Math.max(2, width - label.length))} ${value}`,
  );
}

const settlementPayoutCompletedRenderer: NotificationRendererDefinition<
  typeof settlementPayoutCompletedSchema
> = {
  variant: "settlement.payout-completed",
  category: "transactional",
  schema: settlementPayoutCompletedSchema,
  render(
    input: SettlementPayoutCompletedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const amount = formatCents(input.amountCents, input.currency);
    // `settlementCount` counts consumed CREDITS (≈ orders), not events.
    const kind = input.kind ?? "payout";
    const appliedToBalance = kind === "applied_to_balance";
    const reserved = kind === "reserved";

    // Defaults for the enrichment a legacy (six-field) payload lacks.
    const orgName = input.orgName ?? null;
    const displayTimezone = input.displayTimezone ?? "UTC";
    const payoutDateIso = input.payoutDateIso ?? ctx.now.toISOString();
    const lines = input.lines ?? [];
    const recoveredDebtCents = input.recoveredDebtCents ?? 0;
    const connectAccountFeeCents = input.connectAccountFeeCents ?? 0;
    const reserveHeldCents = input.reserveHeldCents ?? 0;
    const reserveReleasedCents = input.reserveReleasedCents ?? 0;
    const balanceAfterCents = input.balanceAfterCents ?? null;
    const nextPayableAtIso = input.nextPayableAtIso ?? null;
    const bankDelayDays = input.bankDelayDays ?? null;
    const payoutsUrl = input.payoutsUrl ?? null;
    const stripeDashboardUrl =
      input.stripeDashboardUrl ?? STRIPE_EXPRESS_DASHBOARD_URL;

    // ── Reconciliation ────────────────────────────────────────────────
    // The statement must sum to zero BY CONSTRUCTION:
    //   Σlines + otherSales + reserveReleased + adjustments
    //     − debtRow − fee − reserveRow === amountCents
    // For `payout` that is exactly the contract identity (debtRow = debt,
    // reserveRow = reserveHeld). For `reserved` / `applied_to_balance`,
    // `amountCents` IS the reserve / the debt and is shown as the single
    // destination row, so that same withholding is excluded from the
    // deductions — listing it twice would double-count it and the literal
    // identity would be off by exactly that amount. The residual absorbs
    // what the rows cannot explain (a refund debit shrinks the payable but
    // not the SETTLEMENT_CREDIT rows), signed, and 0 means "omit".
    const debtRowCents = appliedToBalance ? 0 : recoveredDebtCents;
    const reserveRowCents = reserved ? 0 : reserveHeldCents;
    const linesCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
    // A legacy payload has no per-order lines at all: every sale is "other",
    // at the gross the deductions reconcile to, so the residual is 0.
    const legacy = input.lines === undefined;
    const otherSalesCount = legacy
      ? input.settlementCount
      : (input.otherSalesCount ?? 0);
    const otherSalesCents = legacy
      ? input.amountCents +
        debtRowCents +
        connectAccountFeeCents +
        reserveRowCents -
        reserveReleasedCents
      : (input.otherSalesCents ?? 0);
    const adjustmentsCents =
      input.amountCents +
      debtRowCents +
      connectAccountFeeCents +
      reserveRowCents -
      reserveReleasedCents -
      linesCents -
      otherSalesCents;

    const templateVariables: PayoutSentTemplateVariables = {
      kind,
      amountCents: input.amountCents,
      currency: input.currency,
      orgName,
      payoutDateIso,
      displayTimezone,
      lines,
      recoveredDebtCents,
      connectAccountFeeCents,
      reserveHeldCents,
      reserveReleasedCents,
      otherSalesCount,
      otherSalesCents,
      adjustmentsCents,
      balanceAfterCents,
      nextPayableAtIso,
      bankDelayDays,
      payoutsUrl,
      stripeDashboardUrl,
      settlementCount: input.settlementCount,
    };

    const metadata: Metadata = {
      payoutId: input.payoutId,
      payoutItemId: input.payoutItemId,
      payeeId: input.payeeId,
      currency: input.currency,
    };

    const tags: Tags = ["settlement", "payout", "completed"];
    // `applied_to_balance`: the whole payout was withheld against the payee's
    // outstanding balance from a lost dispute — no money moved, so "you've
    // been paid" would be a lie and silence would look like a missing payout.
    // `reserved`: the whole payout was deferred into the rolling reserve —
    // also no transfer, but the money is still THEIRS, so the copy must say
    // "held and coming back", never "applied" (that would read as taken).
    // "was sent to your Stripe account", never "is on its way to your bank":
    // we send it; when it arrives is Stripe's and the bank's business.
    // In-app copy is in the render locale (copy/money.ts); email stays English.
    const payoutCopy = PAYOUT_COMPLETED_COPY[ctx.locale];
    const title = payoutCopy.title(kind);
    const body = payoutCopy.body({
      kind,
      amount,
      salesCount: input.settlementCount,
    });
    const action = payoutsUrl
      ? {
          label: payoutCopy.viewPayoutsLabel,
          href: payoutsUrl,
        }
      : null;

    // ── Plain-text statement ───────────────────────────────────────────
    // Structured like the HTML template: headline amount, when it moves,
    // where it came from, what was withheld, what is still owed. Never
    // says "paid" for the no-transfer kinds.
    const money = (cents: number) => formatCents(cents, input.currency);
    const negative = (cents: number) => `−${money(cents)}`;
    const signed = (cents: number) =>
      cents < 0 ? negative(-cents) : `+${money(cents)}`;
    const payoutDate = formatPayoutDate(payoutDateIso, displayTimezone);
    const payoutDateLong = formatPayoutDate(
      payoutDateIso,
      displayTimezone,
      "long",
    );

    const text: string[] = [
      `ITHAS FIRE — ${appliedToBalance ? "PAYOUT APPLIED" : reserved ? "PAYOUT HELD" : "PAYOUT"} · ${payoutDate}`,
      "",
      amount,
      appliedToBalance
        ? `Applied to your outstanding balance on ${payoutDateLong}. No bank transfer was sent.`
        : reserved
          ? `Held in reserve on ${payoutDateLong}. It comes back with a future payout. No bank transfer was sent.`
          : `Sent to your Stripe account on ${payoutDateLong}.`,
    ];

    if (!appliedToBalance && !reserved) {
      // Timing is only stated when the account's delay is KNOWN — a guessed
      // "2 days" that turns into 7 is worse than silence.
      const bankTiming =
        bankDelayDays === null
          ? "on Stripe's schedule"
          : `on Stripe's schedule, about ${bankDelayDays} ${bankDelayDays === 1 ? "day" : "days"} for this account`;
      text.push(
        "",
        ...dotLeaderRows([
          ["We sent it", payoutDate],
          ["Your bank", bankTiming],
        ]),
      );
    }

    const sourceRows: Array<[string, string]> = lines.map((line) => {
      const detail: string[] = [];
      if (line.eventStartsAtIso) {
        detail.push(
          formatPayoutDate(
            line.eventStartsAtIso,
            line.eventTimezone ?? displayTimezone,
          ),
        );
      }
      if (line.ticketCount !== null) {
        detail.push(
          `${line.ticketCount} ${line.ticketCount === 1 ? "ticket" : "tickets"}`,
        );
      }
      const label = `${line.eventTitle ?? "Sale"}${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`;
      return [label, money(line.amountCents)];
    });
    if (otherSalesCount > 0) {
      // With no itemised lines this IS the sales row, not an "other" one.
      sourceRows.push(
        lines.length === 0
          ? [`${otherSalesCount} ${otherSalesCount === 1 ? "sale" : "sales"}`, money(otherSalesCents)]
          : [
              `${otherSalesCount} other ${otherSalesCount === 1 ? "sale" : "sales"}`,
              signed(otherSalesCents),
            ],
      );
    }
    if (reserveReleasedCents > 0) {
      sourceRows.push([
        "Reserve released back to you",
        signed(reserveReleasedCents),
      ]);
    }

    // The row that IS this notification's amount (the reserve for
    // `reserved`, the debt for `applied_to_balance`) is the destination row
    // below, not a deduction — see the reconciliation note above.
    const withholdingRows: Array<[string, string]> = [];
    if (debtRowCents > 0) {
      withholdingRows.push([
        "Applied to an earlier refund",
        negative(debtRowCents),
      ]);
    }
    if (connectAccountFeeCents > 0) {
      withholdingRows.push([
        "Stripe account fee withheld",
        negative(connectAccountFeeCents),
      ]);
    }
    if (reserveRowCents > 0) {
      withholdingRows.push(["Held in reserve", negative(reserveRowCents)]);
    }
    if (adjustmentsCents !== 0) {
      withholdingRows.push(["Other adjustments", signed(adjustmentsCents)]);
    }

    const destinationRow: [string, string] = appliedToBalance
      ? ["Applied to your outstanding balance", negative(input.amountCents)]
      : reserved
        ? ["Held in reserve", negative(input.amountCents)]
        : ["Sent to your Stripe account", negative(input.amountCents)];

    const balanceRows: Array<[string, string]> = [];
    if (balanceAfterCents !== null) {
      const owedTo = orgName ?? "you";
      const nextPayout =
        balanceAfterCents > 0 && nextPayableAtIso
          ? ` — next payout ${formatPayoutDate(nextPayableAtIso, displayTimezone)}`
          : "";
      balanceRows.push([
        `Still owed to ${owedTo}`,
        `${money(balanceAfterCents)}${nextPayout}`,
      ]);
    }

    text.push(
      "",
      "WHERE IT CAME FROM",
      ...dotLeaderRows([
        ...sourceRows,
        ...withholdingRows,
        destinationRow,
        ...balanceRows,
      ]),
    );

    const closing: string[] = [];
    // Also gated on the release: a "+$20.00" row directly above "Nothing
    // was withheld" reads as a contradiction — the sum is no longer just
    // these sales. Mirrors the HTML template's gate exactly.
    const nothingWithheld =
      !appliedToBalance &&
      !reserved &&
      recoveredDebtCents === 0 &&
      connectAccountFeeCents === 0 &&
      reserveHeldCents === 0 &&
      reserveReleasedCents === 0 &&
      adjustmentsCents === 0;
    if (nothingWithheld) {
      closing.push("Nothing was withheld.");
    }
    // Mirrors the HTML template's balance sentence exactly: a positive
    // balance is "still coming"; zero is kind-aware ("waiting to be paid"
    // only makes sense when this payout actually paid); negative says
    // NOTHING here — the Still-owed row already shows the signed figure, and
    // any sentence would either soften a debt or read as a threat.
    if (balanceAfterCents !== null && balanceAfterCents > 0) {
      closing.push(`${money(balanceAfterCents)} is still coming.`);
    } else if (balanceAfterCents === 0) {
      closing.push(
        appliedToBalance || reserved
          ? "Nothing else is outstanding."
          : "Nothing else is waiting to be paid.",
      );
    }
    if (closing.length > 0) {
      text.push("", closing.join(" "));
    }

    text.push("");
    if (payoutsUrl) {
      text.push(`View payouts: ${payoutsUrl}`);
    }
    text.push(`Stripe dashboard: ${stripeDashboardUrl}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "settlement.payout-completed",
        payoutItemId: input.payoutItemId,
        amountCents: input.amountCents,
        currency: input.currency,
      },
      inApp: {
        title,
        body,
        // INFO for the no-transfer paths: nothing to celebrate, but nothing
        // went wrong either — the payee owed the money (debt) or will get it
        // back (reserve).
        kind: appliedToBalance || reserved ? "INFO" : "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        // "covered", not "was applied to": the latter reads as money taken.
        subject: appliedToBalance
          ? `Your ${amount} payout covered your outstanding balance`
          : reserved
            ? `Your ${amount} payout is being held in reserve`
            : `You've been paid ${amount}`,
        text: text.join("\n"),
        template: {
          key: PAYOUT_SENT_TEMPLATE_KEY,
          variables: templateVariables,
        },
        tags,
        metadata,
      },
    };
  },
};

const orderConfirmedSchema = z
  .object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    /** Number of tickets issued on this order. */
    ticketCount: z.number().int().positive(),
    /** Buyer-facing total paid, in minor units (cents). */
    amountCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
  })
  .strict();

type OrderConfirmedInput = z.infer<typeof orderConfirmedSchema>;

/**
 * Buyer-facing: a primary checkout finalized and tickets were issued.
 * In-app (+ push) only — the receipt email is sent separately by
 * `sendTicketIssuedEmail`, so this variant deliberately omits the email
 * channel to avoid double-sending.
 */
const orderConfirmedRenderer: NotificationRendererDefinition<
  typeof orderConfirmedSchema
> = {
  variant: "order.confirmed",
  category: "transactional",
  schema: orderConfirmedSchema,
  render(
    input: OrderConfirmedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const amount = formatCents(input.amountCents, input.currency);
    const isSingle = input.ticketCount === 1;
    const ticketWord = isSingle ? "ticket" : "tickets";
    const ticketSummary = `${input.ticketCount} ${ticketWord}`;
    const verb = isSingle ? "is" : "are";

    const metadata: Metadata = {
      orderId: input.orderId,
      eventId: input.eventId,
      ticketCount: String(input.ticketCount),
      currency: input.currency,
    };

    const tags: Tags = ["order", "confirmed"];
    // In-app copy is in the render locale (copy/money.ts); push stays English.
    const copy = ORDER_CONFIRMED_COPY[ctx.locale];
    const title = copy.title({ eventTitle: input.eventTitle });
    const body = copy.body({
      eventTitle: input.eventTitle,
      ticketCount: input.ticketCount,
      amount,
    });
    const pushTitle = ORDER_CONFIRMED_COPY.en.title({
      eventTitle: input.eventTitle,
    });
    const action = { label: copy.viewTicketsLabel, route: "/my-tickets" };

    return {
      category: "transactional",
      fingerprint: {
        variant: "order.confirmed",
        orderId: input.orderId,
        eventId: input.eventId,
        ticketCount: input.ticketCount,
        amountCents: input.amountCents,
        currency: input.currency,
      },
      inApp: {
        title,
        body,
        kind: "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: pushTitle,
        body: `Your ${ticketSummary} for ${input.eventTitle} ${verb} confirmed.`,
        collapseKey: `order-${input.orderId}`,
        data: { orderId: input.orderId, eventId: input.eventId },
        tags,
        metadata,
        template: null,
      },
    };
  },
};

const orderRefundProcessedSchema = z
  .object({
    orderId: z.string().uuid(),
    refundId: z.string().min(1),
    eventId: z.string().uuid().nullable().optional(),
    eventTitle: z.string().min(1).nullable().optional(),
    /** Total amount refunded to the buyer, in minor units (cents). */
    amountCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    /** Whether the whole order or only part of it was refunded. */
    status: z.enum(["REFUNDED", "PART_REFUNDED"]),
    /**
     * How many tickets this refund returned. Optional: notifications stored
     * before 2026-10-11 do not carry it. Read only by the no-money copy
     * (singular / plural); absent reads as one ticket.
     */
    ticketCount: z.number().int().positive().optional(),
  })
  .strict();

type OrderRefundProcessedInput = z.infer<typeof orderRefundProcessedSchema>;

/**
 * Buyer-facing: a refund finished processing on the buyer's order.
 * In-app (+ push) only: this variant has no email channel.
 *
 * A refund of $0 (`amountCents === 0`: every ticket returned cost the buyer
 * $0, so no money moved) renders the "ticket returned" copy instead, on both
 * channels. Nothing is on its way back to a payment method in that case.
 */
const orderRefundProcessedRenderer: NotificationRendererDefinition<
  typeof orderRefundProcessedSchema
> = {
  variant: "order.refund-processed",
  category: "transactional",
  schema: orderRefundProcessedSchema,
  render(
    input: OrderRefundProcessedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const amount = formatCents(input.amountCents, input.currency);
    const eventFragment = input.eventTitle ? ` for ${input.eventTitle}` : "";
    const isPartial = input.status === "PART_REFUNDED";

    const metadata: Metadata = {
      orderId: input.orderId,
      refundId: input.refundId,
      currency: input.currency,
      status: input.status,
    };
    if (input.eventId) {
      metadata.eventId = input.eventId;
    }

    const tags: Tags = ["order", "refund", "processed"];
    // In-app copy is in the render locale (copy/money.ts); push stays English.
    const copy = ORDER_REFUND_PROCESSED_COPY[ctx.locale];
    // No money moved: the tickets were returned and cost nothing.
    const isNoCharge = input.amountCents === 0;
    const returnedValues = {
      ticketCount: input.ticketCount ?? 1,
      eventTitle: input.eventTitle,
    };
    const title = isNoCharge
      ? ORDER_TICKET_RETURNED_COPY[ctx.locale].title(returnedValues)
      : copy.title({ partial: isPartial });
    const body = isNoCharge
      ? ORDER_TICKET_RETURNED_COPY[ctx.locale].body(returnedValues)
      : copy.body({
          partial: isPartial,
          amount,
          eventTitle: input.eventTitle,
        });
    const pushTitle = isNoCharge
      ? ORDER_TICKET_RETURNED_COPY.en.title(returnedValues)
      : ORDER_REFUND_PROCESSED_COPY.en.title({
          partial: isPartial,
        });
    const pushBody = isNoCharge
      ? ORDER_TICKET_RETURNED_COPY.en.body(returnedValues)
      : `${amount}${eventFragment} is on its way back to your payment method.`;
    const action = { label: copy.viewOrdersLabel, route: "/my-tickets" };

    return {
      category: "transactional",
      fingerprint: {
        variant: "order.refund-processed",
        orderId: input.orderId,
        refundId: input.refundId,
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
      },
      inApp: {
        title,
        body,
        // A returned $0 ticket is information, not money arriving.
        kind: isNoCharge ? "INFO" : "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: pushTitle,
        body: pushBody,
        collapseKey: `refund-${input.refundId}`,
        data: { orderId: input.orderId, refundId: input.refundId },
        tags,
        metadata,
        template: null,
      },
    };
  },
};

const resalePurchaseConfirmedSchema = z
  .object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    /** Buyer-facing total paid for the resale ticket, in minor units (cents). */
    amountCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
  })
  .strict();

type ResalePurchaseConfirmedInput = z.infer<
  typeof resalePurchaseConfirmedSchema
>;

/**
 * Buyer-facing: a resale purchase finalized and the ticket was transferred
 * to the buyer (with a fresh QR code). Mirrors the seller-side
 * `notifyResaleSellerSold` notification. In-app (+ push) only — the buyer
 * receipt email is sent separately by `sendResalePurchaseEmail`, so this
 * variant deliberately omits the email channel to avoid double-sending.
 */
const resalePurchaseConfirmedRenderer: NotificationRendererDefinition<
  typeof resalePurchaseConfirmedSchema
> = {
  variant: "resale.purchase-confirmed",
  category: "transactional",
  schema: resalePurchaseConfirmedSchema,
  render(
    input: ResalePurchaseConfirmedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const amount = formatCents(input.amountCents, input.currency);

    const metadata: Metadata = {
      orderId: input.orderId,
      eventId: input.eventId,
      currency: input.currency,
    };

    const tags: Tags = ["resale", "purchase", "confirmed"];
    // In-app copy is in the render locale (copy/money.ts); push stays English.
    const copy = RESALE_PURCHASE_CONFIRMED_COPY[ctx.locale];
    const title = copy.title({ eventTitle: input.eventTitle });
    const body = copy.body({ eventTitle: input.eventTitle, amount });
    const pushTitle = RESALE_PURCHASE_CONFIRMED_COPY.en.title({
      eventTitle: input.eventTitle,
    });
    const action = { label: copy.viewTicketLabel, route: "/my-tickets" };

    return {
      category: "transactional",
      fingerprint: {
        variant: "resale.purchase-confirmed",
        orderId: input.orderId,
        eventId: input.eventId,
        amountCents: input.amountCents,
        currency: input.currency,
      },
      inApp: {
        title,
        body,
        kind: "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title: pushTitle,
        body: `Your resale ticket for ${input.eventTitle} is confirmed.`,
        collapseKey: `order-${input.orderId}`,
        data: { orderId: input.orderId, eventId: input.eventId },
        tags,
        metadata,
        template: null,
      },
    };
  },
};

const volunteerSignupReceivedSchema = z
  .object({
    /** Set on event-path signups; null/absent for generic ask signups. */
    eventId: z.string().uuid().nullable().optional(),
    /** Set on generic ask signups (generic-volunteering-asks A4). */
    askId: z.string().uuid().nullable().optional(),
    /** Container title: event title (event path) or ask title (ask path). */
    eventTitle: z.string().min(1),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    signupId: z.string().uuid(),
    status: z.enum(["PENDING", "APPROVED"]),
    shiftLabel: z.string().min(1).nullable().optional(),
    shiftStartsAtIso: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
    shiftEndsAtIso: z.string().datetime({ offset: true }).nullable().optional(),
    /**
     * IANA zone the shift window renders in (the event's, or the ask's).
     * Null/absent → the renderer's runtime zone, UTC on the server.
     */
    timezone: z.string().min(1).max(100).nullable().optional(),
    accountCompletionUrl: z.string().url().nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  })
  .strict();

type VolunteerSignupReceivedInput = z.infer<
  typeof volunteerSignupReceivedSchema
>;

const volunteerSignupReceivedRenderer: NotificationRendererDefinition<
  typeof volunteerSignupReceivedSchema
> = {
  variant: "volunteer.signup-received",
  category: "transactional",
  schema: volunteerSignupReceivedSchema,
  render(
    input: VolunteerSignupReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      roleId: input.roleId,
      signupId: input.signupId,
      status: input.status,
    };
    if (input.eventId) metadata.eventId = input.eventId;
    if (input.askId) metadata.askId = input.askId;
    if (input.accountCompletionUrl) {
      metadata.accountCompletionUrl = input.accountCompletionUrl;
    }

    const tags: Tags = ["volunteer", "signup", "received"];
    const isApproved = input.status === "APPROVED";
    // In-app copy is in the render locale (copy/volunteer-signups.ts); the
    // email keeps the English sentences it always had.
    const copy = VOLUNTEER_SIGNUP_RECEIVED_COPY[ctx.locale];
    const english = VOLUNTEER_SIGNUP_RECEIVED_COPY.en;
    const copyVars = {
      eventTitle: input.eventTitle,
      roleName: input.roleName,
      approved: isApproved,
    };
    const title = copy.title(copyVars);
    const inAppBody = copy.body(copyVars);
    const body = english.body(copyVars);
    const subject = english.title({
      eventTitle: input.eventTitle,
      approved: false,
    });

    const textLines: string[] = [body];
    if (input.shiftLabel) {
      textLines.push(`Shift: ${input.shiftLabel}`);
    }
    if (input.accountCompletionUrl) {
      textLines.push(`Complete your account: ${input.accountCompletionUrl}`);
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.signup-received",
        signupId: input.signupId,
        eventId: input.eventId ?? null,
        askId: input.askId ?? null,
        roleId: input.roleId,
        status: input.status,
        shiftLabel: input.shiftLabel ?? null,
        shiftStartsAtIso: input.shiftStartsAtIso ?? null,
        shiftEndsAtIso: input.shiftEndsAtIso ?? null,
        accountCompletionUrl: input.accountCompletionUrl ?? null,
      },
      inApp: {
        title,
        body: inAppBody,
        kind: isApproved ? "SUCCESS" : "INFO",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "volunteer.signup_received",
          variables: {
            eventTitle: input.eventTitle,
            roleName: input.roleName,
            shiftLabel: input.shiftLabel ?? null,
            shiftStartsAtISO: input.shiftStartsAtIso ?? null,
            shiftEndsAtISO: input.shiftEndsAtIso ?? null,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            status: input.status,
            accountCompletionUrl: input.accountCompletionUrl ?? null,
            organizerContactEmail: input.organizerContactEmail ?? null,
          },
        },
        replyTo: input.organizerContactEmail
          ? { to: input.organizerContactEmail }
          : null,
        tags,
        metadata,
      },
    };
  },
};

const volunteerSignupApprovedSchema = z
  .object({
    /** Set on event-path signups; null/absent for generic ask signups. */
    eventId: z.string().uuid().nullable().optional(),
    /** Set on generic ask signups (generic-volunteering-asks A4). */
    askId: z.string().uuid().nullable().optional(),
    /** Container title: event title (event path) or ask title (ask path). */
    eventTitle: z.string().min(1),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    signupId: z.string().uuid(),
    shiftLabel: z.string().min(1).nullable().optional(),
    shiftStartsAtIso: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
    shiftEndsAtIso: z.string().datetime({ offset: true }).nullable().optional(),
    /**
     * IANA zone the shift window renders in (the event's, or the ask's).
     * Null/absent → the renderer's runtime zone, UTC on the server.
     */
    timezone: z.string().min(1).max(100).nullable().optional(),
    reviewerName: z.string().min(1).nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
    /**
     * Where the volunteer lands from the notification: the event page
     * (event path) or the public ask page (ask path). Pre-built by the
     * use case, like `signupsUrl`/`coordinateUrl` on sibling renderers.
     */
    destinationUrl: z.string().url().nullable().optional(),
  })
  .strict();

type VolunteerSignupApprovedInput = z.infer<
  typeof volunteerSignupApprovedSchema
>;

const volunteerSignupApprovedRenderer: NotificationRendererDefinition<
  typeof volunteerSignupApprovedSchema
> = {
  variant: "volunteer.signup-approved",
  category: "transactional",
  schema: volunteerSignupApprovedSchema,
  render(
    input: VolunteerSignupApprovedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      roleId: input.roleId,
      signupId: input.signupId,
      decision: "APPROVED",
    };
    if (input.eventId) metadata.eventId = input.eventId;
    if (input.askId) metadata.askId = input.askId;

    const tags: Tags = ["volunteer", "signup", "approved"];
    const copy = VOLUNTEER_SIGNUP_APPROVED_COPY[ctx.locale];
    const english = VOLUNTEER_SIGNUP_APPROVED_COPY.en;
    const copyVars = { eventTitle: input.eventTitle, roleName: input.roleName };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);
    // Event-path signups link to the event page; ask-path signups link to
    // the public ask page.
    const destinationLabel = input.eventId
      ? english.viewEventLabel
      : english.viewDetailsLabel;
    const inAppLabel = input.eventId
      ? copy.viewEventLabel
      : copy.viewDetailsLabel;
    const destinationUrl = input.destinationUrl ?? null;
    let text = input.shiftLabel ? `${body}\n\nShift: ${input.shiftLabel}` : body;
    if (destinationUrl) {
      text = `${text}\n\n${destinationLabel}: ${destinationUrl}`;
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.signup-approved",
        signupId: input.signupId,
        eventId: input.eventId ?? null,
        askId: input.askId ?? null,
        roleId: input.roleId,
        decision: "APPROVED",
        shiftLabel: input.shiftLabel ?? null,
        shiftStartsAtIso: input.shiftStartsAtIso ?? null,
        shiftEndsAtIso: input.shiftEndsAtIso ?? null,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "SUCCESS",
        action: destinationUrl
          ? { label: inAppLabel, href: destinationUrl }
          : null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text,
        template: {
          key: "volunteer.signup_approved",
          variables: {
            eventTitle: input.eventTitle,
            roleName: input.roleName,
            shiftLabel: input.shiftLabel ?? null,
            shiftStartsAtISO: input.shiftStartsAtIso ?? null,
            shiftEndsAtISO: input.shiftEndsAtIso ?? null,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            reviewerName: input.reviewerName ?? null,
            organizerContactEmail: input.organizerContactEmail ?? null,
            destinationUrl,
            // Keep the HTML CTA label in lockstep with the text/in-app label
            // ("View event" for event-path, "View details" for ask-path).
            destinationLabel,
          },
        },
        replyTo: input.organizerContactEmail
          ? { to: input.organizerContactEmail }
          : null,
        tags,
        metadata,
      },
    };
  },
};

const volunteerSignupRejectedSchema = z
  .object({
    /** Set on event-path signups; null/absent for generic ask signups. */
    eventId: z.string().uuid().nullable().optional(),
    /** Set on generic ask signups (generic-volunteering-asks A4). */
    askId: z.string().uuid().nullable().optional(),
    /** Container title: event title (event path) or ask title (ask path). */
    eventTitle: z.string().min(1),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    signupId: z.string().uuid(),
    reviewerName: z.string().min(1).nullable().optional(),
    rejectionNote: z.string().min(1).nullable().optional(),
    organizerContactEmail: z.string().email().nullable().optional(),
  })
  .strict();

type VolunteerSignupRejectedInput = z.infer<
  typeof volunteerSignupRejectedSchema
>;

const volunteerSignupRejectedRenderer: NotificationRendererDefinition<
  typeof volunteerSignupRejectedSchema
> = {
  variant: "volunteer.signup-rejected",
  category: "transactional",
  schema: volunteerSignupRejectedSchema,
  render(
    input: VolunteerSignupRejectedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      roleId: input.roleId,
      signupId: input.signupId,
      decision: "REJECTED",
    };
    if (input.eventId) metadata.eventId = input.eventId;
    if (input.askId) metadata.askId = input.askId;

    const tags: Tags = ["volunteer", "signup", "rejected"];
    const copy = VOLUNTEER_SIGNUP_REJECTED_COPY[ctx.locale];
    const english = VOLUNTEER_SIGNUP_REJECTED_COPY.en;
    const copyVars = { eventTitle: input.eventTitle, roleName: input.roleName };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);
    const text = input.rejectionNote
      ? `${body}\n\nNote from the organizer: ${input.rejectionNote}`
      : body;

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.signup-rejected",
        signupId: input.signupId,
        eventId: input.eventId ?? null,
        askId: input.askId ?? null,
        roleId: input.roleId,
        decision: "REJECTED",
        rejectionNote: input.rejectionNote ?? null,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "INFO",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text,
        template: {
          key: "volunteer.signup_rejected",
          variables: {
            eventTitle: input.eventTitle,
            roleName: input.roleName,
            reviewerName: input.reviewerName ?? null,
            rejectionNote: input.rejectionNote ?? null,
            organizerContactEmail: input.organizerContactEmail ?? null,
          },
        },
        replyTo: input.organizerContactEmail
          ? { to: input.organizerContactEmail }
          : null,
        tags,
        metadata,
      },
    };
  },
};

const volunteerSpotOpenedSchema = z
  .object({
    /** Set on event-path signups; null/absent for generic ask signups. */
    eventId: z.string().uuid().nullable().optional(),
    /** Set on generic ask signups (generic-volunteering-asks A4). */
    askId: z.string().uuid().nullable().optional(),
    /** Container title: event title (event path) or ask title (ask path). */
    eventTitle: z.string().min(1),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    shiftId: z.string().uuid().nullable().optional(),
    shiftLabel: z.string().min(1).nullable().optional(),
    pendingCount: z.number().int().min(1),
    /** The withdrawn signup that freed the spot — anchors idempotency. */
    withdrawnSignupId: z.string().uuid(),
    /** Deep link to the admin Signups tab for the event. */
    signupsUrl: z.string().url(),
  })
  .strict();

type VolunteerSpotOpenedInput = z.infer<typeof volunteerSpotOpenedSchema>;

/**
 * Org-staff-facing (not volunteer-facing): an APPROVED volunteer withdrew
 * and the freed shift/role has pending applicants waiting (Gap 9). Sent
 * once per org admin by `withdrawVolunteerSignup`.
 */
const volunteerSpotOpenedRenderer: NotificationRendererDefinition<
  typeof volunteerSpotOpenedSchema
> = {
  variant: "volunteer.spot-opened",
  category: "transactional",
  schema: volunteerSpotOpenedSchema,
  render(
    input: VolunteerSpotOpenedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      roleId: input.roleId,
      withdrawnSignupId: input.withdrawnSignupId,
      pendingCount: String(input.pendingCount),
    };
    if (input.eventId) metadata.eventId = input.eventId;
    if (input.askId) metadata.askId = input.askId;
    if (input.shiftId) {
      metadata.shiftId = input.shiftId;
    }

    const tags: Tags = ["volunteer", "signup", "spot-opened"];
    const target = input.shiftLabel
      ? `${input.roleName}/${input.shiftLabel}`
      : input.roleName;
    const copy = VOLUNTEER_SPOT_OPENED_COPY[ctx.locale];
    const english = VOLUNTEER_SPOT_OPENED_COPY.en;
    const copyVars = {
      eventTitle: input.eventTitle,
      target,
      pendingCount: input.pendingCount,
    };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.spot-opened",
        withdrawnSignupId: input.withdrawnSignupId,
        eventId: input.eventId ?? null,
        askId: input.askId ?? null,
        roleId: input.roleId,
        shiftId: input.shiftId ?? null,
        pendingCount: input.pendingCount,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "INFO",
        action: { label: copy.reviewLabel, href: input.signupsUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: `${body}\n\nReview signups: ${input.signupsUrl}`,
        tags,
        metadata,
      },
    };
  },
};

const volunteerShiftReminderSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    signupId: z.string().uuid(),
    kind: z.enum(["REMINDER_24H", "REMINDER_1H"]),
    shiftLabel: z.string().min(1).nullable().optional(),
    shiftStartsAtIso: z.string().datetime({ offset: true }),
    shiftEndsAtIso: z.string().datetime({ offset: true }),
    /**
     * IANA zone the shift window renders in (the event's, or the ask's).
     * Null/absent → the renderer's runtime zone, UTC on the server.
     */
    timezone: z.string().min(1).max(100).nullable().optional(),
    addressText: z.string().min(1).nullable().optional(),
    manageUrl: z.string().url().nullable().optional(),
  })
  .strict();

type VolunteerShiftReminderInput = z.infer<typeof volunteerShiftReminderSchema>;

const volunteerShiftReminderRenderer: NotificationRendererDefinition<
  typeof volunteerShiftReminderSchema
> = {
  variant: "volunteer.shift-reminder",
  category: "transactional",
  schema: volunteerShiftReminderSchema,
  render(
    input: VolunteerShiftReminderInput,
    _ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      roleId: input.roleId,
      signupId: input.signupId,
      kind: input.kind,
    };
    const tags: Tags = [
      "volunteer",
      "shift",
      "reminder",
      input.kind === "REMINDER_24H" ? "24h" : "1h",
    ];
    const kindLabel = input.kind === "REMINDER_24H" ? "Tomorrow" : "In 1 hour";
    const subject = `Reminder: your ${input.eventTitle} shift ${kindLabel.toLowerCase()}`;
    const body = `${kindLabel} — your ${input.roleName} shift at ${input.eventTitle}.${input.shiftLabel ? ` (${input.shiftLabel})` : ""}`;
    const textLines: string[] = [body, `Starts: ${input.shiftStartsAtIso}`];
    if (input.addressText) textLines.push(`Where: ${input.addressText}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.shift-reminder",
        signupId: input.signupId,
        kind: input.kind,
        shiftStartsAtIso: input.shiftStartsAtIso,
      },
      inApp: {
        title: subject,
        body,
        kind: "INFO",
        action: input.manageUrl
          ? { label: "Manage signup", href: input.manageUrl }
          : null,
        expiresAt: input.shiftEndsAtIso ? new Date(input.shiftEndsAtIso) : null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "volunteer.shift_reminder",
          variables: {
            eventTitle: input.eventTitle,
            roleName: input.roleName,
            shiftLabel: input.shiftLabel ?? null,
            shiftStartsAtISO: input.shiftStartsAtIso,
            shiftEndsAtISO: input.shiftEndsAtIso,
            // Same zone the subject and text read in (never the server's).
            timezone: resolveTimeZone(input.timezone),
            kindLabel,
            addressText: input.addressText ?? null,
            manageUrl: input.manageUrl ?? null,
          },
        },
        replyTo: null,
        tags,
        metadata,
      },
    };
  },
};

const volunteerGroupCoordinatorAssignedSchema = z
  .object({
    askId: z.string().uuid(),
    askTitle: z.string().min(1),
    groupId: z.string().uuid(),
    groupName: z.string().min(1),
    coordinateUrl: z.string().url(),
    /**
     * Present only for guest-created (shadow) coordinators — flips the copy
     * to the invite flavor, mirroring volunteer.signup-received.
     */
    accountCompletionUrl: z.string().url().nullable().optional(),
    /**
     * Display name of the ask owner who made the assignment. Null/absent
     * when they have no usable name — the copy then omits the "who".
     * Deliberately NOT in the fingerprint: the dedupe identity is the
     * (group, coordinator) pair, not who clicked.
     */
    assignerName: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

type VolunteerGroupCoordinatorAssignedInput = z.infer<
  typeof volunteerGroupCoordinatorAssignedSchema
>;

/**
 * "You're coordinating <group>" — sent post-commit by
 * assign-group-coordinator (generic-volunteering-asks FR-008). Templated
 * email (ui-email `volunteer.group_coordinator_assigned`) with a plain-text
 * part built here.
 */
const volunteerGroupCoordinatorAssignedRenderer: NotificationRendererDefinition<
  typeof volunteerGroupCoordinatorAssignedSchema
> = {
  variant: "volunteer.group-coordinator-assigned",
  category: "transactional",
  schema: volunteerGroupCoordinatorAssignedSchema,
  render(
    input: VolunteerGroupCoordinatorAssignedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      askId: input.askId,
      groupId: input.groupId,
    };
    if (input.accountCompletionUrl) {
      metadata.accountCompletionUrl = input.accountCompletionUrl;
    }

    const tags: Tags = ["volunteer", "group", "coordinator-assigned"];
    const assignerName = input.assignerName ?? null;
    // Kept in sync with the ui-email registry's getSubject for
    // volunteer.group_coordinator_assigned.
    const copy = VOLUNTEER_GROUP_COORDINATOR_ASSIGNED_COPY[ctx.locale];
    const english = VOLUNTEER_GROUP_COORDINATOR_ASSIGNED_COPY.en;
    const copyVars = {
      groupName: input.groupName,
      askTitle: input.askTitle,
      assignerName,
    };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);

    const textLines: string[] = [subject, body];
    if (input.accountCompletionUrl) {
      textLines.push(
        `You'll need an Ithas Fire account to see your group: ${input.accountCompletionUrl}`,
      );
    }
    textLines.push(`Open your group: ${input.coordinateUrl}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.group-coordinator-assigned",
        groupId: input.groupId,
        askId: input.askId,
        accountCompletionUrl: input.accountCompletionUrl ?? null,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "INFO",
        action: { label: copy.openLabel, href: input.coordinateUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: textLines.join("\n\n"),
        template: {
          key: "volunteer.group_coordinator_assigned",
          variables: {
            assignerName,
            groupName: input.groupName,
            askTitle: input.askTitle,
            coordinateUrl: input.coordinateUrl,
            accountCompletionUrl: input.accountCompletionUrl ?? null,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const volunteerPoolSignupReceivedSchema = z
  .object({
    askId: z.string().uuid(),
    askTitle: z.string().min(1),
    signupId: z.string().uuid(),
    roleId: z.string().uuid(),
    roleName: z.string().min(1),
    status: z.enum(["PENDING", "APPROVED"]),
    coordinateUrl: z.string().url(),
  })
  .strict();

type VolunteerPoolSignupReceivedInput = z.infer<
  typeof volunteerPoolSignupReceivedSchema
>;

/**
 * Coordinator-facing (generic-volunteering-asks FR-008): a new signup
 * landed in the ask's GENERAL POOL and the ask has groups — every assigned
 * coordinator is told so someone triages it. Sent post-commit by the
 * ask-path submit, one per coordinator. Plain-text email, like
 * volunteer.spot-opened.
 */
const volunteerPoolSignupReceivedRenderer: NotificationRendererDefinition<
  typeof volunteerPoolSignupReceivedSchema
> = {
  variant: "volunteer.pool-signup-received",
  category: "transactional",
  schema: volunteerPoolSignupReceivedSchema,
  render(
    input: VolunteerPoolSignupReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      askId: input.askId,
      roleId: input.roleId,
      signupId: input.signupId,
      status: input.status,
    };

    const tags: Tags = ["volunteer", "signup", "pool"];
    const copy = VOLUNTEER_POOL_SIGNUP_RECEIVED_COPY[ctx.locale];
    const english = VOLUNTEER_POOL_SIGNUP_RECEIVED_COPY.en;
    const copyVars = {
      askTitle: input.askTitle,
      roleName: input.roleName,
      approved: input.status === "APPROVED",
    };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.pool-signup-received",
        signupId: input.signupId,
        askId: input.askId,
        roleId: input.roleId,
        status: input.status,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "INFO",
        action: { label: copy.openLabel, href: input.coordinateUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: `${body}\n\nOpen the roster: ${input.coordinateUrl}`,
        tags,
        metadata,
      },
    };
  },
};

const volunteerGroupSignupAssignedSchema = z
  .object({
    askId: z.string().uuid(),
    askTitle: z.string().min(1),
    groupId: z.string().uuid(),
    groupName: z.string().min(1),
    signupId: z.string().uuid(),
    roleName: z.string().min(1),
    volunteerName: z.string().min(1),
    coordinateUrl: z.string().url(),
  })
  .strict();

type VolunteerGroupSignupAssignedInput = z.infer<
  typeof volunteerGroupSignupAssignedSchema
>;

/**
 * Coordinator-facing (generic-volunteering-asks FR-008): a signup was
 * assigned INTO the recipient's group by someone else (owner move; a
 * coordinator's own pull never notifies the actor). Sent post-commit by
 * assign-signup-to-group. Plain-text email, like volunteer.spot-opened.
 */
const volunteerGroupSignupAssignedRenderer: NotificationRendererDefinition<
  typeof volunteerGroupSignupAssignedSchema
> = {
  variant: "volunteer.group-signup-assigned",
  category: "transactional",
  schema: volunteerGroupSignupAssignedSchema,
  render(
    input: VolunteerGroupSignupAssignedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      askId: input.askId,
      groupId: input.groupId,
      signupId: input.signupId,
    };

    const tags: Tags = ["volunteer", "group", "signup-assigned"];
    const copy = VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY[ctx.locale];
    const english = VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY.en;
    const copyVars = {
      volunteerName: input.volunteerName,
      roleName: input.roleName,
      groupName: input.groupName,
      askTitle: input.askTitle,
    };
    const subject = english.title(copyVars);
    const body = english.body(copyVars);

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.group-signup-assigned",
        signupId: input.signupId,
        askId: input.askId,
        groupId: input.groupId,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body(copyVars),
        kind: "INFO",
        action: { label: copy.openLabel, href: input.coordinateUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: `${body}\n\nOpen your group: ${input.coordinateUrl}`,
        tags,
        metadata,
      },
    };
  },
};

const volunteerOccurrenceCancelledSchema = z
  .object({
    askId: z.string().uuid(),
    askTitle: z.string().min(1),
    occurrenceId: z.string().uuid(),
    roleName: z.string().min(1),
    startsAtIso: z.string().datetime({ offset: true }),
    endsAtIso: z.string().datetime({ offset: true }),
    askUrl: z.string().url(),
    /**
     * The ask's place IANA zone. Optional: rows stored before it existed, and
     * asks with no known zone, read in the platform default zone.
     */
    timezone: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();

type VolunteerOccurrenceCancelledInput = z.infer<
  typeof volunteerOccurrenceCancelledSchema
>;

/**
 * Volunteer-facing (generic-volunteer-shifts-occurrences FR-002): a dated
 * slot the volunteer claimed was cancelled by the owner. Sent post-commit
 * by cancel-shift-occurrence, once per active claimant, keyed
 * `<occurrenceId>:cancelled:<claimId>` so each claimant hears exactly once
 * per channel. Plain-text email, like volunteer.spot-opened.
 */
const volunteerOccurrenceCancelledRenderer: NotificationRendererDefinition<
  typeof volunteerOccurrenceCancelledSchema
> = {
  variant: "volunteer.occurrence-cancelled",
  category: "transactional",
  schema: volunteerOccurrenceCancelledSchema,
  render(
    input: VolunteerOccurrenceCancelledInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      askId: input.askId,
      occurrenceId: input.occurrenceId,
      startsAtIso: input.startsAtIso,
    };

    const tags: Tags = ["volunteer", "occurrence", "cancelled"];
    const copy = VOLUNTEER_OCCURRENCE_CANCELLED_COPY[ctx.locale];
    const english = VOLUNTEER_OCCURRENCE_CANCELLED_COPY.en;
    // Every locale (email too) reads the start in the ask's zone via the
    // shared date helper; without one (older rows, asks with no known zone)
    // that helper uses the platform default. The old no-zone branch printed
    // the server's UTC string, which put an evening shift on the next day.
    // `toUTCString` stays only for an instant the helper cannot parse.
    const tz = input.timezone;
    const whenEn =
      formatEventStart("en", input.startsAtIso, tz) ??
      new Date(input.startsAtIso).toUTCString();
    const when =
      ctx.locale === "en"
        ? whenEn
        : (formatEventStart(ctx.locale, input.startsAtIso, tz) ?? whenEn);
    const copyVars = {
      roleName: input.roleName,
      askTitle: input.askTitle,
    };
    const subject = english.title(copyVars);
    const body = english.body({ ...copyVars, when: whenEn });

    return {
      category: "transactional",
      fingerprint: {
        variant: "volunteer.occurrence-cancelled",
        occurrenceId: input.occurrenceId,
        askId: input.askId,
      },
      inApp: {
        title: copy.title(copyVars),
        body: copy.body({ ...copyVars, when }),
        kind: "INFO",
        action: { label: copy.viewLabel, href: input.askUrl },
        expiresAt: new Date(input.endsAtIso),
        tags,
        metadata,
        template: null,
      },
      email: {
        subject,
        text: `${body}\n\nView the schedule: ${input.askUrl}`,
        tags,
        metadata,
      },
    };
  },
};

const volunteerBroadcastSchema = z
  .object({
    askId: z.string().uuid(),
    broadcastId: z.string().uuid(),
    askTitle: z.string().min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();

type VolunteerBroadcastInput = z.infer<typeof volunteerBroadcastSchema>;

/**
 * Preference category for volunteer roster broadcasts — organizer-authored
 * messaging ("messages from event hosts and organizers"), NOT transactional.
 * Exported so broadcast-to-roster's direct email leg gates on the SAME
 * category the in-app leg resolves through notify; the two must never drift.
 */
export const VOLUNTEER_BROADCAST_CATEGORY =
  "organizerMessages" satisfies NotificationCategory;

/**
 * Volunteer-facing roster announcement (generic-volunteering-asks FR-009).
 * IN-APP ONLY by design: the broadcast email is delivered by
 * broadcast-to-roster directly over MailerPort to the signup's roster
 * contactEmail (which shadow, humanId-less volunteers also have), so a
 * renderer email payload here would double-send to account holders.
 */
const volunteerBroadcastRenderer: NotificationRendererDefinition<
  typeof volunteerBroadcastSchema
> = {
  variant: "volunteer.broadcast",
  category: VOLUNTEER_BROADCAST_CATEGORY,
  schema: volunteerBroadcastSchema,
  render(
    input: VolunteerBroadcastInput,
    _ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      askId: input.askId,
      broadcastId: input.broadcastId,
    };
    const tags: Tags = ["volunteer", "broadcast"];

    return {
      category: VOLUNTEER_BROADCAST_CATEGORY,
      fingerprint: {
        variant: "volunteer.broadcast",
        broadcastId: input.broadcastId,
        askId: input.askId,
      },
      inApp: {
        title: `${input.askTitle}: ${input.subject}`,
        body: input.body,
        kind: "INFO",
        action: null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Image moderation (uploader-facing) — FR-009
// ─────────────────────────────────────────────────────────────────────────────
// The title bound is shared with the moderation use cases that BUILD these
// payloads, so the truncation and the validation can never drift apart.

/** Which public surface the moderated object serves. */
const imageModerationKindSchema = z.enum([
  "EVENT_HERO",
  "AVATAR",
  "BANNER",
  "PAGE_MEDIA",
]);

/** The owning entity type of the moderated object. */
const imageModerationSubjectTypeSchema = z.enum([
  "EVENT",
  "HUMAN",
  "ORGANIZATION",
  "PLACE",
]);

/**
 * Fields common to all three moderation notices — mirrors exactly the payload
 * the moderation use cases pass (drain-image-moderations / review-flagged-image).
 * `imageUrl` (the object's public URL) is carried for metadata/fingerprinting
 * only; we never render the (possibly disallowed) image in the notice.
 */
const imageModerationBaseFields = {
  recordId: z.string().uuid(),
  kind: imageModerationKindSchema,
  subjectType: imageModerationSubjectTypeSchema.nullable(),
  subjectId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /**
   * Human-readable name of the thing the image is ON (today: the event title),
   * so the notice says WHICH image it is about. Null when the subject couldn't
   * be resolved — the copy falls back to the generic wording. The bound is the
   * SAME constant the caller truncates with (drift between the two would fail
   * closed and sink the notice), and the caller truncates rather than relying
   * on this check, because these notices are best-effort and a schema rejection
   * would kill the whole send.
   */
  subjectTitle: z
    .string()
    .min(1)
    .max(IMAGE_MODERATION_SUBJECT_TITLE_MAX_LENGTH)
    .nullable(),
  /**
   * Absolute public URL of the subject (`{appBaseUrl}/events/{slug}`, or a
   * PLACE's page `{appBaseUrl}/p/{slug}`). Built from the SLUG, never the id — the public `/events/[...slug]` route resolves
   * via `events.resolveBySlug` (current slug or slug history), so an id-based
   * link 404s. Null when there is no base URL, no slug, or no subject.
   */
  subjectUrl: z.string().url().nullable(),
};

/**
 * Builds the shared metadata map for a moderation notice. `recordId` + `kind`
 * are always present; subject fields only when the record carries them.
 */
function imageModerationMetadata(input: {
  recordId: string;
  kind: string;
  subjectType: string | null;
  subjectId: string | null;
}): Metadata {
  const metadata: Metadata = {
    recordId: input.recordId,
    kind: input.kind,
  };
  if (input.subjectType) metadata.subjectType = input.subjectType;
  if (input.subjectId) metadata.subjectId = input.subjectId;
  return metadata;
}

/**
 * Builds the in-app "view" action for a moderation notice — only for EVENT
 * subjects (Phase 1), whose public page route is cleanly derivable. Other
 * subject types get no action rather than a guessed route.
 *
 * The route is derived from `subjectUrl`'s PATH, so it always carries the
 * event's slug. It used to be built as `/events/{subjectId}` — a UUID — which
 * the public route (slug / slug-history only) resolves to a 404. Never emit an
 * id-based event route from here again: no subjectUrl, no action.
 */
function imageModerationEventAction(
  input: {
    subjectType: string | null;
    subjectUrl: string | null;
  },
  label?: string,
): NotificationAction | null {
  if (input.subjectType !== "EVENT") return null;
  return eventRouteAction(input.subjectUrl, label);
}

/**
 * The plain-text label of the subject link: an EVENT links its event page, a
 * PLACE (a community moderator's page image) its place page.
 */
function imageModerationSubjectLinkLabel(input: {
  subjectType: string | null;
}): string {
  return input.subjectType === "PLACE" ? "View the page" : "View the event";
}

const imageModerationHeldSchema = z
  .object({
    ...imageModerationBaseFields,
    /** Absolute Help Center URL (appBaseUrl + /help), or null. */
    helpUrl: z.string().url().nullable(),
  })
  .strict();

type ImageModerationHeldInput = z.infer<typeof imageModerationHeldSchema>;

/**
 * Uploader-facing: an uploaded image was FLAGGED and is held for human review.
 * Deliberately non-alarming and detail-free — it does not say what was detected,
 * only that the image is in review and will appear once approved. No action is
 * needed of the uploader; the "View event" link is informational (which image is
 * this about?), which is why the label stays neutral.
 */
const imageModerationHeldRenderer: NotificationRendererDefinition<
  typeof imageModerationHeldSchema
> = {
  variant: "image.moderation.held",
  category: "transactional",
  schema: imageModerationHeldSchema,
  render(
    input: ImageModerationHeldInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata = imageModerationMetadata(input);
    const tags: Tags = ["image", "moderation", "held"];
    // In-app copy is in the render locale (copy/moderation.ts); email stays
    // English.
    const copy = IMAGE_MODERATION_HELD_COPY[ctx.locale];
    const copyValues = { subjectTitle: input.subjectTitle };
    const title = IMAGE_MODERATION_HELD_COPY.en.title;
    const body = IMAGE_MODERATION_HELD_COPY.en.body(copyValues);
    // Informational, not a call to action — the image simply isn't visible yet.
    // The link is only there so the uploader can tell WHICH image this is about.
    const action = imageModerationEventAction(input, copy.viewEventLabel);

    const textLines: string[] = [body];
    if (input.subjectUrl) {
      textLines.push(`${imageModerationSubjectLinkLabel(input)}: ${input.subjectUrl}`);
    }
    if (input.helpUrl) {
      textLines.push(`Questions? Visit our Help Center: ${input.helpUrl}`);
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "image.moderation.held",
        recordId: input.recordId,
      },
      inApp: {
        title: copy.title,
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "image.moderation.held",
          variables: {
            helpUrl: input.helpUrl,
            eventTitle: input.subjectTitle,
            eventUrl: input.subjectUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const imageModerationApprovedSchema = z
  .object({
    ...imageModerationBaseFields,
    /** Always null for approvals; present to mirror the shared payload shape. */
    note: z.string().nullable(),
    /** Absolute Help Center URL (appBaseUrl + /help), or null. */
    helpUrl: z.string().url().nullable(),
  })
  .strict();

type ImageModerationApprovedInput = z.infer<
  typeof imageModerationApprovedSchema
>;

/**
 * Uploader-facing: a held image was APPROVED by a moderator and is now visible.
 */
const imageModerationApprovedRenderer: NotificationRendererDefinition<
  typeof imageModerationApprovedSchema
> = {
  variant: "image.moderation.approved",
  category: "transactional",
  schema: imageModerationApprovedSchema,
  render(
    input: ImageModerationApprovedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata = imageModerationMetadata(input);
    const tags: Tags = ["image", "moderation", "approved"];
    // In-app copy is in the render locale (copy/moderation.ts); email stays
    // English.
    const copy = IMAGE_MODERATION_APPROVED_COPY[ctx.locale];
    const copyValues = { subjectTitle: input.subjectTitle };
    const title = IMAGE_MODERATION_APPROVED_COPY.en.title;
    const body = IMAGE_MODERATION_APPROVED_COPY.en.body(copyValues);
    const action = imageModerationEventAction(input, copy.viewEventLabel);

    const textLines: string[] = [body];
    if (input.subjectUrl) {
      textLines.push(`${imageModerationSubjectLinkLabel(input)}: ${input.subjectUrl}`);
    }
    if (input.helpUrl) {
      textLines.push(`Questions? Visit our Help Center: ${input.helpUrl}`);
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "image.moderation.approved",
        recordId: input.recordId,
      },
      inApp: {
        title: copy.title,
        body: copy.body(copyValues),
        kind: "SUCCESS",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "image.moderation.approved",
          variables: {
            eventTitle: input.subjectTitle,
            eventUrl: input.subjectUrl,
            helpUrl: input.helpUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const imageModerationRejectedSchema = z
  .object({
    ...imageModerationBaseFields,
    /** Optional moderator note surfaced to the uploader. */
    note: z.string().nullable(),
    /** Absolute Help Center URL (appBaseUrl + /help), or null. */
    helpUrl: z.string().url().nullable(),
  })
  .strict();

type ImageModerationRejectedInput = z.infer<
  typeof imageModerationRejectedSchema
>;

/**
 * Uploader-facing: a held image was REJECTED by a moderator and won't be shown.
 * Non-judgmental copy; surfaces the reviewer note when present, names/links the
 * event so the uploader knows which image to replace, and invites them to try a
 * different one.
 */
const imageModerationRejectedRenderer: NotificationRendererDefinition<
  typeof imageModerationRejectedSchema
> = {
  variant: "image.moderation.rejected",
  category: "transactional",
  schema: imageModerationRejectedSchema,
  render(
    input: ImageModerationRejectedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata = imageModerationMetadata(input);
    const tags: Tags = ["image", "moderation", "rejected"];
    // In-app copy is in the render locale (copy/moderation.ts); email stays
    // English.
    const copy = IMAGE_MODERATION_REJECTED_COPY[ctx.locale];
    const copyValues = { subjectTitle: input.subjectTitle };
    const title = IMAGE_MODERATION_REJECTED_COPY.en.title;
    const body = IMAGE_MODERATION_REJECTED_COPY.en.body(copyValues);
    // Links to the event (not a guessed editor route) so the uploader knows
    // exactly which image to replace.
    const action = imageModerationEventAction(input, copy.viewEventLabel);

    const textLines: string[] = [body];
    if (input.note) {
      textLines.push(`Note from our moderators: ${input.note}`);
    }
    if (input.subjectUrl) {
      textLines.push(`${imageModerationSubjectLinkLabel(input)}: ${input.subjectUrl}`);
    }
    if (input.helpUrl) {
      textLines.push(`Questions? Visit our Help Center: ${input.helpUrl}`);
    }

    return {
      category: "transactional",
      fingerprint: {
        variant: "image.moderation.rejected",
        recordId: input.recordId,
        note: input.note ?? null,
      },
      inApp: {
        title: copy.title,
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "image.moderation.rejected",
          variables: {
            note: input.note,
            eventTitle: input.subjectTitle,
            eventUrl: input.subjectUrl,
            helpUrl: input.helpUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const bookingRequestReceivedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    placeId: z.string().uuid(),
    // Place names are bounded at input; 200 is deliberate slack (same posture
    // as event titles above) so an oversized value can't bloat the payload.
    placeName: z.string().min(1).max(200),
    /**
     * Requesting act's display name. The CALLER
     * (notify-booking-request-received) guarantees this is non-empty. The
     * `.min(1)` here fails notify() BEFORE its idempotency claim
     * (renderNotification runs first), which is the safe failure mode — a bad
     * value that instead only tripped the ui-email template's own props
     * schema would fail inside the mail adapter AFTER it claims its derived
     * `{key}:email` key, silently losing that send.
     */
    actName: z.string().min(1).max(200),
    /** Anonymous-inquiry contact fields; null for performer-owned requests. */
    contactName: z.string().min(1).max(200).nullable().optional(),
    contactEmail: z.string().email().max(320).nullable().optional(),
    /** Pitch message — input-capped at 2000; slack for legacy/edge rows. */
    message: z.string().min(1).max(4000),
    /** ISO date strings; pitch schema caps at 10, slack here. */
    preferredDates: z.array(z.string().min(1)).max(20).optional(),
    source: z.enum(["PLATFORM", "EMBED"]),
    /**
     * Absolute, PER-RECIPIENT booking-inbox link — the admin slug differs by
     * whether the recipient owns the place directly (`/admin/@human/…`) or
     * via an org (`/admin/org-slug/…`).
     */
    inboxUrl: z.string().url(),
  })
  .strict();

type BookingRequestReceivedInput = z.infer<typeof bookingRequestReceivedSchema>;

/**
 * Venue-facing: a new booking request landed in the place's inbox, from the
 * platform form or the embed widget (booking-request-embed-button FR-008).
 * Sent inline post-commit by both create paths via
 * notify-booking-request-received. In-app + email + push; deliberately NO
 * SMS payload (out of scope per spec — the dispatcher also disables the
 * channel explicitly).
 */
const bookingRequestReceivedRenderer: NotificationRendererDefinition<
  typeof bookingRequestReceivedSchema
> = {
  variant: "booking.request-received",
  category: "transactional",
  schema: bookingRequestReceivedSchema,
  render(
    input: BookingRequestReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      placeId: input.placeId,
      source: input.source,
    };

    const tags: Tags = ["booking", "request-received"];
    // In-app copy is in the render locale (copy/booking.ts); push and email
    // stay English.
    const copy = BOOKING_REQUEST_RECEIVED_COPY[ctx.locale];
    const english = BOOKING_REQUEST_RECEIVED_COPY.en;
    const title = english.title({ placeName: input.placeName });
    const body = english.body({
      actName: input.actName,
      placeName: input.placeName,
    });
    const action: NotificationAction = {
      label: copy.openInboxLabel,
      href: input.inboxUrl,
    };

    const textLines: string[] = [body, input.message];
    if (input.contactEmail) {
      textLines.push(
        `Reply directly: ${input.contactName ? `${input.contactName} — ` : ""}${input.contactEmail}`,
      );
    }
    textLines.push(`Open your booking inbox: ${input.inboxUrl}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.request-received",
        bookingRequestId: input.bookingRequestId,
      },
      inApp: {
        title: copy.title({ placeName: input.placeName }),
        body: copy.body({ actName: input.actName, placeName: input.placeName }),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        collapseKey: `booking-request-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          placeId: input.placeId,
          url: input.inboxUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        // Kept in sync with the template registry's subjectTemplate
        // ("New booking request for {{placeName}}").
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "booking.request_received",
          variables: {
            placeName: input.placeName,
            actName: input.actName,
            contactName: input.contactName ?? null,
            contactEmail: input.contactEmail ?? null,
            message: input.message,
            ...(input.preferredDates
              ? { preferredDates: input.preferredDates }
              : {}),
            source: input.source,
            inboxUrl: input.inboxUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

// ── booking.lineup-invited (tagged act, lineup-booking-requests v2 FR-003) ──

const bookingLineupInvitedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    /** The RECIPIENT — the tagged human. Keys the push collapse per invite. */
    humanId: z.string().uuid(),
    /**
     * The sender (organizer of the ask). The CALLER
     * (notify-booking-lineup-invited) guarantees non-empty and clips to 200;
     * `.min(1)` fails notify() BEFORE its idempotency claim, never after.
     */
    senderName: z.string().min(1).max(200),
    venueName: z.string().min(1).max(200),
    /**
     * The request's nights as stored (`YYYY-MM-DD`, optionally
     * `THH:MM` wall clock). Loose on purpose: a stored value this renderer
     * cannot parse is shown as-is rather than failing the invite.
     */
    preferredDates: z.array(z.string().min(1).max(40)).max(20).optional(),
    /**
     * Lineup v3 (L17 / FR-012): set when the tagged act is a GROUP and this
     * recipient is one of its editors — the invite says which group it is
     * for. Absent for a tagged person.
     */
    asGroupName: z.string().min(1).max(200).optional(),
    /** Absolute link to the one-tap join / pass page. */
    targetUrl: z.string().url(),
  })
  .strict();

type BookingLineupInvitedInput = z.infer<typeof bookingLineupInvitedSchema>;

const PREFERRED_NIGHT_RE = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;

/**
 * "Fri, Aug 14, 2026" or "Fri, Aug 14, 2026 at 8:00 PM" from a stored
 * preferred night. The time is a venue-local WALL CLOCK with no offset (see
 * `bookingPreferredDateSchema`), so it is printed as written, never shifted
 * through a zone. Anything unparseable comes back verbatim.
 */
function formatPreferredNight(value: string): string {
  const match = PREFERRED_NIGHT_RE.exec(value);
  if (!match) return value;
  const day = formatHoldDate(match[1]!);
  if (match[2] === undefined || match[3] === undefined) return day;
  const hour24 = Number(match[2]);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? "AM" : "PM";
  return `${day} at ${hour12}:${match[3]} ${meridiem}`;
}

const BOOKING_LINEUP_TAGS: Tags = ["booking", "lineup"];

/**
 * Act-facing: a sender put this artist on a bill they pitched to a venue.
 * Calm by design (NFR-002): it names who and where, says the ask is theirs
 * to answer, and carries no urgency — confirming or declining is one tap on
 * the landing page the action opens. In-app + push + templated email; no
 * SMS payload (the dispatcher disables the channel too).
 */
const bookingLineupInvitedRenderer: NotificationRendererDefinition<
  typeof bookingLineupInvitedSchema
> = {
  variant: "booking.lineup-invited",
  category: "transactional",
  schema: bookingLineupInvitedSchema,
  render(
    input: BookingLineupInvitedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      humanId: input.humanId,
    };
    // CONTEXT.md "Join / Pass" — never "confirm". A group editor is told
    // which group the bill names (v3 L17). In-app copy is in the render
    // locale (copy/booking.ts); push and email stay English.
    const copy = BOOKING_LINEUP_INVITED_COPY[ctx.locale];
    const english = BOOKING_LINEUP_INVITED_COPY.en;
    const words = {
      senderName: input.senderName,
      venueName: input.venueName,
      asGroupName: input.asGroupName,
    };
    const title = english.title(words);
    const body = english.body(words);
    const action: NotificationAction = {
      label: copy.reviewLabel,
      href: input.targetUrl,
    };
    const dateLabels = (input.preferredDates ?? []).map(formatPreferredNight);

    const textLines: string[] = [body];
    if (dateLabels.length > 0) {
      textLines.push(`Dates they asked about: ${dateLabels.join("; ")}`);
    }
    textLines.push(`Review the request: ${input.targetUrl}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.lineup-invited",
        bookingRequestId: input.bookingRequestId,
        humanId: input.humanId,
      },
      inApp: {
        title: copy.title(words),
        body: copy.body(words),
        kind: "INFO",
        action,
        expiresAt: null,
        tags: BOOKING_LINEUP_TAGS,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        // Per (request, human): one invite, one push slot.
        collapseKey: `booking-lineup-${input.bookingRequestId}-${input.humanId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          url: input.targetUrl,
        },
        tags: BOOKING_LINEUP_TAGS,
        metadata,
        template: null,
      },
      email: {
        // Kept in sync with the ui-email registry's getSubject for
        // booking.lineup_invited.
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "booking.lineup_invited",
          variables: {
            senderName: input.senderName,
            venueName: input.venueName,
            ...(input.asGroupName ? { asGroupName: input.asGroupName } : {}),
            dateLabels,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_LINEUP_TAGS,
        metadata,
      },
    };
  },
};

const organizerBookingRequestReceivedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    /**
     * Sender org's display name. The CALLER
     * (notify-organizer-booking-request-received) guarantees non-empty; the
     * `.min(1)` fails notify() BEFORE its idempotency claim (same hazard note
     * as bookingRequestReceivedSchema.actName).
     */
    orgName: z.string().min(1).max(200),
    /** Pitch message — input-capped at 2000; slack for edge rows. */
    message: z.string().min(1).max(4000),
    /** ISO date strings; organizer pitch caps at 3, slack here. */
    preferredDates: z.array(z.string().min(1)).max(10).optional(),
    /** Attached event's live title, when one is attached and still exists. */
    attachedEventTitle: z.string().min(1).max(200).optional(),
    /**
     * Absolute, PER-RECIPIENT "requests to you" link (account settings for a
     * human act, org settings for an org act).
     */
    requestsUrl: z.string().url(),
  })
  .strict();

type OrganizerBookingRequestReceivedInput = z.infer<
  typeof organizerBookingRequestReceivedSchema
>;

/**
 * Act-facing: an organizer org wants to book them
 * (organizer-booking-requests FR-006). Sent inline post-commit by
 * createOrganizerBookingRequest via notify-organizer-booking-request-received.
 * In-app + email + push; deliberately NO SMS payload (out of scope — the
 * dispatcher also disables the channel explicitly).
 */
const organizerBookingRequestReceivedRenderer: NotificationRendererDefinition<
  typeof organizerBookingRequestReceivedSchema
> = {
  variant: "booking.organizer-request-received",
  category: "transactional",
  schema: organizerBookingRequestReceivedSchema,
  render(
    input: OrganizerBookingRequestReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
    };

    const tags: Tags = ["booking", "organizer-request-received"];
    // In-app copy is in the render locale (copy/booking.ts); push and email
    // stay English.
    const copy = ORGANIZER_BOOKING_REQUEST_RECEIVED_COPY[ctx.locale];
    const english = ORGANIZER_BOOKING_REQUEST_RECEIVED_COPY.en;
    const words = {
      orgName: input.orgName,
      attachedEventTitle: input.attachedEventTitle,
    };
    const title = english.title(words);
    const body = english.body(words);
    const action: NotificationAction = {
      label: copy.viewRequestLabel,
      href: input.requestsUrl,
    };

    const textLines: string[] = [body, input.message];
    textLines.push(`View and respond: ${input.requestsUrl}`);

    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.organizer-request-received",
        bookingRequestId: input.bookingRequestId,
      },
      inApp: {
        title: copy.title(words),
        body: copy.body(words),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        collapseKey: `booking-request-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          url: input.requestsUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        // Kept in sync with the template registry's subjectTemplate
        // ("{{orgName}} wants to book you").
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "booking.organizer_request_received",
          variables: {
            orgName: input.orgName,
            message: input.message,
            ...(input.preferredDates
              ? { preferredDates: input.preferredDates }
              : {}),
            ...(input.attachedEventTitle
              ? { attachedEventTitle: input.attachedEventTitle }
              : {}),
            requestsUrl: input.requestsUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const organizerBookingRequestRespondedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    /** Act display name — caller-resolved, guaranteed non-empty. */
    actName: z.string().min(1).max(200),
    action: z.enum(["accepted", "declined"]),
    agreementId: z.string().uuid().optional(),
    /** Agreement editor (accept) or the org's Bookings hub (decline). */
    targetUrl: z.string().url(),
  })
  .strict();

type OrganizerBookingRequestRespondedInput = z.infer<
  typeof organizerBookingRequestRespondedSchema
>;

/**
 * Organizer-facing: the act responded to their booking request
 * (organizer-booking-requests FR-006). FOLDED into `booking.request-responded`
 * (booking-the-night N9): nothing sends it any more; it stays registered so a
 * notification queued before the fold still renders. Remove once no such row
 * can exist.
 */
const organizerBookingRequestRespondedRenderer: NotificationRendererDefinition<
  typeof organizerBookingRequestRespondedSchema
> = {
  variant: "booking.organizer-request-responded",
  category: "transactional",
  schema: organizerBookingRequestRespondedSchema,
  render(
    input: OrganizerBookingRequestRespondedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const accepted = input.action === "accepted";
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      action: input.action,
      ...(input.agreementId ? { agreementId: input.agreementId } : {}),
    };

    const tags: Tags = ["booking", "organizer-request-responded"];
    // In-app copy is in the render locale (copy/booking.ts); push and email
    // stay English.
    const copy = ORGANIZER_BOOKING_REQUEST_RESPONDED_COPY[ctx.locale];
    const english = ORGANIZER_BOOKING_REQUEST_RESPONDED_COPY.en;
    const words = { actName: input.actName, accepted };
    const title = english.title(words);
    const body = english.body(words);
    const englishLabel = english.label(words);
    const action: NotificationAction = {
      label: copy.label(words),
      href: input.targetUrl,
    };

    const textLines: string[] = [body, `${englishLabel}: ${input.targetUrl}`];

    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.organizer-request-responded",
        bookingRequestId: input.bookingRequestId,
      },
      inApp: {
        title: copy.title(words),
        body: copy.body(words),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        collapseKey: `booking-request-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          url: input.targetUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        // Kept in sync with the template registry's getSubject.
        subject: title,
        text: textLines.join("\n\n"),
        template: {
          key: "booking.organizer_request_responded",
          variables: {
            actName: input.actName,
            action: input.action,
            targetUrl: input.targetUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const bookingRequestRespondedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    /**
     * Who answered — the venue's name (a request to a venue) or the act's
     * name (an organiser's request to an act). Caller-resolved, non-empty.
     */
    responderName: z.string().min(1).max(200),
    action: z.enum(["accepted", "declined", "closed"]),
    /**
     * The responder's reason on a decline or a close — sanitized plain text
     * at the use case's boundary (`plainTextMultilineRequired`), bounded like
     * every booking reason. Absent on accept.
     */
    reason: z.string().min(1).max(1000).optional(),
    /** What follows an accept (see the email template). */
    acceptedNext: z.enum(["terms_coming", "agreement_ready"]).optional(),
    agreementId: z.string().uuid().optional(),
    /** The sender's view of the request, or the agreement on an organiser accept. */
    targetUrl: z.string().url(),
  })
  .strict();

type BookingRequestRespondedInput = z.infer<
  typeof bookingRequestRespondedSchema
>;

/**
 * Sender-facing: the other side answered your booking request
 * (booking-the-night N9 / FR-008). ONE variant for both directions — a venue
 * accepting, declining or closing an act's request, an act accepting or
 * declining an organiser's — with the reason on a decline or close. The
 * TO_PERFORMER-only `booking.organizer-request-responded` folds into it (its
 * renderer stays registered only for rows queued before the fold). Sent
 * inline post-commit via notify-booking-request-responded.
 */
const bookingRequestRespondedRenderer: NotificationRendererDefinition<
  typeof bookingRequestRespondedSchema
> = {
  variant: "booking.request-responded",
  category: "transactional",
  schema: bookingRequestRespondedSchema,
  render(
    input: BookingRequestRespondedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      action: input.action,
      ...(input.agreementId ? { agreementId: input.agreementId } : {}),
    };
    const tags: Tags = ["booking", "request-responded"];
    // In-app copy is in the render locale (copy/booking.ts); push and email
    // stay English. The English title is kept in sync with the email
    // template's subject (packages/ui-email BookingRequestResponded.tsx).
    const words = {
      responderName: input.responderName,
      action: input.action,
      acceptedNext: input.acceptedNext,
    };
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_REQUEST_RESPONDED_COPY[locale];
      const lede = c.lede(words);
      return {
        title: c.title(words),
        lede,
        body: input.reason ? c.withReason({ lede, reason: input.reason }) : lede,
        label: c.label(words),
      };
    };
    const english = textIn("en");
    const local = textIn(ctx.locale);
    const { title, lede, body } = english;
    const action: NotificationAction = {
      label: local.label,
      href: input.targetUrl,
    };

    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.request-responded",
        bookingRequestId: input.bookingRequestId,
        action: input.action,
      },
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body: lede,
        collapseKey: `booking-request-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          url: input.targetUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [body, `${english.label}: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.request_responded",
          variables: {
            responderName: input.responderName,
            action: input.action,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.acceptedNext ? { acceptedNext: input.acceptedNext } : {}),
            targetUrl: input.targetUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const bookingCancelledSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    /** Who cancelled: the venue's name, or the act's. Caller-resolved. */
    cancelledByName: z.string().min(1).max(200),
    /**
     * `"place"` | `"sender"`. Rows stored before 2026-10-18 hold the old
     * spelling and are re-rendered per locale from that payload, so it still
     * parses, read as `"place"`.
     */
    cancelledBy: z
      .enum(["place", "sender", LEGACY_OWNER_SIDE])
      .transform((side) => normalizeCancellerSide(side)),
    /** The booked place-local night, `YYYY-MM-DD`. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** The canceller's reason — sanitized plain text at the boundary. */
    reason: z.string().min(1).max(1000),
    /** The booking's event was cancelled with it. */
    eventCancelled: z.boolean(),
    /** The recipient's own view of the request (per side). */
    targetUrl: z.string().url(),
  })
  .strict();

type BookingCancelledInput = z.infer<typeof bookingCancelledSchema>;

/**
 * Both sides of a booking: its booked night was cancelled
 * (booking-the-night N13 / FR-009; review W4), with the reason. Sent inline
 * post-commit via notify-booking-cancelled. Never names a ticket buyer or a
 * refund amount — buyers hear through cancelEvent's own outbox.
 */
const bookingCancelledRenderer: NotificationRendererDefinition<
  typeof bookingCancelledSchema
> = {
  variant: "booking.booking-cancelled",
  category: "transactional",
  schema: bookingCancelledSchema,
  render(
    input: BookingCancelledInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      cancelledBy: input.cancelledBy,
    };
    const tags: Tags = ["booking", "booking-cancelled"];
    // In-app copy is in the render locale (copy/booking.ts); push and email
    // stay English. The English title is kept in sync with the email
    // template's subject (packages/ui-email BookingCancelled.tsx).
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_CANCELLED_COPY[locale];
      const lede = c.lede({ eventCancelled: input.eventCancelled });
      return {
        title: c.title({
          cancelledByName: input.cancelledByName,
          dateLabel: holdDateLabel(locale, input.date),
        }),
        lede,
        body: c.body({ lede, reason: input.reason }),
        label: c.viewRequestLabel,
      };
    };
    const english = textIn("en");
    const local = textIn(ctx.locale);
    const { title, lede, body } = english;
    const action: NotificationAction = {
      label: local.label,
      href: input.targetUrl,
    };
    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.booking-cancelled",
        bookingRequestId: input.bookingRequestId,
        date: input.date,
      },
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body: lede,
        collapseKey: `booking-request-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          url: input.targetUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [body, `${english.label}: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.booking_cancelled",
          variables: {
            cancelledByName: input.cancelledByName,
            dateLabel,
            reason: input.reason,
            eventCancelled: input.eventCancelled,
            targetUrl: input.targetUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

// ── P3b (asks) ───────────────────────────────────────────────────────────────
// venue-booking-standards v1.1 FR-009b: the venue asked the sender for
// something the night needs (in-app + email), and the sender answered
// (in-app only, venue side). Sent inline post-commit via
// notify-booking-request-ask.

const bookingAskKindSchema = z.enum([
  "IMAGE",
  "FILE",
  "LINK",
  "TEXT",
  "SET_LENGTH",
]);

const bookingAskReceivedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    askId: z.string().uuid(),
    /** The venue's name. Caller-resolved. */
    venueName: z.string().min(1).max(200),
    kind: bookingAskKindSchema,
    /** The venue's wording — sanitized plain text at the ask's boundary. */
    label: z.string().min(1).max(80),
    note: z.string().min(1).max(240).optional(),
    /** The recipient's own view of the request. */
    targetUrl: z.string().url(),
  })
  .strict();

type BookingAskReceivedInput = z.infer<typeof bookingAskReceivedSchema>;

const bookingAskReceivedRenderer: NotificationRendererDefinition<
  typeof bookingAskReceivedSchema
> = {
  variant: "booking.ask-received",
  category: "transactional",
  schema: bookingAskReceivedSchema,
  render(
    input: BookingAskReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      askId: input.askId,
      kind: input.kind,
    };
    const tags: Tags = ["booking", "booking-ask"];
    // In-app copy is in the render locale (copy/booking.ts); email stays
    // English. The English title is kept in sync with the email template's
    // subject (packages/ui-email BookingAskReceived.tsx).
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_ASK_RECEIVED_COPY[locale];
      const answerPhrase = c.answerPhrase[input.kind];
      const lede = c.lede({ answerPhrase });
      return {
        title: c.title({ venueName: input.venueName, label: input.label }),
        answerPhrase,
        // The venue's note is its own words: first, verbatim.
        body: input.note ? `${input.note}\n\n${lede}` : lede,
        label: c.answerLabel,
      };
    };
    const english = textIn("en");
    const local = textIn(ctx.locale);
    const { title, body } = english;
    const action: NotificationAction = {
      label: local.label,
      href: input.targetUrl,
    };
    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.ask-received",
        bookingRequestId: input.bookingRequestId,
        askId: input.askId,
      },
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [body, `${english.label}: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.ask_received",
          variables: {
            venueName: input.venueName,
            label: input.label,
            ...(input.note ? { note: input.note } : {}),
            answerPhrase: english.answerPhrase,
            targetUrl: input.targetUrl,
          },
        },
        tags,
        metadata,
      },
    };
  },
};

const bookingAskAnsweredSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    askId: z.string().uuid(),
    /** The act's (or the sending org's) name. Caller-resolved. */
    answeredByName: z.string().min(1).max(200),
    kind: bookingAskKindSchema,
    label: z.string().min(1).max(80),
    targetUrl: z.string().url(),
  })
  .strict();

type BookingAskAnsweredInput = z.infer<typeof bookingAskAnsweredSchema>;

/** In-app only (FR-009b): the venue side sees the answer on the thread. */
const bookingAskAnsweredRenderer: NotificationRendererDefinition<
  typeof bookingAskAnsweredSchema
> = {
  variant: "booking.ask-answered",
  category: "transactional",
  schema: bookingAskAnsweredSchema,
  render(
    input: BookingAskAnsweredInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      askId: input.askId,
      kind: input.kind,
    };
    const tags: Tags = ["booking", "booking-ask"];
    // In-app only; copy in the render locale (copy/booking.ts).
    const copy = BOOKING_ASK_ANSWERED_COPY[ctx.locale];
    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.ask-answered",
        bookingRequestId: input.bookingRequestId,
        askId: input.askId,
      },
      inApp: {
        title: copy.title({
          answeredByName: input.answeredByName,
          label: input.label,
        }),
        body: copy.body,
        kind: "INFO",
        action: { label: copy.viewRequestLabel, href: input.targetUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
    };
  },
};

const performerReviewPromptSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    placeId: z.string().uuid(),
    placeName: z.string().min(1),
    /** Absolute /review-a-place deep link, prefilled by the dispatch job. */
    reviewUrl: z.string().url(),
  })
  .strict();

type PerformerReviewPromptInput = z.infer<typeof performerReviewPromptSchema>;

/**
 * Post-gig venue-review ask for performers (booking-review-data-weave FR-009),
 * sent once per (event, human) by the post-event-prompts.dispatch drain —
 * never inline from the tRPC path. Category "marketing" on purpose: it is a
 * solicitation, so a marketing-email opt-out suppresses it (calm-honest-ux —
 * one prompt, no reminders, no pressure). Copy must never imply the venue
 * sees who reviewed (weave NFR-002): reviews surface only as anonymized
 * aggregates.
 */
const performerReviewPromptRenderer: NotificationRendererDefinition<
  typeof performerReviewPromptSchema
> = {
  variant: "post-event.performer-review-prompt",
  category: "marketing",
  schema: performerReviewPromptSchema,
  render(
    input: PerformerReviewPromptInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
      placeId: input.placeId,
    };

    const tags: Tags = ["post-event", "review-prompt", "performer"];
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = POST_EVENT_PERFORMER_REVIEW_PROMPT_COPY[ctx.locale];
    const english = POST_EVENT_PERFORMER_REVIEW_PROMPT_COPY.en;
    const copyValues = {
      eventTitle: input.eventTitle,
      placeName: input.placeName,
    };
    const title = english.title(copyValues);
    const body = english.body(copyValues);
    const action: NotificationAction = {
      label: copy.rateLabel,
      href: input.reviewUrl,
    };

    const textLines: string[] = [
      body,
      `Rate the place: ${input.reviewUrl}`,
      // Anonymity promise (weave NFR-002): aggregates only, never
      // attributed — and never imply otherwise.
      `Your answers only ever appear as anonymized aggregates alongside ` +
        `other artists' reviews — the place never sees who said what.`,
      `This is the only note we'll send about this gig — no reminders.`,
    ];

    return {
      category: "marketing",
      fingerprint: {
        variant: "post-event.performer-review-prompt",
        eventId: input.eventId,
        placeId: input.placeId,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: textLines.join("\n\n"),
        tags,
        metadata,
      },
    };
  },
};

const attendeeReviewPromptSchema = z
  .object({
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    /** The venue name, when the event has a resolvable place. Optional: the
     * attendee review form keys off the event, not the venue. */
    placeName: z.string().min(1).optional(),
    /** Absolute /review-event/{eventId} deep link, built by the dispatch job. */
    reviewUrl: z.string().url(),
  })
  .strict();

type AttendeeReviewPromptInput = z.infer<typeof attendeeReviewPromptSchema>;

/**
 * Post-event review ask for scanned-in attendees (attendee-reviews FR-006 /
 * FR-008), sent once per (event, human) by the post-event-prompts.dispatch
 * drain — never inline from the tRPC path. Category "marketing" on purpose
 * (same calm-honest reasoning as the performer prompt): it is a solicitation,
 * so a marketing-email opt-out suppresses it — one prompt, no reminders, no
 * pressure. Copy must state plainly (FR-008) that scores publish only in
 * aggregate once enough reviews exist and that comments reach the organizer
 * without the attendee's name.
 */
const attendeeReviewPromptRenderer: NotificationRendererDefinition<
  typeof attendeeReviewPromptSchema
> = {
  variant: "post-event.attendee-review-prompt",
  category: "marketing",
  schema: attendeeReviewPromptSchema,
  render(
    input: AttendeeReviewPromptInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      eventId: input.eventId,
    };

    const tags: Tags = ["post-event", "review-prompt", "attendee"];
    // In-app copy is in the render locale (copy/events.ts); email stays English.
    const copy = POST_EVENT_ATTENDEE_REVIEW_PROMPT_COPY[ctx.locale];
    const english = POST_EVENT_ATTENDEE_REVIEW_PROMPT_COPY.en;
    const copyValues = {
      eventTitle: input.eventTitle,
      placeName: input.placeName ?? null,
    };
    const title = english.title(copyValues);
    const body = english.body(copyValues);
    const action: NotificationAction = {
      label: copy.rateLabel,
      href: input.reviewUrl,
    };

    const textLines: string[] = [
      body,
      `Share your thoughts: ${input.reviewUrl}`,
      // Plain-language visibility promise (FR-008): scores only ever show up
      // as an aggregate once enough people review, and comments are
      // unattributed to the organizer.
      `Your ratings only ever appear as part of an aggregate score, once ` +
        `enough people have reviewed — never on their own.`,
      `Any comments go straight to the organizer, without your name attached.`,
      `We're only asking once — no reminders.`,
    ];

    return {
      category: "marketing",
      fingerprint: {
        variant: "post-event.attendee-review-prompt",
        eventId: input.eventId,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body(copyValues),
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: textLines.join("\n\n"),
        tags,
        metadata,
      },
    };
  },
};

const bookingMessageReceivedSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    messageId: z.string().uuid(),
    /**
     * Display name of the message's AUTHOR side (venue/org name or act
     * name). The CALLER (notify-booking-request-message) guarantees
     * non-empty; the `.min(1)` fails notify() BEFORE its idempotency claim
     * (same hazard note as bookingRequestReceivedSchema.actName).
     */
    senderLabel: z.string().min(1).max(200),
    /** Body preview — caller-clipped to ~240; slack for edge rows. */
    preview: z.string().min(1).max(500),
    /** Absolute, PER-RECIPIENT deep link into the thread surface. */
    threadUrl: z.string().url(),
  })
  .strict();

type BookingMessageReceivedInput = z.infer<typeof bookingMessageReceivedSchema>;

/**
 * Either side of a booking-request thread: the counterparty posted a message
 * (booking-conversation FR-003). Sent inline post-commit by
 * postBookingRequestMessage via notify-booking-request-message. In-app +
 * email + push; the email is subject+text only (NO ui-email template key —
 * a missing template would be silently skipped by the mail adapter, and no
 * booking.message template exists yet; revisit with the thread UI step).
 * Deliberately NO SMS payload (spec out_of_scope — dispatcher also disables
 * the channel explicitly).
 */
const bookingMessageReceivedRenderer: NotificationRendererDefinition<
  typeof bookingMessageReceivedSchema
> = {
  variant: "booking.message-received",
  category: "transactional",
  schema: bookingMessageReceivedSchema,
  render(
    input: BookingMessageReceivedInput,
    ctx: RendererContext,
  ): RenderNotificationResult {
    const metadata: Metadata = {
      bookingRequestId: input.bookingRequestId,
      messageId: input.messageId,
    };

    const tags: Tags = ["booking", "message-received"];
    // In-app title and label are in the render locale (copy/booking.ts);
    // push and email stay English. The body is the author's own words.
    const copy = BOOKING_MESSAGE_RECEIVED_COPY[ctx.locale];
    const title = BOOKING_MESSAGE_RECEIVED_COPY.en.title({
      senderLabel: input.senderLabel,
    });
    const body = input.preview;
    const action: NotificationAction = {
      label: copy.openConversationLabel,
      href: input.threadUrl,
    };

    return {
      category: "transactional",
      // Per-MESSAGE fingerprint — every message is its own notification
      // (unlike request-level variants that fingerprint on the request).
      fingerprint: {
        variant: "booking.message-received",
        bookingRequestId: input.bookingRequestId,
        messageId: input.messageId,
      },
      inApp: {
        title: copy.title({ senderLabel: input.senderLabel }),
        body,
        kind: "INFO",
        action,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        // Collapse per REQUEST: a burst of messages on one thread folds into
        // the latest push instead of stacking N banners.
        collapseKey: `booking-thread-${input.bookingRequestId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          messageId: input.messageId,
          url: input.threadUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [body, `Reply on the thread: ${input.threadUrl}`].join("\n\n"),
        tags,
        metadata,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Booking holds (docs/specs/2026-08-25/completed/booking-holds.spec.yaml, FR-016).
//
// Nine variants, one per intent kind, dispatched by
// booking-holds/notify-booking-hold-intents. The ACT-facing payloads carry
// the act's OWN date and position only — never who else is in the line
// (locked decision: "acts see their own date and position only"). The
// STAFF-facing payloads carry the act's name because staff already see it on
// the request.
//
// Dates: `date` is the hold's place-local ISO day (YYYY-MM-DD); `respondByISO`
// is an instant, rendered in the place's zone. Both are pre-formatted HERE so
// the ui-email templates receive plain labels (same posture as
// volunteer.shift-reminder's `kindLabel`).
// ─────────────────────────────────────────────────────────────────────────────

const HOLD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bookingHoldBaseSchema = z
  .object({
    bookingRequestId: z.string().uuid(),
    holdId: z.string().uuid(),
    /** Venue name — the dispatcher guarantees non-empty (fallback constant). */
    placeName: z.string().min(1).max(200),
    /** Place-local ISO day of the hold. */
    date: z.string().regex(HOLD_DATE_RE),
    /** IANA zone the deadline is rendered in (dispatcher-validated; UTC fallback). */
    timezone: z.string().min(1).max(64),
    /** Absolute, PER-RECIPIENT deep link (act view or staff inbox). */
    targetUrl: z.string().url(),
  })
  .strict();

/** "Thu, Aug 14, 2026" from a YYYY-MM-DD day — zone-independent by construction. */
function formatHoldDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const instant = new Date(Date.UTC(y!, m! - 1, d!, 12));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(instant);
}

/**
 * "Fri, Aug 14 at 7:00 PM CDT" — deadline instant in the place's zone. An
 * unknown IANA id reads in the platform default, the same zone the Spanish
 * line (formatEventStart) falls back to; resolveTimeZone validates the id,
 * so formatting cannot throw on it.
 */
function formatRespondBy(iso: string, timezone: string): string {
  const instant = new Date(iso);
  const zone = resolveTimeZone(timezone);
  const dayOptions: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return `${new Intl.DateTimeFormat("en-US", { ...dayOptions, timeZone: zone }).format(instant)} at ${new Intl.DateTimeFormat("en-US", { ...timeOptions, timeZone: zone }).format(instant)}`;
}

/**
 * The hold's day in `locale`, for in-app copy. English keeps
 * `formatHoldDate`'s shape exactly (it is also the email/push label); other
 * locales use the shared event-date phrasing ("viernes 14 de agosto de
 * 2026"), formatted at noon UTC in UTC so the day never shifts.
 */
function holdDateLabel(locale: NotificationLocale, day: string): string {
  if (locale === "en") return formatHoldDate(day);
  return formatEventDate(locale, `${day}T12:00:00.000Z`, "UTC") ?? day;
}

/** The deadline in `locale`, in the place's zone. English = `formatRespondBy`. */
function respondByLabel(
  locale: NotificationLocale,
  iso: string,
  timezone: string,
): string {
  if (locale === "en") return formatRespondBy(iso, timezone);
  return (
    formatEventStart(locale, iso, timezone) ?? formatRespondBy(iso, timezone)
  );
}

const BOOKING_HOLD_TAGS: Tags = ["booking", "hold"];

function bookingHoldMetadata(
  input: z.infer<typeof bookingHoldBaseSchema>,
  extra: Metadata = {},
): Metadata {
  return {
    bookingRequestId: input.bookingRequestId,
    holdId: input.holdId,
    date: input.date,
    ...extra,
  };
}

function bookingHoldPush(
  input: z.infer<typeof bookingHoldBaseSchema>,
  title: string,
  body: string,
  metadata: Metadata,
): PushChannelPayload {
  return {
    title,
    body,
    // Collapse per HOLD — a burst of transitions on one hold folds into the
    // latest push.
    collapseKey: `booking-hold-${input.holdId}`,
    data: {
      bookingRequestId: input.bookingRequestId,
      holdId: input.holdId,
      url: input.targetUrl,
    },
    tags: BOOKING_HOLD_TAGS,
    metadata,
    template: null,
  };
}

// ── booking.hold-placed (act, FR-002) ────────────────────────────────────────

const bookingHoldPlacedSchema = bookingHoldBaseSchema
  .extend({ position: z.number().int().min(1) })
  .strict();

const bookingHoldPlacedRenderer: NotificationRendererDefinition<
  typeof bookingHoldPlacedSchema
> = {
  variant: "booking.hold-placed",
  category: "transactional",
  schema: bookingHoldPlacedSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input, { position: String(input.position) });
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_HOLD_PLACED_COPY[locale];
      const day = holdDateLabel(locale, input.date);
      return {
        title: c.title({ placeName: input.placeName, dateLabel: day }),
        body: c.body({ dateLabel: day, position: input.position }),
      };
    };
    const { title, body } = textIn("en");
    const local = textIn(ctx.locale);
    const action: NotificationAction = {
      label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
      href: input.targetUrl,
    };
    return {
      category: "transactional",
      fingerprint: { variant: "booking.hold-placed", holdId: input.holdId },
      inApp: { title: local.title, body: local.body, kind: "INFO", action, expiresAt: null, tags: BOOKING_HOLD_TAGS, metadata, template: null },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        // Kept in sync with the registry subjectTemplate for booking.hold_placed.
        subject: title,
        text: [body, `A hold is not a booking yet — the place confirms it when the date is settled.`, `View your request: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_placed",
          variables: {
            kind: "placed",
            placeName: input.placeName,
            dateLabel,
            position: input.position,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

// ── booking.hold-placed-batch (act, FR-002 batch digest) ─────────────────────

/**
 * ONE notification for a run of dates pencilled in by a single staff action.
 * Without it, three dates would be three emails and three pushes inside a
 * second. `.min(2)` is the point of the variant: a one-date batch renders as
 * plain `booking.hold-placed`, and the dispatcher never emits this below two.
 * Names the act's OWN dates and positions only — never another act (FR-013).
 */
const bookingHoldPlacedBatchSchema = bookingHoldBaseSchema
  .extend({
    dates: z
      .array(
        z
          .object({
            date: z.string().regex(HOLD_DATE_RE),
            position: z.number().int().min(1),
          })
          .strict(),
      )
      .min(2)
      .max(31),
  })
  .strict();

const bookingHoldPlacedBatchRenderer: NotificationRendererDefinition<
  typeof bookingHoldPlacedBatchSchema
> = {
  variant: "booking.hold-placed-batch",
  category: "transactional",
  schema: bookingHoldPlacedBatchSchema,
  render(input, ctx): RenderNotificationResult {
    const rows = input.dates.map((entry) => ({
      dateLabel: formatHoldDate(entry.date),
      position: entry.position,
    }));
    const count = rows.length;
    const metadata = bookingHoldMetadata(input, {
      dateCount: String(count),
      dates: input.dates.map((entry) => entry.date).join(","),
    });
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English. The English title is kept in sync with the
    // registry subjectTemplate for booking.hold_placed (kind: "placed_batch").
    // Each line is "date — the act's OWN place in line", nothing else.
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_HOLD_PLACED_BATCH_COPY[locale];
      const lines = input.dates.map((entry) =>
        c.line({
          dateLabel: holdDateLabel(locale, entry.date),
          position: entry.position,
        }),
      );
      return {
        title: c.title({ placeName: input.placeName, count }),
        lines,
        body: lines.join("; "),
      };
    };
    const { title, lines, body } = textIn("en");
    const local = textIn(ctx.locale);
    // Push bodies get truncated by the OS; name the first date and the count
    // rather than a list that would be cut mid-date.
    const pushBody = `You're in line for ${count} dates, starting ${rows[0]!.dateLabel}.`;
    const action: NotificationAction = {
      label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
      href: input.targetUrl,
    };
    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.hold-placed-batch",
        holdId: input.holdId,
        // The SET, so two batches anchored on the same first hold never
        // collapse into one in-app row.
        dates: input.dates.map((entry) => entry.date).join(","),
      },
      inApp: { title: local.title, body: local.body, kind: "INFO", action, expiresAt: null, tags: BOOKING_HOLD_TAGS, metadata, template: null },
      push: {
        title,
        body: pushBody,
        // One collapse key for the batch — a later per-hold transition
        // collapses on its own hold, not over the digest.
        collapseKey: `booking-hold-batch-${input.holdId}`,
        data: {
          bookingRequestId: input.bookingRequestId,
          holdId: input.holdId,
          url: input.targetUrl,
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [
          `${input.placeName} is holding these dates for you:`,
          lines.join("\n"),
          `A hold is not a booking yet — the place confirms it when the date is settled.`,
          `View your request: ${input.targetUrl}`,
        ].join("\n\n"),
        template: {
          key: "booking.hold_placed",
          variables: {
            kind: "placed_batch",
            placeName: input.placeName,
            dates: rows,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

// ── booking.hold-position-changed (act, FR-003 + move-ups) ───────────────────

const bookingHoldPositionChangedSchema = bookingHoldBaseSchema
  .extend({ position: z.number().int().min(1) })
  .strict();

/**
 * In-app (+push) always; email ONLY when the act became first in line — a
 * move from 4th to 3rd is not worth an email (FR-016 channel decision).
 */
const bookingHoldPositionChangedRenderer: NotificationRendererDefinition<
  typeof bookingHoldPositionChangedSchema
> = {
  variant: "booking.hold-position-changed",
  category: "transactional",
  schema: bookingHoldPositionChangedSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input, { position: String(input.position) });
    const first = input.position === 1;
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_HOLD_POSITION_CHANGED_COPY[locale];
      return {
        title: c.title({ dateLabel: holdDateLabel(locale, input.date), first }),
        body: c.body({ placeName: input.placeName, position: input.position }),
      };
    };
    const { title, body } = textIn("en");
    const local = textIn(ctx.locale);
    const action: NotificationAction = {
      label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
      href: input.targetUrl,
    };
    return {
      category: "transactional",
      fingerprint: {
        variant: "booking.hold-position-changed",
        holdId: input.holdId,
        position: input.position,
      },
      inApp: { title: local.title, body: local.body, kind: "INFO", action, expiresAt: null, tags: BOOKING_HOLD_TAGS, metadata, template: null },
      push: bookingHoldPush(input, title, body, metadata),
      ...(first
        ? {
            email: {
              subject: title,
              text: [body, `View your request: ${input.targetUrl}`].join("\n\n"),
              template: {
                key: "booking.hold_placed",
                variables: {
                  kind: "moved",
                  placeName: input.placeName,
                  dateLabel,
                  position: 1,
                  targetUrl: input.targetUrl,
                },
              },
              tags: BOOKING_HOLD_TAGS,
              metadata,
            },
          }
        : {}),
    };
  },
};

// ── booking.hold-challenged / -challenge-extended (act, FR-004 / FR-005) ─────

const bookingHoldChallengeSchema = bookingHoldBaseSchema
  .extend({
    audience: z.enum(["act", "staff"]).default("act"),
    /** 1 = the challenged act (must answer); 2 = next in line (informational). */
    position: z.union([z.literal(1), z.literal(2)]),
    respondByISO: z.string().datetime({ offset: true }),
    /** STAFF only — the challenged act's name. Forbidden for `act`. */
    actName: z.string().min(1).max(200).optional(),
    /**
     * booking-the-night N19 / FR-014 — the CHALLENGED act (position 1) only:
     * what Keep will do. `book_now`: their terms for the night are sent, and
     * Keep agrees them and books it. `ask_for_terms`: Keep asks the venue for
     * terms. Absent on older payloads (generic copy). Forbidden for staff.
     */
    keepWill: z.enum(["book_now", "ask_for_terms"]).optional(),
  })
  .strict()
  .refine((v) => (v.audience === "staff" ? Boolean(v.actName) : v.actName === undefined), {
    message: "actName is required for staff and forbidden for act",
    path: ["actName"],
  })
  .refine((v) => v.keepWill === undefined || (v.audience === "act" && v.position === 1), {
    message: "keepWill is for the challenged act only",
    path: ["keepWill"],
  });

function renderChallenge(
  variant: "booking.hold-challenged" | "booking.hold-challenge-extended",
  input: z.infer<typeof bookingHoldChallengeSchema>,
  ctx: RendererContext,
): RenderNotificationResult {
  const extended = variant === "booking.hold-challenge-extended";
  const dateLabel = formatHoldDate(input.date);
  const respondBy = formatRespondBy(input.respondByISO, input.timezone);
  const metadata = bookingHoldMetadata(input, {
    position: String(input.position),
    respondBy: input.respondByISO,
  });
  const challenged = input.position === 1;
  // In-app copy is in the render locale (copy/booking-holds.ts); push and
  // email stay English.
  const wordsIn = (locale: NotificationLocale) => ({
    c: BOOKING_HOLD_CHALLENGE_COPY[locale],
    dateLabel: holdDateLabel(locale, input.date),
    respondBy: respondByLabel(locale, input.respondByISO, input.timezone),
  });

  if (input.audience === "staff") {
    // The assignee's in-app ping (FR-004/FR-005): no email, per FR-016.
    const actName = input.actName!;
    const textIn = (locale: NotificationLocale) => {
      const w = wordsIn(locale);
      return {
        title: w.c.staffTitle({ actName, dateLabel: w.dateLabel, extended }),
        body: w.c.staffBody({ actName, respondBy: w.respondBy }),
      };
    };
    const { title, body } = textIn("en");
    const local = textIn(ctx.locale);
    return {
      category: "transactional",
      fingerprint: { variant, holdId: input.holdId, audience: "staff", respondBy: input.respondByISO },
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action: {
          label: BOOKING_HOLD_COMMON_COPY[ctx.locale].openBookingInbox,
          href: input.targetUrl,
        },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
    };
  }

  // N20's challenge notice for the act at 1st hold (owner copy, 2026-09-29)
  // never names the other act; its second sentence says what Keep will do
  // (FR-014) when the payload carries `keepWill`. The act next in line only
  // learns that the first hold was challenged.
  const textIn = (locale: NotificationLocale) => {
    const { c, dateLabel: day, respondBy: by } = wordsIn(locale);
    const where = { placeName: input.placeName, dateLabel: day, extended };
    if (challenged) {
      return {
        title: c.challengedTitle(where),
        body: extended
          ? c.extendedBody({ respondBy: by })
          : c.challengedBody({ dateLabel: day, respondBy: by, keepWill: input.keepWill }),
        label: c.keepOrReleaseLabel,
      };
    }
    return {
      title: c.nextTitle(where),
      body: c.nextBody({ placeName: input.placeName, respondBy: by }),
      label: BOOKING_HOLD_COMMON_COPY[locale].viewYourRequest,
    };
  };
  const english = textIn("en");
  const local = textIn(ctx.locale);
  const { title, body } = english;
  const action: NotificationAction = {
    label: local.label,
    href: input.targetUrl,
  };

  return {
    category: "transactional",
    fingerprint: {
      variant,
      holdId: input.holdId,
      position: input.position,
      respondBy: input.respondByISO,
    },
    inApp: {
      title: local.title,
      body: local.body,
      kind: challenged ? "WARNING" : "INFO",
      action,
      expiresAt: null,
      tags: BOOKING_HOLD_TAGS,
      metadata,
      template: null,
    },
    push: bookingHoldPush(input, title, body, metadata),
    email: {
      subject: title,
      text: [body, `${english.label}: ${input.targetUrl}`].join("\n\n"),
      template: {
        key: "booking.hold_challenged",
        variables: {
          placeName: input.placeName,
          dateLabel,
          respondByLabel: respondBy,
          position: input.position,
          extended,
          targetUrl: input.targetUrl,
          ...(input.keepWill ? { keepWill: input.keepWill } : {}),
        },
      },
      tags: BOOKING_HOLD_TAGS,
      metadata,
    },
  };
}

const bookingHoldChallengedRenderer: NotificationRendererDefinition<
  typeof bookingHoldChallengeSchema
> = {
  variant: "booking.hold-challenged",
  category: "transactional",
  schema: bookingHoldChallengeSchema,
  render(input, ctx) {
    return renderChallenge("booking.hold-challenged", input, ctx);
  },
};

const bookingHoldChallengeExtendedRenderer: NotificationRendererDefinition<
  typeof bookingHoldChallengeSchema
> = {
  variant: "booking.hold-challenge-extended",
  category: "transactional",
  schema: bookingHoldChallengeSchema,
  render(input, ctx) {
    return renderChallenge("booking.hold-challenge-extended", input, ctx);
  },
};

// ── booking.hold-challenge-answered (staff email + in-app; act in-app) ───────

const bookingHoldChallengeAnsweredSchema = bookingHoldBaseSchema
  .extend({
    audience: z.enum(["act", "staff"]),
    answer: z.enum(["kept", "released"]),
    /**
     * STAFF only: the answering act's name (staff see it on the request).
     * MUST be absent for `act` — the position-2 act never learns who is
     * ahead of them.
     */
    actName: z.string().min(1).max(200).optional(),
    /**
     * booking-the-night FR-014, `kept` only: the act kept the hold with no
     * terms sent and has until `respondByISO` (the deadline the keep set) to
     * agree them. STAFF: "send them terms to keep this night". ACT: the
     * keeper's own notice (review W2) — the absolute deadline; the act at
     * position 2 never carries it.
     */
    awaitingTerms: z.literal(true).optional(),
    respondByISO: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((v) => (v.audience === "staff" ? Boolean(v.actName) : v.actName === undefined), {
    message: "actName is required for staff and forbidden for act",
    path: ["actName"],
  })
  .refine(
    (v) =>
      v.awaitingTerms === undefined
        ? v.respondByISO === undefined
        : v.answer === "kept" && v.respondByISO !== undefined,
    { message: "awaitingTerms is kept only, with its deadline", path: ["awaitingTerms"] },
  );

/**
 * FR-006: the challenged act answered. Staff (the assignee) get in-app +
 * email. The position-2 act only hears about a KEEP ("the first hold
 * stands") and only in-app — a release reaches them as a
 * `booking.hold-position-changed` move-up instead.
 */
const bookingHoldChallengeAnsweredRenderer: NotificationRendererDefinition<
  typeof bookingHoldChallengeAnsweredSchema
> = {
  variant: "booking.hold-challenge-answered",
  category: "transactional",
  schema: bookingHoldChallengeAnsweredSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input, { answer: input.answer });
    const fingerprint = {
      variant: "booking.hold-challenge-answered",
      holdId: input.holdId,
      audience: input.audience,
      answer: input.answer,
    };
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const wordsIn = (locale: NotificationLocale) => ({
      c: BOOKING_HOLD_CHALLENGE_ANSWERED_COPY[locale],
      dateLabel: holdDateLabel(locale, input.date),
    });
    const viewYourRequest = BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest;

    if (input.audience === "act" && input.awaitingTerms && input.respondByISO) {
      // The keeper's own notice (review W2): the ABSOLUTE deadline the keep
      // set — never "48 hours", which a longer venue deadline can outlast.
      const respondByISO = input.respondByISO;
      const textIn = (locale: NotificationLocale) => {
        const { c, dateLabel: day } = wordsIn(locale);
        return {
          title: c.keeperTitle({ dateLabel: day }),
          body: c.keeperBody({
            placeName: input.placeName,
            respondBy: respondByLabel(locale, respondByISO, input.timezone),
          }),
        };
      };
      const { title, body } = textIn("en");
      const local = textIn(ctx.locale);
      return {
        category: "transactional",
        fingerprint: { ...fingerprint, respondBy: input.respondByISO },
        inApp: {
          title: local.title,
          body: local.body,
          kind: "INFO",
          action: { label: viewYourRequest, href: input.targetUrl },
          expiresAt: null,
          tags: BOOKING_HOLD_TAGS,
          metadata,
          template: null,
        },
        push: bookingHoldPush(input, title, body, metadata),
      };
    }

    if (input.audience === "act") {
      // The act next in line: never who is ahead of them.
      const textIn = (locale: NotificationLocale) => {
        const { c, dateLabel: day } = wordsIn(locale);
        return {
          title: c.standsTitle({ dateLabel: day }),
          body: c.standsBody({ placeName: input.placeName }),
        };
      };
      const { title, body } = textIn("en");
      const local = textIn(ctx.locale);
      return {
        category: "transactional",
        fingerprint,
        inApp: {
          title: local.title,
          body: local.body,
          kind: "INFO",
          action: { label: viewYourRequest, href: input.targetUrl },
          expiresAt: null,
          tags: BOOKING_HOLD_TAGS,
          metadata,
          template: null,
        },
        push: bookingHoldPush(input, title, body, metadata),
      };
    }

    const actName = input.actName!;
    const kept = input.answer === "kept";
    const awaitingTermsBy =
      input.awaitingTerms && input.respondByISO ? input.respondByISO : null;
    const textIn = (locale: NotificationLocale) => {
      const { c, dateLabel: day } = wordsIn(locale);
      return {
        title: c.staffTitle({ actName, dateLabel: day, kept }),
        body: !kept
          ? c.staffReleasedBody({ dateLabel: day })
          : awaitingTermsBy
            ? // FR-014: Keep = commit, with no terms sent yet.
              c.staffKeptAwaitingTermsBody({
                respondBy: respondByLabel(locale, awaitingTermsBy, input.timezone),
              })
            : c.staffKeptBody,
      };
    };
    const { title, body } = textIn("en");
    const local = textIn(ctx.locale);
    const respondByLabelEn = awaitingTermsBy
      ? formatRespondBy(awaitingTermsBy, input.timezone)
      : null;
    return {
      category: "transactional",
      fingerprint,
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action: {
          label: BOOKING_HOLD_COMMON_COPY[ctx.locale].openBookingInbox,
          href: input.targetUrl,
        },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `Open your booking inbox: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_staff_attention",
          variables: {
            kind: kept ? "answered_kept" : "answered_released",
            actName,
            placeName: input.placeName,
            dateLabel,
            targetUrl: input.targetUrl,
            ...(respondByLabelEn ? { respondByLabel: respondByLabelEn } : {}),
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

// ── booking.hold-released / -lost-date / -expired ────────────────────────────

const bookingHoldReleasedSchema = bookingHoldBaseSchema
  .extend({
    reason: z.enum([
      "MANUAL",
      "REQUEST_CLOSED",
      "SIBLING_CONFIRMED",
      "EVENT_SCHEDULED",
    ]),
    /**
     * Defaults to the act. `staff` exists ONLY for EVENT_SCHEDULED (FR-018):
     * the assignee's in-app note that a published event took a held date.
     */
    audience: z.enum(["act", "staff"]).optional(),
    /** STAFF only — see bookingHoldChallengeAnsweredSchema. */
    actName: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.audience === "staff"
        ? v.reason === "EVENT_SCHEDULED" && Boolean(v.actName)
        : v.actName === undefined,
    {
      message:
        "staff audience is EVENT_SCHEDULED-only and requires actName; actName is forbidden for act",
      path: ["actName"],
    },
  );

/**
 * Act-facing release (FR-006 staff manual, FR-008 sibling-of-confirm, FR-009
 * request closure, FR-018 date taken by a published event). The reason picks
 * the sentence; none of them mention any other act. The FR-018 reason also
 * has a staff (assignee) shape: in-app only.
 */
const bookingHoldReleasedRenderer: NotificationRendererDefinition<
  typeof bookingHoldReleasedSchema
> = {
  variant: "booking.hold-released",
  category: "transactional",
  schema: bookingHoldReleasedSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const local = BOOKING_HOLD_RELEASED_COPY[ctx.locale];
    const english = BOOKING_HOLD_RELEASED_COPY.en;
    const localDateLabel = holdDateLabel(ctx.locale, input.date);
    if (input.audience === "staff") {
      const actName = input.actName!;
      const metadata = bookingHoldMetadata(input, {
        reason: input.reason,
        audience: "staff",
      });
      const title = english.staffTitle({ actName, dateLabel });
      const body = english.staffBody;
      return {
        category: "transactional",
        fingerprint: {
          variant: "booking.hold-released",
          holdId: input.holdId,
          audience: "staff",
        },
        inApp: {
          title: local.staffTitle({ actName, dateLabel: localDateLabel }),
          body: local.staffBody,
          kind: "INFO",
          action: {
            label: BOOKING_HOLD_COMMON_COPY[ctx.locale].openBookingInbox,
            href: input.targetUrl,
          },
          expiresAt: null,
          tags: BOOKING_HOLD_TAGS,
          metadata,
          template: null,
        },
        push: bookingHoldPush(input, title, body, metadata),
      };
    }
    const metadata = bookingHoldMetadata(input, { reason: input.reason });
    const why = { placeName: input.placeName, reason: input.reason };
    const title = english.title({ placeName: input.placeName, dateLabel });
    const body = english.body(why);
    return {
      category: "transactional",
      fingerprint: { variant: "booking.hold-released", holdId: input.holdId },
      inApp: {
        title: local.title({
          placeName: input.placeName,
          dateLabel: localDateLabel,
        }),
        body: local.body(why),
        kind: "INFO",
        action: {
          label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
          href: input.targetUrl,
        },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `View your request: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_released",
          variables: {
            reason:
              input.reason === "SIBLING_CONFIRMED"
                ? "sibling_confirmed"
                : input.reason === "REQUEST_CLOSED"
                  ? "request_closed"
                  : input.reason === "EVENT_SCHEDULED"
                    ? "event_scheduled"
                    : "released",
            placeName: input.placeName,
            dateLabel,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

const bookingHoldLostDateSchema = bookingHoldBaseSchema;

/** FR-008 loser: the date went to another act (unnamed). */
const bookingHoldLostDateRenderer: NotificationRendererDefinition<
  typeof bookingHoldLostDateSchema
> = {
  variant: "booking.hold-lost-date",
  category: "transactional",
  schema: bookingHoldLostDateSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input, { reason: "CONFIRMED_OTHER" });
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const textIn = (locale: NotificationLocale) => {
      const c = BOOKING_HOLD_LOST_DATE_COPY[locale];
      const day = holdDateLabel(locale, input.date);
      return {
        title: c.title({ placeName: input.placeName, dateLabel: day }),
        body: c.body({ dateLabel: day }),
      };
    };
    const { title, body } = textIn("en");
    const local = textIn(ctx.locale);
    return {
      category: "transactional",
      fingerprint: { variant: "booking.hold-lost-date", holdId: input.holdId },
      inApp: {
        title: local.title,
        body: local.body,
        kind: "INFO",
        action: {
          label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
          href: input.targetUrl,
        },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `View your request: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_released",
          variables: {
            reason: "lost_date",
            placeName: input.placeName,
            dateLabel,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

const bookingHoldExpiredSchema = bookingHoldBaseSchema
  .extend({
    audience: z.enum(["act", "staff"]),
    /** STAFF only — see bookingHoldChallengeAnsweredSchema. */
    actName: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.audience === "staff" ? Boolean(v.actName) : v.actName === undefined), {
    message: "actName is required for staff and forbidden for act",
    path: ["actName"],
  });

/** FR-007: a challenged hold's deadline passed. Act + staff both get email. */
const bookingHoldExpiredRenderer: NotificationRendererDefinition<
  typeof bookingHoldExpiredSchema
> = {
  variant: "booking.hold-expired",
  category: "transactional",
  schema: bookingHoldExpiredSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input, { reason: "EXPIRED", audience: input.audience });
    const fingerprint = {
      variant: "booking.hold-expired",
      holdId: input.holdId,
      audience: input.audience,
    };
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const local = BOOKING_HOLD_EXPIRED_COPY[ctx.locale];
    const english = BOOKING_HOLD_EXPIRED_COPY.en;
    const localDateLabel = holdDateLabel(ctx.locale, input.date);

    if (input.audience === "act") {
      const title = english.title({ placeName: input.placeName, dateLabel });
      const body = english.body;
      return {
        category: "transactional",
        fingerprint,
        inApp: {
          title: local.title({
            placeName: input.placeName,
            dateLabel: localDateLabel,
          }),
          body: local.body,
          kind: "INFO",
          action: {
            label: BOOKING_HOLD_COMMON_COPY[ctx.locale].viewYourRequest,
            href: input.targetUrl,
          },
          expiresAt: null,
          tags: BOOKING_HOLD_TAGS,
          metadata,
          template: null,
        },
        push: bookingHoldPush(input, title, body, metadata),
        email: {
          subject: title,
          text: [body, `View your request: ${input.targetUrl}`].join("\n\n"),
          template: {
            key: "booking.hold_released",
            variables: { reason: "expired", placeName: input.placeName, dateLabel, targetUrl: input.targetUrl },
          },
          tags: BOOKING_HOLD_TAGS,
          metadata,
        },
      };
    }

    const actName = input.actName!;
    const title = english.staffTitle({ actName, dateLabel });
    const body = english.staffBody;
    return {
      category: "transactional",
      fingerprint,
      inApp: {
        title: local.staffTitle({ actName, dateLabel: localDateLabel }),
        body: local.staffBody,
        kind: "INFO",
        action: {
          label: BOOKING_HOLD_COMMON_COPY[ctx.locale].openBookingInbox,
          href: input.targetUrl,
        },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `Open your booking inbox: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_staff_attention",
          variables: {
            kind: "expired",
            actName,
            placeName: input.placeName,
            dateLabel,
            targetUrl: input.targetUrl,
          },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

// ── booking.hold-confirmed (act, FR-008 winner) ──────────────────────────────

const bookingHoldConfirmedSchema = bookingHoldBaseSchema;

const bookingHoldConfirmedRenderer: NotificationRendererDefinition<
  typeof bookingHoldConfirmedSchema
> = {
  variant: "booking.hold-confirmed",
  category: "transactional",
  schema: bookingHoldConfirmedSchema,
  render(input, ctx): RenderNotificationResult {
    const dateLabel = formatHoldDate(input.date);
    const metadata = bookingHoldMetadata(input);
    // In-app copy is in the render locale (copy/booking-holds.ts); push and
    // email stay English.
    const local = BOOKING_HOLD_CONFIRMED_COPY[ctx.locale];
    const english = BOOKING_HOLD_CONFIRMED_COPY.en;
    const title = english.title({ placeName: input.placeName, dateLabel });
    const body = english.body;
    return {
      category: "transactional",
      fingerprint: { variant: "booking.hold-confirmed", holdId: input.holdId },
      inApp: {
        title: local.title({
          placeName: input.placeName,
          dateLabel: holdDateLabel(ctx.locale, input.date),
        }),
        body: local.body,
        kind: "INFO",
        action: { label: local.viewBookingLabel, href: input.targetUrl },
        expiresAt: null,
        tags: BOOKING_HOLD_TAGS,
        metadata,
        template: null,
      },
      push: bookingHoldPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `View your booking: ${input.targetUrl}`].join("\n\n"),
        template: {
          key: "booking.hold_confirmed",
          variables: { placeName: input.placeName, dateLabel, targetUrl: input.targetUrl },
        },
        tags: BOOKING_HOLD_TAGS,
        metadata,
      },
    };
  },
};

// ── event.venue-confirmed / event.venue-confirmation-withdrawn ───────────────
// (event owner — venue-confirmation-and-booking-intents spec, docs/specs/
// 2026-08-27). Dispatched by `events/notify-venue-confirmation-intents.ts`.
// Email + in-app + push; the email is text-only until a ui-email template
// exists for these two (Step 4 may add one and switch `template` here).

const venueConfirmationBaseSchema = z
  .object({
    eventId: z.string().uuid(),
    /** Dispatcher-guaranteed non-empty (fallback constant). */
    eventTitle: z.string().min(1).max(200),
    placeId: z.string().uuid(),
    /** Dispatcher-guaranteed non-empty (fallback constant). */
    placeName: z.string().min(1).max(200),
    bookingRequestId: z.string().uuid().nullable(),
    /** Absolute, per-recipient link to the owner's admin event page. */
    targetUrl: z.string().url(),
  })
  .strict();

const VENUE_CONFIRMATION_TAGS: Tags = ["booking", "venue-confirmation"];

function venueConfirmationMetadata(
  input: z.infer<typeof venueConfirmationBaseSchema>,
  extra: Metadata = {},
): Metadata {
  return {
    eventId: input.eventId,
    placeId: input.placeId,
    ...(input.bookingRequestId ? { bookingRequestId: input.bookingRequestId } : {}),
    ...extra,
  };
}

function venueConfirmationPush(
  input: z.infer<typeof venueConfirmationBaseSchema>,
  title: string,
  body: string,
  metadata: Metadata,
): PushChannelPayload {
  return {
    title,
    body,
    // Collapse per EVENT — a confirm/withdraw burst on one event folds into
    // the latest push.
    collapseKey: `venue-confirmation-${input.eventId}`,
    data: { eventId: input.eventId, placeId: input.placeId, url: input.targetUrl },
    tags: VENUE_CONFIRMATION_TAGS,
    metadata,
    template: null,
  };
}

const venueConfirmedSchema = venueConfirmationBaseSchema;

const venueConfirmedRenderer: NotificationRendererDefinition<
  typeof venueConfirmedSchema
> = {
  variant: "event.venue-confirmed",
  category: "transactional",
  schema: venueConfirmedSchema,
  render(input, ctx): RenderNotificationResult {
    const metadata = venueConfirmationMetadata(input);
    // In-app copy is in the render locale (copy/events.ts); push and email
    // stay English.
    const copy = EVENT_VENUE_CONFIRMED_COPY[ctx.locale];
    const copyValues = {
      placeName: input.placeName,
      eventTitle: input.eventTitle,
    };
    const title = EVENT_VENUE_CONFIRMED_COPY.en.title(copyValues);
    const body = EVENT_VENUE_CONFIRMED_COPY.en.body;
    return {
      category: "transactional",
      fingerprint: { variant: "event.venue-confirmed", eventId: input.eventId },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body,
        kind: "INFO",
        action: { label: copy.viewEventLabel, href: input.targetUrl },
        expiresAt: null,
        tags: VENUE_CONFIRMATION_TAGS,
        metadata,
        template: null,
      },
      push: venueConfirmationPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `View your event: ${input.targetUrl}`].join("\n\n"),
        tags: VENUE_CONFIRMATION_TAGS,
        metadata,
      },
    };
  },
};

const venueConfirmationWithdrawnSchema = venueConfirmationBaseSchema
  .extend({
    /** The venue's own words, sanitized upstream. */
    reason: z.string().min(1).max(BOOKING_REASON_MAX),
  })
  .strict();

const venueConfirmationWithdrawnRenderer: NotificationRendererDefinition<
  typeof venueConfirmationWithdrawnSchema
> = {
  variant: "event.venue-confirmation-withdrawn",
  category: "transactional",
  schema: venueConfirmationWithdrawnSchema,
  render(input, ctx): RenderNotificationResult {
    const metadata = venueConfirmationMetadata(input, { reason: input.reason });
    // In-app copy is in the render locale (copy/events.ts); push and email
    // stay English. The reason is the venue's own words, verbatim.
    const copy = EVENT_VENUE_CONFIRMATION_WITHDRAWN_COPY[ctx.locale];
    const copyValues = {
      placeName: input.placeName,
      eventTitle: input.eventTitle,
    };
    const title =
      EVENT_VENUE_CONFIRMATION_WITHDRAWN_COPY.en.title(copyValues);
    const body = EVENT_VENUE_CONFIRMATION_WITHDRAWN_COPY.en.body({
      reason: input.reason,
    });
    return {
      category: "transactional",
      fingerprint: {
        variant: "event.venue-confirmation-withdrawn",
        eventId: input.eventId,
      },
      inApp: {
        title: copy.title(copyValues),
        body: copy.body({ reason: input.reason }),
        kind: "WARNING",
        action: { label: copy.editEventLabel, href: input.targetUrl },
        expiresAt: null,
        tags: VENUE_CONFIRMATION_TAGS,
        metadata,
        template: null,
      },
      push: venueConfirmationPush(input, title, body, metadata),
      email: {
        subject: title,
        text: [body, `Edit your event: ${input.targetUrl}`].join("\n\n"),
        tags: VENUE_CONFIRMATION_TAGS,
        metadata,
      },
    };
  },
};

// ── place.availability-setup-needed (venue staff, availability-onboarding FR-003) ──

/**
 * Setup nudge for a venue with ZERO CalendarAvailability rows whose staff just
 * turned booking acceptance ON or created a calendar (docs/specs/2026-08-31/
 * availability-onboarding.spec.yaml FR-003). IN-APP ONLY — spec-locked: no
 * email, no push, no sms payload, so those channels skip with
 * `renderer_omitted` regardless of preferences. Copy names the CONSEQUENCE
 * (every date shows unavailable; acts can't reach you), never the schema.
 */
const availabilitySetupNeededSchema = z
  .object({
    placeId: z.string().min(1),
    placeName: z.string().min(1).max(200),
    /** Absolute link to the place's calendars page (the fix, one click away). */
    calendarsUrl: z.string().url(),
  })
  .strict();

const availabilitySetupNeededRenderer: NotificationRendererDefinition<
  typeof availabilitySetupNeededSchema
> = {
  variant: "place.availability-setup-needed",
  category: "transactional",
  schema: availabilitySetupNeededSchema,
  render(input, ctx): RenderNotificationResult {
    const metadata: Metadata = { placeId: input.placeId };
    const tags: Tags = ["booking", "availability-setup"];
    // In-app only; copy in the render locale (copy/events.ts).
    const copy = PLACE_AVAILABILITY_SETUP_NEEDED_COPY[ctx.locale];
    return {
      category: "transactional",
      // One per place — the durable idempotency key upstream is the real
      // dedupe; the fingerprint mirrors it so notify()'s own replay window
      // collapses concurrent duplicates too.
      fingerprint: {
        variant: "place.availability-setup-needed",
        placeId: input.placeId,
      },
      inApp: {
        title: copy.title,
        body: copy.body({ placeName: input.placeName }),
        kind: "WARNING",
        action: { label: copy.setHoursLabel, href: input.calendarsUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      // NO push/email/sms — in-app only (spec-locked).
    };
  },
};

// ── P3a (unclaimed venues) ── `booking.venue-claim-invite` and
// `booking.requests-unparked` were removed with parking (amendment
// 2026-09-25). Neither can reach a renderer again: the invite was rendered
// and mailed in-process by its dispatcher, and notify() renders at call time
// and stores the rendered rows, so no queued payload names either variant.

const followEventUrlSchema = z.string().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  "A public HTTP(S) URL is required",
);

const entityNewEventSchema = z.object({
  entityPageId: z.string().min(1).max(200),
  entityName: plainTextRequired(300),
  eventId: z.string().min(1).max(200),
  eventTitle: plainTextRequired(500),
  startsAtIso: z.string().datetime(),
  timezone: z.string().max(100).nullish(),
  eventUrl: followEventUrlSchema,
  manageFollowingUrl: followEventUrlSchema,
}).strict();

const entityNewEventRenderer: NotificationRendererDefinition<
  typeof entityNewEventSchema
> = {
  variant: "entity.new-event",
  category: "organizerMessages",
  schema: entityNewEventSchema,
  render(input, ctx): RenderNotificationResult {
    // In-app copy is in the render locale (copy/events.ts); push and email
    // stay English.
    const copy = ENTITY_NEW_EVENT_COPY[ctx.locale];
    const title = ENTITY_NEW_EVENT_COPY.en.title({
      entityName: input.entityName,
    });
    const when = formatEventStart("en", input.startsAtIso, input.timezone);
    const body = ENTITY_NEW_EVENT_COPY.en.body({
      eventTitle: input.eventTitle,
      startsAt: when,
    });
    const tags = ["follow", "new-event"];
    const metadata = { entityPageId: input.entityPageId, eventId: input.eventId };
    const action = eventRouteAction(input.eventUrl, copy.viewEventLabel);
    return {
      category: "organizerMessages",
      // Per EVENT, not per page: following the org, the venue and the host
      // still yields one alert for one event.
      fingerprint: { variant: "entity.new-event", eventId: input.eventId },
      inApp: {
        title: copy.title({ entityName: input.entityName }),
        body: copy.body({
          eventTitle: input.eventTitle,
          startsAt: formatEventStart(
            ctx.locale,
            input.startsAtIso,
            input.timezone,
          ),
        }),
        kind: "INFO", action, expiresAt: null,
        tags, metadata, template: null,
      },
      push: {
        title, body,
        collapseKey: `follow-${input.eventId}`,
        data: { ...metadata, url: input.eventUrl },
        tags, metadata, template: null,
      },
      email: {
        subject: title,
        text: [title, body, `View event: ${input.eventUrl}`,
          `You follow ${input.entityName} on Ithas Fire.`,
          `Manage follows and notification preferences: ${input.manageFollowingUrl}`,
        ].join("\n\n"),
        tags, metadata,
      },
    };
  },
};

const registry = {
  [entityNewEventRenderer.variant]: entityNewEventRenderer,
  [genericRenderer.variant]: genericRenderer,
  [attendeeReminderRenderer.variant]: attendeeReminderRenderer,
  [attendeeFeedbackRequestRenderer.variant]: attendeeFeedbackRequestRenderer,
  [eventApplicationApprovedRenderer.variant]: eventApplicationApprovedRenderer,
  [eventApplicationReceivedRenderer.variant]: eventApplicationReceivedRenderer,
  [eventApplicationSubmissionReceivedRenderer.variant]:
    eventApplicationSubmissionReceivedRenderer,
  [eventApplicationRejectedRenderer.variant]: eventApplicationRejectedRenderer,
  [eventApplicationWaitlistedRenderer.variant]:
    eventApplicationWaitlistedRenderer,
  // Applicant notices (application-renderers.ts, owner decisions 2026-09-30).
  [eventApplicationBackInReviewRenderer.variant]:
    eventApplicationBackInReviewRenderer,
  [eventCancelledRenderer.variant]: eventCancelledRenderer,
  [eventChangedRenderer.variant]: eventChangedRenderer,
  [eventUnlistedRenderer.variant]: eventUnlistedRenderer,
  [eventLocationRevealedRenderer.variant]: eventLocationRevealedRenderer,
  [rsvpConfirmedRenderer.variant]: rsvpConfirmedRenderer,
  [rsvpDateCancelledRenderer.variant]: rsvpDateCancelledRenderer,
  [rsvpReminderRenderer.variant]: rsvpReminderRenderer,
  [settlementPayoutCompletedRenderer.variant]: settlementPayoutCompletedRenderer,
  [orderConfirmedRenderer.variant]: orderConfirmedRenderer,
  [orderRefundProcessedRenderer.variant]: orderRefundProcessedRenderer,
  [resalePurchaseConfirmedRenderer.variant]: resalePurchaseConfirmedRenderer,
  [volunteerSignupReceivedRenderer.variant]: volunteerSignupReceivedRenderer,
  [volunteerSignupApprovedRenderer.variant]: volunteerSignupApprovedRenderer,
  [volunteerSignupRejectedRenderer.variant]: volunteerSignupRejectedRenderer,
  [volunteerSpotOpenedRenderer.variant]: volunteerSpotOpenedRenderer,
  [volunteerShiftReminderRenderer.variant]: volunteerShiftReminderRenderer,
  [volunteerGroupCoordinatorAssignedRenderer.variant]:
    volunteerGroupCoordinatorAssignedRenderer,
  [volunteerPoolSignupReceivedRenderer.variant]:
    volunteerPoolSignupReceivedRenderer,
  [volunteerGroupSignupAssignedRenderer.variant]:
    volunteerGroupSignupAssignedRenderer,
  [volunteerOccurrenceCancelledRenderer.variant]:
    volunteerOccurrenceCancelledRenderer,
  [volunteerBroadcastRenderer.variant]: volunteerBroadcastRenderer,
  [imageModerationHeldRenderer.variant]: imageModerationHeldRenderer,
  [imageModerationApprovedRenderer.variant]: imageModerationApprovedRenderer,
  [imageModerationRejectedRenderer.variant]: imageModerationRejectedRenderer,
  [bookingRequestReceivedRenderer.variant]: bookingRequestReceivedRenderer,
  [bookingLineupInvitedRenderer.variant]: bookingLineupInvitedRenderer,
  [bookingMessageReceivedRenderer.variant]: bookingMessageReceivedRenderer,
  [organizerBookingRequestReceivedRenderer.variant]:
    organizerBookingRequestReceivedRenderer,
  [organizerBookingRequestRespondedRenderer.variant]:
    organizerBookingRequestRespondedRenderer,
  [bookingRequestRespondedRenderer.variant]: bookingRequestRespondedRenderer,
  [bookingCancelledRenderer.variant]: bookingCancelledRenderer,
  // ── P3b (asks) ──
  [bookingAskReceivedRenderer.variant]: bookingAskReceivedRenderer,
  [bookingAskAnsweredRenderer.variant]: bookingAskAnsweredRenderer,
  [performerReviewPromptRenderer.variant]: performerReviewPromptRenderer,
  [attendeeReviewPromptRenderer.variant]: attendeeReviewPromptRenderer,
  [bookingHoldPlacedRenderer.variant]: bookingHoldPlacedRenderer,
  [bookingHoldPlacedBatchRenderer.variant]: bookingHoldPlacedBatchRenderer,
  [bookingHoldPositionChangedRenderer.variant]: bookingHoldPositionChangedRenderer,
  [bookingHoldChallengedRenderer.variant]: bookingHoldChallengedRenderer,
  [bookingHoldChallengeExtendedRenderer.variant]: bookingHoldChallengeExtendedRenderer,
  [bookingHoldChallengeAnsweredRenderer.variant]: bookingHoldChallengeAnsweredRenderer,
  [bookingHoldReleasedRenderer.variant]: bookingHoldReleasedRenderer,
  [bookingHoldLostDateRenderer.variant]: bookingHoldLostDateRenderer,
  [bookingHoldExpiredRenderer.variant]: bookingHoldExpiredRenderer,
  [bookingHoldConfirmedRenderer.variant]: bookingHoldConfirmedRenderer,
  [venueConfirmedRenderer.variant]: venueConfirmedRenderer,
  [venueConfirmationWithdrawnRenderer.variant]:
    venueConfirmationWithdrawnRenderer,
  [availabilitySetupNeededRenderer.variant]: availabilitySetupNeededRenderer,
  // Lineup notices (owner ruling "option A", 2026-09-30) — lineup-renderers.ts.
  [eventLineupAddedRenderer.variant]: eventLineupAddedRenderer,
  [eventLineupLeftRenderer.variant]: eventLineupLeftRenderer,
  // Open-call notices (spec 2026-10-05, step 7) — open-call-renderers.ts.
  [openCallPickedRenderer.variant]: openCallPickedRenderer,
  [openCallNotThisTimeRenderer.variant]: openCallNotThisTimeRenderer,
  [openCallPulledRenderer.variant]: openCallPulledRenderer,
  [openCallMessageRenderer.variant]: openCallMessageRenderer,
  [openCallDroppedOutRenderer.variant]: openCallDroppedOutRenderer,
  [openCallReceivedRenderer.variant]: openCallReceivedRenderer,
  // The bill's notices after the invite (lineup v3 FR-012) —
  // booking-lineup-notice-renderers.ts.
  [bookingLineupAnsweredRenderer.variant]: bookingLineupAnsweredRenderer,
  [bookingLineupRequestClosedRenderer.variant]:
    bookingLineupRequestClosedRenderer,
  [bookingLineupRemovedRenderer.variant]: bookingLineupRemovedRenderer,
  // In-app-only variants for producers that write the row directly (resale,
  // disputes, entity reports) — direct-money-safety-renderers.ts.
  [resaleListingCreatedRenderer.variant]: resaleListingCreatedRenderer,
  [resaleClaimOpenedRenderer.variant]: resaleClaimOpenedRenderer,
  [resaleClaimResolvedRenderer.variant]: resaleClaimResolvedRenderer,
  [resaleClaimRefundedRenderer.variant]: resaleClaimRefundedRenderer,
  [resaleSellerSoldRenderer.variant]: resaleSellerSoldRenderer,
  [resaleListingClosedRelistRenderer.variant]:
    resaleListingClosedRelistRenderer,
  [resaleSaleRefundedListingClosedRenderer.variant]:
    resaleSaleRefundedListingClosedRenderer,
  [disputeRiskOwnerNoticeRenderer.variant]: disputeRiskOwnerNoticeRenderer,
  [entityReportSubmittedRenderer.variant]: entityReportSubmittedRenderer,
  [entityReportReviewedRenderer.variant]: entityReportReviewedRenderer,
  // In-app-only variants for producers that write their own inbox row
  // (claims, shift reminders, edit suggestions) —
  // direct-community-renderers.ts. Never sent through notify.
  [placeClaimReceivedRenderer.variant]: placeClaimReceivedRenderer,
  [placeClaimDecidedRenderer.variant]: placeClaimDecidedRenderer,
  [placeDisputeDecidedRenderer.variant]: placeDisputeDecidedRenderer,
  [placeOwnershipTransferredRenderer.variant]: placeOwnershipTransferredRenderer,
  [placeDisputeFiledRenderer.variant]: placeDisputeFiledRenderer,
  [volunteerShiftReminderInAppRenderer.variant]:
    volunteerShiftReminderInAppRenderer,
  [volunteerStartReminderInAppRenderer.variant]:
    volunteerStartReminderInAppRenderer,
  [suggestionReceivedRenderer.variant]: suggestionReceivedRenderer,
  [suggestionReviewedRenderer.variant]: suggestionReviewedRenderer,
  // In-app-only invite complaint auto-pause notices (W4), written by
  // events/invites/invite-pause-notifications.ts — invite-pause-renderers.ts.
  [invitePauseOpenedRenderer.variant]: invitePauseOpenedRenderer,
  [invitePauseDecidedRenderer.variant]: invitePauseDecidedRenderer,
  // A change to a frozen deal (freeze-the-deal FR-006) — deal-change-renderers.ts.
  [dealFrozenChangeRenderer.variant]: dealFrozenChangeRenderer,
} satisfies Record<string, NotificationRendererDefinition<z.ZodTypeAny>>;

export type NotificationRendererVariant = keyof typeof registry;

export function listNotificationRendererVariants(): NotificationRendererVariant[] {
  return Object.keys(registry) as NotificationRendererVariant[];
}

export function getNotificationRenderer(
  variant: string,
): NotificationRendererDefinition<z.ZodTypeAny> | null {
  return registry[variant] ?? null;
}

/**
 * Renders one notification variant from its payload.
 *
 * STORED PAYLOADS ARE A CONTRACT. `notify` stores the payload it was given on
 * the in-app row (`templateKey` = variant, `templateVersion` =
 * `IN_APP_TEMPLATE_VERSION`, `templateVariables` = payload), and the inbox
 * re-runs this function on that stored payload at READ time to show the row in
 * the reader's language (`render-stored-notification.ts`; only variants in
 * `LOCALIZED_VARIANTS`, `copy/index.ts`). So a variant's schema must keep
 * parsing every payload it ever accepted: add fields as optional, never
 * tighten or rename. Bump `IN_APP_TEMPLATE_VERSION` (old rows then fall back
 * to their stored English text) when:
 *   - a schema change cannot stay backward compatible; or
 *   - a renderer change SHOWS a payload field its in-app text did not show
 *     before. Old rows were stored when that field was invisible (it may hold
 *     data the reader was never shown, e.g. a withheld address), so a re-render
 *     must not start revealing it.
 * A stored payload that stops parsing falls back the same way, and is
 * reported to Sentry (once per variant per inbox read).
 */
export function renderNotification(
  variant: string,
  payload: unknown,
  context: RenderNotificationContext,
): RenderNotificationResult {
  const ctx: RendererContext = {
    now: context.now,
    locale: context.locale ?? DEFAULT_NOTIFICATION_LOCALE,
  };
  const definition = getNotificationRenderer(variant);
  if (!definition) {
    throw fail("UNKNOWN_NOTIFICATION_VARIANT");
  }

  const parsed = definition.schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw {
      code: "invalid_input",
      message: "invalid_notification_payload",
      issues: parsed.error.issues,
    } as const;
  }

  return definition.render(parsed.data, ctx);
}

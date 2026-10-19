import { z } from "zod";

import type { NotificationAction } from "@th/ports/repos/notifications";

import type { NotificationCategory } from "./categories";
import {
  SUGGESTION_RECEIVED_COPY,
  SUGGESTION_REVIEWED_COPY,
  suggestionReviewedBody,
} from "./copy/community-suggestions";
import {
  PLACE_CLAIM_DECIDED_COPY,
  PLACE_CLAIM_RECEIVED_COPY,
  PLACE_DISPUTE_DECIDED_COPY,
  PLACE_DISPUTE_FILED_COPY,
  PLACE_OWNERSHIP_TRANSFERRED_COPY,
  placeDecisionBody,
} from "./copy/places-claims";
import {
  VOLUNTEER_SHIFT_REMINDER_COPY,
  VOLUNTEER_START_REMINDER_COPY,
} from "./copy/volunteering";
import type { DirectRendererDefinition } from "./direct-in-app";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// IN-APP-ONLY variants for notices whose producers write the inbox row
// themselves instead of going through `notify` (in-app text i18n, Step 4b):
//
//   place.*                          places/_shared/claim-notifications.ts
//   volunteer.shift-reminder-in-app  volunteering/send-volunteer-shift-reminders.ts
//   volunteer.start-reminder-in-app  volunteering/send-volunteer-shift-reminders.ts
//   community.suggestion-*           community/_shared/suggestion-notifications.ts
//
// The producer renders its row's English through these (via
// `buildDirectInAppNotice`, direct-in-app.ts) and stores the
// payload as the row's template, exactly as `notify` does, so the inbox can
// re-render the row in the reader's language. Nothing ever sends these
// variants through `notify`: they render no email, push or SMS, and the
// producers keep their own delivery (transactions, ledgers, recipients).
//
// Registered in `renderers.ts`'s registry. This file must not import
// `renderers.ts` at runtime (the registry imports it); types only.
//
// Schemas are deliberately loose about text (no min/max): the producer
// renders its English through them, so a schema that rejected a real value
// would drop the notification, not just its translation. Stored payloads are a
// contract (see `renderNotification`): only ever add optional fields.
// ─────────────────────────────────────────────────────────────────────────────

type Tags = string[];
type Metadata = Record<string, string>;

function inAppOnly(
  variant: string,
  fingerprint: Record<string, unknown>,
  inApp: {
    title: string;
    body: string;
    kind: "INFO" | "SUCCESS" | "WARNING";
    action: NotificationAction | null;
    tags: Tags;
    metadata: Metadata;
  },
): RenderNotificationResult {
  return {
    category: "transactional",
    fingerprint: { variant, ...fingerprint },
    inApp: { ...inApp, expiresAt: null, template: null },
  };
}

const placeRoute = (placeId: string) => `/places/id/${placeId}`;

// ── place.claim-received ─────────────────────────────────────────────────────

export const PLACE_CLAIM_RECEIVED_VARIANT = "place.claim-received" as const;

const placeClaimReceivedSchema = z
  .object({
    placeId: z.string(),
    placeName: z.string(),
    requestId: z.string(),
    source: z.enum(["OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"]),
  })
  .strict();

export const placeClaimReceivedRenderer: DirectRendererDefinition<
  typeof placeClaimReceivedSchema
> = {
  variant: PLACE_CLAIM_RECEIVED_VARIANT,
  category: "transactional",
  schema: placeClaimReceivedSchema,
  render(input, ctx) {
    const copy = PLACE_CLAIM_RECEIVED_COPY[ctx.locale];
    const isDispute = input.source === "OWNERSHIP_DISPUTE";
    return inAppOnly(
      PLACE_CLAIM_RECEIVED_VARIANT,
      { requestId: input.requestId },
      {
        title: isDispute ? copy.disputeTitle : copy.claimTitle,
        body: isDispute ? copy.disputeBody(input) : copy.claimBody(input),
        kind: "INFO",
        action: { label: copy.reviewLabel, route: "/admin/verifications" },
        tags: ["place", "claim"],
        metadata: {
          placeId: input.placeId,
          requestId: input.requestId,
          source: input.source,
        },
      },
    );
  },
};

// ── place.claim-decided / place.dispute-decided ──────────────────────────────

export const PLACE_CLAIM_DECIDED_VARIANT = "place.claim-decided" as const;
export const PLACE_DISPUTE_DECIDED_VARIANT = "place.dispute-decided" as const;

const placeDecisionSchema = z
  .object({
    placeId: z.string(),
    placeName: z.string(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reviewerNotes: z.string().nullable(),
  })
  .strict();

function placeDecisionRenderer(
  variant: typeof PLACE_CLAIM_DECIDED_VARIANT | typeof PLACE_DISPUTE_DECIDED_VARIANT,
): DirectRendererDefinition<typeof placeDecisionSchema> {
  const catalog =
    variant === PLACE_CLAIM_DECIDED_VARIANT
      ? PLACE_CLAIM_DECIDED_COPY
      : PLACE_DISPUTE_DECIDED_COPY;
  const tag = variant === PLACE_CLAIM_DECIDED_VARIANT ? "claim" : "dispute";
  return {
    variant,
    category: "transactional",
    schema: placeDecisionSchema,
    render(input, ctx) {
      const copy = catalog[ctx.locale];
      return inAppOnly(
        variant,
        { placeId: input.placeId, decision: input.decision },
        {
          title: copy.title(input),
          body: placeDecisionBody(copy, input),
          kind: input.decision === "APPROVED" ? "SUCCESS" : "INFO",
          action: { label: copy.viewLabel, route: placeRoute(input.placeId) },
          tags: ["place", tag],
          metadata: { placeId: input.placeId, decision: input.decision },
        },
      );
    },
  };
}

export const placeClaimDecidedRenderer = placeDecisionRenderer(
  PLACE_CLAIM_DECIDED_VARIANT,
);
export const placeDisputeDecidedRenderer = placeDecisionRenderer(
  PLACE_DISPUTE_DECIDED_VARIANT,
);

// ── place.ownership-transferred / place.dispute-filed ────────────────────────

export const PLACE_OWNERSHIP_TRANSFERRED_VARIANT =
  "place.ownership-transferred" as const;
export const PLACE_DISPUTE_FILED_VARIANT = "place.dispute-filed" as const;

const placeOwnerNoticeSchema = z
  .object({
    placeId: z.string(),
    placeName: z.string(),
    requestId: z.string(),
  })
  .strict();

function placeOwnerNoticeRenderer(
  variant:
    | typeof PLACE_OWNERSHIP_TRANSFERRED_VARIANT
    | typeof PLACE_DISPUTE_FILED_VARIANT,
): DirectRendererDefinition<typeof placeOwnerNoticeSchema> {
  const catalog =
    variant === PLACE_OWNERSHIP_TRANSFERRED_VARIANT
      ? PLACE_OWNERSHIP_TRANSFERRED_COPY
      : PLACE_DISPUTE_FILED_COPY;
  return {
    variant,
    category: "transactional",
    schema: placeOwnerNoticeSchema,
    render(input, ctx) {
      const copy = catalog[ctx.locale];
      return inAppOnly(
        variant,
        { requestId: input.requestId },
        {
          title: copy.title,
          body: copy.body(input),
          kind: "WARNING",
          action: { label: copy.viewLabel, route: placeRoute(input.placeId) },
          tags: ["place", "dispute"],
          metadata: { placeId: input.placeId, requestId: input.requestId },
        },
      );
    },
  };
}

export const placeOwnershipTransferredRenderer = placeOwnerNoticeRenderer(
  PLACE_OWNERSHIP_TRANSFERRED_VARIANT,
);
export const placeDisputeFiledRenderer = placeOwnerNoticeRenderer(
  PLACE_DISPUTE_FILED_VARIANT,
);

// ── volunteer.shift-reminder-in-app ──────────────────────────────────────────
//
// Not `volunteer.shift-reminder`: that older registry variant is a notify()
// renderer nothing sends, with different in-app wording and an email leg.
// This one is exactly what the cron dispatcher writes to the inbox.

export const VOLUNTEER_SHIFT_REMINDER_IN_APP_VARIANT =
  "volunteer.shift-reminder-in-app" as const;

const volunteerShiftReminderInAppSchema = z
  .object({
    signupId: z.string(),
    eventId: z.string(),
    eventTitle: z.string(),
    roleName: z.string(),
    shiftLabel: z.string().nullable(),
    kind: z.enum(["REMINDER_24H", "REMINDER_1H"]),
    /** Absolute manage-signup URL; the action's href. */
    manageUrl: z.string(),
    /**
     * Grouped notice (volunteer-ask-reminders R12, stored since 2026-10-18):
     * one person's shifts at this event starting at the same instant, each
     * with its label. Written only for two or more; `signupId`, `roleName`
     * and `shiftLabel` then name the first. Rows without it are single.
     */
    roles: z
      .array(
        z
          .object({ roleName: z.string(), shiftLabel: z.string().nullable() })
          .strict(),
      )
      .optional(),
    /** Every signup a grouped notice covers, `signupId` first. */
    signupIds: z.array(z.string()).optional(),
  })
  .strict();

export const volunteerShiftReminderInAppRenderer: DirectRendererDefinition<
  typeof volunteerShiftReminderInAppSchema
> = {
  variant: VOLUNTEER_SHIFT_REMINDER_IN_APP_VARIANT,
  category: "transactional",
  schema: volunteerShiftReminderInAppSchema,
  render(input, ctx) {
    const copy = VOLUNTEER_SHIFT_REMINDER_COPY[ctx.locale];
    return inAppOnly(
      VOLUNTEER_SHIFT_REMINDER_IN_APP_VARIANT,
      { signupId: input.signupId, kind: input.kind },
      {
        title: copy.title(input),
        body: copy.body(input),
        kind: "INFO",
        action: { label: copy.openLabel, href: input.manageUrl },
        tags: [
          "volunteer",
          "shift",
          "reminder",
          input.kind === "REMINDER_24H" ? "24h" : "1h",
        ],
        metadata: {
          signupId: input.signupId,
          eventId: input.eventId,
          kind: input.kind,
        },
      },
    );
  },
};

// ── volunteer.start-reminder-in-app ──────────────────────────────────────────
//
// The same dispatcher's reminder for a signup anchored by a START rather than
// a shift (volunteer-ask-reminders): a shiftless event role (EVENT_START,
// before the event starts) or a one-time ask (ASK_START, before the ask
// starts). Says what starts, never "your shift".

export const VOLUNTEER_START_REMINDER_IN_APP_VARIANT =
  "volunteer.start-reminder-in-app" as const;

const volunteerStartReminderInAppSchema = z
  .object({
    signupId: z.string(),
    anchor: z.enum(["EVENT_START", "ASK_START"]),
    /** Set for EVENT_START. */
    eventId: z.string().nullable(),
    /** Set for ASK_START. */
    askId: z.string().nullable(),
    /** The event's or the ask's title. */
    title: z.string(),
    roleName: z.string(),
    kind: z.enum(["REMINDER_24H", "REMINDER_1H"]),
    startsAtIso: z.string(),
    /** The zone the start renders in; null = the platform default. */
    timezone: z.string().nullable(),
    /** Absolute URL; the action's href. */
    manageUrl: z.string(),
    /**
     * Grouped notice (volunteer-ask-reminders R12, stored since 2026-10-18):
     * every role of one person on this event or ask at this start. Written
     * only for two or more; `signupId` then names the first signup and
     * `roleName` its first real role. Rows without it are single.
     */
    roleNames: z.array(z.string()).optional(),
    /** Every signup a grouped notice covers, `signupId` first. */
    signupIds: z.array(z.string()).optional(),
  })
  .strict();

export const volunteerStartReminderInAppRenderer: DirectRendererDefinition<
  typeof volunteerStartReminderInAppSchema
> = {
  variant: VOLUNTEER_START_REMINDER_IN_APP_VARIANT,
  category: "transactional",
  schema: volunteerStartReminderInAppSchema,
  render(input, ctx) {
    const copy = VOLUNTEER_START_REMINDER_COPY[ctx.locale];
    return inAppOnly(
      VOLUNTEER_START_REMINDER_IN_APP_VARIANT,
      { signupId: input.signupId, kind: input.kind },
      {
        title: copy.title(input),
        body: copy.body(input),
        kind: "INFO",
        action: { label: copy.openLabel(input.anchor), href: input.manageUrl },
        tags: [
          "volunteer",
          input.anchor === "ASK_START" ? "ask" : "event",
          "reminder",
          input.kind === "REMINDER_24H" ? "24h" : "1h",
        ],
        metadata: {
          signupId: input.signupId,
          ...(input.eventId ? { eventId: input.eventId } : {}),
          ...(input.askId ? { askId: input.askId } : {}),
          kind: input.kind,
        },
      },
    );
  },
};

// ── community.suggestion-received ────────────────────────────────────────────

export const SUGGESTION_RECEIVED_VARIANT =
  "community.suggestion-received" as const;

const suggestionReceivedSchema = z
  .object({
    eventId: z.string(),
    suggestionId: z.string(),
    eventTitle: z.string(),
    /**
     * A COMMUNITY listing: reviewers have the moderator queue to go to. Other
     * events carry no action (the owner-side review surface is not
     * addressable from the producer).
     */
    moderatorQueue: z.boolean(),
  })
  .strict();

export const suggestionReceivedRenderer: DirectRendererDefinition<
  typeof suggestionReceivedSchema
> = {
  variant: SUGGESTION_RECEIVED_VARIANT,
  category: "transactional",
  schema: suggestionReceivedSchema,
  render(input, ctx) {
    const copy = SUGGESTION_RECEIVED_COPY[ctx.locale];
    return inAppOnly(
      SUGGESTION_RECEIVED_VARIANT,
      { suggestionId: input.suggestionId },
      {
        title: copy.title,
        body: copy.body(input),
        kind: "INFO",
        action: input.moderatorQueue
          ? { label: copy.reviewLabel, route: "/moderate/suggestions" }
          : null,
        tags: ["community", "suggestion"],
        metadata: { eventId: input.eventId, suggestionId: input.suggestionId },
      },
    );
  },
};

// ── community.suggestion-reviewed ────────────────────────────────────────────

export const SUGGESTION_REVIEWED_VARIANT =
  "community.suggestion-reviewed" as const;

const suggestionReviewedSchema = z
  .object({
    eventId: z.string(),
    suggestionId: z.string(),
    eventTitle: z.string(),
    /** The event's public path; null (unpublished draft) = no action. */
    eventRoute: z.string().nullable(),
    decision: z.enum(["APPROVE", "REJECT"]),
    reviewNote: z.string().nullable(),
    conflictedFields: z.array(z.string()),
  })
  .strict();

export const suggestionReviewedRenderer: DirectRendererDefinition<
  typeof suggestionReviewedSchema
> = {
  variant: SUGGESTION_REVIEWED_VARIANT,
  category: "transactional",
  schema: suggestionReviewedSchema,
  render(input, ctx) {
    const copy = SUGGESTION_REVIEWED_COPY[ctx.locale];
    const approved = input.decision === "APPROVE";
    return inAppOnly(
      SUGGESTION_REVIEWED_VARIANT,
      { suggestionId: input.suggestionId, decision: input.decision },
      {
        title: approved ? copy.approvedTitle : copy.rejectedTitle,
        body: suggestionReviewedBody(copy, input),
        kind: approved ? "SUCCESS" : "INFO",
        action: input.eventRoute
          ? { label: copy.viewLabel, route: input.eventRoute }
          : null,
        tags: ["suggestion"],
        metadata: {
          eventId: input.eventId,
          suggestionId: input.suggestionId,
          decision: input.decision,
        },
      },
    );
  },
};

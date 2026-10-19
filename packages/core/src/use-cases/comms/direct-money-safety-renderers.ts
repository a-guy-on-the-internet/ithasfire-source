import { z } from "zod";

import { formatCents } from "../../lib/currency-utils";
import type { NotificationCategory } from "./categories";
import { formatEventDate } from "./copy/common";
import {
  DISPUTE_RISK_OWNER_COPY,
  type DisputeLostOutcome,
  type DisputeNotice,
} from "./copy/disputes";
import { ENTITY_REPORT_COPY } from "./copy/entity-reports";
import {
  RESALE_CLAIM_OPENED_COPY,
  RESALE_CLAIM_REFUNDED_COPY,
  RESALE_CLAIM_RESOLVED_COPY,
  RESALE_LISTING_CLOSED_RELIST_COPY,
  RESALE_LISTING_CREATED_COPY,
  RESALE_SALE_REFUNDED_LISTING_CLOSED_COPY,
  RESALE_SELLER_SOLD_COPY,
} from "./copy/resale-direct";
import type { DirectRendererDefinition } from "./direct-in-app";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// IN-APP-ONLY renderers for notices whose producers write the in-app row
// directly (`repos.notifications.create`) instead of through `notify`:
//   - resale/notify-resale-events.ts (listing created, claim opened, claim
//     resolved), resale/notify-resale-seller-sold.ts,
//     resale/notify-claim-refunded.ts;
//   - disputes/notify-dispute-lifecycle.ts (the risk-owner notice);
//   - entity-reports/_shared/entity-report-notifications.ts.
//
// The producer renders the English row here (so the stored text and this
// renderer can never drift apart) and stores the payload as the row's
// template (`buildDirectInAppNotice`, direct-in-app.ts), so the inbox can
// re-render it in the reader's language. Each producer keeps its own delivery:
// transaction, recipients, tags, metadata, email. These renderers return no
// email or push, and nothing sends them through `notify`.
//
// Registered in `renderers.ts`'s registry. Payload schemas are a stored
// contract (see the comment on `renderNotification`): add fields as optional,
// never tighten. Ids and URLs are plain non-empty strings, not `.uuid()` /
// `.url()`: the producers pass whatever their records hold, and a stricter
// schema would make the WRITE fail and lose the notice.
// ─────────────────────────────────────────────────────────────────────────────

export const RESALE_LISTING_CREATED_VARIANT = "resale.listing-created" as const;
export const RESALE_CLAIM_OPENED_VARIANT = "resale.claim-opened" as const;
export const RESALE_CLAIM_RESOLVED_VARIANT = "resale.claim-resolved" as const;
export const RESALE_CLAIM_REFUNDED_VARIANT = "resale.claim-refunded" as const;
export const RESALE_SELLER_SOLD_VARIANT = "resale.seller-sold" as const;
export const RESALE_LISTING_CLOSED_RELIST_VARIANT =
  "resale.listing-closed-relist" as const;
export const RESALE_SALE_REFUNDED_LISTING_CLOSED_VARIANT =
  "resale.sale-refunded-listing-closed" as const;
export const DISPUTE_RISK_OWNER_NOTICE_VARIANT =
  "dispute.risk-owner-notice" as const;
export const ENTITY_REPORT_SUBMITTED_VARIANT = "entity-report.submitted" as const;
export const ENTITY_REPORT_REVIEWED_VARIANT = "entity-report.reviewed" as const;

const id = z.string().min(1);
/**
 * The event's title, verbatim; null when the event could not be read. Not
 * `.min(1)`: the producers have always printed whatever the record holds.
 */
const eventTitle = z.string().nullable();

/**
 * "Mar 24, 2026": the English short date these producers have always written
 * (`toLocaleDateString("en", …)`), pinned to UTC like the other locales so a
 * reader's language never changes which day a date falls on. Production runs
 * in UTC, so the stored English is unchanged. Other locales use the shared
 * event-date phrasing (copy/common.ts), also in UTC.
 */
function formatNoticeDate(locale: NotificationLocale, iso: string): string {
  if (locale === "en") {
    // An unparseable value reads "Invalid Date", exactly as it always has.
    return new Date(iso).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return formatEventDate(locale, iso, "UTC") ?? iso;
}

/** Shared shape of the in-app-only result. */
function inAppOnly(
  variant: string,
  category: NotificationCategory,
  fingerprint: Record<string, unknown>,
  inApp: {
    title: string;
    body: string;
    kind: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    action: { label: string; href?: string; route?: string } | null;
    tags: string[];
  },
): RenderNotificationResult {
  return {
    category,
    fingerprint: { variant, ...fingerprint },
    inApp: {
      title: inApp.title,
      body: inApp.body,
      kind: inApp.kind,
      action: inApp.action,
      expiresAt: null,
      tags: inApp.tags,
      metadata: {},
      template: null,
    },
  };
}

// ── Resale ───────────────────────────────────────────────────────────────────

const resaleListingCreatedSchema = z
  .object({
    listingId: id,
    eventTitle,
    askPriceCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    listingUrl: z.string().min(1),
  })
  .strict();

export type ResaleListingCreatedPayload = z.infer<
  typeof resaleListingCreatedSchema
>;

export const resaleListingCreatedRenderer: DirectRendererDefinition<
  typeof resaleListingCreatedSchema
> = {
  variant: RESALE_LISTING_CREATED_VARIANT,
  category: "transactional",
  schema: resaleListingCreatedSchema,
  render(input, ctx) {
    const copy = RESALE_LISTING_CREATED_COPY[ctx.locale];
    return inAppOnly(
      RESALE_LISTING_CREATED_VARIANT,
      "transactional",
      { listingId: input.listingId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          price: formatCents(input.askPriceCents, input.currency),
        }),
        kind: "INFO",
        action: { label: copy.viewListingLabel, href: input.listingUrl },
        tags: ["resale", "listing"],
      },
    );
  },
};

const resaleClaimOpenedSchema = z
  .object({
    claimId: id,
    eventTitle,
    /** The raw claim kind (`ticket_invalid`, `entry_denied`, …). */
    claimKind: z.string().min(1),
    /**
     * Still written and accepted (stored rows carry it; the schema is
     * strict) but no longer shown: there is no reply deadline (owner rulings
     * Q8 + Q9, 2026-10-06).
     */
    deadlineIso: z.string().min(1),
    claimUrl: z.string().min(1),
  })
  .strict();

export type ResaleClaimOpenedPayload = z.infer<typeof resaleClaimOpenedSchema>;

export const resaleClaimOpenedRenderer: DirectRendererDefinition<
  typeof resaleClaimOpenedSchema
> = {
  variant: RESALE_CLAIM_OPENED_VARIANT,
  category: "transactional",
  schema: resaleClaimOpenedSchema,
  render(input, ctx) {
    const copy = RESALE_CLAIM_OPENED_COPY[ctx.locale];
    return inAppOnly(
      RESALE_CLAIM_OPENED_VARIANT,
      "transactional",
      { claimId: input.claimId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          claimKind: input.claimKind,
        }),
        kind: "WARNING",
        action: { label: copy.viewClaimLabel, href: input.claimUrl },
        tags: ["resale", "claim"],
      },
    );
  },
};

const resaleClaimResolvedSchema = z
  .object({
    claimId: id,
    eventTitle,
    /** buyer = the claimant; seller = the respondent. */
    audience: z.enum(["buyer", "seller"]),
    status: z.enum(["approved", "denied"]),
    resolution: z.string().nullable(),
    claimUrl: z.string().min(1),
  })
  .strict();

export type ResaleClaimResolvedPayload = z.infer<
  typeof resaleClaimResolvedSchema
>;

export const resaleClaimResolvedRenderer: DirectRendererDefinition<
  typeof resaleClaimResolvedSchema
> = {
  variant: RESALE_CLAIM_RESOLVED_VARIANT,
  category: "transactional",
  schema: resaleClaimResolvedSchema,
  render(input, ctx) {
    const approved = input.status === "approved";
    const copy = RESALE_CLAIM_RESOLVED_COPY[ctx.locale];
    const side =
      input.audience === "buyer"
        ? {
            title: copy.buyer.title(input.status),
            body: copy.buyer.body({
              eventTitle: input.eventTitle,
              status: input.status,
              resolution: input.resolution,
            }),
            kind: approved ? ("SUCCESS" as const) : ("INFO" as const),
            label: copy.buyer.label,
          }
        : {
            title: copy.seller.title(input.status),
            body: copy.seller.body({
              eventTitle: input.eventTitle,
              status: input.status,
            }),
            kind: approved ? ("WARNING" as const) : ("SUCCESS" as const),
            label: copy.seller.label,
          };
    return inAppOnly(
      RESALE_CLAIM_RESOLVED_VARIANT,
      "transactional",
      { claimId: input.claimId, audience: input.audience, status: input.status },
      {
        title: side.title,
        body: side.body,
        kind: side.kind,
        action: { label: side.label, href: input.claimUrl },
        tags: ["resale", "claim"],
      },
    );
  },
};

/** Buyer-facing: the refund for an approved claim has been issued. */
const resaleClaimRefundedSchema = z
  .object({
    claimId: id,
    orderId: id,
    eventTitle,
    /** What Stripe returned to the buyer, in minor units (cents). */
    amountCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    /** The buyer's order page (`/my-tickets/<orderId>`), absolute. */
    orderUrl: z.string().min(1),
  })
  .strict();

export type ResaleClaimRefundedPayload = z.infer<
  typeof resaleClaimRefundedSchema
>;

export const resaleClaimRefundedRenderer: DirectRendererDefinition<
  typeof resaleClaimRefundedSchema
> = {
  variant: RESALE_CLAIM_REFUNDED_VARIANT,
  category: "transactional",
  schema: resaleClaimRefundedSchema,
  render(input, ctx) {
    const copy = RESALE_CLAIM_REFUNDED_COPY[ctx.locale];
    return inAppOnly(
      RESALE_CLAIM_REFUNDED_VARIANT,
      "transactional",
      { claimId: input.claimId, orderId: input.orderId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          amount: formatCents(input.amountCents, input.currency),
        }),
        kind: "SUCCESS",
        action: { label: copy.viewOrderLabel, href: input.orderUrl },
        tags: ["resale", "claim", "refund"],
      },
    );
  },
};

const resaleSellerSoldSchema = z
  .object({
    listingId: id,
    orderId: id,
    eventTitle,
    amountCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    resaleUrl: z.string().min(1),
  })
  .strict();

export type ResaleSellerSoldPayload = z.infer<typeof resaleSellerSoldSchema>;

export const resaleSellerSoldRenderer: DirectRendererDefinition<
  typeof resaleSellerSoldSchema
> = {
  variant: RESALE_SELLER_SOLD_VARIANT,
  category: "transactional",
  schema: resaleSellerSoldSchema,
  render(input, ctx) {
    const copy = RESALE_SELLER_SOLD_COPY[ctx.locale];
    return inAppOnly(
      RESALE_SELLER_SOLD_VARIANT,
      "transactional",
      { listingId: input.listingId, orderId: input.orderId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          amount: formatCents(input.amountCents, input.currency),
        }),
        kind: "SUCCESS",
        action: { label: copy.viewDetailsLabel, href: input.resaleUrl },
        tags: ["resale", "sale"],
      },
    );
  },
};

const resaleListingClosedRelistSchema = z
  .object({
    listingId: id,
    eventTitle,
    askPriceCents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    resaleUrl: z.string().min(1),
  })
  .strict();

export type ResaleListingClosedRelistPayload = z.infer<
  typeof resaleListingClosedRelistSchema
>;

export const resaleListingClosedRelistRenderer: DirectRendererDefinition<
  typeof resaleListingClosedRelistSchema
> = {
  variant: RESALE_LISTING_CLOSED_RELIST_VARIANT,
  category: "transactional",
  schema: resaleListingClosedRelistSchema,
  render(input, ctx) {
    const copy = RESALE_LISTING_CLOSED_RELIST_COPY[ctx.locale];
    return inAppOnly(
      RESALE_LISTING_CLOSED_RELIST_VARIANT,
      "transactional",
      { listingId: input.listingId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          price: formatCents(input.askPriceCents, input.currency),
        }),
        kind: "INFO",
        action: { label: copy.listAgainLabel, href: input.resaleUrl },
        tags: ["resale", "listing"],
      },
    );
  },
};

/** Same payload as the cancel job's notice; different words (a sale was refunded). */
export const resaleSaleRefundedListingClosedRenderer: DirectRendererDefinition<
  typeof resaleListingClosedRelistSchema
> = {
  variant: RESALE_SALE_REFUNDED_LISTING_CLOSED_VARIANT,
  category: "transactional",
  schema: resaleListingClosedRelistSchema,
  render(input, ctx) {
    const copy = RESALE_SALE_REFUNDED_LISTING_CLOSED_COPY[ctx.locale];
    return inAppOnly(
      RESALE_SALE_REFUNDED_LISTING_CLOSED_VARIANT,
      "transactional",
      { listingId: input.listingId },
      {
        title: copy.title,
        body: copy.body({
          eventTitle: input.eventTitle,
          price: formatCents(input.askPriceCents, input.currency),
        }),
        kind: "INFO",
        action: { label: copy.listAgainLabel, href: input.resaleUrl },
        tags: ["resale", "listing", "refund"],
      },
    );
  },
};

// ── Disputes ─────────────────────────────────────────────────────────────────

const DISPUTE_NOTICES = [
  "opened",
  "under_review",
  "funds_withdrawn",
  "won",
  "lost",
] as const satisfies readonly DisputeNotice[];

const DISPUTE_LOST_OUTCOMES = [
  "ticketing_debited",
  "ticketing_not_debited",
  "membership_debited",
  "membership_debited_with_fee",
  "membership_fee_debited",
  "membership_not_debited",
] as const satisfies readonly DisputeLostOutcome[];

const disputeRiskOwnerNoticeSchema = z
  .object({
    disputeId: id,
    notice: z.enum(DISPUTE_NOTICES),
    eventTitle,
    isMembership: z.boolean(),
    evidenceDueIso: z.string().min(1).nullable(),
    /** What the LOST pass did; null on every other notice. */
    lostOutcome: z.enum(DISPUTE_LOST_OUTCOMES).nullable(),
  })
  .strict();

export type DisputeRiskOwnerNoticePayload = z.infer<
  typeof disputeRiskOwnerNoticeSchema
>;

const DISPUTE_NOTICE_KIND: {
  readonly [N in DisputeNotice]: "SUCCESS" | "WARNING" | "ERROR";
} = {
  opened: "WARNING",
  under_review: "WARNING",
  funds_withdrawn: "WARNING",
  won: "SUCCESS",
  lost: "ERROR",
};

export const disputeRiskOwnerNoticeRenderer: DirectRendererDefinition<
  typeof disputeRiskOwnerNoticeSchema
> = {
  variant: DISPUTE_RISK_OWNER_NOTICE_VARIANT,
  category: "transactional",
  schema: disputeRiskOwnerNoticeSchema,
  render(input, ctx) {
    const copy = DISPUTE_RISK_OWNER_COPY[ctx.locale];
    const subject = copy.subject({
      eventTitle: input.eventTitle,
      isMembership: input.isMembership,
    });
    const evidenceDue = input.evidenceDueIso
      ? formatNoticeDate(ctx.locale, input.evidenceDueIso)
      : null;
    return inAppOnly(
      DISPUTE_RISK_OWNER_NOTICE_VARIANT,
      "transactional",
      { disputeId: input.disputeId, notice: input.notice },
      {
        title: copy.title(input.notice),
        body: copy.body({
          notice: input.notice,
          subject,
          evidenceDue,
          lostOutcome: input.lostOutcome,
        }),
        kind: DISPUTE_NOTICE_KIND[input.notice],
        action: null,
        tags: ["dispute", "payments"],
      },
    );
  },
};

// ── Entity reports ───────────────────────────────────────────────────────────

const entityReportSubjectSchema = z.enum([
  "PLACE",
  "HUMAN",
  "ORGANIZATION",
  "ARRIVAL_AREA",
]);

const entityReportSubmittedSchema = z
  .object({
    reportId: id,
    subjectType: entityReportSubjectSchema,
    subjectId: id,
    reason: z.enum([
      "CLOSED_OR_GONE",
      "INCORRECT_INFO",
      "DUPLICATE",
      "INAPPROPRIATE",
      "SPAM",
      "IMPERSONATION",
      "OTHER",
    ]),
  })
  .strict();

export type EntityReportSubmittedPayload = z.infer<
  typeof entityReportSubmittedSchema
>;

export const entityReportSubmittedRenderer: DirectRendererDefinition<
  typeof entityReportSubmittedSchema
> = {
  variant: ENTITY_REPORT_SUBMITTED_VARIANT,
  category: "transactional",
  schema: entityReportSubmittedSchema,
  render(input, ctx) {
    const copy = ENTITY_REPORT_COPY[ctx.locale];
    return inAppOnly(
      ENTITY_REPORT_SUBMITTED_VARIANT,
      "transactional",
      { reportId: input.reportId },
      {
        title: copy.submitted.title(input.subjectType),
        body: copy.submitted.body({
          subject: copy.subject[input.subjectType],
          reason: copy.reason[input.reason],
        }),
        kind: "INFO",
        action: { label: copy.submitted.reviewLabel, route: "/platform/reports" },
        tags: ["platform", "entity-report"],
      },
    );
  },
};

const entityReportReviewedSchema = z
  .object({
    reportId: id,
    subjectType: entityReportSubjectSchema,
    subjectId: id,
    verdict: z.enum(["RESOLVED", "DISMISSED"]),
    /** The reviewer's own words, verbatim (capped at 2000 on input). */
    reviewNote: z.string().nullable(),
  })
  .strict();

export type EntityReportReviewedPayload = z.infer<
  typeof entityReportReviewedSchema
>;

export const entityReportReviewedRenderer: DirectRendererDefinition<
  typeof entityReportReviewedSchema
> = {
  variant: ENTITY_REPORT_REVIEWED_VARIANT,
  category: "transactional",
  schema: entityReportReviewedSchema,
  render(input, ctx) {
    const copy = ENTITY_REPORT_COPY[ctx.locale];
    return inAppOnly(
      ENTITY_REPORT_REVIEWED_VARIANT,
      "transactional",
      { reportId: input.reportId, verdict: input.verdict },
      {
        title: copy.reviewed.title(input.verdict),
        body: copy.reviewed.body({
          verdict: input.verdict,
          subject: copy.subject[input.subjectType],
          reviewNote: input.reviewNote,
        }),
        kind: input.verdict === "RESOLVED" ? "SUCCESS" : "INFO",
        action: null,
        tags: ["entity-report"],
      },
    );
  },
};

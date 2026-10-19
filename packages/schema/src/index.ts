import { z } from "zod";

import type {
  PayoutTermsKind,
  PayoutTermsLineRounding,
  PayoutTermsStatus,
  ApplicationSubmissionStatus,
  CommunityModeratorApplicationStatus,
  PromoHoldStatus,
  PromoKind,
  PromoScope,
  PromoStatus,
  EventAttendanceMode,
  EventEditSuggestionStatus,
  EventGateType,
  EventCategoryRequestKind,
  EventCategoryRequestStatus,
  EventStatus,
  EventStewardship,
  EventVisibility,
  HumanStatus,
  NotificationKind,
  OrderItemKind,
  OrderItemStatus,
  OrderSource,
  OrderStatus,
  OrgRole,
  PayeeSubjectType,
  SupportAuthorType,
  SupportThreadSource,
  SupportThreadStatus,
  TicketStatus,
  WaitlistStatus,
} from "@th/types";

// ─────────────────────────────────────────────────────────────────────────────
// Order Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript interfaces in @th/types/repos/orders.
// The `satisfies readonly XxxType[]` pattern ensures compile-time sync with the
// canonical interface—if you add a status in @th/types but forget here, tsc fails.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for OrderStatus enum values.
 * Source: Prisma OrderStatus enum → @th/types OrderStatus type.
 */
export const orderStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "PART_REFUNDED",
  "REFUNDED",
  "DISPUTED",
  "CANCELLED",
] satisfies readonly OrderStatus[]);

/**
 * Zod schema for OrderSource enum values.
 * Source: Prisma OrderSource enum → @th/types OrderSource type.
 */
export const orderSourceSchema = z.enum([
  "PRIMARY",
  "RESALE",
  "COMP",
] satisfies readonly OrderSource[]);

/**
 * Zod schema for OrderItemKind enum values.
 * Source: Prisma OrderItemKind enum → @th/types OrderItemKind type.
 */
export const orderItemKindSchema = z.enum([
  "ticket",
  "discount",
  "surcharge",
  "platform_credit",
  // One billing period of a membership tier (Order.kind = MEMBERSHIP).
  "membership",
] satisfies readonly OrderItemKind[]);

/**
 * Zod schema for OrderItemStatus enum values.
 * Source: Prisma OrderItemStatus enum → @th/types OrderItemStatus type.
 */
export const orderItemStatusSchema = z.enum([
  "active",
  "refunded",
  "transferred",
] satisfies readonly OrderItemStatus[]);

/**
 * Full OrderItemRecord schema matching @th/types OrderItemRecord.
 * Use .pick() or .omit() in use-cases for specific output shapes.
 */
export const orderItemRecordSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  kind: orderItemKindSchema,
  ticketTypeId: z.string().uuid().nullable(),
  qty: z.number().int().nonnegative(),
  unitPriceCents: z.number().int(),
  amountCents: z.number().int(),
  meta: z.unknown(),
  paidOutAt: z.coerce.date().nullable(),
  refundedAt: z.coerce.date().nullable(),
  /** Tax portion of the refund issued for this item; null = not attributed. */
  refundedTaxCents: z.number().int().nullable(),
  transferredAt: z.coerce.date().nullable(),
  resaleListingId: z.string().uuid().nullable(),
  resaleFaceValueCents: z.number().int().nullable(),
  resaleProcessingPassThroughCents: z.number().int(),
  resaleProcessingFeeConfigRef: z.string().nullable(),
  resaleSaleCutoffAt: z.coerce.date().nullable(),
  resalePayoutReleaseAt: z.coerce.date().nullable(),
  resalePayoutStatus: z
    .enum(["PENDING", "HELD", "READY", "PAID", "BLOCKED"])
    .nullable(),
  resalePayoutHeldAt: z.coerce.date().nullable(),
  resalePayoutHoldReason: z.string().nullable(),
  resalePayoutNoticeSentAt: z.coerce.date().nullable(),
  resalePayoutReminderSentAt: z.coerce.date().nullable(),
  resalePayoutFinalNoticeSentAt: z.coerce.date().nullable(),
  status: orderItemStatusSchema,
});

/**
 * Full OrderRecord schema matching @th/types OrderRecord.
 * Use .pick() or .omit() in use-cases for specific output shapes.
 */
export const orderRecordSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  buyerHumanId: z.string().uuid(),
  amountGrossCents: z.number().int(),
  feesPlatformCents: z.number().int(),
  currency: z.string(),
  feePolicySnapshot: z.unknown(),
  status: orderStatusSchema,
  stripePaymentIntentId: z.string().nullable(),
  billingDescriptor: z.string().nullable().optional(),
  refundPolicyAckAt: z.coerce.date().nullable().optional(),
  refundPolicyAckIp: z.string().nullable().optional(),
  refundPolicyVersion: z.string().nullable().optional(),
  refundPolicyText: z.string().nullable().optional(),
  source: orderSourceSchema,
  occurredAt: z.coerce.date(),
  paidOutAt: z.coerce.date().nullable().optional(),
  parentOrderId: z.string().uuid().nullable(),
  items: z.array(orderItemRecordSchema),
});

/**
 * Zod schema for Stripe refund reasons: exactly Stripe's
 * `RefundCreateParams.Reason` set. Used in refund use-cases, which pass the
 * value to Stripe verbatim. Stripe rejects anything else ("other" included)
 * with "Invalid reason", so an off-list value here is a refund that fails.
 */
export const stripeRefundReasonSchema = z.enum([
  "duplicate",
  "fraudulent",
  "requested_by_customer",
]);
export type StripeRefundReason = z.infer<typeof stripeRefundReasonSchema>;

/**
 * Zod schema for order list sorting options.
 */
export const orderSortSchema = z.enum(["occurredAt_desc", "occurredAt_asc"]);
export type OrderSort = z.infer<typeof orderSortSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Support Chat Schemas
// ─────────────────────────────────────────────────────────────────────────────
// Mirror the Prisma Support* enums → @th/types support types. See
// docs/specs/2026-06-23/completed/support-chat-widget.spec.yaml.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for SupportThreadStatus enum values.
 * Source: Prisma SupportThreadStatus enum → @th/types SupportThreadStatus type.
 */
export const supportThreadStatusSchema = z.enum([
  "OPEN",
  "AWAITING_HUMAN",
  "RESOLVED",
] satisfies readonly SupportThreadStatus[]);

/**
 * Zod schema for SupportThreadSource enum values.
 * Source: Prisma SupportThreadSource enum → @th/types SupportThreadSource type.
 */
export const supportThreadSourceSchema = z.enum([
  "WIDGET",
  "ADMIN",
  "SYSTEM",
] satisfies readonly SupportThreadSource[]);

/**
 * Zod schema for SupportAuthorType enum values.
 * Source: Prisma SupportAuthorType enum → @th/types SupportAuthorType type.
 */
export const supportAuthorTypeSchema = z.enum([
  "USER",
  "HUMAN_AGENT",
  "AI_CLERK",
  "SYSTEM",
] satisfies readonly SupportAuthorType[]);

// ─────────────────────────────────────────────────────────────────────────────
// Ticket Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/tickets.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for TicketStatus enum values.
 * Source: Prisma TicketStatus enum → @th/types TicketStatus type.
 */
export const ticketStatusSchema = z.enum([
  "VALID",
  "SCANNED",
  "INVALID",
  "REFUNDED",
  "LISTED",
] satisfies readonly TicketStatus[]);

/**
 * Zod schema for ticket list sorting options.
 */
export const ticketSortSchema = z.enum(["issuedAt_desc", "issuedAt_asc"]);
export type TicketSort = z.infer<typeof ticketSortSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Event Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/events.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for EventStatus enum values.
 * Source: Prisma EventStatus enum → @th/types EventStatus type.
 */
export const eventStatusSchema = z.enum([
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "CANCELLED",
  "COMPLETED",
] satisfies readonly EventStatus[]);

/**
 * Zod schema for EventVisibility enum values.
 * Source: Prisma EventVisibility enum → @th/types EventVisibility type.
 */
export const eventVisibilitySchema = z.enum([
  "PUBLIC",
  "PRIVATE",
] satisfies readonly EventVisibility[]);

/**
 * Zod schema for EventGateType enum values.
 * Source: Prisma EventGateType enum → @th/types EventGateType type.
 */
export const eventGateTypeSchema = z.enum([
  "NONE",
  "APPLICATION",
  "PASSWORD",
] satisfies readonly EventGateType[]);

/**
 * Zod schema for WaitlistStatus enum values.
 * Source: Prisma WaitlistStatus enum → @th/types WaitlistStatus type.
 */
export const waitlistStatusSchema = z.enum([
  "DISABLED",
  "SCHEDULED",
  "OPEN",
] satisfies readonly WaitlistStatus[]);

/**
 * Zod schema for ApplicationSubmissionStatus enum values.
 * Source: Prisma ApplicationSubmissionStatus enum → @th/types ApplicationSubmissionStatus type.
 */
export const applicationSubmissionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "EXPIRED",
  "WAITLISTED",
] satisfies readonly ApplicationSubmissionStatus[]);

export const eventCategoryRequestKindSchema = z.enum([
  "CATEGORY",
] satisfies readonly EventCategoryRequestKind[]);

export const eventCategoryRequestStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
] satisfies readonly EventCategoryRequestStatus[]);

export const eventCategoryRequestRecordSchema = z.object({
  id: z.string().uuid(),
  kind: eventCategoryRequestKindSchema,
  status: eventCategoryRequestStatusSchema,
  name: z.string(),
  slug: z.string(),
  categoryId: z.string().uuid().nullable(),
  categorySlug: z.string().nullable(),
  categoryName: z.string().nullable(),
  eventId: z.string().uuid().nullable(),
  requesterHumanId: z.string().uuid(),
  reviewedByHumanId: z.string().uuid().nullable(),
  reviewNote: z.string().nullable(),
  resolvedCategoryId: z.string().uuid().nullable(),
  /** The requester's UI locale ("en" | "es"); null = English / older rows. */
  locale: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  reviewedAt: z.coerce.date().nullable(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Community-Managed Listing Schemas
// ─────────────────────────────────────────────────────────────────────────────
// Mirror the Prisma EventAttendanceMode / EventStewardship /
// EventEditSuggestionStatus / CommunityModeratorApplicationStatus enums →
// @th/types. See docs/specs/2026-07-01/completed/community-managed-event-listings.spec.yaml.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for EventAttendanceMode enum values.
 * Source: Prisma EventAttendanceMode enum → @th/types EventAttendanceMode type.
 */
export const eventAttendanceModeSchema = z.enum([
  "TICKETED",
  "RSVP",
] satisfies readonly EventAttendanceMode[]);

/**
 * Zod schema for EventStewardship enum values.
 * Source: Prisma EventStewardship enum → @th/types EventStewardship type.
 */
export const eventStewardshipSchema = z.enum([
  "OWNED",
  "COMMUNITY",
] satisfies readonly EventStewardship[]);

/**
 * Zod schema for EventEditSuggestionStatus enum values.
 * Source: Prisma EventEditSuggestionStatus enum → @th/types EventEditSuggestionStatus type.
 */
export const eventEditSuggestionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
] satisfies readonly EventEditSuggestionStatus[]);

/**
 * Full EventEditSuggestionRecord schema matching
 * @th/types EventEditSuggestionRecord.
 */
export const eventEditSuggestionRecordSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  submitterHumanId: z.uuid().nullable(),
  // No IP field on purpose: the record holds only a keyed hash
  // (`submitterIpHash`), which is internal to the flood cap and is stripped
  // from every output that parses through this schema (it used to return the
  // raw IP to moderators).
  fields: z.record(z.string(), z.unknown()),
  baseVersion: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  status: eventEditSuggestionStatusSchema,
  reviewedByHumanId: z.uuid().nullable(),
  reviewedAt: z.coerce.date().nullable(),
  reviewNote: z.string().nullable(),
  appliedFields: z.record(z.string(), z.unknown()).nullable(),
  conflictedFields: z.array(z.string()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/**
 * Zod schema for CommunityModeratorApplicationStatus enum values.
 * Source: Prisma CommunityModeratorApplicationStatus enum → @th/types type.
 */
export const communityModeratorApplicationStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
] satisfies readonly CommunityModeratorApplicationStatus[]);

/**
 * Full CommunityModeratorApplicationRecord schema matching
 * @th/types CommunityModeratorApplicationRecord.
 */
export const communityModeratorApplicationRecordSchema = z.object({
  id: z.uuid(),
  applicantHumanId: z.uuid(),
  statement: z.string().nullable(),
  status: communityModeratorApplicationStatusSchema,
  reviewedByHumanId: z.uuid().nullable(),
  reviewedAt: z.coerce.date().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/**
 * Full EventRsvpRecord schema matching @th/types EventRsvpRecord.
 */
export const eventRsvpRecordSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  humanId: z.uuid(),
  createdAt: z.coerce.date(),
});

/**
 * Full EventDateRsvpRecord schema matching @th/types EventDateRsvpRecord — the
 * personal per-date "I'm going" marker for a recurring community listing.
 */
export const eventDateRsvpRecordSchema = z.object({
  id: z.uuid(),
  eventDateId: z.uuid(),
  humanId: z.uuid(),
  createdAt: z.coerce.date(),
});

/**
 * Lifecycle of ONE expanded occurrence of a recurring listing. Mirrors the
 * Prisma `EventDateStatus` enum and `@th/types` `EventDateStatus`.
 *
 * `CANCELLED` is now written by TWO very different things, and reads must not
 * conflate them: a whole-schedule edit that dropped an RSVP'd date
 * (`bulkReplaceForEvent` preserves it rather than destroying the RSVPs), and a
 * moderator deliberately calling ONE night off (`cancelEventDate`). Both mean
 * "this night is not happening", which is all any reader needs.
 */
export const eventDateStatusSchema = z.enum(["SCHEDULED", "CANCELLED"]);

// ─────────────────────────────────────────────────────────────────────────────
// PayoutTerms Schemas (formerly Agreement)
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/payout-terms.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for PayoutTermsStatus enum values.
 * Source: Prisma PayoutTermsStatus enum → @th/types PayoutTermsStatus type.
 */
export const payoutTermsStatusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "ARCHIVED",
] satisfies readonly PayoutTermsStatus[]);

/**
 * Zod schema for PayoutTermsKind enum values.
 * Source: Prisma PayoutTermsKind enum → @th/types PayoutTermsKind type.
 */
export const payoutTermsKindSchema = z.enum([
  "PRIMARY",
  "RESALE",
] satisfies readonly PayoutTermsKind[]);

/**
 * Zod schema for PayoutTermsLineRounding enum values.
 * Source: Prisma PayoutTermsLineRounding enum → @th/types PayoutTermsLineRounding type.
 */
export const payoutTermsLineRoundingSchema = z.enum([
  "FLOOR",
  "NEAREST",
] satisfies readonly PayoutTermsLineRounding[]);

// ─────────────────────────────────────────────────────────────────────────────
// Human Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/humans.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for HumanStatus enum values.
 * Source: Prisma HumanStatus enum → @th/types HumanStatus type.
 */
export const humanStatusSchema = z.enum([
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "BANNED",
] satisfies readonly HumanStatus[]);

// ─────────────────────────────────────────────────────────────────────────────
// Promo Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/promos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for PromoStatus enum values.
 * Source: Prisma PromoStatus enum → @th/types PromoStatus type.
 */
export const promoStatusSchema = z.enum([
  "ACTIVE",
  "ARCHIVED",
] satisfies readonly PromoStatus[]);

/**
 * Zod schema for PromoKind enum values.
 * Source: Prisma PromoKind enum → @th/types PromoKind type.
 */
export const promoKindSchema = z.enum([
  "PERCENT",
  "AMOUNT",
] satisfies readonly PromoKind[]);

/**
 * Zod schema for PromoScope enum values.
 * Source: Prisma PromoScope enum → @th/types PromoScope type.
 */
export const promoScopeSchema = z.enum([
  "GLOBAL",
  "ORG",
  "EVENT",
  "TICKET_TYPE",
  "HUMAN",
] satisfies readonly PromoScope[]);

/**
 * Zod schema for PromoHoldStatus enum values.
 * Source: Prisma PromoHoldStatus enum → @th/types PromoHoldStatus type.
 */
export const promoHoldStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "RELEASED",
] satisfies readonly PromoHoldStatus[]);

// ─────────────────────────────────────────────────────────────────────────────
// Notification Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/notifications.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for NotificationKind enum values.
 * Source: Prisma NotificationKind enum → @th/types NotificationKind type.
 */
export const notificationKindSchema = z.enum([
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR",
] satisfies readonly NotificationKind[]);

// ─────────────────────────────────────────────────────────────────────────────
// Authz Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/authz.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for OrgRole enum values.
 * Source: Prisma OrgRole enum → @th/types OrgRole type.
 */
export const orgRoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
  "FINANCE",
  "SCANNER",
] satisfies readonly OrgRole[]);

// ─────────────────────────────────────────────────────────────────────────────
// Payee Schemas
// ─────────────────────────────────────────────────────────────────────────────
// These Zod schemas mirror the TypeScript types in @th/types/repos/payees.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for PayeeSubjectType enum values.
 * Source: Prisma PayeeSubjectType enum → @th/types PayeeSubjectType type.
 */
export const payeeSubjectTypeSchema = z.enum([
  "HUMAN",
  "ORGANIZATION",
] satisfies readonly PayeeSubjectType[]);

// ─────────────────────────────────────────────────────────────────────────────
// ProseMirror / TipTap Configuration
// ─────────────────────────────────────────────────────────────────────────────
// These constants define the canonical set of node and mark types supported
// across all editor implementations (TipTap on web, tap10 on mobile, etc.).
// Any editor must configure itself from these to ensure output compatibility.

/**
 * Supported ProseMirror node types.
 * Both TipTap and tap10 should enable only these nodes.
 */
export const PROSE_NODE_TYPES = [
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "hardBreak",
  "horizontalRule",
  // Future: "imageBlock" for event images
] as const;

export type ProseNodeType = (typeof PROSE_NODE_TYPES)[number];

/**
 * Supported ProseMirror mark types.
 * Marks are inline formatting applied to text.
 */
export const PROSE_MARK_TYPES = ["bold", "italic", "strike", "link"] as const;

export type ProseMarkType = (typeof PROSE_MARK_TYPES)[number];

/**
 * Heading levels supported in the editor.
 * We limit to h1-h3 to keep event descriptions scannable.
 */
export const PROSE_HEADING_LEVELS = [1, 2, 3] as const;

export type ProseHeadingLevel = (typeof PROSE_HEADING_LEVELS)[number];

/**
 * Toolbar action definitions.
 * Shared across editor implementations for consistent UI.
 */
export const PROSE_TOOLBAR_ACTIONS = [
  { id: "bold", label: "Bold", mark: "bold" },
  { id: "italic", label: "Italic", mark: "italic" },
  { id: "strike", label: "Strikethrough", mark: "strike" },
  { id: "link", label: "Link", mark: "link" },
  { id: "heading1", label: "Heading 1", node: "heading", attrs: { level: 1 } },
  { id: "heading2", label: "Heading 2", node: "heading", attrs: { level: 2 } },
  { id: "heading3", label: "Heading 3", node: "heading", attrs: { level: 3 } },
  { id: "bulletList", label: "Bullet List", node: "bulletList" },
  { id: "orderedList", label: "Numbered List", node: "orderedList" },
  { id: "blockquote", label: "Quote", node: "blockquote" },
] as const;

export type ProseToolbarActionId = (typeof PROSE_TOOLBAR_ACTIONS)[number]["id"];

// ─────────────────────────────────────────────────────────────────────────────
// ProseMirror / TipTap Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowlist of media embed providers. The canonical metadata for each
 * provider lives in `@th/core/lib/embeds/providers`; this list is duplicated
 * here so `@th/schema` can validate without depending on `@th/core` (which
 * already depends on `@th/schema`). A unit test in core asserts the two
 * lists stay in sync.
 */
export const MEDIA_EMBED_PROVIDER_IDS = [
  "youtube",
  "spotify",
  "appleMusic",
  "soundcloud",
  "bandcamp",
  "vimeo",
] as const;

export type MediaEmbedProviderIdSchema =
  (typeof MEDIA_EMBED_PROVIDER_IDS)[number];

const mediaEmbedAspectRatioSchema = z
  .string()
  .max(16)
  .regex(/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/)
  .refine((value) => {
    const [width, height] = value.split("/").map(Number);
    if (
      width === undefined ||
      height === undefined ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      height <= 0
    )
      return false;
    const ratio = width / height;
    return ratio >= 0.25 && ratio <= 4;
  }, "invalid aspect ratio");

/**
 * Strict schema for the `mediaEmbed` ProseMirror leaf node.
 *
 * This validates the *shape* of the attrs only — defense-in-depth URL
 * round-trip validation lives in the use-case layer (`save-event-shared`).
 */
export const mediaEmbedNodeSchema = z
  .object({
    type: z.literal("mediaEmbed"),
    attrs: z
      .object({
        provider: z.enum(MEDIA_EMBED_PROVIDER_IDS),
        sourceUrl: z.string().url().max(2048),
        embedUrl: z.string().url().max(2048),
        externalId: z.string().min(1).max(256),
        renderMode: z.enum(["iframe", "link"]),
        kind: z.string().min(1).max(64).optional(),
        title: z.string().max(512).optional(),
        aspectRatio: mediaEmbedAspectRatioSchema.optional(),
      })
      .strict(),
    // Leaf node — no children. Make it optional/empty so existing TipTap
    // JSON that omits the key entirely still validates.
    content: z.array(z.never()).max(0).optional(),
  })
  .strict();

export type MediaEmbedNode = z.infer<typeof mediaEmbedNodeSchema>;

/**
 * A minimal ProseMirror JSON schema.
 *
 * We intentionally keep this permissive at the node level because:
 * - TipTap/ProseMirror plugins can add custom node attrs we don't want to block.
 * - We validate the outer document shape so storage stays consistent.
 *
 * Exception: nodes whose `type === "mediaEmbed"` are validated *strictly*
 * against `mediaEmbedNodeSchema` so a malicious client can't smuggle an
 * arbitrary URL into the iframe via the passthrough.
 */
export const prosemirrorNodeSchema: z.ZodType<any> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      content: z.array(prosemirrorNodeSchema).optional(),
    })
    // Allow extra keys like attrs/marks/text.
    .passthrough()
    .superRefine((node, ctx) => {
      if ((node as { type?: unknown }).type !== "mediaEmbed") return;
      const result = mediaEmbedNodeSchema.safeParse(node);
      if (result.success) return;
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }),
);

export const prosemirrorDocSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(prosemirrorNodeSchema).default([]),
  })
  .strict();

export type ProseMirrorDoc = z.infer<typeof prosemirrorDocSchema>;

export const eventPageBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string(),
      type: z.literal("richText"),
      doc: prosemirrorDocSchema,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      type: z.literal("image"),
      asset: z
        .object({
          assetId: z.string(),
        })
        .strict(),
      alt: z.string().optional(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      type: z.literal("spacer"),
      size: z.enum(["sm", "md", "lg"]).default("md"),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      type: z.literal("cta"),
      label: z.string(),
      href: z.string(),
      variant: z.enum(["primary", "secondary"]).default("primary"),
    })
    .strict(),
]);

export type EventPageBlock = z.infer<typeof eventPageBlockSchema>;

export const layoutColumnRatioSchema = z.enum(["33/67", "50/50", "67/33"]);
export type LayoutColumnRatio = z.infer<typeof layoutColumnRatioSchema>;

export const layoutSectionStyleSchema = z
  .object({
    // A few presets to keep cross-platform rendering predictable.
    background: z
      .enum(["default", "muted", "brand", "transparent"])
      .default("default"),
    density: z.enum(["tight", "normal", "loose"]).default("normal"),
    maxWidth: z.enum(["prose", "wide", "full"]).default("prose"),
    textAlign: z.enum(["left", "center"]).default("left"),
  })
  .strict();
export type LayoutSectionStyle = z.infer<typeof layoutSectionStyleSchema>;

export const layoutSectionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("section"),
    style: layoutSectionStyleSchema.default({
      background: "default",
      density: "normal",
      maxWidth: "prose",
      textAlign: "left",
    }),
    layout: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("singleColumn"),
            columns: z
              .tuple([
                z
                  .object({ blocks: z.array(eventPageBlockSchema).default([]) })
                  .strict(),
              ])
              .default([{ blocks: [] }]),
          })
          .strict(),
        z
          .object({
            type: z.literal("twoColumn"),
            ratio: layoutColumnRatioSchema.default("50/50"),
            columns: z
              .tuple([
                z
                  .object({ blocks: z.array(eventPageBlockSchema).default([]) })
                  .strict(),
                z
                  .object({ blocks: z.array(eventPageBlockSchema).default([]) })
                  .strict(),
              ])
              .default([{ blocks: [] }, { blocks: [] }]),
          })
          .strict(),
      ])
      .default({ type: "singleColumn", columns: [{ blocks: [] }] }),
  })
  .strict();

export type LayoutSection = z.infer<typeof layoutSectionSchema>;

const legacyEventBodySchema = z
  .object({
    layoutId: z
      .enum(["default", "hero-left", "hero-center"])
      .default("default"),
    blocks: z.array(eventPageBlockSchema).default([]),
  })
  .strict();

const eventBodyV1Schema = z
  .object({
    version: z.literal(1),
    sections: z.array(layoutSectionSchema).default([]),
  })
  .strict();

export const eventBodySchema = z.union([
  eventBodyV1Schema,
  legacyEventBodySchema,
]);

export type EventBody = z.infer<typeof eventBodySchema>;

export const updateEventContentInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    content: eventBodySchema,
    // Used by clients to dedupe retries/autosaves.
    clientKey: z.string(),
  })
  .strict();

export type UpdateEventContentInput = z.infer<
  typeof updateEventContentInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Resource Quota Schemas
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ResourceLimitKind,
  QuotaSubjectType,
  ExpansionRequestStatus,
} from "@th/types";

export const resourceLimitKindSchema = z.enum([
  "ORGS_OWNED",
  "ORGS_JOINED",
  "STORAGE_BYTES_ORG",
  "STORAGE_BYTES_HUMAN",
  "STORAGE_BYTES_PLACE",
  "EVENTS_PER_ORG",
  "MEMBERS_PER_ORG",
  "ANNOUNCEMENTS_PER_DAY",
] satisfies readonly ResourceLimitKind[]);

// HUMAN | ORG only, on purpose: a PLACE quota (STORAGE_BYTES_PLACE) is
// charged by core for community page uploads and is not a subject a caller
// may read or file an expansion request against (the owner-access guards in
// get-effective-quota / request-quota-expansion know HUMAN and ORG only).
export const quotaSubjectTypeSchema = z.enum([
  "HUMAN",
  "ORG",
] satisfies readonly QuotaSubjectType[]);

export const expansionRequestStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
] satisfies readonly ExpansionRequestStatus[]);

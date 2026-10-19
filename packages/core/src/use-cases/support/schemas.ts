import { z } from "zod";

import {
  supportAuthorTypeSchema,
  supportThreadSourceSchema,
  supportThreadStatusSchema,
} from "@th/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes for the support chat slice.
// See docs/specs/2026-06-23/completed/support-chat-widget.spec.yaml.
// ─────────────────────────────────────────────────────────────────────────────

/** Output shape for a single support thread. */
export const supportThreadSchema = z
  .object({
    id: z.string().uuid(),
    // Nullable: the SupportThread.human FK is ON DELETE SET NULL, so a thread
    // whose owner was GDPR/CCPA-erased is owner-less (staff-only) with a null
    // humanId. Creation always has an owner; only deletion nulls this.
    humanId: z.string().uuid().nullable(),
    eventId: z.string().uuid().nullable(),
    orderId: z.string().uuid().nullable(),
    status: supportThreadStatusSchema,
    source: supportThreadSourceSchema,
    lastMessageAt: z.coerce.date(),
    resolvedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

/** Output shape for a single support message. */
export const supportMessageSchema = z
  .object({
    id: z.string().uuid(),
    threadId: z.string().uuid(),
    authorType: supportAuthorTypeSchema,
    authorHumanId: z.string().uuid().nullable(),
    body: z.string(),
    readAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  })
  .strict();

/**
 * Staff-only enrichment of {@link supportThreadSchema} for the operator inbox.
 * Adds the resolved human identity (name/email) plus event/order context labels
 * so operators see "Jane Doe <jane@x.com>" and "Order #1234" instead of UUIDs.
 *
 * PII NOTE: these fields are surfaced ONLY by the staff-gated `listThreads`
 * procedure. The attendee-facing `supportThreadSchema` stays lean — name/email
 * never flow to getMyActiveThread / getMessages / sendMessage.
 */
export const supportThreadStaffSchema = supportThreadSchema
  .extend({
    humanDisplayName: z.string().nullable(),
    humanEmail: z.string().email().nullable(),
    eventTitle: z.string().nullable(),
    orderRef: z.string().nullable(),
    // Derived operator-inbox state (see SupportThreadStaffRecord): true when the
    // latest non-SYSTEM message is from the USER with no later agent reply.
    needsReply: z.boolean(),
    lastMessageAuthorType: supportAuthorTypeSchema.nullable(),
  })
  .strict();

export type SupportThreadDto = z.infer<typeof supportThreadSchema>;
export type SupportThreadStaffDto = z.infer<typeof supportThreadStaffSchema>;
export type SupportMessageDto = z.infer<typeof supportMessageSchema>;

/**
 * Best-effort "notify support" hook. Fired on a new thread and on an
 * AWAITING_HUMAN escalation so an operator gets pinged in (e.g.) Discord. It is
 * intentionally a plain function type — NOT a port — mirroring the
 * `onSettlementFailure` pattern in the orders slice: core stays pure (no
 * adapter import) and the API composition root wires this to the existing
 * `createDiscordWebhookAlertSender` (DiscordAlertFn). Implementations MUST be
 * isolated/best-effort and never throw into the caller; the use case also wraps
 * it defensively.
 */
export type SupportAlertReason = "new_thread" | "awaiting_human";

export type NotifySupportInput = {
  reason: SupportAlertReason;
  threadId: string;
  // Nullable: a thread whose owner was GDPR/CCPA-erased can still be
  // re-escalated by staff, in which case there's no human to reference. The
  // alert sender should render "(unknown attendee)" rather than assume an id.
  humanId: string | null;
  eventId: string | null;
  orderId: string | null;
};

export type NotifySupportFn = (input: NotifySupportInput) => Promise<void>;

/** Max length of a single support message body. */
export const SUPPORT_MESSAGE_MAX = 4000;

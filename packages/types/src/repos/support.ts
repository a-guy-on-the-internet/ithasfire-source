// Support chat widget — repo DTOs.
// See docs/specs/2026-06-23/completed/support-chat-widget.spec.yaml.
// These are plain, JSON-serializable shapes returned by the
// SupportThreadRepository. Never expose Prisma models directly.

export type SupportThreadStatus = "OPEN" | "AWAITING_HUMAN" | "RESOLVED";

export type SupportThreadSource = "WIDGET" | "ADMIN" | "SYSTEM";

export type SupportAuthorType = "USER" | "HUMAN_AGENT" | "AI_CLERK" | "SYSTEM";

export interface SupportThreadRecord {
  id: string;
  /**
   * Owning attendee. Set on creation, but NULLABLE: the SupportThread.human FK
   * is ON DELETE SET NULL, so a GDPR/CCPA-erased human's threads survive as
   * owner-less (staff-only) rows with a null humanId.
   */
  humanId: string | null;
  eventId: string | null;
  orderId: string | null;
  status: SupportThreadStatus;
  source: SupportThreadSource;
  lastMessageAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupportMessageRecord {
  id: string;
  threadId: string;
  authorType: SupportAuthorType;
  authorHumanId: string | null;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateSupportThreadInput {
  humanId: string;
  eventId?: string | null;
  orderId?: string | null;
  status?: SupportThreadStatus;
  source?: SupportThreadSource;
  lastMessageAt: Date;
}

export interface AppendSupportMessageInput {
  threadId: string;
  authorType: SupportAuthorType;
  authorHumanId?: string | null;
  body: string;
  /** New value for the thread's lastMessageAt (kept in lockstep with the insert). */
  lastMessageAt: Date;
}

export interface UpdateSupportThreadStatusInput {
  threadId: string;
  status: SupportThreadStatus;
  /** Set when transitioning to RESOLVED; cleared (null) otherwise. */
  resolvedAt: Date | null;
}

export interface ListSupportThreadsInput {
  /** Optional status filter for the operator inbox. */
  status?: SupportThreadStatus;
  limit: number;
  offset: number;
}

/**
 * Staff-only enrichment of {@link SupportThreadRecord} for the operator inbox.
 * Carries the resolved human identity (name/email) plus event/order context
 * labels so operators see "Jane Doe <jane@x.com>" and "Order #1234 — Show at
 * The Chapel" instead of raw UUIDs.
 *
 * PII NOTE: name/email are returned ONLY from the staff `listThreads` path
 * (authorized platform support). The attendee-facing base
 * {@link SupportThreadRecord} deliberately omits these — do not leak them into
 * getMyActiveThread / getMessages / sendMessage.
 */
export interface SupportThreadStaffRecord extends SupportThreadRecord {
  /** Resolved Human.name, or null when the human has no display name. */
  humanDisplayName: string | null;
  /** Resolved buyer email (Human.authUser.email), or null when unknown. */
  humanEmail: string | null;
  /** Resolved Event.title when eventId is set, else null. */
  eventTitle: string | null;
  /**
   * Resolved order reference when orderId is set, else null. The single
   * platform-wide order code — `formatOrderCode(Order.id)` (the 8-hex tail,
   * uppercased) — so it is byte-identical to what the order page, the admin
   * dashboard and admin search show, and pasting it into search resolves.
   */
  orderRef: string | null;
  /**
   * Derived "ball is in the operator's court" flag: true when the thread's
   * most-recent NON-SYSTEM message was authored by the USER (i.e. there's no
   * later HUMAN_AGENT / AI_CLERK reply). SYSTEM status notes never count as a
   * reply, so they don't flip this off. Resolved in the same listThreads query
   * (no N+1), never persisted.
   */
  needsReply: boolean;
  /**
   * Author type of the thread's most-recent non-SYSTEM message, or null when
   * the thread has no non-SYSTEM messages. Lets operators see at a glance who
   * spoke last (USER vs HUMAN_AGENT vs AI_CLERK).
   */
  lastMessageAuthorType: SupportAuthorType | null;
}

export interface ListSupportThreadsResult {
  items: SupportThreadStaffRecord[];
  total: number;
}

export interface MarkSupportMessagesReadInput {
  /** Thread whose messages are being marked read. */
  threadId: string;
  /**
   * Only messages with an authorType in this set are eligible. The owner marks
   * the counterparty's messages (HUMAN_AGENT / AI_CLERK / SYSTEM) read — never
   * their own (USER) sends.
   */
  authorTypes: SupportAuthorType[];
  /** Timestamp to stamp on each newly-read message. */
  readAt: Date;
}

/**
 * GDPR/CCPA erasure input: scrub a deleted human's free-text support content.
 * Run in the SAME transaction as the human deletion, BEFORE the human row is
 * deleted (the FK ON DELETE SET NULL handles the thread's own humanId; this
 * reaches the message free-text + authorHumanId PII the FK can't).
 */
export interface ScrubHumanSupportContentInput {
  /** The human whose authored messages are being scrubbed. */
  humanId: string;
  /** Replacement body for USER free-text messages (e.g. "[deleted]"). */
  tombstone: string;
}

export interface ScrubHumanSupportContentResult {
  /** USER messages whose body was tombstoned and authorHumanId nulled. */
  messagesScrubbed: number;
  /** Non-USER messages (e.g. HUMAN_AGENT) whose authorHumanId was nulled. */
  authorLinksCleared: number;
}

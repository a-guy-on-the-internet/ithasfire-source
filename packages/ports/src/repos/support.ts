import type {
  AppendSupportMessageInput,
  CreateSupportThreadInput,
  ListSupportThreadsInput,
  ListSupportThreadsResult,
  MarkSupportMessagesReadInput,
  ScrubHumanSupportContentInput,
  ScrubHumanSupportContentResult,
  SupportMessageRecord,
  SupportThreadRecord,
  SupportThreadStaffRecord,
  UpdateSupportThreadStatusInput,
} from "@th/types/repos/support";

/**
 * Persistence for the support chat widget (threads + messages).
 *
 * See docs/specs/2026-06-23/completed/support-chat-widget.spec.yaml.
 *
 * The adapter returns plain DTOs (never Prisma models). Authorization and all
 * business rules (who owns a thread, when to escalate, alert dispatch) live in
 * the use cases — this port is pure persistence.
 */
export interface SupportThreadRepository {
  /** Create a new thread. Used when a human sends their first message. */
  createThread(input: CreateSupportThreadInput): Promise<SupportThreadRecord>;

  /** Fetch a single thread by id, or null when it doesn't exist. */
  getThreadById(threadId: string): Promise<SupportThreadRecord | null>;

  /**
   * Find the caller's most-recently-active OPEN or AWAITING_HUMAN thread, if
   * any. Used so a human reuses their live thread instead of spawning a new one
   * on every message. Returns null when the human has no active thread.
   */
  findActiveThreadByHuman(
    humanId: string,
  ): Promise<SupportThreadRecord | null>;

  /**
   * Append a message and bump the thread's `lastMessageAt` to the supplied
   * value in the same write. Returns the persisted message.
   */
  appendMessage(
    input: AppendSupportMessageInput,
  ): Promise<SupportMessageRecord>;

  /** Update a thread's status (and resolvedAt). Returns the updated thread. */
  updateThreadStatus(
    input: UpdateSupportThreadStatusInput,
  ): Promise<SupportThreadRecord>;

  /**
   * List messages for a thread in ascending createdAt order (oldest first) so
   * the widget/admin can render the conversation top-to-bottom.
   *
   * `since` is an incremental cursor (a message createdAt). When set, only
   * messages STRICTLY newer than `since` are returned (`gt`, not `gte`) — the
   * caller passes the createdAt of its newest already-seen message so the poll
   * never re-fetches it. Absent → full history (initial load).
   */
  listMessages(
    threadId: string,
    since?: Date,
  ): Promise<SupportMessageRecord[]>;

  /**
   * Paginated thread list for the operator inbox. Ordering is AWAITING_HUMAN
   * first, then by lastMessageAt descending. Optionally filtered by status.
   *
   * Returns staff-enriched records (human name/email + event/order context
   * labels) resolved via relation includes in the same query — STAFF-ONLY.
   */
  listThreads(
    input: ListSupportThreadsInput,
  ): Promise<ListSupportThreadsResult>;

  /**
   * Stamp `readAt` on the thread's currently-unread messages whose authorType
   * is in `input.authorTypes` (and `readAt` is null). Returns the number of
   * rows updated. Idempotent: a second call updates nothing. Authorization
   * (thread ownership) is enforced in the use case — this is pure persistence.
   */
  markMessagesRead(
    input: MarkSupportMessagesReadInput,
  ): Promise<{ updated: number }>;

  /**
   * GDPR/CCPA erasure: scrub a deleted human's free-text support content.
   * For every SupportMessage authored by `humanId` with authorType USER,
   * replace `body` with `tombstone` and null `authorHumanId`. For any OTHER
   * message authored by `humanId` (e.g. HUMAN_AGENT), null `authorHumanId`
   * to drop the identity link. The thread's own `humanId` is nulled by the
   * FK ON DELETE SET NULL when the Human row is deleted — this method only
   * handles the message free-text + author-id PII that the FK can't reach
   * (SupportMessage.authorHumanId has no FK relation). MUST run in the same
   * tx as the human deletion, BEFORE deleteHuman.
   */
  scrubHumanSupportContent(
    input: ScrubHumanSupportContentInput,
  ): Promise<ScrubHumanSupportContentResult>;

  /**
   * Retention purge: delete RESOLVED threads whose `resolvedAt` is before
   * `input.before`, bounded by `input.limit` rows per call. Their messages
   * cascade-delete (SupportMessage.thread onDelete: Cascade), so a thread delete
   * fully removes the conversation. OPEN / AWAITING_HUMAN threads are never
   * touched (reopening clears resolvedAt, so RESOLVED implies resolvedAt is set).
   * Returns the number of threads deleted.
   */
  deleteResolvedThreadsBefore(input: {
    before: Date;
    limit: number;
  }): Promise<{ deleted: number }>;
}

export type {
  AppendSupportMessageInput,
  CreateSupportThreadInput,
  ListSupportThreadsInput,
  ListSupportThreadsResult,
  MarkSupportMessagesReadInput,
  ScrubHumanSupportContentInput,
  ScrubHumanSupportContentResult,
  SupportMessageRecord,
  SupportThreadRecord,
  SupportThreadStaffRecord,
  UpdateSupportThreadStatusInput,
};

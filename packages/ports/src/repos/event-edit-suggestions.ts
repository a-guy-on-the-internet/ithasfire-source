import type {
  EventEditSuggestionRecord,
  EventEditSuggestionStatus,
} from "@th/types";

export interface CreateEventEditSuggestionInput {
  eventId: string;
  /** Null/omitted = anonymous submission. */
  submitterHumanId?: string | null;
  /** Keyed hash of the submitter's IP (never the IP). */
  submitterIpHash?: string | null;
  /** Whitelisted proposed values keyed by field name. */
  fields: Record<string, unknown>;
  /** Snapshot of the whitelisted fields at draft time (conflict detection). */
  baseVersion: Record<string, unknown>;
  note?: string | null;
}

/**
 * Which approver-side queue to list (FR-008 / FR-016). Scoping is resolved
 * AT QUERY TIME against the suggestion's EVENT (a join through the Event
 * relation) — nothing scope-related is denormalized onto the suggestion row:
 *   - "community": all PENDING suggestions on events with
 *     `Event.stewardship = 'COMMUNITY'` (the moderator queue).
 *   - "org": all PENDING suggestions across events with
 *     `Event.orgId = orgId` (the FR-016 org dashboard inbox, ORG_EDIT_ROLES).
 *   - "event": PENDING suggestions for one event (personal-owner inbox /
 *     event detail views).
 */
export type ListPendingEventEditSuggestionsScope =
  | { kind: "community" }
  | { kind: "org"; orgId: string }
  | { kind: "event"; eventId: string };

export interface ListPendingEventEditSuggestionsInput {
  scope: ListPendingEventEditSuggestionsScope;
  cursor?: string | null;
  limit?: number;
}

export interface ListPendingEventEditSuggestionsResult {
  items: EventEditSuggestionRecord[];
  nextCursor: string | null;
}

export interface ListEventEditSuggestionsBySubmitterInput {
  submitterHumanId: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * A submitter's own suggestion hydrated with just enough target-event context
 * for the "my edit suggestions" view (title + the event's current slug). The
 * slug is nullable because `Event.slug` is optional (unpublished / draft rows).
 */
export interface EventEditSuggestionWithEventContext
  extends EventEditSuggestionRecord {
  eventTitle: string;
  eventSlug: string | null;
}

export interface ListEventEditSuggestionsBySubmitterResult {
  items: EventEditSuggestionWithEventContext[];
  nextCursor: string | null;
}

export interface ClaimPendingEventEditSuggestionForReviewInput {
  id: string;
  reviewedByHumanId: string;
  reviewedAt: Date;
}

export interface MarkEventEditSuggestionReviewedInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewedByHumanId: string;
  reviewedAt: Date;
  reviewNote?: string | null;
  /** Fields actually applied on APPROVE (non-conflicting subset). */
  appliedFields?: Record<string, unknown> | null;
  /** Field names skipped on APPROVE because the event changed since baseVersion. */
  conflictedFields?: string[] | null;
}

export interface CountPendingEventEditSuggestionsByIpInput {
  /** Keyed hash of the submitter's IP. */
  submitterIpHash: string;
  /** Only count suggestions created at/after this instant. */
  since: Date;
}

export interface EventEditSuggestionsRepo {
  /**
   * Privacy retention (ban-that-sticks round 3): null `submitterIpHash` on
   * suggestions created before `before` (~30 days). The per-IP cap only looks
   * back 24h. Returns the rows cleared.
   */
  clearSubmitterIpHashesBefore(input: {
    before: Date;
  }): Promise<{ count: number }>;

  create(
    input: CreateEventEditSuggestionInput,
  ): Promise<EventEditSuggestionRecord>;
  getById(id: string): Promise<EventEditSuggestionRecord | null>;
  /**
   * The raw `fields` JSON of every PENDING suggestion targeting any of the
   * given events, for the storage GC.
   *
   * A suggestion-borne upload lives in limbo: `requestEventImageUpload` creates
   * the Image against the event, but nothing on the Event row points at it
   * until a moderator APPROVES. Between submit and review the ONLY thing
   * referencing that blob is this JSON, so a GC that does not read it deletes
   * the image out from under the pending suggestion — which then becomes
   * permanently unapprovable (`ensureHeroImageReferenceValid` rejects a
   * soft-deleted image).
   *
   * Returns one row per pending suggestion; an event with none is simply
   * absent.
   */
  listPendingReferenceFields(
    eventIds: string[],
  ): Promise<Array<{ eventId: string; fields: unknown }>>;
  listPending(
    input: ListPendingEventEditSuggestionsInput,
  ): Promise<ListPendingEventEditSuggestionsResult>;
  /**
   * Submitter-facing list (all statuses) of the suggestions a signed-in human
   * has submitted, newest first, hydrated with the target event's title +
   * current slug. Anonymous rows (`submitterHumanId = null`) are inherently
   * excluded since we query by a concrete id. Same keyset cursor scheme as
   * `listPending` (cursor = suggestion id).
   */
  listBySubmitter(
    input: ListEventEditSuggestionsBySubmitterInput,
  ): Promise<ListEventEditSuggestionsBySubmitterResult>;
  /**
   * How many suggestions (all statuses) a signed-in human has submitted —
   * the counting twin of {@link listBySubmitter}, same row set. Lets
   * "does this human have any edit suggestions?" surfaces (the
   * account-settings nav) avoid paging rows just to read `.length`.
   */
  countBySubmitter(submitterHumanId: string): Promise<number>;
  /**
   * Atomically claim a PENDING suggestion for review (status guard in the
   * WHERE clause). Returns null when the suggestion is not PENDING — the
   * loser of a concurrent double-review sees null and bails. WHICH actor may
   * review is the use case's job (FR-008 approver routing: COMMUNITY →
   * moderator, org-owned → ORG_EDIT_ROLES, personal → owner); the repo only
   * enforces the status transition.
   */
  claimPendingForReview(
    input: ClaimPendingEventEditSuggestionForReviewInput,
  ): Promise<EventEditSuggestionRecord | null>;
  markReviewed(
    input: MarkEventEditSuggestionReviewedInput,
  ): Promise<EventEditSuggestionRecord>;
  /** Soft per-IP flood cap support (NFR-001). */
  countPendingByIp(
    input: CountPendingEventEditSuggestionsByIpInput,
  ): Promise<number>;
  countPendingByEvent(eventId: string): Promise<number>;
}

export type { EventEditSuggestionRecord, EventEditSuggestionStatus };

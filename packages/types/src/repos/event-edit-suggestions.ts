export type EventEditSuggestionStatus = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Whitelisted suggestion-editable field values (FR-007 of the
 * community-managed-event-listings spec). This is the ONLY shape an edit
 * suggestion may carry: title, body content, schedule, timezone, address +
 * geo, category, hero image, and age limit. Money/tax/payout/ticket/
 * ownership/status fields are never accepted. The SAME whitelist applies to
 * every event kind (COMMUNITY, org-owned, personal) — universal suggestions
 * per FR-006.
 *
 * All fields are optional — a suggestion / apply call carries a partial diff.
 * `geohash6` is deliberately absent: it is re-derived server-side from
 * lat/lng, never accepted from callers.
 */
export interface CommunityEditableFieldValues {
  title?: string;
  /** Event listing body/description (ProseMirror JSON blocks). */
  content?: unknown | null;
  startsAt?: Date;
  /** Non-nullable to match the Event.endsAt column. */
  endsAt?: Date;
  /** IANA timezone identifier (e.g. "America/Chicago"). */
  timezone?: string;
  addressText?: string | null;
  countryCode?: string | null;
  region?: string | null;
  locality?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  categoryId?: string | null;
  heroImageId?: string | null;
  ageLimit?: number | null;
}

/**
 * A pending/reviewed edit suggestion against ANY published PUBLIC event —
 * COMMUNITY listing, org-owned, or personal (FR-006). Review routes to the
 * event's approver side (FR-008): COMMUNITY → any COMMUNITY_MODERATOR,
 * org-owned → ORG_EDIT_ROLES of that org, personal → the humanId owner.
 * Mirrors the EventCategoryRequest request → PENDING → review → atomic apply
 * pattern. `fields` / `baseVersion` / `appliedFields` are whitelisted
 * field-value maps stored as Json; `conflictedFields` is the list of field
 * NAMES skipped on approve because the event changed since `baseVersion`.
 */
export interface EventEditSuggestionRecord {
  id: string;
  eventId: string;
  /** Null = anonymous submission. */
  submitterHumanId: string | null;
  /** Keyed hash of the submitter's IP; never the IP itself. */
  submitterIpHash: string | null;
  /** Whitelisted proposed values keyed by field name. */
  fields: Record<string, unknown>;
  /** Snapshot of the whitelisted fields at draft time (conflict detection). */
  baseVersion: Record<string, unknown>;
  note: string | null;
  status: EventEditSuggestionStatus;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  /** Fields actually applied on APPROVE (non-conflicting subset). */
  appliedFields: Record<string, unknown> | null;
  /** Field names skipped on APPROVE because the event changed since baseVersion. */
  conflictedFields: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

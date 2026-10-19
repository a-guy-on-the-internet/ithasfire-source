/**
 * Org-scoped, venue-internal label for booking requests (booking-holds spec
 * 2026-08-25, FR-017). Never shown to the act.
 */
export interface BookingTagRecord {
  id: string;
  orgId: string;
  name: string;
  /** Lowercased, per-org unique. Derived from `name` in core. */
  slug: string;
  /**
   * Design-token NAME ("accent" | "info" | "success" | "warning" | "danger"
   * | "neutral"), never a hex value. The allowed set is validated in core;
   * the repo stores whatever string it is handed.
   */
  color: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBookingTagInput {
  orgId: string;
  name: string;
  slug: string;
  color: string;
  sortOrder?: number;
}

/**
 * Partial update. `orgId` is REQUIRED and goes in the adapter's WHERE clause
 * (IDOR backstop): a tag id from another org matches zero rows and the
 * adapter returns `null`.
 */
export interface UpdateBookingTagInput {
  id: string;
  orgId: string;
  name?: string;
  slug?: string;
  color?: string;
  sortOrder?: number;
}

/** Same org-scoped WHERE discipline as {@link UpdateBookingTagInput}. */
export interface DeleteBookingTagInput {
  id: string;
  orgId: string;
}

/**
 * Replace-all attach: after the call the request carries exactly `tagIds`
 * (rows not in the set are detached, missing ones inserted).
 *
 * ORG SCOPE: `orgId` is the org that OWNS the request, verified by the use
 * case (place ownership → org) before the call — the join table has no org
 * column and the adapter does not re-derive it. The adapter DOES verify that
 * every `tagId` belongs to `orgId` (one `count` on (id IN, orgId)); any
 * foreign/missing id → `{ code: "invalid_input", message:
 * "booking_tag_foreign_org" }` and nothing is written. A request that
 * vanished before the insert (FK P2003) →
 * `{ code: "conflict", message: "booking_request_missing" }`.
 */
export interface SetBookingRequestTagsInput {
  bookingRequestId: string;
  /** Caller-verified owning org of the request. */
  orgId: string;
  tagIds: readonly string[];
}

/** One row per (request, tag) pair from the batched read. */
export interface BookingRequestTagRow {
  bookingRequestId: string;
  tag: BookingTagRecord;
}

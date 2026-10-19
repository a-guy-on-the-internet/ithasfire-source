import type {
  BookingRequestTagRow,
  BookingTagRecord,
  CreateBookingTagInput,
  DeleteBookingTagInput,
  SetBookingRequestTagsInput,
  UpdateBookingTagInput,
} from "@th/types/repos/booking-tags";

/**
 * Org-scoped booking-request labels (booking-holds spec FR-017). Venue-
 * internal — never projected to the act. Org isolation: every tag mutation
 * carries `orgId` in the WHERE clause; `setForRequest` trusts the use case to
 * have verified the tag ids belong to the request's org.
 */
export interface BookingTagsRepo {
  /** All tags for an org, sortOrder asc then name asc. */
  listForOrg(orgId: string): Promise<BookingTagRecord[]>;
  /**
   * A P2002 on the (orgId, slug) unique maps to
   * `{ code: "conflict", message: "booking_tag_slug_taken" }` — the
   * type-to-create input races itself on double-submit.
   */
  create(input: CreateBookingTagInput): Promise<BookingTagRecord>;
  /**
   * Partial update scoped by (id, orgId); `null` when no row matched. Same
   * P2002 → `booking_tag_slug_taken` mapping as `create`.
   */
  update(input: UpdateBookingTagInput): Promise<BookingTagRecord | null>;
  /**
   * Delete scoped by (id, orgId). Join rows cascade (delete detaches).
   * Resolves `true` iff a row was removed.
   */
  delete(input: DeleteBookingTagInput): Promise<boolean>;
  /**
   * Replace-all attach — see {@link SetBookingRequestTagsInput}. Verifies
   * every tag id belongs to `orgId` before writing; a foreign or unknown id
   * → `{ code: "invalid_input", message: "booking_tag_foreign_org" }`. The
   * request's own org membership is the CALLER's responsibility (`orgId` is
   * trusted as verified).
   */
  setForRequest(input: SetBookingRequestTagsInput): Promise<BookingTagRecord[]>;
  /**
   * Tags for a SET of requests in ONE query (inbox chips). Rows come back
   * ordered by (bookingRequestId, tag.sortOrder, tag.name); `[]` short-
   * circuits without touching the DB.
   */
  listForRequests(
    bookingRequestIds: readonly string[],
  ): Promise<BookingRequestTagRow[]>;
}

export type {
  BookingRequestTagRow,
  BookingTagRecord,
  CreateBookingTagInput,
  DeleteBookingTagInput,
  SetBookingRequestTagsInput,
  UpdateBookingTagInput,
} from "@th/types/repos/booking-tags";

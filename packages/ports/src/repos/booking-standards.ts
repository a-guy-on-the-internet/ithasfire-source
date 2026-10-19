import type {
  BookingPitchExampleRecord,
  BookingStandardItemRecord,
  BookingStandardsForOwners,
  ListBookingStandardsForOwnersInput,
  ReplaceBookingPitchExamplesInput,
  ReplaceBookingStandardItemsInput,
} from "@th/types/repos/booking-standards";

/**
 * Booking standards + example pitches, by polymorphic owner (venue-booking-
 * standards spec, docs/specs/2026-09-25, FR-001 / FR-002).
 *
 * STORAGE ONLY. Resolution (calendar → place → platform), caps, the
 * CUSTOM ⇒ SUGGESTED rule, "does this field apply to this intent" and
 * sanitizing are core's (`packages/core/src/use-cases/booking-standards/`).
 * The only rule the database also holds is D2a, as the SQL CHECK
 * "BookingStandardItem_custom_is_suggested_check".
 *
 * Owner scoping: every method is keyed by (ownerType, ownerId); nothing here
 * checks that the caller may edit that owner — the use case does, first.
 */
export interface BookingStandardsRepo {
  /**
   * Both tables for any mix of owners, in ONE call. Optional `intent` narrows
   * both lists. Each list is ordered by (ownerType, ownerId, intent,
   * sortOrder, id). `owners: []` short-circuits to empty lists without
   * touching the database.
   */
  listForOwners(
    input: ListBookingStandardsForOwnersInput,
  ): Promise<BookingStandardsForOwners>;

  /**
   * Replace-all for one (owner, intent), atomically: delete that owner's rows
   * for that intent, insert `items` with sortOrder 0..n-1 in array order,
   * return the new rows in order. Other intents and other owners are
   * untouched. If any insert fails (e.g. the D2a CHECK) the old rows stay —
   * inside `repos.tx()` the caller's transaction provides that; on the root
   * client the adapter opens its own.
   */
  replaceItems(
    input: ReplaceBookingStandardItemsInput,
  ): Promise<BookingStandardItemRecord[]>;

  /** Replace-all for one (owner, intent)'s examples — same contract. */
  replaceExamples(
    input: ReplaceBookingPitchExamplesInput,
  ): Promise<BookingPitchExampleRecord[]>;
}

export type {
  BookingPitchExampleInput,
  BookingPitchExampleRecord,
  BookingStandardField,
  BookingStandardItemInput,
  BookingStandardItemRecord,
  BookingStandardOwnerKey,
  BookingStandardOwnerType,
  BookingStandardRequirement,
  BookingStandardsForOwners,
  ListBookingStandardsForOwnersInput,
  ReplaceBookingPitchExamplesInput,
  ReplaceBookingStandardItemsInput,
} from "@th/types/repos/booking-standards";

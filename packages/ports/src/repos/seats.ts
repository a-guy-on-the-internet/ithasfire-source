import type {
  FindSeatsForUpdateInput,
  ListSeatsByEventInput,
  LockedSeatRecord,
  ListAvailableSeatsBySectionInput,
  MaterializeSectionsInput,
  MaterializeSectionsResult,
  PickContiguousAvailableInput,
  ReleaseExpiredSeatHoldsInput,
  ReleaseSeatsInput,
  ReserveSeatsForHoldInput,
  SeatRecord,
  SeatDisplayRecord,
  SeatLabelRead,
  SeatPriceOverrideEditRecord,
  SeatPriceOverrideLock,
  SeatPriceOverrideRead,
  SeatSectionPriceOverride,
  SeatSectionSummary,
  SeatStatus,
  UpdateSeatPriceOverridesInput,
  UpdateSeatStatusesInput,
} from "@th/types/repos/seats";

export interface SeatsRepo {
  /**
   * Lock the named seats of `eventId` FOR UPDATE. Seats of another event are
   * not returned. Every row carries `priceOverride`, read leniently and
   * NEVER thrown on, because mint (after the charge), the ticket email and
   * the public resale listing lock seats through here too:
   *   - SQL NULL or JSON `null`        → `null` (no override);
   *   - `{ priceCents: number, ... }` → that override (`reason` kept if a
   *                                      string, else null);
   *   - anything else                  → `{ invalid: true }`.
   * Range is not checked here. Checkout (`holdSeatsForCheckout`) refuses an
   * invalid marker, a negative or a fractional amount (INTERNAL
   * `seat_price_override_invalid`, via `seatOverrideCents`), and refuses
   * `seat_price_changed` when the override differs from the one the cart was
   * priced with.
   */
  findByIdsForUpdate(input: FindSeatsForUpdateInput): Promise<LockedSeatRecord[]>;
  /**
   * Read the stored `priceOverride` of the named seats of `eventId`, WITHOUT a
   * lock, with the same lenient mapping as `findByIdsForUpdate`. Checkout
   * prices a cart from this before it takes any seat lock (the capacity lock
   * must come first) and refuses an invalid value; the locked re-read is what
   * makes the price binding. Seats of another event are not returned.
   */
  findPriceOverridesByIds(
    input: FindSeatsForUpdateInput,
  ): Promise<SeatPriceOverrideRead[]>;
  /**
   * The label and section name of the named seats of `eventId`, read WITHOUT
   * a lock: for a read path that only prints where a ticket sits (the embed
   * confirmation). Seats of another event, and unknown ids, are absent.
   * Implementations MUST NOT lock (`findByIdsForUpdate` waits on checkout,
   * the door and mint, and locks SeatSection).
   */
  findLabelsByIds(input: FindSeatsForUpdateInput): Promise<SeatLabelRead[]>;
  updateStatuses(input: UpdateSeatStatusesInput): Promise<void>;
  /**
   * Auto-assign `qty` AVAILABLE seats of a section (FOR UPDATE, oldest
   * first) and flip them HELD, for a seated line that named no seats.
   * Implementations MUST skip seats that carry a `priceOverride`: the buyer
   * never saw those seats, so they sell only by explicit pick and the
   * auto-assigned line is charged the tier price.
   */
  reserveForHold(input: ReserveSeatsForHoldInput): Promise<SeatRecord[]>;
  /**
   * Pick `qty` AVAILABLE seats from a section, preferring same-row
   * contiguous runs. Locks the section's AVAILABLE rows FOR UPDATE for the
   * duration of the surrounding transaction. Returned seats stay
   * AVAILABLE; the caller flips them to HELD (card) or lets mint flip them
   * to SOLD (cash). Returns an empty array when fewer than `qty` seats are
   * available. Implementations MUST skip seats that carry a `priceOverride`,
   * as `reserveForHold` does: the door charges the tier price.
   */
  pickContiguousAvailable(
    input: PickContiguousAvailableInput,
  ): Promise<SeatRecord[]>;
  /**
   * Put HELD seats back on sale. Implementations MUST carry the
   * `status = "HELD"` predicate (never a blind `updateMany`) so a SOLD seat
   * with a Ticket attached can never be flipped back to AVAILABLE, and MUST
   * honour the optional `heldBefore` ownership fence — see
   * `ReleaseSeatsInput`.
   */
  releaseSeats(input: ReleaseSeatsInput): Promise<void>;
  /**
   * Put ORPHANED expired holds back on sale, returning how many flipped.
   *
   * A candidate is HELD, stamped before `before`, has no Ticket, AND is not
   * referenced by any OPEN order's (`PENDING` / `PROCESSING`)
   * `OrderItem.meta.seatIds`. A seat an open cart still references is that
   * cart's: its fate is decided by the PI-aware cart reaper
   * (`releaseExpiredCarts`), which keeps a paid-but-unfinalised cart —
   * releasing it here double-sold the seat (money audit 2026-09-08 #16).
   * A seat referenced only by a terminal order (CANCELLED, REFUNDED, …) is
   * an orphan and MUST still be released; do not over-exclude.
   *
   * A seat an open order references has NO time bound here: it is released
   * only by the cart reaper's cancel, finalize's mint, or an operator
   * cancelling the order. Watch `quarantinedCount` on `releaseExpiredCarts`
   * for seats wedged behind a paid-but-unfinalised cart.
   *
   * Implementations MUST keep the `status = "HELD"` predicate on the flip
   * and MUST honour `limit` as a cap on seats flipped per call.
   */
  releaseExpiredHolds(input: ReleaseExpiredSeatHoldsInput): Promise<number>;
  listByEvent(input: ListSeatsByEventInput): Promise<SeatRecord[]>;
  /**
   * Every seat of `eventId` for the organizer's override editor, in ONE
   * query, ordered like `listByEvent`. `priceOverride` uses the checkout
   * reads' lenient mapping (null / the override / `{ invalid: true }`), never
   * throwing, so a corrupt row is visible to the caller rather than read as
   * no override. Carries the private `reason`: organizer reads only.
   */
  listPriceOverridesByEvent(
    input: ListSeatsByEventInput,
  ): Promise<SeatPriceOverrideEditRecord[]>;
  /**
   * Every distinct (section, stored override) pair among the seats of
   * `eventId` that carry an override, in ONE unlocked query; seats with SQL
   * NULL or JSON `null` are not read. Same lenient parse as the checkout
   * reads (the override, or `{ invalid: true }`; never thrown), so a corrupt
   * row reaches the caller instead of reading as no override. Seats of every
   * status. Two readers, both asking whether a stored override makes a free
   * tier take money: `publishEvent`, for the whole event, and the ticket type
   * writes (`assignTicketTypeSections`, `upsertTicketType`,
   * `updateTicketType`, through `ensureStoredOverridesGatedForTierWrites`),
   * for the section a free FIXED tier is about to start selling.
   */
  listDistinctPriceOverridesByEvent(
    input: ListSeatsByEventInput,
  ): Promise<SeatSectionPriceOverride[]>;
  /** List available seats with display info for a given section + event. */
  listAvailableBySection(
    input: ListAvailableSeatsBySectionInput,
  ): Promise<SeatDisplayRecord[]>;
  /** Get a section summary by id (for enriching ticket type responses). */
  getSectionById(seatSectionId: string): Promise<SeatSectionSummary | null>;
  /** List all seat sections for an event. */
  listSectionsByEvent(eventId: string): Promise<SeatSectionSummary[]>;
  /**
   * Materialise SeatSection + Seat rows from a PlaceLayout for an event.
   * Idempotent: existing sections (matched by eventId + placeLayoutId + layoutSectionId)
   * are updated rather than duplicated.
   * `sectionsCreated` / `seatsCreated` count rows INSERTED (0 on an unchanged
   * re-run), not rows touched.
   */
  materializeSections(
    input: MaterializeSectionsInput,
  ): Promise<MaterializeSectionsResult>;
  /**
   * The lock `setSeatPriceOverrides` takes before it writes: the named seats
   * of `eventId`, each either locked by THIS transaction (`busy: false`) or
   * reported as locked by another one right now (`busy: true`). Seats of
   * another event, and unknown ids, are absent.
   *
   * Implementations MUST NOT wait on any row lock: lock with
   * `FOR NO KEY UPDATE OF <Seat> SKIP LOCKED` (Seat rows only, never the
   * SeatSection row, in a fixed `id` order) and find the busy rows with a
   * plain, unlocked read. An organizer's bulk edit then never joins a
   * deadlock with checkout, the door or mint; it reports the seats it could
   * not take. Not `findByIdsForUpdate`: that one waits, and locks SeatSection.
   */
  lockSeatsForPriceOverrideWrite(
    input: FindSeatsForUpdateInput,
  ): Promise<SeatPriceOverrideLock[]>;
  /**
   * Bulk-set (or clear) a per-seat price override on seats of `eventId`.
   * Returns the number of rows updated.
   *
   * Implementations MUST carry a `status IN ('AVAILABLE', 'BLOCKED')`
   * predicate on the UPDATE itself (never a blind update by id), for a set
   * AND a clear: a SOLD seat keeps the price it was charged, and a HELD seat
   * belongs to a live checkout that was priced with the current override.
   * `setSeatPriceOverrides` locks the rows first (`lockSeatsForPriceOverrideWrite`)
   * and counts the skips; the predicate is what keeps any other caller from
   * re-pricing them.
   */
  updatePriceOverrides(input: UpdateSeatPriceOverridesInput): Promise<number>;
}

export type {
  FindSeatsForUpdateInput,
  LayoutSectionDef,
  ListSeatsByEventInput,
  ListAvailableSeatsBySectionInput,
  LockedSeatRecord,
  MaterializeSectionsInput,
  MaterializeSectionsResult,
  PickContiguousAvailableInput,
  ReleaseExpiredSeatHoldsInput,
  ReleaseSeatsInput,
  ReserveSeatsForHoldInput,
  SeatRecord,
  SeatDisplayRecord,
  SeatLabelRead,
  SeatPriceOverride,
  SeatPriceOverrideEditRecord,
  SeatPriceOverrideLock,
  SeatPriceOverrideRead,
  SeatSectionPriceOverride,
  InvalidSeatPriceOverride,
  ReadSeatPriceOverride,
  SeatSectionSummary,
  SeatStatus,
  SeatSectionType,
  UpdateSeatPriceOverridesInput,
  UpdateSeatStatusesInput,
} from "@th/types/repos/seats";

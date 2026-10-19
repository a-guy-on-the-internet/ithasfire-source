export type SeatStatus = "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
export type SeatSectionType = "GA" | "RESERVED";

export interface SeatRecord {
  id: string;
  seatSectionId: string;
  eventId: string;
  status: SeatStatus;
  label: string;
  row: string | null;
  number: number | null;
  /** Populated by queries that select price_override; undefined otherwise. */
  priceOverride?: SeatPriceOverride | null;
}

/**
 * A stored `price_override` that is neither absent (SQL NULL / JSON `null`)
 * nor `{ priceCents: number }`. The adapter reports it instead of guessing;
 * checkout refuses it (`seatOverrideCents` throws INTERNAL naming the seat),
 * and every other reader ignores the field.
 */
export interface InvalidSeatPriceOverride {
  invalid: true;
}

/** What the seat reads that checkout prices from carry in `priceOverride`. */
export type ReadSeatPriceOverride =
  | SeatPriceOverride
  | InvalidSeatPriceOverride
  | null;

/**
 * A seat row read FOR UPDATE. `priceOverride` is REQUIRED here (null = none):
 * checkout compares it against the override the cart was priced with, so a
 * projection that left it out would silently pass every seat at the tier
 * price (seat-price-overrides spec FR-003). Mint, the ticket email and the
 * resale listing read the same rows and do not look at it.
 */
export interface LockedSeatRecord extends Omit<SeatRecord, "priceOverride"> {
  priceOverride: ReadSeatPriceOverride;
}

/** One seat's stored override, read without a lock to price a cart. */
export interface SeatPriceOverrideRead {
  id: string;
  /**
   * The seat's section. The promo preview prices a seat at its override only
   * when the seat sits in the section its tier sells, as checkout would
   * accept it (a mismatched seat is refused there, never charged).
   */
  seatSectionId: string;
  priceOverride: ReadSeatPriceOverride;
}

/** Extended seat info for display in seat-picker UIs. */
export interface SeatDisplayRecord {
  id: string;
  seatSectionId: string;
  label: string;
  row: string | null;
  number: number | null;
  status: SeatStatus;
  geometry: unknown | null;
  /**
   * Per-seat price override. When non-null it REPLACES the ticket type's
   * resolved price for this seat, and checkout charges it (FIXED tiers only;
   * see `resolveSeatUnitPriceCents`).
   */
  priceOverride: SeatPriceOverride | null;
}

/**
 * JSON shape stored in Seat.price_override.
 * `priceCents` is the override price; `reason` is an optional human-readable note.
 */
export interface SeatPriceOverride {
  priceCents: number;
  reason?: string | null;
}

/** Seat section summary for embed/widget ticket-type listings. */
export interface SeatSectionSummary {
  id: string;
  name: string;
  type: SeatSectionType;
  capacity: number | null;
  /** Layout-internal section key (e.g. "ga-floor"). Null for manually-created sections. */
  layoutSectionId: string | null;
  /** PlaceLayout this section was materialised from. Null for manually-created sections. */
  placeLayoutId: string | null;
}

export interface ListAvailableSeatsBySectionInput {
  seatSectionId: string;
  eventId: string;
}

export interface FindSeatsForUpdateInput {
  seatIds: string[];
  eventId: string;
}

/**
 * What a seat is called on a ticket: its own label and its section's name.
 * Read without a lock (`SeatsRepo.findLabelsByIds`).
 */
export interface SeatLabelRead {
  id: string;
  label: string;
  row: string | null;
  number: number | null;
  seatSectionId: string;
  /** `SeatSection.name` of the seat's section. */
  sectionName: string;
}

export interface UpdateSeatStatusesInput {
  seatIds: string[];
  status: SeatStatus;
  updatedAt: Date;
}

export interface ReserveSeatsForHoldInput {
  seatSectionId: string;
  eventId: string;
  qty: number;
  heldAt: Date;
}

/**
 * Input for selecting `qty` AVAILABLE seats in a section while trying to
 * keep them contiguous (same row, adjacent numbers). Used by the POS
 * door-sale flow so walk-up groups end up seated together.
 *
 * Implementations must lock the section's AVAILABLE seats FOR UPDATE so
 * concurrent picks don't collide. The returned seats stay AVAILABLE — the
 * caller decides whether to flip them to HELD (card path) or let
 * `mintTicketsForOrder` flip them to SOLD (cash path).
 */
export interface PickContiguousAvailableInput {
  seatSectionId: string;
  eventId: string;
  qty: number;
}

export interface ReleaseSeatsInput {
  seatIds: string[];
  releasedAt: Date;
  /**
   * OPTIONAL ownership fence. When set, only rows whose `updatedAt` is at or
   * before this instant are released; a fresher hold is left alone.
   *
   * `Seat` has no holder column — only `status` and `updatedAt` — so
   * "release the seats THIS order holds" cannot be expressed as an ownership
   * predicate. `status: "HELD"` alone is not one either: it proves somebody
   * holds the seat, not that the caller does. A caller working from a
   * possibly-stale list of seat ids (the expired-cart reaper reads
   * `meta.seatIds`, which is stale by construction) must therefore fence on
   * time as well, passing an instant at or before its OWN hold and strictly
   * before any hold another buyer could have taken.
   *
   * Omit it and the release is HELD-guarded but ownership-blind, which is
   * correct only for callers holding the seat right now in the same
   * transaction (`create-checkout`, `update-order-items`,
   * `claim-free-tickets`, both POS paths).
   */
  heldBefore?: Date;
}

export interface ReleaseExpiredSeatHoldsInput {
  /** TTL fence: only seats whose hold was stamped before this instant. */
  before: Date;
  /** Stamped onto each released seat's `updatedAt`. */
  releasedAt: Date;
  /**
   * Cap on seats flipped per call. Applied AFTER the orphan predicate, so
   * kept-cart seats never crowd orphans out of a page. Omit for no cap.
   */
  limit?: number;
}

export interface ListSeatsByEventInput {
  eventId: string;
}

// ── Price overrides ──────────────────────────────────────────────────────────

/**
 * One seat of an event as the organizer's override editor reads it. Unlike
 * `SeatRecord` (whose display parse turns a corrupt `priceOverride` into
 * `null` silently), `priceOverride` keeps the `{ invalid: true }` marker the
 * checkout reads use, so the editor can show the seat as broken instead of
 * as plain. `reason` is the organizer's private note: never return this
 * record on a public read.
 */
export interface SeatPriceOverrideEditRecord {
  id: string;
  seatSectionId: string;
  status: SeatStatus;
  label: string;
  row: string | null;
  number: number | null;
  priceOverride: ReadSeatPriceOverride;
}

/**
 * One distinct stored override in one section of an event, as
 * `listDistinctPriceOverridesByEvent` reads it for the publish gate. Never
 * `null`: seats without an override are not read.
 */
export interface SeatSectionPriceOverride {
  seatSectionId: string;
  priceOverride: SeatPriceOverride | InvalidSeatPriceOverride;
}

/**
 * One requested seat as `lockSeatsForPriceOverrideWrite` found it.
 * `busy: true` = another transaction holds the row lock right now (a checkout,
 * a door sale, mint, or another override edit); the caller does NOT hold it,
 * and `status` is the last committed value, read without a lock.
 */
export interface SeatPriceOverrideLock {
  id: string;
  seatSectionId: string;
  status: SeatStatus;
  busy: boolean;
}

/** Input for bulk-setting (or clearing) a per-seat price override. */
export interface UpdateSeatPriceOverridesInput {
  seatIds: string[];
  eventId: string;
  /** Pass `null` to clear the override and revert to the ticket-type price. */
  priceOverride: SeatPriceOverride | null;
}

// ── Materialisation ──────────────────────────────────────────────────────────

/** A section definition from PlaceLayout.metadata.sections[] */
export interface LayoutSectionDef {
  sectionId: string;
  label: string;
  capacity: number;
  /** "seat" = individually-placed seats, "ga" = general admission (capacity only), "helper" = visual-only (omit from materialisation). */
  kind?: "seat" | "ga" | "helper";
  color?: string | null;
  geometry?: unknown | null;
  stageAnchor?: unknown | null;
}

/** Input for materialising SeatSection + Seat rows from a PlaceLayout. */
export interface MaterializeSectionsInput {
  eventId: string;
  placeLayoutId: string;
  sections: LayoutSectionDef[];
  /** All seat IDs from the layout (format: "<sectionId>-<row>-<number>"). */
  seatIds: string[];
}

/** Result of materialising sections for an event. */
export interface MaterializeSectionsResult {
  sectionsCreated: number;
  seatsCreated: number;
  /** Map from layoutSectionId → SeatSection.id (UUID). */
  sectionIdMap: Record<string, string>;
}

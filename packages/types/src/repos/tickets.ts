export type TicketTypeStatus = "DRAFT" | "ACTIVE";

export type TicketTypePricingMode = "FIXED" | "ADJUSTABLE";

export type TicketStatus =
  | "VALID"
  | "SCANNED"
  | "INVALID"
  | "REFUNDED"
  | "LISTED";

/**
 * The ticket statuses whose holder still OWNS the reserved seat, i.e. the only
 * ones that may keep a `Seat` out of the pool.
 *
 *   - `VALID`   — unused ticket, the seat is theirs.
 *   - `SCANNED` — they walked in and are sitting in it.
 *   - `LISTED`  — up for resale, but still theirs until it sells.
 *
 * Everything else is terminal: `REFUNDED` (money returned) and `INVALID`
 * (revoked, e.g. a clawed-back volunteer reward). A terminal ticket must NOT
 * block its seat — that is the "a refunded seat can never be resold" bug: the
 * dead row kept its `seatId` and every seat-occupancy read matched on `seatId`
 * alone, so the seat stayed unsellable forever.
 *
 * Lives in `@th/types` (not `@th/core`) deliberately: the Prisma adapter filters
 * the SQL with the SAME list the use cases filter in memory, so the two cannot
 * drift into different definitions of "occupied".
 */
export const SEAT_OWNING_TICKET_STATUSES: readonly TicketStatus[] = [
  "VALID",
  "SCANNED",
  "LISTED",
];

/** True when a ticket in this status still holds its seat. */
export function ticketOwnsSeat(status: TicketStatus): boolean {
  return SEAT_OWNING_TICKET_STATUSES.includes(status);
}

/**
 * The ticket statuses that hold a place in their ticket type's CAPACITY: the
 * `issued` half of `capacity - issued - held` (refunds-restock spec
 * 2026-10-09, FR-001).
 *
 * `REFUNDED` and `INVALID` give the place back, so someone else can buy it.
 * Counts that mean "a ticket ever existed" (the delete-ticket-type and publish
 * guards, mint idempotency) still count every row and must not use this list.
 *
 * Same members as {@link SEAT_OWNING_TICKET_STATUSES}, and that is no
 * accident: a ticket that holds a place holds its seat. It is a separate name
 * so a capacity read and a seat read say which question they ask, and a grep
 * for one does not turn up the other.
 *
 * Lives in `@th/types` for the same reason as the seat set: the Prisma
 * adapter's capacity counts and any in-memory filter read ONE list.
 */
export const CAPACITY_CONSUMING_TICKET_STATUSES: readonly TicketStatus[] = [
  "VALID",
  "SCANNED",
  "LISTED",
];

export interface TicketTypeRecord {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  priceCents: number;
  pricingMode: TicketTypePricingMode;
  minimumCents: number | null;
  suggestedCents: number | null;
  capacity: number;
  status: TicketTypeStatus;
  createdAt: Date;
  updatedAt: Date;
  seatSectionId?: string | null;
  resaleAllowed: boolean;
  resaleCapCents: number | null;
  transferAllowed: boolean;
  /**
   * Scheduled price change (time-based-ticket-pricing FR-005). Both null or
   * both set — the write boundary rejects a half-configuration with
   * TICKET_TYPE_SCHEDULE_INCOMPLETE. `scheduledPriceAt` is an absolute UTC
   * instant; resolve with `resolveUnitPriceCents`, never by reading
   * `priceCents` directly.
   */
  scheduledPriceCents: number | null;
  scheduledPriceAt: Date | null;
  /**
   * Per-type sales window (ticket-type-packs FR-014). Independent bounds; null
   * = "no bound". `salesOpenAt` is INCLUSIVE, `salesCloseAt` EXCLUSIVE. Never
   * hand-roll the comparison — use `resolveTicketTypeSaleState` /
   * `assertTicketTypeOnSale` (packages/core/src/lib/orders/door-pricing.ts).
   */
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
}

export interface CreateTicketTypeInput {
  eventId: string;
  name: string;
  description: string | null;
  priceCents: number;
  pricingMode?: TicketTypePricingMode;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  status: TicketTypeStatus;
  createdAt: Date;
  seatSectionId?: string | null;
  resaleAllowed?: boolean;
  resaleCapCents?: number | null;
  transferAllowed?: boolean;
  /**
   * Scheduled price change (TicketType.scheduledPriceCents / scheduledPriceAt).
   * Omitted = null/null (unscheduled). Callers MUST supply both or neither;
   * the use-case write boundary enforces that with
   * TICKET_TYPE_SCHEDULE_INCOMPLETE.
   */
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
  /**
   * Per-type sales window (TicketType.salesOpenAt / salesCloseAt). Omitted =
   * null (no bound). The use-case write boundary enforces
   * `salesOpenAt < salesCloseAt` when both are supplied, with
   * TICKET_TYPE_SALES_WINDOW_INVALID.
   */
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
}

export interface UpdateTicketTypeInput {
  id: string;
  name?: string;
  description?: string | null;
  priceCents?: number;
  pricingMode?: TicketTypePricingMode;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity?: number;
  seatSectionId?: string | null;
  resaleAllowed?: boolean;
  resaleCapCents?: number | null;
  /**
   * Scheduled price change. `undefined` = leave as-is, `null` = clear. The use
   * case merges these against the stored row before validating the
   * both-or-neither invariant, so a partial update can never leave the row
   * half-configured.
   */
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
  /**
   * Sales window. `undefined` = leave as-is, `null` = clear that bound. The use
   * case merges these against the stored row before validating the ordering
   * invariant, so a partial update can never persist an inverted window.
   */
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
}

export interface TicketRecord {
  id: string;
  eventId: string;
  ticketTypeId: string | null;
  ownerHumanId: string;
  orderId: string | null;
  orderItemId: string | null;
  seatId: string | null;
  code: string;
  status: TicketStatus;
  issuedAt: Date;
  scannedAt: Date | null;
}

export interface CreateTicketInput {
  eventId: string;
  ticketTypeId: string | null;
  ownerHumanId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  seatId?: string | null;
  code: string;
  status: TicketStatus;
  issuedAt: Date;
}

export type TicketScanOutcome = "ACCEPTED" | "REJECTED" | "REPLAY";

/**
 * Scan outcomes that mean a person was LET IN — the attendance basis for the
 * venue track record (venue-track-record spec 2026-09-24, R11 as re-ruled
 * 2026-09-25). `ACCEPTED` is the only admit: the operator scan that burned
 * the ticket, and the two POS auto-admits — cash (`message:
 * "POS_CASH_AUTO_ADMIT"`, record-cash-sale) and card-present (`message:
 * "POS_AUTO_ADMIT"`, finalize-from-payment-intent).
 * `REPLAY` is a second scan of a ticket already in (not a second person) and
 * `REJECTED` is a denial (wrong event, not found, not valid, event inactive).
 */
export const ADMIT_SCAN_OUTCOMES = [
  "ACCEPTED",
] as const satisfies readonly TicketScanOutcome[];

/**
 * Ticket statuses that mean an ACCEPTED scan was UNDONE by `revertTicketScan`
 * and not re-admitted. The revert writes nothing to the `TicketScan` log —
 * it flips the ticket SCANNED → VALID (and it may then be listed for resale,
 * LISTED). The only other way an admitted ticket reaches either status is
 * the resale refund unwind (`restoreAfterResale`), which is always preceded
 * by a `TicketTransfer` back to the seller — so the count reads "has an
 * ACCEPTED row, is VALID or LISTED today, and no transfer since the scan"
 * as "the admit was reverted". Refunds move a ticket to REFUNDED and it
 * keeps counting. `revokeVolunteerReward` REFUSES a SCANNED ticket, so an
 * INVALID ticket with an ACCEPTED row was reverted first — the count cannot
 * see that and over-counts it (FU-008), as it does a reverted admit later
 * refunded or transferred. A re-admit returns it to SCANNED and it counts
 * again.
 */
export const REVERTED_ADMIT_TICKET_STATUSES = [
  "VALID",
  "LISTED",
] as const satisfies readonly TicketStatus[];

export interface RecordTicketScanInput {
  ticketId: string;
  eventId: string;
  actorHumanId: string;
  scannedAt: Date;
  locationLat: number | null;
  locationLng: number | null;
  outcome: TicketScanOutcome;
  message: string | null;
}

export type MarkScannedResult =
  | { ok: true; scannedAt: Date }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_status"; scannedAt?: Date | null };

// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide ticket listing (staff-only)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAllTicketsInput {
  /** Free-text search on ticket code, owner name/email */
  searchQuery?: string | null;
  status?: TicketStatus;
  statuses?: TicketStatus[];
  eventId?: string | null;
  orgId?: string | null;
  sort?: "issuedAt_desc" | "issuedAt_asc";
  limit?: number;
  offset?: number;
}

export interface ListPlatformTicketsItem {
  id: string;
  code: string;
  status: TicketStatus;
  eventId: string;
  eventTitle: string;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
  ownerHumanId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  issuedAt: Date;
  scannedAt: Date | null;
  seatLabel: string | null;
  transferCount: number;
  scanCount: number;
}

export interface ListAllTicketsResult {
  items: ListPlatformTicketsItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Full ticket with relations for platform detail view */
export interface TicketDetailRecord {
  id: string;
  code: string;
  status: TicketStatus;
  eventId: string;
  eventTitle: string;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
  ownerHumanId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  seatId: string | null;
  seatLabel: string | null;
  issuedAt: Date;
  scannedAt: Date | null;
}

export interface TicketTransferRecord {
  id: string;
  ticketId: string;
  fromHumanId: string;
  fromName: string | null;
  toHumanId: string;
  toName: string | null;
  reason: "primary" | "resale" | "gift" | "admin";
  orderId: string | null;
  transferredAt: Date;
}

export interface TicketScanRecord {
  id: string;
  ticketId: string;
  eventId: string;
  actorHumanId: string;
  actorName: string | null;
  outcome: TicketScanOutcome;
  message: string | null;
  scannedAt: Date;
  locationLat: number | null;
  locationLng: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket migration (bulk move tickets between events)
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkMigrateTicketsInput {
  sourceEventId: string;
  targetEventId: string;
  /** Old ticketTypeId → new ticketTypeId. Types not in the map keep their current value. */
  ticketTypeMapping: Record<string, string>;
  /** When true, generates new codes for every migrated ticket. */
  regenerateCodes: boolean;
}

export interface BulkMigrateTicketsResult {
  updatedCount: number;
  /** IDs of the tickets that were migrated. */
  migratedTicketIds: string[];
}

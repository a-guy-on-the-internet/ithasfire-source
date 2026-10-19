import type { ResaleSharePayer } from "./payout-terms";

// ── Status union (mirrors Prisma enum) ──
export type ResaleListingStatus =
  | "ACTIVE"
  | "HELD"
  | "SOLD"
  | "CANCELLED"
  | "EXPIRED";

export type ResaleListingSource = "internal" | "external";

// ── Records ──

export interface ResaleListingRecord {
  id: string;
  ticketId: string;
  eventId: string;
  sellerHumanId: string;
  askPriceCents: number;
  faceValueCents: number | null;
  processingPassThroughCents: number;
  processingFeeConfigRef: string | null;
  saleCutoffAt: Date | null;
  payoutReleaseAt: Date | null;
  currency: string;
  status: ResaleListingStatus;
  expiresAt: Date | null;
  source: string;
  externalRef: unknown;
  resalePayoutTermsId: string | null;
  /**
   * The share this listing's sale pays to the event side (organiser-resale-
   * share FR-005) and who pays it; both null on listings made before the
   * share existed. Optional only so hand-built fakes still type-check; the
   * Prisma adapter always sets both.
   */
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
  buyerOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The ticket facts a listing read shows beside the share (organiser-resale-
 * share FR-007): the original price and the ticket type's stored pricing.
 * Optional only so hand-built fakes still type-check; the Prisma adapter
 * always sets them on the reads that join the ticket.
 */
export interface ResaleListingTicketFacts {
  /**
   * "Original price" (organiser-resale-share FR-007): what the ticket first
   * sold for, read from the seller's purchase item
   * (`OrderItem.originalUnitPriceCents`, written at the first sale or filled
   * at the first listing, FR-004). Null when the item records none, i.e. a
   * listing made before the share existed. Optional only so hand-built fakes
   * still type-check; the Prisma adapter always sets it.
   */
  originalPriceCents?: number | null;
  /**
   * The ticket type's stored pricing, for a UI that must
   * word the original price of a comp ($0 recorded) or pay-what-you-want
   * ticket. Facts only; never used to price anything. Null when the ticket
   * has no type. Optional for the same reason as `originalPriceCents`.
   */
  ticketTypePricing?: {
    /** RAW stored price; resolve with `resolveUnitPriceCents` (scheduled flip). */
    priceCents: number;
    scheduledPriceCents: number | null;
    scheduledPriceAt: Date | null;
    pricingMode: "FIXED" | "ADJUSTABLE";
    minimumCents: number | null;
  } | null;
}

/** The seller's own listings, with the ticket facts. */
export interface SellerResaleListingRecord
  extends ResaleListingRecord,
    ResaleListingTicketFacts {}

/**
 * A resale listing enriched with ticket-type, seat, and section context.
 * Used for buyer-facing browse queries where display info is needed.
 */
export interface EnrichedResaleListingRecord
  extends ResaleListingRecord,
    ResaleListingTicketFacts {
  /** Ticket type name (e.g. "General Admission", "VIP"). Null if ticket has no type. */
  ticketTypeName: string | null;
  /**
   * HISTORICAL face value in cents (FR-001): the listing's own frozen
   * `faceValueCents` snapshot, else the seller's `OrderItem.unitPriceCents`
   * (the ticket's list price at purchase). Null when neither is reachable.
   *
   * Deliberately NEVER the live `TicketType.priceCents` — that number moves
   * whenever the organizer edits it, and showing it as face value would
   * disagree with the seller/venue markup split the money actually took.
   */
  facePriceCents: number | null;
  /** Seat section name (e.g. "Section A", "Floor"). Null for GA or unseated tickets. */
  sectionName: string | null;
  /** Seat section ID. Null for GA or unseated tickets. */
  sectionId: string | null;
  /** Human-readable seat label (e.g. "Row G, Seat 12"). Null for GA or unseated. */
  seatLabel: string | null;
  /** Raw seat row value (e.g. "G"). Null for GA or unseated. */
  seatRow: string | null;
  /** Raw seat number (e.g. 12). Null for GA or unseated. */
  seatNumber: number | null;
}

// ── Inputs ──

export interface CreateResaleListingInput {
  ticketId: string;
  eventId: string;
  sellerHumanId: string;
  askPriceCents: number;
  faceValueCents?: number | null;
  processingPassThroughCents?: number;
  processingFeeConfigRef?: string | null;
  saleCutoffAt?: Date | null;
  payoutReleaseAt?: Date | null;
  currency?: string;
  expiresAt?: Date;
  resalePayoutTermsId?: string;
  /** FR-005 share and payer; both set or both omitted (SQL CHECK). */
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
}

export interface CreateExternalListingInput {
  ticketId: string;
  eventId: string;
  sellerHumanId: string;
  askPriceCents: number;
  faceValueCents?: number | null;
  processingPassThroughCents?: number;
  processingFeeConfigRef?: string | null;
  saleCutoffAt?: Date | null;
  payoutReleaseAt?: Date | null;
  currency?: string;
  expiresAt?: Date;
  resalePayoutTermsId?: string;
  /** FR-005 share and payer; both set or both omitted (SQL CHECK). */
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
  externalRef: { provider: string; externalId: string; barcode?: string };
}

// ── Results ──

export interface ResaleListingHoldResult {
  ok: boolean;
}

export interface ResaleListingCommitResult {
  ok: boolean;
  ticketId?: string;
}

/**
 * A completed resale transaction's price data, used for data-backed
 * pricing in the resale price snapshot computation.
 */
export interface CompletedResalePrice {
  askPriceCents: number;
  completedAt: Date;
}

/**
 * The resale claim window, in days after the event ends (`endsAt ?? startsAt`).
 * A resale buyer can file a claim until it closes, and no RESALE-order credit
 * (the seller's included) is payable before it closes.
 *
 * Lives here, not in core, because BOTH sides read it: core
 * (`lib/resale-claim-window.ts` — the claim deadline, the pricing release
 * floor, the credit maturity floor) and the payee-ledger adapter's payable
 * SQL (which re-checks the window against the event's CURRENT end, so a
 * rescheduled event cannot pay a seller early).
 */
export const RESALE_CLAIM_WINDOW_DAYS = 3;

export type FeeWaiverSubjectType = "HUMAN" | "ORG";
export type FeeWaiverSide = "ORGANIZER" | "BUYER";
export type FeeWaiverStatus = "ACTIVE" | "EXHAUSTED" | "REVOKED";
export type FeeWaiverRedemptionStatus = "RESERVED" | "SETTLED" | "RELEASED";

export interface FeeWaiverRecord {
  id: string;
  subjectType: FeeWaiverSubjectType;
  subjectId: string;
  side: FeeWaiverSide;
  ticketsGranted: number;
  /** RESERVED + SETTLED tickets. Never exceeds `ticketsGranted`. */
  ticketsUsed: number;
  /** Convenience: `ticketsGranted - ticketsUsed`. */
  ticketsRemaining: number;
  status: FeeWaiverStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  notes: string | null;
  createdBy: string;
  revokedBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeeWaiverRedemptionRecord {
  id: string;
  waiverId: string;
  orderId: string;
  ticketsReserved: number;
  feeWaivedCents: number;
  status: FeeWaiverRedemptionStatus;
  releasedAt: Date | null;
  settledAt: Date | null;
  createdAt: Date;
}

/**
 * Identifies the parties on a checkout so the resolver can find an applicable
 * allowance. `buyerHumanId` is null for guest checkout.
 */
export interface ResolveFeeWaiverInput {
  buyerHumanId: string | null;
  organizerOrgId: string | null;
  organizerHumanId: string | null;
  at: Date;
}

export interface ReserveFeeWaiverInput {
  waiverId: string;
  orderId: string;
  /**
   * Platform fee (cents) of each fee-bearing ticket on the order, sorted
   * DESCENDING. Length is how many tickets the order wants waived; the values
   * let the reserve record exactly what a partial fulfilment cost us.
   *
   * Descending order is load-bearing: a partial reservation waives the N most
   * expensive tickets, and `computeOrderAmounts` zeroes those same N. Both
   * sides must sort identically or the recorded cost drifts from the charge.
   */
  waivableTicketFeesCents: number[];
}

export interface ReserveFeeWaiverResult {
  /**
   * Tickets actually reserved — 0 when the allowance was exhausted by a
   * concurrent checkout between resolve and reserve.
   */
  reservedTickets: number;
  feeWaivedCents: number;
  redemptionId: string | null;
}

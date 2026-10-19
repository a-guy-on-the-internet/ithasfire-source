import type {
  FeeWaiverRecord,
  FeeWaiverRedemptionRecord,
  FeeWaiverSide,
  FeeWaiverSubjectType,
  ReserveFeeWaiverInput,
  ReserveFeeWaiverResult,
  ResolveFeeWaiverInput,
} from "@th/types";

export interface GrantFeeWaiverInput {
  subjectType: FeeWaiverSubjectType;
  subjectId: string;
  side: FeeWaiverSide;
  ticketsGranted: number;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  notes?: string | null;
  actorHumanId: string;
}

export interface ListFeeWaiversInput {
  subjectType?: FeeWaiverSubjectType;
  subjectId?: string;
  side?: FeeWaiverSide;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export interface FeeWaiversRepo {
  getById(id: string): Promise<FeeWaiverRecord | null>;

  /**
   * Returns every ACTIVE, in-window allowance with headroom that applies to
   * this checkout, most-depleted first so a nearly-spent allowance is used up
   * before a fresh one. Resolution is the caller's job — this only filters.
   */
  resolveApplicable(input: ResolveFeeWaiverInput): Promise<FeeWaiverRecord[]>;

  /**
   * Atomically claims up to `requestedTickets` from the allowance and writes a
   * RESERVED redemption row.
   *
   * MUST be a single conditional UPDATE guarded on
   * `ticketsUsed + n <= ticketsGranted` — two checkouts racing for the last
   * ticket of an allowance must not both win. Partial fulfilment is expected:
   * asking for 5 against 3 remaining reserves 3.
   *
   * Idempotent per (waiverId, orderId): re-reserving for an order that already
   * holds a RESERVED/SETTLED redemption returns the existing reservation
   * without double-spending.
   */
  reserve(input: ReserveFeeWaiverInput): Promise<ReserveFeeWaiverResult>;

  /**
   * Returns a reservation to the allowance — checkout failed/expired, or the
   * order was refunded. No-op when the redemption is already RELEASED, so
   * duplicate webhook deliveries cannot inflate an allowance.
   */
  release(orderId: string): Promise<{ releasedTickets: number }>;

  /** Marks an order's reservations as spent for good. */
  settle(orderId: string): Promise<{ settledTickets: number }>;

  listRedemptionsByOrder(orderId: string): Promise<FeeWaiverRedemptionRecord[]>;

  grant(input: GrantFeeWaiverInput): Promise<FeeWaiverRecord>;

  revoke(input: {
    waiverId: string;
    actorHumanId: string;
  }): Promise<FeeWaiverRecord>;

  list(input: ListFeeWaiversInput): Promise<{
    waivers: FeeWaiverRecord[];
    total: number;
  }>;
}

export type {
  FeeWaiverRecord,
  FeeWaiverRedemptionRecord,
  FeeWaiverSide,
  FeeWaiverStatus,
  FeeWaiverSubjectType,
  ReserveFeeWaiverInput,
  ReserveFeeWaiverResult,
  ResolveFeeWaiverInput,
} from "@th/types";

import type {
  ConfirmPromoHoldsInput,
  PromoHoldRecord,
  PromoRecord,
  PromoRedemptionRecord,
  PromoRedemptionStats,
  PromoRedemptionStatsInput,
  PromoWithStats,
  CreatePromoHoldInput,
  CreatePromoInput,
  FindActivePromosInput,
  ListPromosByScopeInput,
  ListPromosByScopeResult,
  UpdatePromoInput,
} from "@th/types";

/**
 * Stats read keyed on the CALLER'S clock. A PENDING hold is a promised slot
 * and counts while it is unexpired at `now` OR its order is still open
 * (PENDING / PROCESSING) — the cart's lifetime is the hold's authority. The
 * adapter must not reach for DB time, or the count would disagree with the
 * `expiresAt` the same clock stamped.
 */
export type PromoRedemptionStatsQuery = PromoRedemptionStatsInput & {
  now: Date;
  /**
   * Leave THIS order's live holds out of the count: the buyer's own PENDING
   * cart, which still holds the code while they preview an edited cart or
   * retry checkout carrying it. That hold must not refuse them the slot they
   * already have. Confirmed redemptions are never excluded — a paid order is
   * a real redemption whoever asks. The caller must have established that
   * the order is the buyer's own PENDING cart on the same event; the
   * authoritative re-check in `createHolds` never excludes anything.
   */
  excludeOrderId?: string;
};

export type CreatePromoHoldsParams = {
  /** Same clock the holds' `expiresAt` was derived from. */
  now: Date;
};

export interface PromosRepo {
  findActiveByCodes(params: FindActivePromosInput): Promise<PromoRecord[]>;
  /**
   * `totalRedemptions` / `redemptionsForHuman` = confirmed redemptions PLUS
   * live holds (PENDING, not already confirmed on their order, and EITHER
   * unexpired at `now` OR on an order that is still open — PENDING or
   * PROCESSING). The cart's lifetime is the hold's authority: the hold TTL
   * (15 min) is shorter than the cart TTL (20 min, reaped on the next pass),
   * and a paid cart confirms its hold expired or not, so a hold whose cart
   * is still open must keep its slot or a second checkout can double-redeem
   * a cap of one in the gap. This is the cheap pre-check; `createHolds` is
   * the authority.
   */
  getRedemptionStats(
    params: PromoRedemptionStatsQuery,
  ): Promise<PromoRedemptionStats>;
  /**
   * Writes the holds AND enforces `maxRedemptions` / `maxRedemptionsPerHuman`
   * under a per-promo transaction-scoped advisory lock, throwing the same
   * `promo_max_redeemed` / `promo_redeemed_by_human` conflicts the use-case
   * pre-check throws. Idempotent on the hold's key: a retry gets its existing
   * row back without a re-check.
   *
   * ORDERING INVARIANT: call this AFTER the ticket-type capacity lock and
   * any Seat lock — i.e. as the last lock a checkout transaction takes.
   * Every caller (web checkout, free claim, both POS paths) does. Taking it
   * earlier than capacity on one path reintroduces a cycle.
   */
  createHolds(
    inputs: CreatePromoHoldInput[],
    params: CreatePromoHoldsParams,
  ): Promise<PromoHoldRecord[]>;
  releaseHoldsForOrder(orderId: string): Promise<void>;
  listHoldsForOrder(orderId: string): Promise<PromoHoldRecord[]>;
  confirmHoldsForOrder(
    params: ConfirmPromoHoldsInput,
  ): Promise<PromoRedemptionRecord[]>;
  listRedemptionsByOrderId(orderId: string): Promise<PromoRedemptionRecord[]>;

  // ── CRUD ─────────────────────────────────────────────────────────────────
  create(input: CreatePromoInput): Promise<PromoRecord>;
  update(input: UpdatePromoInput): Promise<PromoRecord>;
  getById(id: string): Promise<PromoRecord | null>;
  listByScope(input: ListPromosByScopeInput): Promise<ListPromosByScopeResult>;
  getByIdWithStats(id: string): Promise<PromoWithStats | null>;
}

export type {
  ConfirmPromoHoldsInput,
  PromoHoldRecord,
  PromoHoldSource,
  PromoKind,
  PromoRecord,
  PromoScope,
  PromoRedemptionRecord,
  PromoRedemptionStats,
  PromoRedemptionStatsInput,
  PromoWithStats,
  CreatePromoHoldInput,
  CreatePromoInput,
  FindActivePromosInput,
  ListPromosByScopeInput,
  ListPromosByScopeResult,
  UpdatePromoInput,
} from "@th/types";

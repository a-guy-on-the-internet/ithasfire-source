import type {
  ClaimRecord,
  CreateClaimInput,
  UpdateClaimStatusInput,
} from "@th/types/repos/claims";
import type { OffsetPaginatedResult } from "../pagination";

export interface ClaimsRepo {
  create(input: CreateClaimInput): Promise<ClaimRecord>;
  getById(id: string): Promise<ClaimRecord | null>;
  getByOrderItemId(orderItemId: string): Promise<ClaimRecord | null>;
  /**
   * Take the order item's claim TRANSACTION advisory lock
   * (`pg_advisory_xact_lock(hashtext('claim_order_item:' || orderItemId))`),
   * held until the surrounding transaction ends. MUST be called on the tx
   * client (`repos.tx()`) — outside one it is released at once and
   * serializes nothing.
   *
   * What it serializes: opening a resale claim (`createClaim`) against every
   * move of that item's ticket — `transferTicket`, `initiateEmailTransfer`,
   * `claimPendingTransfer` and `createResaleListing` (core helper
   * `ensureTicketNotUnderClaim`) — and every staff decision on the claim
   * (`reviewClaim`'s `transitionClaim`, for every target status), so two
   * concurrent decisions cannot both pass their status check. Both sides take this lock BEFORE reading
   * the claim row they decide on, so a move can never pass its "no
   * unresolved claim" check while a claim on the same item is being created
   * but not yet committed (write skew under READ COMMITTED; there is no
   * ticket `FOR UPDATE`). Take it before the transaction's first row write:
   * the advisory key lives in its own lock space, and taking it first keeps
   * it out of the order → ticket → listing → hold → items row-lock order.
   */
  lockOrderItem(orderItemId: string): Promise<void>;
  /**
   * Conditional status write: applies only while the row's status is still
   * `input.fromStatus`. Returns null — and writes nothing — when it is not
   * (another transition got there first), so a decision is never
   * overwritten. Callers also hold `lockOrderItem`; this is the backstop.
   */
  updateStatus(
    id: string,
    input: UpdateClaimStatusInput,
  ): Promise<ClaimRecord | null>;

  listByEvent(input: {
    eventId: string;
    status?: string[];
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<ClaimRecord>>;

  /** `orderId` narrows to one of the buyer's orders (the order page). */
  listByClaimant(
    humanId: string,
    input: { orderId?: string; limit?: number; offset?: number },
  ): Promise<OffsetPaginatedResult<ClaimRecord>>;

  /** List claims filed against a seller (respondent). For the seller's claims dashboard. */
  listByRespondent(
    humanId: string,
    input: { status?: string[]; limit?: number; offset?: number },
  ): Promise<OffsetPaginatedResult<ClaimRecord>>;

  /** List all claims across events with optional status filter. For platform support staff. */
  listAll(input: {
    status?: string[];
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<ClaimRecord>>;

  hasOpenClaims(orderId: string): Promise<boolean>;

  /**
   * Bulk check: given a list of settlement IDs, return the subset that have
   * open claims on any linked order (via settlement_lines → order_item_settlement_lines → order_items → claims).
   * Used by the payout batch runner to skip payee groups with unresolved disputes.
   */
  settlementIdsWithOpenClaims(settlementIds: string[]): Promise<Set<string>>;

  /**
   * Bulk read: the subset of `orderIds` whose order is REFUNDED. Backs a
   * claim's `refundConfirmed` (an approved claim's refund has landed) in one
   * query per page.
   */
  refundedOrderIds(orderIds: string[]): Promise<Set<string>>;

  /**
   * Record a seller's response/evidence to a claim. Support will see both
   * sides. Applies only while the claim is still undecided (`open` /
   * `under_review`); returns null and writes nothing once it is decided, so
   * a reply racing a decision never lands on a resolved claim.
   */
  recordSellerResponse(
    claimId: string,
    payload: { sellerEvidence: unknown; respondedAt: Date },
  ): Promise<ClaimRecord | null>;
}

export type {
  ClaimRecord,
  ClaimStatus,
  ClaimKind,
  ClaimResolution,
  CreateClaimInput,
  UpdateClaimStatusInput,
} from "@th/types/repos/claims";

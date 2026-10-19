import type {
  CompletedResalePrice,
  CreateExternalListingInput,
  CreateResaleListingInput,
  EnrichedResaleListingRecord,
  ResaleListingCommitResult,
  ResaleListingHoldResult,
  ResaleListingRecord,
  ResaleListingStatus,
  SellerResaleListingRecord,
} from "@th/types/repos/resale-listings";
import type { OrderStatus } from "@th/types/repos/orders";
import type { OffsetPaginatedResult } from "../pagination";

/** One listing hold, as the stale-hold sweep reads it. */
export type ResaleListingHoldRef = {
  listingId: string;
  buyerHumanId: string;
  heldUntil: Date;
};

/**
 * What `releaseHold` did. `released: false` = nothing of this hold's was
 * left to release (the listing is not HELD, or holds a newer hold). On a
 * release, the listing goes back on sale only if it can still be sold:
 *
 * - `CANCELLED` / `ticket_not_listed`: the ticket is no longer LISTED (a
 *   refund voided it) or the seller's original item was refunded. The
 *   ticket is left as it is.
 * - `CANCELLED` / `event_cancelled`: the event is CANCELLED (a listing held
 *   before `cancelOpenForEvent` existed). Ticket LISTED → VALID, as
 *   `cancelOpenForEvent` does.
 * - `EXPIRED` / `listing_expired`: `expiresAt` has passed. Ticket
 *   LISTED → VALID, as `expireStale` does.
 * - `ACTIVE`: back on sale.
 */
export type ResaleListingReleaseResult =
  | { released: false }
  | { released: true; listingStatus: "ACTIVE" }
  | {
      released: true;
      listingStatus: "CANCELLED";
      reason: "ticket_not_listed" | "original_item_refunded" | "event_cancelled";
    }
  | { released: true; listingStatus: "EXPIRED"; reason: "listing_expired" };

/** One of the buyer's orders for a listing, as the stale-hold sweep reads it. */
export type ResaleListingHoldOrder = {
  id: string;
  status: OrderStatus;
  /**
   * `meta.holdExpiresAt` of the order's item for this listing: the
   * `heldUntil` of the hold this order took. Null when absent or not a string.
   */
  holdExpiresAt: string | null;
};

export interface ResaleListingsRepo {
  // ── Existing: hold / commit / cancel ──
  /**
   * CAS ACTIVE → HELD, then writes the hold row. `ok: false` when the listing
   * is not ACTIVE (held, sold, cancelled, expired) or still carries a hold
   * row. Run it inside a transaction that rolls back on `ok: false`: the
   * flip may already have been applied when a leftover hold row refuses.
   */
  hold(
    listingId: string,
    buyerHumanId: string,
    heldUntil: Date,
  ): Promise<ResaleListingHoldResult>;
  commit(
    listingId: string,
    buyerHumanId: string,
    buyerOrderId: string,
  ): Promise<ResaleListingCommitResult>;
  /**
   * HELD → ACTIVE as a compare-and-swap, then drops the hold row. Throws
   * `{ code: "conflict", message: "resale_listing_cancel_hold_mismatch" }`
   * and writes nothing when the listing is missing or not HELD: it never
   * puts a SOLD / CANCELLED / EXPIRED listing back on sale.
   *
   * No production caller (`releaseHold` is the fenced release).
   */
  cancelHold(listingId: string): Promise<void>;
  /**
   * HELD → CANCELLED for one listing, as a compare-and-swap, then drops its
   * hold row. `closed: false` (nothing written) when the listing is not
   * HELD. Returns the hold it dropped, so the caller can say whose checkout
   * it ended.
   *
   * For the resale refund unwind only: the seller of this listing is being
   * refunded for the purchase that gave them the ticket, so the ticket is
   * leaving them and the listing cannot be honoured. The CALLER must already
   * hold the ticket row lock (`tickets.getByIdForUpdate`): `commit`,
   * `lockHold`, `releaseHold` and `cancelOpenForEvent` all take the ticket
   * first, so under that lock a HELD listing can only stay HELD. The
   * checkout's finalize then meets a CANCELLED listing and `commit` throws
   * `resale_listing_not_sellable`; it can never sell the ticket.
   *
   * Listing row, then hold row, the order every hold writer uses. No order
   * item is touched: the only item naming this listing is the in-flight
   * buyer's, and that pointer is how their order is found afterwards.
   */
  closeHeld(listingId: string): Promise<{
    closed: boolean;
    hold: { buyerHumanId: string; heldUntil: Date } | null;
  }>;
  /**
   * True when the listing is still HELD by exactly this hold (`buyerHumanId`
   * AND `heldUntil`, compared to the millisecond). Takes the listing row lock
   * for the rest of the caller's transaction, so a racing
   * `cancelOpenForEvent` either committed first (this returns false) or
   * blocks until the caller commits.
   *
   * No production caller: `createResaleCheckout`'s link used it until it
   * moved to `lockHold` (which also locks the ticket it re-reads).
   */
  assertHeldBy(
    listingId: string,
    hold: { buyerHumanId: string; heldUntil: Date },
  ): Promise<boolean>;
  /**
   * Release ONE specific hold: deletes the hold row only if it still matches
   * `buyerHumanId` AND `heldUntil`, and only then moves the listing out of
   * HELD, to ACTIVE only if it can still be sold (see
   * `ResaleListingReleaseResult` for the rules). A newer hold (another
   * buyer, or the same buyer's later attempt) never matches, so a stale
   * release cannot free it.
   *
   * Lock order: ticket row, then listing row, then the hold row: the order
   * `commit`, `cancelOpenForEvent` and the refund reconcile take. `now`
   * decides `expiresAt` (default: the wall clock).
   */
  releaseHold(
    listingId: string,
    hold: { buyerHumanId: string; heldUntil: Date },
    opts?: { now?: Date },
  ): Promise<ResaleListingReleaseResult>;
  /**
   * `assertHeldBy` with the ticket row locked first: ticket row, then
   * listing row, the order `releaseHold` takes. For a caller that must hold
   * both locks BEFORE it decides (the stale-hold sweep, before it releases;
   * `createResaleCheckout`'s link, after `orders.linkPaymentIntentIfPending`,
   * before it re-reads the ticket and the seller's item). Taking only the
   * listing row there would invert against `cancelOpenForEvent` (tickets,
   * then listings) once the ticket is touched.
   */
  lockHold(
    listingId: string,
    hold: { buyerHumanId: string; heldUntil: Date },
  ): Promise<boolean>;
  /**
   * Holds whose `heldUntil` is before `heldBefore` on listings still HELD,
   * in (`heldUntil`, `listingId`) order, starting strictly after `after`
   * when given (a keyset cursor, so holds the sweep keeps cannot starve the
   * rest). Read with no lock: the sweep re-checks each one under the locks
   * (`lockHold`) before acting on it.
   */
  listExpiredHolds(input: {
    heldBefore: Date;
    limit: number;
    after?: { heldUntil: Date; listingId: string } | null;
  }): Promise<ResaleListingHoldRef[]>;
  /**
   * HELD listings with no hold row. No writer leaves this state (every hold
   * removal flips the listing in the same transaction), and the fenced
   * `releaseHold` cannot free one, so the sweep reports them for a person.
   */
  listHeldWithoutHold(limit: number): Promise<string[]>;
  /**
   * Every order of `buyerHumanId` with an item for this listing (the
   * `resaleListingId` column or `meta.resaleListingId`), with its status and
   * the hold expiry its item recorded. The stale-hold sweep calls it after
   * `lockHold`, so no finalize can move the listing in between.
   */
  listOrdersForHold(
    listingId: string,
    buyerHumanId: string,
  ): Promise<ResaleListingHoldOrder[]>;
  /**
   * Undo a sale: SOLD → `nextStatus` for the listing sold to `buyerOrderId`,
   * as a compare-and-swap, clearing `buyerOrderId`. Throws
   * `{ code: "conflict", message: "resale_sale_unwind_mismatch" }` when no
   * such SOLD row matches.
   *
   * PRECONDITION for `nextStatus: "ACTIVE"`: the ticket has no OTHER live
   * (ACTIVE / HELD) listing. This and `cancelHold` are the only writes that
   * take a listing from a past status back to a live one, and a second live
   * row violates the one-live-listing-per-ticket index (a P2002 naming
   * "Listing_ticketId_live_key", not relabelled here), failing the caller's
   * refund transaction.
   *
   * The CALLER makes it hold. A ticket bought on resale can be listed again
   * (owner ruling 2026-10-11), so the buyer being refunded may have a live
   * listing of their own on it. `unwindResaleOrderAfterRefund`, the one
   * caller, closes that listing first: `cancel` for an ACTIVE one, then the
   * sale may come back to ACTIVE; `closeHeld` for a HELD one, and then it
   * only ever passes `"CANCELLED"` here. When the ticket was sold on it does
   * not call this at all and the sale stays SOLD. `nextStatus: "CANCELLED"`
   * needs no live slot and has no such precondition.
   */
  unwindSale(
    listingId: string,
    buyerOrderId: string,
    nextStatus: "ACTIVE" | "CANCELLED",
  ): Promise<void>;

  // ── CRUD ──
  /**
   * Inserts a new ACTIVE listing row; a ticket's past listings are kept, never
   * reused. Throws `{ code: "conflict", message: "resale_listing_live_exists" }`
   * when the ticket already has a live (ACTIVE / HELD) listing, which is what
   * the loser of two racing creates gets. `createExternal` throws the same.
   */
  create(input: CreateResaleListingInput): Promise<ResaleListingRecord>;
  /**
   * ACTIVE → CANCELLED for this seller's listing, as a compare-and-swap.
   * Returns `true` when the row flipped; `false` when the listing was not
   * ACTIVE any more (a buyer's `hold` got there first, or it is already
   * closed) or is not this seller's. Callers MUST branch on it before they
   * touch the ticket: treating a lost CAS as a cancel puts a ticket back to
   * VALID under a HELD listing, and the buyer's paid finalize then fails.
   */
  cancel(listingId: string, sellerHumanId: string): Promise<boolean>;
  getById(id: string): Promise<ResaleListingRecord | null>;
  /**
   * The ticket's CURRENT listing. A ticket keeps one row per listing it ever
   * had, and at most one of them is live (ACTIVE or HELD; a partial unique
   * index enforces it). Returns the live listing when there is one, otherwise
   * the most recently created past listing (SOLD / CANCELLED / EXPIRED), or
   * `null` for a ticket that was never listed.
   *
   * So a non-live result means "nothing is on sale for this ticket now", not
   * "this is the ticket's only listing". Read a specific past listing with
   * `getById`.
   */
  getByTicketId(ticketId: string): Promise<ResaleListingRecord | null>;

  // ── Queries ──
  listByEvent(input: {
    eventId: string;
    status?: ResaleListingStatus[];
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<ResaleListingRecord>>;

  /**
   * Browse listings for an event with ticket-type, seat, and section context.
   * Joins through Ticket → TicketType and Ticket → Seat → SeatSection.
   * Supports optional section filtering.
   */
  listByEventEnriched(input: {
    eventId: string;
    status?: ResaleListingStatus[];
    sectionId?: string;
    /**
     * Only listings priced under the event share (`eventShareCents` set).
     * A listing without one was priced under the removed markup split and
     * cannot be bought (organiser-resale-share FR-014/FR-015).
     */
    onlyWithShare?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<EnrichedResaleListingRecord>>;

  listBySeller(input: {
    sellerHumanId: string;
    status?: ResaleListingStatus[];
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<SellerResaleListingRecord>>;

  // ── Batch ops ──
  expireStale(now: Date): Promise<{ expiredCount: number }>;

  /**
   * Cancel every OPEN (ACTIVE | HELD) listing of an event. Used by
   * `cancelEvent` inside its transaction so a listing over a now-refunded
   * ticket can never be bought (money audit 2026-09-08 #22).
   *
   * Idempotent: only rows still ACTIVE/HELD flip; a replay finds none. Also
   * releases the HELD rows' holds, resets the listings' tickets LISTED →
   * VALID (the `expireStale` bookkeeping — keeps "LISTED ⇔ open listing"
   * true for orders whose refund FAILED, so they stay refundable by the
   * normal path) and clears the order items' `resaleListingId` pointer.
   *
   * Lock order: tickets BEFORE listings, matching `commit`, so a resale
   * finalize racing this call blocks rather than deadlocks.
   */
  cancelOpenForEvent(eventId: string): Promise<{ cancelledListingIds: string[] }>;

  /**
   * Live (ACTIVE | HELD) listings with no event share (`eventShareCents`
   * NULL): listings priced under the markup split, before the organiser's
   * resale share existed (organiser-resale-share FR-015). Oldest first, by
   * id after `afterId` (keyset), at most `limit` rows. Unlocked: the caller
   * re-checks each row under its own compare-and-swap.
   */
  listLiveWithoutShare(input: {
    limit: number;
    afterId?: string | null;
  }): Promise<ResaleListingRecord[]>;

  /**
   * Fetch completed (SOLD) resale transaction prices for a given event +
   * ticket type within a rolling day window. Used by the resale price
   * snapshot computation to switch from heuristic to data-backed pricing.
   */
  getCompletedResalePrices(
    eventId: string,
    ticketTypeId: string,
    dayWindow: number,
  ): Promise<CompletedResalePrice[]>;

  // ── External inventory ──
  createExternal(
    input: CreateExternalListingInput,
  ): Promise<ResaleListingRecord>;
}

export type {
  CompletedResalePrice,
  CreateExternalListingInput,
  CreateResaleListingInput,
  EnrichedResaleListingRecord,
  ResaleListingCommitResult,
  ResaleListingHoldResult,
  ResaleListingRecord,
  ResaleListingStatus,
  SellerResaleListingRecord,
} from "@th/types/repos/resale-listings";

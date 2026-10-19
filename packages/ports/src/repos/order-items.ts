import type {
  OrderItemRecord,
  OrderItemStatus,
  ResaleClauseFillInput,
} from "@th/types/repos/orders";

export interface OrderItemsRepo {
  /**
   * FR-004 (organiser-resale-share spec): write a ticket's resale clause
   * record onto its purchase item ONCE, for a ticket sold before the record
   * existed (or while the event's clause was unset). A conditional write,
   * `... WHERE "resaleClauseType" IS NULL`: it lands only on an item that
   * records no clause, and never overwrites one.
   *
   * Returns `true` when this call wrote the record, `false` when the item
   * already had a clause (or does not exist). Two racing fills on one item
   * serialise on its row lock; under READ COMMITTED the second re-checks the
   * predicate after the first commits, matches nothing and returns `false`,
   * and its caller re-reads the item to use the record that won. Run it
   * inside the transaction that uses the record, so a refused listing rolls
   * the fill back with it.
   */
  fillResaleClauseIfUnset(
    itemId: string,
    record: ResaleClauseFillInput,
  ): Promise<boolean>;

  /**
   * Stamp `paidOutAt` (funds transferred to the payee) on the given items —
   * ONCE, ever: items already stamped are skipped, so the payout batch's
   * crash-heal replays cannot restamp history to the replay date. The stamp
   * gates refund behaviour (paid-out items get a Stripe transfer reversal;
   * unstamped ones don't) and blocks self-serve refunds after payout.
   */
  markItemsPaidOut(itemIds: string[], paidOutAt: Date): Promise<void>;

  /**
   * Write an order item's `resaleListingId`, unconditionally.
   *
   * The column has two meanings, by the item's order: on a RESALE order's
   * item it is the listing the item was BOUGHT THROUGH (written once, at
   * checkout, never rewritten, and never cleared while that sale stands:
   * the adapter's bulk clears null it only when that listing closes without
   * the sale, and `meta.resaleListingId` still names it); on any other item
   * it is the listing the
   * ticket is on sale through NOW. Use cases do not call this directly:
   * they go through `setListedNowPointer`
   * (core `use-cases/_helpers/order-item-listing-pointer.ts`), which skips a
   * RESALE item.
   */
  setResaleListingId(
    itemId: string,
    resaleListingId: string | null,
  ): Promise<void>;

  /**
   * Update an order item's status (e.g., "active" → "refunded" or "transferred").
   *
   * `refundedTaxCents` is the tax portion of the refund ACTUALLY ISSUED for
   * this item, and is only meaningful with `status: "refunded"`. Pass it from
   * the same computation that produced the refund cents (see
   * `packages/core/src/lib/orders/refund-tax-share.ts`) — never a re-derived
   * or idealised share. Omit it when the caller genuinely has no attribution;
   * the column then stays NULL, which reads as "not attributed" rather than
   * as a measured zero. Any non-refunded status clears it.
   *
   * `refundedPlatformFeeCents` is its sibling for the PLATFORM-FEE portion of
   * the refund actually issued for this item — the share of
   * `Order.feesPlatformCents` the platform gave back (buyer-funded in
   * PASS_THROUGH, absorbed out of the organiser's basis in ABSORB; the same
   * cents either way). Same rules: pass it from the computation that produced
   * the refund (`_shared/refund-platform-fee-share.ts`), omit it when there is
   * no attribution so the column stays NULL, and any non-refunded status
   * clears it. NULL is never a zero here — the P&L consumer withholds a net
   * below full coverage (docs/decisions/absorb-refund-returns-platform-fee.md).
   */
  updateStatus(
    itemId: string,
    status: OrderItemStatus,
    timestamp: Date,
    refundedTaxCents?: number | null,
    refundedPlatformFeeCents?: number | null,
    options?: {
      /**
       * OPT-IN compare-and-swap: write only if the row is STILL in this
       * status. Returns `false` when it is not, and writes nothing.
       *
       * Why it is opt-in rather than the default (money audit 2026-09-08 #19).
       * The flip to `transferred` is decided by a read — the quote/classify
       * step that said the item was `active` — and applied by this write, with
       * nothing holding the row in between under READ COMMITTED. A gift
       * landing between a refund's quote and its commit used to leave both
       * "successful", last write winning. The two TRANSFER paths
       * (`transferTicket`, `claimPendingTransfer`) therefore pass
       * `expectedStatus: "active"` and refuse when they lose.
       *
       * Every other caller passes nothing and keeps the unconditional write
       * byte for byte — deliberately. The REFUND paths have already moved
       * money at Stripe by the time they reach here, so `refunded` is the
       * truth of the row whatever raced them; they must not be able to fail
       * late. They notice the race and report it instead (see
       * `reportConcurrentlyMovedItems`). Making this a CAS for everyone would
       * turn a reportable anomaly into a refund that throws after the buyer
       * has been paid back.
       */
      expectedStatus?: OrderItemStatus;
    },
  ): Promise<boolean>;

  /**
   * Bulk-update the status of multiple order items in a single query.
   * Used by refund flows to avoid sequential per-item updates.
   */
  bulkUpdateStatus(
    itemIds: string[],
    status: OrderItemStatus,
    timestamp: Date,
  ): Promise<void>;

  /**
   * Remember which reserved seat an item's ticket occupied, stamped into the
   * item's `meta.releasedSeatId` — called by `releaseSeatsForVoidedTickets`
   * IMMEDIATELY BEFORE that ticket's `seatId` is cleared.
   *
   * Why it exists: `Ticket.seatId` is `@unique`, so a voided ticket has to let
   * go of the link or the next buyer's mint fails with P2002 after their card
   * is charged. Clearing it is therefore non-negotiable — and it erases the
   * only record of which seat the order sold. The org order-detail view reads
   * this back so a refunded line still says "C8" rather than nothing.
   *
   * A merge, not a replace: every other key on the item's meta survives.
   * Existing entries are overwritten (a seat re-released after a resale unwind
   * is the same item's newer truth). No-op on an empty list.
   */
  recordReleasedSeats(
    entries: ReadonlyArray<{ orderItemId: string; seatId: string }>,
  ): Promise<void>;

  /**
   * List order items for an order.
   */
  listByOrderId(orderId: string): Promise<OrderItemRecord[]>;

  /**
   * Get a single order item by ID.
   */
  getById(itemId: string): Promise<OrderItemRecord | null>;
}

export type {
  OrderItemRecord,
  OrderItemStatus,
  ResaleClauseFillInput,
} from "@th/types/repos/orders";

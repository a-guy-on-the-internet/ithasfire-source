import type {
  CreateTicketInput,
  CreateTicketTypeInput,
  ListAllTicketsInput,
  ListAllTicketsResult,
  MarkScannedResult,
  RecordTicketScanInput,
  TicketDetailRecord,
  TicketRecord,
  TicketScanOutcome,
  TicketScanRecord,
  TicketStatus,
  TicketTransferRecord,
  TicketTypeRecord,
  TicketTypeStatus,
  UpdateTicketTypeInput,
  BulkMigrateTicketsInput,
  BulkMigrateTicketsResult,
  EventStatus,
  OrderStatus,
} from "@th/types";

export interface ListUpcomingHeldEventsInput {
  humanId: string;
  /** An event counts while it has not ended: `Event.endsAt > now`. */
  now: Date;
  /** Only events in these statuses (the next-night read passes PUBLISHED). */
  eventStatuses: readonly EventStatus[];
  /** Only tickets on orders in these statuses. Ticketless-order rows never count. */
  orderStatuses: readonly OrderStatus[];
  /** At most this many events; the caller keeps it to a handful. */
  limit: number;
}

export interface UpcomingHeldEventRow {
  eventId: string;
  startsAt: Date;
  /** The human's ACTIVE tickets for the event, on orders in `orderStatuses`. */
  ticketCount: number;
  /**
   * The most recent (by `Order.occurredAt`, then id) of those orders that
   * `humanId` BOUGHT — the only kind `getMyOrder` opens for them. Null when
   * every held ticket came in by transfer on someone else's order.
   */
  latestOwnOrderId: string | null;
}

/**
 * Capacity accounting for ONE ticket type, as returned by the lock-free batch
 * read {@link TicketsRepo.countCapacityUsageForTicketTypes}. Same two numbers,
 * same meanings, as `lockAndCountCapacityForTicketType` — deliberately, so the
 * public "sold out?" badge and the pre-charge gate cannot drift into two
 * different definitions of "available".
 */
export type TicketTypeCapacityUsage = {
  ticketTypeId: string;
  /**
   * Tickets of this type whose status is in
   * `CAPACITY_CONSUMING_TICKET_STATUSES` (VALID | SCANNED | LISTED). A refund
   * or revocation lowers it and frees the place; a lower count can never
   * oversell.
   */
  issued: number;
  /**
   * Qty on ticket lines of PENDING PRIMARY orders placed at or after
   * `heldSince` (`Order.occurredAt >= heldSince`). Money in flight; evaporates
   * on its own.
   */
  held: number;
};

export interface TicketsRepo {
  create(input: CreateTicketInput): Promise<TicketRecord>;
  listByOrderId(orderId: string): Promise<TicketRecord[]>;
  getByOrderItemId(orderItemId: string): Promise<TicketRecord | null>;
  /**
   * Batch-fetch tickets by their order item IDs.
   * Returns records only for IDs that have a ticket; missing items are omitted.
   */
  listByOrderItemIds(orderItemIds: string[]): Promise<TicketRecord[]>;
  /**
   * Tickets that OCCUPY the given seats — i.e. only those whose status still
   * owns the seat (`SEAT_OWNING_TICKET_STATUSES`: VALID | SCANNED | LISTED).
   *
   * Terminal rows (REFUNDED, INVALID) are deliberately NOT returned, and an
   * unfiltered read of them is what made a refunded seat permanently
   * unsellable.
   *
   * They do NOT keep their `seatId`: every path that voids a ticket clears the
   * link (`clearSeatAssignments`), because `Ticket.seatId` is `@unique` and a
   * dead row holding it fails the next buyer's mint after they are charged.
   * The seat a refunded line sold is preserved on the ORDER ITEM instead
   * (`meta.releasedSeatId`, see `OrderItemsRepo.recordReleasedSeats`) — that
   * is where seat history lives now, not here.
   *
   * A terminal row that still has a `seatId` is therefore pre-fix history or a
   * hand/backfill artefact. The filter still stands: it is what stops such a
   * row re-locking the seat. For the unfiltered read see
   * {@link TicketsRepo.findBySeatIdsIncludingTerminal} — do not drop this
   * filter to get it.
   */
  findBySeatIds(seatIds: string[]): Promise<TicketRecord[]>;
  /**
   * EVERY ticket row linked to these seats, terminal ones included — the "who
   * has ever sat here" read that {@link TicketsRepo.findBySeatIds} refuses to
   * be.
   *
   * This is NOT an occupancy question and must never be used as one: a
   * REFUNDED row here does not mean the seat is taken. It exists for exactly
   * one job — the pre-flight in `mintTickets`. `Ticket.seatId` is `@unique`,
   * so a dead row still pointing at a seat makes the next buyer's
   * `tickets.create` fail with P2002 AFTER their card is charged. Seeing the
   * dead row lets mint refuse deliberately, before the create.
   *
   * Callers must classify the rows themselves (`ticketOwnsSeat`); this method
   * deliberately hands back both kinds.
   */
  findBySeatIdsIncludingTerminal(seatIds: string[]): Promise<TicketRecord[]>;
  /**
   * Drop the seat link of tickets that have been VOIDED (refunded/cancelled),
   * so the seat can be sold again.
   *
   * `Ticket.seatId` is `@unique` (packages/db/prisma/ticket.prisma): while a
   * dead ticket still points at a seat, minting the NEXT buyer's ticket for it
   * fails with P2002 → `seat_taken` — after their card has been charged.
   * Freeing the `Seat` row without clearing this link only moves the failure
   * from checkout to mint.
   *
   * Call it ONLY for tickets voided in the same transaction; a live ticket
   * losing its seat silently un-seats a real attendee.
   */
  clearSeatAssignments(ticketIds: string[]): Promise<void>;
  markScanned(code: string, at: Date): Promise<MarkScannedResult>;
  getById(ticketId: string): Promise<TicketRecord | null>;
  /**
   * {@link getById} with the ticket row LOCKED (`FOR NO KEY UPDATE`) until
   * the surrounding transaction ends, and the record read AFTER the lock, so
   * status, owner and order are the committed truth. Call inside `repos.tx()`.
   *
   * For a caller that decides from the ticket and then writes it or its
   * resale listing (`revokeVolunteerReward`, `cancelResaleListing`). Lock
   * order is TICKET, THEN LISTING, the order `commit`, `lockHold`,
   * `releaseHold` and `cancelOpenForEvent` take; taking the listing first
   * inverts against them. `FOR NO KEY UPDATE` queues behind every other
   * UPDATE of the row but not behind an insert's foreign-key `FOR KEY SHARE`.
   */
  getByIdForUpdate(ticketId: string): Promise<TicketRecord | null>;
  getByCode(code: string): Promise<TicketRecord | null>;
  /**
   * Write a ticket's status by id.
   *
   * Without `expectedStatus` the write is unconditional and returns `true`.
   * With it, the write is a compare-and-swap: only a ticket STILL in
   * `expectedStatus` moves, and the return says whether it did (`false` =
   * the ticket was in some other status, or does not exist). Callers MUST
   * branch on it.
   *
   * Any write that moves an EXISTING ticket into a place-holding status
   * (VALID, SCANNED, LISTED) must pass `expectedStatus`. REFUNDED and INVALID
   * are terminal: they have given their capacity place back
   * (`CAPACITY_CONSUMING_TICKET_STATUSES`), so an unconditional write that
   * lands on one of them takes a place back without the capacity lock and
   * can oversell the tier (refunds-restock spec 2026-10-09).
   */
  setStatus(
    ticketId: string,
    status: TicketStatus,
    options?: { scannedAt?: Date | null; expectedStatus?: TicketStatus },
  ): Promise<boolean>;
  recordScan(input: RecordTicketScanInput): Promise<void>;
  /**
   * Track record for the invite send allowance (gated-event invite links,
   * owner ruling 2026-10-05, fix round 1): how many DISTINCT ticket holders
   * were door-scanned ACCEPTED at the owner's events (an org, or the human
   * who owns person-owned events), capped at `cap` (the query stops there,
   * so it never counts unbounded rows). Only scans that look like a real
   * door count:
   *   - the event ended before `endedBefore` (callers pass now - 24h);
   *   - `scannedAt >= startsAt - doorLeadSeconds` (no scanning a ticket days
   *     before the event to manufacture history);
   *   - not a POS auto-admit (`message` POS_AUTO_ADMIT / POS_CASH_AUTO_ADMIT):
   *     a cash sale is operator-asserted;
   *   - the holder is not the scanner (`ownerHumanId <> actorHumanId`);
   *   - the holder is not the owner human (person-owned) or a member of the
   *     owning org (OrgMember), so an organiser can't scan their own team;
   *   - the ticket is PAID (fix round 2): its order was a Stripe-charged WEB
   *     checkout (`paymentChannel = WEB`, a PaymentIntent) with
   *     `amountGrossCents > 0`, not a COMP, and SUCCEEDED or PART_REFUNDED.
   *     POS and cash sales, comps and $0 orders mint holders for free
   *     (a cash sale even creates a phantom Human), so they never count;
   *   - the ticket is not refunded or voided (status VALID, SCANNED, LISTED);
   *   - the holder has an auth account with a VERIFIED email.
   */
  countDistinctDoorScannedHolders(input: {
    owner: { orgId: string } | { humanId: string };
    endedBefore: Date;
    doorLeadSeconds: number;
    cap: number;
  }): Promise<number>;
  /**
   * Move a ticket's ownership — a guarded COMPARE-AND-SWAP, not a write.
   *
   * Returns `true` when the row moved (and a `TicketTransfer` row was written
   * beside it), `false` when nothing matched. Callers MUST branch on it.
   *
   * WHY IT IS A CAS (money audit 2026-09-08 #19). Transferability is decided
   * by a READ (`ensureTicketTransferable`, `claimPendingTransfer`) and applied
   * by this WRITE, with nothing holding the row in between under READ
   * COMMITTED. An unconditional `update` here meant a refund landing in that
   * window left both sides "successful": the sender was refunded AND the
   * recipient held a live pass, because last write won. The predicates below
   * are what make the loser refuse instead of overwrite.
   *
   * `fromHumanId` is ALWAYS part of the predicate — a ticket that has already
   * moved on does not move again. (It replaces an untyped `throw new
   * Error("not owner")` the resale unwind used to string-match on.)
   *
   * `expectedStatus` is OPT-IN, and deliberately not hardcoded to VALID:
   *   - `transferTicket` / `claimPendingTransfer` pass `"VALID"`, because
   *     that is exactly the condition they checked on the read. A ticket that
   *     went LISTED, SCANNED, REFUNDED or INVALID in the window must lose.
   *   - `unwindResaleOrderAfterRefund` passes NOTHING, on purpose: it hands a
   *     refunded resale ticket back to its seller and must do so whatever
   *     status the buyer left it in (a SCANNED ticket still goes home). Pinning
   *     VALID there would strand the seller's ticket with the refunded buyer.
   *
   * The transfer moves no money, so it is the side that can safely fail late;
   * the refund side, which has already called Stripe, is the side that wins.
   */
  transfer(input: {
    ticketId: string;
    fromHumanId: string;
    toHumanId: string;
    reason: "primary" | "resale" | "gift" | "admin";
    orderId?: string | null;
    /** When set, only a ticket STILL in this status moves. See above. */
    expectedStatus?: TicketStatus;
  }): Promise<boolean>;
  findTicketTypeByName(
    eventId: string,
    name: string,
  ): Promise<TicketTypeRecord | null>;
  createTicketType(input: CreateTicketTypeInput): Promise<TicketTypeRecord>;
  getTicketTypeById(id: string): Promise<TicketTypeRecord | null>;
  updateTicketType(input: UpdateTicketTypeInput): Promise<TicketTypeRecord>;
  deleteTicketType(id: string): Promise<void>;
  /**
   * EVERY Ticket row of this type, any status, refunded and revoked included.
   * A history count, not a capacity count: it answers "was a ticket of this
   * type ever issued?" for the `deleteTicketType` guard
   * (`TICKET_TYPE_HAS_SALES`), where a refunded ticket still has an order and
   * finance rows pointing at the type. For "how many places are taken" use
   * {@link countCapacityConsumingForTicketType}.
   */
  countIssuedForTicketType(ticketTypeId: string): Promise<number>;
  /**
   * Tickets of this type whose status is in
   * `CAPACITY_CONSUMING_TICKET_STATUSES` (VALID | SCANNED | LISTED): the
   * places they hold. REFUNDED and INVALID tickets have given theirs back.
   *
   * The same definition as `issued` in
   * {@link lockAndCountCapacityForTicketType} and
   * {@link countCapacityUsageForTicketTypes}, without the lock or `held`. Used
   * by the `mintTickets` last-resort backstop and the comp advisory check: if
   * either counted refunded rows, a place a refund freed would pass the
   * pre-charge gate and then be refused at mint after the card was charged.
   * Takes no lock; the pre-charge gate is the method that serialises sellers.
   */
  countCapacityConsumingForTicketType(ticketTypeId: string): Promise<number>;
  /**
   * Capacity accounting for a ticket type, serialised against concurrent
   * callers.
   *
   * Takes a TRANSACTION-SCOPED ADVISORY LOCK on the ticket type first, so two
   * sellers deciding "is there one left?" at the same instant queue behind
   * each other instead of both reading the same count and both saying yes. The
   * lock is held until the surrounding interactive transaction commits — so
   * this MUST be called inside `repos.tx()`, and the caller's insert must
   * happen in that same transaction or the serialisation is worthless.
   *
   * It is deliberately NOT `SELECT ... FOR UPDATE` on the TicketType row:
   * inserting an OrderItem or Ticket takes an implicit `FOR KEY SHARE` on that
   * same row, and web checkout locks Seats before inserting its items — the
   * opposite order to POS — so a row lock makes the two paths deadlock. The
   * advisory lock lives in a lock space FK key-share locks cannot reach.
   *
   * ORDERING INVARIANT: callers must take this BEFORE any Seat lock
   * (`seats.pickContiguousAvailable`). Both POS use cases do. Reversing it
   * reintroduces a cycle with web checkout.
   *
   * Returns two numbers that mean different things:
   *   - `issued` — tickets of the type whose status is in
   *                `CAPACITY_CONSUMING_TICKET_STATUSES` (VALID | SCANNED |
   *                LISTED). A refund or revocation lowers it, which frees the
   *                place for another buyer. That is safe only because
   *                REFUNDED and INVALID are TERMINAL: once a ticket gives its
   *                place back, no write may move it into a place-holding
   *                status again, or it would retake the place without this
   *                lock and oversell the tier. The writes that could are
   *                guarded to keep them terminal: `setStatus` with
   *                `expectedStatus` (cancel listing LISTED→VALID, create
   *                listing VALID→LISTED, revert scan SCANNED→VALID),
   *                `reassignForResale` (LISTED only), `restoreAfterResale`
   *                (place-holding only), `markScanned` (VALID only) and the
   *                resale-listings adapter's LISTED→VALID resets. A new
   *                write into VALID, SCANNED or LISTED must be guarded the
   *                same way.
   *   - `held`   — qty on ticket lines of PENDING orders created at or after
   *                `heldSince`. Reservations for money in flight.
   *
   * `held` is derived from the ORDER'S OWN AGE, not from a separate expiry
   * stamp, and that is load-bearing. A PENDING order's PaymentIntent stays
   * confirmable until `releaseExpiredCarts` cancels it; an independent hold
   * clock drifts against that job and reopens the window where a ticket is
   * resold while the first buyer's charge can still land. One clock, no drift.
   * Callers derive `heldSince` from the reaper's TTL plus its cron period —
   * see `assertPosCapacity`.
   *
   * Available capacity is `capacity - issued - held`. Counting only `issued`
   * (which is what `mintTickets` does, deliberately, as a last-resort
   * backstop) is what lets a card get charged for a ticket that no longer
   * exists by the time the webhook mints it.
   *
   * KNOWN GAPS — this is not yet the whole story of capacity:
   *   - Only the POS paths call it. Web checkout performs no pre-charge check
   *     and takes no lock, so a web buyer can still mint past a POS
   *     reservation. Same bug class, other direction, not yet closed. (POS now
   *     respects web carts automatically — they are PENDING orders like any
   *     other.)
   *   - `PROCESSING` orders (delayed-notification methods such as ACH) are not
   *     counted: no longer PENDING, not yet minted, so they reserve nothing
   *     for the days they may be in flight.
   * Do not read a passing check here as "capacity is safe" until both are
   * addressed.
   */
  lockAndCountCapacityForTicketType(input: {
    ticketTypeId: string;
    /**
     * Orders created strictly before this instant no longer reserve — they are
     * either already reaped or imminently reapable. Derived by the caller from
     * the expired-cart reaper's TTL plus its cron period; see
     * `CAPACITY_HELD_WINDOW_SECONDS`.
     */
    heldSince: Date;
    /**
     * Ignore this order's own ticket lines when summing `held`.
     *
     * The cart paths need it: an order being re-priced (`updateOrderItems`) or
     * converted to a charge (`createCheckout` with `pendingOrderId`) is already
     * holding the very stock it is asking for, and would otherwise be refused
     * by its own reservation.
     *
     * Only affects `held`; `issued` is never excluded, because a minted ticket
     * holds its place no matter which order produced it, until a refund or
     * revocation gives the place back for good.
     *
     * Callers MUST validate ownership (buyer + event + PENDING) before passing
     * an id — an unvalidated id would let a buyer discount someone else's hold
     * and oversell past it.
     */
    excludeOrderId?: string | null;
  }): Promise<{ issued: number; held: number }>;
  /**
   * LOCK-FREE, BATCHED capacity accounting for a set of ticket types — the
   * READ-side twin of `lockAndCountCapacityForTicketType`.
   *
   * WHY A SECOND METHOD EXISTS. The locking one is unusable on a public read
   * path for two independent reasons, and either alone is disqualifying:
   *
   *   1. It takes a per-ticket-type transaction-scoped ADVISORY lock. Every
   *      anonymous view of an event page would then queue behind (and hold up)
   *      live checkouts for that tier. A page view must never be able to slow a
   *      sale, and a sale must never wait on a page view.
   *   2. It answers for ONE ticket type. An event with six tiers would issue
   *      six lock-and-count round trips per page view — an N+1 on the hottest
   *      read in the product.
   *
   * So this one takes no lock and answers for all ids in one round trip. It is
   * a SNAPSHOT, and callers must treat it as one: it is display truth, never
   * enforcement truth. Enforcement stays with `assertTicketTypeCapacity` inside
   * `repos.tx()`, where the lock makes the count decisive. Reading this and
   * then writing based on it would be a textbook TOCTOU oversell.
   *
   * COUNTING RULES ARE IDENTICAL to the locking method — same
   * `CAPACITY_CONSUMING_TICKET_STATUSES` filter on `issued`, same PRIMARY-only
   * filter and `Order.occurredAt >= heldSince` window on `held`. That is the whole
   * point: a badge computed from a NARROWER basis than the gate would still
   * offer a tier checkout refuses. Read that method's doc block before touching
   * either; they must be changed together.
   *
   * There is no `excludeOrderId`: this surface has no order. A buyer with their
   * own cart open sees their own hold subtracted from the public number, which
   * is correct — those units are theirs only until the hold lapses, and the
   * cart itself is what shows them the quantity they hold.
   *
   * Returns exactly ONE entry per DISTINCT id passed in, zero-filled when the
   * type has no tickets and no holds (and when the id does not exist at all).
   * Callers therefore never have to distinguish "absent" from "zero". Empty
   * input returns an empty array without touching the database.
   */
  countCapacityUsageForTicketTypes(input: {
    ticketTypeIds: readonly string[];
    /**
     * Same cutoff, same meaning as {@link lockAndCountCapacityForTicketType}'s
     * `heldSince`: ticket lines on PENDING orders placed BEFORE this instant
     * are already reaped or imminently reapable and reserve nothing. Derive it
     * with `heldSinceFor(now)` so this public read and the pre-charge gate
     * cannot answer differently — a badge computed from a narrower basis than
     * the gate offers tickets checkout then refuses.
     */
    heldSince: Date;
  }): Promise<TicketTypeCapacityUsage[]>;
  /**
   * EVERY Ticket row of the event, any status, refunded and revoked included.
   * A history count, like {@link countIssuedForTicketType}: it answers "were
   * tickets ever issued for this event?" for the publish guard
   * (`TICKETS_ALREADY_ISSUED`). Not a capacity count. `migrateEventOrders`
   * also reads it as one, and so over-counts refunded rows on both events (a
   * known, out-of-scope gap in the refunds-restock spec, 2026-10-09).
   */
  countIssuedForEvent(eventId: string): Promise<number>;
  /**
   * People through the door per event: for each `eventId`, the number of
   * DISTINCT tickets with an admit outcome (`ADMIT_SCAN_OUTCOMES`, i.e.
   * `ACCEPTED`) in the append-only `TicketScan` log — people who actually
   * came in, NOT tickets sold (venue-track-record spec 2026-09-24, FR-009 /
   * R4 / R11).
   *
   * Events with ZERO scanned tickets are ABSENT from the map — never present
   * as 0. That absence is load-bearing: `recalculatePlaceStats` counts
   * `map.size` as `scannedEventCount` and averages only over those, so a
   * show nobody scanned at is excluded from the mean rather than dragging
   * it to zero. Callers wanting a number for every id do `map.get(id) ?? 0`
   * themselves.
   *
   * The basis is the LOG, not `Ticket.scannedAt` (R11 re-ruled 2026-09-25,
   * FU-005): every refund path (full, per-item, cash, Stripe reconcile,
   * mark-refunded) clears `scannedAt`, but the log does not forget, so a
   * ticket refunded after the door STILL counts. A REPLAY (the same ticket
   * scanned again) and a REJECTED scan are not admits; DISTINCT makes an
   * admit → revert → re-admit one person.
   *
   * Reverted admits do NOT count. `revertTicketScan` writes no log row — it
   * flips the ticket SCANNED → VALID — so an admit reads as reverted when
   * the ticket's status today is in `REVERTED_ADMIT_TICKET_STATUSES`
   * (VALID, LISTED) AND it has no `TicketTransfer` after the scan. The
   * transfer clause keeps the resale refund unwind (which returns an
   * ADMITTED buyer's ticket to its seller as VALID/LISTED) counted. Known
   * over-count: a reverted admit whose ticket is later refunded, invalidated
   * or transferred without a re-scan. Exact handling needs the revert to
   * write a log row (a new outcome) — not built.
   *
   * One `GROUP BY eventId` over `TicketScan(eventId, scannedAt)`, Ticket by
   * pkey; empty input returns an empty map without querying. Unknown ids are
   * simply absent.
   */
  countScannedByEvent(eventIds: string[]): Promise<Map<string, number>>;
  /**
   * EVERY Ticket row this order minted for the type, any status. `mintTickets`
   * reads it for idempotency, so it must keep counting refunded rows: a
   * replayed mint after a refund must find the tickets it already made and
   * mint nothing, not re-mint the refunded ones.
   */
  countForOrderTicketType(
    orderId: string,
    ticketTypeId: string,
  ): Promise<number>;
  /**
   * Whether a human currently owns at least one active ticket for the event.
   * The ownership FACT, for surfaces addressed to the buyer's inbox (the
   * ticket email, dispute evidence). A surface that grants holder-only
   * content to a SIGNED-IN viewer uses {@link viewerHoldsActiveTicketForEvent}.
   */
  hasActiveTicketForEvent(eventId: string, humanId: string): Promise<boolean>;
  /**
   * Holder access for a signed-in VIEWER: {@link hasActiveTicketForEvent}
   * AND the owner's email is verified (`AuthUser.emailVerified`). Guest
   * checkout, comps and door sales attach tickets BY EMAIL, so an account
   * that never proved its address can hold someone else's tickets (B2,
   * account squatting); those must not unlock the private address or the
   * banned-owner page for it. A shadow guest whose address is later proven
   * (email code / magic link) passes. No AuthUser → false.
   */
  viewerHoldsActiveTicketForEvent(
    eventId: string,
    viewerHumanId: string,
  ): Promise<boolean>;
  /**
   * {@link hasActiveTicketForEvent} for a batch: the subset of `eventIds` for
   * which `humanId` currently owns at least one ACTIVE ticket (VALID |
   * SCANNED | LISTED, the same set). One query; an empty `eventIds` returns
   * `[]` without querying. Backs the holder-address gate on list surfaces
   * (the my-tickets list), where a per-row read would be N queries.
   */
  listEventIdsWithActiveTicket(
    humanId: string,
    eventIds: readonly string[],
  ): Promise<string[]>;
  /**
   * The soonest not-yet-ended events `humanId` holds ACTIVE tickets for
   * (VALID | SCANNED | LISTED, the {@link hasActiveTicketForEvent} set), on
   * orders whose status is in `orderStatuses` — the same ticket ownership the
   * my-tickets list reads (`ownerHumanId`, so a ticket transferred away is
   * gone and one transferred in counts). Ordered by `(Event.startsAt,
   * Event.id)` ascending, at most `limit` events. Backs the navbar's
   * next-night read; one query, no per-event fan-out.
   */
  listUpcomingHeldEvents(
    input: ListUpcomingHeldEventsInput,
  ): Promise<UpcomingHeldEventRow[]>;
  /**
   * Distinct `ownerHumanId`s of every ACTIVE ticket (status VALID | SCANNED |
   * LISTED) for an event — the fan-out audience for the address-reveal
   * notification job. Same status set `hasActiveTicketForEvent` gates on.
   */
  activeTicketHolderHumanIds(eventId: string): Promise<string[]>;
  /**
   * Lightweight lookup of all tickets owned by a human for a specific event.
   *
   * Used by the unified scan resolver (FR-009b) to enrich a volunteer scan
   * result with "also holds a ticket" context. Returns minimal fields and
   * is read-only — callers should filter to the statuses they care about
   * (typically VALID + SCANNED) before deriving display state.
   *
   * Ordered most-recent-first by ticket creation time.
   */
  findByEventAndHuman(
    eventId: string,
    humanId: string,
  ): Promise<
    Array<{
      ticketId: string;
      ticketCode: string;
      status: TicketStatus;
      scannedAt: Date | null;
    }>
  >;
  /**
   * Distinct `orderId`s of orders that contain at least one ticket whose
   * `ownerHumanId` matches `humanId`. Used by the buyer-side My Tickets list
   * to surface orders the actor received tickets for via transfer (without
   * being the original buyer). `orderId IS NULL` is excluded.
   */
  listOrderIdsOwnedByHuman(humanId: string): Promise<string[]>;
  /** Cross-org paginated ticket search for platform staff */
  listAll(input: ListAllTicketsInput): Promise<ListAllTicketsResult>;
  /** Full ticket with relations for platform detail view */
  getByIdWithRelations(ticketId: string): Promise<TicketDetailRecord | null>;
  /** Transfer history for a ticket */
  listTransfers(ticketId: string): Promise<TicketTransferRecord[]>;
  /** Scan history for a ticket */
  listScans(ticketId: string): Promise<TicketScanRecord[]>;
  /**
   * Batched form for many tickets in ONE query (dispute evidence assembly:
   * an order's tickets → one scan log). Sorted `scannedAt ASC, id ASC` across
   * the whole set; empty input returns `[]` without querying.
   */
  listScansByTicketIds(ticketIds: string[]): Promise<TicketScanRecord[]>;
  /**
   * Atomically reassign a ticket for a completed resale purchase.
   *
   * Updates:
   *  - `orderId`      → the new resale order
   *  - `orderItemId`  → the new resale order item
   *  - `code`         → a fresh QR/scan code (invalidates the old one)
   *  - `status`       → VALID
   *
   * Only a ticket that is still LISTED moves: the one status a ticket under a
   * HELD listing has. A REFUNDED or INVALID ticket (refunded or revoked while
   * its listing stayed open) has given its capacity place back and must not
   * come back to VALID. THROWS `{ code: "conflict", message:
   * "resale_reassign_ticket_not_listed" }` when nothing matched, so the
   * finalize transaction rolls back and the paid resale order goes to manual
   * review instead of minting a place past capacity.
   *
   * Must be called inside the same transaction as the ownership transfer.
   */
  reassignForResale(input: {
    ticketId: string;
    newOrderId: string;
    newOrderItemId: string;
    newCode: string;
  }): Promise<void>;

  /**
   * Hand a refunded resale buyer's ticket back to its seller: repoint it at
   * the seller's order/item, rotate the code, and set it VALID with
   * `scannedAt` cleared.
   *
   * Only a ticket in a place-holding status (`CAPACITY_CONSUMING_TICKET_STATUSES`:
   * VALID, SCANNED, LISTED, whatever the buyer left it in) moves. Bringing a
   * REFUNDED or INVALID ticket back would take a capacity place without the
   * lock. The one caller, `unwindResaleOrderAfterRefund`, checks for a
   * terminal ticket first and closes the sale without calling this (it runs
   * after Stripe has refunded, so it must not throw there). THROWS `{ code:
   * "conflict", message: "resale_restore_ticket_terminal" }` when nothing
   * matched: the backstop for a ticket voided between that check and this
   * write.
   */
  restoreAfterResale(input: {
    ticketId: string;
    restoredOrderId: string | null;
    restoredOrderItemId: string | null;
    newCode: string;
  }): Promise<void>;

  /**
   * Activate all DRAFT ticket types for an event.
   * Called during event publish to transition ticket types from DRAFT → ACTIVE.
   * Returns the number of ticket types activated.
   */
  activateDraftTicketTypes(eventId: string): Promise<number>;

  /**
   * Bulk-migrate tickets from one event to another.
   * Updates eventId, optionally remaps ticketTypeId, and regenerates codes.
   * Used by the order migration use case.
   */
  bulkMigrateToEvent(
    input: BulkMigrateTicketsInput,
  ): Promise<BulkMigrateTicketsResult>;
}

export type {
  BulkMigrateTicketsInput,
  BulkMigrateTicketsResult,
  CreateTicketInput,
  CreateTicketTypeInput,
  ListAllTicketsInput,
  ListAllTicketsResult,
  ListPlatformTicketsItem,
  MarkScannedResult,
  RecordTicketScanInput,
  TicketDetailRecord,
  TicketRecord,
  TicketScanOutcome,
  TicketScanRecord,
  TicketStatus,
  TicketTransferRecord,
  TicketTypePricingMode,
  TicketTypeRecord,
  TicketTypeStatus,
  UpdateTicketTypeInput,
} from "@th/types";

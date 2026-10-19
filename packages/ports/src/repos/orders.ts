import type {
  BuyerOrderSummary,
  CountDistinctBuyersForOwnerInput,
  CreatePendingOrderInput,
  CreatePendingOrderResult,
  CreateOrderTaxLinesInput,
  OrderTaxLineRecord,
  ExpiredPendingOrderItem,
  FindOrderForOwnerInput,
  FindOrderForOwnerResult,
  SummarizeBuyerOrdersForOwnerInput,
  FindOrderByPaymentIntentResult,
  GetTaxNexusRollupInput,
  CashTillSummary,
  CashTillSaleRow,
  CashSaleListRow,
  CollectedTaxTotal,
  SummarizeCashTillForEventInput,
  ListCashSalesForEventInput,
  ListCashSalesForEventResult,
  ListAllOrdersInput,
  ListAllOrdersResult,
  ListEventCompOrdersInput,
  ListEventCompOrdersResult,
  ListExpiredPendingOrdersInput,
  ListOtherPendingInput,
  ListOrdersByBuyerInput,
  OrderKind,
  ListOrdersByBuyerEventLocation,
  ListOrdersByBuyerItem,
  ListOrdersByBuyerResult,
  ListOrdersForHumanOwnedEventsInput,
  ListOrdersForHumanOwnedEventsResult,
  ListOrdersForOrgInput,
  ListOrdersForOrgResult,
  ListPendingCartsInput,
  ListPendingCartsResult,
  OrderEventAttribution,
  OrderItemRecord,
  OrderRecord,
  OrderSource,
  OrderStatus,
  MarkOrderDisputeStatusInput,
  PaymentCardChecks,
  PendingCartItem,
  SearchEventAttendeesInput,
  SearchEventAttendeesResult,
  StalePendingOrderItem,
  TaxNexusRollupRow,
  TaxSplitTicketItem,
  UpdatePendingOrderItemsInput,
  BulkMigrateOrdersInput,
  BulkMigrateOrdersResult,
  ResaleOrderItemPayoutStatus,
  UpdateResaleOrderItemFinanceStateInput,
  ListOrdersMissingProcessorFeeInput,
  OrderMissingProcessorFee,
  RecordProcessorFeeReadFailureInput,
  StampProcessorFeeInput,
  CancelledEventOpenDoorCardSaleRow,
} from "@th/types/repos/orders";
import type { PayeeLedgerInvariantScan } from "@th/types/repos/payee-ledger";

/**
 * Value (not type) re-export: the adapter needs the actual status list to
 * build its where-clause, and the doc comment describing what "an order"
 * means for a buyer summary lives right next to it.
 */
export { COMPLETED_ORDER_STATUSES } from "@th/types/repos/orders";

export interface OrdersRepo {
  createPending(
    input: CreatePendingOrderInput,
  ): Promise<CreatePendingOrderResult>;
  /**
   * Persist the per-imposition tax breakdown of an order, in the order's create
   * transaction. The caller owns the invariant: Σ `amountCents` over PLATFORM
   * lines === the `taxAmountCents` it passed to `createPending` (both come from
   * one `solveTaxLinesAndProcessorFee` result). A no-op for an empty list.
   */
  createTaxLines(input: CreateOrderTaxLinesInput): Promise<void>;
  /** An order's tax lines, oldest first. Empty for orders that predate them. */
  listTaxLines(orderId: string): Promise<OrderTaxLineRecord[]>;
  /**
   * Tax lines for many orders in ONE query, keyed by order id (each list
   * oldest first, like `listTaxLines`). Orders with no lines are absent from
   * the map. Empty input returns an empty map without a query. For loops over
   * many orders (event cancellation) — never call `listTaxLines` per order.
   */
  listTaxLinesByOrderIds(
    orderIds: string[],
  ): Promise<Map<string, OrderTaxLineRecord[]>>;
  getById(orderId: string): Promise<OrderRecord | null>;
  /**
   * `Order.kind` for the given ids, as a map. Orders that do not exist are
   * absent from the map.
   *
   * Exists for the payout batch: post-cutover it classifies a payout's
   * revenue (membership vs ticketing) from the orders behind the consumed
   * SETTLEMENT_CREDIT entries, replacing the settlement-line join
   * (`settlementLines.settlementIdsWithOrderKinds`) that the ledger model
   * deleted. One batched query for the whole run — never per-order.
   */
  getKindsByIds(orderIds: string[]): Promise<Map<string, OrderKind>>;
  /**
   * Re-price a cart: replace its amounts, `feePolicySnapshot` and items, as
   * a compare-and-set in one transaction. Writes only while the order is
   * still an unclaimed cart: status PENDING, no `stripePaymentIntentId`, no
   * `termsAcceptedAt` (the state `updateOrderItems` accepts). Returns `null`
   * and writes nothing when the order is missing or has moved on since the
   * caller read it (finalize, checkout or expiry won the race).
   */
  updatePendingItems(
    input: UpdatePendingOrderItemsInput,
  ): Promise<OrderRecord | null>;
  listForOrg(input: ListOrdersForOrgInput): Promise<ListOrdersForOrgResult>;
  listForHumanOwnedEvents(
    input: ListOrdersForHumanOwnedEventsInput,
  ): Promise<ListOrdersForHumanOwnedEventsResult>;
  listByBuyer(input: ListOrdersByBuyerInput): Promise<ListOrdersByBuyerResult>;
  /**
   * Owner-scoped lookup of ONE order by exact id and/or its 8-hex tail
   * (`idSuffix`). The tail is NOT unique, so an ambiguous match returns `null`
   * rather than guessing.
   *
   * The owner scope is part of the same where-clause as the identifier, so a
   * foreign org's order id is indistinguishable from a nonexistent one: both
   * return `null`. Returns `null` without querying when no identifier is given.
   */
  findForOwner(
    input: FindOrderForOwnerInput,
  ): Promise<FindOrderForOwnerResult | null>;
  /**
   * Number of DISTINCT buyers behind the owner's orders matching `searchQuery`
   * — the true total for a deduped attendee list (`listForOrg().total` counts
   * orders, not buyers).
   */
  countDistinctBuyersForOwner(
    input: CountDistinctBuyersForOwnerInput,
  ): Promise<number>;
  /**
   * Per-buyer order count + most recent order date within the owner scope, for
   * a bounded set of buyers. Buyers with no orders in scope are omitted.
   */
  summarizeBuyerOrdersForOwner(
    input: SummarizeBuyerOrdersForOwnerInput,
  ): Promise<BuyerOrderSummary[]>;
  /** Search ticket buyers for a specific event by name or email */
  searchEventAttendees(
    input: SearchEventAttendeesInput,
  ): Promise<SearchEventAttendeesResult>;
  /**
   * Comps ledger for ONE event: `source = "COMP"` ordered `occurredAt desc`.
   *
   * Rides the existing `Order_eventId_occurredAt_idx` — `source` is filtered
   * in-heap, which is the right trade at tens of comps per event. Do NOT add an
   * index for this (see the 20260730120000_order_comp_provenance migration).
   *
   * Returns provenance RAW: `issuedByHumanId` unresolved, and
   * `hasVolunteerRewardGrant` rather than a derived origin. Deriving "this comp
   * came from a reward trigger" is a domain rule and belongs in the use case;
   * hydrating the issuer's display name is a separate `humans.getByIds` call
   * because `compIssuedByHumanId` deliberately carries no FK.
   *
   * NOT status-filtered: a revoked reward leaves a CANCELLED comp that the
   * ledger still has to show.
   *
   * TENANT SCOPE: takes `eventId` ALONE, with no owner predicate — unlike
   * `searchEventAttendees`, whose where-clause carries `event: { orgId }` as a
   * backstop. The single caller (`listCompOrders`) derives the org from the
   * event row itself and authorizes against THAT, so there is no client-supplied
   * scope to disagree with and no IDOR. A second caller that authorizes some
   * other way inherits NO defence in depth from this method — scope it yourself
   * or add an owner predicate here.
   */
  listEventCompOrders(
    input: ListEventCompOrdersInput,
  ): Promise<ListEventCompOrdersResult>;
  /** List pending cart orders with active holds for cart recovery */
  listPendingCarts(
    input: ListPendingCartsInput,
  ): Promise<ListPendingCartsResult>;
  /**
   * Cancel a pending order (releases holds). Returns true if cancelled, false if already finalized.
   *
   * CAS on `status = PENDING`. With `expectedPaymentIntentId` the CAS also
   * requires `stripePaymentIntentId` to still equal it (`null` = still
   * unlinked). Callers that settled a PaymentIntent from an earlier read pass
   * the id they settled: `createCheckout` links its PaymentIntent AFTER the
   * order commits, so a PENDING order read with no PI can gain a live one
   * before the cancel lands, and cancelling it then would strand a payable
   * charge.
   */
  cancelPendingOrder(
    orderId: string,
    opts?: { expectedPaymentIntentId: string | null },
  ): Promise<boolean>;
  /**
   * Cancel a PROCESSING order (delayed payment that failed after debit was
   * initiated, e.g. ACH return). Returns true if cancelled.
   */
  cancelProcessingOrder(orderId: string): Promise<boolean>;
  /**
   * Void a SUCCEEDED $0 COMP order (e.g. a revoked volunteer reward). Guarded
   * to `status = "SUCCEEDED"` AND `source = "COMP"` so it can never touch a
   * paid order — there is nothing to refund on a comp, this is a pure state
   * flip to CANCELLED. Idempotent: returns false when nothing matched (already
   * cancelled, not a comp, or paid). Callers void the minted Ticket separately.
   */
  cancelCompOrder(orderId: string): Promise<boolean>;
  linkPaymentIntent(orderId: string, piId: string): Promise<void>;
  /**
   * CAS link used by `createCheckout`, which creates the PaymentIntent after
   * the order commits. Links only while the order is still PENDING and has no
   * PaymentIntent, or already has this one (a webhook got there first).
   * Returns whether the order now carries `piId`. `false` means the order was
   * retired, released or reaped in between, and the PaymentIntent must not be
   * handed to the buyer.
   */
  linkPaymentIntentIfPending(
    orderId: string,
    piId: string,
    opts?: {
      /**
       * Also link a PROCESSING order (finalize: a delayed payment settling).
       * Never a terminal one.
       */
      allowProcessing?: boolean;
    },
  ): Promise<boolean>;
  clearPaymentIntent(orderId: string): Promise<void>;
  findByPaymentIntent(
    piId: string,
  ): Promise<FindOrderByPaymentIntentResult | null>;
  /**
   * The MEMBERSHIP order minted from a Stripe Billing invoice, if one exists.
   *
   * Backed by a UNIQUE index, so this can return at most one row. Read inside
   * the same transaction that would create the order: it turns a redelivered
   * `invoice.payment_succeeded` into a no-op that returns the SAME order rather
   * than a second charge-shaped row, without depending on the idempotency store
   * being reachable.
   */
  findByStripeInvoiceId(stripeInvoiceId: string): Promise<OrderRecord | null>;
  markSucceeded(orderId: string): Promise<void>;
  /**
   * Marks an order as PROCESSING — used for delayed notification payment
   * methods (ACH Direct Debit, bank transfers) where Stripe confirms the
   * intent but funds haven't settled yet. The webhook will later call
   * markSucceeded when the payment fully clears.
   */
  markProcessing(orderId: string): Promise<void>;
  /**
   * CAS form of `markSucceeded` for paths that act on a payment against an
   * order read EARLIER (finalize): flips to SUCCEEDED only while the order is
   * still PENDING or PROCESSING. Returns false when a canceller (retire /
   * release / reaper) got there first, so a stale read can never turn a
   * CANCELLED order — whose credit and seats were already handed back — into
   * a SUCCEEDED one.
   */
  markSucceededIfOpen(orderId: string): Promise<boolean>;
  /**
   * CAS form of `markProcessing`: PENDING → PROCESSING only. Returns false
   * when the order is no longer PENDING (cancelled, or already advanced).
   */
  markProcessingIfPending(orderId: string): Promise<boolean>;
  /**
   * Sets the order's refund status: REFUNDED when `partialCents` is omitted,
   * PART_REFUNDED when it is given. The number is not stored; it only selects
   * the status, and 0 is a valid partial amount (refunding a ticket that cost
   * $0 while other tickets stay live), so implementations test for
   * `undefined`, never truthiness.
   */
  markRefunded(orderId: string, partialCents?: number): Promise<void>;
  /**
   * CAS form of a full `markRefunded`: SUCCEEDED → REFUNDED only. Returns
   * false when the order is no longer SUCCEEDED (another refund won, or it
   * was never paid). The row lock the UPDATE takes is held to the end of the
   * caller's transaction, so a concurrent refund of the same order waits and
   * then gets false: exactly one refund claims the order.
   */
  markRefundedIfSucceeded(orderId: string): Promise<boolean>;
  /**
   * The door sweep's scan (`settleDoorOrdersOnCancelledEvents`): CANCELLED
   * events still carrying door orders a cancellation should have settled —
   *  - a SUCCEEDED CASH order with a CASH_SALE_DEBIT that is not reversed
   *    (the organiser still owes fee + tax on cash they hand back), or
   *  - a PENDING POS order (a card sale that could still be tapped).
   *
   * The debit is the cutover marker: every cash sale since the door was
   * priced that owes fee or tax carries one, and no older sale does, so an
   * event cancelled before this change is never listed for its old cash
   * orders and the sweep never rewrites them. Sales that owe nothing (comps,
   * fee-waived sales at 0% tax) write no debit and are left to the live
   * cancellation; see `settleDoorOrdersOnCancelledEvents`. The PENDING half
   * needs no history bound: a void cancels only a PaymentIntent proven dead.
   *
   * Distinct event ids, oldest open order first (`occurredAt`, then id), at
   * most `limit`. `excludeOrderIds` drops orders the caller has quarantined,
   * so an event whose only open order is stuck is not listed at all and
   * cannot hold a slot at the head of every page.
   */
  listCancelledEventIdsWithOpenDoorOrders(input: {
    limit: number;
    excludeOrderIds?: readonly string[];
  }): Promise<string[]>;
  /**
   * The event's SUCCEEDED CASH orders (comps included), by id ascending,
   * after `afterId`, at most `limit` — the cancellation's cash phase reads
   * its candidates with this, one keyset page at a time, instead of paging
   * every SUCCEEDED order and reading each one back.
   *
   * `unreversedCashSaleDebitOnly` narrows it to orders whose
   * CASH_SALE_DEBIT is not reversed: what the door sweep may touch (see
   * `listCancelledEventIdsWithOpenDoorOrders` for why).
   */
  listSucceededCashOrderIdsForEvent(input: {
    eventId: string;
    unreversedCashSaleDebitOnly: boolean;
    afterId?: string | null;
    limit: number;
  }): Promise<string[]>;
  /**
   * Report-only invariant (verify-ledger-invariants): door card sales left
   * open on a CANCELLED event whose last change is at or before
   * `cancelledBefore` (the grace cutoff) —
   *  - SUCCEEDED with a PaymentIntent: paid and never refunded (the sale
   *    finalised while the cancellation was refunding, after its scan), or
   *  - PENDING: the cancellation and the door sweep could not void it (its
   *    PaymentIntent was paid, or Stripe kept refusing).
   * Total count plus a sample capped at `sampleLimit`.
   */
  listOpenDoorCardSalesOnCancelledEvents(
    cancelledBefore: Date,
    sampleLimit?: number,
  ): Promise<PayeeLedgerInvariantScan<CancelledEventOpenDoorCardSaleRow>>;
  /**
   * Record which Stripe payment method was used (e.g. "card", "us_bank_account").
   * Called from the webhook when we learn the actual method from the charge.
   */
  setPaymentMethodType(orderId: string, methodType: string): Promise<void>;
  /**
   * Snapshots the card AVS/CVC check results for chargeback evidence.
   * Best-effort at `payment_intent.succeeded`; null clears (non-card method).
   */
  setPaymentCardChecks(
    orderId: string,
    checks: PaymentCardChecks | null,
  ): Promise<void>;
  /**
   * ATTRIBUTION, never money: what each order is ABOUT — its code, its kind,
   * and the event behind it — as a map. Ids that name no order are absent.
   *
   * Exists for the payouts views. A maturity tranche's sub-lines are
   * SETTLEMENT_CREDIT entries carrying an `orderId`, and an organiser reading
   * "$550 arrives 4 Oct" needs to see WHICH SHOWS that is. One batched
   * projection for a whole page of credits — never per-entry.
   *
   * `eventId` (and everything derived from it) is NULL for MEMBERSHIP orders,
   * which have no event at all, and for an order whose event row was deleted.
   * Both are real states; the caller renders "no show" rather than dropping
   * the line, because dropping it would make the sub-lines stop summing to
   * the heading above them.
   */
  getEventAttributionByIds(
    orderIds: string[],
  ): Promise<Map<string, OrderEventAttribution>>;
  /** Mirror the latest Stripe dispute lifecycle state onto the order row. */
  markDisputeStatus(input: MarkOrderDisputeStatusInput): Promise<void>;
  /** Cross-org paginated order search for platform staff */
  listAll(input: ListAllOrdersInput): Promise<ListAllOrdersResult>;
  /** List PENDING orders created before a cutoff (for expired cart cleanup). */
  listExpiredPending(
    input: ListExpiredPendingOrdersInput,
  ): Promise<ExpiredPendingOrderItem[]>;
  /** List other PENDING orders for the same buyer+event (for stale cart cleanup on finalization). */
  listOtherPending(
    input: ListOtherPendingInput,
  ): Promise<StalePendingOrderItem[]>;
  /** Bulk-update eventId for all orders matching a source event. Used by order migration. */
  bulkMigrateToEvent(
    input: BulkMigrateOrdersInput,
  ): Promise<BulkMigrateOrdersResult>;
  /** Update payout-hold bookkeeping for a resale order item. */
  updateResaleOrderItemFinanceState(
    input: UpdateResaleOrderItemFinanceStateInput,
  ): Promise<OrderItemRecord | null>;
  /**
   * All-time collected sales tax, grouped by currency — the tax component of
   * the platform solvency read (settlements/check-platform-solvency).
   *
   * Status filter MIRRORS {@link getTaxNexusRollup}: SUCCEEDED and
   * PART_REFUNDED only, so fully REFUNDED / CANCELLED / PENDING / DISPUTED
   * orders contribute nothing. Unlike that rollup there is NO time window
   * (liability does not expire) and no refund netting — see
   * {@link CollectedTaxTotal} for why the result is a deliberate UPPER BOUND
   * and must not be "corrected" downward without a real tax ledger.
   *
   * READ-ONLY. Never sums across currencies.
   */
  sumCollectedTaxByCurrency(): Promise<CollectedTaxTotal[]>;

  /**
   * Orders whose `processorFeeCents` has never been read, oldest first, for
   * the backfill sweep to fetch from Stripe and stamp.
   *
   * Only orders with a `stripePaymentIntentId` are returned: the fee lives on
   * the charge's balance transaction, so an order with no intent has nothing
   * to read and would be claimed forever. Status is filtered to the ones that
   * were actually CHARGED (SUCCEEDED / PART_REFUNDED / REFUNDED / DISPUTED) —
   * CANCELLED never captured money (its only writers are PENDING→,
   * PROCESSING→ and a $0 comp void) and PENDING/PROCESSING have not captured
   * yet, so none of them has a balance transaction to read.
   *
   * OLDEST FIRST so the backlog drains deterministically. That ordering alone
   * does NOT protect the backlog from a row Stripe can never resolve (deleted
   * test data, an intent on another Stripe account, an intent that never
   * produced a charge): oldest-first would hand it back every run, and once
   * `limit` such rows exist the sweep never reaches a newer order. So the
   * query also honours the two retry-bookkeeping columns:
   *
   *   * a row that failed is BACKED OFF — excluded until its
   *     `processorFeeReadFailedAt` is older than `now − retryBackoffMs`;
   *   * a row with `processorFeeReadFailures >= maxFailures` is PARKED —
   *     never returned again until the count is reset by hand.
   *
   * A permanently failing row therefore costs a page slot at most once per
   * backoff window and drops out entirely after `maxFailures` attempts, so
   * it cannot starve newer rows. The sweep counts parked rows separately in
   * its output; they are NOT in this list.
   *
   * READ-ONLY.
   */
  listOrdersMissingProcessorFee(
    input: ListOrdersMissingProcessorFeeInput,
  ): Promise<OrderMissingProcessorFee[]>;

  /**
   * Record one failed attempt to read an order's processor fee: stamps
   * `processorFeeReadFailedAt = failedAt` and increments
   * `processorFeeReadFailures`. Returns the NEW failure count, or 0 when
   * nothing was recorded.
   *
   * Guarded to rows where `processorFeeCents IS NULL`: a concurrent sweep may
   * have stamped the fee between our claim and our failure, and a stamped
   * row must never be marked failed — its bookkeeping describes a road that
   * has already been travelled. The 0 return is how the caller tells "not
   * recorded (already stamped)" from "recorded"; it never counts a 0 as a
   * parked row.
   *
   * Retry bookkeeping only. NEVER money, never read by a revenue path.
   */
  recordProcessorFeeReadFailure(
    input: RecordProcessorFeeReadFailureInput,
  ): Promise<number>;

  /**
   * Stamp `processorFeeCents` on one order.
   *
   * Guarded to rows where the column IS NULL, so a concurrent sweep (or a
   * replay of the same batch) can never overwrite a value already measured —
   * the number is read from an immutable balance transaction, so first write
   * wins and any later one is redundant by construction. Returns whether a row
   * was actually updated, which the caller treats as "claimed" rather than as
   * an error: a 0 means someone else stamped it first.
   *
   * `feeCents` is what Stripe reported, never a modelled figure. A caller that
   * cannot obtain the real number must leave the column NULL — a NULL is read
   * as "not attributed" and suppresses the net, whereas a guess would be
   * indistinguishable from a measurement once stored.
   */
  stampProcessorFee(input: StampProcessorFeeInput): Promise<boolean>;

  /**
   * Aggregate net facilitated sales + collected tax grouped by the frozen tax
   * situs (country + state/province) for orders since `input.since`. Powers the
   * economic-nexus threshold watch (spec 2026-07-01 §5.3). Counts SUCCEEDED and
   * PART_REFUNDED orders; excludes fully REFUNDED / CANCELLED / PENDING /
   * DISPUTED.
   */
  getTaxNexusRollup(
    input: GetTaxNexusRollupInput,
  ): Promise<TaxNexusRollupRow[]>;
  /**
   * EVERY ticket item (`kind = 'ticket'`, any status) of the given orders, in
   * ONE query, keyed by order id. Exists for the nexus rollup's per-line split
   * of refunded tax on orders with ≥2 PLATFORM tax lines: the allocator needs
   * all of an order's ticket items, not only the refunded ones. Orders with no
   * ticket items are absent. Empty input returns an empty map without a query.
   */
  listTicketItemsForTaxSplit(
    orderIds: string[],
  ): Promise<Map<string, TaxSplitTicketItem[]>>;
  /**
   * Reconcile the cash drawer for one event: what the door took, what it
   * comped, and what it handed back.
   *
   * Exists because CASH orders never touch Settlement (the organiser holds
   * the money, so there is nothing to move) and every money view we have
   * reads the Settlement side — which leaves cash correct and invisible.
   * Counts SUCCEEDED and REFUNDED; PENDING cash rows are rolled-back
   * attempts, not money.
   */
  summarizeCashTillForEvent(
    input: SummarizeCashTillForEventInput,
  ): Promise<CashTillSummary>;
  /**
   * One event's cash door sales (SUCCEEDED, REFUNDED, PART_REFUNDED), newest
   * first, keyset-paged: the list the Sell screen refunds from. Rows carry
   * no buyer PII. One query; items and promo codes ride it as nested
   * selects, never a per-row read.
   */
  listCashSalesForEvent(
    input: ListCashSalesForEventInput,
  ): Promise<ListCashSalesForEventResult>;
}

export type {
  OrderKind,
  PaymentCardChecks,
  BulkMigrateOrdersInput,
  CashTillSaleRow,
  CashTillSummary,
  CashSaleListRow,
  CollectedTaxTotal,
  SummarizeCashTillForEventInput,
  ListCashSalesForEventInput,
  ListCashSalesForEventResult,
  BulkMigrateOrdersResult,
  BuyerOrderSummary,
  CountDistinctBuyersForOwnerInput,
  CreatePendingOrderInput,
  CreatePendingOrderResult,
  CreateOrderTaxLineInput,
  CreateOrderTaxLinesInput,
  OrderTaxBase,
  OrderTaxCollector,
  OrderTaxLineRecord,
  EventCompOrderItem,
  EventCompOrderTicketTypeLine,
  ExpiredPendingOrderItem,
  FindOrderByPaymentIntentResult,
  FindOrderForOwnerInput,
  FindOrderForOwnerResult,
  OrderOwnerScope,
  SummarizeBuyerOrdersForOwnerInput,
  GetTaxNexusRollupInput,
  ListAllOrdersInput,
  ListAllOrdersResult,
  ListEventCompOrdersInput,
  ListEventCompOrdersResult,
  ListExpiredPendingOrdersInput,
  ListOtherPendingInput,
  ListOrdersByBuyerEventLocation,
  ListOrdersByBuyerInput,
  ListOrdersByBuyerItem,
  ListOrdersByBuyerResult,
  ListOrdersForHumanOwnedEventsInput,
  ListOrdersForHumanOwnedEventsResult,
  ListOrdersForOrgInput,
  ListOrdersForOrgResult,
  ListPendingCartsInput,
  ListPendingCartsResult,
  ListPlatformOrdersItem,
  MarkOrderDisputeStatusInput,
  OrderItemKind,
  OrderEventAttribution,
  OrderItemRecord,
  OrderItemStatus,
  OrderRecord,
  OrderSource,
  OrderStatus,
  PendingCartItem,
  PlatformOrderItemSummary,
  SearchEventAttendeesInput,
  SearchEventAttendeesResult,
  StalePendingOrderItem,
  TaxNexusRollupRow,
  TaxNexusRollupTaxLineParts,
  TaxSplitTicketItem,
  UpdateResaleOrderItemFinanceStateInput,
  UpdatePendingOrderItemsInput,
} from "@th/types/repos/orders";

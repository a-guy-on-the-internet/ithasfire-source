import type {
  ConnectAccountFeeTotal,
  CreatePayoutItemInput,
  ListPayoutHistoryQuery,
  ListPayoutHistoryResult,
  PayoutLedgerHealItem,
  PayoutLedgerHealQuery,
  EarliestTransferredPayoutQuery,
  PayoutItemRecord,
  PayoutItemWithSettlements,
  PayoutItemsInPeriodQuery,
  StalePendingPayoutItem,
  TransferredPayoutItemForOrderItems,
  TransferredReserveActivityItem,
  TransferredReserveActivityQuery,
} from "@th/types/repos/payout-items";

export interface PayoutItemsRepo {
  create(input: CreatePayoutItemInput): Promise<PayoutItemRecord>;

  /**
   * Single-row read by id. Exists for the payout batch's claim-lost recovery
   * probe: a committed transfer claim carries the ORIGINAL PayoutItem's id,
   * and the batch must check that item's status (and plan identity) before
   * re-stamping it transferred. Null when the id names no row.
   */
  getById(payoutItemId: string): Promise<PayoutItemRecord | null>;

  /**
   * Bulk-create multiple payout items in a single operation.
   * Returns the created records in the same order as the input array.
   */
  createMany(inputs: CreatePayoutItemInput[]): Promise<PayoutItemRecord[]>;

  /**
   * Terminal success. `stripeTransferId` is null ONLY for a fully-withheld
   * item (debt recovery consumed the entire net, so no Stripe call was made).
   * `transferredAt` stamps WHEN the transfer landed — Stripe bills its
   * monthly active-account fee for the month a payout LANDS, so month
   * attribution keys on this timestamp, never on `createdAt`.
   */
  markTransferred(
    payoutItemId: string,
    stripeTransferId: string | null,
    transferredAt: Date,
  ): Promise<void>;
  markFailed(
    payoutItemId: string,
    failedAt: Date,
    reason: string,
  ): Promise<void>;
  listByPayoutId(payoutId: string): Promise<PayoutItemWithSettlements[]>;

  /**
   * Of the given payees, which have a payout item that ACTUALLY TRANSFERRED
   * inside `[from, to]`? Stripe's monthly active-account fee is billed per
   * account per calendar month in which the account receives a payout, so one
   * `transferred` item anywhere in the month means the fee for that
   * account-month is already incurred and a further payout carries zero
   * marginal cost.
   *
   * `status = 'transferred'` is the whole point of the filter: a `pending` or
   * `failed` item moved no money, so Stripe never billed for it and it must not
   * suppress a later, legitimate deduction. The same reasoning excludes
   * fully-withheld debt-recovery items (`stripeTransferId IS NULL`): they
   * completed without any Stripe transfer, so the account never went active.
   *
   * "Inside the period" means the transfer EXECUTED inside it: the filter
   * keys on `transferredAt`, falling back to `createdAt` only for legacy rows
   * (transferredAt null) that predate the column.
   *
   * Batched by design — one query for the whole run, never per-payee.
   */
  payeeIdsWithTransferredPayoutInPeriod(
    query: PayoutItemsInPeriodQuery,
  ): Promise<Set<string>>;

  /**
   * Transferred items carrying a durable plan, for the payout LEDGER heal
   * sweep at the top of `runPayoutBatch`. The PAYOUT entry / credit
   * consumption / `paidOutAt` writes all happen AFTER `markTransferred`, so a
   * process death in that window leaves a payee who HAS been paid whose
   * payable still says they are owed — and the next batch would pay it again.
   * The sweep replays those three writes off the frozen plan (idempotent key,
   * consumed-once guard) BEFORE the payable is read. No Stripe call: the
   * transfer already happened.
   *
   * Returns items needing EITHER of two heals (deduped, createdAt order):
   *   * the PAYOUT ledger entry is missing (anti-join on `payoutLedgerKey`
   *     against `PayeeLedgerEntry.idempotencyKey`) — the arithmetic heal;
   *   * the PAYOUT entry EXISTS but one of the item's `plannedOrderItemIds`
   *     still has `paidOutAt IS NULL` — a crash between the debit and the
   *     stamps. NOT cosmetic: an unstamped item classifies as not-paid-out
   *     at refund time, skips the Stripe transfer reversal, and the platform
   *     fronts the refund as unrecouped debt.
   * Fully-squared history is excluded, which is what keeps the batch's
   * `itemsLedgerHealed` counter meaning "a real crash happened" instead of
   * saturating on nightly full-history replays.
   */
  listTransferredNeedingLedgerHeal(
    query: PayoutLedgerHealQuery,
  ): Promise<PayoutLedgerHealItem[]>;

  /**
   * PENDING post-cutover items (non-null `payoutLedgerKey`) created before
   * `cutoff`, for the batch's stale-pending recovery probe. A run that died
   * between committing its transfer claim and `markTransferred` leaves a
   * REAL Stripe transfer on an item still "pending" — invisible to the
   * transferred-only heal feed, and invisible to the claim-lost probe too
   * whenever the next night's credit set (and therefore cell hash) differs.
   * This feed exists so recovery keys on the item's own STORED plan, not on
   * a hash collision. Deliberately unbounded by payee (a crashed item's
   * payee may have no live payable cell); pending items are a transient
   * state, so the scan is small.
   */
  listPendingWithPlanOlderThan(
    cutoff: Date,
  ): Promise<StalePendingPayoutItem[]>;

  /**
   * Every `transferred` item with `reserveHeldCents > 0` OR
   * `reserveReleasedCents > 0` for the given payees. Feeds the rolling-
   * reserve crash sweep at the start of `runPayoutBatch`'s reserve step: the
   * RESERVE_HOLD / RESERVE_RELEASE ledger writes happen AFTER
   * markTransferred, so a process death in that window leaves a transferred
   * item whose deferred money the ledger has never heard of (a missing hold
   * means the payee's reserve silently never matures; a missing release
   * means a matured hold would be released — and paid — twice). Bounded by
   * payeeIds only, same rationale as
   * {@link TransferredReserveActivityQuery}.
   */
  listTransferredWithReserveActivity(
    query: TransferredReserveActivityQuery,
  ): Promise<TransferredReserveActivityItem[]>;

  /**
   * Earliest transfer timestamp per payee among `transferred` items whose
   * settlements trace (via lines) to orders of `orderKind`. The seasoning
   * curve's track-record read: "when did this payee's FIRST membership /
   * ticketing payout land?". Payees with none are absent from the map.
   *
   * Reads BOTH eras and takes the earlier: pre-cutover items through the
   * frozen `PayoutItemSettlement` junction, post-cutover items through their
   * durable plan (`plannedCreditEntryIds` → SETTLEMENT_CREDIT → `Order.kind`).
   * Reading only the junction — which nothing writes any more — would make
   * every post-cutover payee look brand new FOREVER and pin them at the
   * curve's maximum-risk bracket (1000 bps on every membership payout, never
   * graduating), so the two-era union is load-bearing, not tidiness.
   *
   * Timestamp is `min(transferredAt)` falling back to `min(createdAt)` for
   * legacy rows predating the column — for those, creation and transfer
   * happened in the same batch run minutes apart, so against 90/180-day
   * brackets the approximation is exact. One grouped query per kind for the
   * whole batch, never per-payee.
   */
  earliestTransferredPayoutAtByPayee(
    query: EarliestTransferredPayoutQuery,
  ): Promise<Map<string, Date>>;

  /**
   * Track record for the invite send allowance (gated-event invite links,
   * owner ruling 2026-10-05): true when the payee of this subject (an org,
   * or a human for person-owned events) has at least one SETTLED payout, i.e.
   * a PayoutItem with status "transferred". An EXISTS query, never a count.
   */
  subjectHasTransferredPayout(subject: {
    subjectType: "ORGANIZATION" | "HUMAN";
    subjectId: string;
  }): Promise<boolean>;

  /**
   * Ledger-era transfer-reversal resolution: every `transferred` item that
   * moved money over Stripe (`stripeTransferId` non-null) whose
   * `plannedOrderItemIds` overlaps the given order items. Post-cutover
   * payouts write NOTHING into the frozen settlement junction, so this is the
   * ONLY way a post-payout refund can find the transfer that paid an order
   * item and pull the money back — without it the refund proceeds, the
   * platform fronts the buyer's cents, and the payee keeps theirs.
   * Fully-withheld items (`stripeTransferId` null) are excluded by design:
   * no Stripe transfer exists to reverse.
   */
  listTransferredByPlannedOrderItemIds(
    orderItemIds: string[],
  ): Promise<TransferredPayoutItemForOrderItems[]>;

  /**
   * STAFF READ — the PAID half of `/platform/settlements` ("when, how much,
   * to whom"). One row per item, joined to its parent `Payout` (schedule,
   * batch status) and its `Payee` (subject), newest first, keyset-paged,
   * optionally filtered by item status.
   *
   * Lives here rather than on `PayoutsRepo` because the row IS a
   * `PayoutItem`: the batch is a scheduler detail, while the amount, the
   * status, the Stripe transfer id and the failure reason are all item
   * columns. See {@link ListPayoutHistoryResult} for the ordering rule and
   * {@link PayoutHistoryItem} for the gross/net distinction.
   *
   * ALSO the organiser-facing read, via {@link ListPayoutHistoryQuery.payeeIds}
   * — the SAME statement narrowed to one payee, never a second query. Omitted
   * `payeeIds` = every payee (staff); an EXPLICIT empty array = no rows. It
   * ANDs with `status` in the base `WHERE`, so the keyset cursor and `total`
   * both describe the filtered set. A cursor is therefore only MEANINGFUL
   * within the filter set that produced it — and nothing here detects a
   * mismatched pair, so a caller that changes `payeeIds` or `status` must
   * restart from page one or it will silently page from an offset that means
   * something else.
   *
   * READ-ONLY. MUST be called on the top-level repos, never inside
   * `repos.tx(...)`. A statement budget is ALWAYS applied (`statementTimeoutMs`
   * only overrides the default), so the adapter ALWAYS opens its own
   * transaction to scope `SET LOCAL` to this read and ALWAYS refuses a
   * TransactionClient (INTERNAL) rather than leak those settings onto a
   * caller's work — there is no unbudgeted path to fall back to.
   */
  listHistory(query: ListPayoutHistoryQuery): Promise<ListPayoutHistoryResult>;

  /**
   * Σ `connectAccountFeeCents` over TRANSFERRED payout items, grouped by
   * lower-cased currency. All time, one row per currency.
   *
   * It lives HERE rather than on the analytics repo because the column lives
   * on `PayoutItem` and this repo owns every read of that table — the
   * analytics repo aggregates Order/Event/Ticket. The staff revenue view
   * composes the two.
   *
   * See {@link ConnectAccountFeeTotal} for what the number means (a recovered
   * COST, never fee income) and why pending/failed items are excluded.
   * READ-ONLY, diagnostic: cents ride `::bigint` → number so a pathological
   * total is reported rather than raising 22003.
   */
  sumConnectAccountFeesByCurrency(): Promise<ConnectAccountFeeTotal[]>;
}

export type {
  ConnectAccountFeeTotal,
  CreatePayoutItemInput,
  ListPayoutHistoryQuery,
  ListPayoutHistoryResult,
  PayoutHistoryItem,
  PayoutHistoryStatusFilter,
  PayoutLedgerHealItem,
  PayoutLedgerHealQuery,
  EarliestTransferredPayoutQuery,
  PayoutItemRecord,
  PayoutItemWithSettlements,
  PayoutItemStatus,
  PayoutItemsInPeriodQuery,
  StalePendingPayoutItem,
  TransferredPayoutItemForOrderItems,
  TransferredReserveActivityItem,
  TransferredReserveActivityQuery,
} from "@th/types/repos/payout-items";

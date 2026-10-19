import type { OrderKind } from "./orders";

export type PayoutItemStatus = "pending" | "transferred" | "failed";

export interface PayoutItemRecord {
  id: string;
  payoutId: string;
  payeeId: string;
  currency: string;
  /**
   * GROSS — the PAYABLE claimed by this item, never netted. (On pre-cutover
   * rows: the sum of the linked settlements.)
   */
  amountCents: number;
  /**
   * Stripe's monthly active-account fee withheld from this transfer, in cents.
   * The transfer sent to Stripe is
   * `amountCents - reserveHeldCents - connectAccountFeeCents
   *  + reserveReleasedCents`.
   */
  connectAccountFeeCents: number;
  /**
   * LEGACY, always 0 on rows written post-cutover. Dispute-debt withheld
   * from this item's transfer under the pre-2026-08-10 model. Debt is no
   * longer a withholding step — it is a NEGATIVE payable that pays nothing
   * and is recouped by arithmetic on the next cycle (spec §2) — so nothing
   * writes this column any more. Kept because the column is financial
   * history on existing rows.
   */
  recoveredDebtCents: number;
  /**
   * Rolling-reserve cents withheld from this item's transfer (0 = none).
   * Computed on the MEMBERSHIP portion of the payout only (deduction order:
   * reserve → Connect fee) and stamped at creation — never recomputed. A
   * reserve is DEFERRED payout, not revenue: a matching RESERVE_HOLD ledger
   * entry (`reserve-hold:<payoutItemId>`) tracks the deferred cents until
   * they mature and ride back on a later payout via `reserveReleasedCents`.
   * Unlike the $2 fee, the reserve may consume the entire net — that item
   * completes through the zero-net path with no Stripe call.
   */
  reserveHeldCents: number;
  /**
   * Matured reserve ADDED to this item's transfer (0 = none). The transfer
   * sent to Stripe is `amountCents - reserveHeldCents -
   * connectAccountFeeCents + reserveReleasedCents`. Matching RESERVE_RELEASE
   * ledger entries (`reserve-release:<holdEntryId>`, sourceId = this item)
   * mark which holds came back; the crash sweep uses that linkage to heal a
   * transfer whose release writes were lost.
   */
  reserveReleasedCents: number;
  /**
   * THE DURABLE PLAN — the SETTLEMENT_CREDIT ids this item claims, frozen at
   * mint time. Recovery reads it instead of re-deriving from a payable the
   * crash may already have changed. Empty on pre-cutover rows.
   */
  plannedCreditEntryIds: string[];
  /** Order-item ids the planned credits attribute to (`paidOutAt` targets). */
  plannedOrderItemIds: string[];
  /** The exact cents handed to Stripe. Recorded, never recomputed. */
  plannedNetCents: number;
  /**
   * `idempotencyKey` of this item's PAYOUT ledger entry, derived from the
   * CREDIT SET (not this row's id) so a duplicate run replays it as a no-op.
   * Null on pre-cutover rows.
   */
  payoutLedgerKey: string | null;
  stripeTransferId: string | null;
  status: PayoutItemStatus;
  failedAt: Date | null;
  failureReason: string | null;
  /**
   * When this item's transfer actually EXECUTED (Stripe accepted it, or the
   * zero-net path completed without a Stripe call). Stripe bills its monthly
   * active-account fee for the month a payout LANDS, so month attribution
   * keys on this; `createdAt` is only a fallback for rows predating the
   * column. Null for pending/failed items.
   */
  transferredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePayoutItemInput {
  payoutId: string;
  payeeId: string;
  currency: string;
  /**
   * GROSS — the PAYABLE this item claims this cycle, before any
   * transfer-time withholding (rolling reserve, Connect fee) and excluding
   * matured reserve riding along. The same number the PAYOUT ledger entry
   * records; see `PayoutDebitPayeeLedgerInput.amountCents`.
   *
   * `settlementIds` is GONE: post-cutover a payout item links no settlements
   * (`PayoutItemSettlement` is frozen history). What a payout covered is
   * answered by the PAYOUT ledger entry's `metadata.consumedCreditEntryIds`
   * and the credits' `consumedByEntryId` stamp.
   */
  amountCents: number;
  /**
   * Connect active-account fee to withhold from this item's transfer.
   * Omitted / undefined behaves as 0. Stamped at creation (on the planned
   * payable) so a re-run can never recompute — and therefore never
   * double-deduct.
   */
  connectAccountFeeCents?: number;
  /**
   * Rolling-reserve cents to withhold from this item's transfer. Omitted /
   * undefined behaves as 0. Same stamped-at-creation discipline as the
   * connect fee: decided once on the planned payable, read back off the
   * persisted row at transfer time, never recomputed.
   */
  reserveHeldCents?: number;
  /**
   * Matured reserve to ADD to this item's transfer. Omitted / undefined
   * behaves as 0. Stamped at creation; the RESERVE_RELEASE ledger entries
   * are written only after the transfer actually executes.
   */
  reserveReleasedCents?: number;
  /** {@link PayoutItemRecord.plannedCreditEntryIds}. Defaults to []. */
  plannedCreditEntryIds?: string[];
  /** {@link PayoutItemRecord.plannedOrderItemIds}. Defaults to []. */
  plannedOrderItemIds?: string[];
  /** {@link PayoutItemRecord.plannedNetCents}. Defaults to 0. */
  plannedNetCents?: number;
  /** {@link PayoutItemRecord.payoutLedgerKey}. */
  payoutLedgerKey?: string | null;
}

/**
 * Query for the payout LEDGER heal sweep: transferred items for these payees
 * that carry a durable plan (`payoutLedgerKey` non-null). Bounded by payeeIds
 * only — deliberately no time window, same reasoning as the reserve sweep: an
 * orphaned PAYOUT entry that ages out means the payable still shows money the
 * payee was already sent, and the next batch pays it AGAIN.
 */
export interface PayoutLedgerHealQuery {
  payeeIds: string[];
}

/**
 * A PENDING post-cutover item old enough that its run is certainly dead,
 * fed to the batch's stale-pending recovery probe: if the item's transfer
 * claim (derived from `payoutLedgerKey` — same cell hash) holds a COMMITTED
 * record naming this item, the money left Stripe and the item must be
 * re-stamped `transferred` so the ledger heal can see it.
 */
export interface StalePendingPayoutItem {
  id: string;
  payeeId: string;
  currency: string;
  /** Non-null by query construction (pre-cutover rows carry no plan). */
  payoutLedgerKey: string;
}

/** What the ledger heal replays. Everything comes off the row — nothing is recomputed. */
export interface PayoutLedgerHealItem {
  id: string;
  payoutId: string;
  payeeId: string;
  currency: string;
  /** The PAYABLE CLAIMED — what the PAYOUT entry must record. */
  amountCents: number;
  plannedCreditEntryIds: string[];
  plannedOrderItemIds: string[];
  plannedNetCents: number;
  payoutLedgerKey: string;
  stripeTransferId: string | null;
}

/**
 * Ledger-era transfer-reversal resolution (post-cutover refunds): a
 * `transferred` payout item that actually moved money over Stripe
 * (`stripeTransferId` non-null) and whose durable plan attributes revenue to
 * one of the order items being refunded. Post-cutover payouts write NO
 * `OrderItemSettlementLine`/`SettlementLine` rows — `plannedOrderItemIds` is
 * the ONLY link from a paid-out order item back to the transfer that paid it,
 * so this projection is what `reverseTransfersForItems` reverses against.
 */
export interface TransferredPayoutItemForOrderItems {
  payoutItemId: string;
  stripeTransferId: string;
  payeeId: string;
  currency: string;
  plannedOrderItemIds: string[];
  /** GROSS payable the item claimed (pre-withholding). */
  amountCents: number;
  /**
   * The exact cents handed to Stripe (`plannedNetCents`, post-withholding).
   * A reversal for a heavily-withheld item's payee share CAN exceed what is
   * still reversible on the transfer — callers deliberately do NOT preclamp
   * with this; Stripe is the authority and its failure surfaces normally.
   */
  netAmountCents: number;
}

/**
 * Window used to ask "has this payee already received a payout this calendar
 * month?" — the question that decides whether Stripe's active-account fee has
 * already been incurred for that account-month.
 */
export interface PayoutItemsInPeriodQuery {
  payeeIds: string[];
  /** Inclusive lower bound (start of the calendar month, UTC). */
  from: Date;
  /** Inclusive upper bound (normally "now"). */
  to: Date;
}

/**
 * LEGACY projection: a payout item plus the settlements it linked. Only
 * PRE-cutover rows carry links — nothing writes `PayoutItemSettlement` any
 * more (spec 2026-08-10 §7), so `settlementIds` is `[]` on every new row.
 */
export interface PayoutItemWithSettlements extends PayoutItemRecord {
  settlementIds: string[];
}

/**
 * Query for the rolling-reserve crash sweep in `runPayoutBatch`: every
 * transferred item that withheld reserve OR carried a reserve release, for
 * the payees about to be processed. Bounded by `payeeIds` ONLY — deliberately
 * no time window: a window would let an orphaned write age out, and for a
 * missing RESERVE_HOLD that means the payee's deferred money silently never
 * matures, which is strictly worse than a rare re-listing of already-healed
 * rows (each replay is an idempotent no-op).
 */
export interface TransferredReserveActivityQuery {
  payeeIds: string[];
}

/** Minimal projection the reserve sweep needs to (re)write ledger entries. */
export interface TransferredReserveActivityItem {
  id: string;
  payoutId: string;
  payeeId: string;
  currency: string;
  reserveHeldCents: number;
  reserveReleasedCents: number;
}

/**
 * "When did this payee's FIRST payout of the given order-kind transfer?" —
 * the seasoning curve's track-record input. One grouped query per kind for
 * the whole batch, never per-payee.
 */
export interface EarliestTransferredPayoutQuery {
  payeeIds: string[];
  /** `Order.kind` the payout's settlements must trace to (via lines). */
  orderKind: OrderKind;
}

// ── Payout history (staff "Payouts sent" view) ──────────────────────────────
//
// The PAID half of the platform-admin settlements page: one row per
// `PayoutItem`, joined to its parent `Payout` (for the schedule) and its
// `Payee` (for who). Read-only, cursor-paged, newest first.
//
// Deliberately a row per ITEM, not per Payout batch: a batch is an
// implementation detail of the scheduler, whereas "we sent $X to Y on Z" is
// the unit a human asks about — and it is also the unit that carries the
// status, the Stripe transfer id and the failure reason.

export type PayoutHistoryStatusFilter =
  | "all"
  | "pending"
  | "transferred"
  | "failed";

export interface ListPayoutHistoryQuery {
  /** Default `"all"`. Anything else filters on `PayoutItem.status`. */
  status?: PayoutHistoryStatusFilter;
  /**
   * Narrows the page to these payees (`PayoutItem.payeeId`). OMITTED
   * (`undefined`) = every payee — the staff read. An EXPLICIT empty array
   * means exactly that: no payees, so no rows.
   *
   * The SAME rule, stated the same way, as the payee-ledger reads'
   * `payeeIds` (`listPayableBalances` / `listUpcomingMaturities`) — one
   * convention for payee narrowing across the whole settlement surface, so
   * the organiser-facing payouts view is a narrowed staff read rather than a
   * parallel implementation of payout arithmetic.
   *
   * Composes with `status`: both land in the SAME base `WHERE`, ANDed, so
   * the keyset cursor pages the FILTERED set and `total` counts the FILTERED
   * set. A CURSOR IS ONLY VALID WITHIN THE FILTER SET THAT PRODUCED IT —
   * changing `payeeIds` (exactly as with `status`) invalidates it, and a
   * caller that changes either must restart from page one. Nothing encodes
   * the filter into the cursor, so a mismatched pair is not detected: it
   * silently pages from an offset that means something else.
   */
  payeeIds?: string[];
  /** Page size; the adapter clamps to [1, 200]. */
  limit?: number;
  /**
   * Opaque keyset cursor from a prior page's `pageInfo.nextCursor`. A cursor
   * that fails to decode restarts from the top rather than throwing — the
   * same posture as `listDebtPositions` and the dispute desk's `listForDesk`.
   */
  cursor?: string | null;
  /**
   * Per-statement budget (default 8000ms, clamped to [1, 300000]), applied
   * exactly like {@link ListPayeeDebtPositionsInput.statementTimeoutMs}: the
   * adapter runs the read in its own interactive transaction and maps a
   * Postgres `57014` / Prisma `P2028` to `SERVICE_UNAVAILABLE`
   * (`payout_items_history_timeout`) so a slow diagnostic degrades to an
   * inline error instead of hanging the settlements page.
   */
  statementTimeoutMs?: number;
}

/**
 * One payout item as the staff view reads it: when, how much, to whom, and
 * the deductions that explain the number.
 *
 * `amountCents` is GROSS — the payable claimed this cycle, before any
 * withholding (see the `PayoutItem.amountCents` schema comment, where the
 * invariant is spelled out). `netCents` is the frozen
 * `plannedNetCents`: the exact cents handed to Stripe, RECORDED rather than
 * recomputed because every withholding input drifts after a transfer lands.
 * The UI shows both, plus the deduction columns, so the difference is never
 * a number a reader has to trust without seeing its parts.
 */
export interface PayoutHistoryItem {
  /** `PayoutItem.id`. */
  id: string;
  payoutId: string;
  payeeId: string;
  /** From the joined `Payee` row — who the money went to. */
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  currency: string;
  /** GROSS — sum of the payable claimed, before withholding. */
  amountCents: number;
  /** Stripe's monthly active-account fee withheld from this transfer. */
  connectAccountFeeCents: number;
  /** LEGACY pre-cutover debt recovery; always 0 on modern rows. */
  recoveredDebtCents: number;
  /** Rolling-reserve cents withheld from this transfer. */
  reserveHeldCents: number;
  /** Matured reserve ADDED back onto this transfer. */
  reserveReleasedCents: number;
  /**
   * `plannedNetCents` — the exact cents handed to Stripe, frozen at mint.
   *
   * NULL = NOT RECORDED, which is not the same as zero. The column was added
   * `INTEGER NOT NULL DEFAULT 0` (migration 20260813140000), so every
   * PayoutItem written before it carries a backfilled 0 — and a transferred
   * $500 item would otherwise render "Gross $500.00 / Sent $0.00", money that
   * demonstrably moved reported as nothing sent.
   *
   * A stored net counts as REAL when either `payoutLedgerKey` is set (a
   * post-cutover row, whose writer sets both together) OR the value is
   * non-zero (which no backfill can produce). Only a pre-cutover row whose
   * true net was genuinely zero comes back null — unknown is the safe
   * direction there, since it is indistinguishable from the backfill.
   */
  netCents: number | null;
  status: PayoutItemStatus;
  /** When the transfer actually executed. Null for pending/failed items. */
  transferredAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  stripeTransferId: string | null;
  /**
   * The instant this row sorts and displays on: `transferredAt` when the
   * money moved, else the parent batch's `scheduledFor`. See
   * {@link ListPayoutHistoryResult} for why the fallback is the schedule.
   */
  occurredAt: Date;
  /** Parent `Payout.scheduledFor` — when the batch was meant to run. */
  scheduledFor: Date;
  /** Parent `Payout.status` — "scheduled"|"running"|"completed"|"failed"|"canceled". */
  payoutStatus: string;
  processorBatchId: string | null;
  createdAt: Date;
}

export interface ListPayoutHistoryResult {
  /**
   * Ordered by `occurredAt` DESC, then `id` DESC — newest first.
   *
   * ORDERING CHOICE, stated once so nobody has to infer it: a TRANSFERRED
   * item sorts on `transferredAt` (when the money actually left), and a
   * pending or failed item — which has no `transferredAt` — sorts on its
   * parent batch's `scheduledFor`. Sorting pending rows by their own
   * `createdAt` would have been equivalent in practice (an item is minted by
   * the run it was scheduled for) but `scheduledFor` is the column a human
   * recognises, and it is the value the UI renders in the same cell, so the
   * sort key and the visible date are the same number. Consequence worth
   * knowing: tonight's pending items sort ABOVE last night's transferred
   * ones, which is what ops wants — money in flight is the urgent row.
   */
  items: PayoutHistoryItem[];
  pageInfo: {
    cursorField: string;
    nextCursor: string | null;
    limit: number;
    hasNextPage: boolean;
  };
  /**
   * Count of items at or after the cursor (this page included). On the first
   * page — no cursor — that is the grand total for the active status filter,
   * which is what the section badge reads.
   */
  total: number;
}

/**
 * Σ `PayoutItem.connectAccountFeeCents` for one currency — Stripe's monthly
 * active-account fee the platform WITHHELD from transfers.
 *
 * The one cleanly-recorded RECOVERED COST on the platform's books. It is not
 * revenue: it is a cost the platform incurs and then recoups out of a payee's
 * transfer, so a revenue view carries it as a separate, labelled line rather
 * than adding it to fee income.
 *
 * `status = 'transferred'` ONLY. A pending or failed item withheld nothing —
 * no transfer executed, so the cents were never kept. Same reasoning as
 * {@link PayoutItemsRepo.payeeIdsWithTransferredPayoutInPeriod}'s status
 * filter. Fully-withheld items (`stripeTransferId` null but `transferred`)
 * DO count: the fee was withheld even though no Stripe transfer was needed.
 *
 * All time, no window. Currency is lower-cased so the rows join the ledger's
 * and Stripe's lowercase ISO-4217.
 */
export interface ConnectAccountFeeTotal {
  /** Lowercase ISO-4217. */
  currency: string;
  connectAccountFeeCents: number;
  /** Transferred payout items behind the total (including fee-free ones). */
  itemCount: number;
}

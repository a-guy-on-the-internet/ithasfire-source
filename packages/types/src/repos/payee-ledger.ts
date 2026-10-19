export type PayeeLedgerEntryType =
  | "SETTLEMENT_CREDIT"
  | "REFUND_DEBIT"
  | "DISPUTE_HOLD"
  | "DISPUTE_DEBIT"
  | "DISPUTE_RELEASE"
  | "PAYOUT"
  | "RESERVE_HOLD"
  | "RESERVE_RELEASE"
  | "MANUAL_ADJUSTMENT"
  /**
   * Written when a post-payout refund successfully reverses a Stripe
   * transfer: the money came back externally, so the payee's balance owes
   * nothing net. +effect on `ledgerBalanceCents`; `relatedEntryId` links to
   * the REFUND_DEBIT it compensates.
   */
  | "TRANSFER_REVERSAL_CREDIT"
  /**
   * A cash sale at the door (spec 2026-10-07 door-sales-same-price-and-tax,
   * FR-004): the organiser holds the cash, and its tax is owed to the
   * platform (owner ruling 2026-10-08: cash = no platform fee; a sale
   * recorded before it was debited fee + tax). −effect on the payable and `ledgerBalanceCents`,
   * ALWAYS effective (no `availableAt`), so it reduces the next payout and a
   * cash-only payee carries the negative balance forward (owner ruling R6).
   */
  | "CASH_SALE_DEBIT"
  /**
   * Reverses a CASH_SALE_DEBIT when the cash sale is refunded at the gate.
   * +effect; `relatedEntryId` links to the debit it reverses.
   */
  | "CASH_SALE_DEBIT_REVERSAL";

export interface PayeeLedgerEntryRecord {
  id: string;
  idempotencyKey: string;
  payeeId: string;
  type: PayeeLedgerEntryType;
  amountCents: number;
  currency: string;
  sourceKind: string;
  sourceId: string;
  orderId: string | null;
  settlementId: string | null;
  disputeId: string | null;
  relatedEntryId: string | null;
  /**
   * When this entry counts toward the PAYABLE balance. Null = immediately.
   * Only SETTLEMENT_CREDIT rows carry a value (the maturity date); debits,
   * holds and payouts are always effective — credits wait, debits never do.
   * DB-enforced for credits by the SQL-only CHECK
   * `PayeeLedgerEntry_settlement_credit_available_check`.
   */
  availableAt: Date | null;
  /**
   * Stamped on a SETTLEMENT_CREDIT when a PAYOUT entry consumes its net
   * contribution. Attribution only (order-item `paidOutAt` stamping,
   * reporting) — NEVER an input to amount computation.
   */
  consumedByEntryId: string | null;
  description: string;
  metadata: unknown | null;
  createdAt: Date;
  /**
   * The EFFECTIVE maturity — `availableAt`, or for a RESALE order's credit
   * the later of that and the claim window's close measured from the event's
   * CURRENT end (the date the payable query and the upcoming-maturities
   * forecast mature/bucket the credit on). Set ONLY by `listEntries`' filtered
   * (tranche-attribution) path; absent on every other read. `availableAt`
   * always stays the stored column.
   */
  effectiveAvailableAt?: Date | null;
}

export interface HoldPayeeLedgerInput {
  idempotencyKey: string;
  payeeId: string;
  amountCents: number;
  currency: string;
  disputeId: string;
  /**
   * REQUIRED in practice whenever the dispute concerns an order (the only
   * production writer always passes it). The payable query's active-hold
   * carve-out probes holds by (orderId, payeeId, currency) — a NULL-orderId
   * hold is invisible to it, so the blocking dispute status would exclude
   * the credit AND the hold's pendingHold would subtract: the double-punish
   * the carve-out exists to prevent (transient under-pay). Omit only for
   * disputes with no associated order.
   */
  orderId?: string | null;
  sourceId?: string | null;
  description?: string | null;
  metadata?: unknown | null;
}

export interface ReleasePayeeLedgerHoldInput {
  holdEntryId: string;
  idempotencyKey?: string | null;
  description?: string | null;
  metadata?: unknown | null;
}

/**
 * A DISPUTE_DEBIT: the payee actually owes this money (a lost dispute: this
 * payee's share of the disputed amount on any product line, plus — on
 * memberships only — Stripe's dispute fee as a second entry), as opposed to a
 * DISPUTE_HOLD which is merely provisional.
 *
 * `amountCents` is POSITIVE — like holds and releases, the entry type carries
 * the direction; the adapter decrements `ledgerBalanceCents` by this amount.
 * If an active hold exists for the same dispute/payee/currency, the debit
 * consumes it (the hold's provisional pending-hold effect is replaced by the
 * real balance debit).
 */
export interface DebitPayeeLedgerInput {
  idempotencyKey: string;
  payeeId: string;
  amountCents: number;
  currency: string;
  disputeId: string;
  /**
   * Default true: a newly created debit consumes the dispute's active
   * DISPUTE_HOLD for the same (payee, currency), linking it via
   * `relatedEntryId` and removing its pending-hold effect. Pass `false` for
   * an entry that must NEVER touch a hold — the dispute FEE debit, which is
   * money on top of the principal: if it matched the hold instead of the
   * amount entry, the hold's cents would be released against the wrong
   * entry and the principal would never be consumed from it.
   */
  consumeHold?: boolean;
  orderId?: string | null;
  sourceId?: string | null;
  description?: string | null;
  metadata?: unknown | null;
}

/**
 * Compensates a DISPUTE_DEBIT after a WON-after-LOST status flip: Stripe can
 * re-close a dispute in the payee's favour after a LOST close already
 * converted the hold into a realised debit. The hold is gone (consumed by the
 * debit), so `releaseHoldsForDispute` finds nothing — this entry is what puts
 * the money back.
 *
 * Entry-type choice: `DISPUTE_RELEASE`, NOT `PAYOUT`. `getBalance` reads the
 * rollup table (`PayeeLedgerBalance`) — entry types never re-enter balance
 * math after the write — so the type is purely semantic, and "the dispute's
 * claim on the payee's money is released" is exactly what happened. The
 * balance effect differs from a hold-release on purpose: a hold-release
 * decrements `pendingHoldCents` (the hold was provisional); this reversal
 * increments `ledgerBalanceCents`, because the debit it compensates was a
 * realised decrement of that same column. Sign convention is file-wide:
 * `amountCents` is stored POSITIVE, the operation carries the direction.
 */
export interface ReverseDisputeDebitInput {
  /**
   * `dispute-debit-reversal:${disputeId}:${payeeId}:${currency}` (or the
   * `...-reversal-fee:` twin for the fee debit) by convention. Idempotent
   * exactly like `hold`/`debit`: a replay returns the existing row without
   * re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /** POSITIVE cents — equal to the debit entry being reversed. */
  amountCents: number;
  currency: string;
  disputeId: string;
  /** The DISPUTE_DEBIT entry being compensated (stored as relatedEntryId). */
  debitEntryId: string;
  orderId?: string | null;
  description?: string | null;
  metadata?: unknown | null;
}

/**
 * A RESERVE_HOLD: cents withheld from a payout's MEMBERSHIP portion under the
 * rolling reserve (spec 2026-08-05, "Dispute policy"). A reserve is DEFERRED
 * PAYOUT, not revenue and not debt — the money stays on the platform balance
 * and returns to the payee via a RESERVE_RELEASE once the hold matures.
 *
 * Rollup semantics (see the adapter): a created hold INCREMENTS
 * `PayeeLedgerBalance.reserveBalanceCents` and touches nothing else —
 * `ledgerBalanceCents` never saw these cents (they were withheld before the
 * transfer), so there is no debit to mirror. Sign convention is file-wide:
 * `amountCents` is stored POSITIVE, the entry type carries the direction.
 */
export interface ReserveHoldPayeeLedgerInput {
  /**
   * `reserve-hold:${payoutItemId}` by convention — at most one hold per
   * payout item. Idempotent exactly like `hold`/`debit`: a replay returns
   * the existing row without re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /** POSITIVE cents withheld from the payout's membership portion. */
  amountCents: number;
  currency: string;
  /** The PayoutItem the reserve was withheld from (stored as sourceId). */
  payoutItemId: string;
  description?: string | null;
  metadata?: unknown | null;
}

/**
 * A RESERVE_RELEASE: a matured RESERVE_HOLD returning to the payee by riding
 * a later payout's transfer. The release's `amountCents`/`currency` are taken
 * from the HOLD row (never passed in), `relatedEntryId` links hold → release
 * (which is what marks the hold as no longer outstanding), and `sourceId` is
 * the payout item whose transfer carried the money back — that linkage is
 * what lets the crash sweep compute how much of a stamped
 * `reserveReleasedCents` has already been written.
 *
 * Rollup: a created release DECREMENTS `reserveBalanceCents` (floored at 0,
 * mirroring the pending-hold guard). `ledgerBalanceCents` is untouched — the
 * money moves in the Stripe transfer, not in the ledger balance.
 */
export interface ReserveReleasePayeeLedgerInput {
  /**
   * `reserve-release:${holdEntryId}` by convention — the release is keyed by
   * the HOLD it terminates (each hold releases at most once, ever), not by
   * the payout item that happens to carry it. Idempotent like every other
   * entry writer in this file.
   */
  idempotencyKey: string;
  /** The RESERVE_HOLD being released (becomes relatedEntryId). */
  holdEntryId: string;
  /** The PayoutItem whose transfer carries the released cents (sourceId). */
  payoutItemId: string;
  description?: string | null;
  metadata?: unknown | null;
}

/**
 * A SETTLEMENT_CREDIT: a payee's split of an order, materialized as the
 * ledger entry that IS the source of truth for what they are owed
 * (spec 2026-08-10, ledger-authoritative-settlement §3). Written by order
 * finalize per payee, in the same transaction as the order writes.
 *
 * `availableAt` is REQUIRED — it is the maturity date (`computePayoutDate`
 * of the event's schedule; resale: purchase + `resalePayoutReleaseDays`)
 * without which "pay the balance" would pay out tonight's sales for an event
 * three weeks away. DB-enforced by the SQL-only CHECK
 * `PayeeLedgerEntry_settlement_credit_available_check`.
 *
 * `metadata` is REQUIRED and carries the item-level attribution
 * `{ items: Record<orderItemId, contributionCents> }` — the per-item
 * breakdown partial refunds and item-level reporting read; there is no join
 * table. Sign convention is file-wide: `amountCents` is stored POSITIVE and
 * the type carries direction; the adapter increments `ledgerBalanceCents`.
 */
export interface SettlementCreditPayeeLedgerInput {
  /**
   * `settlement-credit:${orderId}:${payeeId}` by convention. Idempotent
   * exactly like `hold`/`debit`: a replay returns the existing row without
   * re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /** POSITIVE cents — this payee's split of the order. */
  amountCents: number;
  currency: string;
  orderId: string;
  /** Maturity: when this credit starts counting toward the payable balance. */
  availableAt: Date;
  description: string;
  /** Carries `{ items: Record<orderItemId, contributionCents> }`. */
  metadata: unknown;
  sourceKind: string;
  sourceId: string;
}

/**
 * A REFUND_DEBIT: the payee's share of a refunded amount. Written by EVERY
 * refund path (full, partial, admin, reconcile) — the one refund rule is
 * "always write the debit; then, if money already left, try to pull it back"
 * (spec §4).
 *
 * ALWAYS effective: a refund debit reduces the payable balance the instant it
 * is written, even while the credit it nets against is still immature —
 * that asymmetry is the entire P0 fix. Never touches `pendingHoldCents`
 * (holds are the dispute lifecycle's bucket). Sign convention is file-wide:
 * `amountCents` is stored POSITIVE, the adapter decrements
 * `ledgerBalanceCents`.
 */
export interface RefundDebitPayeeLedgerInput {
  /**
   * `refund-debit:${orderId}:${payeeId}:${refundId}` by convention.
   * Idempotent exactly like `hold`/`debit`: a replay returns the existing
   * row without re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /** POSITIVE cents — the payee's share of the refunded amount. */
  amountCents: number;
  currency: string;
  orderId: string;
  description: string;
  sourceKind: string;
  sourceId: string;
  metadata?: unknown | null;
}

/**
 * A TRANSFER_REVERSAL_CREDIT: a post-payout refund's Stripe transfer
 * reversal SUCCEEDED, so the money came back to the platform externally and
 * the payee's balance owes nothing net (spec §4.2). Compensates exactly one
 * REFUND_DEBIT (`relatedEntryId` → the debit), the same linking discipline
 * as DISPUTE_RELEASE → DISPUTE_DEBIT. Sign convention is file-wide:
 * `amountCents` is stored POSITIVE, the adapter increments
 * `ledgerBalanceCents` — debit + reversal net to zero.
 */
export interface TransferReversalCreditPayeeLedgerInput {
  /**
   * Keyed by the reversal it records (e.g.
   * `transfer-reversal-credit:${refundDebitEntryId}`). Idempotent exactly
   * like `hold`/`debit`: a replay returns the existing row without
   * re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /** POSITIVE cents — equal to the REFUND_DEBIT being compensated. */
  amountCents: number;
  currency: string;
  orderId: string;
  /** The REFUND_DEBIT entry this reversal compensates (relatedEntryId). */
  relatedEntryId: string;
  description: string;
  /** Defaults to "transfer_reversal". */
  sourceKind?: string | null;
  /** Defaults to `relatedEntryId`; pass the Stripe reversal id when known. */
  sourceId?: string | null;
  metadata?: unknown | null;
}

/**
 * A CASH_SALE_DEBIT: the tax inside a door cash sale (fee + tax for one
 * recorded before the owner ruling of 2026-10-08), owed by the organiser who
 * holds the cash (spec 2026-10-07 FR-004, owner ruling R6).
 * Sign convention is file-wide: `amountCents` is stored POSITIVE and the
 * adapter DECREMENTS `ledgerBalanceCents`. Always effective, like a refund
 * debit: it never waits for a maturity date.
 */
export interface CashSaleDebitPayeeLedgerInput {
  /**
   * `cash-sale-debit:${orderId}` by convention (one debit per cash order).
   * Idempotent exactly like `hold`/`debit`: a replay returns the existing row
   * without re-applying balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /**
   * POSITIVE cents — the tax the cash sale collected (owner ruling
   * 2026-10-08: no platform fee on cash; older debits also carry the fee).
   */
  amountCents: number;
  currency: string;
  orderId: string;
  description: string;
  sourceKind: string;
  sourceId: string;
  metadata?: unknown | null;
}

/**
 * A CASH_SALE_DEBIT_REVERSAL: the cash sale was refunded at the gate, so
 * what the debit claimed (tax; fee + tax on an older sale) is no longer owed. Amount, payee and currency
 * are COPIED from the debit row (`debitIdempotencyKey`), never passed in, so a
 * reversal can only ever undo exactly what was debited. A debit is reversed at
 * most once, ever: a second reversal under any key returns the first.
 */
export interface CashSaleDebitReversalPayeeLedgerInput {
  /** `cash-sale-debit-reversal:${orderId}` by convention. */
  idempotencyKey: string;
  /** The `idempotencyKey` of the CASH_SALE_DEBIT being reversed. */
  debitIdempotencyKey: string;
  description: string;
  sourceKind: string;
  sourceId: string;
  metadata?: unknown | null;
}

/**
 * A PAYOUT entry recording money OUT: the payout batch consumed
 * `amountCents` of the payee's payable balance. Sign convention is
 * file-wide: `amountCents` is stored POSITIVE, the adapter DECREMENTS
 * `ledgerBalanceCents`.
 *
 * NOTE ON THE LEGACY COLLISION: the pre-cutover debt-recovery writer wrote
 * type PAYOUT with the OPPOSITE (+=) effect — a payout WITHHOLDING squaring
 * dispute debt. That writer is DELETED (spec 2026-08-10 §7); PAYOUT now means
 * money-out, full stop. Its `debt-recovery:${payoutItemId}` key namespace
 * survives only as a discriminator: `listPayableBalances` still reads rows
 * under that prefix POSITIVE so pre-cutover entries in an old database keep
 * agreeing with the rollup effect they applied, and the adapter REFUSES to
 * write a new payout debit under it.
 */
export interface PayoutDebitPayeeLedgerInput {
  /**
   * `payout:${payoutItemId}` by convention (and never the legacy
   * `debt-recovery:` namespace — the adapter throws). Idempotent exactly like
   * `hold`/`debit`: a replay returns the existing row without re-applying
   * balance effects.
   */
  idempotencyKey: string;
  payeeId: string;
  /**
   * POSITIVE cents of PAYABLE CLAIMED by this payout item this cycle —
   * defined positively, NOT by transfer arithmetic: the payable consumed
   * BEFORE any transfer-time withholding (rolling reserve, Connect account
   * fee), and EXCLUDING matured reserve riding along (that was consumed by
   * the cycle that withheld it).
   *
   * Deriving it from the transfer amount is the classic mistake — every
   * withholding you forget becomes phantom payable that pays again:
   *
   *   payable 100, reserve 10            → transfer 90, amountCents 100
   *   payable 100, connect fee 2         → transfer 98, amountCents 100
   *   payable 100, reserve 10, release 5 → transfer 95, amountCents 100
   *
   * Writing the transfer amount (90/98/95) leaves the withheld cents in
   * payable; the next cycle pays them AGAIN, and a later RESERVE_RELEASE
   * doubles the reserve slice on top. (The balance effect is negative.)
   */
  amountCents: number;
  currency: string;
  /** Always "payout_item" — the entry records a PayoutItem's transfer. */
  sourceKind: "payout_item";
  /** The PayoutItem whose transfer this entry records. */
  sourceId: string;
  description: string;
  /**
   * REQUIRED: carries the consumed credit entry ids
   * (`{ consumedCreditEntryIds: string[] }`) — the FIFO attribution record
   * that pairs with `markCreditsConsumed`.
   */
  metadata: unknown;
}

/**
 * Opt-in per-statement budget for the two whole-ledger aggregates
 * (`listPayableBalances`, `sumOutstandingLiability`).
 *
 * OMITTED is the default and is what the PAYOUT BATCH passes: the nightly
 * run has no deadline worth failing for, and its code path is byte-identical
 * to what it has always been. A budget is passed only by INTERACTIVE staff
 * reads, where an unbounded full-ledger aggregate would hang the settlements
 * page. When present the adapter opens its OWN transaction to scope
 * `SET LOCAL jit`/`statement_timeout` to the read, refuses a
 * TransactionClient (INTERNAL) rather than leak those settings onto a
 * caller's work, and maps Postgres's `57014` — or Prisma's `P2028` if the
 * transaction budget ever wins — to `SERVICE_UNAVAILABLE`.
 *
 * The budget changes NOTHING about the arithmetic. A staff read and a batch
 * read of the same instant return the same cents; only the failure mode
 * differs.
 */
export interface PayeeLedgerReadBudget {
  /** Milliseconds, clamped by the adapter to [1, 300000]. */
  statementTimeoutMs?: number;
}

/**
 * One (payee, currency) cell of the payable query — what the payout batch
 * would transfer, before the max(0, ·) clamp and reserve withholding.
 * Negative = a debt position: pay nothing, carry forward, next cycle's
 * arithmetic recoups it.
 */
export interface PayeeLedgerPayableBalance {
  payeeId: string;
  currency: string;
  payableCents: number;
  /**
   * Maturity date of the OLDEST matured, unblocked credit in this cell —
   * "how long has this payee been waiting?". The payout batch orders its
   * planning feed by this so that a `limit` smaller than the number of
   * payable payees starves nobody: a payee skipped tonight has an older
   * `oldestMaturedAt` tomorrow and wins the next cap. Ordering by payeeId
   * instead (the obvious default) hands the same low-id prefix every batch,
   * forever, and degrades silently. Null when the cell's positive balance
   * comes from non-credit entries only.
   */
  oldestMaturedAt: Date | null;
}

/**
 * Total OUTSTANDING LIABILITY for one currency: what the platform owes
 * payees, regardless of when it matures.
 *
 * This is emphatically NOT {@link PayeeLedgerPayableBalance} summed up. The
 * payable answers "what can tonight's batch pay?" and filters on maturity; a
 * credit for an event three weeks out is excluded from it and is still the
 * organiser's money. Reporting payable as liability would show the platform
 * solvent while it was insolvent, which is why the two have separate queries
 * and separate types.
 *
 * The three components are reported SEPARATELY, never pre-summed, because
 * they carry different certainty and a human triaging a thin balance needs to
 * see which one moved. Every component is per-currency; currencies never sum
 * together.
 */
export interface PayeeLedgerLiabilityTotal {
  /** Lowercase ISO-4217, as stored on the entries. */
  currency: string;
  /**
   * Σ over payees of `max(0, signed entry sum)` — every SETTLEMENT_CREDIT at
   * ANY maturity, net of refunds / dispute debits / payouts.
   *
   * The per-payee `max(0, ·)` clamp is load-bearing: a payee in debt does not
   * offset another payee's credit. One organiser's negative balance is not
   * money the platform can spend paying a different organiser, so summing the
   * raw signed totals would UNDERSTATE liability — the dangerous direction.
   */
  unpaidCreditsCents: number;
  /**
   * Σ `PayeeLedgerBalance.reserveBalanceCents` — rolling-reserve cents
   * withheld from past payouts. Deferred payout, not platform revenue: still
   * owed.
   */
  reserveHeldCents: number;
  /**
   * Σ `PayeeLedgerBalance.ledgerPendingHoldCents` — cents held against open
   * disputes. Owed to the payee if the dispute is won and to the network if
   * it is lost; either way not the platform's.
   */
  pendingHoldCents: number;
}

/**
 * One (payee, currency, maturity date) tranche of SETTLEMENT_CREDIT that has
 * NOT matured yet — the forward-looking sibling of
 * {@link PayeeLedgerPayableBalance}.
 *
 * A CREDIT FEED, NOT A BALANCE. `creditCents` is GROSS: SETTLEMENT_CREDIT
 * only — no REFUND_DEBIT, no PAYOUT, no hold, no reserve. Every one of those
 * is effective the moment it is written (see `availableAt`: "credits wait,
 * debits never do" — and `hold()` bumps the pending-hold rollup at write
 * time, which the payable subtracts every night). So all of them have
 * ALREADY moved today's payable, and the ONLY honest netting against a
 * future tranche is the carried-forward DEBT that payable shows: a negative
 * payable today is consumed by the next tranches, soonest first. The use
 * case does that walk; this row never subtracts anything.
 *
 * Consequently `creditCents` is NOT "what this payee will receive on
 * `maturesAt`". Debt aside, maturity is one of several gates: the payout
 * minimum, the per-run payee cap, the batch's eligibility checks and
 * transfer-time withholding all apply at run time, and a refund landing
 * before the date shrinks it. It forecasts MATURITY, not PAYMENT.
 */
export interface PayeeLedgerUpcomingMaturity {
  payeeId: string;
  /** Lowercase, trimmed ISO-4217 — normalised the way the payable query is. */
  currency: string;
  /** `SETTLEMENT_CREDIT.availableAt`, strictly AFTER the read's `asOf`. */
  maturesAt: Date;
  /**
   * GROSS: Σ `amountCents` of the unblocked credits in this tranche. POSITIVE
   * by construction (credits only). Rides `::bigint` → number like the
   * reconciliation reads: diagnostic, never a transfer input.
   */
  creditCents: number;
  /**
   * ANNOTATION ONLY — NEVER AN OPERAND. Σ ACTIVE DISPUTE_HOLD `amountCents`
   * on the orders behind this tranche's credits, for this payee and
   * currency: "this much of the credit is under an open dispute". The hold
   * is ALREADY inside today's payable (it is subtracted unconditionally
   * there), so it reaches the forecast as carried-forward debt; subtracting
   * `heldCents` as well counts it twice — a 7,000 credit under a 3,000 hold
   * pays 4,000 on the night, not 1,000.
   *
   * Attributed ONCE per (payee, currency, order), to the EARLIEST tranche of
   * that order, so an order whose credits mature on two dates shows its hold
   * on one row only. Reported AS WRITTEN — it may exceed one tranche's
   * credit (a hold is sized from the order, a tranche from one maturity) —
   * and it is summed nowhere. "Active" = no DISPUTE_RELEASE / DISPUTE_DEBIT
   * row points at the hold, the same definition `CREDIT_NOT_BLOCKED_SQL` and
   * `findActiveHoldRows` use.
   */
  heldCents: number;
  /** How many credit rows the tranche is made of. */
  creditCount: number;
}

/**
 * A matured, unblocked, not-yet-consumed SETTLEMENT_CREDIT — the unit of
 * FIFO payout attribution. `metadata` carries the item-level breakdown
 * (`{ items: Record<orderItemId, contributionCents> }`) written at credit
 * time.
 */
export interface ConsumablePayeeLedgerCredit {
  id: string;
  orderId: string | null;
  amountCents: number;
  metadata: unknown | null;
}

export interface PayeeLedgerBalanceRecord {
  payeeId: string;
  currency: string;
  ledgerBalanceCents: number;
  pendingHoldCents: number;
  /**
   * Outstanding rolling reserve — DEFERRED payout, reported separately.
   * These cents never entered `ledgerBalanceCents` (they were withheld
   * before the transfer that would have carried them), so they are NOT part
   * of the `availableCents` computation: subtracting them there would count
   * the same money twice.
   */
  reserveCents: number;
  /**
   * `ledgerBalanceCents - pendingHoldCents`. What the payee could be paid
   * out of the LEDGER today: realised balance minus provisional dispute
   * holds. Never reduced by `reserveCents` (see above) — a reserve-only
   * payee reads exactly 0 here, not a negative.
   */
  availableCents: number;
}

/**
 * Options for the payee-scoped entry read (`PayeeLedgerRepo.listEntries`).
 *
 * TWO MODES, and the boundary between them is deliberate. `currency` /
 * `types` / `limit` / `offset` are the plain journal read the method has
 * always been. The four fields BELOW them turn it into the ATTRIBUTION FEED
 * behind a maturity tranche: the individual SETTLEMENT_CREDIT rows a tranche
 * total is made of, so a payouts view can name the order each one came from.
 * Passing none of the four leaves the read byte-for-byte what it was.
 * The last three (`atOrBefore`, `after`, `order`) are the export's snapshot
 * walk; left unset they change nothing either.
 */
export interface ListPayeeLedgerEntriesOptions {
  currency?: string;
  types?: PayeeLedgerEntryType[];
  limit?: number;
  offset?: number;
  /**
   * Keep only entries whose `availableAt` is STRICTLY AFTER this instant.
   *
   * Strict (`>`), matching `PayeeLedgerRepo.listUpcomingMaturities`'s
   * `availableAt > asOf` exactly: pass the SAME `asOf` and these rows are
   * drawn from precisely the tranches that read forecasts. An inclusive
   * bound here would pull in a credit that matured ON the instant — payable
   * today, absent from every tranche — and the sub-lines would out-sum their
   * own heading.
   *
   * CONSEQUENCE WORTH STATING: `availableAt` is NULL on every entry type
   * except SETTLEMENT_CREDIT, and a NULL comparison is false, so passing
   * this bound makes the read CREDITS-ONLY whatever `types` says.
   */
  availableAtAfter?: Date;
  /**
   * Keep only entries whose `availableAt` is AT OR BEFORE this instant —
   * INCLUSIVE (`<=`), asymmetric with {@link availableAtAfter} on purpose so
   * a caller can bound the feed by the last VISIBLE tranche's `maturesAt`
   * and still get that tranche's own rows. Same NULL consequence as above.
   */
  availableAtBefore?: Date;
  /**
   * Keep only entries with `consumedByEntryId IS NULL` — not yet claimed by
   * a payout.
   *
   * NOT PART OF THE TRANCHE-ATTRIBUTION BUNDLE, and it must never be added
   * to it. `listUpcomingMaturities` filters its credit rows on type, payee,
   * maturity and the blocked-credit fragment — and on NOTHING ELSE. It
   * applies no consumption filter, so a tranche counts a consumed credit and
   * an attribution list with this flag would not: heading $40, sub-lines
   * nothing. The rule is one-directional — whatever the tranche counts, the
   * attribution lists — and every extra filter breaks it.
   *
   * It stays on this type because it is legitimate for other callers (a
   * "what is still unpaid" journal view), just not for that one.
   */
  unconsumedOnly?: boolean;
  /**
   * Drop SETTLEMENT_CREDIT rows that are BLOCKED — an order under an open or
   * under-review dispute with no active DISPUTE_HOLD carrying the
   * withholding, or under an open/under-review resale claim.
   *
   * THIS EXISTS SO THE ROWS AGREE WITH `listUpcomingMaturities`. That read
   * applies the same exclusion (the shared `CREDIT_NOT_BLOCKED_SQL`
   * fragment) to its tranche totals. Without this flag, an attribution list
   * under a tranche would include credits the tranche total excluded, and
   * the sub-lines would not sum to the figure printed above them — worse
   * than showing no sub-lines at all. The adapter reuses that one fragment
   * rather than retyping the predicate, so the two cannot drift.
   *
   * Only SETTLEMENT_CREDIT rows are subject to it; every other type passes
   * through untouched (nothing "blocks" a debit).
   */
  excludeBlockedCredits?: boolean;
  /**
   * Keep only entries at or before this (createdAt, id) position — the
   * row-value comparison `(createdAt, id) <= (cursor.createdAt, cursor.id)`,
   * INCLUSIVE, the same total order the read sorts on.
   *
   * THIS IS A SNAPSHOT BOUND, not a filter on meaning. The ledger CSV export
   * (`payouts/export-payee-ledger.ts`) reads the newest entry once, then
   * walks every older one under this bound, so an entry stamped after the
   * cursor read is left out. Belongs to neither mode above; it composes
   * with both.
   */
  atOrBefore?: { createdAt: Date; id: string };
  /**
   * Keep only entries strictly AFTER this (createdAt, id) position —
   * `(createdAt, id) > (cursor.createdAt, cursor.id)`, EXCLUSIVE. The keyset
   * the export pages on: pass the previous page's last row, with no offset.
   *
   * WHY NOT OFFSET. `createdAt` is stamped at INSERT, not at commit, so a
   * transaction that commits late can land a row BEHIND a walk already under
   * way. Under OFFSET that row shifts every later one by a place: the next
   * page repeats a row and the running balance counts it twice. Under this
   * keyset the late row sits behind the position and is simply not read.
   * Meant for `order: "asc"`; with the default descending sort it still
   * filters, but it is not a "next page" there.
   */
  after?: { createdAt: Date; id: string };
  /**
   * Sort direction over (createdAt, id). Default `"desc"` — newest first,
   * `createdAt DESC, id DESC`, what every caller before the export has
   * always read. `"asc"` is the exact reverse (`createdAt ASC, id ASC`), so
   * the `id` tie-break holds in both directions.
   */
  order?: "asc" | "desc";
}

// ── Reconciliation (spec 2026-08-10 §9) ─────────────────────────────────────
//
// Row shapes for the read-only ledger invariant sweep. The sweep REPORTS and
// never repairs — money repair stays human — so these are diagnostic rows,
// not write inputs.

/**
 * One invariant scan result: the TOTAL number of violating rows found in the
 * database plus a capped sample of them. `total` is the count the job reports
 * and alerts on; `rows` is bounded so a pathological drift (every cell wrong)
 * cannot ship megabytes into Sentry/Discord payloads.
 */
export interface PayeeLedgerInvariantScan<TRow> {
  total: number;
  rows: TRow[];
}

/**
 * A (payee, currency) cell whose cached `PayeeLedgerBalance` counters
 * disagree with the counters recomputed from its `PayeeLedgerEntry` rows.
 * All six values are reported (not just the mismatching pair) because a
 * drifted cell is usually diagnosed by which OTHER counters still agree.
 */
export interface PayeeLedgerRollupDriftRow {
  payeeId: string;
  currency: string;
  cachedLedgerBalanceCents: number;
  expectedLedgerBalanceCents: number;
  cachedPendingHoldCents: number;
  expectedPendingHoldCents: number;
  cachedReserveCents: number;
  expectedReserveCents: number;
  /**
   * Entries exist for this cell but no `PayeeLedgerBalance` row does. Every
   * effectful writer upserts the rollup, so a missing row with a non-zero
   * expected counter means an effect was lost (or the row was deleted).
   */
  rollupRowMissing: boolean;
  /**
   * A `PayeeLedgerBalance` row exists but the cell has no entries at all.
   * Entries are append-only, so a non-zero orphan rollup is a counter that
   * was moved without its journal — or a journal that was deleted.
   */
  orphanRollupRow: boolean;
}

/**
 * A (order, payee, currency) cell violating refund conservation:
 * Σ REFUND_DEBIT > Σ SETTLEMENT_CREDIT (a refund clawed back more than was
 * ever granted) and/or Σ TRANSFER_REVERSAL_CREDIT > Σ REFUND_DEBIT (more
 * money "came back" than ever left). Both are asserted at write time by the
 * refund paths; this row means a writer bypassed the assert.
 */
export interface PayeeLedgerConservationViolationRow {
  orderId: string;
  payeeId: string;
  currency: string;
  creditCents: number;
  refundDebitCents: number;
  transferReversalCreditCents: number;
  /**
   * Σ PRINCIPAL DISPUTE_DEBIT on the cell — the `dispute-debit:` namespace
   * only. The `dispute-debit-fee:` twin (Stripe's dispute fee, membership
   * only) is money ON TOP of the credit, not a claim against it, and is
   * excluded from the conservation comparison.
   */
  disputeDebitCents: number;
  /**
   * Σ DISPUTE_RELEASE that compensates a PRINCIPAL DISPUTE_DEBIT
   * (WON-after-LOST, `dispute-debit-reversal:` namespace); the
   * `...-reversal-fee:` twin is excluded to match `disputeDebitCents`.
   */
  disputeDebitReversalCents: number;
  /** Σ fee-namespace DISPUTE_DEBIT on the cell. Reported, never asserted. */
  disputeFeeDebitCents: number;
  /** Σ CASH_SALE_DEBIT on the cell (a door cash sale's tax; fee + tax before 2026-10-08). */
  cashSaleDebitCents: number;
  /**
   * Σ CASH_SALE_DEBIT_REVERSAL on the cell. Asserted ≤ `cashSaleDebitCents`:
   * a gate refund gives back at most what its cash sale debited.
   */
  cashSaleDebitReversalCents: number;
}

/**
 * A door cash sale's CASH_SALE_DEBIT on an event that has been CANCELLED,
 * with no CASH_SALE_DEBIT_REVERSAL. Cancelling an event refunds every cash
 * sale and reverses its debit (owner ruling 2026-10-07), so a row here is an
 * organiser still being charged tax (fee + tax on an older sale) for money
 * they handed back: the
 * cancellation's cash phase and the sweep both failed or never ran.
 */
export interface PayeeLedgerCancelledEventCashDebitRow {
  orderId: string;
  eventId: string;
  payeeId: string;
  currency: string;
  /** The unreversed CASH_SALE_DEBIT, positive cents. */
  cashSaleDebitCents: number;
}

/**
 * A (order, payee) cell that should have SETTLEMENT_CREDIT entries and does
 * not (`creditCents = 0`), or whose credits don't sum to the payee's
 * `OrderSplit` total — the silently-skipped-write failure mode stored totals
 * could never surface (spec §9, "Completeness").
 */
export interface PayeeLedgerCompletenessGapRow {
  orderId: string;
  payeeId: string;
  currency: string;
  expectedFromSplitsCents: number;
  creditCents: number;
}

// ── Debt positions (staff "Payees in debt" view) ────────────────────────────
//
// A (payee, currency) cell whose PAYABLE — the same dated, dispute-aware sum
// `listPayableBalances` computes — is NEGATIVE. The payout batch pays such a
// cell nothing and carries it forward ("debt position"); this read model is
// how ops sees who owes what, since when, and from which debits.

/**
 * The debits that can put a payee in debt. `CASH_SALE_DEBIT` is a door cash
 * sale's tax (spec 2026-10-07, R6; fee + tax before the owner ruling of
 * 2026-10-08): an organiser who sells
 * only cash owes it until their first card revenue nets it.
 */
export type PayeeLedgerDebtDebitType =
  | "DISPUTE_DEBIT"
  | "REFUND_DEBIT"
  | "CASH_SALE_DEBIT";

export interface PayeeLedgerDebtPosition {
  payeeId: string;
  /** From the `Payee` row — who the ledger cell belongs to. */
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  currency: string;
  /**
   * NEGATIVE: the payable as `listPayableBalances` would report it. Read
   * through `::bigint` — display only, never a transfer input — so a cell
   * beyond int4 still LISTS here even though the batch's `::int` would raise.
   */
  payableCents: number;
  /**
   * When the cell's running balance last crossed below zero and stayed
   * there: the `createdAt` of the first entry after the most recent point at
   * which the running signed sum (entries ordered by createdAt, id; each
   * entry weighted with TODAY's effectiveness — maturity, blocking, legacy
   * sign) was still ≥ 0. Null when the negative payable is not attributable
   * to any journal entry — i.e. the entry sum is ≥ 0 and the deficit comes
   * entirely from the rollup's `ledgerPendingHoldCents`, which has no
   * position in the journal.
   */
  debtSinceAt: Date | null;
  /** Type of the most recent DISPUTE_DEBIT / REFUND_DEBIT in the cell. */
  lastDebitType: PayeeLedgerDebtDebitType | null;
  lastDebitAt: Date | null;
  /**
   * Σ PRINCIPAL DISPUTE_DEBIT — the `dispute-debit:` namespace only; the
   * `dispute-debit-fee:` twin (Stripe's fee on membership disputes) is
   * excluded, matching {@link PayeeLedgerConservationViolationRow}.
   */
  disputeDebitCents: number;
  /** Σ REFUND_DEBIT on the cell. */
  refundDebitCents: number;
}

export interface ListPayeeDebtPositionsInput {
  /** The payable clock — the same `asOf` the batch passes. */
  now: Date;
  /** Page size; the adapter clamps to [1, 200]. */
  limit?: number;
  /**
   * Opaque keyset cursor from a prior page's `pageInfo.nextCursor`. A cursor
   * that fails to decode restarts from the top rather than throwing — the
   * same posture as the dispute desk's `listForDesk`.
   */
  cursor?: string | null;
  /**
   * Per-statement budget (default 8000ms, clamped to [1, 300000]). The
   * adapter runs the read in ITS OWN interactive transaction (`SET LOCAL
   * jit = off` + `SET LOCAL statement_timeout`, with the transaction's own
   * timeout set ABOVE this so Postgres fires first) and maps Postgres's
   * `57014` — or Prisma's `P2028` if the transaction budget ever wins — to
   * `SERVICE_UNAVAILABLE` (`payee_ledger_debt_positions_timeout`,
   * `meta.expired` names the budget) so a slow diagnostic degrades to an
   * inline error instead of hanging the page.
   */
  statementTimeoutMs?: number;
}

export interface ListPayeeDebtPositionsResult {
  /** Ordered by `payableCents` ASC (largest debt first), then payeeId, currency. */
  items: PayeeLedgerDebtPosition[];
  pageInfo: {
    cursorField: string;
    nextCursor: string | null;
    limit: number;
    hasNextPage: boolean;
  };
  /**
   * Count of debt cells at or after the cursor (this page included). On the
   * first page — no cursor — that is the grand total, which is what the
   * staff badge reads; later pages report the remainder.
   */
  total: number;
}

// ── Unrecovered cash-sale debt (staff "Unpaid cash balances" view) ──────────
//
// A door cash sale writes a CASH_SALE_DEBIT: the organiser holds the cash,
// and the tax in it is owed to the platform (spec 2026-10-07, R6; the
// platform fee too, for a sale recorded before the owner ruling of
// 2026-10-08: cash = no platform fee). The debit is recovered from later credits (online sales) through the
// ordinary payable arithmetic; a cash-only organiser may never have any.
// This read model lists the cash debt that later credits have NOT covered
// and that is older than a cutoff (FR-013: more than 30 days), so the
// platform can collect it by hand.

/**
 * One (payee, currency) cell with cash-sale debt older than the cutoff that
 * later credits have not recovered. "Recovered" is FIFO: the payee's credits
 * pay its oldest debits first (any debit type), so what stays unpaid is the
 * NEWEST debits that together make up the cell's deficit. The adapter header
 * (`listUnrecoveredCashDebts`) has the definition and the proof that credit
 * timing does not change it.
 */
export interface PayeeLedgerUnrecoveredCashDebt {
  payeeId: string;
  /** From the `Payee` row. Cash payees are organisations today. */
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  /** The organisation's name and slug; null for a HUMAN payee or a missing org row. */
  orgName: string | null;
  orgSlug: string | null;
  currency: string;
  /** Unrecovered cash-sale debt of any age, cents (> 0). */
  unrecoveredCashDebtCents: number;
  /** The part of it from cash debits created before the cutoff, cents (> 0). */
  overdueCashDebtCents: number;
  /** `createdAt` of the oldest cash debit with an unrecovered remainder. */
  oldestUnrecoveredAt: Date;
  /**
   * The payee has a connected Stripe account (`stripeAccountId` set). False
   * = the placeholder payee a first cash sale creates: no online sales, no
   * payouts, so the ledger can never recover this debt by netting.
   */
  hasStripeAccount: boolean;
  /** Stripe reports payouts enabled on the connected account. */
  payoutsEnabled: boolean;
  /**
   * The cell's payable as `listPayableBalances` would report it (journal sum
   * minus the rollup's pending holds). Negative whenever a row is listed,
   * unless a pending hold makes it more negative still.
   */
  payableCents: number;
}

export interface ListUnrecoveredCashDebtsInput {
  /** The payable clock — the same `asOf` the batch passes. */
  now: Date;
  /**
   * Cutoff: a cash debit counts as overdue when its `createdAt` is strictly
   * before this instant. The use case passes `now − 30 days`.
   */
  olderThan: Date;
  /** Page size; the adapter clamps to [1, 200]. */
  limit?: number;
  /** Opaque keyset cursor; an undecodable one restarts from the top. */
  cursor?: string | null;
  /**
   * Per-statement budget, the same contract as
   * {@link ListPayeeDebtPositionsInput.statementTimeoutMs}: default 8000ms,
   * clamped to [1, 300000]; a timeout surfaces as SERVICE_UNAVAILABLE
   * (`payee_ledger_unrecovered_cash_debts_timeout`).
   */
  statementTimeoutMs?: number;
}

export interface ListUnrecoveredCashDebtsResult {
  /** Ordered by `overdueCashDebtCents` DESC (largest first), then payeeId, currency. */
  items: PayeeLedgerUnrecoveredCashDebt[];
  pageInfo: {
    cursorField: string;
    nextCursor: string | null;
    limit: number;
    hasNextPage: boolean;
  };
  /** Cells at or after the cursor; the grand total on the first page. */
  total: number;
}

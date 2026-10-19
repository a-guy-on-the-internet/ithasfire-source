import type {
  CashSaleDebitPayeeLedgerInput,
  CashSaleDebitReversalPayeeLedgerInput,
  ConsumablePayeeLedgerCredit,
  DebitPayeeLedgerInput,
  HoldPayeeLedgerInput,
  ListPayeeDebtPositionsInput,
  ListPayeeDebtPositionsResult,
  ListPayeeLedgerEntriesOptions,
  ListUnrecoveredCashDebtsInput,
  ListUnrecoveredCashDebtsResult,
  PayeeLedgerBalanceRecord,
  PayeeLedgerCancelledEventCashDebitRow,
  PayeeLedgerCompletenessGapRow,
  PayeeLedgerConservationViolationRow,
  PayeeLedgerDebtDebitType,
  PayeeLedgerDebtPosition,
  PayeeLedgerEntryRecord,
  PayeeLedgerEntryType,
  PayeeLedgerInvariantScan,
  PayeeLedgerLiabilityTotal,
  PayeeLedgerPayableBalance,
  PayeeLedgerReadBudget,
  PayeeLedgerRollupDriftRow,
  PayeeLedgerUnrecoveredCashDebt,
  PayeeLedgerUpcomingMaturity,
  PayoutDebitPayeeLedgerInput,
  RefundDebitPayeeLedgerInput,
  ReleasePayeeLedgerHoldInput,
  ReserveHoldPayeeLedgerInput,
  ReserveReleasePayeeLedgerInput,
  ReverseDisputeDebitInput,
  SettlementCreditPayeeLedgerInput,
  TransferReversalCreditPayeeLedgerInput,
} from "@th/types/repos/payee-ledger";

export interface PayeeLedgerRepo {
  hold(input: HoldPayeeLedgerInput): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a DISPUTE_DEBIT. Idempotent exactly like `hold`: unique on
   * `idempotencyKey`, a replay returns the existing row without re-applying
   * any balance effects. Consumes the dispute's active hold for the payee
   * (if one exists) — see the adapter for the balance-rollup mechanics.
   */
  debit(input: DebitPayeeLedgerInput): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a positive DISPUTE_RELEASE that compensates a DISPUTE_DEBIT
   * (`ledgerBalanceCents += amountCents`) after a WON-after-LOST flip. Never
   * touches pending holds — the debit it reverses already consumed any hold.
   * Idempotent exactly like `hold`/`debit`. See
   * {@link ReverseDisputeDebitInput} for the entry-type rationale.
   */
  reverseDisputeDebit(
    input: ReverseDisputeDebitInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a RESERVE_HOLD: rolling-reserve cents withheld from a payout,
   * incrementing `reserveBalanceCents` (`ledgerBalanceCents` untouched — the
   * cents were withheld before the transfer, so the ledger balance never saw
   * them). Idempotent exactly like `hold`/`debit`. See
   * {@link ReserveHoldPayeeLedgerInput} for the rollup semantics.
   */
  reserveHold(input: ReserveHoldPayeeLedgerInput): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a RESERVE_RELEASE terminating one RESERVE_HOLD: amount/currency
   * come from the hold row, `relatedEntryId` links hold → release, and
   * `reserveBalanceCents` is decremented (floored at 0). If the hold is
   * already released — under this key or any other — the existing release is
   * returned untouched (a hold releases at most once, ever). Throws if
   * `holdEntryId` does not name a RESERVE_HOLD row.
   */
  reserveRelease(
    input: ReserveReleasePayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Every RESERVE_HOLD for the given payees that has no linked
   * RESERVE_RELEASE, oldest first (createdAt asc). Feeds the payout batch's
   * release decision AND its crash sweep — one batched query for the run.
   */
  listUnreleasedReserveHolds(
    payeeIds: string[],
  ): Promise<PayeeLedgerEntryRecord[]>;
  /**
   * Sum of RESERVE_RELEASE `amountCents` per payout item (matched on
   * `sourceId`), for the reserve crash sweep: a transferred item stamped with
   * `reserveReleasedCents` may have had some, all or none of its release
   * entries written before a crash — this is how the sweep computes the
   * remainder still owed to the ledger. Items with no releases are absent
   * from the map.
   */
  sumReserveReleasedByPayoutItem(
    payoutItemIds: string[],
  ): Promise<Map<string, number>>;
  /** All DISPUTE_DEBIT entries written for a dispute (amount + fee twins). */
  listDebitsForDispute(disputeId: string): Promise<PayeeLedgerEntryRecord[]>;
  listActiveHoldsByDispute(disputeId: string): Promise<PayeeLedgerEntryRecord[]>;
  releaseHold(
    input: ReleasePayeeLedgerHoldInput,
  ): Promise<PayeeLedgerEntryRecord | null>;
  releaseHoldsForDispute(disputeId: string): Promise<PayeeLedgerEntryRecord[]>;
  getBalance(
    payeeId: string,
    currency: string,
  ): Promise<PayeeLedgerBalanceRecord>;
  /**
   * The payee-scoped journal read: this payee's entries, `createdAt` DESC,
   * `limit` default 50.
   *
   * ALSO the ATTRIBUTION FEED behind ONE maturity tranche: the individual
   * SETTLEMENT_CREDIT rows a tranche's `creditCents` is made of, each with
   * its `orderId`, so a payouts view can name what the tranche is.
   *
   * DO NOT ASSEMBLE THE OPTIONS BY HAND. Call
   * `trancheAttributionOptions` (`@th/core` →
   * `use-cases/payouts/_shared/tranche-attribution`), which is the single
   * definition of the bundle. Written out, it is FOUR options, and three of
   * them are load-bearing:
   *
   *   * `currency` — the tranche's own currency. A tranche is per (payee,
   *     currency, maturesAt); omitting this merges every currency the payee
   *     holds into one list.
   *   * `availableAtAfter` — the PREVIOUS tranche's `maturesAt` for the same
   *     payee and currency, or `asOf` for the first. NOT simply `asOf`:
   *     `asOf` selects the rows behind EVERY upcoming tranche, so 11 Oct and
   *     18 Oct credits render under a "4 Oct" heading.
   *   * `availableAtBefore` — this tranche's `maturesAt`.
   *   * `excludeBlockedCredits` — not optional garnish. The tranche total
   *     already drops blocked credits, so a list without this does not sum
   *     to the heading above it.
   *
   * The two bounds together are a HALF-OPEN window `(previous, this]`, which
   * is expressible only because `availableAtAfter` is strict and
   * `availableAtBefore` is inclusive — that asymmetry exists for exactly
   * this. Adjacent tranches therefore partition the payee's upcoming credits
   * with no row shared and none dropped.
   *
   * `unconsumedOnly` IS NOT PART OF THE BUNDLE. See
   * {@link ListPayeeLedgerEntriesOptions.unconsumedOnly}: the tranche read
   * applies no consumption filter, so adding one here lists fewer rows than
   * the heading counted.
   *
   * Deliberately NOT a second method. One payee-scoped entry read, one set
   * of filters — a `listUpcomingCreditsForPayee` alongside this would be a
   * second place for the blocked-credit rule to rot.
   */
  listEntries(
    payeeId: string,
    opts?: ListPayeeLedgerEntriesOptions,
  ): Promise<PayeeLedgerEntryRecord[]>;
  /**
   * The refund math's order-scoped read (spec §4): every
   * SETTLEMENT_CREDIT / REFUND_DEBIT / TRANSFER_REVERSAL_CREDIT entry with
   * this `orderId`, PLUS the order's DISPUTE_DEBIT and DISPUTE_RELEASE rows
   * (with `relatedEntryId`, so a debit-compensating release can be told
   * from a hold-release), createdAt asc. Refund paths group these by payee
   * to compute the per-payee debit — the credit's `metadata.items` carries
   * the item-level attribution; prior REFUND_DEBITs AND realised dispute
   * debits (`realisedDisputeDebitCentsByPayee`) bound the cumulative clamp
   * (Σ refund + Σ dispute principal ≤ credit per (order, payee)). Holds,
   * payouts and reserves are deliberately excluded: they never enter refund
   * arithmetic. Every consumer branches on `entry.type`; never sum blindly.
   */
  listOrderEntries(orderId: string): Promise<PayeeLedgerEntryRecord[]>;
  /**
   * Batched {@link listOrderEntries}: the same entry types for MANY orders in
   * one query, grouped by `orderId`. Exists because the payout batch needs the
   * net contribution (credit − refund debits + reversals) of every membership
   * order it is paying, and asking per order is an N+1 on the hot path.
   * Orders with no matching entries are absent from the map.
   */
  listOrderEntriesForOrders(
    orderIds: string[],
  ): Promise<Map<string, PayeeLedgerEntryRecord[]>>;
  /**
   * Write a SETTLEMENT_CREDIT: the payee's split of an order, materialized
   * as the entry that IS the source of truth for what they are owed. Carries
   * a REQUIRED `availableAt` maturity date (credits wait for maturity;
   * debits never do — the asymmetry is the design) and REQUIRED `metadata`
   * with the item-level attribution
   * (`{ items: Record<orderItemId, contributionCents> }`).
   * `ledgerBalanceCents += amountCents` on the rollup. Idempotent exactly
   * like `hold`/`debit`: unique on `idempotencyKey`, a replay returns the
   * existing row without re-applying balance effects. See
   * {@link SettlementCreditPayeeLedgerInput}.
   */
  settlementCredit(
    input: SettlementCreditPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a REFUND_DEBIT: the payee's share of a refunded amount, ALWAYS
   * effective immediately — it reduces the payable balance the instant it is
   * written, even while the credit it nets against is still immature.
   * `ledgerBalanceCents -= amountCents`; NEVER touches `pendingHoldCents`
   * (holds belong to the dispute lifecycle). Idempotent exactly like
   * `hold`/`debit`. See {@link RefundDebitPayeeLedgerInput}.
   */
  refundDebit(
    input: RefundDebitPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a TRANSFER_REVERSAL_CREDIT: a post-payout refund's Stripe transfer
   * reversal succeeded, so the money came back externally.
   * `ledgerBalanceCents += amountCents`, netting the linked REFUND_DEBIT
   * (`relatedEntryId`) to zero. Idempotent exactly like `hold`/`debit`. See
   * {@link TransferReversalCreditPayeeLedgerInput}.
   */
  transferReversalCredit(
    input: TransferReversalCreditPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a CASH_SALE_DEBIT: the platform fee + tax inside a door cash sale,
   * owed by the organiser who holds the cash (spec 2026-10-07 FR-004). ALWAYS
   * effective, like `refundDebit`: `ledgerBalanceCents -= amountCents` and the
   * payable drops the instant it is written, so the next payout is reduced by
   * it and a cash-only payee carries the negative balance forward. Never
   * touches pending holds. Idempotent exactly like `hold`/`debit`. Must be
   * called on the sale's transaction so the debit commits with the order.
   */
  cashSaleDebit(
    input: CashSaleDebitPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * Write a CASH_SALE_DEBIT_REVERSAL for the debit named by
   * `debitIdempotencyKey`: amount, payee, currency and order are copied from
   * that row, `relatedEntryId` links reversal → debit, and
   * `ledgerBalanceCents += amountCents` (debit + reversal net to zero).
   * Returns null when no such debit exists (a comp, a fee- and tax-free cash
   * sale, or a cash order recorded before cash debits existed). A debit is
   * reversed at most once, ever: an existing reversal of it (under this key or
   * any other) is returned untouched.
   */
  cashSaleDebitReversal(
    input: CashSaleDebitReversalPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord | null>;
  /**
   * Read the CASH_SALE_DEBIT stored under `debitIdempotencyKey`, the same key
   * {@link cashSaleDebitReversal} names to find the debit it reverses, so a
   * reader sees exactly the row a refund would reverse. Returns it whether or
   * not it has been reversed since. Null when there is no such debit (a comp,
   * a fee- and tax-free cash sale, or a cash order recorded before cash
   * debits existed). Throws when the key holds a row of another type, as the
   * reversal does: that is a key collision, never "no debit".
   */
  findCashSaleDebit(
    debitIdempotencyKey: string,
  ): Promise<PayeeLedgerEntryRecord | null>;
  /**
   * Write a PAYOUT entry recording money OUT: `amountCents` stays POSITIVE
   * (file-wide sign convention — the type carries direction) and
   * `ledgerBalanceCents -= amountCents`. `amountCents` is the PAYABLE
   * CLAIMED by the payout item this cycle — before ANY transfer-time
   * withholding (rolling reserve, Connect account fee) and excluding
   * matured reserve riding along; never derive it from the Stripe transfer
   * amount — see {@link PayoutDebitPayeeLedgerInput.amountCents} for the
   * worked examples including the fee case.
   * PAYOUT now means money-out, full stop: the legacy debt-recovery writer
   * (same type, += effect) is DELETED. Its `debt-recovery:` key namespace
   * survives as a REFUSED prefix here (and as a positive-sign carve-out in
   * {@link listPayableBalances}) purely so pre-cutover rows in an old
   * database still read with the sign their rollup effect applied.
   * Idempotent exactly like `hold`/`debit`.
   */
  payoutDebit(
    input: PayoutDebitPayeeLedgerInput,
  ): Promise<PayeeLedgerEntryRecord>;
  /**
   * THE money query: per (payeeId, currency), the signed sum of ledger
   * entries as of `asOf`, minus `ledgerPendingHoldCents`. This — not the
   * cached rollup — is what the payout batch transfers from.
   *
   * A SETTLEMENT_CREDIT contributes ONLY when it is matured
   * (`availableAt <= asOf`) AND not `blocked` (spec §2): a blocking dispute
   * status (`OPEN`/`UNDER_REVIEW`) excludes the credit ONLY when no ACTIVE
   * DISPUTE_HOLD exists for the same (order, payee, currency) — when a hold
   * exists, the hold IS the withholding mechanism (its cents subtract via
   * pendingHold), and excluding the credit too would punish the same money
   * twice. An open resale claim (`open`/`under_review`) always excludes.
   * Every other effective type contributes unconditionally:
   * TRANSFER_REVERSAL_CREDIT, CASH_SALE_DEBIT_REVERSAL and
   * debit-compensating DISPUTE_RELEASE add, REFUND_DEBIT / DISPUTE_DEBIT /
   * CASH_SALE_DEBIT / PAYOUT subtract (legacy `debt-recovery:`
   * PAYOUT rows add, matching their rollup effect). DISPUTE_HOLD and
   * RESERVE_HOLD / RESERVE_RELEASE are excluded (they live in their own
   * rollup buckets — the hold effect enters via the pendingHold subtraction,
   * reserves never enter the payable at all).
   *
   * Returns NEGATIVE totals as-is: a debt position pays nothing and carries
   * forward; the caller applies the `max(0, ·)` clamp. Never sums across
   * currencies. See the adapter for the dispute-status subtlety (LOST is
   * deliberately NOT excluded — memberships net via the DISPUTE_DEBIT,
   * ticketing via the persisting hold) and the legacy PAYOUT-sign
   * discrimination.
   *
   * `payeeIds` narrows the aggregate to those payees — the payout batch's
   * pre-transfer RE-CHECK uses it so re-running the payable for ONE item
   * costs a bounded index scan instead of a full-ledger aggregate per item.
   * OMITTED (`undefined`) = every payee — the batch's planning read. An
   * EXPLICIT empty array means exactly that: no payees, so no rows.
   *
   * Rows come back ordered by `oldestMaturedAt` ASC (nulls last), then
   * payeeId/currency — oldest-waiting money first, so the batch's payee cap
   * cannot starve a stable low-priority tail. See
   * {@link PayeeLedgerPayableBalance.oldestMaturedAt}.
   */
  listPayableBalances(
    asOf: Date,
    payeeIds?: string[],
    budget?: PayeeLedgerReadBudget,
  ): Promise<PayeeLedgerPayableBalance[]>;
  /**
   * TOTAL OUTSTANDING LIABILITY per currency — what the platform OWES, with
   * no maturity filter at all. The sibling of {@link listPayableBalances},
   * and deliberately a SEPARATE query rather than a reuse of it.
   *
   * Payable answers "what can tonight's batch pay?"; this answers "what do we
   * owe, ever?". A SETTLEMENT_CREDIT for an event three weeks out is absent
   * from the first and present here — it is the organiser's money either way.
   * Using the payable as the liability would report the platform solvent
   * while it was insolvent, so the two must never be conflated.
   *
   * Sign conventions are the payable's, SHARED as SQL rather than retyped
   * (the adapter derives both from one `NON_CREDIT_EFFECT_SQL` fragment):
   * SETTLEMENT_CREDIT + / TRANSFER_REVERSAL_CREDIT + /
   * CASH_SALE_DEBIT_REVERSAL + / debit-compensating DISPUTE_RELEASE + /
   * REFUND_DEBIT − / DISPUTE_DEBIT − / CASH_SALE_DEBIT − / PAYOUT − (legacy
   * `debt-recovery:` rows +, matching the += their deleted writer applied) /
   * DISPUTE_HOLD, RESERVE_*, MANUAL_ADJUSTMENT 0.
   *
   * TWO gates the payable applies are dropped for credits, both on purpose:
   *   * maturity (`availableAt <= asOf`) — the entire point;
   *   * the blocked-credit exclusion (open dispute / open claim) — a credit
   *     under an open dispute is still owed to SOMEBODY (the payee if won,
   *     the network if lost). Excluding it would understate liability.
   *
   * Per (payee, currency) the signed entry sum is CLAMPED AT ZERO before the
   * per-currency sum: one payee's debt cannot fund another payee's credit, so
   * letting a negative cell offset a positive one would understate what is
   * owed. Reserves and pending holds are added as their own components (see
   * {@link PayeeLedgerLiabilityTotal}), each reported separately.
   *
   * READ-ONLY. Cents ride `::bigint` → number like the reconciliation reads
   * (diagnostic, never a transfer input), so a pathological total is REPORTED
   * rather than raising 22003.
   */
  sumOutstandingLiability(
    budget?: PayeeLedgerReadBudget,
  ): Promise<PayeeLedgerLiabilityTotal[]>;

  /**
   * UPCOMING MATURITIES — the forward half of the payable. Per (payee,
   * currency, `availableAt`), the SETTLEMENT_CREDIT cents that are NOT
   * payable yet because `availableAt > asOf`.
   *
   * THE SIBLING OF {@link listPayableBalances}, covering exactly the credit
   * rows that one EXCLUDES on maturity. Payable answers "what can tonight's
   * batch pay?"; this answers "when does the rest become payable?".
   *
   * A CREDIT FEED, NOT A BALANCE. `creditCents` includes NO other entry type
   * — no REFUND_DEBIT, no PAYOUT, no DISPUTE_HOLD, no reserves — and that is
   * the single most important property of this method. All of those are
   * ALREADY EFFECTIVE: debits and payouts reduce the payable the instant they
   * are written (see {@link refundDebit}), and a hold bumps the pending-hold
   * rollup at write time, which the payable subtracts unconditionally every
   * night. So every one of them is accounted for in TODAY's number, and the
   * only honest way to carry any of them forward is through that number: a
   * NEGATIVE payable today (carried-forward debt — including the debt a hold
   * on an immature credit creates) is consumed by the next tranches, soonest
   * first. The use case does that walk from the payable read; this method
   * subtracts nothing, and the adapter must NOT reuse the shared non-credit
   * effect fragment — that fragment exists for SIGNED BALANCE SUMS.
   *
   * `heldCents` is an ANNOTATION of the above, never an operand: how much of
   * the tranche's credit sits under an open dispute. Attributed once per
   * (payee, currency, order) to that order's EARLIEST tranche, reported as
   * written (unclamped), summed nowhere. Subtracting it from `creditCents`
   * counts the hold twice — see {@link PayeeLedgerUpcomingMaturity.heldCents}.
   *
   * ONE gate IS shared with the payable: the blocked-credit exclusion (spec
   * §2, `CREDIT_NOT_BLOCKED_SQL`, reused verbatim). A credit sitting under an
   * open dispute WITHOUT a hold, or under an open resale claim, is not money
   * we should forecast going out — it may end up with the network instead.
   * Note the contrast with {@link sumOutstandingLiability}, which
   * deliberately KEEPS blocked credits: liability must err high, a payout
   * forecast must not.
   *
   * WHAT THIS IS NOT: the sum of this feed for a payee is NOT "what they
   * will receive". Debt aside, maturity is only one of the batch's gates —
   * the payout MINIMUM, the per-run PAYEE CAP, the ELIGIBILITY checks and
   * transfer-time WITHHOLDING are all applied at run time (`run-batch.ts`
   * §2/§3), and a refund landing before `maturesAt` reduces the tranche. It
   * forecasts MATURITY, not PAYMENT, and every consumer must label it that
   * way.
   *
   * `payeeIds` narrows the feed to those payees. POSITIONALLY AND
   * SEMANTICALLY IDENTICAL to {@link listPayableBalances}'s second argument,
   * deliberately: these two are siblings, so a reader who knows one must
   * never be surprised by the other. OMITTED (`undefined`) = every payee —
   * the staff full-ledger read. An EXPLICIT empty array means exactly that:
   * no payees, so no rows. Narrowing is pushed INTO the SQL (a bounded index
   * scan on `payeeId`), never applied as a post-filter over a full-ledger
   * aggregate — filtering in JS would keep exactly the cost this argument
   * exists to avoid. The organiser-facing payouts view is one payee's slice
   * of the SAME read staff get, never a second implementation of it.
   *
   * Ordered `maturesAt` ASC, then `payeeId` ASC, then `currency` ASC.
   * READ-ONLY. Cents ride `::bigint` → number like the reconciliation reads
   * (diagnostic, never a transfer input), so a pathological total is
   * REPORTED rather than raising 22003.
   *
   * When a `budget` is passed this MUST be called on the top-level repos,
   * never inside `repos.tx(...)`: the adapter opens its own transaction to
   * scope `SET LOCAL jit` / `statement_timeout` to the read, and refuses a
   * TransactionClient (INTERNAL) rather than leak those settings onto a
   * caller's work — same contract as the sibling reads.
   */
  listUpcomingMaturities(
    asOf: Date,
    payeeIds?: string[],
    budget?: PayeeLedgerReadBudget,
  ): Promise<PayeeLedgerUpcomingMaturity[]>;

  /**
   * The FIFO consumption feed for one (payee, currency): SETTLEMENT_CREDIT
   * rows that are matured (`availableAt <= asOf`), not blocked (same
   * dispute/claim exclusions as {@link listPayableBalances}) and not yet
   * consumed (`consumedByEntryId IS NULL`), ordered by `availableAt` asc
   * then `createdAt` asc. Attribution only — the payable AMOUNT is
   * `listPayableBalances`'s sum, never a sum over these rows.
   */
  listConsumableCredits(
    payeeId: string,
    currency: string,
    asOf: Date,
  ): Promise<ConsumablePayeeLedgerCredit[]>;
  /**
   * Stamp `consumedByEntryId = payoutEntryId` on the given SETTLEMENT_CREDIT
   * rows. Doubly guarded: only rows whose `consumedByEntryId IS NULL` are
   * updated (a credit is consumed at most once, ever), and the update is
   * scoped to the consuming PAYOUT entry's own payeeId + currency — a buggy
   * caller structurally cannot stamp another payee's credits, and a
   * `payoutEntryId` that names no PAYOUT entry stamps nothing. Returns the
   * number of rows actually stamped — the caller treats a mismatch with
   * `creditEntryIds.length` as a fault (another payout already claimed a
   * credit, or the ids were out of scope).
   */
  markCreditsConsumed(
    creditEntryIds: string[],
    payoutEntryId: string,
  ): Promise<number>;

  /**
   * Staff read: every (payee, currency) cell whose payable — the SAME signed
   * sum as {@link listPayableBalances}, evaluated at `now` — is NEGATIVE,
   * joined to the `Payee` subject, with the debit breakdown and the
   * since-when marker described on {@link PayeeLedgerDebtPosition}. Ordered
   * by `payableCents` ASC (largest debt first), keyset-paginated on
   * (payableCents, payeeId, currency). The drift-guard is structural: the
   * adapter derives both queries from one shared effect fragment, so a cell
   * this lists is exactly a cell the batch would pay nothing.
   *
   * MUST be called on the top-level repos, never inside `repos.tx(...)`:
   * the adapter opens its own transaction to scope `SET LOCAL jit` /
   * `statement_timeout` to this read, and refuses a TransactionClient
   * (INTERNAL) rather than leak those settings onto a caller's work.
   */
  listDebtPositions(
    input: ListPayeeDebtPositionsInput,
  ): Promise<ListPayeeDebtPositionsResult>;

  /**
   * Staff read (FR-013): every (payee, currency) cell holding CASH_SALE_DEBIT
   * money that later credits have not recovered and that was written before
   * `olderThan`. Recovery is FIFO over the cell's debits (oldest paid first),
   * reversals netted against the debit they reverse; see
   * {@link PayeeLedgerUnrecoveredCashDebt} and the adapter header for the
   * definition. Ordered by overdue cents DESC, keyset-paginated.
   *
   * Same transaction posture as {@link listDebtPositions}: MUST be called on
   * the top-level repos (the adapter opens its own transaction for
   * `SET LOCAL jit` / `statement_timeout` and refuses a TransactionClient).
   */
  listUnrecoveredCashDebts(
    input: ListUnrecoveredCashDebtsInput,
  ): Promise<ListUnrecoveredCashDebtsResult>;

  // ── Reconciliation reads (spec 2026-08-10 §9) — READ-ONLY, never repair ───

  /**
   * Recompute every (payee, currency) rollup from its entries and return the
   * cells whose cached `PayeeLedgerBalance` counters disagree — including
   * cells with entries but no rollup row, and orphan rollup rows with no
   * entries. This is the check on THE mutable cached counter the payable
   * query subtracts (`ledgerPendingHoldCents`) that nothing else verifies:
   * the writers clamp their decrements at 0 (`GREATEST(0, ·)`), which BOUNDS
   * drift but also MASKS it, so only a recompute can surface it.
   * `sampleLimit` caps the rows returned; `total` is always the full count.
   */
  listRollupDrift(
    sampleLimit?: number,
  ): Promise<PayeeLedgerInvariantScan<PayeeLedgerRollupDriftRow>>;

  /**
   * Per-(order, payee, currency) conservation: cells where
   * Σ REFUND_DEBIT > Σ SETTLEMENT_CREDIT or
   * Σ TRANSFER_REVERSAL_CREDIT > Σ REFUND_DEBIT. Asserted at write time by
   * the refund paths AND swept here (spec §9) — the sweep catches writers
   * that bypassed the assert.
   */
  listConservationViolations(
    sampleLimit?: number,
  ): Promise<PayeeLedgerInvariantScan<PayeeLedgerConservationViolationRow>>;

  /**
   * Completeness: SUCCEEDED / PART_REFUNDED orders finalized before
   * `finalizedBefore` (the caller's grace cutoff) whose per-payee
   * `OrderSplit` totals are not matched by SETTLEMENT_CREDIT entries —
   * missing entirely, or summing to the wrong amount. Scoped to
   * ledger-era orders only (no `SettlementLine` rows — see the adapter for
   * the era-discrimination rationale).
   */
  listCompletenessGaps(
    finalizedBefore: Date,
    sampleLimit?: number,
  ): Promise<PayeeLedgerInvariantScan<PayeeLedgerCompletenessGapRow>>;

  /**
   * Cancelled-event cash debits: CASH_SALE_DEBIT entries whose order's event
   * is CANCELLED and last changed before `cancelledBefore` (the caller's
   * grace cutoff, so a cancellation whose cash phase is still running is not
   * flagged), with no CASH_SALE_DEBIT_REVERSAL. See
   * {@link PayeeLedgerCancelledEventCashDebitRow}.
   */
  listUnreversedCashSaleDebitsOnCancelledEvents(
    cancelledBefore: Date,
    sampleLimit?: number,
  ): Promise<
    PayeeLedgerInvariantScan<PayeeLedgerCancelledEventCashDebitRow>
  >;
}

export type {
  CashSaleDebitPayeeLedgerInput,
  CashSaleDebitReversalPayeeLedgerInput,
  ConsumablePayeeLedgerCredit,
  DebitPayeeLedgerInput,
  HoldPayeeLedgerInput,
  ListPayeeDebtPositionsInput,
  ListPayeeDebtPositionsResult,
  ListPayeeLedgerEntriesOptions,
  ListUnrecoveredCashDebtsInput,
  ListUnrecoveredCashDebtsResult,
  PayeeLedgerBalanceRecord,
  PayeeLedgerCancelledEventCashDebitRow,
  PayeeLedgerCompletenessGapRow,
  PayeeLedgerConservationViolationRow,
  PayeeLedgerDebtDebitType,
  PayeeLedgerDebtPosition,
  PayeeLedgerEntryRecord,
  PayeeLedgerEntryType,
  PayeeLedgerInvariantScan,
  PayeeLedgerLiabilityTotal,
  PayeeLedgerPayableBalance,
  PayeeLedgerReadBudget,
  PayeeLedgerRollupDriftRow,
  PayeeLedgerUnrecoveredCashDebt,
  PayeeLedgerUpcomingMaturity,
  PayoutDebitPayeeLedgerInput,
  RefundDebitPayeeLedgerInput,
  ReleasePayeeLedgerHoldInput,
  ReserveHoldPayeeLedgerInput,
  ReserveReleasePayeeLedgerInput,
  ReverseDisputeDebitInput,
  SettlementCreditPayeeLedgerInput,
  TransferReversalCreditPayeeLedgerInput,
} from "@th/types/repos/payee-ledger";
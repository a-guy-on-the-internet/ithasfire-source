import {
  Prisma,
  type PayeeLedgerBalance,
  type PayeeLedgerEntry,
} from "@prisma/client";
import { RESALE_CLAIM_WINDOW_DAYS } from "@th/types/repos/resale-listings";
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
  PayeeLedgerCancelledEventCashDebitRow,
  PayeeLedgerCompletenessGapRow,
  PayeeLedgerConservationViolationRow,
  PayeeLedgerDebtDebitType,
  PayeeLedgerDebtPosition,
  PayeeLedgerEntryRecord,
  PayeeLedgerInvariantScan,
  PayeeLedgerLiabilityTotal,
  PayeeLedgerPayableBalance,
  PayeeLedgerReadBudget,
  PayeeLedgerRepo,
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
} from "@th/ports/repos/payee-ledger";

import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

type PrismaWithTransaction = PrismaClientOrTx & {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

/**
 * Entry types that CONSUME a DISPUTE_HOLD (via `relatedEntryId` → the hold).
 * A hold with no consuming entry of one of these types is ACTIVE — its cents
 * still sit in `ledgerPendingHoldCents` and subtract from the payable.
 *
 * Exported so the reconciliation queries below derive their active-hold SQL
 * predicate from THIS list instead of hand-copying it (drift-guard: a second
 * hand-maintained copy of "what releases a hold" is a bug factory —
 * `findActiveHoldRows`, `createDebitEntry` and the sweep must always agree).
 */
export const RELEASE_TYPES = ["DISPUTE_RELEASE", "DISPUTE_DEBIT"] as const;

/**
 * RELEASE_TYPES as a quoted SQL literal list, for fragments that must stay
 * BIND-FREE (CREDIT_NOT_BLOCKED_SQL is composed into builders whose bound
 * value positions are pinned by tests). The values are this module's own
 * enum constants, never input.
 */
const RELEASE_TYPES_SQL_LIST = Prisma.raw(
  RELEASE_TYPES.map((type) => `'${type}'`).join(", "),
);

const toNullableJson = (
  value: unknown | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

export function makePayeeLedgerRepo(p: PrismaClientOrTx): PayeeLedgerRepo {
  return {
    hold: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createHoldEntry(tx, input);
        if (created) {
          await incrementPendingHold(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            input.amountCents,
          );
        }
        return entry;
      }),

    debit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, applied] = await createDebitEntry(tx, input);
        if (applied.created) {
          // Sign convention: the ENTRY stores a positive amount (the type
          // carries direction, exactly like holds/releases); the BALANCE
          // rollup moves. A debit is real money owed, so it always decrements
          // ledgerBalanceCents. If it consumed a hold, the hold's provisional
          // pending-hold effect is removed at the same time — the net
          // available delta from hold→debit is (holdCents - debitCents), not
          // a double count.
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            -input.amountCents,
          );
          if (applied.consumedHold) {
            await decreasePendingHoldWithoutGoingNegative(
              tx,
              applied.consumedHold.payeeId,
              applied.consumedHold.currency,
              applied.consumedHold.amountCents,
            );
          }
        }
        return entry;
      }),

    reverseDisputeDebit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createDebitReversalEntry(tx, input);
        if (created) {
          // Compensates a realised debit: mirrors the debit's direction,
          // inverted —
          // the entry stores a positive amount (type carries direction), and
          // the rollup moves ledgerBalanceCents UP by exactly what the debit
          // took. Pending holds are untouched — the debit being reversed
          // already consumed any hold, so there is no provisional effect left
          // to unwind.
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            input.amountCents,
          );
        }
        return entry;
      }),

    reserveHold: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createReserveHoldEntry(tx, input);
        if (created) {
          // Rollup semantics (see ReserveHoldPayeeLedgerInput): a hold moves
          // ONLY reserveBalanceCents, upward — the cents are deferred payout
          // sitting on the platform balance. ledgerBalanceCents is untouched
          // on purpose: it never saw these cents (they were withheld before
          // the transfer), so there is no debit to mirror. Effects applied
          // only when the row was actually created — a replay is a no-op,
          // file-wide convention.
          await incrementReserveBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            input.amountCents,
          );
        }
        return entry;
      }),

    reserveRelease: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const hold = await tx.payeeLedgerEntry.findUnique({
          where: { id: input.holdEntryId },
        });
        if (!hold || hold.type !== "RESERVE_HOLD") {
          throw new Error("payee_ledger_reserve_release_hold_not_found");
        }
        const [entry, created] = await createReserveReleaseEntry(tx, hold, input);
        if (created) {
          // Inverse of the hold's rollup: reserveBalanceCents comes back
          // down by exactly the hold's amount. Floored at 0 like the
          // pending-hold guard — a legitimate release can never take the
          // rollup negative, so a clamp only ever masks (and bounds) an
          // upstream double-write.
          await decreaseReserveBalanceWithoutGoingNegative(
            tx,
            hold.payeeId,
            hold.currency,
            hold.amountCents,
          );
        }
        return entry;
      }),

    listUnreleasedReserveHolds: async (payeeIds) => {
      if (payeeIds.length === 0) return [];
      const rows = await p.payeeLedgerEntry.findMany({
        where: {
          payeeId: { in: payeeIds },
          type: "RESERVE_HOLD",
          relatedEntries: { none: { type: { in: ["RESERVE_RELEASE"] } } },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapPayeeLedgerEntry);
    },

    sumReserveReleasedByPayoutItem: async (payoutItemIds) => {
      if (payoutItemIds.length === 0) return new Map<string, number>();
      const groups = await p.payeeLedgerEntry.groupBy({
        by: ["sourceId"],
        where: {
          type: "RESERVE_RELEASE",
          sourceId: { in: payoutItemIds },
        },
        _sum: { amountCents: true },
      });
      return new Map(
        groups.map((g) => [g.sourceId, g._sum.amountCents ?? 0] as const),
      );
    },

    listDebitsForDispute: async (disputeId) => {
      const rows = await p.payeeLedgerEntry.findMany({
        where: { disputeId, type: "DISPUTE_DEBIT" },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapPayeeLedgerEntry);
    },

    listActiveHoldsByDispute: async (disputeId) => {
      const rows = await findActiveHoldRows(p, disputeId);
      return rows.map(mapPayeeLedgerEntry);
    },

    releaseHold: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const hold = await tx.payeeLedgerEntry.findUnique({
          where: { id: input.holdEntryId },
        });
        if (!hold) return null;
        return releaseHoldRow(tx, hold, input);
      }),

    releaseHoldsForDispute: (disputeId) =>
      withLedgerTransaction(p, async (tx) => {
        const holds = await findActiveHoldRows(tx, disputeId);
        const releases: PayeeLedgerEntryRecord[] = [];

        for (const hold of holds) {
          const release = await releaseHoldRow(tx, hold, {
            holdEntryId: hold.id,
          });
          if (release) releases.push(release);
        }

        return releases;
      }),

    getBalance: async (payeeId, currency) => {
      const normalizedCurrency = normalizeCurrency(currency);
      const row = await p.payeeLedgerBalance.findUnique({
        where: {
          payeeId_currency: { payeeId, currency: normalizedCurrency },
        },
      });
      return mapBalance(payeeId, normalizedCurrency, row);
    },

    listEntries: async (payeeId, opts = {}) => {
      // TWO PATHS, and the split is the point. The plain journal read stays
      // the exact Prisma `findMany` it has always been — untouched bytes for
      // every existing caller. Only the attribution options (maturity window
      // / unconsumed / blocked-credit exclusion) take the raw-SQL path,
      // because the blocked-credit rule is a correlated predicate over
      // Order, PayeeLedgerEntry and Claim that Prisma's query builder cannot
      // express, and the ONLY acceptable implementation of it is the SHARED
      // CREDIT_NOT_BLOCKED_SQL fragment listUpcomingMaturities already uses.
      // Re-expressing it in `where:` would be the second copy that drifts.
      if (needsFilteredEntryScan(opts)) {
        return listFilteredEntries(p, payeeId, opts);
      }
      const direction = opts.order ?? "desc";
      const rows = await p.payeeLedgerEntry.findMany({
        where: {
          payeeId,
          currency: opts.currency ? normalizeCurrency(opts.currency) : undefined,
          type: opts.types && opts.types.length > 0 ? { in: opts.types } : undefined,
          // The export's snapshot bound `(createdAt, id) <= cursor` and its
          // keyset `(createdAt, id) > after`, spelled out for a query builder
          // with no row-value comparison. Each is an `OR`, so they go under
          // `AND`. Absent unless asked for, so the plain read keeps its old
          // `where`.
          ...(opts.atOrBefore || opts.after
            ? {
                AND: [
                  ...(opts.atOrBefore
                    ? [
                        {
                          OR: [
                            { createdAt: { lt: opts.atOrBefore.createdAt } },
                            {
                              createdAt: opts.atOrBefore.createdAt,
                              id: { lte: opts.atOrBefore.id },
                            },
                          ],
                        },
                      ]
                    : []),
                  ...(opts.after
                    ? [
                        {
                          OR: [
                            { createdAt: { gt: opts.after.createdAt } },
                            {
                              createdAt: opts.after.createdAt,
                              id: { gt: opts.after.id },
                            },
                          ],
                        },
                      ]
                    : []),
                ],
              }
            : {}),
        },
        // `id` DESC is a TIE-BREAK, not decoration, and it matches the
        // filtered path's `ORDER BY e."createdAt" DESC, e."id" DESC` byte for
        // byte. `createdAt` alone is not a total order — credits for one
        // order are written in a single transaction and routinely share a
        // timestamp — so under OFFSET paging Postgres is free to return tied
        // rows in a different order per page, which silently duplicates one
        // row and drops another. The organiser statement pages this read.
        orderBy: [{ createdAt: direction }, { id: direction }],
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
      });
      return rows.map(mapPayeeLedgerEntry);
    },

    listOrderEntries: async (orderId) => {
      const rows = await p.payeeLedgerEntry.findMany({
        where: {
          orderId,
          type: {
            in: [
              "SETTLEMENT_CREDIT",
              "REFUND_DEBIT",
              "TRANSFER_REVERSAL_CREDIT",
              // Dispute principal debits (and the releases that compensate
              // them on WON-after-LOST) are claims against the same credit:
              // the refund clamp and the dispute-loss cap both subtract
              // them (`realisedDisputeDebitCentsByPayee`). Without these a
              // partial LOST + full refund clawed credit + debit.
              "DISPUTE_DEBIT",
              "DISPUTE_RELEASE",
            ],
          },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapPayeeLedgerEntry);
    },

    listOrderEntriesForOrders: async (orderIds) => {
      const grouped = new Map<string, PayeeLedgerEntryRecord[]>();
      if (orderIds.length === 0) return grouped;
      // One query for every order the caller cares about — the batched twin
      // of listOrderEntries above (same type filter, same createdAt ordering
      // WITHIN each group, since a stable global sort preserves per-group
      // order when bucketed).
      const rows = await p.payeeLedgerEntry.findMany({
        where: {
          orderId: { in: [...new Set(orderIds)] },
          type: {
            in: [
              "SETTLEMENT_CREDIT",
              "REFUND_DEBIT",
              "TRANSFER_REVERSAL_CREDIT",
              // Dispute principal debits (and the releases that compensate
              // them on WON-after-LOST) are claims against the same credit:
              // the refund clamp and the dispute-loss cap both subtract
              // them (`realisedDisputeDebitCentsByPayee`). Without these a
              // partial LOST + full refund clawed credit + debit.
              "DISPUTE_DEBIT",
              "DISPUTE_RELEASE",
            ],
          },
        },
        orderBy: { createdAt: "asc" },
      });
      for (const row of rows) {
        if (!row.orderId) continue;
        const list = grouped.get(row.orderId);
        if (list) list.push(mapPayeeLedgerEntry(row));
        else grouped.set(row.orderId, [mapPayeeLedgerEntry(row)]);
      }
      return grouped;
    },

    settlementCredit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createSettlementCreditEntry(tx, input);
        if (created) {
          // Sign convention, file-wide: the entry stores a positive amount
          // and the type carries direction. A settlement credit is earned
          // revenue, so the un-dated rollup goes UP by the full amount —
          // maturity (`availableAt`) lives on the ENTRY and is consulted only
          // by the payable query; the rollup deliberately counts immature
          // credits (it is the reconciliation job's cheap cross-check, never
          // a transfer input).
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            input.amountCents,
          );
        }
        return entry;
      }),

    refundDebit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createRefundDebitEntry(tx, input);
        if (created) {
          // A refund debit is ALWAYS effective — it decrements the rollup the
          // instant it is written, even while the credit it nets against is
          // still immature (the asymmetry is the P0 fix). pendingHold is
          // deliberately untouched: holds belong to the dispute lifecycle,
          // and a refund is not a dispute.
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            -input.amountCents,
          );
        }
        return entry;
      }),

    transferReversalCredit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createTransferReversalCreditEntry(
          tx,
          input,
        );
        if (created) {
          // Mirrors `reverseDisputeDebit`'s direction, compensating a
          // realised REFUND_DEBIT: the money came back externally via the
          // Stripe transfer reversal, so the rollup moves back UP by exactly
          // what the debit took — debit + reversal net to zero. Pending
          // holds are untouched.
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            input.amountCents,
          );
        }
        return entry;
      }),

    cashSaleDebit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createCashSaleDebitEntry(tx, input);
        if (created) {
          // Always effective, exactly like a refund debit: the tax (fee + tax
          // on a sale before 2026-10-08) is owed the moment the organiser
          // takes the cash, so the rollup goes
          // DOWN now and the next payout is reduced by it. Pending holds are
          // untouched (a cash sale is not a dispute).
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            -input.amountCents,
          );
        }
        return entry;
      }),

    cashSaleDebitReversal: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const result = await createCashSaleDebitReversalEntry(tx, input);
        if (!result) return null;
        const [entry, created] = result;
        if (created) {
          // Undoes the debit to the cent: amount, payee and currency were
          // copied from the debit row, so debit + reversal net to zero.
          await incrementLedgerBalance(
            tx,
            entry.payeeId,
            normalizeCurrency(entry.currency),
            entry.amountCents,
          );
        }
        return entry;
      }),

    findCashSaleDebit: async (debitIdempotencyKey) => {
      const debit = await p.payeeLedgerEntry.findUnique({
        where: { idempotencyKey: debitIdempotencyKey },
      });
      if (!debit) return null;
      if (debit.type !== "CASH_SALE_DEBIT") {
        throw new Error("payee_ledger_cash_sale_debit_key_not_a_debit");
      }
      return mapPayeeLedgerEntry(debit);
    },

    payoutDebit: (input) =>
      withLedgerTransaction(p, async (tx) => {
        const [entry, created] = await createPayoutDebitEntry(tx, input);
        if (created) {
          // Money OUT: the transfer left the platform, so the rollup goes
          // DOWN. The pre-cutover debt-recovery writer used the SAME type
          // (PAYOUT) with the OPPOSITE (+=) effect; it is DELETED (spec
          // 2026-08-10 §7). Only its key namespace survives, as the
          // sign discriminator for legacy rows in listPayableBalances.
          await incrementLedgerBalance(
            tx,
            input.payeeId,
            normalizeCurrency(input.currency),
            -input.amountCents,
          );
        }
        return entry;
      }),

    listPayableBalances: (asOf, payeeIds, budget) =>
      listPayableBalances(p, asOf, payeeIds, budget),

    listConsumableCredits: (payeeId, currency, asOf) =>
      listConsumableCredits(p, payeeId, normalizeCurrency(currency), asOf),

    listDebtPositions: (input) => listDebtPositions(p, input),

    listUnrecoveredCashDebts: (input) => listUnrecoveredCashDebts(p, input),

    markCreditsConsumed: async (creditEntryIds, payoutEntryId) => {
      if (creditEntryIds.length === 0) return 0;
      // The consuming PAYOUT entry is the scope authority: its payeeId +
      // currency gate the UPDATE, so a buggy caller passing another payee's
      // credit ids STRUCTURALLY cannot stamp them — those rows fall out of
      // the WHERE and the count mismatch surfaces the bug. A payoutEntryId
      // that names no PAYOUT entry stamps nothing (count 0) for the same
      // reason.
      const payoutEntry = await p.payeeLedgerEntry.findUnique({
        where: { id: payoutEntryId },
      });
      if (!payoutEntry || payoutEntry.type !== "PAYOUT") return 0;
      // Legacy debt-recovery rows share the PAYOUT type but are debt
      // squaring, not consumption — refuse them as a consuming entry so a
      // buggy caller cannot stamp credits against a recovery row. (The
      // writer is gone; pre-cutover rows can still exist.)
      if (payoutEntry.idempotencyKey.startsWith("debt-recovery:")) return 0;
      // Guard on `consumedByEntryId IS NULL`: a credit is consumed at most
      // once, ever. The count is returned rather than asserted here — the
      // caller (the payout batch) treats a mismatch with
      // creditEntryIds.length as a fault, because it means another payout
      // already claimed one of the credits (or the ids were out of scope).
      const result = await p.payeeLedgerEntry.updateMany({
        where: {
          id: { in: creditEntryIds },
          type: "SETTLEMENT_CREDIT",
          payeeId: payoutEntry.payeeId,
          currency: payoutEntry.currency,
          consumedByEntryId: null,
        },
        data: { consumedByEntryId: payoutEntryId },
      });
      return result.count;
    },

    sumOutstandingLiability: (budget) => sumOutstandingLiability(p, budget),

    listUpcomingMaturities: (asOf, payeeIds, budget) =>
      listUpcomingMaturities(p, asOf, payeeIds, budget),

    listRollupDrift: (sampleLimit) => listRollupDrift(p, sampleLimit),

    listConservationViolations: (sampleLimit) =>
      listConservationViolations(p, sampleLimit),

    listCompletenessGaps: (finalizedBefore, sampleLimit) =>
      listCompletenessGaps(p, finalizedBefore, sampleLimit),

    listUnreversedCashSaleDebitsOnCancelledEvents: (
      cancelledBefore,
      sampleLimit,
    ) =>
      listUnreversedCashSaleDebitsOnCancelledEvents(
        p,
        cancelledBefore,
        sampleLimit,
      ),
  };
}

// ── The payable query ───────────────────────────────────────────────────────
//
// Per (payeeId, currency), the signed sum of ledger entries as of `asOf`,
// minus the rollup's ledgerPendingHoldCents. THE money query: this — never
// the cached ledgerBalanceCents — is what the payout batch transfers from
// (spec 2026-08-10, ledger-authoritative-settlement §2).
//
// Signed effects:
//   SETTLEMENT_CREDIT          +   only if matured AND not blocked (below)
//   TRANSFER_REVERSAL_CREDIT   +   always
//   CASH_SALE_DEBIT_REVERSAL   +   always (a gate refund of a cash sale)
//   DISPUTE_RELEASE            +   only when it compensates a DISPUTE_DEBIT
//   REFUND_DEBIT               −   always
//   DISPUTE_DEBIT              −   always
//   CASH_SALE_DEBIT            −   always: tax the organiser collected in
//                                  cash and owes the platform (spec
//                                  2026-10-07 FR-004; fee + tax before the
//                                  owner ruling of 2026-10-08); a cash-only payee goes
//                                  negative and carries it forward
//   PAYOUT                     −   except legacy debt-recovery rows (below)
//   DISPUTE_HOLD / RESERVE_*       excluded — they live in their own rollup
//                                  buckets (holds enter via the pendingHold
//                                  subtraction; reserves never enter payable)
//   MANUAL_ADJUSTMENT              excluded — zero writers exist today; wired
//                                  when the ledger-admin correction tool lands
//
// A SETTLEMENT_CREDIT contributes ONLY if:
//   * it is MATURE (`creditMaturedSql`): availableAt <= asOf (credits wait,
//     debits never do) AND, for a RESALE order, the claim window measured
//     from the event's CURRENT end has closed, AND
//   * it is not `blocked` (spec §2):
//       blocked := order disputeStatus in (OPEN, UNDER_REVIEW)
//                  AND no ACTIVE DISPUTE_HOLD exists for the same
//                  (order, payee, currency)
//                  OR order has an open Claim, or an APPROVED one whose
//                  money is not yet accounted for by a refund debit,
//                  dispute debit, active dispute hold, or REFUNDED status
//     The active-hold carve-out is load-bearing: the dispute lifecycle
//     (core/use-cases/disputes/shared.ts) writes Order.disputeStatus AND a
//     per-payee DISPUTE_HOLD in the same pass. When the hold exists, the
//     hold IS the withholding mechanism — its cents already subtract via
//     pendingHoldCents, so letting the status exclusion fire too would
//     punish the same money twice (credit excluded AND hold subtracted).
//     The status exclusion only carries the case where NO hold was written
//     (e.g. zero-amount disputes). "Active" = a DISPUTE_HOLD with no
//     consuming DISPUTE_RELEASE / DISPUTE_DEBIT related to it — the same
//     definition as findActiveHoldRows above.
//   * open-Claim list = ('open', 'under_review'), the same status list as
//     claims.settlementIdsWithOpenClaims, joined directly on orderId (no
//     settlement tables in the new model). PLUS 'approved' until the money
//     is accounted for elsewhere (see CREDIT_NOT_BLOCKED_SQL): approval
//     commits before the refund, which can fail, stay pending, or never run.
//
// THE DISPUTE-STATUS LIST IS DELIBERATELY NOT THE LEGACY ONE. Today's
// BLOCKED_SETTLEMENT_DISPUTE_STATUSES is [OPEN, UNDER_REVIEW, LOST]; here
// 'LOST' is deliberately ABSENT. A LOST dispute's punishment is exactly one
// mechanism: the LOST close converts each payee's hold into a realised
// DISPUTE_DEBIT (− above) — the credit re-enters and the debit nets it — on
// BOTH product lines (core/use-cases/disputes/shared.ts `debitDisputeLoss`).
// They differ only on Stripe's dispute fee: memberships get a second fee
// debit, ticketing never does (platform-borne). Until 2026-09 ticketing LOST
// wrote no debit and the standing hold's pendingHoldCents subtraction was the
// punishment; that path is gone, and any pre-cutover ticketing hold that was
// never consumed still nets the same way (credit re-enters, hold subtracts).
// The cell nets correctly ONLY because LOST is absent from the exclusion
// list; copying the legacy 3-status list would punish LOST twice (spec §5,
// "exactly one mechanism per dispute state"). Do not "fix" this against the
// legacy list.
//
// DISPUTE_RELEASE is split by what it relates to because the writer above is
// two different operations sharing one type: `releaseHold` (relatedEntry is a
// DISPUTE_HOLD; its whole effect is the pendingHold decrement the rollup
// already carries — counting the entry as + would hand the payee free money
// on every hold→release cycle) vs `reverseDisputeDebit` (relatedEntry is a
// DISPUTE_DEBIT; the + compensates the debit's −). Discriminating on the
// related entry's type keeps every dispute cell's net equal to today's
// getBalance() outcomes, which spec §5 mandates.
//
// PAYOUT sign, legacy discrimination: the pre-cutover debt-recovery writer
// (DELETED in the batch-rewrite step) wrote the SAME type with the OPPOSITE
// rollup effect (+= — a payout WITHHOLDING squaring dispute debt). Reading
// those rows as − would double-count the debt against the payee, so PAYOUT
// rows are discriminated by their key namespace: idempotencyKey LIKE
// 'debt-recovery:%' counts POSITIVE (matching the += their rollup effect
// applied, keeping query↔rollup agreement); every other PAYOUT row counts
// negative (money out). The namespaces cannot collide — `payoutDebit`
// THROWS on the legacy prefix — so no NEW row can ever land on the positive
// branch; it exists only for entries written before the cutover, which the
// reconciliation job (spec §9) flags.
//
// Negative totals are returned AS-IS: a negative payable is a debt position —
// pay nothing, carry forward; the CALLER applies the max(0, ·) clamp.
// Currencies never sum together (grouped per currency).
//
// Tables are schema-qualified (public.*) to keep this raw query independent
// of the connection's runtime search_path — Neon's pooled endpoint can
// briefly return connections with an empty search_path on compute wake-up,
// surfacing as 42P01 "relation does not exist" (same reasoning as
// claims.settlementIdsWithOpenClaims).
// Blocked-credit predicate (spec §2), TRUE when the credit row `e` is NOT
// blocked. Shared by listPayableBalances and listConsumableCredits as one
// composed fragment so the payable sum and the consumption feed structurally
// cannot drift — a credit the sum counts must be consumable and vice versa
// (drift-guard: the guarantee is the shared fragment, not reviewer
// discipline). Semantics:
//   * a blocking dispute status (OPEN/UNDER_REVIEW) excludes the credit ONLY
//     when no ACTIVE hold carries the withholding — when a hold exists, the
//     hold IS the mechanism (its cents subtract via pendingHoldCents);
//     "active" = not consumed by a DISPUTE_RELEASE/DISPUTE_DEBIT, the same
//     definition as findActiveHoldRows.
//   * an open Claim on the order always excludes, with no time bound: a
//     claim is never closed automatically (owner ruling Q9, 2026-10-06), so
//     an open / under_review claim holds the credit past the claim-window
//     close until staff approve or deny it. And so does an approved
//     one until the money is accounted for elsewhere (order REFUNDED, or a
//     refund debit / principal dispute debit / active dispute hold on the
//     same cell) — the approved freeze never stacks with a debit or hold.
// Constant fragment — no interpolated parameters.
//
// RESERVED ALIASES: the fragment binds `e` (the credit row under test) from
// the caller's scope and introduces `o` (Order), `h` (hold), `r` (release),
// `cl` / `cla` (Claim), `clo` (the claim's Order), `cx` (a covering
// debit/hold), `cxr` (a hold's release) and `cxr2` (a debit's reversal) of
// its own. A caller must alias
// its entry row `e` and must not reuse any of these names for an outer
// table, or the correlated references silently rebind to the inner scope.
//
// Exported for the SQL-shape unit tests only.
export const CREDIT_NOT_BLOCKED_SQL = Prisma.sql`
  NOT (
    EXISTS (
      SELECT 1 FROM public."Order" o
      WHERE o."id" = e."orderId"
        AND o."disputeStatus" IN ('OPEN', 'UNDER_REVIEW')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public."PayeeLedgerEntry" h
      WHERE h."type" = 'DISPUTE_HOLD'
        AND h."orderId" = e."orderId"
        AND h."payeeId" = e."payeeId"
        AND h."currency" = e."currency"
        AND NOT EXISTS (
          SELECT 1 FROM public."PayeeLedgerEntry" r
          WHERE r."relatedEntryId" = h."id"
            AND r."type" IN ('DISPUTE_RELEASE', 'DISPUTE_DEBIT')
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public."Claim" cl
    WHERE cl."orderId" = e."orderId"
      AND cl."status" IN ('open', 'under_review')
  )
  -- An APPROVED claim keeps freezing while the money it is owed back for is
  -- accounted for NOWHERE ELSE. review-claim commits the approval BEFORE the
  -- Stripe refund, and the refund can then fail (approval record failed,
  -- admin retries), stay pending (the charge.refunded webhook finalises it
  -- later), or never run (no payment intent) — the credit must not pay out
  -- meanwhile.
  --
  -- The rule: this freeze NEVER stacks with another mechanism on the same
  -- money, or the payee is punished twice (credit excluded AND a debit/hold
  -- subtracted — and with a LOST debit nothing would ever lift it). So it
  -- lifts once the order is REFUNDED (the normal terminal: markRefunded
  -- commits with the REFUND_DEBITs) or the (order, payee, currency) cell
  -- carries any of:
  --   * a REFUND_DEBIT — the refund (or reconcile's ledger-only degrade,
  --     which writes debits without flipping the status) is netting it;
  --   * an UNREVERSED principal DISPUTE_DEBIT — a LOST chargeback is
  --     netting it (a debit later reversed by WON-after-LOST gave the money
  --     back, so it does not; nor does the 'dispute-debit-fee:' namespace,
  --     which is money ON TOP of the credit, not a claim against it);
  --   * an ACTIVE DISPUTE_HOLD (same "active" definition as the dispute arm
  --     above) — the hold is withholding it via pendingHoldCents. A hold
  --     RELEASED on a WON dispute withholds nothing, so the freeze returns.
  --
  -- Accepted imprecision: a PARTIAL refund debit lifts the freeze for the
  -- whole credit. The remainder can then pay out before the approved full
  -- refund lands; the later debit is recouped from the payee's next payouts
  -- (a debt position), never double-punished.
  --
  -- Shape (performance): the claim test is an EXISTS correlated on orderId
  -- ALONE, so Postgres runs it once as a hashed subplan instead of once per
  -- credit row; the per-(payee, currency) covering check is correlated on
  -- three columns and so cannot be hashed — the CASE makes it run ONLY for
  -- credits whose order has an approved, unrefunded claim.
  AND CASE
    WHEN EXISTS (
      SELECT 1 FROM public."Claim" cla
      WHERE cla."orderId" = e."orderId"
        AND cla."status" = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM public."Order" clo
          WHERE clo."id" = cla."orderId"
            AND clo."status" = 'REFUNDED'
        )
    )
    THEN EXISTS (
      SELECT 1 FROM public."PayeeLedgerEntry" cx
      WHERE cx."orderId" = e."orderId"
        AND cx."payeeId" = e."payeeId"
        AND cx."currency" = e."currency"
        AND (
          cx."type" = 'REFUND_DEBIT'
          OR (
            cx."type" = 'DISPUTE_DEBIT'
            AND cx."idempotencyKey" NOT LIKE 'dispute-debit-fee:%'
            -- A principal debit REVERSED (WON after LOST: a DISPUTE_RELEASE
            -- related to the debit) gave the money back to the payee, so it
            -- no longer nets the credit and must not lift the freeze. Same
            -- netting as core's realisedDisputeDebitCentsByPayee, and the
            -- same "consumed means inactive" reading as the hold arm below.
            AND NOT EXISTS (
              SELECT 1 FROM public."PayeeLedgerEntry" cxr2
              WHERE cxr2."relatedEntryId" = cx."id"
                AND cxr2."type" = 'DISPUTE_RELEASE'
            )
          )
          OR (
            cx."type" = 'DISPUTE_HOLD'
            AND NOT EXISTS (
              SELECT 1 FROM public."PayeeLedgerEntry" cxr
              WHERE cxr."relatedEntryId" = cx."id"
                AND cxr."type" IN (${RELEASE_TYPES_SQL_LIST})
            )
          )
        )
    )
    ELSE TRUE
  END
`;

/**
 * The signed per-entry effect on the payable, as one composable fragment —
 * the CASE that `listPayableBalances` SUMs. Bound to a row alias `e` (the
 * caller's FROM must alias `public."PayeeLedgerEntry"` as `e`; the nested
 * CREDIT_NOT_BLOCKED_SQL additionally reserves `o`, `h`, `r`, `cl`, `cla`,
 * `clo`, `cx`, `cxr`, `cxr2`; `creditMaturedSql` reserves `rso`, `rwo`, `rwe`; and
 * this fragment reserves
 * `rel`) and to the
 * `asOf` clock for the maturity test. Shared with `listDebtPositions` for
 * the same reason CREDIT_NOT_BLOCKED_SQL is shared with the consumption
 * feed: a debt cell the staff view lists must be EXACTLY a cell the payout
 * batch would pay nothing, and two hand-maintained copies of the sign table
 * are how that guarantee would rot. Semantics are in the header above.
 */
/**
 * The signed effect of every entry type EXCEPT SETTLEMENT_CREDIT, as the tail
 * of a CASE (WHEN arms + the terminating ELSE, no `CASE`/`END`). Extracted so
 * the sign table has exactly ONE home: `payableEffectSql` and
 * `LIABILITY_EFFECT_SQL` differ ONLY in how they gate the credit, and every
 * other sign — reversal +, cash-sale-debit reversal +, debit-compensating
 * release +, legacy `debt-recovery:` PAYOUT +, ordinary PAYOUT −,
 * refund/dispute/cash-sale debit −,
 * DISPUTE_HOLD / RESERVE_* / MANUAL_ADJUSTMENT 0 — is shared bytes rather
 * than two copies a reviewer has to keep in step. Same binding convention as
 * the fragments above: the caller's FROM must alias `PayeeLedgerEntry` as
 * `e`, and this fragment additionally reserves `rel`.
 */
const NON_CREDIT_EFFECT_SQL = Prisma.sql`
            WHEN e."type" IN ('TRANSFER_REVERSAL_CREDIT', 'CASH_SALE_DEBIT_REVERSAL')
              THEN e."amountCents"
            WHEN e."type" = 'DISPUTE_RELEASE' THEN
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM public."PayeeLedgerEntry" rel
                  WHERE rel."id" = e."relatedEntryId"
                    AND rel."type" = 'DISPUTE_DEBIT'
                )
                THEN e."amountCents"
                ELSE 0
              END
            WHEN e."type" = 'PAYOUT' THEN
              -- Legacy-namespace discrimination (see the header): a
              -- pre-cutover debt-recovery row applied += to the rollup, so
              -- it must read + here too; every other PAYOUT is money out.
              CASE
                WHEN e."idempotencyKey" LIKE 'debt-recovery:%'
                THEN e."amountCents"
                ELSE -e."amountCents"
              END
            WHEN e."type" IN ('REFUND_DEBIT', 'DISPUTE_DEBIT', 'CASH_SALE_DEBIT')
              THEN -e."amountCents"
            ELSE 0`;

// The window as a SQL literal, not a bind: it is a compile-time integer
// constant from @th/types (never user input), and inlining it keeps the
// maturity fragment bind-free, so it composes into the forecast/feed builders
// without shifting the positions of THEIR bound values.
if (!Number.isInteger(RESALE_CLAIM_WINDOW_DAYS) || RESALE_CLAIM_WINDOW_DAYS < 0) {
  throw new Error("RESALE_CLAIM_WINDOW_DAYS must be a non-negative integer");
}
const RESALE_CLAIM_WINDOW_DAYS_SQL = Prisma.raw(String(RESALE_CLAIM_WINDOW_DAYS));

/**
 * EFFECTIVE maturity of the ledger row `e` — the ONE definition every read
 * that asks "is this credit mature / when does it mature" shares:
 * `listPayableBalances` (sum + `oldestMaturedAt`), `listConsumableCredits`,
 * `listDebtPositions` (via `payableEffectSql`), the upcoming-maturities
 * forecast's tranche date, and the tranche attribution feed's
 * `availableAtAfter` / `availableAtBefore` bounds. Payable and forecast
 * therefore partition the unblocked credits exactly: no credit is in both,
 * none falls between.
 *
 *   effective = GREATEST(availableAt, claim close)   for a RESALE order
 *             = availableAt                          otherwise
 *
 * where claim close = the event's CURRENT `endsAt ?? startsAt` +
 * RESALE_CLAIM_WINDOW_DAYS (the same constant core's
 * `resaleClaimWindowClosesAt` uses). `availableAt` is fixed at credit time and
 * cannot see an event moved LATER after finalize; `create-claim` reads the
 * current end, so without this the seller could be paid while the buyer can
 * still file. Half-open like create-claim: claims while `now < close`,
 * mature from `asOf >= close`.
 *
 * NULL `availableAt` (every non-credit row) stays NULL, so debit rows on a
 * resale order never acquire a maturity. GREATEST ignores the NULL the
 * scalar subquery yields for non-RESALE / event-less orders.
 *
 * Bind-free. Reserves the aliases `rso`, `rwo` (Order) and `rwe` (Event).
 * Exported for the SQL-shape unit tests only.
 */
export const CREDIT_EFFECTIVE_MATURITY_SQL = Prisma.sql`(
  CASE
    WHEN e."availableAt" IS NULL THEN NULL
    -- Is this a RESALE order? Correlated on orderId ALONE, so Postgres runs
    -- it once as a hashed subplan rather than an index probe per row; the
    -- per-row claim-close lookup below then runs only for RESALE credits.
    WHEN EXISTS (
      SELECT 1 FROM public."Order" rso
      WHERE rso."id" = e."orderId"
        AND rso."source" = 'RESALE'
    )
    THEN GREATEST(
      e."availableAt",
      (
        SELECT COALESCE(rwe."endsAt", rwe."startsAt")
                 + make_interval(days => ${RESALE_CLAIM_WINDOW_DAYS_SQL})
        FROM public."Order" rwo
        JOIN public."Event" rwe ON rwe."id" = rwo."eventId"
        WHERE rwo."id" = e."orderId"
      )
    )
    ELSE e."availableAt"
  END
)`;

/** `e` is mature at `asOf` (see CREDIT_EFFECTIVE_MATURITY_SQL). */
export function creditMaturedSql(asOf: Date): Prisma.Sql {
  return Prisma.sql`(${CREDIT_EFFECTIVE_MATURITY_SQL} <= ${asOf})`;
}

function payableEffectSql(asOf: Date): Prisma.Sql {
  return Prisma.sql`
          CASE
            WHEN e."type" = 'SETTLEMENT_CREDIT' THEN
              CASE
                WHEN ${creditMaturedSql(asOf)}
                  -- blocked (spec §2): shared fragment — see
                  -- CREDIT_NOT_BLOCKED_SQL for the semantics.
                  AND ${CREDIT_NOT_BLOCKED_SQL}
                THEN e."amountCents"
                ELSE 0
              END
            ${NON_CREDIT_EFFECT_SQL}
          END`;
}

// ── Opt-in statement budget for the two whole-ledger aggregates ─────────────
//
// `listPayableBalances` and `sumOutstandingLiability` are full-ledger
// aggregates with no natural bound. The payout BATCH runs them unbudgeted —
// nightly, headless, nothing to degrade to — and that path must stay exactly
// as it was, so an OMITTED budget short-circuits to the bare query: same
// bytes, same transaction (none), same errors.
//
// A budget is passed only by the interactive staff reads on
// `/platform/settlements`, where an unbounded aggregate would hang the page.
// Then the read gets the same treatment `listDebtPositions` documents at
// length: its OWN interactive transaction, `SET LOCAL jit = off` (these
// aggregates trip `jit_optimize_above_cost` and pay seconds of LLVM compile
// for a sub-second query), `SET LOCAL statement_timeout`, and the
// transaction's own budget set ABOVE the statement's so POSTGRES cancels
// first. Both cancellations map to SERVICE_UNAVAILABLE — the adapter is the
// only layer that can see 57014 / P2028, and core must not learn driver
// codes.
//
// A TransactionClient is REFUSED when a budget is set: `SET LOCAL` on a
// caller's `repos.tx` would silently apply jit/timeout to everything else in
// that transaction.
/**
 * Test-only seam, mirroring `__testOnlyDebtPositionsHooks`: an async hook run
 * INSIDE a budgeted read's transaction, after the SET LOCALs and before the
 * statement. The integration suite uses it to make the read slow for real
 * (`SELECT pg_sleep(...)`) and prove the degrade path. Never set in
 * production code paths.
 */
export const __testOnlyLedgerBudgetHooks: {
  beforeQuery: ((tx: PrismaClientOrTx) => Promise<void>) | null;
} = { beforeQuery: null };

async function withStatementBudget<T>(
  p: PrismaClientOrTx,
  budget: PayeeLedgerReadBudget | undefined,
  label: string,
  run: (client: PrismaClientOrTx) => Promise<T>,
): Promise<T> {
  const requested = budget?.statementTimeoutMs;
  if (requested == null || !Number.isFinite(requested)) return run(p);

  const timeoutMs = Math.min(
    Math.max(Math.floor(requested), 1),
    DEBT_MAX_STATEMENT_TIMEOUT_MS,
  );
  const txTimeoutMs = timeoutMs + TX_TIMEOUT_HEADROOM_MS;

  if (!hasTransaction(p)) {
    throw fail("INTERNAL", {
      message: `${label}_requires_top_level_client`,
      meta: { hint: `${label} with a statement budget must run outside repos.tx` },
    });
  }

  try {
    return await withLedgerTransaction(
      p,
      async (tx) => {
        // SET cannot take a bind parameter; `timeoutMs` is an integer we
        // clamped ourselves, never caller text, so the interpolation is a
        // number literal by construction.
        await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        if (__testOnlyLedgerBudgetHooks.beforeQuery) {
          await __testOnlyLedgerBudgetHooks.beforeQuery(tx);
        }
        return run(tx);
      },
      { maxWait: DEBT_TX_MAX_WAIT_MS, timeout: txTimeoutMs },
    );
  } catch (err) {
    const expired = classifyTimeout(err);
    if (expired) {
      throw fail("SERVICE_UNAVAILABLE", {
        message: `${label}_timeout`,
        meta: {
          expired,
          statementTimeoutMs: timeoutMs,
          transactionTimeoutMs: txTimeoutMs,
        },
        cause: err,
      });
    }
    throw err;
  }
}

async function listPayableBalances(
  p: PrismaClientOrTx,
  asOf: Date,
  payeeIds?: string[],
  budget?: PayeeLedgerReadBudget,
): Promise<PayeeLedgerPayableBalance[]> {
  // Optional payee narrowing. `undefined` = the whole ledger (the batch's
  // planning read); an EXPLICIT array — including an empty one — restricts to
  // exactly those payees, which is what the batch's per-item pre-transfer
  // re-check passes so the recheck costs an index scan, not a full aggregate.
  // Pushed INSIDE the grouped subquery (not applied after) so Postgres never
  // aggregates rows it is about to discard.
  const payeeFilter =
    payeeIds === undefined
      ? Prisma.empty
      : Prisma.sql`WHERE e."payeeId" = ANY(${payeeIds}::text[])`;
  // The final ::int cast is deliberate bounds-checking, not convenience: a
  // per-(payee, currency) payable beyond ±$21.4M overflows int4 and Postgres
  // RAISES 22003 rather than truncating. Right direction (never silently
  // wrap money), but note the blast radius — the raise halts THIS WHOLE
  // QUERY, i.e. the entire batch run, not just the offending payee.
  return withStatementBudget(
    p,
    budget,
    "payee_ledger_payable_balances",
    (c) => c.$queryRaw<PayeeLedgerPayableBalance[]>`
    SELECT
      s."payeeId" AS "payeeId",
      s."currency" AS "currency",
      (s."entryCents" - COALESCE(b."ledgerPendingHoldCents", 0))::int AS "payableCents",
      s."oldestMaturedAt" AS "oldestMaturedAt"
    FROM (
      SELECT
        e."payeeId",
        btrim(lower(e."currency")) AS "currency",
        -- "How long has this money been waiting?" — the oldest MATURED,
        -- unblocked credit in the cell. The batch orders its planning feed by
        -- this so a payee cap cannot starve a stable tail (payeeId ordering
        -- hands the same prefix every night, forever, and does it silently).
        -- EFFECTIVE maturity (a rescheduled RESALE credit has waited since
        -- its claim window closed, not since its stale availableAt).
        MIN(
          CASE WHEN e."creditPayable" THEN e."effectiveMaturesAt" END
        ) AS "oldestMaturedAt",
        SUM(
          CASE
            WHEN e."type" = 'SETTLEMENT_CREDIT' THEN
              CASE WHEN e."creditPayable" THEN e."amountCents" ELSE 0 END
            ${NON_CREDIT_EFFECT_SQL}
          END
        ) AS "entryCents"
      -- The per-row credit gates are computed ONCE here and read by both the
      -- MIN and the SUM above. Written inline in both CASEs (as before), each
      -- credit row paid for the maturity + blocked correlated subplans twice
      -- — Postgres does not share subplan results across expressions.
      -- OFFSET 0 is the optimisation fence that stops the planner pulling
      -- these subqueries up and re-inlining the expressions into the outer
      -- CASEs. Two levels because the blocked fragment binds the row as "e"
      -- and must see the maturity already computed. Same results as the
      -- unfused form: the gate is the identical expression
      -- (payableEffectSql = CASE credit WHEN matured AND not blocked).
      FROM (
        SELECT
          e.*,
          CASE
            WHEN e."type" = 'SETTLEMENT_CREDIT'
              AND e."effectiveMaturesAt" <= ${asOf}
            THEN ${CREDIT_NOT_BLOCKED_SQL}
            ELSE FALSE
          END AS "creditPayable"
        FROM (
          SELECT
            e.*,
            CASE
              WHEN e."type" = 'SETTLEMENT_CREDIT'
              THEN ${CREDIT_EFFECTIVE_MATURITY_SQL}
            END AS "effectiveMaturesAt"
          FROM public."PayeeLedgerEntry" e
          ${payeeFilter}
          OFFSET 0
        ) e
        OFFSET 0
      ) e
      -- Normalised, same as the liability query. Grouping on the raw column
      -- produced TWO cells for one payee-currency, and that is worse here than
      -- it is for liability: run-batch's cellClaimKey is already normalised,
      -- so both cells hash to one claim, the loser records
      -- itemsSkippedClaimLost, and the SAME casing wins every night — so the
      -- losing cell's money is never paid out at all.
      GROUP BY e."payeeId", btrim(lower(e."currency"))
    ) s
    -- Aggregated before the join, not normalised inside the ON clause: the
    -- rollup's PK is (payeeId, currency) on the RAW column, so two casings are
    -- two rows, and joining them both to one normalised cell would multiply
    -- the cell — turning an under-deduction into a duplicated payable.
    LEFT JOIN (
      SELECT
        b2."payeeId" AS "payeeId",
        btrim(lower(b2."currency")) AS "currency",
        SUM(b2."ledgerPendingHoldCents") AS "ledgerPendingHoldCents"
      FROM public."PayeeLedgerBalance" b2
      GROUP BY b2."payeeId", btrim(lower(b2."currency"))
    ) b
      ON b."payeeId" = s."payeeId" AND b."currency" = s."currency"
    ORDER BY s."oldestMaturedAt" ASC NULLS LAST,
             s."payeeId" ASC, s."currency" ASC
  `,
  );
}

// ── The liability query ─────────────────────────────────────────────────────
//
// TOTAL OUTSTANDING LIABILITY per currency: what the platform OWES, with no
// maturity filter. Deliberately a SEPARATE query from listPayableBalances,
// never a reuse of it — payable is "what can tonight's batch pay?", liability
// is "what do we owe, ever?", and reporting the first as the second would
// show the platform solvent while insolvent (a credit maturing in three weeks
// is the organiser's money today).
//
// Same sign table as the payable, SHARED as bytes via NON_CREDIT_EFFECT_SQL.
// SETTLEMENT_CREDIT is the only arm that differs, and it drops BOTH of the
// payable's gates:
//   * maturity — the whole point of this query;
//   * the blocked-credit exclusion (open dispute / open claim) — a blocked
//     credit is still owed to SOMEBODY (the payee if the dispute is won, the
//     network if it is lost), so excluding it would UNDERSTATE liability.
//     Understating is the dangerous direction; this query always errs high.
// Note the corollary: a credit whose dispute hold is also counted below
// contributes twice (once as the credit, once as the hold). That is
// deliberate over-provisioning, and it is why every component is returned
// separately instead of pre-summed — see the use case's docstring.
//
// Aliases: the enclosing FROM binds `e`; NON_CREDIT_EFFECT_SQL reserves
// `rel`. Schema-qualified (public.*) for the same Neon empty-search_path
// wake-up reason as the payable query.
const LIABILITY_EFFECT_SQL = Prisma.sql`
          CASE
            WHEN e."type" = 'SETTLEMENT_CREDIT' THEN e."amountCents"
            ${NON_CREDIT_EFFECT_SQL}
          END`;

/**
 * Per-currency liability totals. READ-ONLY.
 *
 * THE CLAMP IS THE POINT: the signed entry sum is reduced per (payee,
 * currency) and passed through `GREATEST(·, 0)` BEFORE the per-currency SUM.
 * A payee in debt does not offset another payee's credit — the platform
 * cannot spend one organiser's negative balance to pay a different organiser
 * — so summing raw signed totals would understate what is owed. Dropping the
 * clamp is the single most dangerous edit that can be made to this function.
 *
 * Reserves and pending holds come off the `PayeeLedgerBalance` rollup rather
 * than being recomputed from entries: they ARE rollup counters (the drift
 * sweep in this file is what proves them). Each is `GREATEST(·, 0)`-clamped
 * for the same reason as above — a negative counter is drift, and drift must
 * not be allowed to shrink the liability figure; `listRollupDrift` is where
 * it gets reported.
 *
 * FULL OUTER JOIN because either side can exist alone: a payee with entries
 * and no rollup row (a lost effect), and an orphan rollup row carrying a
 * reserve with no journal. Both are drift, both still represent money, so
 * both count here and are diagnosed by invariant 1.
 *
 * Cents ride `::bigint` → `centsToNumber`, matching the reconciliation reads
 * — this is a diagnostic total, never a transfer input, so a pathological
 * figure must be REPORTED, not raise 22003 the way the payable's deliberate
 * `::int` bounds-check does.
 */
async function sumOutstandingLiability(
  p: PrismaClientOrTx,
  budget?: PayeeLedgerReadBudget,
): Promise<PayeeLedgerLiabilityTotal[]> {
  const rows = await withStatementBudget(
    p,
    budget,
    "payee_ledger_outstanding_liability",
    (c) => c.$queryRaw<
    Array<{
      currency: string;
      unpaidCreditsCents: bigint;
      reserveHeldCents: bigint;
      pendingHoldCents: bigint;
    }>
  >`
    -- Currency is normalised on BOTH sides before anything is grouped or
    -- joined. The port promises "Lowercase ISO-4217" and one row per currency;
    -- grouping on the raw column broke that promise whenever two casings
    -- existed (legacy rows, a backfill, direct SQL — the write path itself
    -- normalises).
    --
    -- Two rows for one currency harmed three ways, and they pull in DIFFERENT
    -- directions, which is why the fix is a fold and not a dedupe:
    --   * a consumer keying by currency could keep only the last row and drop
    --     the other's cents (understating);
    --   * each casing was clamped at zero INDEPENDENTLY, so one payee's debt
    --     in one casing no longer offset their credit in the other
    --     (overstating);
    --   * the staff "what we owe" panel rendered two lines for one currency.
    -- Folding first and clamping once is the only arithmetic that is right on
    -- all three counts.
    --
    -- Each side is aggregated to one row per (payee, normalised currency)
    -- BEFORE the join. Normalising only in the join condition would be worse
    -- than the bug: two balance rows would each pick up the same entry total
    -- and double-count it.
    WITH entry_cells AS (
      SELECT
        e."payeeId" AS "payeeId",
        btrim(lower(e."currency")) AS "currency",
        SUM((${LIABILITY_EFFECT_SQL})::bigint)::bigint AS "entryCents"
      FROM public."PayeeLedgerEntry" e
      GROUP BY e."payeeId", btrim(lower(e."currency"))
    ),
    -- Per-row clamp BEFORE the sum, preserving the previous semantics exactly
    -- (a negative stored balance never subtracts from a sibling's).
    balance_cells AS (
      SELECT
        b."payeeId" AS "payeeId",
        btrim(lower(b."currency")) AS "currency",
        SUM(GREATEST(b."reserveBalanceCents", 0))::bigint      AS "reserveCents",
        SUM(GREATEST(b."ledgerPendingHoldCents", 0))::bigint   AS "holdCents"
      FROM public."PayeeLedgerBalance" b
      GROUP BY b."payeeId", btrim(lower(b."currency"))
    ),
    cells AS (
      SELECT
        COALESCE(c."payeeId", b."payeeId")     AS "payeeId",
        COALESCE(c."currency", b."currency")   AS "currency",
        -- The per-payee zero clamp. Never move this outside the SUM below.
        -- It now runs ONCE per payee-currency, after the casings are folded:
        -- clamping each casing separately floored a payee's debt in one
        -- casing against their credit in another and overstated the total.
        GREATEST(COALESCE(c."entryCents", 0), 0)::bigint       AS "unpaidCents",
        COALESCE(b."reserveCents", 0)::bigint                 AS "reserveCents",
        COALESCE(b."holdCents", 0)::bigint                    AS "holdCents"
      FROM entry_cells c
      FULL OUTER JOIN balance_cells b
        ON b."payeeId" = c."payeeId" AND b."currency" = c."currency"
    )
    SELECT
      cells."currency"                       AS "currency",
      SUM(cells."unpaidCents")::bigint       AS "unpaidCreditsCents",
      SUM(cells."reserveCents")::bigint      AS "reserveHeldCents",
      SUM(cells."holdCents")::bigint         AS "pendingHoldCents"
    FROM cells
    GROUP BY cells."currency"
    ORDER BY cells."currency" ASC
  `,
  );
  return rows.map((r) => ({
    currency: r.currency,
    unpaidCreditsCents: centsToNumber(r.unpaidCreditsCents),
    reserveHeldCents: centsToNumber(r.reserveHeldCents),
    pendingHoldCents: centsToNumber(r.pendingHoldCents),
  }));
}

// ── The filtered entry scan (tranche attribution) ───────────────────────────
//
// `listEntries` with any of the attribution options: the individual
// SETTLEMENT_CREDIT rows a maturity tranche is made of, so a payouts view can
// say WHICH orders a tranche came from.
//
// It exists as raw SQL for exactly one reason: CREDIT_NOT_BLOCKED_SQL. The
// blocked-credit rule is a correlated NOT-EXISTS over Order, a second
// PayeeLedgerEntry (the hold), a third (its release) and Claim — not
// expressible in a Prisma `where:` — and listUpcomingMaturities applies it to
// its tranche TOTALS. If the attribution rows applied a different rule (or
// none), the sub-lines under a tranche would not sum to the tranche's own
// heading figure. So the fragment is REUSED as bytes, never retyped, and the
// outer row is aliased `e` because the fragment binds `e` and reserves `o`,
// `h`, `r`, `cl`.
//
// Only SETTLEMENT_CREDIT rows are subject to the exclusion — nothing blocks a
// debit — hence the `type <> 'SETTLEMENT_CREDIT' OR ...` disjunction rather
// than a bare predicate, which would have silently dropped every debit.

/** True when any option needs the raw scan; false keeps the legacy findMany. */
function needsFilteredEntryScan(opts: ListPayeeLedgerEntriesOptions): boolean {
  return (
    opts.availableAtAfter !== undefined ||
    opts.availableAtBefore !== undefined ||
    opts.unconsumedOnly === true ||
    opts.excludeBlockedCredits === true
  );
}

/**
 * The filtered entry scan as a parameterised `Prisma.Sql`, exported for the
 * same reason as {@link buildDebtPositionsSql} and
 * {@link buildUpcomingMaturitiesSql}: the integration suite runs the EXACT
 * bytes, and the filter composition is assertable in a unit test without a
 * database. Every bound is a PARAMETER — no interpolated caller text.
 */
export function buildFilteredEntriesSql(params: {
  payeeId: string;
  opts: ListPayeeLedgerEntriesOptions;
}): Prisma.Sql {
  const { payeeId, opts } = params;

  // Clamped to non-negative integers. Prisma's findMany accepts a NEGATIVE
  // `take` (backwards pagination from a cursor) and a fractional one, but
  // Postgres rejects `LIMIT -5` outright ("LIMIT must not be negative") — so
  // the two branches of listEntries would answer the same input with a page
  // and an exception respectively. Neither meaning is available here (there
  // is no cursor to page backwards from), so the clamp is the honest floor: a
  // non-positive page size returns NOTHING rather than quietly becoming the
  // default 50, which would hand back rows nobody asked for.
  const limit = Math.max(Math.floor(opts.limit ?? 50), 0);
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0);

  // Currency is normalised on the COLUMN, `btrim(lower(...))`, matching
  // buildUpcomingMaturitiesSql's GROUP BY byte for byte (and the same
  // spelling the payable/liability queries in this file use).
  //
  // This deliberately DIVERGES from the legacy findMany branch, which
  // compares the raw column. The two answer different questions: findMany is
  // the journal read, this path is the attribution feed for a tranche, and
  // `tranche.currency` is ALWAYS the normalised value because the tranche
  // read grouped on it. Comparing raw here would count a row stored 'USD'
  // into the tranche total and then fail to list it underneath — heading and
  // sub-lines disagreeing over nothing but casing. Agreement by construction
  // beats agreement by an invariant held in the writers.
  //
  // No index is lost that mattered: `e."payeeId" = $1` is the selective
  // predicate and currency only narrows within one payee's entries.
  const currencyFilter = opts.currency
    ? Prisma.sql`AND btrim(lower(e."currency")) = ${normalizeCurrency(opts.currency)}`
    : Prisma.empty;

  // `::text` on both sides: the column is an enum, the parameter an array of
  // strings, and Postgres will not coerce text[] to enum[] on its own.
  const typeFilter =
    opts.types && opts.types.length > 0
      ? Prisma.sql`AND e."type"::text = ANY(${opts.types as string[]}::text[])`
      : Prisma.empty;

  // STRICT `>`, matching listUpcomingMaturities' `availableAt > asOf` byte
  // for byte. A credit maturing ON the instant is payable TODAY and belongs
  // to no tranche; including it here would out-sum the heading.
  //
  // Both bounds compare the EFFECTIVE maturity (CREDIT_EFFECTIVE_MATURITY_SQL)
  // — the date the forecast buckets a credit under — so a tranche's
  // attribution feed returns exactly that tranche's credits. For every
  // non-RESALE row this IS availableAt (byte-for-byte the old predicate);
  // NULL availableAt (non-credit rows) stays NULL and still never matches.
  const afterFilter =
    opts.availableAtAfter !== undefined
      ? Prisma.sql`AND ${CREDIT_EFFECTIVE_MATURITY_SQL} > ${opts.availableAtAfter}`
      : Prisma.empty;
  // INCLUSIVE `<=`, so a caller can bound by the LAST VISIBLE tranche's
  // maturesAt and still get that tranche's rows. Asymmetric with the bound
  // above on purpose; both are documented on the options type.
  const beforeFilter =
    opts.availableAtBefore !== undefined
      ? Prisma.sql`AND ${CREDIT_EFFECTIVE_MATURITY_SQL} <= ${opts.availableAtBefore}`
      : Prisma.empty;

  const unconsumedFilter =
    opts.unconsumedOnly === true
      ? Prisma.sql`AND e."consumedByEntryId" IS NULL`
      : Prisma.empty;

  const blockedFilter =
    opts.excludeBlockedCredits === true
      ? Prisma.sql`AND (e."type" <> 'SETTLEMENT_CREDIT' OR ${CREDIT_NOT_BLOCKED_SQL})`
      : Prisma.empty;

  // The export's snapshot bound: a row-value comparison, the same total
  // order the ORDER BY below sorts on, inclusive of the cursor row itself.
  const atOrBeforeFilter = opts.atOrBefore
    ? Prisma.sql`AND (e."createdAt", e."id") <= (${opts.atOrBefore.createdAt}, ${opts.atOrBefore.id})`
    : Prisma.empty;
  // ...and its keyset: strictly after the previous page's last row.
  const keysetAfterFilter = opts.after
    ? Prisma.sql`AND (e."createdAt", e."id") > (${opts.after.createdAt}, ${opts.after.id})`
    : Prisma.empty;

  // Picked from two literals, never caller text: `Prisma.raw` here cannot
  // carry anything but the keyword.
  const direction = Prisma.raw(opts.order === "asc" ? "ASC" : "DESC");

  return Prisma.sql`
    -- effectiveAvailableAt: the SAME expression the maturity bounds below
    -- filter on, so a tranche's sub-lines show the date they are bucketed
    -- under (a rescheduled RESALE credit's stale availableAt would sit
    -- outside its own tranche's window).
    SELECT e.*, ${CREDIT_EFFECTIVE_MATURITY_SQL} AS "effectiveAvailableAt"
    FROM public."PayeeLedgerEntry" e
    WHERE e."payeeId" = ${payeeId}
      ${currencyFilter}
      ${typeFilter}
      ${afterFilter}
      ${beforeFilter}
      ${unconsumedFilter}
      ${blockedFilter}
      ${atOrBeforeFilter}
      ${keysetAfterFilter}
    -- Same (createdAt, id) order as the findMany path. The id tiebreak keeps
    -- the sort stable under createdAt ties, which both OFFSET paging and the
    -- keyset bounds above depend on.
    ORDER BY e."createdAt" ${direction}, e."id" ${direction}
    LIMIT ${limit} OFFSET ${offset}
  `;
}

async function listFilteredEntries(
  p: PrismaClientOrTx,
  payeeId: string,
  opts: ListPayeeLedgerEntriesOptions,
): Promise<PayeeLedgerEntryRecord[]> {
  // No statement budget and no own transaction: unlike the aggregate reads
  // this is a bounded, payee-scoped, LIMITed scan, so it stays callable from
  // inside `repos.tx(...)` exactly as the findMany path always has been.
  const rows = await p.$queryRaw<
    Array<PayeeLedgerEntry & { effectiveAvailableAt: Date | null }>
  >(buildFilteredEntriesSql({ payeeId, opts }));
  return rows.map((row) => ({
    ...mapPayeeLedgerEntry(row),
    // The date the forecast buckets this credit under (see the SELECT).
    effectiveAvailableAt: row.effectiveAvailableAt,
  }));
}

// ── The upcoming-maturity query ─────────────────────────────────────────────
//
// The forward half of the payable: per (payee, currency, availableAt), the
// SETTLEMENT_CREDIT cents that are NOT payable yet because their maturity is
// still ahead of `asOf`. Exactly the credit rows `listPayableBalances`
// excludes on maturity, and the same rows `sumOutstandingLiability` folds
// anonymously into one per-currency figure — here they keep their DATE,
// which is the whole point: "what goes out on 4 Oct" is unanswerable from
// either sibling.
//
// A CREDIT FEED, NOT A BALANCE. `creditCents` is GROSS and deliberately does
// NOT use NON_CREDIT_EFFECT_SQL. That fragment is the sign table for SIGNED
// BALANCE SUMS, and this is not one: a REFUND_DEBIT or a PAYOUT is effective
// the instant it is written, so it has ALREADY reduced today's payable.
// Netting it off a FUTURE tranche would deduct it a second time.
//
// HOLDS ARE ALREADY EFFECTIVE TOO — this is the trap. `hold()` bumps
// ledgerPendingHoldCents at WRITE time and listPayableBalances subtracts it
// unconditionally, tonight and every night, so a hold on an IMMATURE credit
// shows up TODAY as a lower (often negative) payable. The consumer
// (core list-upcoming-payouts.ts) reads that payable and nets the
// carried-forward DEBT against the gross, soonest tranche first; a hold
// reaches the forecast THROUGH that debt and must never be subtracted a
// second time. Trace: credit 7,000 maturing 4 Oct under a 3,000 hold →
// payable today −3,000 → the batch pays 4,000 on the night; the debt walk
// says 7,000 − 3,000 = 4,000; "credit − hold − debt" said 1,000.
//
// `heldCents` is therefore an ANNOTATION, never an operand: how much of this
// tranche's credit sits under an open dispute (the hold is inside today's
// payable already). Attributed ONCE per (payee, normalised currency, order)
// — to the EARLIEST tranche of that order, via `tranche_orders`' MIN — so a
// hold on an order whose credits mature on two dates is never shown twice.
// Reported AS WRITTEN: it may exceed one tranche's credit (a hold is sized
// from the order, a tranche from one maturity), and nothing sums it. "Active"
// = HOLD_NOT_CONSUMED_SQL, the same predicate as findActiveHoldRows and the
// blocked-credit fragment. A credit with a NULL orderId carries no hold.
//
// ONE gate IS shared with the payable: CREDIT_NOT_BLOCKED_SQL, reused
// verbatim so a credit under an open dispute WITHOUT a hold, or under an
// open resale claim, is not forecast as money going out. That is the
// deliberate difference from the liability query, which KEEPS blocked
// credits because liability must err HIGH while a payout forecast must not.
//
// Currency is normalised (`btrim(lower(...))`) before grouping AND on both
// sides of the hold join, for the same reason the payable query does it —
// see the comment on its GROUP BY: two casings of one payee-currency
// produced two competing cells and the losing cell's money never went out.
//
// `availableAt` is nullable in the schema (a DB CHECK requires it only for
// SETTLEMENT_CREDIT rows); the `> asOf` comparison is NULL-false, so a NULL
// row drops out on its own and no extra guard is needed.
//
// Schema-qualified (public.*) so the statement survives a Neon pooled
// connection waking with an empty search_path, same as its siblings.
//
// PAYEE NARROWING (`payeeIds`) is applied INSIDE `tranche_credits`, not after
// the aggregate: everything downstream — `tranches`, `tranche_orders`,
// `tranche_holds` — derives from that CTE, so one predicate bounds the whole
// statement to an index scan on `payeeId`. A JS post-filter would have kept
// the full-ledger aggregate the argument exists to avoid, and the organiser
// view (one payee, page load latency) is precisely the caller that cannot
// afford it. `undefined` = every payee; an EXPLICIT empty array yields
// `= ANY('{}')`, which is false for every row — no payees, no rows, exactly
// as the port documents and exactly as listPayableBalances behaves.

/**
 * The upcoming-maturities statement as a parameterised `Prisma.Sql`, exported
 * for the same reason as {@link buildDebtPositionsSql}: the integration suite
 * (and any EXPLAIN) runs the EXACT bytes the adapter runs (`.text` +
 * `.values`), and the payee filter can be asserted in a unit test without a
 * database. `asOf` is bound, never interpolated; `payeeIds` is bound as a
 * `text[]`.
 */
export function buildUpcomingMaturitiesSql(params: {
  asOf: Date;
  payeeIds?: string[];
}): Prisma.Sql {
  const { asOf, payeeIds } = params;
  const payeeFilter =
    payeeIds === undefined
      ? Prisma.empty
      : Prisma.sql`AND e."payeeId" = ANY(${payeeIds}::text[])`;

  return Prisma.sql`
    WITH tranche_credits AS (
      -- The credit rows of the feed. Alias MUST be "e": CREDIT_NOT_BLOCKED_SQL
      -- binds the credit under test as "e" and reserves its aliases.
      SELECT
        e."payeeId"                 AS "payeeId",
        btrim(lower(e."currency"))  AS "currency",
        e."effectiveMaturesAt"      AS "maturesAt",
        e."orderId"                 AS "orderId",
        e."amountCents"             AS "amountCents"
      FROM (
        -- EFFECTIVE maturity, computed once per credit (OFFSET 0 fences the
        -- planner from re-inlining it into both the WHERE and the SELECT):
        -- the SAME expression the payable query matures on, so payable and
        -- forecast partition the unblocked credits exactly — a RESALE credit
        -- held past its stale availableAt by a rescheduled event's claim
        -- window is forecast at the window's close, not lost between the two.
        SELECT
          e."payeeId", e."currency", e."orderId", e."amountCents",
          ${CREDIT_EFFECTIVE_MATURITY_SQL} AS "effectiveMaturesAt"
        FROM public."PayeeLedgerEntry" e
        WHERE e."type" = 'SETTLEMENT_CREDIT'
          -- Narrowing first: the fragments here run correlated subqueries,
          -- and there is no reason to evaluate them for rows this caller is
          -- not asking about.
          ${payeeFilter}
        OFFSET 0
      ) e
      WHERE e."effectiveMaturesAt" > ${asOf}
        -- blocked (spec §2): the SAME shared fragment the payable query uses,
        -- so a credit this forecast lists is exactly a credit the batch would
        -- pay once it matures.
        AND ${CREDIT_NOT_BLOCKED_SQL}
    ),
    tranches AS (
      SELECT
        tc."payeeId", tc."currency", tc."maturesAt",
        COALESCE(SUM(tc."amountCents"), 0)::bigint AS "creditCents",
        COUNT(*)::int                              AS "creditCount"
      FROM tranche_credits tc
      GROUP BY tc."payeeId", tc."currency", tc."maturesAt"
    ),
    -- ONE row per (payee, currency, order), pinned to that order's EARLIEST
    -- tranche: the hold is annotated once, even when the order's credits
    -- share a tranche (several rows, one order) or span two dates.
    tranche_orders AS (
      SELECT
        tc."payeeId", tc."currency", tc."orderId",
        MIN(tc."maturesAt") AS "maturesAt"
      FROM tranche_credits tc
      WHERE tc."orderId" IS NOT NULL
      GROUP BY tc."payeeId", tc."currency", tc."orderId"
    ),
    tranche_holds AS (
      -- The hold row is aliased "e" here so HOLD_NOT_CONSUMED_SQL (which binds
      -- "e" as the hold under test) applies unchanged. Separate CTE scope, so
      -- it cannot collide with the credit "e" above.
      SELECT
        t."payeeId", t."currency", t."maturesAt",
        COALESCE(SUM(e."amountCents"), 0)::bigint AS "heldCents"
      FROM tranche_orders t
      JOIN public."PayeeLedgerEntry" e
        ON e."type" = 'DISPUTE_HOLD'
       AND e."orderId" = t."orderId"
       AND e."payeeId" = t."payeeId"
       AND btrim(lower(e."currency")) = t."currency"
      WHERE ${HOLD_NOT_CONSUMED_SQL}
      GROUP BY t."payeeId", t."currency", t."maturesAt"
    )
    SELECT
      tr."payeeId"     AS "payeeId",
      tr."currency"    AS "currency",
      tr."maturesAt"   AS "maturesAt",
      tr."creditCents" AS "creditCents",
      -- As written, unclamped: an annotation, never an operand.
      COALESCE(th."heldCents", 0)::bigint AS "heldCents",
      tr."creditCount" AS "creditCount"
    FROM tranches tr
    LEFT JOIN tranche_holds th
      ON th."payeeId" = tr."payeeId"
     AND th."currency" = tr."currency"
     AND th."maturesAt" = tr."maturesAt"
    ORDER BY tr."maturesAt" ASC,
             tr."payeeId" ASC,
             tr."currency" ASC
  `;
}

interface UpcomingMaturityRawRow {
  payeeId: string;
  currency: string;
  maturesAt: Date;
  creditCents: bigint;
  heldCents: bigint;
  creditCount: number;
}

async function listUpcomingMaturities(
  p: PrismaClientOrTx,
  asOf: Date,
  payeeIds?: string[],
  budget?: PayeeLedgerReadBudget,
): Promise<PayeeLedgerUpcomingMaturity[]> {
  const sql = buildUpcomingMaturitiesSql({ asOf, payeeIds });
  // `::bigint` → number, NOT the payable query's `::int`. The payable casts
  // to int4 as a deliberate bounds-check on a TRANSFER INPUT, accepting that
  // a pathological cell raises 22003 and halts the whole batch. This is a
  // DIAGNOSTIC/display read, so it follows the reconciliation reads'
  // precedent instead: a pathological total gets REPORTED rather than
  // exploding a staff page.
  const rows = await withStatementBudget(
    p,
    budget,
    "payee_ledger_upcoming_maturities",
    (c) => c.$queryRaw<UpcomingMaturityRawRow[]>(sql),
  );

  return rows.map((r) => ({
    payeeId: r.payeeId,
    currency: r.currency,
    maturesAt: r.maturesAt,
    creditCents: centsToNumber(r.creditCents),
    heldCents: centsToNumber(r.heldCents),
    creditCount: Number(r.creditCount),
  }));
}

// FIFO consumption feed: matured, unblocked, unconsumed SETTLEMENT_CREDIT
// rows for one (payee, currency), oldest maturity first. The dispute/claim
// exclusions are IDENTICAL to listPayableBalances' credit filter — a credit
// the payable sum refuses must never be attributed to a payout. Attribution
// only: amounts come from the payable sum, never from these rows.
async function listConsumableCredits(
  p: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  asOf: Date,
): Promise<ConsumablePayeeLedgerCredit[]> {
  return p.$queryRaw<ConsumablePayeeLedgerCredit[]>`
    SELECT e."id", e."orderId", e."amountCents", e."metadata"
    FROM public."PayeeLedgerEntry" e
    WHERE e."payeeId" = ${payeeId}
      AND e."currency" = ${currency}
      AND e."type" = 'SETTLEMENT_CREDIT'
      -- Maturity: the SAME fragment as the payable sum (incl. the resale
      -- claim window), so the feed can always cover what the sum counted.
      AND ${creditMaturedSql(asOf)}
      AND e."consumedByEntryId" IS NULL
      -- blocked (spec §2): the SAME shared fragment as listPayableBalances —
      -- a credit the payable sum COUNTS (because its withholding rides the
      -- hold) must also be consumable, or FIFO attribution could not cover
      -- the amount actually paid.
      AND ${CREDIT_NOT_BLOCKED_SQL}
    -- FIFO on EFFECTIVE maturity (the same expression oldestMaturedAt
    -- reports), so a rescheduled RESALE credit is consumed in the order it
    -- actually became payable, not by its stale availableAt.
    ORDER BY ${CREDIT_EFFECTIVE_MATURITY_SQL} ASC, e."createdAt" ASC
  `;
}

// ── Debt positions (staff "Payees in debt" view) ─────────────────────────────
//
// READ-ONLY, DISPLAY-ONLY. Every (payee, currency) cell whose payable — the
// SAME signed sum `listPayableBalances` computes, via the shared
// `payableEffectSql` fragment — is negative, joined to the Payee subject. The
// batch pays such a cell nothing and carries it forward (run-batch.ts, "debt
// position"); this is how ops sees the carry-forward. Nothing here is ever a
// transfer input, which is why the cents ride `::bigint` + `centsToNumber`
// (like the invariant sweeps) rather than the batch's deliberate `::int`
// raise: a pathological cell must show up in the diagnostic view, not kill
// it with a 22003.
//
// `debtSinceAt` is the TRUE crossing point, not an approximation: the
// running signed sum over the cell's entries (createdAt, id order; each entry
// weighted with today's effectiveness) is computed with a window function,
// and the marker is the createdAt of the first row AFTER the last row at
// which that running sum was still >= 0. Bounded: the window runs only over
// entries of the cells on THIS page (`page_window`, the lookahead row
// excluded), never over the whole ledger. The running sum ignores the
// rollup's `ledgerPendingHoldCents` (a counter, not a journal position), so
// a cell that is negative ONLY because of a pending hold has no crossing and
// reads null — reported honestly rather than back-filled.
//
// Cursor: keyset on the ORDER BY tuple (payableCents, payeeId, currency),
// encoded as base64url JSON. An undecodable cursor restarts from the top
// (the dispute desk's `listForDesk` posture) rather than 400-ing a stale tab.
//
// Cost: one aggregate pass over PayeeLedgerEntry (the same shape as the
// nightly batch's planning read) plus a bounded window pass — ~150ms of
// real execution at 20k entries / 500 payees. The statement ALWAYS runs
// inside a transaction with `SET LOCAL jit = off`: the planner mis-costs the
// fragment's correlated subplans (estimated cost ~14.6M for a query that
// touches 2.5k buffers), which trips `jit_optimize_above_cost`, and Postgres
// then spends ~2.5s LLVM-compiling 221 functions for a 150ms query —
// measured: 2045ms with JIT vs the figure in the integration suite's EXPLAIN
// case without it. (`listPayableBalances`, the batch's nightly read, pays
// the same tax; nightly, it does not matter.) The caller may also pass
// `statementTimeoutMs` (`SET LOCAL statement_timeout` in the same tx,
// default DEBT_DEFAULT_STATEMENT_TIMEOUT_MS); a 57014 cancel surfaces as
// SERVICE_UNAVAILABLE so a slow debt section degrades to an inline error
// instead of hanging the settlements page. The ADAPTER throws that domain
// error deliberately — it is the only layer that can see Postgres's 57014
// or Prisma's P2028, and core must not learn driver error codes.
//
// TWO budgets, ordered on purpose: the Postgres statement_timeout must
// expire FIRST, so the interactive transaction is opened with
// `timeout = statementTimeoutMs + TX_TIMEOUT_HEADROOM_MS`. Prisma's default
// `timeout` is 5000ms — with it, a 6s query dies as P2028 ("Transaction
// already closed") from Prisma's side, which is also classified as a timeout
// (meta.expired = "transaction") so the degrade path still holds if the
// ordering ever regresses. The read MUST run on a top-level client: it opens
// its own transaction because `SET LOCAL` on a caller's `repos.tx` would
// silently apply jit/timeout to everything else in that transaction — a
// TransactionClient is refused (INTERNAL).

const DEBT_CURSOR_FIELD = "payableCents,payeeId,currency";
const DEBT_DEFAULT_LIMIT = 25;
const DEBT_MAX_LIMIT = 200;
/** Applied when the caller passes no `statementTimeoutMs`. */
export const DEBT_DEFAULT_STATEMENT_TIMEOUT_MS = 8_000;
/** Hard ceiling on a caller-supplied statement timeout (5 minutes). */
const DEBT_MAX_STATEMENT_TIMEOUT_MS = 300_000;
/** Interactive-tx `timeout` = statement budget + this, so Postgres fires first. */
export const TX_TIMEOUT_HEADROOM_MS = 2_000;
/** Interactive-tx `maxWait` (time to acquire a connection from the pool). */
export const DEBT_TX_MAX_WAIT_MS = 5_000;

/**
 * Test-only seam: an async hook run INSIDE the read's transaction, after the
 * SET LOCALs and before the statement. The integration suite uses it to make
 * the read slow for real (`SELECT pg_sleep(...)`) and prove which budget
 * fires. Never set in production code paths.
 */
export const __testOnlyDebtPositionsHooks: {
  beforeQuery: ((tx: PrismaClientOrTx) => Promise<void>) | null;
} = { beforeQuery: null };

interface DebtCursor {
  /** Decimal string — bigint-safe; the SQL casts it `::bigint`. */
  payableCents: string;
  payeeId: string;
  currency: string;
}

function encodeDebtCursor(c: DebtCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function isInt8Range(decimal: string): boolean {
  try {
    const v = BigInt(decimal);
    return v >= -(2n ** 63n) && v <= 2n ** 63n - 1n;
  } catch {
    return false;
  }
}

function decodeDebtCursor(raw: string | null | undefined): DebtCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as DebtCursor).payableCents === "string" &&
      /^-?\d{1,19}$/.test((parsed as DebtCursor).payableCents) &&
      // int8 range: a hand-edited out-of-range cursor must take the
      // documented restart-from-top path, not raise 22003 on the ::bigint cast.
      isInt8Range((parsed as DebtCursor).payableCents) &&
      typeof (parsed as DebtCursor).payeeId === "string" &&
      typeof (parsed as DebtCursor).currency === "string"
    ) {
      const c = parsed as DebtCursor;
      return {
        payableCents: c.payableCents,
        payeeId: c.payeeId,
        currency: c.currency,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface DebtPositionRawRow {
  payeeId: string;
  currency: string;
  payableCents: bigint;
  disputeDebitCents: bigint;
  refundDebitCents: bigint;
  lastDebitAt: Date | null;
  lastDebitType: PayeeLedgerDebtDebitType | null;
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  debtSinceAt: Date | null;
  totalCount: bigint;
}

/**
 * The debt-positions statement as a parameterised `Prisma.Sql`, exported so
 * the integration suite can `EXPLAIN (ANALYZE, BUFFERS)` the EXACT bytes the
 * adapter runs (`.text` + `.values`) instead of a retyped approximation.
 * `limit` must already be clamped; `cursor` already decoded.
 */
export function buildDebtPositionsSql(params: {
  asOf: Date;
  limit: number;
  cursor: DebtCursor | null;
}): Prisma.Sql {
  const { asOf, limit, cursor } = params;
  // Row-value comparison against the ORDER BY tuple: strictly after the
  // cursor row in (payable ASC, payeeId ASC, currency ASC) order.
  const cursorPredicate = cursor
    ? Prisma.sql`AND (c."payableCents", c."payeeId", c."currency")
        > (${cursor.payableCents}::bigint, ${cursor.payeeId}, ${cursor.currency})`
    : Prisma.empty;
  return Prisma.sql`
    -- MATERIALIZED: without the barrier the planner pulls this subquery up
    -- and re-evaluates the SUM (with its hashed subplans) in the WHERE, the
    -- ORDER BY key and the projection. Measured as a minor effect next to
    -- JIT (header), kept because one aggregate pass is the intended shape
    -- and the barrier makes the plan read the way the SQL does.
    WITH sums AS MATERIALIZED (
        SELECT
          e."payeeId",
          e."currency",
          SUM((${payableEffectSql(asOf)})::bigint)::bigint AS "entryCents",
          SUM(
            CASE WHEN e."type" = 'DISPUTE_DEBIT'
              -- DISPUTE_FEE_DEBIT_KEY_PREFIX (core write-refund-debits.ts):
              -- principal only; the fee twin is money on top of the credit.
              AND e."idempotencyKey" NOT LIKE 'dispute-debit-fee:%'
              THEN e."amountCents"::bigint ELSE 0 END
          )::bigint AS "disputeDebitCents",
          SUM(
            CASE WHEN e."type" = 'REFUND_DEBIT'
              THEN e."amountCents"::bigint ELSE 0 END
          )::bigint AS "refundDebitCents",
          MAX(
            CASE WHEN e."type" IN
              ('DISPUTE_DEBIT', 'REFUND_DEBIT', 'CASH_SALE_DEBIT')
              THEN e."createdAt" END
          ) AS "lastDebitAt"
        FROM public."PayeeLedgerEntry" e
        GROUP BY e."payeeId", e."currency"
    ),
    cells AS (
      SELECT
        s."payeeId" AS "payeeId",
        s."currency" AS "currency",
        -- bigint on purpose (header): display-only, never a transfer input.
        (s."entryCents" - COALESCE(b."ledgerPendingHoldCents", 0))::bigint AS "payableCents",
        s."disputeDebitCents" AS "disputeDebitCents",
        s."refundDebitCents" AS "refundDebitCents",
        s."lastDebitAt" AS "lastDebitAt"
      FROM sums s
      LEFT JOIN public."PayeeLedgerBalance" b
        ON b."payeeId" = s."payeeId" AND b."currency" = s."currency"
      WHERE (s."entryCents" - COALESCE(b."ledgerPendingHoldCents", 0)) < 0
    ),
    page AS (
      SELECT
        c.*,
        COUNT(*) OVER ()::bigint AS "totalCount"
      FROM cells c
      WHERE TRUE ${cursorPredicate}
      ORDER BY c."payableCents" ASC, c."payeeId" ASC, c."currency" ASC
      LIMIT ${limit + 1}
    ),
    -- The rows that will actually be RETURNED: the +1 lookahead row only
    -- answers hasNextPage and is sliced off, so it must not pay for a window
    -- pass over its journal.
    page_window AS (
      SELECT pw."payeeId", pw."currency"
      FROM page pw
      ORDER BY pw."payableCents" ASC, pw."payeeId" ASC, pw."currency" ASC
      LIMIT ${limit}
    ),
    running AS (
      SELECT
        e."payeeId",
        e."currency",
        e."createdAt",
        ROW_NUMBER() OVER (
          PARTITION BY e."payeeId", e."currency"
          ORDER BY e."createdAt" ASC, e."id" ASC
        ) AS "rn",
        SUM((${payableEffectSql(asOf)})::bigint) OVER (
          PARTITION BY e."payeeId", e."currency"
          ORDER BY e."createdAt" ASC, e."id" ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "bal"
      FROM public."PayeeLedgerEntry" e
      WHERE EXISTS (
        SELECT 1 FROM page_window pg
        WHERE pg."payeeId" = e."payeeId" AND pg."currency" = e."currency"
      )
    ),
    last_non_negative AS (
      SELECT
        r."payeeId",
        r."currency",
        COALESCE(MAX(r."rn") FILTER (WHERE r."bal" >= 0), 0) AS "lastNonNegRn"
      FROM running r
      GROUP BY r."payeeId", r."currency"
    ),
    since AS (
      SELECT
        r."payeeId",
        r."currency",
        MIN(r."createdAt") AS "debtSinceAt"
      FROM running r
      JOIN last_non_negative l
        ON l."payeeId" = r."payeeId" AND l."currency" = r."currency"
      WHERE r."rn" > l."lastNonNegRn" AND r."bal" < 0
      GROUP BY r."payeeId", r."currency"
    )
    SELECT
      pg."payeeId",
      pg."currency",
      pg."payableCents",
      pg."disputeDebitCents",
      pg."refundDebitCents",
      pg."lastDebitAt",
      pg."totalCount",
      py."subjectType"::text AS "subjectType",
      py."subjectId" AS "subjectId",
      s."debtSinceAt" AS "debtSinceAt",
      (
        SELECT d."type"::text
        FROM public."PayeeLedgerEntry" d
        WHERE d."payeeId" = pg."payeeId"
          AND d."currency" = pg."currency"
          AND d."type" IN ('DISPUTE_DEBIT', 'REFUND_DEBIT', 'CASH_SALE_DEBIT')
        ORDER BY d."createdAt" DESC, d."id" DESC
        LIMIT 1
      ) AS "lastDebitType"
    FROM page pg
    JOIN public."Payee" py ON py."id" = pg."payeeId"
    LEFT JOIN since s
      ON s."payeeId" = pg."payeeId" AND s."currency" = pg."currency"
    ORDER BY pg."payableCents" ASC, pg."payeeId" ASC, pg."currency" ASC
  `;
}

/**
 * Which budget killed the read, if any. `statement`: Postgres cancelled it
 * (`57014 query_canceled` — with the pg driver adapter the SQLSTATE rides
 * `code` on the error or on its `cause`; Prisma's wrapper exposes it as
 * `meta.code`). `transaction`: Prisma's interactive-tx `timeout` expired
 * first (`P2028`, "Transaction already closed" / "expired transaction").
 * The message matches are the last-resort net for re-wrapped errors.
 */
function classifyTimeout(err: unknown): "statement" | "transaction" | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as {
      code?: unknown;
      meta?: { code?: unknown };
      message?: unknown;
      cause?: unknown;
    };
    if (o.code === "57014" || o.meta?.code === "57014") return "statement";
    if (o.code === "P2028") return "transaction";
    if (typeof o.message === "string") {
      if (/statement timeout|57014/i.test(o.message)) return "statement";
      if (/transaction already closed|expired transaction|P2028/i.test(o.message)) {
        return "transaction";
      }
    }
    cur = o.cause;
  }
  return null;
}

async function listDebtPositions(
  p: PrismaClientOrTx,
  input: ListPayeeDebtPositionsInput,
): Promise<ListPayeeDebtPositionsResult> {
  const limit = Math.min(
    Math.max(input.limit ?? DEBT_DEFAULT_LIMIT, 1),
    DEBT_MAX_LIMIT,
  );
  const cursor = decodeDebtCursor(input.cursor);
  const sql = buildDebtPositionsSql({ asOf: input.now, limit, cursor });

  // Effective statement budget: caller's (clamped) or the default. Never
  // unbounded — the whole point is that the page cannot hang.
  const timeoutMs = Math.min(
    Math.max(
      Math.floor(
        input.statementTimeoutMs != null &&
          Number.isFinite(input.statementTimeoutMs)
          ? input.statementTimeoutMs
          : DEBT_DEFAULT_STATEMENT_TIMEOUT_MS,
      ),
      1,
    ),
    DEBT_MAX_STATEMENT_TIMEOUT_MS,
  );
  const txTimeoutMs = timeoutMs + TX_TIMEOUT_HEADROOM_MS;

  // Own transaction only (header): SET LOCAL on a caller's tx would leak
  // jit/timeout onto everything else in it.
  if (!hasTransaction(p)) {
    throw fail("INTERNAL", {
      message: "payee_ledger_debt_positions_requires_top_level_client",
      meta: { hint: "listDebtPositions must run outside repos.tx" },
    });
  }

  let rows: DebtPositionRawRow[];
  try {
    rows = await withLedgerTransaction(
      p,
      async (tx) => {
        // LOCAL scopes both settings to this transaction. `jit = off` is the
        // perf fix described in the header; `statement_timeout` is the
        // degrade path. SET cannot take a bind parameter; `timeoutMs` is an
        // integer we clamped ourselves, never caller text, so the
        // interpolation is a number literal by construction.
        await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        if (__testOnlyDebtPositionsHooks.beforeQuery) {
          await __testOnlyDebtPositionsHooks.beforeQuery(tx);
        }
        return tx.$queryRaw<DebtPositionRawRow[]>(sql);
      },
      { maxWait: DEBT_TX_MAX_WAIT_MS, timeout: txTimeoutMs },
    );
  } catch (err) {
    const expired = classifyTimeout(err);
    if (expired) {
      throw fail("SERVICE_UNAVAILABLE", {
        message: "payee_ledger_debt_positions_timeout",
        meta: {
          expired,
          statementTimeoutMs: timeoutMs,
          transactionTimeoutMs: txTimeoutMs,
        },
        cause: err,
      });
    }
    throw err;
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const items: PayeeLedgerDebtPosition[] = pageRows.map((r) => ({
    payeeId: r.payeeId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    currency: r.currency,
    payableCents: centsToNumber(r.payableCents),
    debtSinceAt: r.debtSinceAt,
    lastDebitType: r.lastDebitType,
    lastDebitAt: r.lastDebitAt,
    disputeDebitCents: centsToNumber(r.disputeDebitCents),
    refundDebitCents: centsToNumber(r.refundDebitCents),
  }));
  // Cursor comes from the RAW bigint, not the Number-mapped DTO: above 2^53
  // `centsToNumber` rounds, and a rounded keyset would skip or repeat a row.
  const lastRaw = pageRows[pageRows.length - 1];
  return {
    items,
    pageInfo: {
      cursorField: DEBT_CURSOR_FIELD,
      nextCursor:
        hasNextPage && lastRaw
          ? encodeDebtCursor({
              payableCents: lastRaw.payableCents.toString(),
              payeeId: lastRaw.payeeId,
              currency: lastRaw.currency,
            })
          : null,
      limit,
      hasNextPage,
    },
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
  };
}

// ── Unrecovered cash-sale debt (staff "Unpaid cash balances" view) ───────────
//
// READ-ONLY, DISPLAY-ONLY (spec 2026-10-07 R6 / FR-013). A door cash sale
// writes a CASH_SALE_DEBIT (the tax the organiser collected in cash; fee +
// tax on a sale before the owner ruling of 2026-10-08); the payout batch recovers it by netting it against later credits.
// This read lists the cash debt that has NOT been recovered and is older
// than a cutoff, per (payee, currency) cell.
//
// DEFINITION. Within one cell, credits pay debits oldest-first (FIFO), any
// debit type, where the debits are the entries with a NEGATIVE payable
// effect: REFUND_DEBIT, DISPUTE_DEBIT, CASH_SALE_DEBIT and ordinary PAYOUT.
// Reversals are netted against the debit they reverse BEFORE that, not
// spent FIFO: CASH_SALE_DEBIT_REVERSAL → its CASH_SALE_DEBIT,
// TRANSFER_REVERSAL_CREDIT → its REFUND_DEBIT, DISPUTE_RELEASE → its
// DISPUTE_DEBIT (each via `relatedEntryId`). Otherwise a refunded cash sale's
// reversal would "pay" an older cash debit and leave the refunded one
// looking unpaid. A debit's net = amount − Σ its reversals, floored at 0.
// A cash debit's UNRECOVERED remainder is what FIFO leaves of its net; it is
// OVERDUE when the debit's `createdAt` is before `olderThan`. A cell is
// listed when its overdue remainder is > 0.
//
// WHY THIS CAN BE COMPUTED WITHOUT REPLAYING THE JOURNAL. Under FIFO with a
// running balance B, a debit is only ever paid once every older debit is
// fully paid (a credit pays the head of the queue; a surplus exists only
// while the queue is empty, and a new debit spends it first). So the paid
// part of the debit sequence is always a PREFIX and the unpaid part a
// SUFFIX, and the unpaid total equals the deficit D = max(0, −B). Hence:
//
//   remainder(debit i) = clamp(D − Σ net of the debits NEWER than i, 0, net_i)
//
// i.e. the unpaid debts are "the newest debits that together make up the
// deficit" — the simpler formulation, provably the same thing. WHEN a credit
// landed (or matured) does not matter, only the final D does, which is why
// maturity order never enters the query. Netting a reversal against its debit
// leaves B unchanged (the pair contributes −x + x either way), so D is the
// cell's plain journal sum.
//
// D comes from the SAME shared `payableEffectSql` as the payout batch, at
// `now` (maturity, blocking, legacy PAYOUT sign included), so an unmatured or
// blocked credit has recovered nothing yet. The rollup's
// `ledgerPendingHoldCents` is NOT part of D — same posture as the debt
// desk's `debtSinceAt`: a pending hold is withholding of credits already in
// the journal, not a debit. If the dispute is lost it becomes a DISPUTE_DEBIT,
// NEWER than the cash debit, which FIFO then leaves unpaid instead; if it is
// won the credit stays. Either way the cash debt was recovered. The cell's
// payable (holds included) is still returned for display.
//
// Known edge: effectiveness is evaluated TODAY (as everywhere in this file).
// A credit that was paid out and is now frozen by an open claim reads 0, so
// the cell's deficit includes the payout that credit funded and FIFO may
// list an older cash debit until the claim resolves. Temporary and rare;
// reported as-is rather than modelled.
//
// Known edge 2 (UNDER-lists, code review 2026-10-08): the walk orders a
// PAYOUT by its row's createdAt, which is written after the Stripe transfer
// and, when that write fails, replayed by the next run's heal sweep. A cash
// debit written between the batch's payable read and that late PAYOUT row
// sorts OLDER than the payout, so the payout absorbs the deficit and the
// cash debit reads 0 here (it still shows on "Payees in debt"). Needs a
// failed PAYOUT write plus a door sale in the gap. The fix is to order a
// PAYOUT by the batch's planning instant (store it on the entry) — a
// run-batch change, left as a follow-up.
//
// MANUAL_ADJUSTMENT contributes 0 to the balance and is not in `debits`
// today. When its writer lands, a negative adjustment must join BOTH
// NON_CREDIT_EFFECT_SQL and the `debits` set below, or the walk pushes the
// excess onto the oldest debits and overstates cash debt.
//
// BOUNDED, for now. Candidate cells only ever grow (a cash debit older than
// the cutoff stays older), so before the page ships: EXPLAIN at volume and
// consider a partial index on ("payeeId","currency") WHERE type =
// 'CASH_SALE_DEBIT'. The candidate cells are those with an unreversed
// CASH_SALE_DEBIT older than the cutoff (one filtered pass over the ledger; the reversal
// probe matches the partial unique index on `relatedEntryId` for
// CASH_SALE_DEBIT_REVERSAL); the payable aggregate and the window run only
// over THOSE cells' entries (the (payeeId, createdAt) index covers the
// join), not every cell in the ledger, and nothing is loaded into Node.
// Not EXPLAIN-measured at volume; the statement budget is the backstop. The page is keyset-paginated on
// (overdue DESC, payeeId, currency). Runs in its own transaction with
// `SET LOCAL jit = off` + a statement budget via `withStatementBudget`, for
// the reason the debt desk header gives (the payable fragment trips JIT).

const CASH_DEBT_CURSOR_FIELD = "overdueCashDebtCents,payeeId,currency";

interface CashDebtCursor {
  /** Decimal string — bigint-safe; the SQL casts it `::bigint`. */
  overdueCents: string;
  payeeId: string;
  currency: string;
}

function encodeCashDebtCursor(c: CashDebtCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCashDebtCursor(
  raw: string | null | undefined,
): CashDebtCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as CashDebtCursor).overdueCents === "string" &&
      /^\d+$/.test((parsed as CashDebtCursor).overdueCents) &&
      isInt8Range((parsed as CashDebtCursor).overdueCents) &&
      typeof (parsed as CashDebtCursor).payeeId === "string" &&
      typeof (parsed as CashDebtCursor).currency === "string"
    ) {
      const c = parsed as CashDebtCursor;
      return {
        overdueCents: c.overdueCents,
        payeeId: c.payeeId,
        currency: c.currency,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface UnrecoveredCashDebtRawRow {
  payeeId: string;
  currency: string;
  unrecoveredCents: bigint;
  overdueCents: bigint;
  oldestUnrecoveredAt: Date;
  payableCents: bigint;
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  hasStripeAccount: boolean;
  payoutsEnabled: boolean;
  orgName: string | null;
  orgSlug: string | null;
  totalCount: bigint;
}

/**
 * The unrecovered-cash-debt statement as a parameterised `Prisma.Sql`,
 * exported so the integration suite can EXPLAIN the exact bytes the adapter
 * runs. `limit` must already be clamped; `cursor` already decoded. Aliases:
 * `e` is the payable fragment's row (it reserves the names listed on
 * `payableEffectSql`), so every other table here uses a name outside that set.
 */
export function buildUnrecoveredCashDebtsSql(params: {
  asOf: Date;
  olderThan: Date;
  limit: number;
  cursor: CashDebtCursor | null;
}): Prisma.Sql {
  const { asOf, olderThan, limit, cursor } = params;
  // Strictly after the cursor row in (overdue DESC, payeeId ASC, currency
  // ASC) order, written as an ascending row comparison on the negated key.
  const cursorPredicate = cursor
    ? Prisma.sql`AND (-(cl2."overdueCents"), cl2."payeeId", cl2."currency")
        > (-(${cursor.overdueCents}::bigint), ${cursor.payeeId}, ${cursor.currency})`
    : Prisma.empty;
  return Prisma.sql`
    WITH candidates AS MATERIALIZED (
      -- Cells holding at least one unreversed cash debit older than the
      -- cutoff: nothing else can have overdue cash debt.
      SELECT DISTINCT cd."payeeId", cd."currency"
      FROM public."PayeeLedgerEntry" cd
      WHERE cd."type" = 'CASH_SALE_DEBIT'
        AND cd."createdAt" < ${olderThan}
        AND NOT EXISTS (
          SELECT 1 FROM public."PayeeLedgerEntry" cdr
          WHERE cdr."relatedEntryId" = cd."id"
            AND cdr."type" = 'CASH_SALE_DEBIT_REVERSAL'
        )
    ),
    sums AS MATERIALIZED (
      -- The cell's journal sum with the batch's own sign table, at asOf;
      -- only cells in deficit can hold unrecovered debt.
      SELECT agg.*
      FROM (
        SELECT
          e."payeeId",
          e."currency",
          SUM((${payableEffectSql(asOf)})::bigint)::bigint AS "entryCents"
        FROM public."PayeeLedgerEntry" e
        JOIN candidates cand
          ON cand."payeeId" = e."payeeId" AND cand."currency" = e."currency"
        GROUP BY e."payeeId", e."currency"
      ) agg
      WHERE agg."entryCents" < 0
    ),
    reversals AS (
      -- What reverses a SPECIFIC debit, netted against that debit rather
      -- than spent FIFO (header). Cell-local, like the sum.
      SELECT
        rv."relatedEntryId" AS "debitId",
        SUM(rv."amountCents")::bigint AS "reversedCents"
      FROM public."PayeeLedgerEntry" rv
      JOIN sums sm ON sm."payeeId" = rv."payeeId" AND sm."currency" = rv."currency"
      WHERE rv."relatedEntryId" IS NOT NULL
        AND rv."type" IN (
          'CASH_SALE_DEBIT_REVERSAL', 'TRANSFER_REVERSAL_CREDIT', 'DISPUTE_RELEASE'
        )
      GROUP BY rv."relatedEntryId"
    ),
    debits AS (
      -- Every entry with a NEGATIVE payable effect (NON_CREDIT_EFFECT_SQL's
      -- minus arms), at its net amount.
      SELECT
        d."id",
        d."payeeId",
        d."currency",
        d."type",
        d."createdAt",
        GREATEST(d."amountCents"::bigint - COALESCE(rx."reversedCents", 0), 0)::bigint
          AS "netCents",
        (-sm."entryCents")::bigint AS "deficitCents"
      FROM public."PayeeLedgerEntry" d
      JOIN sums sm ON sm."payeeId" = d."payeeId" AND sm."currency" = d."currency"
      LEFT JOIN reversals rx ON rx."debitId" = d."id"
      WHERE d."type" IN ('REFUND_DEBIT', 'DISPUTE_DEBIT', 'CASH_SALE_DEBIT')
         OR (d."type" = 'PAYOUT' AND d."idempotencyKey" NOT LIKE 'debt-recovery:%')
    ),
    walked AS (
      -- Σ net of the debits NEWER than this one (newest first; id breaks a
      -- createdAt tie deterministically).
      SELECT
        dw.*,
        COALESCE(
          SUM(dw."netCents") OVER (
            PARTITION BY dw."payeeId", dw."currency"
            ORDER BY dw."createdAt" DESC, dw."id" DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ),
          0
        )::bigint AS "newerCents"
      FROM debits dw
    ),
    remaining AS (
      SELECT
        wk."payeeId",
        wk."currency",
        wk."createdAt",
        LEAST(wk."netCents", GREATEST(wk."deficitCents" - wk."newerCents", 0))::bigint
          AS "remainingCents"
      FROM walked wk
      WHERE wk."type" = 'CASH_SALE_DEBIT'
    ),
    cells AS (
      SELECT
        rm."payeeId",
        rm."currency",
        SUM(rm."remainingCents")::bigint AS "unrecoveredCents",
        COALESCE(
          SUM(rm."remainingCents") FILTER (WHERE rm."createdAt" < ${olderThan}),
          0
        )::bigint AS "overdueCents",
        MIN(rm."createdAt") FILTER (WHERE rm."remainingCents" > 0)
          AS "oldestUnrecoveredAt"
      FROM remaining rm
      GROUP BY rm."payeeId", rm."currency"
    ),
    page AS (
      SELECT
        cl2.*,
        COUNT(*) OVER ()::bigint AS "totalCount"
      FROM cells cl2
      WHERE cl2."overdueCents" > 0 ${cursorPredicate}
      ORDER BY cl2."overdueCents" DESC, cl2."payeeId" ASC, cl2."currency" ASC
      LIMIT ${limit + 1}
    )
    SELECT
      pg."payeeId",
      pg."currency",
      pg."unrecoveredCents",
      pg."overdueCents",
      pg."oldestUnrecoveredAt",
      pg."totalCount",
      (sm."entryCents" - COALESCE(bal."ledgerPendingHoldCents", 0))::bigint
        AS "payableCents",
      py."subjectType"::text AS "subjectType",
      py."subjectId" AS "subjectId",
      (py."stripeAccountId" IS NOT NULL) AS "hasStripeAccount",
      py."payoutsEnabled" AS "payoutsEnabled",
      og."name" AS "orgName",
      og."slug" AS "orgSlug"
    FROM page pg
    JOIN sums sm ON sm."payeeId" = pg."payeeId" AND sm."currency" = pg."currency"
    JOIN public."Payee" py ON py."id" = pg."payeeId"
    LEFT JOIN public."PayeeLedgerBalance" bal
      ON bal."payeeId" = pg."payeeId" AND bal."currency" = pg."currency"
    LEFT JOIN public."Organization" og
      ON py."subjectType" = 'ORGANIZATION' AND og."id" = py."subjectId"
    ORDER BY pg."overdueCents" DESC, pg."payeeId" ASC, pg."currency" ASC
  `;
}

async function listUnrecoveredCashDebts(
  p: PrismaClientOrTx,
  input: ListUnrecoveredCashDebtsInput,
): Promise<ListUnrecoveredCashDebtsResult> {
  const limit = Math.min(
    Math.max(input.limit ?? DEBT_DEFAULT_LIMIT, 1),
    DEBT_MAX_LIMIT,
  );
  const cursor = decodeCashDebtCursor(input.cursor);
  const sql = buildUnrecoveredCashDebtsSql({
    asOf: input.now,
    olderThan: input.olderThan,
    limit,
    cursor,
  });

  // Never unbudgeted: like the debt desk, this read backs a staff page that
  // must degrade to an inline error, not hang.
  const statementTimeoutMs =
    input.statementTimeoutMs != null && Number.isFinite(input.statementTimeoutMs)
      ? input.statementTimeoutMs
      : DEBT_DEFAULT_STATEMENT_TIMEOUT_MS;
  const rows = await withStatementBudget(
    p,
    { statementTimeoutMs },
    "payee_ledger_unrecovered_cash_debts",
    (client) => client.$queryRaw<UnrecoveredCashDebtRawRow[]>(sql),
  );

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const items: PayeeLedgerUnrecoveredCashDebt[] = pageRows.map((r) => ({
    payeeId: r.payeeId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    orgName: r.orgName,
    orgSlug: r.orgSlug,
    currency: r.currency,
    unrecoveredCashDebtCents: centsToNumber(r.unrecoveredCents),
    overdueCashDebtCents: centsToNumber(r.overdueCents),
    oldestUnrecoveredAt: r.oldestUnrecoveredAt,
    hasStripeAccount: r.hasStripeAccount,
    payoutsEnabled: r.payoutsEnabled,
    payableCents: centsToNumber(r.payableCents),
  }));
  // Cursor from the RAW bigint (see listDebtPositions).
  const lastRaw = pageRows[pageRows.length - 1];
  return {
    items,
    pageInfo: {
      cursorField: CASH_DEBT_CURSOR_FIELD,
      nextCursor:
        hasNextPage && lastRaw
          ? encodeCashDebtCursor({
              overdueCents: lastRaw.overdueCents.toString(),
              payeeId: lastRaw.payeeId,
              currency: lastRaw.currency,
            })
          : null,
      limit,
      hasNextPage,
    },
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
  };
}

// ── Reconciliation queries (spec 2026-08-10 §9) ─────────────────────────────
//
// READ-ONLY, all three: they SELECT, count, and sample — never write. Repair
// stays human (the ledger-admin MANUAL_ADJUSTMENT tool, when it lands); a job
// that "fixes" money it decided was wrong is a second writer with all the
// drift risk of the first.
//
// Overflow posture: every SUM here goes through ::bigint (Postgres SUM(int4)
// returns bigint anyway; the casts make it explicit) so a pathological cell
// FLAGS instead of raising 22003 the way the payable query's deliberate
// ::int bounds-check does. The payable query's raise is right for a transfer
// input (never silently wrap money you are about to SEND); it is wrong for a
// diagnostic sweep, whose entire job is to report the pathological cell.
//
// Sample caps: each query returns `total` (the FULL violation count, via
// COUNT(*) OVER ()) plus at most `sampleLimit` rows, so a drift that touches
// every cell cannot ship an unbounded payload into Sentry/Discord.

// Matches the verifyLedgerInvariants input schema's max (its Zod schema caps
// sampleLimit at 20) so the two layers advertise the same real ceiling.
const DEFAULT_INVARIANT_SAMPLE_LIMIT = 20;

/** Clamp a caller-supplied sample cap to something sane for an alert payload. */
function clampSampleLimit(sampleLimit: number | undefined): number {
  const n = sampleLimit ?? DEFAULT_INVARIANT_SAMPLE_LIMIT;
  return Math.max(1, Math.min(DEFAULT_INVARIANT_SAMPLE_LIMIT, Math.trunc(n)));
}

/**
 * bigint → number for report rows. Diagnostic only: the violation COMPARISON
 * happens in SQL on bigints, so a value beyond 2^53 here can at worst render
 * imprecisely in a sample row — it cannot mask or invent a violation.
 */
function centsToNumber(v: bigint | number): number {
  return Number(v);
}

/**
 * "No entry of a hold-consuming type points at hold row `e`" — the ACTIVE
 * predicate of `findActiveHoldRows` / `createDebitEntry`, as SQL, derived
 * from the SAME exported `RELEASE_TYPES` constant those use (drift-guard: if
 * a new release type is ever added to the constant, this predicate follows
 * automatically). The enclosing query must alias the DISPUTE_HOLD row as `e`
 * — the same binding convention as CREDIT_NOT_BLOCKED_SQL above.
 */
const HOLD_NOT_CONSUMED_SQL = Prisma.sql`
  NOT EXISTS (
    SELECT 1 FROM public."PayeeLedgerEntry" rel
    WHERE rel."relatedEntryId" = e."id"
      AND rel."type"::text = ANY(${[...RELEASE_TYPES]}::text[])
  )
`;

/**
 * Invariant 1 — rollup drift. Recomputes, per (payeeId, currency), the three
 * cached `PayeeLedgerBalance` counters from the entries and returns every
 * cell where any of them disagrees.
 *
 * Expected-value arithmetic mirrors the WRITERS in this file (the
 * `incrementLedgerBalance` / `incrementPendingHold` / reserve calls), NOT the
 * payable query — the rollup deliberately counts immature and blocked credits:
 *
 *   ledgerBalanceCents  = Σ SETTLEMENT_CREDIT + Σ TRANSFER_REVERSAL_CREDIT
 *                       + Σ CASH_SALE_DEBIT_REVERSAL
 *                       + Σ debit-compensating DISPUTE_RELEASE (relatedEntry
 *                         is a DISPUTE_DEBIT; the hold-release flavour has no
 *                         balance effect — same discrimination as the payable
 *                         query) − Σ REFUND_DEBIT − Σ DISPUTE_DEBIT
 *                       − Σ CASH_SALE_DEBIT
 *                       − Σ PAYOUT (legacy `debt-recovery:` rows +, matching
 *                         the += their deleted writer applied)
 *                       ; DISPUTE_HOLD / RESERVE_* contribute 0 (own buckets)
 *                       ; MANUAL_ADJUSTMENT contributes 0 — zero writers
 *                         exist today; when the ledger-admin correction tool
 *                         lands, its sign must be added HERE and in the
 *                         payable query together.
 *   ledgerPendingHoldCents = Σ ACTIVE DISPUTE_HOLD (no consuming entry of a
 *                            RELEASE_TYPES type — the shared predicate above)
 *   reserveBalanceCents    = Σ RESERVE_HOLD − Σ RESERVE_RELEASE (a release
 *                            releases exactly its hold's amount, at most
 *                            once, so this equals Σ unreleased holds)
 *
 * The FULL OUTER JOIN carries both defect shapes the upsert discipline can
 * mask: entries with no rollup row (an effect was lost — `rollupRowMissing`)
 * and rollup rows with no entries (`orphanRollupRow`). A missing rollup row
 * whose expected counters are all zero is NOT drift (the GREATEST(0,·)
 * decrement helpers legitimately skip row creation).
 *
 * Schema-qualified (public.*) for the same Neon empty-search_path wake-up
 * reason as the payable query.
 */
async function listRollupDrift(
  p: PrismaClientOrTx,
  sampleLimit?: number,
): Promise<PayeeLedgerInvariantScan<PayeeLedgerRollupDriftRow>> {
  const limit = clampSampleLimit(sampleLimit);
  const rows = await p.$queryRaw<
    Array<{
      payeeId: string;
      currency: string;
      cachedLedgerBalanceCents: bigint;
      expectedLedgerBalanceCents: bigint;
      cachedPendingHoldCents: bigint;
      expectedPendingHoldCents: bigint;
      cachedReserveCents: bigint;
      expectedReserveCents: bigint;
      rollupRowMissing: boolean;
      orphanRollupRow: boolean;
      totalCount: bigint;
    }>
  >`
    WITH expected AS (
      SELECT
        e."payeeId",
        e."currency",
        SUM(
          CASE
            WHEN e."type" IN ('SETTLEMENT_CREDIT', 'TRANSFER_REVERSAL_CREDIT', 'CASH_SALE_DEBIT_REVERSAL')
              THEN e."amountCents"::bigint
            WHEN e."type" = 'DISPUTE_RELEASE' THEN
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM public."PayeeLedgerEntry" rel
                  WHERE rel."id" = e."relatedEntryId"
                    AND rel."type" = 'DISPUTE_DEBIT'
                )
                THEN e."amountCents"::bigint
                ELSE 0
              END
            WHEN e."type" = 'PAYOUT' THEN
              CASE
                WHEN e."idempotencyKey" LIKE 'debt-recovery:%'
                THEN e."amountCents"::bigint
                ELSE -e."amountCents"::bigint
              END
            WHEN e."type" IN ('REFUND_DEBIT', 'DISPUTE_DEBIT', 'CASH_SALE_DEBIT')
              THEN -e."amountCents"::bigint
            ELSE 0
          END
        )::bigint AS "expectedLedgerBalanceCents",
        SUM(
          CASE
            WHEN e."type" = 'DISPUTE_HOLD' AND ${HOLD_NOT_CONSUMED_SQL}
            THEN e."amountCents"::bigint
            ELSE 0
          END
        )::bigint AS "expectedPendingHoldCents",
        SUM(
          CASE
            WHEN e."type" = 'RESERVE_HOLD' THEN e."amountCents"::bigint
            WHEN e."type" = 'RESERVE_RELEASE' THEN -e."amountCents"::bigint
            ELSE 0
          END
        )::bigint AS "expectedReserveCents"
      FROM public."PayeeLedgerEntry" e
      GROUP BY e."payeeId", e."currency"
    )
    SELECT
      COALESCE(x."payeeId", b."payeeId") AS "payeeId",
      COALESCE(x."currency", b."currency") AS "currency",
      COALESCE(b."ledgerBalanceCents", 0)::bigint AS "cachedLedgerBalanceCents",
      COALESCE(x."expectedLedgerBalanceCents", 0) AS "expectedLedgerBalanceCents",
      COALESCE(b."ledgerPendingHoldCents", 0)::bigint AS "cachedPendingHoldCents",
      COALESCE(x."expectedPendingHoldCents", 0) AS "expectedPendingHoldCents",
      COALESCE(b."reserveBalanceCents", 0)::bigint AS "cachedReserveCents",
      COALESCE(x."expectedReserveCents", 0) AS "expectedReserveCents",
      (b."payeeId" IS NULL) AS "rollupRowMissing",
      (x."payeeId" IS NULL) AS "orphanRollupRow",
      COUNT(*) OVER ()::bigint AS "totalCount"
    FROM expected x
    FULL OUTER JOIN public."PayeeLedgerBalance" b
      ON b."payeeId" = x."payeeId" AND b."currency" = x."currency"
    WHERE COALESCE(x."expectedLedgerBalanceCents", 0)
            <> COALESCE(b."ledgerBalanceCents", 0)
       OR COALESCE(x."expectedPendingHoldCents", 0)
            <> COALESCE(b."ledgerPendingHoldCents", 0)
       OR COALESCE(x."expectedReserveCents", 0)
            <> COALESCE(b."reserveBalanceCents", 0)
    ORDER BY 1 ASC, 2 ASC
    LIMIT ${limit}
  `;
  return {
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
    rows: rows.map((r) => ({
      payeeId: r.payeeId,
      currency: r.currency,
      cachedLedgerBalanceCents: centsToNumber(r.cachedLedgerBalanceCents),
      expectedLedgerBalanceCents: centsToNumber(r.expectedLedgerBalanceCents),
      cachedPendingHoldCents: centsToNumber(r.cachedPendingHoldCents),
      expectedPendingHoldCents: centsToNumber(r.expectedPendingHoldCents),
      cachedReserveCents: centsToNumber(r.cachedReserveCents),
      expectedReserveCents: centsToNumber(r.expectedReserveCents),
      rollupRowMissing: r.rollupRowMissing,
      orphanRollupRow: r.orphanRollupRow,
    })),
  };
}

/**
 * Invariant 2 — per-(order, payee, currency) conservation. Sign conventions
 * from the payable query's CASE: SETTLEMENT_CREDIT +, REFUND_DEBIT −,
 * DISPUTE_DEBIT −, TRANSFER_REVERSAL_CREDIT +, debit-compensating
 * DISPUTE_RELEASE + — all stored as positive `amountCents` (the type carries
 * direction, file-wide), so the checks compare positive sums:
 *
 *   Σ REFUND_DEBIT ≤ Σ SETTLEMENT_CREDIT   (a refund can never claw back
 *                                           more than was ever granted)
 *   Σ TRANSFER_REVERSAL_CREDIT ≤ Σ REFUND_DEBIT   (a reversal compensates a
 *                                           debit; more coming back than
 *                                           ever left is manufactured money)
 *   Σ REFUND_DEBIT + Σ DISPUTE_DEBIT − Σ debit-compensating DISPUTE_RELEASE
 *                              ≤ Σ SETTLEMENT_CREDIT
 *       (refunds and lost disputes together can never take back more of an
 *       order than the payee was credited for it. PRINCIPAL only: the
 *       `dispute-debit-fee:` entry — Stripe's dispute fee, debited to
 *       membership payees — is money on top of the credit, not a claim
 *       against it, so it and its `...-reversal-fee:` twin are excluded from
 *       BOTH sums (excluding one side alone would let a WON-after-LOST
 *       membership drive the left side negative and mask a real violation).
 *       The fee total is reported on the row for context, never compared.
 *       TRANSFER_REVERSAL_CREDIT
 *       is deliberately NOT subtracted on the left: it compensates a
 *       REFUND_DEBIT because the money came back through Stripe — the payee
 *       kept nothing more, so it must not make room for a dispute debit.
 *       Same reading as `retainedCreditByPayee`, the dispute-loss cap.)
 *
 *   Σ CASH_SALE_DEBIT_REVERSAL ≤ Σ CASH_SALE_DEBIT   (a gate refund can
 *                                           only give back what its cash
 *                                           sale debited; a cash order has
 *                                           no credit, so it is its own pair)
 *
 * DISPUTE_RELEASE is discriminated by what it relates to, exactly as in the
 * payable query and the rollup-drift check: the hold-release flavour
 * (relatedEntry is a DISPUTE_HOLD) has no balance effect and is ignored
 * here; only the WON-after-LOST reversal (relatedEntry is a DISPUTE_DEBIT)
 * counts as money given back.
 *
 * Entries with NULL orderId (payouts, reserves, some dispute rows) are out of
 * scope by construction — conservation is an ORDER-cell property.
 */
async function listConservationViolations(
  p: PrismaClientOrTx,
  sampleLimit?: number,
): Promise<PayeeLedgerInvariantScan<PayeeLedgerConservationViolationRow>> {
  const limit = clampSampleLimit(sampleLimit);
  const rows = await p.$queryRaw<
    Array<{
      orderId: string;
      payeeId: string;
      currency: string;
      creditCents: bigint;
      refundDebitCents: bigint;
      transferReversalCreditCents: bigint;
      disputeDebitCents: bigint;
      disputeDebitReversalCents: bigint;
      disputeFeeDebitCents: bigint;
      cashSaleDebitCents: bigint;
      cashSaleDebitReversalCents: bigint;
      totalCount: bigint;
    }>
  >`
    WITH cells AS (
      SELECT
        e."orderId" AS "orderId",
        e."payeeId" AS "payeeId",
        e."currency" AS "currency",
        SUM(
          CASE WHEN e."type" = 'SETTLEMENT_CREDIT'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "creditCents",
        SUM(
          CASE WHEN e."type" = 'REFUND_DEBIT'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "refundDebitCents",
        SUM(
          CASE WHEN e."type" = 'TRANSFER_REVERSAL_CREDIT'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "transferReversalCreditCents",
        SUM(
          CASE WHEN e."type" = 'DISPUTE_DEBIT'
            -- DISPUTE_FEE_DEBIT_KEY_PREFIX (core write-refund-debits.ts)
            AND e."idempotencyKey" NOT LIKE 'dispute-debit-fee:%'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "disputeDebitCents",
        SUM(
          CASE WHEN e."type" = 'DISPUTE_DEBIT'
            -- DISPUTE_FEE_DEBIT_KEY_PREFIX (core write-refund-debits.ts)
            AND e."idempotencyKey" LIKE 'dispute-debit-fee:%'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "disputeFeeDebitCents",
        SUM(
          CASE WHEN e."type" = 'DISPUTE_RELEASE'
            -- DISPUTE_FEE_REVERSAL_KEY_PREFIX (core write-refund-debits.ts)
            AND e."idempotencyKey" NOT LIKE 'dispute-debit-reversal-fee:%'
            AND EXISTS (
              SELECT 1 FROM public."PayeeLedgerEntry" d
              WHERE d."id" = e."relatedEntryId"
                AND d."type" = 'DISPUTE_DEBIT'
            )
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "disputeDebitReversalCents",
        SUM(
          CASE WHEN e."type" = 'CASH_SALE_DEBIT'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "cashSaleDebitCents",
        SUM(
          CASE WHEN e."type" = 'CASH_SALE_DEBIT_REVERSAL'
            THEN e."amountCents"::bigint ELSE 0 END
        )::bigint AS "cashSaleDebitReversalCents"
      FROM public."PayeeLedgerEntry" e
      WHERE e."orderId" IS NOT NULL
        AND e."type" IN
          ('SETTLEMENT_CREDIT', 'REFUND_DEBIT', 'TRANSFER_REVERSAL_CREDIT',
           'DISPUTE_DEBIT', 'DISPUTE_RELEASE', 'CASH_SALE_DEBIT',
           'CASH_SALE_DEBIT_REVERSAL')
      GROUP BY e."orderId", e."payeeId", e."currency"
    )
    SELECT
      c.*,
      COUNT(*) OVER ()::bigint AS "totalCount"
    FROM cells c
    WHERE c."refundDebitCents" > c."creditCents"
       OR c."transferReversalCreditCents" > c."refundDebitCents"
       OR c."refundDebitCents" + c."disputeDebitCents"
          - c."disputeDebitReversalCents" > c."creditCents"
       OR c."cashSaleDebitReversalCents" > c."cashSaleDebitCents"
    ORDER BY c."orderId" ASC, c."payeeId" ASC, c."currency" ASC
    LIMIT ${limit}
  `;
  return {
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
    rows: rows.map((r) => ({
      orderId: r.orderId,
      payeeId: r.payeeId,
      currency: r.currency,
      creditCents: centsToNumber(r.creditCents),
      refundDebitCents: centsToNumber(r.refundDebitCents),
      transferReversalCreditCents: centsToNumber(r.transferReversalCreditCents),
      disputeDebitCents: centsToNumber(r.disputeDebitCents),
      disputeDebitReversalCents: centsToNumber(r.disputeDebitReversalCents),
      disputeFeeDebitCents: centsToNumber(r.disputeFeeDebitCents),
      cashSaleDebitCents: centsToNumber(r.cashSaleDebitCents),
      cashSaleDebitReversalCents: centsToNumber(r.cashSaleDebitReversalCents),
    })),
  };
}

/**
 * Invariant 3 — completeness. Every order that SHOULD have minted
 * SETTLEMENT_CREDIT entries must have them, summing per payee to exactly the
 * payee's `OrderSplit` total.
 *
 * THE PREDICATE MIRRORS THE WRITERS' INPUTS, not a re-statement of business
 * rules: both credit writers — `createCreditsFromOrder` (ticketing: webhook
 * finalize + credit-covered checkout) and `recordMembershipInvoicePaid`
 * (memberships) — mint exactly ONE credit per payee whose amount is that
 * payee's summed `OrderSplit` rows, skipping payees whose sum is ≤ 0, under
 * the shared `settlement-credit:${orderId}:${payeeId}` key. So the source of
 * truth this check reads is the SAME `OrderSplit` rows those writers read:
 *
 *   * POS cash sales and free orders write NO OrderSplit rows
 *     (`record-cash-sale` explicitly; free checkout has nothing to split) →
 *     no expectation, correctly out of scope with no order-kind special-case;
 *   * zero/negative per-payee sums → no credit expected (HAVING > 0 mirrors
 *     the writers' `amount <= 0` skip);
 *   * status gate: SUCCEEDED and PART_REFUNDED only — both mean payment
 *     finalized and the mint should have happened. REFUNDED / DISPUTED /
 *     CANCELLED are deliberately out: a fully-refunded pre-cutover order is
 *     owed nothing and must not page anyone.
 *
 * ERA DISCRIMINATION — the `NOT EXISTS (SettlementLine)` clause: pre-cutover
 * orders were paid through the deleted Settlement system and legitimately
 * have NO ledger credits (only transferred/cancelled history in the frozen
 * tables; pending ones were backfilled with per-line amounts that need not
 * equal the raw split sums). Their tell is `SettlementLine` rows, which the
 * old writer created at payment time and which nothing writes post-cutover —
 * an era test carried by the DATA, with no hardcoded cutover date to rot. A
 * pre-cutover order whose settlement creation ALSO failed has neither
 * SettlementLine rows nor credits and IS flagged — correctly: it was
 * genuinely never paid.
 *
 * `finalizedBefore` is the caller's grace cutoff against `Order.updatedAt`
 * (the status flip to SUCCEEDED touches it; any later write only postpones
 * detection, never false-positives it) so an order whose finalize/webhook is
 * mid-flight is not flagged mid-mint.
 */
async function listCompletenessGaps(
  p: PrismaClientOrTx,
  finalizedBefore: Date,
  sampleLimit?: number,
): Promise<PayeeLedgerInvariantScan<PayeeLedgerCompletenessGapRow>> {
  const limit = clampSampleLimit(sampleLimit);
  const rows = await p.$queryRaw<
    Array<{
      orderId: string;
      payeeId: string;
      currency: string;
      expectedFromSplitsCents: bigint;
      creditCents: bigint;
      totalCount: bigint;
    }>
  >`
    SELECT
      s."orderId" AS "orderId",
      s."payeeId" AS "payeeId",
      o."currency" AS "currency",
      s."expectedFromSplitsCents" AS "expectedFromSplitsCents",
      COALESCE(c."creditCents", 0) AS "creditCents",
      COUNT(*) OVER ()::bigint AS "totalCount"
    FROM (
      SELECT
        os."orderId",
        os."payeeId",
        SUM(os."amountCents"::bigint)::bigint AS "expectedFromSplitsCents"
      FROM public."OrderSplit" os
      GROUP BY os."orderId", os."payeeId"
      HAVING SUM(os."amountCents"::bigint) > 0
    ) s
    JOIN public."Order" o ON o."id" = s."orderId"
    LEFT JOIN (
      SELECT
        e."orderId",
        e."payeeId",
        SUM(e."amountCents"::bigint)::bigint AS "creditCents"
      FROM public."PayeeLedgerEntry" e
      WHERE e."type" = 'SETTLEMENT_CREDIT'
      GROUP BY e."orderId", e."payeeId"
    ) c ON c."orderId" = s."orderId" AND c."payeeId" = s."payeeId"
    WHERE o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
      AND o."updatedAt" <= ${finalizedBefore}
      AND NOT EXISTS (
        SELECT 1 FROM public."SettlementLine" sl
        WHERE sl."orderId" = s."orderId"
      )
      AND COALESCE(c."creditCents", 0) <> s."expectedFromSplitsCents"
    ORDER BY o."updatedAt" ASC, s."orderId" ASC, s."payeeId" ASC
    LIMIT ${limit}
  `;
  return {
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
    rows: rows.map((r) => ({
      orderId: r.orderId,
      payeeId: r.payeeId,
      currency: r.currency,
      expectedFromSplitsCents: centsToNumber(r.expectedFromSplitsCents),
      creditCents: centsToNumber(r.creditCents),
    })),
  };
}

/**
 * Cancelled-event cash debits (see the port). A debit is "reversed" when a
 * CASH_SALE_DEBIT_REVERSAL points at it (`relatedEntryId`) — the adapter
 * writes at most one per debit. The grace cutoff is on the EVENT's
 * `updatedAt`: cancelling stamps it, and the cancellation's cash phase runs
 * right after the commit, so a fresh cancellation is not flagged mid-run.
 */
async function listUnreversedCashSaleDebitsOnCancelledEvents(
  p: PrismaClientOrTx,
  cancelledBefore: Date,
  sampleLimit?: number,
): Promise<PayeeLedgerInvariantScan<PayeeLedgerCancelledEventCashDebitRow>> {
  const limit = clampSampleLimit(sampleLimit);
  const rows = await p.$queryRaw<
    Array<{
      orderId: string;
      eventId: string;
      payeeId: string;
      currency: string;
      cashSaleDebitCents: bigint;
      totalCount: bigint;
    }>
  >`
    SELECT
      d."orderId" AS "orderId",
      ev."id" AS "eventId",
      d."payeeId" AS "payeeId",
      d."currency" AS "currency",
      d."amountCents"::bigint AS "cashSaleDebitCents",
      COUNT(*) OVER ()::bigint AS "totalCount"
    FROM public."PayeeLedgerEntry" d
    JOIN public."Order" o ON o."id" = d."orderId"
    JOIN public."Event" ev ON ev."id" = o."eventId"
    WHERE d."type" = 'CASH_SALE_DEBIT'
      AND ev."status" = 'CANCELLED'
      AND ev."updatedAt" <= ${cancelledBefore}
      AND NOT EXISTS (
        SELECT 1 FROM public."PayeeLedgerEntry" r
        WHERE r."type" = 'CASH_SALE_DEBIT_REVERSAL'
          AND r."relatedEntryId" = d."id"
      )
    ORDER BY ev."updatedAt" ASC, d."orderId" ASC
    LIMIT ${limit}
  `;
  return {
    total: rows.length > 0 ? centsToNumber(rows[0]!.totalCount) : 0,
    rows: rows.map((r) => ({
      orderId: r.orderId,
      eventId: r.eventId,
      payeeId: r.payeeId,
      currency: r.currency,
      cashSaleDebitCents: centsToNumber(r.cashSaleDebitCents),
    })),
  };
}

async function createHoldEntry(
  tx: PrismaClientOrTx,
  input: HoldPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_hold_amount_must_be_positive");
  }

  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "DISPUTE_HOLD",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: "dispute",
      sourceId: input.sourceId ?? input.disputeId,
      orderId: input.orderId ?? null,
      disputeId: input.disputeId,
      settlementId: null,
      relatedEntryId: null,
      description: input.description ?? `Dispute hold for ${input.disputeId}`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_hold_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

type DebitApplied = {
  created: boolean;
  consumedHold: PayeeLedgerEntry | null;
};

async function createDebitEntry(
  tx: PrismaClientOrTx,
  input: DebitPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, DebitApplied]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_debit_amount_must_be_positive");
  }

  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    return [mapPayeeLedgerEntry(existing), { created: false, consumedHold: null }];
  }

  const currency = normalizeCurrency(input.currency);

  // A debit that lands after a hold CONSUMES the hold: linking via
  // relatedEntryId is what makes findActiveHoldRows stop treating the hold as
  // active (DISPUTE_DEBIT is in RELEASE_TYPES). At most one hold exists per
  // (dispute, payee, currency) by the `dispute-hold:` idempotency-key
  // convention; a direct debit with no prior hold simply links nothing.
  //
  // `consumeHold: false` opts an entry OUT of this — the dispute FEE debit,
  // which is money on top of the principal and must never be the thing that
  // consumes the hold (otherwise the principal entry finds no hold and the
  // hold's cents are released against the wrong amount).
  const activeHolds =
    input.consumeHold === false
      ? []
      : await tx.payeeLedgerEntry.findMany({
          where: {
            disputeId: input.disputeId,
            payeeId: input.payeeId,
            currency,
            type: "DISPUTE_HOLD",
            relatedEntries: { none: { type: { in: [...RELEASE_TYPES] } } },
          },
          orderBy: { createdAt: "asc" },
          take: 1,
        });
  const consumedHold = activeHolds[0] ?? null;

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "DISPUTE_DEBIT",
      amountCents: input.amountCents,
      currency,
      sourceKind: "dispute",
      sourceId: input.sourceId ?? input.disputeId,
      orderId: input.orderId ?? null,
      disputeId: input.disputeId,
      settlementId: null,
      relatedEntryId: consumedHold?.id ?? null,
      description: input.description ?? `Dispute debit for ${input.disputeId}`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_debit_replay_missing");

  return [
    mapPayeeLedgerEntry(entry),
    {
      created: result.count === 1,
      consumedHold: result.count === 1 ? consumedHold : null,
    },
  ];
}

async function createDebitReversalEntry(
  tx: PrismaClientOrTx,
  input: ReverseDisputeDebitInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_debit_reversal_amount_must_be_positive");
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey, createMany with skipDuplicates, and balance effects
  // applied ONLY when the row was actually created (result.count === 1) — a
  // replay returns the existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      // DISPUTE_RELEASE, deliberately NOT PAYOUT: the dispute's claim on the
      // payee's money is what is being released. getBalance reads only the
      // rollup table, so the type is semantic; the balance direction
      // (ledgerBalance increment, holds untouched) is applied by the caller
      // above. See ReverseDisputeDebitInput for the full rationale.
      type: "DISPUTE_RELEASE",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: "dispute",
      sourceId: input.disputeId,
      orderId: input.orderId ?? null,
      disputeId: input.disputeId,
      settlementId: null,
      // Links the reversal to the DEBIT it compensates. Harmless to the
      // active-hold queries: those inspect DISPUTE_HOLD rows' relatedEntries,
      // and this entry relates to a debit, never a hold.
      relatedEntryId: input.debitEntryId,
      description:
        input.description ??
        `Dispute debit reversed for ${input.disputeId} (dispute won)`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_debit_reversal_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createSettlementCreditEntry(
  tx: PrismaClientOrTx,
  input: SettlementCreditPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_settlement_credit_amount_must_be_positive");
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey (`settlement-credit:${orderId}:${payeeId}` by convention),
  // createMany with skipDuplicates, and balance effects applied ONLY when the
  // row was actually created (result.count === 1) — a replay returns the
  // existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "SETTLEMENT_CREDIT",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      orderId: input.orderId,
      disputeId: null,
      settlementId: null,
      relatedEntryId: null,
      // The maturity date — required at the type level AND by the SQL CHECK
      // PayeeLedgerEntry_settlement_credit_available_check. Credits wait for
      // this; debits never wait for anything.
      availableAt: input.availableAt,
      description: input.description,
      // Required: carries { items: Record<orderItemId, contributionCents> },
      // the item-level attribution partial refunds and reporting read.
      metadata: toNullableJson(input.metadata),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_settlement_credit_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createRefundDebitEntry(
  tx: PrismaClientOrTx,
  input: RefundDebitPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_refund_debit_amount_must_be_positive");
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey (`refund-debit:${orderId}:${payeeId}:${refundId}` by
  // convention), createMany with skipDuplicates, and balance effects applied
  // ONLY when the row was actually created — a replay returns the existing
  // row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "REFUND_DEBIT",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      orderId: input.orderId,
      disputeId: null,
      settlementId: null,
      relatedEntryId: null,
      // No availableAt, ever: debits are always effective (the asymmetry
      // against SETTLEMENT_CREDIT is the design, not an omission).
      availableAt: null,
      description: input.description,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_refund_debit_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createTransferReversalCreditEntry(
  tx: PrismaClientOrTx,
  input: TransferReversalCreditPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error(
      "payee_ledger_transfer_reversal_credit_amount_must_be_positive",
    );
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey, createMany with skipDuplicates, and balance effects
  // applied ONLY when the row was actually created — a replay returns the
  // existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "TRANSFER_REVERSAL_CREDIT",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: input.sourceKind ?? "transfer_reversal",
      sourceId: input.sourceId ?? input.relatedEntryId,
      orderId: input.orderId,
      disputeId: null,
      settlementId: null,
      // Links the reversal to the REFUND_DEBIT it compensates — same linking
      // discipline as DISPUTE_RELEASE → DISPUTE_DEBIT. Harmless to the
      // dispute-hold queries: those inspect DISPUTE_HOLD rows' relatedEntries
      // for RELEASE_TYPES, and this type is in neither set.
      relatedEntryId: input.relatedEntryId,
      availableAt: null,
      description: input.description,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) {
    throw new Error("payee_ledger_transfer_reversal_credit_replay_missing");
  }
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createCashSaleDebitEntry(
  tx: PrismaClientOrTx,
  input: CashSaleDebitPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("payee_ledger_cash_sale_debit_amount_must_be_positive");
  }

  // Idempotency mechanics mirror `refundDebit` exactly: unique on
  // idempotencyKey (`cash-sale-debit:${orderId}` by convention), createMany
  // with skipDuplicates, and balance effects applied ONLY when the row was
  // actually created — a replay returns the existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "CASH_SALE_DEBIT",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      orderId: input.orderId,
      disputeId: null,
      settlementId: null,
      relatedEntryId: null,
      // Debits never wait for a maturity date.
      availableAt: null,
      description: input.description,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_cash_sale_debit_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

/**
 * Reverses ONE CASH_SALE_DEBIT, copying amount/payee/currency/order from the
 * debit row so a reversal can never undo more (or other) than was debited.
 * Null when the debit does not exist. A debit is reversed at most once, ever:
 * an existing reversal related to it — under this key or any other — is
 * returned as not-created (the reserveRelease discipline).
 */
async function createCashSaleDebitReversalEntry(
  tx: PrismaClientOrTx,
  input: CashSaleDebitReversalPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean] | null> {
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    if (existing.type !== "CASH_SALE_DEBIT_REVERSAL") {
      throw new Error("payee_ledger_cash_sale_debit_reversal_key_collision");
    }
    return [mapPayeeLedgerEntry(existing), false];
  }

  const debit = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.debitIdempotencyKey },
  });
  if (!debit) return null;
  if (debit.type !== "CASH_SALE_DEBIT") {
    throw new Error("payee_ledger_cash_sale_debit_reversal_target_not_a_debit");
  }

  const prior = await tx.payeeLedgerEntry.findFirst({
    where: { relatedEntryId: debit.id, type: "CASH_SALE_DEBIT_REVERSAL" },
  });
  if (prior) return [mapPayeeLedgerEntry(prior), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: debit.payeeId,
      type: "CASH_SALE_DEBIT_REVERSAL",
      amountCents: debit.amountCents,
      currency: debit.currency,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      orderId: debit.orderId,
      disputeId: null,
      settlementId: null,
      relatedEntryId: debit.id,
      availableAt: null,
      description: input.description,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) {
    throw new Error("payee_ledger_cash_sale_debit_reversal_replay_missing");
  }
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createPayoutDebitEntry(
  tx: PrismaClientOrTx,
  input: PayoutDebitPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_payout_debit_amount_must_be_positive");
  }
  // The payable query's PAYOUT sign discrimination rides on the key
  // namespace (`debt-recovery:%` counts +, everything else −). Make the
  // namespace structural, not conventional: a payout-debit written under
  // the legacy prefix would apply a −= rollup while the query reads it +=,
  // silently diverging query from rollup.
  if (input.idempotencyKey.startsWith("debt-recovery:")) {
    throw new Error("payee_ledger_payout_debit_key_namespace_reserved");
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey (`payout:${payoutItemId}` by convention — a DIFFERENT
  // namespace from the legacy `debt-recovery:${payoutItemId}`), createMany
  // with skipDuplicates, and balance effects applied ONLY when the row was
  // actually created — a replay returns the existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      // PAYOUT with money-OUT semantics (ledgerBalanceCents -= amount, in
      // the caller). The legacy debt-recovery writer used the same type with
      // the OPPOSITE effect and is deleted; the guard above keeps its key
      // namespace unwritable so query and rollup can never disagree.
      type: "PAYOUT",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      orderId: null,
      disputeId: null,
      settlementId: null,
      relatedEntryId: null,
      availableAt: null,
      description: input.description,
      // Required: carries the consumed credit entry ids — the FIFO
      // attribution record that pairs with markCreditsConsumed.
      metadata: toNullableJson(input.metadata),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_payout_debit_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createReserveHoldEntry(
  tx: PrismaClientOrTx,
  input: ReserveHoldPayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  if (input.amountCents <= 0) {
    throw new Error("payee_ledger_reserve_hold_amount_must_be_positive");
  }

  // Idempotency mechanics mirror `hold`/`debit` exactly: unique on
  // idempotencyKey (`reserve-hold:${payoutItemId}` by convention),
  // createMany with skipDuplicates, and balance effects applied ONLY when the
  // row was actually created — a replay returns the existing row untouched.
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: input.payeeId,
      type: "RESERVE_HOLD",
      amountCents: input.amountCents,
      currency: normalizeCurrency(input.currency),
      sourceKind: "payout_item",
      sourceId: input.payoutItemId,
      orderId: null,
      disputeId: null,
      settlementId: null,
      relatedEntryId: null,
      description:
        input.description ??
        `Rolling reserve withheld by payout item ${input.payoutItemId}`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) throw new Error("payee_ledger_reserve_hold_replay_missing");
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function createReserveReleaseEntry(
  tx: PrismaClientOrTx,
  hold: PayeeLedgerEntry,
  input: ReserveReleasePayeeLedgerInput,
): Promise<[PayeeLedgerEntryRecord, boolean]> {
  // Two guards, in the same order as releaseHoldRow:
  //  1. key replay — this exact release was already written;
  //  2. consumed hold — the hold was already released under ANOTHER key
  //     (shouldn't happen with the `reserve-release:${holdEntryId}` key
  //     convention, but a hold must release at most once EVER, so the
  //     invariant is enforced on the relation, not on the convention).
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return [mapPayeeLedgerEntry(existing), false];

  const consumed = await findReserveReleaseForHold(tx, hold.id);
  if (consumed) return [mapPayeeLedgerEntry(consumed), false];

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey: input.idempotencyKey,
      payeeId: hold.payeeId,
      type: "RESERVE_RELEASE",
      // Amount and currency come from the HOLD — a release returns exactly
      // what was deferred, never a caller-supplied figure.
      amountCents: hold.amountCents,
      currency: hold.currency,
      // sourceId = the payout item whose transfer CARRIES the released cents
      // (not the item the hold came from — that one is the hold's sourceId).
      // The crash sweep sums releases by this to compute how much of a
      // stamped reserveReleasedCents is still unwritten.
      sourceKind: "payout_item",
      sourceId: input.payoutItemId,
      orderId: null,
      disputeId: null,
      settlementId: null,
      relatedEntryId: hold.id,
      description:
        input.description ??
        `Rolling reserve released by payout item ${input.payoutItemId}`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const entry = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!entry) {
    if (result.count === 0) {
      const consumedAfterConflict = await findReserveReleaseForHold(tx, hold.id);
      if (consumedAfterConflict) {
        return [mapPayeeLedgerEntry(consumedAfterConflict), false];
      }
    }
    throw new Error("payee_ledger_reserve_release_replay_missing");
  }
  return [mapPayeeLedgerEntry(entry), result.count === 1];
}

async function findReserveReleaseForHold(
  tx: PrismaClientOrTx,
  holdEntryId: string,
): Promise<PayeeLedgerEntry | null> {
  const releases = await tx.payeeLedgerEntry.findMany({
    where: { relatedEntryId: holdEntryId, type: "RESERVE_RELEASE" },
    orderBy: { createdAt: "asc" },
    take: 1,
  });
  return releases[0] ?? null;
}

async function releaseHoldRow(
  tx: PrismaClientOrTx,
  hold: PayeeLedgerEntry,
  input: ReleasePayeeLedgerHoldInput,
): Promise<PayeeLedgerEntryRecord | null> {
  if (hold.type !== "DISPUTE_HOLD") return null;
  if (!hold.disputeId) return null;

  const idempotencyKey =
    input.idempotencyKey ?? `dispute-release:${hold.disputeId}:${hold.id}`;
  const existing = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return mapPayeeLedgerEntry(existing);

  const consumed = await findConsumedHoldRow(tx, hold.id);
  if (consumed) return mapPayeeLedgerEntry(consumed);

  const result = await tx.payeeLedgerEntry.createMany({
    data: {
      idempotencyKey,
      payeeId: hold.payeeId,
      type: "DISPUTE_RELEASE",
      amountCents: hold.amountCents,
      currency: hold.currency,
      sourceKind: "dispute",
      sourceId: hold.disputeId,
      orderId: hold.orderId,
      settlementId: hold.settlementId,
      disputeId: hold.disputeId,
      relatedEntryId: hold.id,
      description: input.description ?? `Dispute hold released for ${hold.disputeId}`,
      metadata: toNullableJson(input.metadata ?? null),
    },
    skipDuplicates: true,
  });
  const release = await tx.payeeLedgerEntry.findUnique({
    where: { idempotencyKey },
  });
  if (!release) {
    if (result.count === 0) {
      const consumedAfterConflict = await findConsumedHoldRow(tx, hold.id);
      if (consumedAfterConflict) return mapPayeeLedgerEntry(consumedAfterConflict);
    }
    throw new Error("payee_ledger_release_replay_missing");
  }

  if (result.count === 1) {
    await decreasePendingHoldWithoutGoingNegative(
      tx,
      hold.payeeId,
      hold.currency,
      hold.amountCents,
    );
  }

  return mapPayeeLedgerEntry(release);
}

async function findConsumedHoldRow(
  tx: PrismaClientOrTx,
  holdEntryId: string,
): Promise<PayeeLedgerEntry | null> {
  const consumed = await tx.payeeLedgerEntry.findMany({
    where: {
      relatedEntryId: holdEntryId,
      type: { in: [...RELEASE_TYPES] },
    },
    orderBy: { createdAt: "asc" },
    take: 1,
  });
  return consumed[0] ?? null;
}

async function findActiveHoldRows(
  p: PrismaClientOrTx,
  disputeId: string,
): Promise<PayeeLedgerEntry[]> {
  return p.payeeLedgerEntry.findMany({
    where: {
      disputeId,
      type: "DISPUTE_HOLD",
      relatedEntries: { none: { type: { in: [...RELEASE_TYPES] } } },
    },
    orderBy: { createdAt: "asc" },
  });
}

async function incrementPendingHold(
  tx: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  amountCents: number,
): Promise<void> {
  await tx.payeeLedgerBalance.upsert({
    where: { payeeId_currency: { payeeId, currency } },
    create: {
      payeeId,
      currency,
      ledgerBalanceCents: 0,
      ledgerPendingHoldCents: amountCents,
      reserveBalanceCents: 0,
    },
    update: {
      ledgerPendingHoldCents: { increment: amountCents },
    },
  });
}

async function incrementLedgerBalance(
  tx: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  deltaCents: number,
): Promise<void> {
  await tx.payeeLedgerBalance.upsert({
    where: { payeeId_currency: { payeeId, currency } },
    create: {
      payeeId,
      currency,
      ledgerBalanceCents: deltaCents,
      ledgerPendingHoldCents: 0,
      reserveBalanceCents: 0,
    },
    update: {
      ledgerBalanceCents: { increment: deltaCents },
    },
  });
}

async function incrementReserveBalance(
  tx: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  amountCents: number,
): Promise<void> {
  await tx.payeeLedgerBalance.upsert({
    where: { payeeId_currency: { payeeId, currency } },
    create: {
      payeeId,
      currency,
      ledgerBalanceCents: 0,
      ledgerPendingHoldCents: 0,
      reserveBalanceCents: amountCents,
    },
    update: {
      reserveBalanceCents: { increment: amountCents },
    },
  });
}

async function decreaseReserveBalanceWithoutGoingNegative(
  tx: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  amountCents: number,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "PayeeLedgerBalance"
    SET "reserveBalanceCents" = GREATEST(0, "reserveBalanceCents" - ${amountCents}),
        "updatedAt" = NOW()
    WHERE "payeeId" = ${payeeId}
      AND "currency" = ${currency}
  `);
}

async function decreasePendingHoldWithoutGoingNegative(
  tx: PrismaClientOrTx,
  payeeId: string,
  currency: string,
  amountCents: number,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "PayeeLedgerBalance"
    SET "ledgerPendingHoldCents" = GREATEST(0, "ledgerPendingHoldCents" - ${amountCents}),
        "updatedAt" = NOW()
    WHERE "payeeId" = ${payeeId}
      AND "currency" = ${currency}
  `);
}

/**
 * Interactive-transaction budget. Prisma's DEFAULTS are `maxWait: 2000` /
 * `timeout: 5000` ms; a statement that outlives `timeout` is killed by
 * PRISMA (P2028 "Transaction already closed"), not by Postgres, so any
 * `SET LOCAL statement_timeout` above 5s inside a default transaction is
 * unreachable. Callers that set a Postgres budget MUST pass a `timeout`
 * above it (`listDebtPositions` does).
 */
type LedgerTransactionOptions = { maxWait?: number; timeout?: number };

async function withLedgerTransaction<T>(
  p: PrismaClientOrTx,
  fn: (tx: PrismaClientOrTx) => Promise<T>,
  options?: LedgerTransactionOptions,
): Promise<T> {
  if (!hasTransaction(p)) return fn(p);
  // Invoke as a METHOD — destructuring $transaction off the client loses its
  // `this` binding and throws "_engineConfig of undefined" on a real
  // PrismaClient (latent until this repo was first constructed with a
  // top-level client instead of a TransactionClient).
  return (p as PrismaWithTransaction).$transaction(
    (tx: Prisma.TransactionClient) => fn(tx),
    options,
  );
}

function hasTransaction(p: PrismaClientOrTx): p is PrismaWithTransaction {
  return typeof (p as { $transaction?: unknown }).$transaction === "function";
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

function mapPayeeLedgerEntry(row: PayeeLedgerEntry): PayeeLedgerEntryRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    payeeId: row.payeeId,
    type: row.type,
    amountCents: row.amountCents,
    currency: row.currency,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    orderId: row.orderId ?? null,
    settlementId: row.settlementId ?? null,
    disputeId: row.disputeId ?? null,
    relatedEntryId: row.relatedEntryId ?? null,
    availableAt: row.availableAt ?? null,
    consumedByEntryId: row.consumedByEntryId ?? null,
    description: row.description,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
  };
}

function mapBalance(
  payeeId: string,
  currency: string,
  row: PayeeLedgerBalance | null,
) {
  const ledgerBalanceCents = row?.ledgerBalanceCents ?? 0;
  const pendingHoldCents = row?.ledgerPendingHoldCents ?? 0;
  const reserveCents = row?.reserveBalanceCents ?? 0;

  return {
    payeeId,
    currency,
    ledgerBalanceCents,
    pendingHoldCents,
    reserveCents,
    // Available = balance minus PROVISIONAL dispute holds, and NOTHING else.
    // `reserveCents` is deliberately NOT subtracted: a RESERVE_HOLD never
    // credited `ledgerBalanceCents` in the first place (the cents were
    // withheld before the transfer — see `reserveHold` above), so
    // subtracting it here would deduct the same money twice and read a
    // reserve-only payee as negative. The reserve is DEFERRED payout,
    // reported separately via `reserveCents`.
    availableCents: ledgerBalanceCents - pendingHoldCents,
  };
}

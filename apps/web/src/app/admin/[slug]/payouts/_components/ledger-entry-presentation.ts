import type { PayeeStatementEntry } from "@th/core/use-cases/payouts/get-payee-statement";

// ─────────────────────────────────────────────────────────────────────────────
// How one ledger row reads: its label, and which way (if any) it moved the
// balance.
//
// `amountCents` is stored POSITIVE on every type and the type carries the
// direction, so nothing here sums an amount without first deciding its sign.
// The sign has two sources, in this order:
//
//   1. THE BALANCE COLUMN ITSELF. Every row carries `balanceAfterCents`, and
//      rows are newest first, so `this − older` IS the row's signed effect —
//      the server's arithmetic, not a client re-derivation. This is what
//      keeps Change and Balance from ever contradicting each other on screen
//      (a "+$40" beside an unchanged balance is the contradiction it avoids:
//      a DISPUTE_RELEASE that released a HOLD moves no balance at all).
//   2. THE TYPE, only when the movement is unknown — a null balance, or the
//      oldest row on the last loaded page with more pages behind it. This is
//      the documented default direction per type; MANUAL_ADJUSTMENT has no
//      documented direction, so it stays unsigned until its balance says.
//
// The ledger opened at zero, so when there is no older row AND no further
// page, the older balance is 0 and the oldest row's movement is exact.
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerEntryType = PayeeStatementEntry["type"];

export const LEDGER_ENTRY_LABEL_KEY: Record<LedgerEntryType, string> = {
  SETTLEMENT_CREDIT: "admin.payoutsEntrySalesCredit",
  REFUND_DEBIT: "admin.payoutsEntryRefund",
  PAYOUT: "admin.payoutsEntryPayoutSent",
  DISPUTE_DEBIT: "admin.payoutsEntryDisputeLost",
  DISPUTE_RELEASE: "admin.payoutsEntryDisputeReleased",
  TRANSFER_REVERSAL_CREDIT: "admin.payoutsEntryTransferReversed",
  DISPUTE_HOLD: "admin.payoutsEntryDisputeHold",
  RESERVE_HOLD: "admin.payoutsEntryReserveHold",
  RESERVE_RELEASE: "admin.payoutsEntryReserveRelease",
  MANUAL_ADJUSTMENT: "admin.payoutsEntryAdjustment",
  // Door cash sale: the tax the organiser collected in cash and the platform
  // remits. Since the owner ruling of 2026-10-08 (cash = no platform fee) a
  // new debit is tax only; one recorded before it is platform fee + tax. The
  // key name predates the ruling; its copy is reworded separately.
  CASH_SALE_DEBIT: "admin.payoutsEntryCashSaleFees",
  CASH_SALE_DEBIT_REVERSAL: "admin.payoutsEntryCashSaleRefunded",
};

export type LedgerChange = {
  kind: "credit" | "debit" | "none";
  /** Absolute cents. */
  cents: number;
};

type ChangeEntry = Pick<
  PayeeStatementEntry,
  "type" | "amountCents" | "balanceAfterCents"
>;

const DEFAULT_DIRECTION: Record<LedgerEntryType, LedgerChange["kind"]> = {
  SETTLEMENT_CREDIT: "credit",
  TRANSFER_REVERSAL_CREDIT: "credit",
  DISPUTE_RELEASE: "credit",
  REFUND_DEBIT: "debit",
  DISPUTE_DEBIT: "debit",
  PAYOUT: "debit",
  DISPUTE_HOLD: "none",
  RESERVE_HOLD: "none",
  RESERVE_RELEASE: "none",
  MANUAL_ADJUSTMENT: "none",
  CASH_SALE_DEBIT: "debit",
  CASH_SALE_DEBIT_REVERSAL: "credit",
};

export function ledgerEntryChange(
  entry: ChangeEntry,
  olderBalanceAfterCents: number | null,
): LedgerChange {
  if (entry.balanceAfterCents !== null && olderBalanceAfterCents !== null) {
    const delta = entry.balanceAfterCents - olderBalanceAfterCents;
    if (delta > 0) return { kind: "credit", cents: delta };
    if (delta < 0) return { kind: "debit", cents: -delta };
    return { kind: "none", cents: entry.amountCents };
  }
  return { kind: DEFAULT_DIRECTION[entry.type], cents: entry.amountCents };
}

/**
 * The balance BEFORE row `index` — i.e. the next older row's balance-after.
 * Null when that row is on a page not loaded yet, or when `index` sits above
 * a page seam whose contiguity was not confirmed (a refetch may have opened
 * a gap — see `use-statement-pages.ts`); 0 when there is no older row at
 * all, because the ledger opened at zero.
 */
export function olderBalanceAfterCents(
  entries: ReadonlyArray<Pick<PayeeStatementEntry, "balanceAfterCents">>,
  index: number,
  hasMore: boolean,
  unconfirmedSeams: ReadonlySet<number> = new Set(),
): number | null {
  if (unconfirmedSeams.has(index)) return null;
  const older = entries[index + 1];
  if (older) return older.balanceAfterCents;
  return hasMore ? null : 0;
}

/** The verb for a row that moves a bucket rather than the balance. */
export function ledgerHoldVerb(
  type: LedgerEntryType,
): "held" | "released" | null {
  switch (type) {
    case "DISPUTE_HOLD":
    case "RESERVE_HOLD":
      return "held";
    case "RESERVE_RELEASE":
    case "DISPUTE_RELEASE":
      return "released";
    default:
      return null;
  }
}

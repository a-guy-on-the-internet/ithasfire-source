import type { PayeeLedgerEntryType } from "@th/types/repos/payee-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// ledgerEntryBalanceDeltaCents — the SIGNED effect of ONE ledger entry on
// `PayeeLedgerBalance.ledgerBalanceCents` (the "everything owed, matured or
// not" figure `getBalance` reports).
//
// THIS IS A MIRROR, NOT A SOURCE OF TRUTH. The authoritative mapping is the
// `expectedLedgerBalanceCents` CASE inside `listRollupDrift` in
// `packages/adapters/src/db/prisma/payee-ledger.ts` — the query the nightly
// invariant sweep uses to recompute the rollup from the entries and flag
// drift. That CASE is inline SQL, so it cannot be imported; this function
// restates it arm for arm, and `__tests__/ledger-entry-delta.test.ts` pins
// each arm against the adapter's source text so the two cannot silently
// diverge. If you change one, change the other in the same commit.
//
// Arm by arm (adapter line references are to the CASE in `listRollupDrift`):
//
//   SETTLEMENT_CREDIT, TRANSFER_REVERSAL_CREDIT,
//   CASH_SALE_DEBIT_REVERSAL                      +amount
//   DISPUTE_RELEASE                               +amount ONLY when the entry
//       it relates to (`relatedEntryId`) is a DISPUTE_DEBIT — the WON-after-
//       LOST reversal. The other flavour, a release of a DISPUTE_HOLD, moves
//       the pending-hold bucket and never the balance → 0.
//   PAYOUT                                        −amount, EXCEPT the legacy
//       `debt-recovery:` key namespace, which the deleted pre-cutover writer
//       applied as += and which the adapter still reads as +. New writers
//       cannot mint that namespace (`payoutDebit` throws on it), so it only
//       ever describes rows that already exist.
//   REFUND_DEBIT, DISPUTE_DEBIT, CASH_SALE_DEBIT  −amount
//   DISPUTE_HOLD, RESERVE_HOLD, RESERVE_RELEASE   0 — own rollup buckets
//   MANUAL_ADJUSTMENT                             0 — the adapter's `ELSE 0`
//       arm. ZERO WRITERS exist today (the ledger-admin correction tool has
//       not landed); the adapter's doc block says its sign must be added to
//       the rollup query and the payable query together when it does. Until
//       then a MANUAL_ADJUSTMENT row would not move the cached balance
//       either, so 0 here is the only honest mirror. Add the sign HERE in
//       that same commit.
//
// `amountCents` is stored POSITIVE on every type; the type carries the
// direction. Nothing here sums — one entry in, one signed integer out.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idempotency-key prefix of the DELETED pre-cutover debt-recovery writer.
 * The adapter's rollup query reads a PAYOUT under this prefix as a CREDIT
 * (`LIKE 'debt-recovery:%'`), and `payoutDebit` refuses to mint it, so the
 * namespace is frozen history. Exported so the test can pin the literal.
 */
export const LEGACY_DEBT_RECOVERY_KEY_PREFIX = "debt-recovery:";

/**
 * The slice of a ledger entry the balance delta depends on. Two fields beyond
 * `type` + `amountCents` are load-bearing, because the adapter's mapping is:
 *
 *   - `idempotencyKey` — discriminates the legacy `debt-recovery:` PAYOUT.
 *   - `relatedEntryType` — the TYPE of the row `relatedEntryId` points at,
 *     which is what tells a debit-compensating DISPUTE_RELEASE (+) from a
 *     hold-release (0). The entry record itself carries only the id, so the
 *     caller resolves it (`dispute-release-relations.ts`). REQUIRED, not
 *     optional, on purpose: a caller that has not done that resolution
 *     would silently get 0 for a won-after-lost release — the wrong sign —
 *     and must be made to say `null` out loud. `null` means "no related row,
 *     or not a DISPUTE_DEBIT"; only the literal "DISPUTE_DEBIT" flips the
 *     sign, exactly as the SQL's EXISTS.
 *
 * Deliberately NOT re-exported from `payouts/index.ts`: the only callers with
 * the dispute plumbing to fill `relatedEntryType` honestly are the statement
 * and the ledger export. Import from this path directly if another appears.
 */
export type LedgerDeltaEntry = {
  type: PayeeLedgerEntryType;
  /** POSITIVE integer cents, as stored. */
  amountCents: number;
  idempotencyKey: string;
  relatedEntryType: PayeeLedgerEntryType | null;
};

/**
 * Signed cents this entry added to (positive) or removed from (negative)
 * `ledgerBalanceCents` when it was applied. 0 for every type that lives in
 * another bucket.
 */
export function ledgerEntryBalanceDeltaCents(entry: LedgerDeltaEntry): number {
  const amount = entry.amountCents;
  switch (entry.type) {
    case "SETTLEMENT_CREDIT":
    case "TRANSFER_REVERSAL_CREDIT":
    case "CASH_SALE_DEBIT_REVERSAL":
      return amount;
    case "DISPUTE_RELEASE":
      return entry.relatedEntryType === "DISPUTE_DEBIT" ? amount : 0;
    case "PAYOUT":
      return entry.idempotencyKey.startsWith(LEGACY_DEBT_RECOVERY_KEY_PREFIX)
        ? amount
        : -amount;
    case "REFUND_DEBIT":
    case "DISPUTE_DEBIT":
    case "CASH_SALE_DEBIT":
      return -amount;
    case "DISPUTE_HOLD":
    case "RESERVE_HOLD":
    case "RESERVE_RELEASE":
    case "MANUAL_ADJUSTMENT":
      return 0;
    default: {
      // Exhaustiveness: a new enum member fails to compile here AND lands in
      // the adapter's `ELSE 0` arm, so "0 until someone decides" is the
      // mirror of what the rollup query would do with it.
      const _never: never = entry.type;
      void _never;
      return 0;
    }
  }
}

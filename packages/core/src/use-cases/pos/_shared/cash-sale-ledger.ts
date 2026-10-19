import type { TxRepos } from "@th/ports/repos";

/**
 * Ledger plumbing shared by `recordCashSale` (writes the CASH_SALE_DEBIT) and
 * `refundCashSale` (writes its CASH_SALE_DEBIT_REVERSAL). Spec 2026-10-07
 * door-sales-same-price-and-tax, FR-004 / FR-008; owner ruling R6.
 *
 * ONE debit per cash order, keyed by the order id, so a replayed write is a
 * no-op in the adapter (unique `idempotencyKey`) and the refund can name the
 * debit it reverses without a read.
 */
export const CASH_SALE_DEBIT_KEY_PREFIX = "cash-sale-debit:";
export const CASH_SALE_DEBIT_REVERSAL_KEY_PREFIX = "cash-sale-debit-reversal:";

export function cashSaleDebitKey(orderId: string): string {
  return `${CASH_SALE_DEBIT_KEY_PREFIX}${orderId}`;
}

export function cashSaleDebitReversalKey(orderId: string): string {
  return `${CASH_SALE_DEBIT_REVERSAL_KEY_PREFIX}${orderId}`;
}

/**
 * Set when `resolveCashSalePayee` tried to create the org's placeholder payee
 * in this transaction attempt — the one write in a cash sale that can lose a
 * race on a unique key against a concurrent sale.
 */
export type CashSalePayeeRace = { placeholderAttempted: boolean };

/**
 * The payee that owes a cash sale's tax (owner ruling 2026-10-08: cash = no
 * platform fee; sales before it also owed the fee): the ORGANISATION that
 * runs the event, because it is the one holding the cash. Payout setup is NOT required
 * to sell cash (R6): when the org has no Payee row yet, a PENDING placeholder
 * (no Stripe account, payouts disabled) is created, the same move
 * `update-event-splits` and `resolve-resale-seller-split` make. The debit then
 * sits on that payee as a negative balance; `run-batch` pays it nothing (a
 * negative cell is below the payout minimum) and nets it against the first
 * card revenue once the org connects Stripe.
 */
export async function resolveCashSalePayee(
  tx: TxRepos,
  orgId: string,
  race?: CashSalePayeeRace,
): Promise<{ payeeId: string; placeholderCreated: boolean }> {
  const existing = await tx.payees.getBySubject({
    type: "ORGANIZATION",
    id: orgId,
  });
  if (existing) {
    return { payeeId: existing.id, placeholderCreated: false };
  }
  // Two first cash sales for the same org can both get here; the loser's
  // insert hits @@unique(subjectType, subjectId) as P2002. That aborts the
  // Postgres transaction, so it cannot be caught and re-read here — the
  // caller sees the flag, and retries its (rolled-back) transaction once,
  // where the read above finds the winner's payee.
  if (race) race.placeholderAttempted = true;
  const created = await tx.payees.upsertForSubject({
    subjectType: "ORGANIZATION",
    subjectId: orgId,
  });
  return { payeeId: created.id, placeholderCreated: true };
}

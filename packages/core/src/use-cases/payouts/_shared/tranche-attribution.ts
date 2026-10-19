import { fail } from "@th/errors";

import type { ListPayeeLedgerEntriesOptions } from "@th/ports/repos/payee-ledger";

/**
 * The tranche shape this helper needs — a structural subset of
 * `PayeeLedgerUpcomingMaturity`, so a real tranche row is always assignable.
 */
export interface TrancheKey {
  payeeId: string;
  currency: string;
  maturesAt: Date;
}

export interface TrancheAttributionInput {
  /** The tranche whose sub-lines are being fetched. */
  tranche: TrancheKey;
  /**
   * The tranche IMMEDIATELY BEFORE it for the SAME payee and the SAME
   * currency, or `null`/omitted when this is that payee-currency's first
   * upcoming tranche.
   *
   * "Same currency" is not a formality. `listUpcomingMaturities` orders by
   * `maturesAt` ASC, then `payeeId`, then `currency`, so consecutive rows in
   * the feed routinely belong to DIFFERENT currencies. Handing this the
   * previous ROW rather than the previous row IN THIS CURRENCY moves the
   * window's lower bound to an unrelated date. That is why the mismatch
   * throws instead of being silently tolerated.
   */
  previousTranche?: TrancheKey | null;
  /**
   * `asOf` — the SAME instant given to `listUpcomingMaturities`. Used as the
   * lower bound for the FIRST tranche, matching that read's own
   * `availableAt > asOf`.
   */
  asOf: Date;
  /** Row cap for the sub-line list. Passed straight through. */
  limit?: number;
}

/**
 * THE definition of "which ledger entries are behind this tranche", as one
 * options object for `PayeeLedgerRepo.listEntries`.
 *
 * It exists as a function rather than a doc comment because the bundle is
 * four coupled options and getting any one wrong is invisible in review but
 * loud in front of a customer: the sub-lines stop summing to the heading
 * above them. Layer 2 calls this; nothing assembles the bundle by hand.
 *
 * ## The window is HALF-OPEN: `(previous.maturesAt, tranche.maturesAt]`
 *
 * `availableAtAfter` is STRICT and `availableAtBefore` is INCLUSIVE — the
 * asymmetry documented on `ListPayeeLedgerEntriesOptions` exists for exactly
 * this. Adjacent tranches therefore PARTITION the payee's upcoming credits:
 * a credit maturing on the previous tranche's date is excluded here (it was
 * counted there), and one maturing on this tranche's date is included. No
 * row is shared, none is dropped.
 *
 * Using `asOf` as the lower bound for every tranche — the obvious mistake —
 * selects the rows behind ALL of them, so 11 Oct and 18 Oct credits render
 * under a "4 Oct — $5,500" heading.
 *
 * ## What is deliberately NOT here
 *
 * `unconsumedOnly`. `listUpcomingMaturities` applies no consumption filter,
 * so adding one lists fewer rows than the heading counted. The invariant is
 * one-directional: whatever the tranche COUNTS, the attribution LISTS. Every
 * filter in this bundle has a counterpart in that read —
 * `types`/`currency`/the maturity window/`excludeBlockedCredits` — and
 * nothing else may be added without one.
 */
export function trancheAttributionOptions(
  input: TrancheAttributionInput,
): ListPayeeLedgerEntriesOptions {
  const { tranche, previousTranche, asOf, limit } = input;

  if (previousTranche) {
    if (previousTranche.payeeId !== tranche.payeeId) {
      throw fail("INTERNAL", {
        message: "tranche_attribution_payee_mismatch",
        meta: {
          tranchePayeeId: tranche.payeeId,
          previousPayeeId: previousTranche.payeeId,
        },
      });
    }
    if (previousTranche.currency !== tranche.currency) {
      throw fail("INTERNAL", {
        message: "tranche_attribution_currency_mismatch",
        meta: {
          trancheCurrency: tranche.currency,
          previousCurrency: previousTranche.currency,
        },
      });
    }
    if (previousTranche.maturesAt.getTime() >= tranche.maturesAt.getTime()) {
      // A non-ascending pair means the caller walked the feed in the wrong
      // order (or reused a row from another currency). Left unchecked it
      // produces an EMPTY or INVERTED window, which renders as "this tranche
      // is made of nothing" — a money view silently showing zero.
      throw fail("INTERNAL", {
        message: "tranche_attribution_window_not_ascending",
        meta: {
          previousMaturesAt: previousTranche.maturesAt.toISOString(),
          maturesAt: tranche.maturesAt.toISOString(),
        },
      });
    }
  }

  return {
    // Per (payee, currency, maturesAt) — omitting the currency merges every
    // currency the payee holds into one list.
    currency: tranche.currency,
    // The tranche read counts SETTLEMENT_CREDIT and nothing else. The
    // maturity window already implies this (availableAt is NULL on every
    // other type), but stating it keeps the two reads legibly aligned.
    types: ["SETTLEMENT_CREDIT"],
    availableAtAfter: previousTranche ? previousTranche.maturesAt : asOf,
    availableAtBefore: tranche.maturesAt,
    // The tranche total already drops blocked credits.
    excludeBlockedCredits: true,
    limit,
  };
}

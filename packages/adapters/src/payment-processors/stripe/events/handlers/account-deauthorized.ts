// adapters/stripe/events/handlers/account-deauthorized.ts
import type { AccountDeauthorized } from "../guards";
import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";

export interface AccountDeauthorizedResult {
  payeeId: string | null;
}

/**
 * Handle `account.application.deauthorized` — a connected account revoked
 * our platform's authorization.
 *
 * Marks the payee as RESTRICTED with payouts/charges disabled. That is the
 * WHOLE handler, deliberately: the pre-ledger version also cancelled the
 * payee's pending settlements (`settlements.cancelForPayee`), but in the
 * ledger-authoritative world (spec §7) a deauthorized payee's
 * SETTLEMENT_CREDITs STAY on the ledger — money owed doesn't vanish with
 * Stripe access. What stops transfers to the dead account is the payout
 * batch's `payoutsEnabled` eligibility guard (which the restriction above
 * flips off); if the payee later re-onboards, their balance pays out
 * normally with no data to resurrect.
 */
export async function onAccountDeauthorized(
  deps: { repos: Repos; logger?: LoggerPort },
  acct: AccountDeauthorized,
): Promise<AccountDeauthorizedResult> {
  const payee = await deps.repos.payees.markDeauthorized(acct.id);

  if (!payee) {
    deps.logger?.warn("onAccountDeauthorized.payee_not_found", {
      stripeAccountId: acct.id,
    });
    return { payeeId: null };
  }

  deps.logger?.info("onAccountDeauthorized.payee_restricted", {
    payeeId: payee.id,
    stripeAccountId: acct.id,
  });

  return { payeeId: payee.id };
}

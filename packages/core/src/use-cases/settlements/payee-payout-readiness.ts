import type { PayeeRecord } from "@th/types/repos/payees";

/** Why the payout batch would skip this payee, or `null` when it can pay. */
export type PayeePayoutBlocker =
  | "payee_not_found"
  | "payee_missing_stripe_account"
  | "payee_payouts_disabled";

/**
 * The payout batch's eligibility test for one payee: a Stripe Connect account
 * AND `payoutsEnabled` (the flag the Connect sync maintains). `Payee.status`
 * is deliberately not part of it — see the comment at the call site in
 * `run-batch.ts`.
 *
 * Shared so that anything which promises a payee money later (a resale
 * listing) asks the same question the batch that pays them will ask.
 */
export function payeePayoutBlocker(
  payee: Pick<PayeeRecord, "stripeAccountId" | "payoutsEnabled"> | null,
): PayeePayoutBlocker | null {
  if (!payee) return "payee_not_found";
  if (!payee.stripeAccountId) return "payee_missing_stripe_account";
  if (!payee.payoutsEnabled) return "payee_payouts_disabled";
  return null;
}

import { z } from "zod";

import { parseInput } from "../../lib/io";

/**
 * Stripe Connect's $2 monthly ACTIVE-account fee, recovered as a payout
 * deduction.
 *
 * ── The rule, as it is said to a venue ──────────────────────────────────────
 *   "If you sold tickets this month, memberships cost you nothing.
 *    If you didn't, we deduct the $2 Stripe charges us to pay you."
 *
 * ── Why a deduction and not a charge ────────────────────────────────────────
 * Collecting $2 separately burns ~$0.36 in processing to recover $2 — an 18%
 * loss on the recovery. We are merchant of record and the money already flows
 * through our own pipeline, so withholding costs nothing: the retained cents
 * simply stay on the platform balance. There is no second Stripe call.
 *
 * ── What actually triggers Stripe's fee ─────────────────────────────────────
 * Stripe bills the PLATFORM $2 per Express connected account, but ONLY for
 * calendar months in which that account RECEIVES A PAYOUT. Dormant accounts
 * cost nothing. Two consequences drive every branch below:
 *
 *   1. The fee is per account-MONTH, not per payout. Once an account has
 *      received one payout this month, every further payout that month has
 *      genuinely zero marginal cost — so at most ONE deduction per payee per
 *      calendar month, ever.
 *   2. An account already settling TICKET revenue was going to be active
 *      regardless, so we eat the $2 as a cost of ticketing (which is exactly
 *      what we do today) and deduct nothing.
 *
 * Note the mechanic is about ticket revenue *settling* this month, not ticket
 * *sales* this month: Stripe charges on the payout, so the payout is what the
 * question has to be asked about. For a venue selling and settling on a normal
 * cadence these coincide, which is why the plain-English sentence above is
 * still honest.
 *
 * ── Order of operations: the minimum gate comes FIRST ───────────────────────
 * The spec is explicit — a balance below `payoutMinimumCents` "does not pay
 * out, and is therefore never charged the $2." So the minimum is evaluated on
 * the GROSS group total, before any deduction, by the caller; this helper only
 * re-asserts it defensively.
 *
 * We deliberately do NOT re-gate on the post-deduction amount. Doing so would
 * mean a payee whose steady monthly balance sits just above the minimum pays
 * out only every other month — reintroducing exactly the "your money arrives
 * later" delay that the spec rejects when it rules out quarterly batching. The
 * minimum answers "is this balance worth moving at all"; once we've decided to
 * move it, the fee is a real cost of moving it and comes out of the transfer.
 * With the default $10 minimum against a $2 fee, the worst case is a payee
 * receiving $8 — bounded, and the pathological "$2 out of a $3 payout" the
 * spec warns about is impossible because $3 never pays out.
 *
 * ── Fail safe: deduct only on positive evidence ─────────────────────────────
 * A deduction requires MEMBERSHIP revenue to be present in the payout, not
 * merely the absence of ticketing revenue. A settlement group we cannot
 * classify (no lines, an unrecognised source) is left alone. We would rather
 * eat $2 than take $2 we cannot justify on a payee's statement.
 */

/** Why the computed deduction is what it is. Recorded on the audit entry. */
export type ConnectAccountFeeReason =
  /** The full fee was withheld from this transfer. */
  | "deducted"
  /** Recovery is switched off (policy fee is 0). */
  | "no_fee_configured"
  /** Defensive: the group is below the payout minimum and shouldn't be paying out. */
  | "below_payout_minimum"
  /** This payout carries ticket revenue — the account was active regardless. */
  | "ticketing_revenue_in_payout"
  /** Nothing here is membership revenue, so there is nothing to recover against. */
  | "no_membership_revenue_in_payout"
  /** A payout already transferred for this payee this calendar month. */
  | "account_already_active_this_month"
  /**
   * Cross-worker guard: another batch run already claimed this payee's fee for
   * the month (idempotency key `connect-fee:<payee>:<YYYY-MM>` — per
   * ACCOUNT-month, no currency: Stripe bills the account once regardless of
   * how many currencies pay out), so stamping it again here would
   * double-deduct. Decided by the caller, not by this pure helper.
   */
  | "fee_already_claimed_this_month"
  /** Withholding would leave nothing (or less than nothing) to transfer. */
  | "would_zero_transfer";

export const connectAccountFeeDeductionInputSchema = z
  .object({
    /** GROSS payout for this (payee, currency) group, in cents. */
    groupTotalCents: z.number().int().nonnegative(),
    /** Stripe's monthly active-account fee, in cents. 0 disables recovery. */
    feeCents: z.number().int().nonnegative(),
    /** Minimum gross balance that pays out at all, in cents. */
    payoutMinimumCents: z.number().int().nonnegative(),
    /** Any settlement in this group traces to an `Order.kind = TICKETING`. */
    hasTicketingRevenueInPayout: z.boolean(),
    /** Any settlement in this group traces to an `Order.kind = MEMBERSHIP`. */
    hasMembershipRevenueInPayout: z.boolean(),
    /**
     * This payee already had a payout item TRANSFER earlier in the same
     * calendar month — including earlier in this very batch run. Stripe's fee
     * for that account-month is therefore already incurred.
     */
    accountAlreadyActiveThisMonth: z.boolean(),
    /**
     * Cents already withheld from this payout by HIGHER-PRIORITY deductions —
     * today, dispute-debt recovery, which comes first because it is real money
     * the payee owes. The fee's zero-transfer fail-safe is evaluated against
     * what actually remains after those, not against the gross: a $2 fee that
     * fits the gross but not the post-debt remainder is absorbed, never taken.
     * The minimum gate deliberately still reads the GROSS (see above) —
     * whether a balance is worth moving is a question about the balance, not
     * about the debt riding on it. Defaults to 0 so existing callers are
     * untouched.
     */
    priorWithholdingCents: z.number().int().nonnegative().default(0),
  })
  .strict();

export type ConnectAccountFeeDeductionInput = z.infer<
  typeof connectAccountFeeDeductionInputSchema
>;

export interface ConnectAccountFeeDeduction {
  /**
   * Cents to withhold. Always non-negative, and when positive it leaves at
   * least one transferable cent after every deduction:
   * `deductionCents + priorWithholdingCents < groupTotalCents`.
   */
  deductionCents: number;
  reason: ConnectAccountFeeReason;
}

/**
 * Smallest transfer we are willing to send to Stripe. A transfer of 0 is
 * rejected outright, and a transfer of dust still costs the payout fee, so if
 * withholding would take us there we withhold nothing instead and absorb the
 * cost. Unreachable while `payoutMinimumCents >= feeCents` (the shipped
 * config); this exists so a misconfigured policy cannot produce a negative or
 * zero transfer.
 */
const MIN_NET_TRANSFER_CENTS = 1;

/**
 * Decide the Connect active-account fee deduction for ONE payout group.
 *
 * Pure and total — no I/O, no clock, no floating point. Every branch returns a
 * reason so the audit entry can say why nothing was taken, which is the case a
 * venue is most likely to ask about.
 */
export function computeConnectAccountFeeDeduction(
  rawInput: unknown,
): ConnectAccountFeeDeduction {
  const input = parseInput(connectAccountFeeDeductionInputSchema, rawInput);

  if (input.feeCents <= 0) {
    return { deductionCents: 0, reason: "no_fee_configured" };
  }

  // Defensive re-assertion of the caller's gate. The spec's guarantee — a
  // sub-minimum balance "does not pay out, and is therefore never charged the
  // $2" — must hold even if a future caller reorders the pipeline.
  if (input.groupTotalCents < input.payoutMinimumCents) {
    return { deductionCents: 0, reason: "below_payout_minimum" };
  }

  // The account was going to be active for ticketing anyway: zero marginal
  // cost, so memberships ride along free. This is the promise, stated first.
  if (input.hasTicketingRevenueInPayout) {
    return { deductionCents: 0, reason: "ticketing_revenue_in_payout" };
  }

  // Positive evidence required — see "fail safe" above.
  if (!input.hasMembershipRevenueInPayout) {
    return { deductionCents: 0, reason: "no_membership_revenue_in_payout" };
  }

  // At most one $2 per account per calendar month: Stripe only bills once.
  if (input.accountAlreadyActiveThisMonth) {
    return { deductionCents: 0, reason: "account_already_active_this_month" };
  }

  // Evaluated on what is actually left after higher-priority withholdings
  // (debt recovery). Debt is allowed to consume the whole payout; the $2
  // convenience recovery never is — if it doesn't fit the remainder, we
  // absorb it.
  if (
    input.groupTotalCents - input.priorWithholdingCents - input.feeCents <
    MIN_NET_TRANSFER_CENTS
  ) {
    return { deductionCents: 0, reason: "would_zero_transfer" };
  }

  return { deductionCents: input.feeCents, reason: "deducted" };
}

/**
 * Start of `at`'s calendar month in UTC — the window over which "has this
 * account already received a payout?" is asked.
 *
 * UTC rather than a venue-local zone on purpose: the question is about STRIPE's
 * billing month for the PLATFORM's account, not about any payee's local
 * calendar, and a single fixed zone keeps the boundary deterministic and
 * testable. Our boundary may sit a few hours off Stripe's, which can only ever
 * shift a deduction between two adjacent months — it can never produce two
 * deductions for one Stripe charge in steady state, because each month still
 * admits at most one.
 */
export function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
}

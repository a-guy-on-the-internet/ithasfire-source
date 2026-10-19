import { addBusinessDays } from "./business-days";

/**
 * The Stripe balance-availability floor for payout maturity.
 *
 * WHY THIS EXISTS: `settlements.run-batch` creates transfers WITHOUT
 * `source_transaction`, so every transfer draws on the platform's AVAILABLE
 * Stripe balance. For a US platform account a charge sits in `pending` for
 * 2 business days before it becomes available. Meanwhile `computePayoutDate`
 * can schedule a payout as soon as the day after the event: a Saturday-night
 * door sale on the `ASAP` schedule matures Sunday and is picked up by Monday's
 * batch — two days before that money can possibly be available, so the
 * transfer fails with `balance_insufficient`.
 *
 * The floor clamps credit maturity to "no earlier than the money can be
 * there". It is a MAX, not a blanket delay: an advance sale three weeks out is
 * already scheduled well past the floor and is untouched. Only late sales and
 * door sales move.
 *
 * `source_transaction` is deliberately NOT the fix — it pins one transfer to
 * one charge, which is incompatible with the ledger-authoritative design's
 * one-transfer-per-(payee, currency) aggregation.
 *
 * ACCEPTED CONSEQUENCE: because the floor is per-credit, one event's revenue
 * can now mature on two different days — a WEEK_OF_EVENT show whose advance
 * sales mature on the Sunday and whose door sales are floored to the Tuesday
 * pays out in two transfers. That is a deliberate trade of Sunday-consistency
 * for speed. Do NOT "fix" it by bucketing the floor up to
 * `getEffectiveSunday`; that would delay every floored credit to the next
 * Sunday for a cosmetic gain.
 *
 * See `business-days.ts` for the banking-holiday gap this does not cover.
 */

/**
 * Business days the platform balance needs before a settled charge can fund an
 * outbound transfer, measured from credit-mint time.
 *
 * Method-agnostic by design — see `computeAvailabilityFloor` for why there is
 * no ACH branch.
 */
export const SETTLEMENT_FLOOR_BUSINESS_DAYS = 2;

/**
 * The earliest instant a charge minted at `chargedAt` can safely fund a
 * transfer: midnight `America/Chicago` on the 2nd business day after the mint
 * day (weekend mints start counting the following Monday).
 *
 * NO PER-PAYMENT-METHOD BRANCH — deliberately. An earlier draft of this file
 * carried a 4-business-day ACH (`us_bank_account`) branch. It was wrong, and
 * anyone tempted to re-add it should read this first:
 *
 *   Stripe's ACH Direct Debit docs (https://docs.stripe.com/payments/ach-direct-debit)
 *   put standard settlement at "4 business days from PAYMENT CREATION", and
 *   describe ACH as a delayed-notification method that "can take up to 4
 *   business days to receive acknowledgement of success or failure".
 *
 * Both clocks start at payment creation and run concurrently. We mint credits
 * at `payment_intent.succeeded`, which for ACH IS that ~T+4 acknowledgement —
 * so by the time this function is called the settlement wait has already
 * elapsed. Adding another 4 business days on top double-counts the same
 * window and would delay every ACH payout by most of a week for nothing.
 *
 * A flat 2 is right for both:
 *   - CARD: `succeeded` is ~charge creation, and US card funds land 2 business
 *     days from creation. `now + 2` is exact.
 *   - ACH: `succeeded` sits at or near T+4, so `now + 2` is a small
 *     conservative cushion. It also degrades gracefully in the uncertain case:
 *     if Stripe ever acknowledges at T+2 while funds post at T+4, `now + 2`
 *     lands on T+4 anyway.
 *
 * Reading `Order.paymentMethodType` here would additionally have been unsound:
 * the field is written by the webhook, and both write sites sit behind gates
 * that the credit mint routinely beats (the card write runs AFTER
 * `finalizePaymentIntent`; the `payment_intent.processing` write is skipped
 * whenever the browser's `confirm-payment` call has already flipped the order
 * out of `PENDING`). A branch on it would have fired only when the webhook won
 * a race — intermittent and unreproducible. Removing the branch removes the
 * race.
 */
export function computeAvailabilityFloor(chargedAt: Date): Date {
  return addBusinessDays(chargedAt, SETTLEMENT_FLOOR_BUSINESS_DAYS);
}

/**
 * `max(scheduledPayoutDate, computeAvailabilityFloor(chargedAt))`.
 *
 * Returns `scheduledPayoutDate` unchanged whenever the schedule already lands
 * past the floor — the common case for advance sales.
 *
 * @param scheduledPayoutDate - The schedule's own maturity date
 *   (`computePayoutDate` for ticketing, `firstOfNextUtcMonth` for memberships).
 * @param chargedAt - When the money entered the platform balance. Credits are
 *   minted at payment finalization (the webhook or invoice event that reports
 *   the charge succeeded), so the caller's `clock.now()` is that instant. On an
 *   operator re-drive of `settlements.createFromOrder` "now" is later, which
 *   pushes the floor LATER — conservative, never early.
 */
export function applyAvailabilityFloor(
  scheduledPayoutDate: Date,
  chargedAt: Date,
): Date {
  // An Invalid Date compares false against everything, so an unguarded `>=`
  // would silently swallow it and hand back the floor — a plausible-looking
  // wrong maturity date instead of a loud failure. `addBusinessDays` already
  // throws on an invalid `chargedAt`; match that here.
  if (Number.isNaN(scheduledPayoutDate.getTime())) {
    throw new Error("applyAvailabilityFloor: scheduledPayoutDate is invalid");
  }
  const floor = computeAvailabilityFloor(chargedAt);
  return scheduledPayoutDate.getTime() >= floor.getTime()
    ? scheduledPayoutDate
    : floor;
}

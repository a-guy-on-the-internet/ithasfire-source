/**
 * `Membership.status` mirrors **Stripe's** subscription vocabulary verbatim, in
 * Stripe's own lower-snake casing — not ours.
 *
 * This is not an accident and it is not cosmetic. `startMembership` and
 * `cancelMembership` both persist `subscription.status` straight off the Stripe
 * object, and `startMembership`'s live-membership check compares against
 * `"active" | "trialing" | "past_due" | "unpaid"`. Writing an upper-cased
 * `"PAST_DUE"` from the webhook path would produce a row that no existing
 * comparison matches: the member would look lapsed to the benefits resolver and
 * simultaneously look absent to the double-submit guard, so a past-due member
 * could be billed a second subscription.
 *
 * Hence one named constant, so the value is stated once and the reason travels
 * with it. The spec's data-model sketch writes these upper-cased; the shipped
 * schema comment ("mirrors STRIPE's subscription status vocabulary") and the
 * shipped code do not. The code wins.
 */
export const MEMBERSHIP_STATUS_PAST_DUE = "past_due";

/**
 * The statuses under which a membership GRANTS BENEFITS at ticket checkout.
 *
 * This is deliberately narrower than `startMembership`'s LIVE_STATUSES
 * ("active" | "trialing" | "past_due" | "unpaid"), and the two must not be
 * conflated: LIVE answers "does this member already have this subscription?"
 * (a past-due member must not be double-billed a second subscription), while
 * THIS list answers "has this member paid for the current period?". A
 * `past_due` or `unpaid` member has a failing card and grants NOTHING —
 * otherwise a lapsed card keeps earning discounts indefinitely while Stripe
 * retries. `trialing` grants: Stripe treats a trial as an entitled period.
 * `canceled` / `incomplete` / `incomplete_expired` never grant.
 *
 * ONE definition, here, next to the status vocabulary note above — every
 * caller (checkout benefit resolution today, anything later) imports this
 * rather than re-listing strings.
 */
export const MEMBERSHIP_BENEFIT_GRANTING_STATUSES = [
  "active",
  "trialing",
] as const;

/**
 * The statuses under which a membership is LIVE — "this member already has
 * this subscription" / "this tier currently has subscribers". Deliberately
 * WIDER than the benefit-granting list above: a `past_due` or `unpaid` member
 * has a failing card and earns nothing, but their subscription still exists
 * and still bills, so it must count everywhere the question is "is there a
 * subscription on Stripe to protect or to fix": the double-subscribe guard
 * (`startMembership`), the address-change fan-out, the rate-change repointing
 * of `default_tax_rates` (`refreshTaxJurisdictions`), and an owner's live
 * member count. Miss a `past_due` row in any of those and it keeps billing the
 * wrong thing while looking, to a narrower list, like it does not exist.
 */
export const MEMBERSHIP_LIVE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
] as const;

/**
 * The statuses that mean THE CARD IS FAILING: the subscription still exists
 * and still bills, but the member is currently being denied everything they
 * signed up for.
 *
 * This is exactly `MEMBERSHIP_LIVE_STATUSES` minus
 * `MEMBERSHIP_BENEFIT_GRANTING_STATUSES` — "live but granting nothing" — and a
 * test pins that relationship so the three lists cannot drift apart silently.
 *
 * Written out rather than computed, deliberately. A derived list would absorb
 * any future addition to LIVE automatically, and the next status Stripe
 * invents (it has invented several) might be live-and-non-granting for a
 * reason that has nothing to do with a failing card — `paused` would be
 * reported to an operator as a payment failure, in copy that names a cause
 * that is not happening. The drift test forces a human to look instead.
 *
 * Consumed by `memberships.report-health`, whose entire reason for existing is
 * that nothing watched these two states.
 */
export const MEMBERSHIP_PAYMENT_FAILING_STATUSES = [
  "past_due",
  "unpaid",
] as const;

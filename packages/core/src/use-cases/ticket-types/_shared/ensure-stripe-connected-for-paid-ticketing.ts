import type { EventRecord } from "@th/ports/repos/events";
import type { GetPayeeBySubjectInput } from "@th/ports/repos/payees";
import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { isEverPaidTicketType } from "../../../lib/orders/door-pricing";

/**
 * Refuse a money-taking tier when the event's owner has NO Stripe Connect
 * payee.
 *
 * The sibling of `ensureFeePolicyResolvableForPaidTicketing`: same transition,
 * the other precondition a sale needs. Without a payee every checkout on the
 * tier fails with an error the ORGANIZER never sees (the BUYER does), so both
 * write paths refuse the configuration up front.
 *
 * SHARED because BOTH write paths can perform the free→paid flip and a gate on
 * only one of them is not a gate:
 *   - `upsertTicketType` — adds a NEW paid tier (also the path
 *     `applyTicketTypeTemplate` funnels through);
 *   - `updateTicketType` — edits an EXISTING free tier into a paid one.
 * It lived inline in `upsertTicketType` while it had one caller; it is here,
 * unchanged, so the two cannot drift.
 */

/**
 * A LINKED ACCOUNT, not capability. The gate's contract on purpose: a Payee
 * row gets its `stripeAccountId` the moment an organizer STARTS Connect
 * onboarding (`initiateOnboarding` → `payees.upsertForSubject`), long before
 * Stripe enables charges. Demanding
 * `status === "ACTIVE" && chargesEnabled && payoutsEnabled` here — the check
 * `publishEvent`'s `ensureStripeConnectedForPaidEvent` does — would block an
 * organizer from AUTHORING paid tiers for however many hours or days Stripe
 * spends verifying them, on an event they cannot publish yet anyway.
 *
 * The capability check therefore belongs to PUBLISH, which is the last gate
 * before an event is buyable and where refusing costs the organizer nothing
 * they can't immediately act on. This gate answers only "is there a Connect
 * account at all?".
 */
export async function ensureStripeConnectedForPaidTicketing(
  tx: TxRepos,
  event: EventRecord,
): Promise<void> {
  const subject = derivePayeeSubject(event);
  if (!subject) {
    throw fail("PAID_TICKETING_REQUIRES_STRIPE");
  }

  const found = await tx.payees.getBySubject(subject);
  if (!found) {
    throw fail("PAID_TICKETING_REQUIRES_STRIPE");
  }
  // A Payee row alone no longer means onboarding started: PLACEHOLDER payees
  // (no Connect account, payouts disabled) are created by a door cash sale
  // (R6, spec 2026-10-07), event splits, resale seller splits and booking
  // lines. `initiateOnboarding` always links `stripeAccountId` when it
  // creates or claims the row, so THAT is "a Connect account exists" — and
  // still nothing about capability (see above).
  const payee = await tx.payees.getById(found.id);
  if (!payee?.stripeAccountId) {
    throw fail("PAID_TICKETING_REQUIRES_STRIPE");
  }
}

/**
 * Does this tier need a connected Stripe account?
 *
 * Deliberately NARROWER than {@link ticketTypeNeedsFeePolicy}: a pure
 * pay-what-you-want tier with NO minimum has never required a connected account
 * here, and widening that historical rule is a separate decision, not this
 * module's to make. That is why `pricingMode` is NOT forwarded to
 * `isEverPaidTicketType` (which treats ADJUSTABLE as paid) and why the
 * ADJUSTABLE arm below tests the MINIMUM instead.
 *
 * The ADJUSTABLE clearing mirrors what both write paths persist for such a
 * tier (no list price, no schedule — the buyer names the amount), so a raw stored row and a freshly-normalized one get the same
 * answer.
 */
export function ticketTypeRequiresStripe(ticketType: {
  priceCents: number;
  scheduledPriceCents?: number | null;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
  minimumCents?: number | null;
}): boolean {
  const isAdjustable = ticketType.pricingMode === "ADJUSTABLE";

  if (isAdjustable) {
    return (ticketType.minimumCents ?? 0) > 0;
  }

  return isEverPaidTicketType({
    priceCents: ticketType.priceCents,
    scheduledPriceCents: ticketType.scheduledPriceCents,
    // `pricingMode` withheld deliberately — see the doc comment.
  });
}

export function derivePayeeSubject(
  event: EventRecord,
): GetPayeeBySubjectInput | null {
  if (event.orgId) {
    return {
      type: "ORGANIZATION",
      id: event.orgId,
    } satisfies GetPayeeBySubjectInput;
  }
  if (event.humanId) {
    return {
      type: "HUMAN",
      id: event.humanId,
    } satisfies GetPayeeBySubjectInput;
  }
  return null;
}

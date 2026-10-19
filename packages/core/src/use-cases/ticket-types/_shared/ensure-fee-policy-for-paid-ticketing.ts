import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { isEverPaidTicketType } from "../../../lib/orders/door-pricing";
import { resolveScopedFeePolicy } from "../../../lib/payments/resolve-scoped-fee-policy";

/**
 * Refuse a money-taking tier when NO fee policy resolves at EVENT, ORG or
 * GLOBAL scope.
 *
 * Which policy resolves no longer matters beyond its existence: a policy's
 * `feeMode` is never read for pricing (SALE_FEE_MODE,
 * docs/decisions/absorb-removed.md), so the legacy-ABSORB refusal this gate
 * used to carry is gone.
 *
 * WHY THIS GATE EXISTS. `publishEvent` no longer requires a fee policy for a
 * FREE event (the platform's first-ever publish died on that gate, and the fee
 * policy is PLATFORM configuration the organizer cannot create). A free event
 * therefore reaches PUBLISHED with nothing pinned onto its payout terms.
 * Turning any of its tiers into a money-taking one afterwards is a free→paid
 * flip, and without this gate the failure surfaces at the BUYER's checkout
 * (`loadPayoutTermsContext` → AGREEMENT_MISSING_FEE_POLICY) rather than at the
 * organizer's edit.
 *
 * It is the sibling of `ensureStripeConnectedForPaidTicketing`, gating the same
 * transition on the other precondition a sale needs.
 *
 * SHARED because BOTH write paths can perform the flip and a gate on only one
 * of them is not a gate:
 *   - `upsertTicketType` — adds a NEW paid tier to the event;
 *   - `updateTicketType` — edits an EXISTING free tier into a paid one.
 *
 * Deliberately NOT restricted to PUBLISHED events. On a DRAFT it simply moves
 * the same refusal earlier than publish, with copy that names the real cause.
 */

export type FeePolicyTicketingGateDeps = {
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
  /** Tag for the scope walk's diagnostics, e.g. `"upsertTicketType"`. */
  source: string;
};

/**
 * Does this tier take money in ANY of the ways the platform supports?
 *
 * Wraps {@link isEverPaidTicketType} and ADDS the ADJUSTABLE arm explicitly.
 *
 * This is deliberately WIDER than `upsertTicketType`'s `requiresStripe`, which
 * excludes a pure pay-what-you-want tier with no minimum for historical
 * reasons (that narrower rule predates this work and widening it is a separate
 * decision). For the FEE POLICY the answer is unambiguous: a pay-what-you-can
 * tier charges buyers, so it needs a fee policy, and `publishEvent`'s
 * `isEverPaidTicketType` already treats ADJUSTABLE as paid. Matching publish is
 * the point — a tier the ticket editor accepts must not be one publish then
 * rejects.
 */
export function ticketTypeNeedsFeePolicy(ticketType: {
  priceCents: number;
  scheduledPriceCents?: number | null;
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
}): boolean {
  return isEverPaidTicketType(ticketType);
}

export async function ensureFeePolicyResolvableForPaidTicketing(
  tx: TxRepos,
  event: EventRecord,
  now: Date,
  deps: FeePolicyTicketingGateDeps,
): Promise<void> {
  const feePolicy = await resolveScopedFeePolicy(
    tx,
    { eventId: event.id, orgId: event.orgId },
    now,
    deps,
  );

  if (!feePolicy) {
    throw fail("PAID_TICKETING_REQUIRES_FEE_POLICY");
  }
}

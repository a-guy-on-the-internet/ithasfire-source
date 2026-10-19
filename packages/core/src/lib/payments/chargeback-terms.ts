import type { TxRepos } from "@th/ports/repos";
import type {
  EventTicketTypeSummary,
  EventRecord,
} from "@th/ports/repos/events";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import { isEverPaidTicketType } from "../orders/door-pricing";

// ── Where the gate lives ─────────────────────────────────────────────────────
//
// Ithas Fire is the merchant of record (Stripe Connect separate charges and
// transfers). These terms create a repayment + payout-setoff obligation, so
// acceptance belongs at PAYOUT SETUP — the moment the organizer configures
// how money reaches them — not at event publish.
//
//   • STRICT, current-version gate → `initiateOnboarding` (stripe-connect).
//     `requireCurrentChargebackTermsForRiskOwner` runs before any Stripe
//     account or account-link is created. An owner who has never accepted,
//     or accepted an older version, must re-accept before touching Connect.
//
//   • VERSION-AGNOSTIC backstops → `publishEvent` and `createCheckout`.
//     `requireAnyChargebackTermsFor*` only asks "did this owner ever accept?".
//     An organizer is bound by whichever version they accepted, so a copy
//     edit that bumps `CURRENT_CHARGEBACK_TERMS_VERSION` must NOT hard-fail
//     checkout for every already-published paid event — that is a
//     self-inflicted sales outage that buys nothing legally. The backstops
//     exist to catch owners who somehow reached a paid flow with no
//     acceptance at all (legacy rows, seed data, a future bypass), not to
//     enforce recency. Recency is re-enforced the next time the owner
//     initiates Connect onboarding.
//
// Bumping the version therefore has exactly one runtime effect: owners hit
// the strict gate the next time they (re-)enter Stripe Connect onboarding.
// A fully onboarded owner never re-enters it, so a SUBSTANTIVE terms change
// that must re-bind existing owners needs a separate mechanism (a
// re-acceptance sweep, or a strict gate re-enabled at publish) — bumping the
// constant alone will not do it.
//
// The 2026-09-03 revision is a CORRECTION of copy that overstated what the
// platform takes; it does NOT re-bind owners who are already onboarded, and
// nothing in this repo sweeps them. If re-binding them ever matters, that
// needs a deliberate re-acceptance sweep — the bump alone reaches only
// owners who re-enter Connect onboarding.

// ⚠️ NOT LAWYER-REVIEWED. This text describes Ithas Fire's intended payout
// and dispute behavior in plain language. A payments/fintech attorney must
// redline this before it carries weight in a real dispute. Tracked items
// that need legal input before launch:
//   • Link / reference syntax for Terms of Service + Stripe Connected
//     Account Agreement (currently bare prose; renderer doesn't parse
//     markdown so links can't be clickable until we extend the data model).
//   • Governing law / venue placeholders in the main ToS, which these terms
//     inherit wholesale (¶10).
//   • Enforceability of the anti-circumvention paragraph (¶9) against, say,
//     a sole trader who opens a second personal account — under §17(b) of
//     the Stripe Connected Account Agreement and applicable
//     consumer-protection law.
//   • Whether the buyer-facing ToS needs a matching disclosure that the
//     evidence we submit to the card network (¶2) includes the buyer's
//     name, email, IP address and billing address.
//   • Whether an admin who joins an organization AFTER acceptance is bound
//     without personally accepting.
//   • Definition of "risk owner" — the operational concept behind the
//     payout-setoff scope (this copy no longer names it, but the gate and
//     the ledger still key on it) may be overbroad or underbroad depending
//     on jurisdiction.

export const CURRENT_CHARGEBACK_TERMS_VERSION = "2026-09-03";

export const CURRENT_CHARGEBACK_TERMS_TEXT = [
  "These terms supplement the Ithas Fire Terms of Service and your Stripe Connected Account Agreement. They cover how disputes and payouts work for the paid events and memberships you sell through Ithas Fire, and you accept them when you set up payouts.",
  "Ithas Fire is the merchant of record for these sales. When a buyer disputes a charge with their card issuer, the card network takes the money back from Ithas Fire, and we respond to the dispute on your behalf using records of the order and the event — the buyer's checkout details, your refund policy as it was shown at checkout, and any door scans.",
  "While a dispute is open we hold the disputed amount out of your payable balance, up to what you were credited for that order. The rest of your balance pays out as normal.",
  "If the dispute is lost, that amount is deducted from your upcoming payouts. We never take back more than you were paid for the order, and if the order was already refunded we take nothing further. For ticket sales, the card network's dispute fee is ours and is not passed on to you; for membership subscriptions, the fee is deducted along with the disputed amount.",
  "If the dispute is won, the hold is released, and anything already deducted for it is credited back to you.",
  "If what you owe is more than your pending payouts, the balance carries forward and is recovered from later payouts until it clears. Ithas Fire recovers dispute balances from your payouts and does not debit your bank account. A refund works differently: it reverses the transfer we already sent you, and if your Stripe balance does not cover it, your Stripe agreement governs what happens next.",
  "Membership revenue carries a temporary reserve while you are new to memberships: 10% of each membership payout for your first 90 days, 5% from 90 to 180 days, and nothing after that. If you have been selling tickets with us for at least 90 days before you turn memberships on, you start at 5%. This is deferred payout, not a fee — it is released to you with a later payout, and your payout notification names it. A lost membership chargeback restarts the clock for 180 days. Ticket revenue carries no reserve.",
  "We may hold or suspend payouts while dispute activity, refund exposure, or a compliance review needs manual attention. We email the contact address on your account when a dispute opens, when funds are held, and when it closes. If you believe a hold or suspension is wrong, reply to that email or write to support@ithasfire.com and we will review it.",
  "You agree not to use a new organization, a new account, or an affiliated entity to avoid a balance you owe Ithas Fire. We reserve the right to apply an outstanding balance to other accounts you own or control.",
  "All other terms — governing law, dispute resolution, account termination, and what happens to an outstanding balance when an account closes — are as set out in the Ithas Fire Terms of Service.",
].join("\n\n");

export type ChargebackTermsSnapshot = {
  version: string;
  text: string;
};

export type ChargebackTermsRiskOwner =
  | { type: "ORGANIZATION"; id: string }
  | { type: "HUMAN"; id: string };

export function getCurrentChargebackTermsSnapshot(): ChargebackTermsSnapshot {
  return {
    version: CURRENT_CHARGEBACK_TERMS_VERSION,
    text: CURRENT_CHARGEBACK_TERMS_TEXT,
  };
}

/**
 * Does this event ever take money, and therefore need chargeback terms?
 *
 * Delegates to `isEverPaidTicketType` (FR-004) rather than testing
 * `priceCents > 0` directly. This is a WILL-IT-EVER predicate, not a
 * what-does-it-cost-now read, so it must NOT be time-resolved: a tier that is
 * $0 today and $20 after a scheduled flip needs chargeback terms accepted
 * BEFORE the flip, not at the moment money starts moving. Same reasoning as the
 * matching gate in `listEventTicketTypes` and `publishEvent`.
 */
export function hasPaidTicketTypes(
  ticketTypes: readonly EventTicketTypeSummary[],
): boolean {
  return ticketTypes.some(isEverPaidTicketType);
}

export function deriveChargebackTermsRiskOwner(
  event: Pick<EventRecord, "orgId" | "humanId">,
): ChargebackTermsRiskOwner | null {
  if (event.orgId) {
    return { type: "ORGANIZATION", id: event.orgId };
  }

  if (event.humanId) {
    return { type: "HUMAN", id: event.humanId };
  }

  return null;
}

type ChargebackTermsGateInput = {
  repos: Pick<TxRepos, "organizations" | "humans">;
  owner: ChargebackTermsRiskOwner | null;
};

type ChargebackTermsPaidEventGateInput = {
  repos: Pick<TxRepos, "organizations" | "humans">;
  event: Pick<EventRecord, "orgId" | "humanId">;
  ticketTypes: readonly EventTicketTypeSummary[];
  /**
   * The event sells a seat at a paid override price through a tier that is
   * itself free (publish learns it from the seats; `ticketTypes` cannot say
   * it). Counts as paid.
   */
  paidSeatOverrides?: boolean;
};

type OrganizationChargebackTermsFields = Pick<
  OrganizationRecord,
  | "chargebackTermsVersion"
  | "chargebackTermsAcceptedAt"
  | "chargebackTermsAcceptedByHumanId"
>;

type HumanChargebackTermsFields = Pick<
  HumanRecord,
  "chargebackTermsVersion" | "chargebackTermsAcceptedAt"
>;

type ChargebackTermsPredicates = {
  organization: (organization: OrganizationChargebackTermsFields) => boolean;
  human: (human: HumanChargebackTermsFields) => boolean;
};

/**
 * STRICT gate (Stripe Connect onboarding): the owner must hold an acceptance
 * of the CURRENT version. See the placement notes at the top of this file.
 */
export async function requireCurrentChargebackTermsForRiskOwner(
  input: ChargebackTermsGateInput,
): Promise<void> {
  await requireChargebackTermsForRiskOwner(input, {
    organization: organizationHasCurrentChargebackTerms,
    human: humanHasCurrentChargebackTerms,
  });
}

/**
 * VERSION-AGNOSTIC backstop (publish + checkout): ANY prior acceptance
 * satisfies it, regardless of version. Preserves the `hasPaidTicketTypes`
 * WILL-IT-EVER short-circuit — free events never need the terms.
 */
export async function requireAnyChargebackTermsForPaidEvent(
  input: ChargebackTermsPaidEventGateInput,
): Promise<void> {
  if (!hasPaidTicketTypes(input.ticketTypes) && !input.paidSeatOverrides) {
    return;
  }

  await requireAnyChargebackTermsForRiskOwner({
    repos: input.repos,
    owner: deriveChargebackTermsRiskOwner(input.event),
  });
}

/**
 * VERSION-AGNOSTIC backstop (publish + checkout): ANY prior acceptance
 * satisfies it, regardless of version. Same error shape as the strict gate
 * so transports and clients need no new mapping.
 */
export async function requireAnyChargebackTermsForRiskOwner(
  input: ChargebackTermsGateInput,
): Promise<void> {
  await requireChargebackTermsForRiskOwner(input, {
    organization: organizationHasAnyChargebackTerms,
    human: humanHasAnyChargebackTerms,
  });
}

async function requireChargebackTermsForRiskOwner(
  input: ChargebackTermsGateInput,
  predicates: ChargebackTermsPredicates,
): Promise<void> {
  const { owner, repos } = input;
  if (!owner) {
    throwChargebackTermsRequired(null);
  }

  if (owner.type === "ORGANIZATION") {
    const organization = await repos.organizations.getById(owner.id);
    if (!organization || !predicates.organization(organization)) {
      throwChargebackTermsRequired(owner);
    }
    return;
  }

  const human = await repos.humans.getById(owner.id);
  if (!human || !predicates.human(human)) {
    throwChargebackTermsRequired(owner);
  }
}

/**
 * An org's acceptance counts only while its accepter is on record: the
 * accepter FK is `onDelete: SetNull`, so a deleted accepter's account voids it
 * for every gate. Exported so `getOrg` describes the record the way the gates
 * judge it.
 */
export function organizationHasAnyChargebackTerms(
  organization: OrganizationChargebackTermsFields,
): boolean {
  return (
    organization.chargebackTermsAcceptedAt instanceof Date &&
    Boolean(organization.chargebackTermsAcceptedByHumanId)
  );
}

function organizationHasCurrentChargebackTerms(
  organization: OrganizationChargebackTermsFields,
): boolean {
  return (
    organization.chargebackTermsVersion === CURRENT_CHARGEBACK_TERMS_VERSION &&
    organizationHasAnyChargebackTerms(organization)
  );
}

function humanHasAnyChargebackTerms(human: HumanChargebackTermsFields): boolean {
  return human.chargebackTermsAcceptedAt instanceof Date;
}

function humanHasCurrentChargebackTerms(
  human: HumanChargebackTermsFields,
): boolean {
  return (
    human.chargebackTermsVersion === CURRENT_CHARGEBACK_TERMS_VERSION &&
    humanHasAnyChargebackTerms(human)
  );
}

function throwChargebackTermsRequired(
  owner: ChargebackTermsRiskOwner | null,
): never {
  // `meta` is the only channel `toTrpcError` forwards to the client
  // (`data.meta` via the router errorFormatter); the top-level copies stay
  // for in-process callers and existing test pins.
  throw {
    code: "chargeback_terms_required",
    message: "chargeback_terms_required",
    requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
    owner,
    meta: { owner, requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION },
  } as const;
}

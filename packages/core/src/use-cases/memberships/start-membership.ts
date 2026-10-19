import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";

import { parseInput } from "../../lib/io";
import { ensureJurisdictionDefaultTaxRateIds } from "./ensure-jurisdiction-tax-rate";
import { MEMBERSHIP_LIVE_STATUSES } from "./membership-status";
import { membershipOutputSchema } from "./schemas";
import { resolveMemberTaxJurisdiction } from "./resolve-member-tax-jurisdiction";

/**
 * Subscribe a member to a tier.
 *
 * Order of operations matters and is not arbitrary:
 *
 *  1. Tax is resolved BEFORE anything is created in Stripe. Resolution fails
 *     closed, so an unpriceable address must abort the signup before it can
 *     leave a Customer or Subscription behind that we would then have to
 *     reconcile.
 *  2. The Customer is platform-owned, so a member supporting three owners
 *     enters their card once.
 *  3. The subscription is a PLATFORM charge — no `transfer_data.destination`,
 *     no `application_fee_percent`. The owner is paid through the
 *     Orders/Settlement pipeline (`recordMembershipInvoicePaid` →
 *     `runPayoutBatch`), which is what preserves payout timing control and the
 *     dispute-hold machinery; a destination charge would move the money at
 *     charge time AND the settlement would pay it again. The connected-account
 *     readiness check below is therefore a GATE only: a payee with no payable
 *     account must be refused before we bill anyone, but the account id is
 *     never handed to billing.
 */

export const startMembershipInputSchema = z
  .object({
    tierId: z.string().uuid(),
    memberHumanId: z.string().uuid(),
    /** Destination-sourced tax needs the MEMBER's address, not the owner's. */
    billingCountryCode: z.string().trim().length(2),
    billingPostalCode: z.string().trim().min(1).max(16),
    memberEmail: z.string().email().nullable().optional(),
    memberName: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export type StartMembershipInput = z.infer<typeof startMembershipInputSchema>;

/**
 * The membership row plus the browser's payment hand-off.
 *
 * `paymentIntentClientSecret` is the first invoice's PaymentIntent client
 * secret: the subscription is created `default_incomplete` (the member has no
 * card on file yet), so the row lands with Stripe's `incomplete` status and
 * the browser confirms this secret with Stripe Elements. Webhooks
 * (`customer.subscription.updated` → syncMembershipFromStripe,
 * `invoice.payment_succeeded` → recordMembershipInvoicePaid) then flip the row
 * active and mint the Order. Null when there is nothing to confirm: the
 * double-submit early-return on an already-live membership, or a first
 * invoice that needs no payment (100% discount / trial).
 *
 * The secret is a bearer credential for completing this payment — return it
 * to the member who started the flow and NEVER log it.
 */
export const startMembershipOutputSchema = membershipOutputSchema.extend({
  paymentIntentClientSecret: z.string().nullable(),
});

export type StartMembershipOutput = z.infer<typeof startMembershipOutputSchema>;

export type StartMembershipDeps = {
  repos: Repos;
  membershipBilling: MembershipBillingPort;
  taxRateLookup: TaxRateLookupPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/** Stripe statuses that mean "this member already has this membership". */
const LIVE_STATUSES: ReadonlySet<string> = new Set(MEMBERSHIP_LIVE_STATUSES);

export async function startMembership(
  deps: StartMembershipDeps,
  rawInput: unknown,
): Promise<MembershipRecord & { paymentIntentClientSecret: string | null }> {
  const input = parseInput(startMembershipInputSchema, rawInput);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");
  if (tier.status !== "ACTIVE" || !tier.stripePriceId) {
    throw fail("MEMBERSHIP_TIER_NOT_ACTIVE", { meta: { tierId: tier.id } });
  }

  const standing = await deps.repos.membershipStandings.findForOwner({
    ownerOrgId: tier.ownerOrgId,
    ownerHumanId: tier.ownerHumanId,
  });
  if (standing?.suspended) {
    throw fail("MEMBERSHIPS_SUSPENDED", { meta: { tierId: tier.id } });
  }

  // Returning early on a LIVE membership makes a double-submit harmless. A
  // lapsed row is deliberately NOT an early return — the unique index means a
  // returning member resumes that same row with a new subscription.
  const existing = await deps.repos.memberships.findForMemberAndTier({
    tierId: input.tierId,
    memberHumanId: input.memberHumanId,
  });
  if (existing && LIVE_STATUSES.has(existing.status)) {
    // Nothing to pay: the live subscription already has a card on file.
    return { ...existing, paymentIntentClientSecret: null };
  }

  // Gate only (see header note 3): refuse before billing when the owner has no
  // payable account. The account id itself is NOT passed to billing — payout
  // happens via the settlement pipeline, not on the subscription.
  await ensureOwnerHasPayableAccount(deps.repos, tier);

  // Tax first, and it throws rather than degrading — see
  // resolveMemberTaxJurisdiction. Doing this before any Stripe write is what
  // keeps a refused signup from stranding half-built billing objects.
  const { jurisdiction } = await resolveMemberTaxJurisdiction(
    {
      repos: deps.repos,
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      countryCode: input.billingCountryCode,
      postalCode: input.billingPostalCode,
    },
  );

  // Minted lazily rather than by the refresh job — that keeps the job from
  // holding a two-phase commit open across our DB and Stripe's API. Shared
  // with the billing-address-change path (`updateMemberBillingAddress`).
  const defaultTaxRateIds = await ensureJurisdictionDefaultTaxRateIds(
    { repos: deps.repos, membershipBilling: deps.membershipBilling },
    jurisdiction,
  );

  const { customerId } = await deps.membershipBilling.ensureCustomer({
    humanId: input.memberHumanId,
    email: input.memberEmail ?? null,
    name: input.memberName ?? null,
    idempotencyKey: `membership-customer:${input.memberHumanId}`,
  });

  const subscription = await deps.membershipBilling.createSubscription({
    customerId,
    priceId: tier.stripePriceId,
    defaultTaxRateIds,
    metadata: {
      tierId: tier.id,
      memberHumanId: input.memberHumanId,
      ...(tier.ownerOrgId ? { ownerOrgId: tier.ownerOrgId } : {}),
      ...(tier.ownerHumanId ? { ownerHumanId: tier.ownerHumanId } : {}),
    },
    // `v2`: versioned because the request SHAPE changed (default_incomplete +
    // payment_settings + expand). Stripe replays an idempotency key only for
    // byte-identical params and 409s otherwise, so an unversioned key would
    // lock out for 24h any member whose create was attempted under the old
    // shape — observed live when the pre-fix "customer has no attached payment
    // source" failure poisoned the key for the post-fix retry. Bump the
    // version whenever the params to `createSubscription` change again.
    idempotencyKey: `membership-subscription:v2:${tier.id}:${input.memberHumanId}`,
  });

  const persisted = existing
    ? // RESUME, not sync: the fresh subscription minted above is a NEW Stripe
      // object, so the row must be re-pointed at it wholesale —
      // `updateFromStripe` (deliberately) cannot carry the subscription /
      // customer / tax linkage, and leaving the old `stripeSubscriptionId` in
      // place would make every `invoice.payment_succeeded` for the new
      // subscription miss the row (DLQ forever: member billed, owner unpaid).
      await deps.repos.memberships.resumeFromStripe({
        id: existing.id,
        stripeSubscriptionId: subscription.subscriptionId,
        stripeCustomerId: customerId,
        status: subscription.status,
        taxJurisdictionId: jurisdiction.id,
        billingPostalCode: input.billingPostalCode,
        billingCountryCode: input.billingCountryCode,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: null,
      })
    : await deps.repos.memberships.create({
        tierId: tier.id,
        memberHumanId: input.memberHumanId,
        stripeSubscriptionId: subscription.subscriptionId,
        stripeCustomerId: customerId,
        status: subscription.status,
        taxJurisdictionId: jurisdiction.id,
        billingPostalCode: input.billingPostalCode,
        billingCountryCode: input.billingCountryCode,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      });

  // The client secret is deliberately NOT logged — it is a bearer credential
  // for completing the payment. Log only whether one exists.
  deps.logger?.info("membership.started", {
    membershipId: persisted.id,
    tierId: tier.id,
    stripeSubscriptionId: subscription.subscriptionId,
    taxJurisdictionId: jurisdiction.id,
    status: persisted.status,
    requiresPaymentConfirmation: subscription.paymentIntentClientSecret != null,
  });

  return {
    ...persisted,
    // `?? null`: defensive against a MembershipBillingPort implementation
    // predating the field; the wire contract is `string | null`, never
    // undefined.
    paymentIntentClientSecret: subscription.paymentIntentClientSecret ?? null,
  };
}

/**
 * Readiness GATE, not routing. The subscription itself never references the
 * connected account (the settlement pipeline pays the owner), but signing a
 * member up to fund an owner who cannot be paid would strand their money in
 * pending settlements — so an owner without a charges-enabled account is
 * refused before anything is billed.
 */
async function ensureOwnerHasPayableAccount(
  repos: Repos,
  tier: { ownerOrgId: string | null; ownerHumanId: string | null },
): Promise<void> {
  const subject = tier.ownerOrgId
    ? ({ type: "ORGANIZATION", id: tier.ownerOrgId } as const)
    : ({ type: "HUMAN", id: tier.ownerHumanId! } as const);

  const ref = await repos.payees.getBySubject(subject);
  const payee = ref ? await repos.payees.getById(ref.id) : null;

  // Without a charges-enabled connected account there is nowhere for the money
  // to land. Refusing here beats collecting from a member and discovering at
  // settlement that the owner cannot be paid.
  if (!payee?.stripeAccountId || !payee.chargesEnabled) {
    throw fail("PAYEE_NOT_READY", {
      meta: {
        ownerOrgId: tier.ownerOrgId,
        ownerHumanId: tier.ownerHumanId,
      },
    });
  }
}

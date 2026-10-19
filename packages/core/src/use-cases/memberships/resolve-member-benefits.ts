import type { TxRepos } from "@th/ports/repos";
import type { MembershipDiscountKind } from "@th/ports/repos/membership-tiers";

import { MEMBERSHIP_BENEFIT_GRANTING_STATUSES } from "./membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// resolveMemberBenefits — the SECOND eligibility source feeding the ONE
// discount pipeline.
//
// Called during ticket checkout (inside the checkout transaction) to answer:
// "which benefits do this buyer's memberships entitle them to, for THIS
// event?" The resulting GRANTS are handed to `evaluatePromoApplications` as
// `memberGrants`, where they join the exact same eligibility, clamp, stacking
// and ledger (PromoHold / PromoRedemption) machinery as typed codes. There is
// no second discount implementation and no second ledger.
//
// A grant carries its own discount terms. It is NOT a promo reference: a
// benefit has no code (so nothing to leak), no campaign window (so nothing
// can expire out from under the tier) and no status of its own — its validity
// window IS the membership.
//
// Division of responsibility — deliberate, do not duplicate either side:
//
//   THIS resolver decides ENTITLEMENT:
//     * membership status — only MEMBERSHIP_BENEFIT_GRANTING_STATUSES grant;
//       a canceled / past_due / unpaid membership grants NOTHING.
//     * benefit narrowing — a benefit's optional categoryId / placeId must
//       match the event's.
//     * OWNER SCOPE — derived from the tier's owner and attached to the grant.
//
//   `evaluatePromoApplications` decides APPLICABILITY:
//     * scope matching against THIS event, via the same `computeEligibleAmount`
//       that gates typed codes — including the mandatory `event.orgId != null`
//       guard on human-owned scope (orgId takes precedence as the payee, so an
//       org-owned event that also carries a humanId must never match a human's
//       entitlement).
//     * stacking, clamping, and the one-benefit-per-order rule.
//
// THE CROSS-TENANT GUARD is that derived `ownerScope`, and it is structural
// rather than a check: a grant can only ever be scoped to the tier's own
// owner, so a benefit discounting a DIFFERENT payee's revenue is not something
// the model can express. That replaces two hand-written defences the promo
// design needed (an attach-time `ensurePromoScopeOwnedByOwner` call and a
// GLOBAL-scope filter here) — a GLOBAL grant is now unrepresentable.
//
// Failure posture: this resolver does NOT swallow repo errors. It runs inside
// the checkout transaction, where a thrown repo error aborts (and safely
// rolls back) the whole checkout — degrading to "member silently pays full
// price" would be an overcharge masked as success.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveMemberBenefitsRepos = Pick<
  TxRepos,
  "memberships" | "membershipTiers"
>;

export type ResolveMemberBenefitsInput = {
  /** The buyer. Callers with an anonymous buyer skip resolution entirely. */
  memberHumanId: string;
  /** The event being checked out — only the fields entitlement needs. */
  event: {
    id: string;
    orgId: string | null;
    humanId: string | null;
    categoryId?: string | null;
    placeId?: string | null;
  };
  now: Date;
};

/**
 * Whose revenue a benefit may discount, derived from the tier's owner.
 *
 * `HUMAN` carries the same payee-precedence rule as `PromoScope.HUMAN`: it
 * matches only events with `orgId == null`, because an org-owned event pays
 * the org even when a human is also attached.
 */
export type MemberBenefitOwnerScope =
  | { kind: "ORG"; orgId: string }
  | { kind: "HUMAN"; humanId: string };

/** One entitled benefit, attributed to the membership + tier that granted it. */
export type MemberBenefitGrant = {
  benefitId: string;
  tierId: string;
  tierName: string;
  membershipId: string;
  discountKind: MembershipDiscountKind;
  discountValue: number;
  maxDiscountCents: number | null;
  /** Owner override for the checkout line label; null = generated. */
  label: string | null;
  ownerScope: MemberBenefitOwnerScope;
};

export async function resolveMemberBenefits(
  repos: ResolveMemberBenefitsRepos,
  input: ResolveMemberBenefitsInput,
): Promise<MemberBenefitGrant[]> {
  const memberships = await repos.memberships.listForMember({
    memberHumanId: input.memberHumanId,
    statuses: [...MEMBERSHIP_BENEFIT_GRANTING_STATUSES],
  });
  if (memberships.length === 0) {
    return [];
  }

  // Deterministic order regardless of adapter/DB row order: oldest membership
  // first, so downstream admission (one benefit per order, ties broken by
  // arrival) does not flap between checkouts.
  const sortedMemberships = [...memberships].sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1),
  );

  const membershipByTierId = new Map<string, (typeof memberships)[number]>();
  for (const membership of sortedMemberships) {
    if (!membershipByTierId.has(membership.tierId)) {
      membershipByTierId.set(membership.tierId, membership);
    }
  }

  const tierIds = Array.from(membershipByTierId.keys());
  const [tiers, benefits] = await Promise.all([
    repos.membershipTiers.listByIds(tierIds),
    repos.membershipTiers.listBenefitsForTiers(tierIds),
  ]);
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));

  // Benefit-level narrowing: categoryId / placeId, when set, must match the
  // event. An event with a null category/place never matches a narrowed
  // benefit — narrowing means "only there", not "anywhere unclassified".
  const applicableBenefits = benefits.filter(
    (benefit) =>
      (benefit.categoryId == null ||
        benefit.categoryId === (input.event.categoryId ?? null)) &&
      (benefit.placeId == null ||
        benefit.placeId === (input.event.placeId ?? null)),
  );
  if (applicableBenefits.length === 0) {
    return [];
  }

  const grants: MemberBenefitGrant[] = [];
  for (const benefit of applicableBenefits) {
    const membership = membershipByTierId.get(benefit.tierId);
    const tier = tierById.get(benefit.tierId);
    if (!membership || !tier) {
      continue;
    }
    const ownerScope = deriveOwnerScope(tier);
    if (!ownerScope) {
      // A tier with neither owner id is unattributable (core enforces the XOR
      // on write). Granting it would mean a discount against nobody's revenue.
      continue;
    }
    grants.push({
      benefitId: benefit.id,
      tierId: benefit.tierId,
      tierName: tier.name,
      membershipId: membership.id,
      discountKind: benefit.discountKind,
      discountValue: benefit.discountValue,
      maxDiscountCents: benefit.maxDiscountCents,
      label: benefit.label,
      ownerScope,
    });
  }

  return grants;
}

function deriveOwnerScope(tier: {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
}): MemberBenefitOwnerScope | null {
  // Org wins when both are somehow set — the same payee precedence settlement
  // uses, so an entitlement can never resolve against a payee that would not
  // have been paid.
  if (tier.ownerOrgId) {
    return { kind: "ORG", orgId: tier.ownerOrgId };
  }
  if (tier.ownerHumanId) {
    return { kind: "HUMAN", humanId: tier.ownerHumanId };
  }
  return null;
}

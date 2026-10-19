import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { Repos } from "@th/ports/repos";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import { buildStatementDescriptor } from "./statement-descriptor";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Publish a tier: mint its Stripe Product and Price, then mark it ACTIVE.
 *
 * This is where Stripe objects are created, not at draft time — Prices are
 * immutable, so minting one per edit of an unfinished draft would leave
 * unusable orphans behind forever.
 *
 * Idempotent by construction. Both Stripe calls are keyed on the tier id, and
 * a tier that already carries its ids short-circuits, so a retried publish
 * (double-click, webhook replay, job retry) cannot mint a second Price and
 * quietly start billing new members a different amount from existing ones.
 */

export const publishMembershipTierInputSchema = z
  .object({ actorHumanId: z.string().uuid(), tierId: z.string().uuid() })
  .strict();

export type PublishMembershipTierInput = z.infer<
  typeof publishMembershipTierInputSchema
>;

export type PublishMembershipTierDeps = {
  repos: Repos;
  membershipBilling: MembershipBillingPort;
  logger?: LoggerPort;
};

export async function publishMembershipTier(
  deps: PublishMembershipTierDeps,
  rawInput: unknown,
): Promise<MembershipTierRecord> {
  const input = parseInput(publishMembershipTierInputSchema, rawInput);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");
  if (tier.status === "ARCHIVED") throw fail("MEMBERSHIP_TIER_ARCHIVED");

  // Publishing mints the Stripe Price and opens the tier for billing — a
  // finance action on the tier's owner.
  await requireTierOwnerAccess({
    repos: deps.repos,
    tier,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  const standing = await deps.repos.membershipStandings.findForOwner({
    ownerOrgId: tier.ownerOrgId,
    ownerHumanId: tier.ownerHumanId,
  });
  if (standing?.suspended) {
    throw fail("MEMBERSHIPS_SUSPENDED", { meta: { tierId: tier.id } });
  }

  // The statement descriptor is the OWNER's name — what the member's card
  // statement shows on every charge. An unrecognised descriptor is how
  // "is this fraud?" chargebacks start, which is why this is dispute-prevention
  // item 1 in the spec, not cosmetics. The tier name never fits in 22 chars
  // and lives in the receipt email instead.
  const statementDescriptor = buildStatementDescriptor(
    await resolveOwnerDisplayName(deps.repos, tier),
  );

  // Already published: no second Price is ever minted, but `ensureProduct`
  // still runs — Products are mutable, and the adapter HEALS a descriptor
  // that is missing (products minted before descriptors existed, e.g. the dev
  // "Sustaining Member") or stale (owner renamed). Republishing is therefore
  // the repair path for old products.
  if (tier.stripeProductId && tier.stripePriceId) {
    const { productId } = await deps.membershipBilling.ensureProduct({
      tierId: tier.id,
      name: tier.name,
      description: tier.description,
      statementDescriptor,
      idempotencyKey: `membership-tier-product:${tier.id}`,
    });
    if (productId !== tier.stripeProductId) {
      // The tierId-metadata search resolved a DIFFERENT product than the tier
      // references — someone deleted or re-tagged the product in the
      // Dashboard. Do not silently re-point money objects from a publish
      // retry; surface it for a human instead.
      deps.logger?.error("membership.tier.product_mismatch", {
        tierId: tier.id,
        stripeProductId: tier.stripeProductId,
        resolvedProductId: productId,
      });
    }
    return tier.status === "ACTIVE"
      ? tier
      : deps.repos.membershipTiers.update({ id: tier.id, status: "ACTIVE" });
  }

  const { productId } = await deps.membershipBilling.ensureProduct({
    tierId: tier.id,
    name: tier.name,
    description: tier.description,
    statementDescriptor,
    idempotencyKey: `membership-tier-product:${tier.id}`,
  });

  const { priceId } = await deps.membershipBilling.createPrice({
    productId,
    unitAmountCents: tier.priceCents,
    currency: tier.currency,
    interval: tier.interval === "YEAR" ? "year" : "month",
    // Keyed on the tier AND its amount: a genuine archive-and-replace price
    // change must be able to mint a NEW Price, while a retry of this exact
    // publish must not.
    idempotencyKey: `membership-tier-price:${tier.id}:${tier.priceCents}`,
  });

  const withIds = await deps.repos.membershipTiers.attachStripeIds({
    id: tier.id,
    stripeProductId: productId,
    stripePriceId: priceId,
  });

  deps.logger?.info("membership.tier.published", {
    tierId: tier.id,
    stripeProductId: productId,
    stripePriceId: priceId,
  });

  return withIds.status === "ACTIVE"
    ? withIds
    : deps.repos.membershipTiers.update({ id: tier.id, status: "ACTIVE" });
}

/**
 * The OWNER's display name — org name or human name — which is what the
 * member's card statement must show. `null` (owner row missing, or a human
 * who never set a name) falls through to `buildStatementDescriptor`'s
 * "MEMBERSHIP" fallback rather than blocking the publish: a missing display
 * name is not a reason a venue cannot sell memberships.
 */
async function resolveOwnerDisplayName(
  repos: Repos,
  tier: { ownerOrgId: string | null; ownerHumanId: string | null },
): Promise<string | null> {
  if (tier.ownerOrgId) {
    const [org] = await repos.organizations.getByIds([tier.ownerOrgId]);
    return org?.name ?? null;
  }
  if (tier.ownerHumanId) {
    const [human] = await repos.humans.getByIds([tier.ownerHumanId]);
    return human?.name ?? null;
  }
  return null;
}

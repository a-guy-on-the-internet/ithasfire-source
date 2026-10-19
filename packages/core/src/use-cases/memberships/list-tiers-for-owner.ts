import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_ANY_ROLE } from "../../lib/rbac";
import {
  MEMBERSHIP_BENEFIT_GRANTING_STATUSES,
} from "./membership-status";
import {
  membershipTierBenefitOutputSchema,
  membershipTierOutputSchema,
} from "./schemas";

/**
 * Admin view of an owner's tiers: every status, PROMO benefits, and member
 * counts. Read access mirrors listPromos (any org role); mutations stay
 * finance-gated.
 *
 * Two counts per tier because they answer different questions:
 *   - `memberCount` — members currently paying (benefit-granting statuses),
 *     the number an owner reads as "how many members do I have".
 *   - `priceLocked` — whether ANY membership row has ever existed (or a
 *     Stripe Price has been minted), i.e. whether `priceCents` is frozen and
 *     a price change means archive-and-replace. Surfaced here so the UI can
 *     disable the price field instead of letting the user discover the lock
 *     on submit.
 */

export const listTiersForOwnerInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
  })
  .strict();

export type ListTiersForOwnerInput = z.infer<typeof listTiersForOwnerInputSchema>;

const adminTierSchema = membershipTierOutputSchema.extend({
  benefits: z.array(membershipTierBenefitOutputSchema),
  /** Members currently entitled (active / trialing). */
  memberCount: z.number().int().min(0),
  /** True once priceCents can no longer be edited (archive-and-replace). */
  priceLocked: z.boolean(),
});

export const listTiersForOwnerOutputSchema = z.object({
  items: z.array(adminTierSchema),
});

export type ListTiersForOwnerOutput = z.infer<
  typeof listTiersForOwnerOutputSchema
>;

export type ListTiersForOwnerDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listTiersForOwner(
  deps: ListTiersForOwnerDeps,
  rawInput: unknown,
): Promise<ListTiersForOwnerOutput> {
  const input = parseInput(listTiersForOwnerInputSchema, rawInput);

  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ANY_ROLE,
  });

  const tiers = await deps.repos.membershipTiers.listForOwner({
    ownerOrgId: input.ownerType === "ORGANIZATION" ? input.ownerId : null,
    ownerHumanId: input.ownerType === "HUMAN" ? input.ownerId : null,
  });
  if (tiers.length === 0) {
    return { items: [] };
  }

  const tierIds = tiers.map((tier) => tier.id);
  const [benefits, liveCounts, everCounts] = await Promise.all([
    deps.repos.membershipTiers.listBenefitsForTiers(tierIds),
    deps.repos.memberships.countByTier({
      tierIds,
      statuses: [...MEMBERSHIP_BENEFIT_GRANTING_STATUSES],
    }),
    deps.repos.memberships.countByTier({ tierIds }),
  ]);

  const liveByTier = new Map(liveCounts.map((row) => [row.tierId, row.count]));
  const everByTier = new Map(everCounts.map((row) => [row.tierId, row.count]));
  const benefitsByTier = new Map<string, typeof benefits>();
  for (const benefit of benefits) {
    const bucket = benefitsByTier.get(benefit.tierId);
    if (bucket) bucket.push(benefit);
    else benefitsByTier.set(benefit.tierId, [benefit]);
  }

  return listTiersForOwnerOutputSchema.parse({
    items: tiers.map((tier) => ({
      ...tier,
      benefits: benefitsByTier.get(tier.id) ?? [],
      memberCount: liveByTier.get(tier.id) ?? 0,
      priceLocked:
        (everByTier.get(tier.id) ?? 0) > 0 || tier.stripePriceId != null,
    })),
  });
}

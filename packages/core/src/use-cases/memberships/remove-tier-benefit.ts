import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Detach a benefit from a tier. Members lose the entitlement at their next
 * checkout — grants are resolved live, never cached on the member.
 *
 * The row is RETIRED, not deleted (`archivedAt`), which is invisible from
 * here: a retired benefit is excluded from every read, so this use case's
 * behaviour is byte-identical to the hard delete it replaced. What changes is
 * downstream — the PromoRedemption rows the benefit produced keep their
 * foreign key instead of being cascade-erased, because those rows are the
 * platform's record of granted margin. Deleting a benefit used to wipe that
 * history from the owner's order detail AND from platform staff views, from
 * an ordinary product action carrying no destructive-action warning.
 *
 * The benefit must belong to the ADDRESSED tier: a benefitId from some other
 * tier answers MEMBERSHIP_BENEFIT_NOT_FOUND, indistinguishable from a
 * nonexistent id, so the error can't be used to probe other owners' benefit
 * rows.
 */

export const removeTierBenefitInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    tierId: z.string().uuid(),
    benefitId: z.string().uuid(),
  })
  .strict();

export type RemoveTierBenefitInput = z.infer<typeof removeTierBenefitInputSchema>;

export const removeTierBenefitOutputSchema = z
  .object({ benefitId: z.string().uuid(), removed: z.literal(true) })
  .strict();

export type RemoveTierBenefitOutput = z.infer<
  typeof removeTierBenefitOutputSchema
>;

export type RemoveTierBenefitDeps = {
  repos: Repos;
  /** Stamps `archivedAt`. Injected so the retirement instant is reproducible. */
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function removeTierBenefit(
  deps: RemoveTierBenefitDeps,
  rawInput: unknown,
): Promise<RemoveTierBenefitOutput> {
  const input = parseInput(removeTierBenefitInputSchema, rawInput);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");

  await requireTierOwnerAccess({
    repos: deps.repos,
    tier,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  const benefit = await deps.repos.membershipTiers.findBenefitById(
    input.benefitId,
  );
  if (!benefit || benefit.tierId !== tier.id) {
    throw fail("MEMBERSHIP_BENEFIT_NOT_FOUND");
  }

  await deps.repos.membershipTiers.deleteBenefit({
    id: benefit.id,
    archivedAt: deps.clock.now(),
  });

  await deps.repos.audit.log({
    entity: "membership_tier",
    entityId: tier.id,
    action: "membership_tier.benefit_removed",
    data: {
      actorHumanId: input.actorHumanId,
      benefitId: benefit.id,
      discountKind: benefit.discountKind,
      discountValue: benefit.discountValue,
      maxDiscountCents: benefit.maxDiscountCents,
    },
  });

  deps.logger?.info("membership.tier.benefit_removed", {
    tierId: tier.id,
    benefitId: benefit.id,
  });

  return { benefitId: benefit.id, removed: true };
}

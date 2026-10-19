import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import { assertBenefitTerms } from "./attach-tier-benefit";
import {
  benefitTermsSchema,
  membershipTierBenefitOutputSchema,
  type MembershipTierBenefitOutput,
} from "./schemas";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Edit a benefit's terms in place.
 *
 * Nothing here is locked by subscriber count — that is the whole point of the
 * entity. A benefit is an ongoing entitlement resolved live at each checkout,
 * so changing its terms changes what members get from their NEXT order and
 * touches no past one (the applied discount is recorded on the order and in
 * the ledger). There is no Stripe object behind it and no immutability to
 * respect, unlike `priceCents`.
 *
 * Ownership is the tier's, same as attach; the benefit must belong to the
 * ADDRESSED tier so a benefitId from another tier answers
 * MEMBERSHIP_BENEFIT_NOT_FOUND rather than becoming a probe.
 */

export const updateTierBenefitInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    tierId: z.string().uuid(),
    benefitId: z.string().uuid(),
  })
  .merge(benefitTermsSchema)
  .strict();

export type UpdateTierBenefitInput = z.infer<typeof updateTierBenefitInputSchema>;

export const updateTierBenefitOutputSchema = membershipTierBenefitOutputSchema;
export type UpdateTierBenefitOutput = MembershipTierBenefitOutput;

export type UpdateTierBenefitDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function updateTierBenefit(
  deps: UpdateTierBenefitDeps,
  rawInput: unknown,
): Promise<UpdateTierBenefitOutput> {
  const input = parseInput(updateTierBenefitInputSchema, rawInput);
  assertBenefitTerms(input);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");
  if (tier.status === "ARCHIVED") throw fail("MEMBERSHIP_TIER_ARCHIVED");

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

  const updated = await deps.repos.membershipTiers.updateBenefit({
    id: benefit.id,
    discountKind: input.discountKind,
    discountValue: input.discountValue,
    maxDiscountCents: input.maxDiscountCents ?? null,
    categoryId: input.categoryId ?? null,
    placeId: input.placeId ?? null,
    label: input.label ?? null,
  });

  await deps.repos.audit.log({
    entity: "membership_tier",
    entityId: tier.id,
    action: "membership_tier.benefit_updated",
    data: {
      actorHumanId: input.actorHumanId,
      benefitId: benefit.id,
      from: {
        discountKind: benefit.discountKind,
        discountValue: benefit.discountValue,
        maxDiscountCents: benefit.maxDiscountCents,
        categoryId: benefit.categoryId,
        placeId: benefit.placeId,
        label: benefit.label,
      },
      to: {
        discountKind: updated.discountKind,
        discountValue: updated.discountValue,
        maxDiscountCents: updated.maxDiscountCents,
        categoryId: updated.categoryId,
        placeId: updated.placeId,
        label: updated.label,
      },
    },
  });

  deps.logger?.info("membership.tier.benefit_updated", {
    tierId: tier.id,
    benefitId: benefit.id,
  });

  return updateTierBenefitOutputSchema.parse(updated);
}

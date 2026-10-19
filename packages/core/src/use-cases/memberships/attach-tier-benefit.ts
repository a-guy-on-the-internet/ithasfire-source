import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import {
  benefitTermsSchema,
  membershipTierBenefitOutputSchema,
  type MembershipTierBenefitOutput,
} from "./schemas";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Attach a DISCOUNT benefit to a tier.
 *
 * The terms live on the benefit — there is no promo to point at, so there is
 * also no promo-ownership guard here any more. That check has not been
 * relaxed, it has been made STRUCTURAL: `resolveMemberBenefits` derives each
 * grant's `ownerScope` from the tier's own owner, and checkout's one scope
 * gate (`computeEligibleAmount`) matches that scope against the event's payee
 * — org → `event.orgId`, human → `event.orgId == null && event.humanId`. A
 * benefit that discounts a DIFFERENT owner's revenue is therefore not
 * something the model can express, where before it was something two separate
 * hand-written filters had to keep refusing.
 *
 * `categoryId` / `placeId` narrow WHERE the benefit applies ("free entry to
 * open mics", "only at our room"). They are opaque narrowing keys — an event
 * matches only on exact equality at resolve time — so a bogus id yields a
 * benefit that never fires, never one that leaks.
 *
 * Idempotent-ish: re-attaching identical terms with identical narrowing AND an
 * identical label returns the existing benefit row instead of stacking a
 * duplicate. Label is part of that identity deliberately — otherwise adding a
 * labelled copy of an existing benefit would silently return the unlabelled
 * one and drop what the owner typed.
 */

export const attachTierBenefitInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    tierId: z.string().uuid(),
  })
  .merge(benefitTermsSchema)
  .strict();

export type AttachTierBenefitInput = z.infer<typeof attachTierBenefitInputSchema>;

export const attachTierBenefitOutputSchema = membershipTierBenefitOutputSchema;
export type AttachTierBenefitOutput = MembershipTierBenefitOutput;

export type AttachTierBenefitDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function attachTierBenefit(
  deps: AttachTierBenefitDeps,
  rawInput: unknown,
): Promise<AttachTierBenefitOutput> {
  const input = parseInput(attachTierBenefitInputSchema, rawInput);
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

  const categoryId = input.categoryId ?? null;
  const placeId = input.placeId ?? null;
  const maxDiscountCents = input.maxDiscountCents ?? null;
  const label = input.label ?? null;

  const existing = await deps.repos.membershipTiers.listBenefitsForTiers([
    tier.id,
  ]);
  const duplicate = existing.find(
    (benefit) =>
      benefit.discountKind === input.discountKind &&
      benefit.discountValue === input.discountValue &&
      benefit.maxDiscountCents === maxDiscountCents &&
      benefit.categoryId === categoryId &&
      benefit.placeId === placeId &&
      // Label is part of the identity here. Without it, adding "$5 off"
      // labelled "Locals discount" to a tier that already has an unlabelled
      // "$5 off" would return the old row, toast success, and silently drop
      // what the owner typed.
      benefit.label === label,
  );
  if (duplicate) {
    return attachTierBenefitOutputSchema.parse(duplicate);
  }

  const created = await deps.repos.membershipTiers.createBenefit({
    tierId: tier.id,
    discountKind: input.discountKind,
    discountValue: input.discountValue,
    maxDiscountCents,
    categoryId,
    placeId,
    label,
  });

  await deps.repos.audit.log({
    entity: "membership_tier",
    entityId: tier.id,
    action: "membership_tier.benefit_attached",
    data: {
      actorHumanId: input.actorHumanId,
      benefitId: created.id,
      discountKind: input.discountKind,
      discountValue: input.discountValue,
      maxDiscountCents,
      categoryId,
      placeId,
      label,
    },
  });

  deps.logger?.info("membership.tier.benefit_attached", {
    tierId: tier.id,
    benefitId: created.id,
  });

  return attachTierBenefitOutputSchema.parse(created);
}

/**
 * Term rules Zod cannot express on its own, in ONE place so attach and update
 * cannot drift: PERCENT is 1–100, AMOUNT is at least a cent, and a clamp that
 * can never bind on an AMOUNT benefit is a mistake worth naming rather than
 * silently ignoring.
 */
export function assertBenefitTerms(terms: {
  discountKind: "AMOUNT" | "PERCENT";
  discountValue: number;
  maxDiscountCents?: number | null;
}): void {
  if (terms.discountKind === "PERCENT") {
    if (terms.discountValue < 1 || terms.discountValue > 100) {
      throw fail("MEMBERSHIP_BENEFIT_INVALID_TERMS", {
        meta: {
          reason: "percent_out_of_range",
          discountValue: terms.discountValue,
        },
      });
    }
    return;
  }

  if (terms.discountValue < 1) {
    throw fail("MEMBERSHIP_BENEFIT_INVALID_TERMS", {
      meta: { reason: "amount_below_one_cent", discountValue: terms.discountValue },
    });
  }
  if (
    terms.maxDiscountCents != null &&
    terms.maxDiscountCents < terms.discountValue
  ) {
    throw fail("MEMBERSHIP_BENEFIT_INVALID_TERMS", {
      meta: {
        reason: "max_below_amount",
        discountValue: terms.discountValue,
        maxDiscountCents: terms.maxDiscountCents,
      },
    });
  }
}

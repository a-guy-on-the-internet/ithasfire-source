import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import {
  membershipTierOutputSchema,
  type MembershipTierOutput,
} from "./schemas";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Edit a membership tier.
 *
 * `name` / `description` / `sortOrder` are freely editable at any status
 * except ARCHIVED (an archived tier is a tombstone — replace it instead).
 *
 * `priceCents` is editable ONLY while the tier is an unpublished DRAFT that
 * has never had a subscriber. Two reasons, either sufficient alone:
 *   1. Spec rule: once a tier has EVER had a subscriber (any Membership row,
 *      any status), the price is frozen — archive-and-replace is the path.
 *   2. Stripe rule: publish mints an immutable Price. Editing `priceCents`
 *      after that would desync the row from the minted Price (publish
 *      short-circuits when stripePriceId is set, so a new Price would never
 *      be minted) and new members would silently be billed the OLD amount.
 *
 * `benefitsDescription` is the form's delivery statement: the owner's own claim about
 * what members get, freely editable at any time. It describes an entitlement
 * that is resolved live at each checkout, so there is nothing to migrate when
 * it changes.
 */

export const updateMembershipTierInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    tierId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    benefitsDescription: plainTextMultilineOptional(500).nullable().optional(),
    priceCents: z.number().int().positive().max(100_000_00).optional(),
    sortOrder: z.number().int().min(0).max(9_999).optional(),
  })
  .strict();

export type UpdateMembershipTierInput = z.infer<
  typeof updateMembershipTierInputSchema
>;

export const updateMembershipTierOutputSchema = membershipTierOutputSchema;
export type UpdateMembershipTierOutput = MembershipTierOutput;

export type UpdateMembershipTierDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function updateMembershipTier(
  deps: UpdateMembershipTierDeps,
  rawInput: unknown,
): Promise<UpdateMembershipTierOutput> {
  const input = parseInput(updateMembershipTierInputSchema, rawInput);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");
  if (tier.status === "ARCHIVED") throw fail("MEMBERSHIP_TIER_ARCHIVED");

  await requireTierOwnerAccess({
    repos: deps.repos,
    tier,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  const wantsPriceChange =
    input.priceCents !== undefined && input.priceCents !== tier.priceCents;
  if (wantsPriceChange) {
    // "Ever had a subscriber" — any row, any status. A canceled member who
    // resubscribes resumes their old row at the price they signed up under.
    const everSubscribed =
      (await deps.repos.membershipTiers.countSubscribers(tier.id)) > 0;
    if (everSubscribed || tier.stripePriceId) {
      throw fail("MEMBERSHIP_TIER_PRICE_LOCKED", {
        meta: {
          tierId: tier.id,
          reason: everSubscribed ? "has_subscribers" : "price_minted",
          resolution:
            "Archive this tier and create a replacement at the new price. " +
            "Existing members keep billing at the price they agreed to.",
        },
      });
    }
  }

  const updated = await deps.repos.membershipTiers.update({
    id: tier.id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.benefitsDescription === undefined
      ? {}
      : { benefitsDescription: input.benefitsDescription }),
    ...(wantsPriceChange ? { priceCents: input.priceCents } : {}),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  });

  await deps.repos.audit.log({
    entity: "membership_tier",
    entityId: tier.id,
    action: "membership_tier.updated",
    data: {
      actorHumanId: input.actorHumanId,
      changed: {
        ...(input.name === undefined ? {} : { name: true }),
        ...(input.description === undefined ? {} : { description: true }),
        ...(input.benefitsDescription === undefined
          ? {}
          : { benefitsDescription: true }),
        ...(wantsPriceChange
          ? { priceCents: { from: tier.priceCents, to: input.priceCents } }
          : {}),
        ...(input.sortOrder === undefined ? {} : { sortOrder: true }),
      },
    },
  });

  deps.logger?.info("membership.tier.updated", { tierId: tier.id });

  return updateMembershipTierOutputSchema.parse(updated);
}

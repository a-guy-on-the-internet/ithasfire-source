import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import {
  membershipTierOutputSchema,
  type MembershipTierOutput,
} from "./schemas";
import { requireTierOwnerAccess } from "./tier-access";

/**
 * Archive a tier: new signups stop, existing subscriptions keep billing.
 *
 * Deliberately does NOT touch Stripe. Archiving is "close the door", not
 * "cancel everyone" — existing members agreed to a recurring charge and keep
 * it until THEY cancel. `startMembership` refuses any non-ACTIVE tier
 * (MEMBERSHIP_TIER_NOT_ACTIVE), which is the whole enforcement: no signup
 * path exists that does not go through it.
 *
 * Idempotent: archiving an archived tier returns it unchanged.
 */

export const archiveMembershipTierInputSchema = z
  .object({ actorHumanId: z.string().uuid(), tierId: z.string().uuid() })
  .strict();

export type ArchiveMembershipTierInput = z.infer<
  typeof archiveMembershipTierInputSchema
>;

export const archiveMembershipTierOutputSchema = membershipTierOutputSchema;
export type ArchiveMembershipTierOutput = MembershipTierOutput;

export type ArchiveMembershipTierDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function archiveMembershipTier(
  deps: ArchiveMembershipTierDeps,
  rawInput: unknown,
): Promise<ArchiveMembershipTierOutput> {
  const input = parseInput(archiveMembershipTierInputSchema, rawInput);

  const tier = await deps.repos.membershipTiers.findById(input.tierId);
  if (!tier) throw fail("MEMBERSHIP_TIER_NOT_FOUND");

  await requireTierOwnerAccess({
    repos: deps.repos,
    tier,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  if (tier.status === "ARCHIVED") {
    return archiveMembershipTierOutputSchema.parse(tier);
  }

  const archived = await deps.repos.membershipTiers.update({
    id: tier.id,
    status: "ARCHIVED",
  });

  await deps.repos.audit.log({
    entity: "membership_tier",
    entityId: tier.id,
    action: "membership_tier.archived",
    data: { actorHumanId: input.actorHumanId, previousStatus: tier.status },
  });

  deps.logger?.info("membership.tier.archived", { tierId: tier.id });

  return archiveMembershipTierOutputSchema.parse(archived);
}

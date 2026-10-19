import type { OrgRole } from "@th/ports/repos/authz";
import type { Repos } from "@th/ports/repos";

import {
  requireOwnerAccess,
  type OwnerAccessResult,
} from "../../lib/rbac";

/**
 * The (ownerType, ownerId) pair for a tier's owner. Exactly one of
 * ownerOrgId / ownerHumanId is set (enforced at create), so the derivation is
 * total — the non-null assertion is backed by that invariant.
 */
export function tierOwner(tier: {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
}): { ownerType: "HUMAN" | "ORGANIZATION"; ownerId: string } {
  return tier.ownerOrgId
    ? { ownerType: "ORGANIZATION", ownerId: tier.ownerOrgId }
    : { ownerType: "HUMAN", ownerId: tier.ownerHumanId! };
}

/**
 * Authorize an actor against a tier's owner: the human themselves for
 * human-owned tiers, or one of `roles` for org-owned tiers. Mirrors the promos
 * use cases' `requireOwnerAccess` idiom — authz lives in core, never in the
 * transport.
 */
export async function requireTierOwnerAccess(input: {
  repos: Repos;
  tier: { ownerOrgId: string | null; ownerHumanId: string | null };
  actorHumanId: string;
  roles: readonly OrgRole[];
}): Promise<OwnerAccessResult> {
  const { ownerType, ownerId } = tierOwner(input.tier);
  return requireOwnerAccess({
    repos: input.repos,
    ownerType,
    ownerId,
    actorHumanId: input.actorHumanId,
    roles: input.roles,
  });
}

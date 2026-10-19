import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { requireOrgMembership, ORG_EDIT_ROLES } from "../../../lib/rbac";

/**
 * Resolve + authorize the "memberships" embed subject.
 *
 * `subjectId` names the membership-tier OWNER — an Organization id or a Human
 * id (the same owner model as `MembershipTier`). Resolution is org-first, then
 * human: ids are UUIDs minted by different tables, so exactly one lookup can
 * succeed. Mirrors the existing per-type gates:
 *
 * - Organization owner → `requireOrgMembership` with ORG_EDIT_ROLES (same as
 *   the "organization" subject).
 * - Human owner → the actor may only manage their OWN subject (same
 *   no-delegation rule as `requireHumanSubjectAccess` for the "human"
 *   subject).
 * - Neither exists → `OWNER_NOT_FOUND` (the entity-pages vocabulary for the
 *   same HUMAN/ORGANIZATION owner model).
 *
 * Deliberately NOT gated on the owner having ACTIVE tiers or a non-suspended
 * standing: owners may register their website's domain before publishing a
 * tier (same early-setup rationale as the place subject), and the widget READ
 * path (`getMembershipWidget` → `listPublicTiers`) already serves an empty
 * list for suspended owners.
 *
 * @returns the resolved owner, so read paths can reuse the lookups.
 */
export async function requireMembershipsSubjectAccess(
  repos: Pick<Repos, "organizations" | "humans" | "authz">,
  subjectId: string,
  actorHumanId: string,
): Promise<
  | { kind: "organization"; id: string; name: string }
  | { kind: "human"; id: string; name: string | null }
> {
  const org = await repos.organizations.getById(subjectId);
  if (org) {
    await requireOrgMembership({
      repos,
      orgId: org.id,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return { kind: "organization", id: org.id, name: org.name };
  }

  const human = await repos.humans.getById(subjectId);
  if (!human) {
    throw fail("OWNER_NOT_FOUND");
  }
  if (human.id !== actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "human" } });
  }
  return { kind: "human", id: human.id, name: human.name ?? null };
}

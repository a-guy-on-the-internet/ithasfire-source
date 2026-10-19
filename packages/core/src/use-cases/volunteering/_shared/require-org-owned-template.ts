import { fail } from "@th/errors";

import type { OrgMembershipLookup } from "../../../lib/rbac";

/**
 * The tenancy gate for MUTATING a volunteer role template (FR-007).
 *
 * `VolunteerRoleTemplate` holds two kinds of row since the 2026-07-27
 * role-packs work:
 *
 *   - ORG rows      — `orgId` set, `isPlatform` false.
 *   - PLATFORM rows — `orgId` NULL, `isPlatform` true. Staff-curated
 *                     catalogue content shared by every org on the platform.
 *
 * Every mutating use case reaches its template by bare id and then derives
 * authz FROM THE ROW (`requireOrgMembership({ orgId: template.orgId })`).
 * On a platform row that question has no answer — so an organizer editing
 * or archiving one would silently rewrite the catalogue for every other org.
 * This helper runs BEFORE any membership check and refuses the row outright.
 *
 * It also narrows `orgId` from `string | null` to `string` by control flow,
 * so callers feed a real org id into `requireOrgMembership` with no
 * non-null assertion, no `?? ""`, and no cast.
 *
 * The failure is the SAME `TEMPLATE_NOT_FOUND` used for a template that
 * doesn't exist or belongs to another org: an organizer probing ids learns
 * nothing about what is on the other side.
 */
export function requireOrgOwnedTemplate<
  T extends { orgId: string | null; isPlatform: boolean },
>(template: T | null | undefined): { template: T; orgId: string } {
  const owned = tryOrgOwnedTemplate(template);
  if (!owned) {
    throw fail("TEMPLATE_NOT_FOUND");
  }
  return owned;
}

/**
 * The same gate, for the callers that answer with `null` instead of
 * throwing (a read returning "not found" rather than a typed error).
 *
 * This is the single implementation of "is this row org-owned, and by
 * whom" — `requireOrgOwnedTemplate` is a thin throw wrapper over it. Kept
 * that way deliberately: a hand-rolled
 * `!t || t.isPlatform || t.orgId === null` at a read site would not inherit
 * a future tightening of this rule, and the read sites are exactly the ones
 * least likely to be revisited when it changes.
 */
export function tryOrgOwnedTemplate<
  T extends { orgId: string | null; isPlatform: boolean },
>(template: T | null | undefined): { template: T; orgId: string } | null {
  // Platform rows are checked on the flag ALONE (not "orgId is null"), so a
  // mis-shaped row — flag set but with an orgId — still fails closed.
  if (!template || template.isPlatform) {
    return null;
  }
  const { orgId } = template;
  if (orgId === null) {
    // An org row with no org: unowned, therefore unreachable by anyone.
    return null;
  }
  return { template, orgId };
}

/**
 * "Is this actor even in the template's org?"
 *
 * Answering with INSUFFICIENT_ROLE tells a probing organizer that a template
 * with that id EXISTS and belongs to someone else. Non-membership therefore
 * answers TEMPLATE_NOT_FOUND — indistinguishable from a bad id — while a
 * genuine member holding the wrong role still gets the actionable
 * INSUFFICIENT_ROLE from the caller's normal `requireOrgMembership`.
 *
 * Costs one extra indexed membership read inside the caller's transaction;
 * the alternative (re-implementing the role check here) would fork the
 * canonical authz helper, which is worse.
 */
export async function requireTemplateOrgMembership(input: {
  repos: OrgMembershipLookup;
  orgId: string;
  actorHumanId: string;
}): Promise<void> {
  const membership = await input.repos.authz.getOrgMembership({
    orgId: input.orgId,
    humanId: input.actorHumanId,
  });
  if (!membership) {
    throw fail("TEMPLATE_NOT_FOUND");
  }
}

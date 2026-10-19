import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { organizationHasAnyChargebackTerms } from "../../lib/payments/chargeback-terms";
import { ORG_ANY_ROLE, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getOrgInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
  })
  .strict();

export const getOrgOutputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    defaultLocale: z.string().nullable(),
    contactEmail: z.string().nullable(),
    physicalAddress: z.string().nullable(),
    /**
     * Organizer chargeback-terms acceptance. PRESENT (nullable) only when the
     * actor holds one of `ORG_FINANCE_ROLES` — payout setup is a finance
     * concern and acceptance state is not for every member. ABSENT for other
     * roles, so a client can tell "not allowed to see" from "not accepted"
     * (`null`). Feeds the payments page's terms gate and the event builder's
     * readiness rail.
     *
     * Reported the way the server's gates judge it: an acceptance whose
     * accepter is gone (`chargebackTermsAcceptedByHumanId` nulled when that
     * account is deleted) counts for nothing at publish or onboarding, so it
     * reads as never accepted (both `null`) rather than as done.
     */
    chargebackTermsVersion: z.string().nullable().optional(),
    chargebackTermsAcceptedAt: z.date().nullable().optional(),
  })
  .strict();

export type GetOrgInput = z.infer<typeof getOrgInputSchema>;
export type GetOrgOutput = z.infer<typeof getOrgOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetOrgDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/** Any org member can read the org profile. */
const REQUIRED_ACTOR_ROLES = ORG_ANY_ROLE;

export async function getOrg(
  deps: GetOrgDeps,
  rawInput: unknown,
): Promise<GetOrgOutput> {
  const input = parseInput(getOrgInputSchema, rawInput);

  await deps.authz.requireOrgRole({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    requiredRoles: [...REQUIRED_ACTOR_ROLES],
  });

  const org = await deps.repos.organizations.getById(input.orgId);
  if (!org) {
    throw fail("ORG_NOT_FOUND");
  }

  // `requireOrgRole` above already proved membership; this second read only
  // decides whether the finance-only fields ride along. Never a throw.
  const membership = await deps.repos.authz.getOrgMembership({
    orgId: input.orgId,
    humanId: input.actorHumanId,
  });
  const canSeeChargebackTerms =
    membership !== null && ORG_FINANCE_ROLES.includes(membership.role);
  const acceptanceCounts = organizationHasAnyChargebackTerms(org);

  return getOrgOutputSchema.parse({
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    defaultLocale: org.defaultLocale ?? null,
    contactEmail: org.contactEmail ?? null,
    physicalAddress: org.physicalAddress ?? null,
    ...(canSeeChargebackTerms
      ? {
          chargebackTermsVersion: acceptanceCounts
            ? (org.chargebackTermsVersion ?? null)
            : null,
          chargebackTermsAcceptedAt: acceptanceCounts
            ? (org.chargebackTermsAcceptedAt ?? null)
            : null,
        }
      : {}),
  });
}

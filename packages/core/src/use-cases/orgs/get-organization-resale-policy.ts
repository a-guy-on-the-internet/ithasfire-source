import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { RESALE_CLAIM_WINDOW_DAYS } from "../../lib/resale-claim-window";
import { fail } from "@th/errors";

const PLATFORM_DEFAULT_PAYOUT_RELEASE_DAYS = 7;

export const getOrganizationResalePolicyInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
  })
  .strict();

export const getOrganizationResalePolicyOutputSchema = z
  .object({
    orgId: z.string().uuid(),
    payoutTermsId: z.string().uuid().nullable(),
    payoutReleaseDays: z.number().int(),
    /** True when no org-level policy is configured; values fall back to platform defaults. */
    isPlatformDefault: z.boolean(),
  })
  .strict();

export type GetOrganizationResalePolicyInput = z.infer<
  typeof getOrganizationResalePolicyInputSchema
>;
export type GetOrganizationResalePolicyOutput = z.infer<
  typeof getOrganizationResalePolicyOutputSchema
>;

export type GetOrganizationResalePolicyDeps = {
  repos: Pick<Repos, "organizations" | "payoutTerms" | "authz">;
  logger?: LoggerPort;
  /**
   * The dangling-template fallback is a deliberate swallow (the settings
   * page still renders), so it reaches Sentry through this. Guarded: a
   * throwing reporter changes nothing.
   */
  reportError?: ReporterPort | null;
};

/**
 * Reads the org's RESALE policy template. Returns platform defaults when
 * the org hasn't configured one yet so the settings UI can render a
 * "currently using platform default" sidebar without a separate flag.
 */
export async function getOrganizationResalePolicy(
  deps: GetOrganizationResalePolicyDeps,
  rawInput: unknown,
): Promise<GetOrganizationResalePolicyOutput> {
  const input = parseInput(getOrganizationResalePolicyInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const org = await deps.repos.organizations.getById(input.orgId);
  if (!org) {
    throw fail("ORG_NOT_FOUND");
  }

  if (!org.defaultResalePayoutTermsId) {
    return getOrganizationResalePolicyOutputSchema.parse({
      orgId: input.orgId,
      payoutTermsId: null,
      payoutReleaseDays: PLATFORM_DEFAULT_PAYOUT_RELEASE_DAYS,
      isPlatformDefault: true,
    });
  }

  const terms = await deps.repos.payoutTerms.getById(
    org.defaultResalePayoutTermsId,
  );
  if (!terms) {
    // Dangling FK — surface as platform default so the settings page still
    // works; the next save will mint a fresh template row.
    const extra = {
      orgId: input.orgId,
      payoutTermsId: org.defaultResalePayoutTermsId,
    };
    deps.logger?.warn("orgs.resale_policy_dangling_fk", extra);
    try {
      deps.reportError?.(new Error("org_resale_policy_dangling_fk"), {
        tags: {
          useCase: "getOrganizationResalePolicy",
          reason: "dangling_fk",
        },
        extra,
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return getOrganizationResalePolicyOutputSchema.parse({
      orgId: input.orgId,
      payoutTermsId: null,
      payoutReleaseDays: PLATFORM_DEFAULT_PAYOUT_RELEASE_DAYS,
      isPlatformDefault: true,
    });
  }

  return getOrganizationResalePolicyOutputSchema.parse({
    orgId: input.orgId,
    payoutTermsId: terms.id,
    // Effective window: a value stored below the claim window (allowed before
    // the floor existed) is clamped wherever it is used, so show that.
    payoutReleaseDays: Math.max(
      terms.resalePayoutReleaseDays,
      RESALE_CLAIM_WINDOW_DAYS,
    ),
    isPlatformDefault: false,
  });
}

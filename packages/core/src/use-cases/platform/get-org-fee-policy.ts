import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getGlobalFeePolicyInputSchema = z
  .object({
    actorHumanId: z.string(),
  })
  .strict();

export const feePolicyOutputSchema = z.object({
  id: z.string().nullable(),
  scopeType: z.enum(["GLOBAL", "ORG", "EVENT"]),
  buyerFeePct: z.number().nonnegative(),
  maxFeeCents: z.number().int().nonnegative().nullable(),
  minFeeCents: z.number().int().nonnegative(),
  maxPlatformFeeCents: z.number().int().nonnegative().nullable(),
  platformFixedCents: z.number().int().nonnegative(),
  feeMode: z.enum(["ABSORB", "PASS_THROUGH"]),
  processsorFeePct: z.number().nonnegative(),
  processorFixedCents: z.number().int().nonnegative(),
  payoutPct: z.number().nonnegative(),
  payoutFixedCents: z.number().int().nonnegative(),
  monthlyPayoutCents: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
});

export const getGlobalFeePolicyOutputSchema = z
  .object({
    policy: feePolicyOutputSchema.nullable(),
  })
  .strict();

export type GetGlobalFeePolicyInput = z.infer<
  typeof getGlobalFeePolicyInputSchema
>;
export type GetGlobalFeePolicyOutput = z.infer<
  typeof getGlobalFeePolicyOutputSchema
>;

export type GetGlobalFeePolicyDeps = {
  repos: Pick<Repos, "feePolicies">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current GLOBAL fee policy.
 * Restricted to platform staff (ADMIN role).
 */
export async function getGlobalFeePolicy(
  deps: GetGlobalFeePolicyDeps,
  rawInput: unknown,
): Promise<GetGlobalFeePolicyOutput> {
  const logger = deps.logger?.child({ useCase: "getGlobalFeePolicy" });

  const input = parseInput(getGlobalFeePolicyInputSchema, rawInput);

  // RBAC: must be platform staff
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN"],
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }

  const now = new Date();

  const globalPolicy = await deps.repos.feePolicies.resolveEffective({
    scopeType: "GLOBAL",
    scopeId: null,
    at: now,
  });

  if (!globalPolicy) {
    logger?.warn("No global fee policy found");
    return getGlobalFeePolicyOutputSchema.parse({ policy: null });
  }

  logger?.info("Resolved global fee policy", { policyId: globalPolicy.id });
  return getGlobalFeePolicyOutputSchema.parse({
    policy: {
      id: globalPolicy.id,
      scopeType: globalPolicy.scopeType,
      buyerFeePct: globalPolicy.buyerFeePct,
      maxFeeCents: globalPolicy.maxFeeCents,
      minFeeCents: globalPolicy.minFeeCents,
      maxPlatformFeeCents: globalPolicy.maxPlatformFeeCents,
      platformFixedCents: globalPolicy.platformFixedCents,
      feeMode: globalPolicy.feeMode,
      processsorFeePct: globalPolicy.processsorFeePct,
      processorFixedCents: globalPolicy.processorFixedCents,
      payoutPct: globalPolicy.payoutPct,
      payoutFixedCents: globalPolicy.payoutFixedCents,
      monthlyPayoutCents: globalPolicy.monthlyPayoutCents,
      version: globalPolicy.version,
    },
  });
}

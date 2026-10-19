import { z } from "zod";
import { resourceLimitKindSchema, quotaSubjectTypeSchema } from "@th/schema";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_ANY_ROLE } from "../../lib/rbac";

export const getEffectiveQuotaInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    subjectType: quotaSubjectTypeSchema,
    subjectId: z.string().min(1),
    kind: resourceLimitKindSchema,
  })
  .strict();

export const getEffectiveQuotaOutputSchema = z
  .object({
    kind: resourceLimitKindSchema,
    limitValue: z.string(),
    currentUsage: z.string(),
    isOverride: z.boolean(),
    hasPendingExpansionRequest: z.boolean(),
    /** Only set for ORG subjects with trust-scaled quota kinds. */
    trustLevel: z.number().int().min(0).max(3).optional(),
  })
  .strict();

export type GetEffectiveQuotaInput = z.infer<
  typeof getEffectiveQuotaInputSchema
>;
export type GetEffectiveQuotaOutput = z.infer<
  typeof getEffectiveQuotaOutputSchema
>;

export type GetEffectiveQuotaDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function getEffectiveQuota(
  deps: GetEffectiveQuotaDeps,
  rawInput: unknown,
): Promise<GetEffectiveQuotaOutput> {
  const input = parseInput(getEffectiveQuotaInputSchema, rawInput);

  // Cross-tenant guard: the actor must own (HUMAN) or be a member of (ORG) the
  // subject before we expose its quota. The quota subjectType enum uses "ORG",
  // while requireOwnerAccess expects "ORGANIZATION".
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.subjectType === "ORG" ? "ORGANIZATION" : "HUMAN",
    ownerId: input.subjectId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ANY_ROLE,
  });

  const [quota, hasPending] = await Promise.all([
    deps.repos.resourceQuotas.getEffectiveQuota({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
    }),
    deps.repos.resourceQuotas.hasPendingExpansionRequest({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
    }),
  ]);

  return getEffectiveQuotaOutputSchema.parse({
    kind: quota.kind,
    limitValue: quota.limitValue.toString(),
    currentUsage: quota.currentUsage.toString(),
    isOverride: quota.isOverride,
    hasPendingExpansionRequest: hasPending,
    trustLevel: quota.trustLevel,
  });
}

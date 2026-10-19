import { z } from "zod";
import { resourceLimitKindSchema, quotaSubjectTypeSchema } from "@th/schema";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_EDIT_OR_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

export const requestQuotaExpansionInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    subjectType: quotaSubjectTypeSchema,
    subjectId: z.string().min(1),
    kind: resourceLimitKindSchema,
    requestedLimitValue: z.coerce.bigint().positive(),
    reason: z
      .string()
      .trim()
      .min(10, "reason_min_length")
      .max(1000, "reason_max_length"),
  })
  .strict();

export const requestQuotaExpansionOutputSchema = z
  .object({
    expansionRequestId: z.string(),
    status: z.literal("PENDING"),
  })
  .strict();

export type RequestQuotaExpansionInput = z.infer<
  typeof requestQuotaExpansionInputSchema
>;
export type RequestQuotaExpansionOutput = z.infer<
  typeof requestQuotaExpansionOutputSchema
>;

export type RequestQuotaExpansionDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function requestQuotaExpansion(
  deps: RequestQuotaExpansionDeps,
  rawInput: unknown,
): Promise<RequestQuotaExpansionOutput> {
  const input = parseInput(requestQuotaExpansionInputSchema, rawInput);

  // Cross-tenant guard: the actor must own (HUMAN) or be a member of (ORG) the
  // subject before they can file an expansion request against it. The quota
  // subjectType enum uses "ORG", while requireOwnerAccess expects "ORGANIZATION".
  // For ORG subjects we require an edit/finance role (not VIEWER/SCANNER): only
  // those roles can create the resources that hit these limits, and it keeps
  // read-only members from polluting the platform expansion-review queue.
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.subjectType === "ORG" ? "ORGANIZATION" : "HUMAN",
    ownerId: input.subjectId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_OR_FINANCE_ROLES,
  });

  const result = await deps.repos.tx(async (tx) => {
    // Check no duplicate PENDING request
    const hasPending = await tx.resourceQuotas.hasPendingExpansionRequest({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
    });

    if (hasPending) {
      throw fail("EXPANSION_REQUEST_ALREADY_PENDING");
    }

    // Get effective quota so we can record the current limit
    const quota = await tx.resourceQuotas.getEffectiveQuota({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
    });

    if (input.requestedLimitValue <= quota.limitValue) {
      throw fail("REQUESTED_LIMIT_NOT_HIGHER");
    }

    const request = await tx.resourceQuotas.createExpansionRequest({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentLimitValue: quota.limitValue,
      requestedLimitValue: input.requestedLimitValue,
      reason: input.reason,
      requestedByHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "expansion_request",
      entityId: request.id,
      action: "expansion_request.created",
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: input.kind,
        requestedLimitValue: input.requestedLimitValue.toString(),
      },
      at: new Date(),
    });

    return request;
  });

  return requestQuotaExpansionOutputSchema.parse({
    expansionRequestId: result.id,
    status: result.status,
  });
}

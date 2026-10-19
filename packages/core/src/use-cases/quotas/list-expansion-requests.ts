import { z } from "zod";
import {
  expansionRequestStatusSchema,
  resourceLimitKindSchema,
  quotaSubjectTypeSchema,
} from "@th/schema";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

export const listExpansionRequestsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    status: expansionRequestStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

const expansionRequestItemSchema = z.object({
  id: z.string(),
  subjectType: quotaSubjectTypeSchema,
  subjectId: z.string(),
  kind: resourceLimitKindSchema,
  currentLimitValue: z.string(),
  requestedLimitValue: z.string(),
  reason: z.string(),
  status: expansionRequestStatusSchema,
  requestedByHumanId: z.string(),
  reviewedByHumanId: z.string().nullable(),
  reviewedAt: z.coerce.date().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const listExpansionRequestsOutputSchema = z
  .object({
    items: z.array(expansionRequestItemSchema),
    total: z.number(),
  })
  .strict();

export type ListExpansionRequestsInput = z.infer<
  typeof listExpansionRequestsInputSchema
>;
export type ListExpansionRequestsOutput = z.infer<
  typeof listExpansionRequestsOutputSchema
>;

export type ListExpansionRequestsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listExpansionRequests(
  deps: ListExpansionRequestsDeps,
  rawInput: unknown,
): Promise<ListExpansionRequestsOutput> {
  const input = parseInput(listExpansionRequestsInputSchema, rawInput);

  // Platform staff check
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT"],
  });

  const result = await deps.repos.resourceQuotas.listExpansionRequests({
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  return listExpansionRequestsOutputSchema.parse({
    items: result.items.map((item) => ({
      ...item,
      currentLimitValue: item.currentLimitValue.toString(),
      requestedLimitValue: item.requestedLimitValue.toString(),
    })),
    total: result.total,
  });
}

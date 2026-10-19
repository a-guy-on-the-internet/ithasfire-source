import { z } from "zod";

import {
  eventCategoryRequestKindSchema,
  eventCategoryRequestRecordSchema,
  eventCategoryRequestStatusSchema,
} from "@th/schema";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

export const listCategoryRequestsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    status: eventCategoryRequestStatusSchema.default("PENDING"),
    kind: eventCategoryRequestKindSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listCategoryRequestsOutputSchema = z
  .object({
    requests: z.array(eventCategoryRequestRecordSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ListCategoryRequestsInput = z.infer<
  typeof listCategoryRequestsInputSchema
>;
export type ListCategoryRequestsOutput = z.infer<
  typeof listCategoryRequestsOutputSchema
>;

export type ListCategoryRequestsDeps = {
  repos: Pick<Repos, "categoryRequests">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listCategoryRequests(
  deps: ListCategoryRequestsDeps,
  rawInput: unknown,
): Promise<ListCategoryRequestsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listCategoryRequests" });

  const execute = async (): Promise<ListCategoryRequestsOutput> => {
    const input = parseInput(listCategoryRequestsInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "REVIEWER", "DEVELOPER", "SUPPORT"],
    });

    const result = await deps.repos.categoryRequests.list({
      status: input.status,
      kind: input.kind,
      limit: input.limit,
      offset: input.offset,
    });

    return listCategoryRequestsOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listCategoryRequests", execute);
  }

  return execute();
}

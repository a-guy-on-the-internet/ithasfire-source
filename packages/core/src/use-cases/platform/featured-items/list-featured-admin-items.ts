import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { featuredItemRecordSchema } from "./schema";

export const listFeaturedAdminItemsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listFeaturedAdminItemsOutputSchema = z
  .object({
    items: z.array(featuredItemRecordSchema),
    total: z.number().int().min(0),
  })
  .strict();

export type ListFeaturedAdminItemsInput = z.infer<
  typeof listFeaturedAdminItemsInputSchema
>;
export type ListFeaturedAdminItemsOutput = z.infer<
  typeof listFeaturedAdminItemsOutputSchema
>;

export type ListFeaturedAdminItemsDeps = {
  repos: Pick<Repos, "featuredItems">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listFeaturedAdminItems(
  deps: ListFeaturedAdminItemsDeps,
  rawInput: unknown,
): Promise<ListFeaturedAdminItemsOutput> {
  const input = parseInput(listFeaturedAdminItemsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
  });

  const result = await deps.repos.featuredItems.listAll({
    limit: input.limit,
    offset: input.offset,
  });

  deps.logger?.info("listFeaturedAdminItems.completed", {
    count: result.items.length,
    total: result.total,
  });

  return listFeaturedAdminItemsOutputSchema.parse(result);
}

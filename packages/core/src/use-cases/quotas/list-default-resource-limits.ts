import { z } from "zod";
import { resourceLimitKindSchema } from "@th/schema";
import {
  ALL_RESOURCE_LIMIT_KINDS,
  DEFAULT_RESOURCE_LIMITS,
} from "@th/types/repos/resource-quotas";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

export const listDefaultResourceLimitsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

const defaultLimitItemSchema = z.object({
  kind: resourceLimitKindSchema,
  limitValue: z.string(),
  /** True when the value comes from a DB row; false when using the built-in fallback. */
  isConfigured: z.boolean(),
});

export const listDefaultResourceLimitsOutputSchema = z
  .object({
    items: z.array(defaultLimitItemSchema),
  })
  .strict();

export type ListDefaultResourceLimitsInput = z.infer<
  typeof listDefaultResourceLimitsInputSchema
>;
export type ListDefaultResourceLimitsOutput = z.infer<
  typeof listDefaultResourceLimitsOutputSchema
>;

export type ListDefaultResourceLimitsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listDefaultResourceLimits(
  deps: ListDefaultResourceLimitsDeps,
  rawInput: unknown,
): Promise<ListDefaultResourceLimitsOutput> {
  const input = parseInput(listDefaultResourceLimitsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT"],
  });

  const records = await deps.repos.resourceQuotas.listDefaultLimits();

  // Index DB rows by kind for O(1) lookup.
  const dbMap = new Map(records.map((r) => [r.kind, r]));

  // Return every known kind. Prefer the DB value; fall back to the
  // built-in default so admins always see the full list.
  const items = ALL_RESOURCE_LIMIT_KINDS.map((kind) => {
    const dbRow = dbMap.get(kind);
    return {
      kind,
      limitValue: (dbRow
        ? dbRow.limitValue
        : DEFAULT_RESOURCE_LIMITS[kind]
      ).toString(),
      isConfigured: dbRow !== undefined,
    };
  });

  return listDefaultResourceLimitsOutputSchema.parse({ items });
}

import { z } from "zod";
import { resourceLimitKindSchema } from "@th/schema";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

export const updateDefaultResourceLimitInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    kind: resourceLimitKindSchema,
    limitValue: z.coerce.bigint().positive(),
  })
  .strict();

export const updateDefaultResourceLimitOutputSchema = z
  .object({
    kind: resourceLimitKindSchema,
    limitValue: z.string(),
  })
  .strict();

export type UpdateDefaultResourceLimitInput = z.infer<
  typeof updateDefaultResourceLimitInputSchema
>;
export type UpdateDefaultResourceLimitOutput = z.infer<
  typeof updateDefaultResourceLimitOutputSchema
>;

export type UpdateDefaultResourceLimitDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function updateDefaultResourceLimit(
  deps: UpdateDefaultResourceLimitDeps,
  rawInput: unknown,
): Promise<UpdateDefaultResourceLimitOutput> {
  const input = parseInput(updateDefaultResourceLimitInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
    errorCode: "STAFF_ONLY",
  });

  const result = await deps.repos.tx(async (tx) => {
    const record = await tx.resourceQuotas.upsertDefaultLimit({
      kind: input.kind,
      limitValue: input.limitValue,
    });

    await tx.audit.log({
      entity: "default_resource_limit",
      entityId: input.kind,
      action: "default_resource_limit.updated",
      data: {
        actorHumanId: input.actorHumanId,
        kind: input.kind,
        limitValue: input.limitValue.toString(),
      },
      at: new Date(),
    });

    return record;
  });

  return updateDefaultResourceLimitOutputSchema.parse({
    kind: result.kind,
    limitValue: result.limitValue.toString(),
  });
}

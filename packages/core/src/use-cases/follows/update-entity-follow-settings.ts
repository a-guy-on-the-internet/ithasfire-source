import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  updateEntityFollowSettingsInputSchema,
  updateEntityFollowSettingsOutputSchema,
} from "./schemas";
import { ensureCanManageEntityPage, getEntityPageOrThrow } from "./shared";

export type UpdateEntityFollowSettingsInput = z.infer<
  typeof updateEntityFollowSettingsInputSchema
>;
export type UpdateEntityFollowSettingsOutput = z.infer<
  typeof updateEntityFollowSettingsOutputSchema
>;

export type UpdateEntityFollowSettingsDeps = {
  repos: Pick<Repos, "tx" | "entityPages">;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace">;
  logger?: LoggerPort;
};

export async function updateEntityFollowSettings(
  deps: UpdateEntityFollowSettingsDeps,
  rawInput: unknown,
): Promise<UpdateEntityFollowSettingsOutput> {
  const logger = deps.logger?.child({ useCase: "updateEntityFollowSettings" });

  const execute = async () => {
    const input = parseInput(updateEntityFollowSettingsInputSchema, rawInput);
    const page = await getEntityPageOrThrow(deps.repos, input.entityPageId);

    await ensureCanManageEntityPage(deps.authz, input.actorHumanId, page);

    await deps.repos.tx(async (tx) => {
      await tx.entityPages.updateFollowSettings(page.id, {
        allowFollows: input.allowFollows,
        showFollowerCount: input.showFollowerCount,
      });

      await tx.audit.log({
        entity: "entity_page",
        entityId: page.id,
        action: "entity_page.follow_settings_updated",
        data: {
          actorHumanId: input.actorHumanId,
          allowFollows: input.allowFollows,
          showFollowerCount: input.showFollowerCount,
        },
      });
    });

    return updateEntityFollowSettingsOutputSchema.parse({
      entityPageId: page.id,
    });
  };

  if (logger) {
    return logger.withTime("updateEntityFollowSettings", execute);
  }

  return execute();
}

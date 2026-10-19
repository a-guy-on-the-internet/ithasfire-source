import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import {
  FOLLOW_NEARBY_DEFAULT_RADIUS_KM,
  updateFollowPreferencesInputSchema,
  updateFollowPreferencesOutputSchema,
} from "./schemas";

export type UpdateFollowPreferencesInput = z.infer<
  typeof updateFollowPreferencesInputSchema
>;
export type UpdateFollowPreferencesOutput = z.infer<
  typeof updateFollowPreferencesOutputSchema
>;

export type UpdateFollowPreferencesDeps = {
  repos: Pick<Repos, "tx" | "follows">;
  logger?: LoggerPort;
};

export async function updateFollowPreferences(
  deps: UpdateFollowPreferencesDeps,
  rawInput: unknown,
): Promise<UpdateFollowPreferencesOutput> {
  const logger = deps.logger?.child({ useCase: "updateFollowPreferences" });

  const execute = async () => {
    const input = parseInput(updateFollowPreferencesInputSchema, rawInput);

    const updated = await deps.repos.tx(async (tx) => {
      const existing = await tx.follows.getFollow(
        input.actorHumanId,
        input.entityPageId,
      );
      if (!existing) {
        throw fail("FOLLOW_NOT_FOUND");
      }

      const follow = await tx.follows.updateFollowPreferences(
        input.actorHumanId,
        input.entityPageId,
        {
          notifyNewEvents: input.notifyNewEvents,
          notifyNearby: input.notifyNearby,
          // An omitted radius keeps the stored one: a save changes the
          // radius only when the person sent a new one.
          radiusKm: input.notifyNearby
            ? (input.radiusKm ??
              existing.radiusKm ??
              FOLLOW_NEARBY_DEFAULT_RADIUS_KM)
            : undefined,
        },
      );

      await tx.audit.log({
        entity: "entity_follow",
        entityId: follow.id,
        action: "entity_follow.preferences_updated",
        data: {
          actorHumanId: input.actorHumanId,
          entityPageId: input.entityPageId,
          notifyNewEvents: input.notifyNewEvents,
          notifyNearby: input.notifyNearby,
        },
      });

      return follow;
    });

    return updateFollowPreferencesOutputSchema.parse({ followId: updated.id });
  };

  if (logger) {
    return logger.withTime("updateFollowPreferences", execute);
  }

  return execute();
}

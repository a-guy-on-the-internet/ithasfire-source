import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  FOLLOW_NEARBY_DEFAULT_RADIUS_KM,
  followEntityInputSchema,
  followEntityOutputSchema,
} from "./schemas";
import { getPublicEntityPageOrThrow } from "./shared";
import { fail } from "@th/errors";

export type FollowEntityInput = z.infer<typeof followEntityInputSchema>;
export type FollowEntityOutput = z.infer<typeof followEntityOutputSchema>;

export type FollowEntityDeps = {
  repos: Pick<Repos, "tx" | "follows" | "entityPages">;
  logger?: LoggerPort;
};

export async function followEntity(
  deps: FollowEntityDeps,
  rawInput: unknown,
): Promise<FollowEntityOutput> {
  const logger = deps.logger?.child({ useCase: "followEntity" });

  const execute = async () => {
    const input = parseInput(followEntityInputSchema, rawInput);
    const page = await getPublicEntityPageOrThrow(
      deps.repos,
      input.entityPageId,
    );

    if (!page.allowFollows) {
      throw fail("FOLLOWS_DISABLED");
    }

    if (page.ownerType === "HUMAN" && page.ownerId === input.actorHumanId) {
      throw fail("SELF_FOLLOW_NOT_ALLOWED");
    }

    const follow = await deps.repos.tx(async (tx) => {
      const result = await tx.follows.upsertFollow({
        followerHumanId: input.actorHumanId,
        entityPageId: input.entityPageId,
        notifyNearby: input.notifyNearby,
        radiusKm: input.notifyNearby ? (input.radiusKm ?? FOLLOW_NEARBY_DEFAULT_RADIUS_KM) : undefined,
      });

      if (result.created) {
        await tx.audit.log({
          entity: "entity_follow",
          entityId: result.follow.id,
          action: "entity_follow.created",
          data: {
            actorHumanId: input.actorHumanId,
            entityPageId: input.entityPageId,
          },
        });
      }

      return {
        followId: result.follow.id,
        alreadyFollowing: !result.created,
      } as const;
    });

    return followEntityOutputSchema.parse(follow);
  };

  if (logger) {
    return logger.withTime("followEntity", execute);
  }

  return execute();
}

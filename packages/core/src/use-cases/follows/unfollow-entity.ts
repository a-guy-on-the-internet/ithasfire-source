import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  unfollowEntityInputSchema,
  unfollowEntityOutputSchema,
} from "./schemas";

export type UnfollowEntityInput = z.infer<typeof unfollowEntityInputSchema>;
export type UnfollowEntityOutput = z.infer<typeof unfollowEntityOutputSchema>;

export type UnfollowEntityDeps = {
  repos: Pick<Repos, "tx" | "follows">;
  logger?: LoggerPort;
};

export async function unfollowEntity(
  deps: UnfollowEntityDeps,
  rawInput: unknown,
): Promise<UnfollowEntityOutput> {
  const logger = deps.logger?.child({ useCase: "unfollowEntity" });

  const execute = async () => {
    const input = parseInput(unfollowEntityInputSchema, rawInput);

    await deps.repos.tx(async (tx) => {
      const result = await tx.follows.deleteFollow(
        input.actorHumanId,
        input.entityPageId,
      );
      if (!result.deleted || !result.followId) {
        return;
      }

      await tx.audit.log({
        entity: "entity_follow",
        entityId: result.followId,
        action: "entity_follow.deleted",
        data: {
          actorHumanId: input.actorHumanId,
          entityPageId: input.entityPageId,
        },
      });
    });

    return unfollowEntityOutputSchema.parse({ success: true });
  };

  if (logger) {
    return logger.withTime("unfollowEntity", execute);
  }

  return execute();
}

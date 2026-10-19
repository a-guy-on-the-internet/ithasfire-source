import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { isFollowingInputSchema, isFollowingOutputSchema } from "./schemas";

export type IsFollowingInput = z.infer<typeof isFollowingInputSchema>;
export type IsFollowingOutput = z.infer<typeof isFollowingOutputSchema>;

export type IsFollowingDeps = {
  repos: Pick<Repos, "follows">;
  logger?: LoggerPort;
};

export async function isFollowing(
  deps: IsFollowingDeps,
  rawInput: unknown,
): Promise<IsFollowingOutput> {
  const logger = deps.logger?.child({ useCase: "isFollowing" });

  const execute = async () => {
    const input = parseInput(isFollowingInputSchema, rawInput);
    const follow = await deps.repos.follows.getFollow(
      input.actorHumanId,
      input.entityPageId,
    );
    return isFollowingOutputSchema.parse({ isFollowing: Boolean(follow) });
  };

  if (logger) {
    return logger.withTime("isFollowing", execute);
  }

  return execute();
}

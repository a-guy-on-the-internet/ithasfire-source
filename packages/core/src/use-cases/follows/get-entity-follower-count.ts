import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  getEntityFollowerCountInputSchema,
  getEntityFollowerCountOutputSchema,
} from "./schemas";
import { getPublicEntityPageOrThrow } from "./shared";

export type GetEntityFollowerCountInput = z.infer<
  typeof getEntityFollowerCountInputSchema
>;
export type GetEntityFollowerCountOutput = z.infer<
  typeof getEntityFollowerCountOutputSchema
>;

export type GetEntityFollowerCountDeps = {
  repos: Pick<Repos, "entityPages" | "follows">;
  logger?: LoggerPort;
};

export async function getEntityFollowerCount(
  deps: GetEntityFollowerCountDeps,
  rawInput: unknown,
): Promise<GetEntityFollowerCountOutput> {
  const logger = deps.logger?.child({ useCase: "getEntityFollowerCount" });

  const execute = async () => {
    const input = parseInput(getEntityFollowerCountInputSchema, rawInput);
    const page = await getPublicEntityPageOrThrow(
      deps.repos,
      input.entityPageId,
    );
    const count = await deps.repos.follows.countByEntity(page.id);

    return getEntityFollowerCountOutputSchema.parse({
      count: page.showFollowerCount ? count : 0,
      isPublic: page.showFollowerCount,
    });
  };

  if (logger) {
    return logger.withTime("getEntityFollowerCount", execute);
  }

  return execute();
}

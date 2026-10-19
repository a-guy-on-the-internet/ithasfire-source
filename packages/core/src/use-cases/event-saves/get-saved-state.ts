import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import {
  getSavedStateInputSchema,
  getSavedStateOutputSchema,
} from "./schemas";

export type GetSavedStateInput = z.infer<typeof getSavedStateInputSchema>;
export type GetSavedStateOutput = z.infer<typeof getSavedStateOutputSchema>;

export type GetSavedStateDeps = {
  repos: Pick<Repos, "eventSaves">;
  logger?: LoggerPort;
};

/**
 * Batch saved flags for one page of event cards (FR-005). Bounded to ≤50
 * eventIds at the schema so the toggle path stays a single index lookup
 * (NFR-001). Only ever reflects the actor's own saves.
 */
export async function getSavedState(
  deps: GetSavedStateDeps,
  rawInput: unknown,
): Promise<GetSavedStateOutput> {
  const logger = deps.logger?.child({ useCase: "getSavedState" });

  const execute = async () => {
    const input = parseInput(getSavedStateInputSchema, rawInput);
    const saved = await deps.repos.eventSaves.getSavedStateForEvents({
      humanId: input.actorHumanId,
      eventIds: input.eventIds,
    });

    return getSavedStateOutputSchema.parse({ saved });
  };

  if (logger) {
    return logger.withTime("getSavedState", execute);
  }

  return execute();
}

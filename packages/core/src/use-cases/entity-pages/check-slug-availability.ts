import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

// ── Schemas ────────────────────────────────────────────────────────────────

export const checkSlugAvailabilityInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(200),
    /** If editing an existing page, exclude its own slug from the collision check. */
    excludePageId: z.string().optional(),
  })
  .strict();

export const checkSlugAvailabilityOutputSchema = z
  .object({
    available: z.boolean(),
  })
  .strict();

export type CheckSlugAvailabilityInput = z.infer<
  typeof checkSlugAvailabilityInputSchema
>;
export type CheckSlugAvailabilityOutput = z.infer<
  typeof checkSlugAvailabilityOutputSchema
>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type CheckSlugAvailabilityDeps = {
  repos: Pick<Repos, "entityPages">;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function checkSlugAvailability(
  deps: CheckSlugAvailabilityDeps,
  rawInput: unknown,
): Promise<CheckSlugAvailabilityOutput> {
  const logger = deps.logger?.child({ useCase: "checkSlugAvailability" });

  const execute = async (): Promise<CheckSlugAvailabilityOutput> => {
    const input = parseInput(checkSlugAvailabilityInputSchema, rawInput);

    const available = await deps.repos.entityPages.isSlugAvailable(
      input.slug,
      input.excludePageId,
    );

    return checkSlugAvailabilityOutputSchema.parse({ available });
  };

  if (logger) {
    return logger.withTime("checkSlugAvailability", execute);
  }
  return execute();
}

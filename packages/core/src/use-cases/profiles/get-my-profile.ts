import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { z } from "zod";

export const getMyProfileInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

export const getMyProfileOutputSchema = z
  .object({
    humanId: z.uuid(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    /** Slug of the human's EntityPage, when one exists. Used to build links to /humans/[slug]. */
    slug: z.string().nullable(),
    /**
     * Visibility of the human's EntityPage. `null` when no page exists yet.
     * Lets account settings show a public-page on/off toggle without a
     * second round-trip. PRIVATE pages 404 on public routes.
     */
    visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]).nullable(),
  })
  .strict();

export type GetMyProfileInput = z.infer<typeof getMyProfileInputSchema>;
export type GetMyProfileOutput = z.infer<typeof getMyProfileOutputSchema>;

export type GetMyProfileDeps = {
  repos: Pick<Repos, "humans" | "entityPages">;
  logger?: LoggerPort;
};

export async function getMyProfile(
  deps: GetMyProfileDeps,
  rawInput: unknown,
): Promise<GetMyProfileOutput> {
  const logger = deps.logger?.child({ useCase: "getMyProfile" });

  const execute = async () => {
    const input = parseInput(getMyProfileInputSchema, rawInput);

    const page = await deps.repos.entityPages.getByOwner(
      "HUMAN",
      input.actorHumanId,
    );

    return getMyProfileOutputSchema.parse({
      humanId: input.actorHumanId,
      displayName: page?.displayName ?? null,
      avatarUrl: page?.avatarUrl ?? null,
      slug: page?.slug ?? null,
      visibility: page?.visibility ?? null,
    });
  };

  if (logger) {
    return logger.withTime("getMyProfile", execute);
  }

  return execute();
}

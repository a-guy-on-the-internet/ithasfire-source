import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const resolvePlaceByIdInputSchema = z
  .object({
    placeId: z.string().uuid(),
  })
  .strict();

export const resolvePlaceByIdOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    redirect: z.boolean(),
  })
  .strict();

export type ResolvePlaceByIdInput = z.infer<typeof resolvePlaceByIdInputSchema>;
export type ResolvePlaceByIdOutput = z.infer<
  typeof resolvePlaceByIdOutputSchema
>;

export type ResolvePlaceByIdDeps = {
  repos: Pick<Repos, "places">;
  logger?: LoggerPort;
};

export async function resolvePlaceById(
  deps: ResolvePlaceByIdDeps,
  rawInput: unknown,
): Promise<ResolvePlaceByIdOutput> {
  const input = parseInput(resolvePlaceByIdInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // This is a placeholder resolver.
  // Once we add place slugs + slug history, this will return the canonical slug
  // and indicate whether the request should be redirected.
  deps.logger?.info("places.resolve_by_id", { placeId: input.placeId });

  return resolvePlaceByIdOutputSchema.parse({
    placeId: place.id,
    redirect: false,
  });
}

import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * Counts public directory places for honest "N venues" copy (home hero kicker).
 *
 * A directory place is `Place.status = ACTIVE AND Place.listedInDirectory = true`;
 * when a `near` scope is given, additionally `lat`/`lng` are non-null and within
 * `radiusKm` of the point.
 */
export const countDirectoryPlacesInputSchema = z
  .object({
    near: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusKm: z.number().positive().max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

export const countDirectoryPlacesOutputSchema = z.object({
  count: z.number().int().min(0),
});

export type CountDirectoryPlacesInput = z.infer<
  typeof countDirectoryPlacesInputSchema
>;
export type CountDirectoryPlacesOutput = z.infer<
  typeof countDirectoryPlacesOutputSchema
>;

export type CountDirectoryPlacesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function countDirectoryPlaces(
  deps: CountDirectoryPlacesDeps,
  rawInput: unknown,
): Promise<CountDirectoryPlacesOutput> {
  const input = parseInput(countDirectoryPlacesInputSchema, rawInput);

  const count = await deps.repos.places.countDirectory(
    input.near ? { near: input.near } : undefined,
  );

  deps.logger?.info("places.count_directory", {
    count,
    scoped: Boolean(input.near),
  });

  return countDirectoryPlacesOutputSchema.parse({ count });
}

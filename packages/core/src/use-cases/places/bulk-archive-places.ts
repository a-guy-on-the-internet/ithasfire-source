import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { UpdatePlaceStatusDeps } from "./update-place-status";
import { updatePlaceStatus } from "./update-place-status";

export const bulkArchivePlacesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).min(1).max(100),
});

export const bulkArchivePlacesOutputSchema = z.object({
  total: z.number().int(),
  archived: z.number().int(),
  skipped: z.number().int(),
  results: z.array(
    z.object({
      placeId: z.string().uuid(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});

export type BulkArchivePlacesInput = z.infer<
  typeof bulkArchivePlacesInputSchema
>;
export type BulkArchivePlacesOutput = z.infer<
  typeof bulkArchivePlacesOutputSchema
>;

export type BulkArchivePlacesDeps = UpdatePlaceStatusDeps;

export async function bulkArchivePlaces(
  deps: BulkArchivePlacesDeps,
  rawInput: unknown,
): Promise<BulkArchivePlacesOutput> {
  const input = parseInput(bulkArchivePlacesInputSchema, rawInput);
  const results: BulkArchivePlacesOutput["results"] = [];
  let archived = 0;
  let skipped = 0;

  for (const placeId of input.placeIds) {
    try {
      await updatePlaceStatus(deps, {
        actorHumanId: input.actorHumanId,
        placeId,
        status: "ARCHIVED",
        clientKey: `${input.actorHumanId}:archive:${placeId}`,
      });
      results.push({ placeId, ok: true });
      archived++;
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "internal_error";
      results.push({ placeId, ok: false, error: code });
      skipped++;
    }
  }

  return { total: input.placeIds.length, archived, skipped, results };
}

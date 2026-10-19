import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import {
  upsertPlace,
  upsertPlaceInputSchema,
  type UpsertPlaceDeps,
} from "./upsert-place";

// Capped at 5 to stay within the default Prisma connection pool (2×CPUs+1 on
// a single-vCPU Cloud Run instance ≈ 3-5). Each upsertPlace opens one tx.
const CONCURRENCY = 5;

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]!() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
}

const singlePlaceSchema = upsertPlaceInputSchema.omit({ actorHumanId: true });

export const bulkUpsertPlacesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  places: z.array(singlePlaceSchema).min(1).max(100),
});

export const bulkUpsertPlacesOutputSchema = z.object({
  total: z.number().int(),
  imported: z.number().int(),
  skipped: z.number().int(),
  results: z.array(
    z.object({
      index: z.number().int(),
      placeId: z.string().uuid().optional(),
      error: z.string().optional(),
    }),
  ),
});

export type BulkUpsertPlacesInput = z.infer<typeof bulkUpsertPlacesInputSchema>;
export type BulkUpsertPlacesOutput = z.infer<
  typeof bulkUpsertPlacesOutputSchema
>;

export type BulkUpsertPlacesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Forwarded to every per-item `upsertPlace`. An item that changes an
   * existing venue's address privacy re-projects that venue's events, and
   * `search` is what re-indexes them — without it their search documents keep
   * the old location until the nightly reindex.
   */
  search?: UpsertPlaceDeps["search"];
  reportError?: UpsertPlaceDeps["reportError"];
};

export async function bulkUpsertPlaces(
  deps: BulkUpsertPlacesDeps,
  rawInput: unknown,
): Promise<BulkUpsertPlacesOutput> {
  const input = parseInput(bulkUpsertPlacesInputSchema, rawInput);
  const results: BulkUpsertPlacesOutput["results"] = [];
  let imported = 0;
  let skipped = 0;

  const startMs = Date.now();

  const settledResults = await runWithConcurrency(
    input.places.map((placeInput, i) => async () => {
      const result = await upsertPlace(deps, {
        ...placeInput,
        actorHumanId: input.actorHumanId,
      });
      return { index: i, placeId: result.placeId };
    }),
    CONCURRENCY,
  );

  for (const [i, settled] of settledResults.entries()) {
    if (settled.status === "fulfilled") {
      results.push(settled.value);
      imported++;
    } else {
      const err = settled.reason;
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "internal_error";
      results.push({ index: i, error: code });
      skipped++;
    }
  }

  deps.logger?.info("bulkUpsertPlaces.completed", {
    total: input.places.length,
    imported,
    skipped,
    durationMs: Date.now() - startMs,
  });

  return { total: input.places.length, imported, skipped, results };
}

/**
 * Drain `SearchReindexPending`: the scheduled half of the edit-triggered,
 * batched search reindex (see `search-reindex-marks.ts`).
 *
 * Runs ONLY because an edit (or a previous drain that left rows behind)
 * scheduled it. Reads pending rows oldest-first in batches, reindexes them
 * through the same fenced incremental path every post-commit refresh uses,
 * clears the rows it refreshed (generation-guarded: a mark made while the
 * drain was reading survives), and records failures on the rest.
 *
 * Ends by looking at what is left:
 *   · nothing → no reschedule. The chain stops; nothing wakes the database
 *     until the next edit.
 *   · rows remain (failures, or marks made during the run) → ONE more run,
 *     backed off by how often those rows have already failed.
 * A row that has failed {@link DEFAULT_DRAIN_MAX_ATTEMPTS} times is parked:
 * no drain picks it up or reschedules for it, and the nightly full reindex
 * (which clears the list too) is its backstop. A new edit to that entity
 * re-marks it and resets the count.
 */
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  SearchReindexEntityType,
  SearchReindexPendingRow,
  SearchReindexPendingSnapshot,
} from "@th/ports/repos/search-reindex-pending";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { describeError, parseInput } from "../../lib/io";
import {
  buildSearchIndex,
  MAX_INDEX_BATCH_SIZE,
  type BuildSearchIndexInput,
} from "./build-search-index";
import {
  scheduleSearchReindexDrain,
  type ScheduleDrainOutcome,
  type SearchReindexDrainTrigger,
} from "./search-reindex-marks";

export const DEFAULT_DRAIN_BATCH_SIZE = 100;
export const DEFAULT_DRAIN_MAX_BATCHES = 20;
/** Failed attempts after which a row is parked for the nightly rebuild. */
export const DEFAULT_DRAIN_MAX_ATTEMPTS = 5;
/** Same budget the outbox drains use (~120s), under the 300s request cap. */
export const DEFAULT_DRAIN_TIME_BUDGET_MS = 120_000;
/** First retry delay for rows that failed; doubles per failure. */
export const DRAIN_BACKOFF_BASE_MS = 5 * 60_000;
/** Longest backoff between retries. */
export const DRAIN_BACKOFF_MAX_MS = 60 * 60_000;

export const drainSearchReindexPendingInputSchema = z
  .object({
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_INDEX_BATCH_SIZE)
      .default(DEFAULT_DRAIN_BATCH_SIZE),
    maxBatches: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(DEFAULT_DRAIN_MAX_BATCHES),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(DEFAULT_DRAIN_MAX_ATTEMPTS),
    /**
     * Wall-clock budget: no new batch starts after it. Keeps one run well
     * inside the 300s Cloud Tasks dispatch deadline / Cloud Run request
     * timeout (a batch of up to 200 fenced single-type reindexes is seconds).
     * Rows left over are picked up by the reschedule.
     */
    timeBudgetMs: z
      .number()
      .int()
      .min(1)
      .max(240_000)
      .default(DEFAULT_DRAIN_TIME_BUDGET_MS),
  })
  .strict();

export type DrainSearchReindexPendingInput = z.input<
  typeof drainSearchReindexPendingInputSchema
>;

export type DrainSearchReindexPendingDeps = {
  repos: Repos;
  search: MultiSearchPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** ReporterPort convention: the drain swallows per-row failures. */
  reportError?: ReporterPort;
  /** For the self-reschedule while rows remain. Absent = nightly backstop. */
  searchReindexDrain?: SearchReindexDrainTrigger;
};

export type DrainSearchReindexPendingOutput = {
  /** Rows read and attempted this run. */
  attempted: number;
  /** Rows deleted by the guarded clear. */
  cleared: number;
  /** Rows whose reindex failed (kept, attempts + 1). */
  failed: number;
  /** A batch cap stopped the run with rows still unread. */
  batchCapReached: boolean;
  /** The time budget stopped the run before the list was exhausted. */
  budgetExhausted: boolean;
  /** Due rows left after the run (sampled, capped at the sample size). */
  remaining: number;
  reschedule: ScheduleDrainOutcome | "not_needed";
  /** Delay asked for when rescheduling with backoff (undefined = default). */
  rescheduleDelayMs?: number;
};

const SELECTOR_KEY: Record<
  SearchReindexEntityType,
  keyof Pick<
    BuildSearchIndexInput,
    "eventIds" | "humanIds" | "placeIds" | "organizationIds"
  >
> = {
  event: "eventIds",
  human: "humanIds",
  place: "placeIds",
  organization: "organizationIds",
};

/** Due rows sampled after the run to decide the reschedule. */
const REMAINING_SAMPLE = 50;

type Failure = { snapshot: SearchReindexPendingSnapshot; error: string };

export async function drainSearchReindexPending(
  deps: DrainSearchReindexPendingDeps,
  rawInput: unknown,
): Promise<DrainSearchReindexPendingOutput> {
  const input = parseInput(
    drainSearchReindexPendingInputSchema,
    rawInput ?? {},
  );
  const logger = deps.logger?.child({ useCase: "drainSearchReindexPending" });

  let attempted = 0;
  let cleared = 0;
  const failures: Failure[] = [];
  let cursor: SearchReindexPendingRow | undefined;
  let batchCapReached = false;
  let budgetExhausted = false;
  const deadline = deps.clock.now().getTime() + input.timeBudgetMs;

  for (let batch = 0; ; batch += 1) {
    if (batch >= input.maxBatches) {
      batchCapReached = true;
      break;
    }
    if (batch > 0 && deps.clock.now().getTime() >= deadline) {
      budgetExhausted = true;
      break;
    }
    const rows = await deps.repos.searchReindexPending.listDue({
      limit: input.batchSize,
      maxAttempts: input.maxAttempts,
      after: cursor
        ? {
            markedAt: cursor.markedAt,
            entityType: cursor.entityType,
            entityId: cursor.entityId,
          }
        : undefined,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1];
    attempted += rows.length;

    const outcome = await reindexRows(deps, rows);
    if (outcome.succeeded.length > 0) {
      cleared += await deps.repos.searchReindexPending.clearIfUnchanged(
        outcome.succeeded,
      );
    }
    for (const failure of outcome.failed) {
      await deps.repos.searchReindexPending.recordFailure([failure.snapshot], {
        error: failure.error,
        at: deps.clock.now(),
      });
      failures.push(failure);
    }
    if (rows.length < input.batchSize) break;
  }

  if (failures.length > 0) reportFailures(deps, logger, failures);

  // What is left decides whether the chain continues. Read from the START
  // (no cursor): this run's failures and marks made while it ran.
  const left = await deps.repos.searchReindexPending.listDue({
    limit: REMAINING_SAMPLE,
    maxAttempts: input.maxAttempts,
  });

  let reschedule: DrainSearchReindexPendingOutput["reschedule"] = "not_needed";
  let rescheduleDelayMs: number | undefined;
  if (left.length > 0) {
    rescheduleDelayMs = backoffDelayMs(left);
    reschedule = await scheduleSearchReindexDrain(
      {
        searchReindexDrain: deps.searchReindexDrain,
        clock: deps.clock,
        logger,
        reportError: deps.reportError,
      },
      { reason: "drainSearchReindexPending", delayMs: rescheduleDelayMs },
    );
  }

  const output: DrainSearchReindexPendingOutput = {
    attempted,
    cleared,
    failed: failures.length,
    batchCapReached,
    budgetExhausted,
    remaining: left.length,
    reschedule,
    rescheduleDelayMs,
  };
  logger?.info("search.reindex_drain_completed", output);
  return output;
}

/**
 * Backoff for the next run, from the LEAST-failed remaining row: a fresh mark
 * (0 failures) gets the configured default delay (`undefined`); rows that
 * only keep failing wait base · 2^(failures − 1), capped.
 */
export function backoffDelayMs(
  rows: ReadonlyArray<Pick<SearchReindexPendingRow, "attempts">>,
): number | undefined {
  const fewest = Math.min(...rows.map((r) => r.attempts));
  if (!Number.isFinite(fewest) || fewest <= 0) return undefined;
  return Math.min(
    DRAIN_BACKOFF_BASE_MS * 2 ** (fewest - 1),
    DRAIN_BACKOFF_MAX_MS,
  );
}

/**
 * Reindex one batch, grouped by entity type. A whole-group failure (the
 * fence gave up, the backend is down) is retried entity by entity, so one
 * poisoned entity cannot hold every other row in its batch hostage.
 */
async function reindexRows(
  deps: DrainSearchReindexPendingDeps,
  rows: SearchReindexPendingRow[],
): Promise<{ succeeded: SearchReindexPendingSnapshot[]; failed: Failure[] }> {
  const succeeded: SearchReindexPendingSnapshot[] = [];
  const failed: Failure[] = [];

  const byType = new Map<SearchReindexEntityType, SearchReindexPendingRow[]>();
  for (const row of rows) {
    const list = byType.get(row.entityType) ?? [];
    list.push(row);
    byType.set(row.entityType, list);
  }

  for (const [type, group] of byType) {
    let perId: Map<string, string>;
    try {
      perId = await indexIds(
        deps,
        type,
        group.map((r) => r.entityId),
      );
    } catch (err) {
      if (group.length === 1) {
        perId = new Map([[group[0]!.entityId, describeError(err)]]);
      } else {
        perId = new Map();
        for (const row of group) {
          try {
            const one = await indexIds(deps, type, [row.entityId]);
            for (const [id, error] of one) perId.set(id, error);
          } catch (oneErr) {
            perId.set(row.entityId, describeError(oneErr));
          }
        }
      }
    }
    for (const row of group) {
      const snapshot = {
        entityType: row.entityType,
        entityId: row.entityId,
        generation: row.generation,
      };
      const error = perId.get(row.entityId);
      if (error === undefined) succeeded.push(snapshot);
      else failed.push({ snapshot, error });
    }
  }

  return { succeeded, failed };
}

/** Reindex `ids` of one type. Resolves to the per-id failures (id → error). */
async function indexIds(
  deps: DrainSearchReindexPendingDeps,
  type: SearchReindexEntityType,
  ids: string[],
): Promise<Map<string, string>> {
  const result = await buildSearchIndex(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    { [SELECTOR_KEY[type]]: ids },
  );
  const failures = new Map<string, string>();
  for (const err of result.errors) {
    if (err.type === type) failures.set(err.id, err.error);
  }
  return failures;
}

function reportFailures(
  deps: DrainSearchReindexPendingDeps,
  logger: LoggerPort | undefined,
  failures: Failure[],
): void {
  const sample = failures.slice(0, 20).map((f) => ({
    type: f.snapshot.entityType,
    id: f.snapshot.entityId,
    error: f.error,
  }));
  try {
    logger?.error("search.reindex_drain_failures", {
      failed: failures.length,
      sample,
    });
  } catch {
    // Best-effort.
  }
  try {
    deps.reportError?.(
      new Error(
        `drainSearchReindexPending: ${failures.length} entity reindex(es) failed`,
      ),
      {
        tags: { useCase: "drainSearchReindexPending", op: "drain" },
        extra: { failed: failures.length, sample },
      },
    );
  } catch {
    // Best-effort: a throwing reporter must not end the drain.
  }
}

/**
 * The full search rebuild, and the one-shot rebuild after a format change.
 *
 *  · {@link runFullSearchReindex} is what `search.full-reindex` runs (nightly
 *    at 03:00 UTC, and on demand). Around the NON-DESTRUCTIVE
 *    `buildSearchIndex({ fullReindex })` it (1) clears the
 *    `SearchReindexPending` rows that existed before the rebuild read
 *    anything, for the types it fully refreshed (rewritten AND swept) only,
 *    and (2) records this build's {@link SEARCH_INDEX_FORMAT_VERSION} once
 *    every page was attempted and none failed as a whole. Per-id CONTENT
 *    errors do not block the record: those entities keep their previous
 *    document, and `buildSearchIndex` logs and REPORTS them once per type
 *    (`step: "contentErrors"`). After a page failure only the next nightly
 *    run can record the version (ensure-format is not retried for it).
 *  · {@link ensureSearchIndexFormat} is what `search.ensure-format` runs,
 *    fired once by the deploy workflow after the jobs service has rolled. It
 *    is the SAME code that rebuilds, so it compares the stored version with
 *    the version it would write: behind → claim, rebuild, record; equal or
 *    AHEAD (an older revision still serving) → no-op. No timer anywhere; a
 *    missed trigger self-heals at the next nightly run, which records the
 *    version too.
 */
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  SearchReindexPendingRow,
  SearchReindexPendingSnapshot,
} from "@th/ports/repos/search-reindex-pending";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { describeError } from "../../lib/io";
import {
  buildSearchIndex,
  isPageLevelError,
  type BuildSearchIndexOutput,
} from "./build-search-index";
import { SEARCH_INDEX_FORMAT_VERSION } from "./search-index-format";

/** The jobs-service job that rebuilds the whole index. */
export const SEARCH_FULL_REINDEX_JOB = "search.full-reindex";

/** Largest `attempts` value the snapshot reads (every row, parked included). */
const ALL_ATTEMPTS = 2_147_483_647;
const SNAPSHOT_PAGE = 500;

export type RunFullSearchReindexDeps = {
  repos: Repos;
  search: MultiSearchPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type RunFullSearchReindexOutput = BuildSearchIndexOutput & {
  /** Pending rows cleared because the rebuild refreshed them. */
  pendingCleared: number;
  /**
   * Format version recorded (null: a page failed as a whole, or recording
   * itself failed).
   */
  formatVersionRecorded: number | null;
};

export async function runFullSearchReindex(
  deps: RunFullSearchReindexDeps,
  input: { batchSize: number },
): Promise<RunFullSearchReindexOutput> {
  const logger = deps.logger?.child({ useCase: "runFullSearchReindex" });

  // Snapshot BEFORE the rebuild reads any source row: those marks are covered
  // by it. Marks made during the rebuild keep a newer generation and survive.
  const snapshot = await snapshotAllPending(deps.repos);

  const result = await buildSearchIndex(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    { fullReindex: true, batchSize: input.batchSize },
  );

  // A mark is covered only when its TYPE was fully refreshed: rewritten AND
  // swept. A type whose sweep was skipped (a page failed) or failed still
  // serves documents nothing rewrote — e.g. a venue suspended just before
  // the run — so its marks stay for the drain. Nothing counts as swept when
  // the sweep marker itself failed.
  const swept = new Set(result.sweptTypes ?? []);
  const failedKeys = new Set(result.errors.map((e) => `${e.type}:${e.id}`));
  const covered = snapshot.filter(
    (row) =>
      swept.has(row.entityType) &&
      !failedKeys.has(`${row.entityType}:${row.entityId}`),
  );
  // PAGE-level failures leave documents in the old format (never rewritten)
  // and block the record. Per-id CONTENT errors do not: those entities keep
  // their previous document, and buildSearchIndex logs + reports them once
  // per type (step "contentErrors").
  const pageFailures = result.errors.filter((e) => isPageLevelError(e.error));

  let pendingCleared = 0;
  let formatVersionRecorded: number | null = null;
  // Bookkeeping after the rebuild: a failure here must not turn a successful
  // rebuild into a failed run, but it must be visible (ReporterPort).
  try {
    pendingCleared =
      await deps.repos.searchReindexPending.clearIfUnchanged(covered);
    // Every page was attempted AND none failed as a whole: every live
    // document is now in this build's format. Monotonic, so an older
    // revision's run never lowers what a newer one recorded. With page
    // failures the version stays unrecorded (each failed page is reported by
    // the rebuild) and only the next nightly run can record it:
    // ensure-format returns normally here and is not retried.
    if (pageFailures.length === 0) {
      await deps.repos.searchIndexState.recordFormatVersion({
        version: SEARCH_INDEX_FORMAT_VERSION,
        at: deps.clock.now(),
      });
      formatVersionRecorded = SEARCH_INDEX_FORMAT_VERSION;
    }
  } catch (err) {
    try {
      logger?.error("search.full_reindex_bookkeeping_failed", {
        error: describeError(err),
      });
    } catch {
      // Best-effort.
    }
    try {
      deps.reportError?.(err, {
        tags: { useCase: "runFullSearchReindex", op: "bookkeeping" },
      });
    } catch {
      // Best-effort.
    }
  }

  return { ...result, pendingCleared, formatVersionRecorded };
}

async function snapshotAllPending(
  repos: Repos,
): Promise<SearchReindexPendingSnapshot[]> {
  const out: SearchReindexPendingSnapshot[] = [];
  let cursor: SearchReindexPendingRow | undefined;
  for (;;) {
    const rows = await repos.searchReindexPending.listDue({
      limit: SNAPSHOT_PAGE,
      maxAttempts: ALL_ATTEMPTS,
      after: cursor
        ? {
            markedAt: cursor.markedAt,
            entityType: cursor.entityType,
            entityId: cursor.entityId,
          }
        : undefined,
    });
    for (const r of rows) {
      out.push({
        entityType: r.entityType,
        entityId: r.entityId,
        generation: r.generation,
      });
    }
    if (rows.length < SNAPSHOT_PAGE) return out;
    cursor = rows[rows.length - 1];
  }
}

/**
 * How long a claim blocks another `search.ensure-format` delivery (Pub/Sub
 * may redeliver while a rebuild is still running) before it can be retaken.
 * Well above a rebuild's duration; a crashed run's claim simply expires, and
 * the nightly run records the version regardless.
 */
export const FORMAT_REBUILD_CLAIM_TTL_MS = 60 * 60_000;

/** The jobs-service job that runs {@link ensureSearchIndexFormat}. */
export const SEARCH_ENSURE_FORMAT_JOB = "search.ensure-format";

export type EnsureSearchIndexFormatDeps = RunFullSearchReindexDeps;

export type EnsureSearchIndexFormatOutput =
  | { outcome: "current"; storedVersion: number; codeVersion: number }
  | { outcome: "claimed_elsewhere"; codeVersion: number }
  | ({ outcome: "rebuilt"; codeVersion: number } & RunFullSearchReindexOutput);

/**
 * Post-deploy format check (see module doc). A failure is logged, REPORTED
 * and rethrown (so the delivery is retried), after giving the claim back.
 */
export async function ensureSearchIndexFormat(
  deps: EnsureSearchIndexFormatDeps,
  input: { batchSize: number },
  opts: { version?: number; claimTtlMs?: number } = {},
): Promise<EnsureSearchIndexFormatOutput> {
  const version = opts.version ?? SEARCH_INDEX_FORMAT_VERSION;
  const ttl = opts.claimTtlMs ?? FORMAT_REBUILD_CLAIM_TTL_MS;
  const logger = deps.logger?.child({ useCase: "ensureSearchIndexFormat" });

  const state = await deps.repos.searchIndexState.get();
  const storedVersion = state?.formatVersion ?? 0;
  // Equal, or AHEAD: a newer revision already rebuilt; this (older) code must
  // not write its format over it.
  if (storedVersion >= version) {
    logger?.info("search.format_current", { storedVersion, version });
    return { outcome: "current", storedVersion, codeVersion: version };
  }

  const now = deps.clock.now();
  const claimed = await deps.repos.searchIndexState.claimFormatRebuild({
    version,
    now,
    staleBefore: new Date(now.getTime() - ttl),
  });
  if (!claimed) {
    logger?.info("search.format_rebuild_claimed_elsewhere", { version });
    return { outcome: "claimed_elsewhere", codeVersion: version };
  }

  logger?.info("search.format_rebuild_started", { version, storedVersion });
  try {
    const rebuilt = await runFullSearchReindex(deps, input);
    return { outcome: "rebuilt", codeVersion: version, ...rebuilt };
  } catch (err) {
    try {
      logger?.error("search.format_rebuild_failed", {
        version,
        error: describeError(err),
      });
    } catch {
      // Best-effort.
    }
    try {
      deps.reportError?.(err, {
        tags: { useCase: "ensureSearchIndexFormat", op: "formatRebuild" },
        extra: { version },
      });
    } catch {
      // Best-effort.
    }
    // Give the claim back so the retried delivery can take it at once. A
    // failed release is a deliberate swallow (the claim then just expires
    // after FORMAT_REBUILD_CLAIM_TTL_MS, delaying the retry) and is reported.
    try {
      await deps.repos.searchIndexState.releaseFormatRebuildClaim({ version });
    } catch (releaseErr) {
      try {
        logger?.error("search.format_rebuild_claim_release_failed", {
          version,
          error: describeError(releaseErr),
        });
      } catch {
        // Best-effort.
      }
      try {
        deps.reportError?.(releaseErr, {
          tags: {
            useCase: "ensureSearchIndexFormat",
            op: "releaseFormatRebuildClaim",
          },
          extra: { version },
        });
      } catch {
        // Best-effort: a throwing reporter must not mask the rebuild error.
      }
    }
    throw err;
  }
}

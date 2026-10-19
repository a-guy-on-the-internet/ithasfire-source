import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { SearchReindexPendingSnapshot } from "@th/ports/repos/search-reindex-pending";
import { describeError } from "../../lib/io";
import { buildSearchIndex } from "./build-search-index";
import {
  pendingRepoOf,
  toSearchReindexTarget,
  type SearchReindexSelector,
} from "./search-reindex-marks";

type Selector = SearchReindexSelector;

type ReindexDeps = {
  repos: Repos;
  search?: MultiSearchPort;
  /**
   * REQUIRED (FR-003), even though this helper never reads a price itself:
   * `buildSearchIndex` resolves every tier's EFFECTIVE price at the instant it
   * runs (FR-008), and defaulting the clock here would reintroduce a hidden
   * `Date.now()` on the one path that stamps prices into a cache — the exact
   * shape of read that R-001 is about. It is also load-bearing for tests: a
   * fire-and-forget reindex that read the wall clock could not be asserted
   * against a frozen instant.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. The reindex is fire-and-forget, so a
   * failure never reaches a tRPC/fastify backstop — without this the only trace
   * is a `logger.warn`, which is NOT captured by Sentry. Wire it at the call
   * site (from `ctx.reportError`) so a silent index-drift failure is visible.
   */
  reportError?: ReporterPort;
};

/**
 * Incrementally upsert a single entity into the search index after a
 * mutation. Best-effort: never blocks the caller, never throws.
 *
 * AFTER COMMIT of a write that marked the entity (`markForSearchReindex`, in
 * the write's transaction): on success it clears that mark with the
 * generation guard. Whatever it cannot clear stays for the scheduled drain
 * (`search.drain-reindex-pending`), which the committed mark itself asked for
 * (`withSearchReindexDrainScheduling`), and the nightly `search.full-reindex`
 * still reconciles any drift.
 *
 * Mirrors the pattern in `publishEvent` so every mutation site looks the
 * same and the indexing path is single-source.
 */
export function reindexAfterMutation(
  deps: ReindexDeps,
  useCaseName: string,
  selector: Selector,
): void {
  void runReindexAfterMutation(deps, useCaseName, selector);
}

/**
 * Read the entity's pending row BEFORE the reindex reads its source rows: the
 * generation it carries is the clear guard (see `SearchReindexPendingRepo`).
 * Best-effort: a failed read is reported and returns [] — the reindex still
 * runs, the mark simply stays for the drain.
 */
async function snapshotPending(
  deps: ReindexDeps,
  useCaseName: string,
  selector: Selector,
  logger: LoggerPort | undefined,
): Promise<SearchReindexPendingSnapshot[]> {
  // A structural test double without the repo has no marks to guard.
  const pending = pendingRepoOf(deps.repos);
  if (!pending) return [];
  try {
    const rows = await pending.getMany([toSearchReindexTarget(selector)]);
    return rows.map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
      generation: r.generation,
    }));
  } catch (err) {
    reportPendingFailure(deps, useCaseName, selector, logger, "snapshot", err);
    return [];
  }
}

/** Guarded clear after a successful reindex. Best-effort, reported. */
async function clearPending(
  deps: ReindexDeps,
  useCaseName: string,
  selector: Selector,
  logger: LoggerPort | undefined,
  snapshot: SearchReindexPendingSnapshot[],
): Promise<void> {
  const pending = pendingRepoOf(deps.repos);
  if (snapshot.length === 0 || !pending) return;
  try {
    await pending.clearIfUnchanged(snapshot);
  } catch (err) {
    reportPendingFailure(deps, useCaseName, selector, logger, "clear", err);
  }
}

function reportPendingFailure(
  deps: ReindexDeps,
  useCaseName: string,
  selector: Selector,
  logger: LoggerPort | undefined,
  step: "snapshot" | "clear",
  err: unknown,
): void {
  try {
    logger?.error(`${useCaseName}.search_reindex_pending_${step}_failed`, {
      kind: selector.kind,
      id: selector.id,
      error: describeError(err),
    });
  } catch {
    // Best-effort.
  }
  try {
    deps.reportError?.(err, {
      tags: { useCase: useCaseName, op: `searchReindexPending.${step}` },
      extra: { kind: selector.kind, id: selector.id },
    });
  } catch {
    // Best-effort: a throwing reporter must never surface.
  }
}

/**
 * The SAME work as {@link reindexAfterMutation}, with the promise handed back
 * instead of dropped. Identical behaviour and identical swallow/report
 * discipline — it IS the implementation; the void form is a one-line wrapper —
 * so there is nothing here to keep in sync.
 *
 * NEVER REJECTS in practice. Both branches of the chain below are terminal
 * handlers and every reporter call inside them is individually try/caught, so
 * an index failure cannot become a caller-visible one. The one unguarded path
 * is the `logger` calls themselves — a throwing logger would reject the
 * returned promise. Pino does not throw, and awaiting callers are expected to
 * keep a terminal `.catch` anyway, so this is a caveat rather than a hole.
 *
 * Exists for ONE shape: a caller with N entities to re-index that must not
 * dispatch all N at once. `reindexAfterMutation` returning void makes
 * back-pressure impossible — the only way to pace the fan-out is to await
 * actual completion — and the alternative (a caller reaching past this file to
 * `buildSearchIndex` directly) is how the incremental path's `reportError`
 * went dead once already. Await this in bounded chunks instead; keep the whole
 * loop off the request path yourself.
 */
export function runReindexAfterMutation(
  deps: ReindexDeps,
  useCaseName: string,
  selector: Selector,
): Promise<void> {
  if (!deps.search) return Promise.resolve();
  const search = deps.search;
  const logger = deps.logger?.child({ useCase: useCaseName });

  const input =
    selector.kind === "event"
      ? { eventIds: [selector.id] }
      : selector.kind === "human"
        ? { humanIds: [selector.id] }
        : selector.kind === "place"
          ? { placeIds: [selector.id] }
          : { organizationIds: [selector.id] };

  let snapshot: SearchReindexPendingSnapshot[] = [];
  return snapshotPending(deps, useCaseName, selector, logger)
    .then((taken) => {
      snapshot = taken;
      return buildSearchIndex(
        {
          repos: deps.repos,
          search,
          clock: deps.clock,
          logger,
          // MUST be forwarded. `buildSearchIndex` has its own deliberate swallows
          // (the EntityPage read that supplies a place's `pageSlug` and an owner's
          // bio) which report through `deps.reportError`. Omitting it here left
          // that reporting dead on the ENTIRE incremental path — every
          // mutation-driven reindex — so a blip during a venue's post-save
          // reindex silently wrote `pageSlug: null`, dropping that venue to the
          // `/places/id/{uuid}` fallback until the nightly full reindex, with
          // nothing in Sentry. The nightly job (apps/jobs/src/jobs/search.ts)
          // was already wired; this path was not.
          reportError: deps.reportError,
        },
        input,
      );
    })
    .then(
      async (result) => {
        if (result.errors.length > 0) {
          // A per-id read/index failure (e.g. a transient getById blip) resolves
          // the promise but SKIPS the upsert-or-remove for that id — so a
          // cancelled event can silently linger on the search-served embed until
          // the nightly reconcile. Escalate to error + reportError so it's
          // Sentry-visible, not just an info line (the rejection branch below
          // only covers a whole-batch failure, never a per-id one).
          logger?.error(`${useCaseName}.search_index_partial_failure`, {
            kind: selector.kind,
            id: selector.id,
            errors: result.errors.length,
          });
          try {
            deps.reportError?.(
              new Error(
                `reindexAfterMutation: ${result.errors.length} per-id error(s)`,
              ),
              {
                tags: { useCase: useCaseName, op: "reindexAfterMutation" },
                extra: {
                  kind: selector.kind,
                  id: selector.id,
                  errors: result.errors,
                },
              },
            );
          } catch {
            // Reporting is best-effort — a throwing reporter must never turn the
            // graceful fire-and-forget swallow into an unhandled rejection.
          }
          return;
        }
        logger?.info(`${useCaseName}.search_indexed`, {
          kind: selector.kind,
          id: selector.id,
          errors: result.errors.length,
        });
        // The document now reflects everything committed before the snapshot
        // was read; drop the mark unless a newer edit re-marked it since.
        await clearPending(deps, useCaseName, selector, logger, snapshot);
      },
      (err) => {
        logger?.warn(`${useCaseName}.search_index_failed`, {
          kind: selector.kind,
          id: selector.id,
          error: describeError(err),
        });
        try {
          deps.reportError?.(err, {
            tags: { useCase: useCaseName, op: "reindexAfterMutation" },
            extra: { kind: selector.kind, id: selector.id },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never turn the
          // graceful fire-and-forget swallow into an unhandled rejection.
        }
      },
    );
}

export type ReindexAllPublishedEventsDeps = Omit<
  ReindexDeps,
  "search" | "reportError"
> & {
  /** Required here (unlike `reindexAfterMutation`): a caller that reindexes
   *  the whole corpus is doing it deliberately, so a missing port is a wiring
   *  bug, not a "search is off" no-op. */
  search: MultiSearchPort;
};

export type ReindexAllPublishedEventsResult = {
  /** Events successfully written to the index. Excludes per-id failures. */
  indexed: number;
  /** Events enumerated from `listPublished` across all pages. */
  enumerated: number;
  /**
   * PER-ID failures collected across every page. `buildSearchIndex` RESOLVES
   * with these rather than rejecting (a `getById` blip skips one event's
   * upsert), so a caller that ignores this array reports success while some
   * events keep serving a stale price.
   */
  errors: Array<{ id: string; error: string }>;
};

/**
 * Reindex EVERY published event after a platform-wide pricing change (a GLOBAL
 * fee-policy change), which alters the fee-inclusive buyer total on any event
 * whose price resolves through the global policy. Non-destructive: paginates
 * published events and upserts them in batches via `buildSearchIndex` (no
 * index clear), so search never goes empty mid-run.
 *
 * AWAITABLE, on purpose. The only caller is the deploy-time reconciler
 * `apps/api/src/scripts/reference-data/seed-platform-fee-policy.ts`, a short-lived process: a
 * fire-and-forget variant would be cut off when the script exits.
 *
 * TWO DISTINCT FAILURE MODES, and both must reach the caller:
 *  - WHOLE-BATCH failure (search backend down, `listPublished` throws) →
 *    THROWS. Nothing was indexed and continuing is pointless.
 *  - PER-ID failure (one event's `getById` blips) → `buildSearchIndex` still
 *    RESOLVES, with the failure in `result.errors`. Those are accumulated into
 *    {@link ReindexAllPublishedEventsResult.errors} and NOT swallowed: the
 *    caller must treat a non-empty array as a failure, or a fee change ships
 *    with a handful of events quietly serving the old price until the nightly
 *    reconcile. (`reindexAfterMutation` escalates the same case to
 *    `reportError` — same hazard, different reporting channel.)
 */
export async function reindexAllPublishedEvents(
  deps: ReindexAllPublishedEventsDeps,
): Promise<ReindexAllPublishedEventsResult> {
  const { search } = deps;
  const logger = deps.logger?.child({ op: "reindexAllPublishedEvents" });
  const batchSize = 200;

  let offset = 0;
  let enumerated = 0;
  let indexed = 0;
  const errors: ReindexAllPublishedEventsResult["errors"] = [];

  for (;;) {
    const page = await deps.repos.events.listPublished({
      limit: batchSize,
      offset,
    });
    if (page.items.length === 0) break;
    const result = await buildSearchIndex(
      { repos: deps.repos, search, clock: deps.clock, logger },
      { eventIds: page.items.map((event) => event.id) },
    );
    indexed += result.eventsIndexed;
    for (const err of result.errors) {
      errors.push({ id: err.id, error: err.error });
    }
    enumerated += page.items.length;
    if (page.items.length < batchSize) break;
    offset += batchSize;
  }

  if (errors.length > 0) {
    logger?.error("all_events_reindex_partial_failure", {
      enumerated,
      indexed,
      errors: errors.length,
    });
  } else {
    logger?.info("all_events_reindexed", { enumerated, indexed });
  }

  return { indexed, enumerated, errors };
}

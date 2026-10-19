import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { describeError } from "../../lib/io";
import type { TaxRateCacheTarget } from "../events/_shared/resolve-event-tax-rate";
import { runReindexAfterMutation } from "../search/reindex-after-mutation";
import {
  markForSearchReindex,
  pendingRepoOf,
} from "../search/search-reindex-marks";

/**
 * Most events one cache fill re-indexes. A venue's unstamped upcoming events
 * are normally a handful; anything past this waits for the nightly
 * `search.full-reindex`, which recomputes every all-in total anyway.
 */
export const TAX_LOCATION_REINDEX_LIMIT = 200;

/**
 * Single-event index passes in flight at once (each one is an index-write
 * fence transaction on the live pool) — the same pacing `upsertPlace` uses
 * for its re-projected events.
 */
const REINDEX_CONCURRENCY = 2;

export type ReindexEventsAtTaxLocationDeps = {
  /** The full repos bag (never a transaction): this runs after commit. */
  repos: Repos;
  /**
   * Present = an immediate reindex attempt after the marks commit. Absent =
   * marks only; the scheduled drain (`search.drain-reindex-pending`) or the
   * nightly full reindex picks them up.
   */
  search?: MultiSearchPort;
  /** Defaults to the fill's own instant (`opts.now`). */
  clock?: ClockPort;
  logger?: LoggerPort;
  /**
   * REQUIRED in practice (optional only for test doubles): this is a
   * fire-and-forget loop with no backstop above it, so a failure reaches
   * Sentry only through here.
   */
  reportError?: ReporterPort;
};

/**
 * After a venue's tax-rate cache was FILLED (by publish, checkout, a quote or
 * the background fill job), refresh the search documents of the venue's
 * other published upcoming events that have no stamped rate of their own:
 * their stored all-in total was computed without a rate ("See details") and
 * can now be priced.
 *
 * FIRE-AND-FORGET, never throws, never blocks the caller: call it AFTER the
 * transaction that filled the cache has committed, never inside one. Two
 * steps, the same pair every search write uses (`search-reindex-marks.ts`):
 *
 *  1. MARK the events in `SearchReindexPending` (one short transaction of its
 *     own), so the refresh survives this process — the repos' drain
 *     scheduling asks for a `search.drain-reindex-pending` run after commit;
 *  2. when a search port is present, an immediate, paced reindex of each
 *     (`runReindexAfterMutation`, which clears the marks it served).
 *
 * `alsoEventIds` covers events the listing query no longer returns: the
 * checkout that filled the cache also STAMPED its own event, so it is no
 * longer "unstamped", but its document still says "See details".
 *
 * Any failure is logged at `error` and reported (each guarded so a throwing
 * logger / reporter changes nothing).
 */
export function reindexEventsAtTaxLocation(
  deps: ReindexEventsAtTaxLocationDeps,
  target: TaxRateCacheTarget,
  opts: { now: Date; useCase: string; alsoEventIds?: readonly string[] },
): void {
  void runReindexEventsAtTaxLocation(deps, target, opts);
}

/**
 * {@link reindexEventsAtTaxLocation} with the promise handed back, for a
 * caller that must await it (a jobs handler: work left running after the
 * response is starved of CPU on Cloud Run). Never rejects.
 */
export async function runReindexEventsAtTaxLocation(
  deps: ReindexEventsAtTaxLocationDeps,
  target: TaxRateCacheTarget,
  opts: { now: Date; useCase: string; alsoEventIds?: readonly string[] },
): Promise<{ eventIds: string[] }> {
  const targetRef =
    target.kind === "place"
      ? { kind: "place" as const, id: target.placeId }
      : { kind: "saved-location" as const, id: target.savedLocationId };
  let eventIds: string[] = [];
  try {
    const listed = await deps.repos.events.listUnstampedUpcomingIdsAtTaxLocation(
      {
        target:
          target.kind === "place"
            ? { kind: "place", placeId: target.placeId }
            : { kind: "saved-location", savedLocationId: target.savedLocationId },
        now: opts.now,
        limit: TAX_LOCATION_REINDEX_LIMIT,
      },
    );
    eventIds = [...new Set([...(opts.alsoEventIds ?? []), ...listed])];
    if (eventIds.length === 0) return { eventIds };

    const selectors = eventIds.map((id) => ({ kind: "event" as const, id }));
    // A structural test double without the pending repo has nothing to mark.
    if (pendingRepoOf(deps.repos)) {
      await deps.repos.tx((tx) => markForSearchReindex(tx, selectors, opts.now));
    }

    if (deps.search) {
      const reindexDeps = {
        repos: deps.repos,
        search: deps.search,
        clock: deps.clock ?? { now: () => opts.now },
        logger: deps.logger,
        reportError: deps.reportError,
      };
      // Collect-and-rethrow, as `upsertPlace`'s fan-out: one event's failure
      // never abandons the rest, and the first one is reported below.
      const failures: unknown[] = [];
      for (let i = 0; i < eventIds.length; i += REINDEX_CONCURRENCY) {
        const settled = await Promise.allSettled(
          eventIds
            .slice(i, i + REINDEX_CONCURRENCY)
            .map((id) =>
              runReindexAfterMutation(reindexDeps, opts.useCase, {
                kind: "event",
                id,
              }),
            ),
        );
        for (const outcome of settled) {
          if (outcome.status === "rejected") failures.push(outcome.reason);
        }
      }
      if (failures.length > 0) throw failures[0];
    }

    deps.logger?.info("tax.location_events_reindexed", {
      useCase: opts.useCase,
      target: targetRef,
      eventCount: eventIds.length,
    });
    return { eventIds };
  } catch (err) {
    try {
      deps.logger?.error("tax.location_events_reindex_failed", {
        useCase: opts.useCase,
        target: targetRef,
        eventCount: eventIds.length,
        error: describeError(err),
      });
    } catch {
      // Best-effort.
    }
    try {
      deps.reportError?.(err, {
        tags: { useCase: opts.useCase, op: "reindexEventsAtTaxLocation" },
        extra: { target: targetRef, eventCount: eventIds.length },
      });
    } catch {
      // Best-effort: a throwing reporter must never surface.
    }
    return { eventIds };
  }
}

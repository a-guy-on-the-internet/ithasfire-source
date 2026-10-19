/**
 * FR-008 / Q-001 (RESOLVED) — search-index freshness for scheduled price flips.
 *
 * THE PROBLEM. `build-search-index` materialises `minPaidPriceCents` (and the
 * fee-inclusive `lowestBuyerTotalCents`) onto each event's search document. A
 * scheduled price change (FR-005) is evaluated at READ TIME against the clock,
 * so when the flip moment arrives NOTHING is written to any row — no mutation
 * fires, no reindex is triggered, and the index keeps serving the pre-flip
 * price indefinitely. That is the one genuine cost of read-time evaluation, and
 * the spec required it be answered rather than discovered in production.
 *
 * THE ANSWER, per Q-001. The index stores the CURRENT effective price (resolved
 * through `resolveUnitPriceCents` at index time — see `BuildSearchIndexDeps`),
 * and this scan re-indexes events whose flip has just crossed. Indexing the
 * post-flip price EARLY was rejected: search would advertise a price that is
 * not yet purchasable, which is the same quote-one-charge-another failure in a
 * different surface.
 *
 * WHY THIS IS NOT AN NFR-002 VIOLATION. NFR-002 forbids a job from flipping a
 * price or making a tier purchasable. Nothing here does either: the price is
 * still resolved at read time by every surface that takes money, and this job
 * cannot change what a buyer is charged even if it never runs. It refreshes a
 * DERIVED CACHE — a side effect, which is exactly what apps/jobs is for.
 *
 * ── DEVIATION FROM THE SPEC'S WORDING, STATED PLAINLY ──────────────────────
 * Q-001 says "enqueue a re-index job scheduled for scheduledPriceAt". That
 * mechanism DOES NOT EXIST in this codebase and cannot be built without new
 * infrastructure: the queue in `jobs.manifest.json` is Google Pub/Sub, which
 * has no delayed delivery, and `JobQueuePort.delayMs` has exactly one
 * implementation — the in-memory adapter used by tests. There is no durable
 * timer service to enqueue against.
 *
 * So this follows the shipped precedent Q-001 itself names,
 * `events.address-reveal-notify`, which is a SCHEDULED SCAN over a lookback
 * window rather than a per-row enqueue. That is not a compromise; for this
 * problem it is strictly better:
 *
 *   - A delayed enqueue that is dropped (worker crash, queue purge, redeploy)
 *     is lost forever, and nothing ever notices. A window scan self-heals: the
 *     next tick after an outage still sees every flip inside the lookback.
 *     Cron drift, the exact hazard the address-reveal job documents, is
 *     absorbed rather than amplified.
 *   - No enqueue means no write coupling: a schedule can be created, edited or
 *     cleared without the write path having to keep a pending timer in sync.
 *     `updateTicketType` already reindexes on edit (so an edited schedule is
 *     picked up immediately); this scan only has to cover the moment nobody
 *     writes anything.
 *   - It needs no new column. A cursor stamp would be a schema change, and
 *     re-indexing is naturally idempotent — the document is rewritten from the
 *     source rows every time — so repeated coverage inside the window is
 *     wasted work, never a wrong result.
 *
 * IF THIS JOB NEVER RUNS: browse/search cards keep showing the PRE-FLIP price
 * ("from $12" after the price became $20) until something else reindexes the
 * event — any ticket-type edit, or the nightly `search.full-reindex`. Checkout,
 * the public ticket list, the POS and every embed resolve at read time and
 * charge correctly regardless. The degradation is a stale browse card, never a
 * mispriced sale. It is also self-limiting: the nightly full reindex bounds
 * staleness at ~24h even with this job disabled entirely.
 */
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { buildSearchIndex } from "./build-search-index";

/**
 * Default lookback when the caller supplies no explicit window.
 *
 * Deliberately MUCH wider than the tick interval so a few hours of cron outage
 * cannot silently skip a flip — the same reasoning (and the same trade) as
 * `DEFAULT_WINDOW_LOOKBACK_MS` on the address-reveal scan. The cost of the
 * overlap is bounded and harmless: an event flipping inside the window is
 * re-indexed once per tick until it falls out, which rewrites an identical
 * document.
 */
export const DEFAULT_FLIP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Rows fetched per cursor page. NOT a cap on the run — the scan pages until the
 * window is exhausted (see `DEFAULT_MAX_EVENTS`).
 */
export const SCAN_PAGE_SIZE = 500;

/**
 * ABSOLUTE safety bound on events re-indexed in one run.
 *
 * This is a circuit breaker, not a page size. It exists so a pathological window
 * (a bad backfill, a data bug) cannot turn one tick into an unbounded reindex of
 * the whole platform — but if it ever binds, the run is INCOMPLETE and the
 * remainder is not re-indexed by this job. That is reported loudly rather than
 * silently truncated: see `reportError` on the deps.
 */
export const DEFAULT_MAX_EVENTS = 5_000;

export const reindexScheduledPriceFlipsInputSchema = z
  .object({
    /**
     * Explicit window start (exclusive), for backfills. Defaults to
     * `windowEnd - DEFAULT_FLIP_LOOKBACK_MS`.
     */
    windowStartIso: z.string().datetime({ offset: true }).optional(),
    /**
     * Explicit window end (inclusive). Defaults to `clock.now()`, and is
     * CLAMPED to `clock.now()` either way — a future end would re-index events
     * whose flip has NOT happened yet, stamping the index with the pre-flip
     * price again for no reason (and, if the resolver were ever consulted with
     * that future instant, would advertise a price nobody can buy).
     */
    windowEndIso: z.string().datetime({ offset: true }).optional(),
    /** Absolute circuit breaker on events re-indexed in one run. */
    maxEvents: z.number().int().min(1).max(50_000).default(DEFAULT_MAX_EVENTS),
  })
  .strict();
// NOTE: start-before-end is NOT validated here. It is enforced AFTER the clamp
// in the use case, because the clamp can itself invert an otherwise-valid
// request: a backfill asking for (T+1h, T+2h] while `now` is T has its end
// clamped back to T, leaving start > end. Validating the REQUESTED values would
// wave that through and return zero rows — indistinguishable from "nothing
// flipped", which is the worst possible way for a backfill to fail.

export type ReindexScheduledPriceFlipsInput = z.infer<
  typeof reindexScheduledPriceFlipsInputSchema
>;

export const reindexScheduledPriceFlipsOutputSchema = z
  .object({
    /** Events whose flip crossed inside the window. */
    eventsFound: z.number().int().nonnegative(),
    /** Documents the indexer reported as written. */
    eventsIndexed: z.number().int().nonnegative(),
    /** Per-event indexing failures reported by `buildSearchIndex`. */
    errors: z.number().int().nonnegative(),
    /**
     * TRUE when the run stopped at `maxEvents` with the window not exhausted —
     * i.e. this refresh is INCOMPLETE and some events are still serving a stale
     * price. Surfaced in the output (not just the log) so the job's own return
     * value carries the bad news.
     */
    capReached: z.boolean(),
    /** Cursor pages fetched. Useful for spotting a pathological window. */
    pagesScanned: z.number().int().nonnegative(),
    windowStartIso: z.string(),
    windowEndIso: z.string(),
  })
  .strict();

export type ReindexScheduledPriceFlipsOutput = z.infer<
  typeof reindexScheduledPriceFlipsOutputSchema
>;

export type ReindexScheduledPriceFlipsDeps = {
  repos: Repos;
  search: MultiSearchPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the two conditions this job can hit that are
   * INVISIBLE by construction otherwise:
   *
   *   1. the absolute `maxEvents` circuit breaker binding, which leaves part of
   *      the window un-refreshed;
   *   2. `buildSearchIndex` reporting per-event errors, which it returns rather
   *      than throwing — so no fastify/tRPC backstop ever sees them.
   *
   * Neither throws, so without this the only trace is a log line. Guarded so a
   * throwing reporter can never change the job's behaviour.
   */
  reportError?: ReporterPort;
};

export async function reindexScheduledPriceFlips(
  deps: ReindexScheduledPriceFlipsDeps,
  rawInput: unknown,
): Promise<ReindexScheduledPriceFlipsOutput> {
  const input = parseInput(reindexScheduledPriceFlipsInputSchema, rawInput);

  const now = deps.clock.now();

  // Clamp the end to `now` — never index a flip that has not happened.
  const requestedEnd = input.windowEndIso ? new Date(input.windowEndIso) : now;
  const windowEnd = requestedEnd.getTime() > now.getTime() ? now : requestedEnd;

  const windowStart = input.windowStartIso
    ? new Date(input.windowStartIso)
    : new Date(windowEnd.getTime() - DEFAULT_FLIP_LOOKBACK_MS);

  // Validated AFTER the clamp — see the note on the input schema. An inverted
  // window is a caller error that must be loud, not a silent zero-row run that
  // reads exactly like "nothing flipped".
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw fail("INVALID_INPUT", {
      meta: {
        reason: "window_start_not_before_end",
        windowStartIso: windowStart.toISOString(),
        windowEndIso: windowEnd.toISOString(),
        // Named explicitly so a backfill operator can see that the CLAMP, not
        // their input, is what inverted the window.
        clampedToNow: requestedEnd.getTime() > now.getTime(),
      },
    });
  }

  // ── Page the whole window ──────────────────────────────────────────────────
  // Cursor pagination, NOT a single capped query. A capped query with a stable
  // `ORDER BY eventId` would return the SAME first N events on every tick for
  // the whole lookback, so anything past N would never be re-indexed by this
  // job at all — it would heal only at the nightly full reindex. A coordinated
  // on-sale or a platform-wide early-bird deadline is enough to trigger that.
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pagesScanned = 0;
  let capReached = false;

  for (;;) {
    const page: string[] =
      await deps.repos.events.listEventIdsWithScheduledPriceFlipBetween({
        windowStart,
        windowEnd,
        limit: SCAN_PAGE_SIZE,
        afterEventId: cursor,
      });

    pagesScanned += 1;

    for (const eventId of page) seen.add(eventId);

    // The repo returns ROWS (one per matching ticket type), deliberately not
    // DISTINCT — so a short page, not a short DEDUPED page, means exhausted.
    if (page.length < SCAN_PAGE_SIZE) break;

    cursor = page[page.length - 1] ?? null;
    if (cursor == null) break;

    if (seen.size >= input.maxEvents) {
      capReached = true;
      break;
    }
  }

  const eventIds = [...seen].slice(0, input.maxEvents);

  if (capReached) {
    // A truncated refresh leaves events serving a price nobody can buy, and
    // NOTHING else in the system notices — this job returns normally and the
    // next tick truncates identically. `logger.error` IS captured by Sentry via
    // pinoIntegration; `reportError` adds the tagged event. `warn` would be
    // invisible, which is the failure mode this whole guard exists to avoid.
    const message =
      "search.reindex_scheduled_price_flips: maxEvents cap reached — " +
      "refresh is INCOMPLETE, some events are serving a stale indexed price";
    deps.logger?.error(message, {
      maxEvents: input.maxEvents,
      eventsFound: eventIds.length,
      pagesScanned,
      windowStartIso: windowStart.toISOString(),
      windowEndIso: windowEnd.toISOString(),
    });
    try {
      deps.reportError?.(new Error(message), {
        tags: { job: "search.reindex-scheduled-price-flips" },
        extra: {
          maxEvents: input.maxEvents,
          eventsFound: eventIds.length,
          pagesScanned,
          windowStartIso: windowStart.toISOString(),
          windowEndIso: windowEnd.toISOString(),
        },
      });
    } catch {
      // A throwing reporter must never change this job's behaviour.
    }
  }

  if (eventIds.length === 0) {
    return reindexScheduledPriceFlipsOutputSchema.parse({
      eventsFound: 0,
      eventsIndexed: 0,
      errors: 0,
      capReached,
      pagesScanned,
      windowStartIso: windowStart.toISOString(),
      windowEndIso: windowEnd.toISOString(),
    });
  }

  // Re-index through the ONE indexer, which re-reads the rows and resolves
  // every price at its own `clock.now()`. This function deliberately does not
  // compute or pass a price: it decides WHICH events are stale, never WHAT
  // they cost.
  const result = await buildSearchIndex(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
    },
    { eventIds },
  );

  if (result.errors.length > 0) {
    // `buildSearchIndex` RETURNS per-event failures rather than throwing, so
    // without this they reach no backstop at all.
    const message =
      "search.reindex_scheduled_price_flips: per-event indexing failures";
    deps.logger?.error(message, {
      errorCount: result.errors.length,
      errors: result.errors.slice(0, 10),
    });
    try {
      deps.reportError?.(new Error(message), {
        tags: { job: "search.reindex-scheduled-price-flips" },
        extra: { errors: result.errors.slice(0, 10) },
      });
    } catch {
      // Never let the reporter change behaviour.
    }
  }

  deps.logger?.info("search.reindex_scheduled_price_flips.completed", {
    eventsFound: eventIds.length,
    eventsIndexed: result.eventsIndexed,
    errors: result.errors.length,
    capReached,
    pagesScanned,
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
  });

  return reindexScheduledPriceFlipsOutputSchema.parse({
    eventsFound: eventIds.length,
    eventsIndexed: result.eventsIndexed,
    errors: result.errors.length,
    capReached,
    pagesScanned,
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
  });
}

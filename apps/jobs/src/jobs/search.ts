/**
 * Search Jobs
 *
 * Background work for search index maintenance.
 */
import { z } from "zod";
import {
  defineJob,
  defineScheduledTask,
  type JobContext,
} from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { reportNotConfiguredOnce } from "../lib/report-not-configured";
import {
  buildSearchIndex,
  drainSearchReindexPending,
  drainSearchReindexPendingInputSchema,
  ensureSearchIndexFormat,
  reindexScheduledPriceFlips,
  reindexScheduledPriceFlipsInputSchema,
  runFullSearchReindex,
} from "@th/core/use-cases/search";

/**
 * The four by-id jobs below are each asked for ONE document, and
 * `buildSearchIndex` only RETURNS a by-id failure in `result.errors`: it
 * reports nothing on that path and leaves the escalation to its caller.
 *
 * THROW, never return `{ success: false }`: app.ts answers 200 for any
 * returned value, so only a throw makes the run fail and show. The write is
 * an upsert-or-remove rebuilt from source rows, so running it again is safe.
 * Nothing retries these jobs on its own (they run from /platform/jobs and
 * from a DLQ rerun, one request each); wire one to a trigger that retries a
 * non-2xx without a bound and this throw has to be looked at again. One such
 * trigger is dormant: each job's manifest `queue` topic has a push
 * subscription (`jobs_push` in `infra/terraform/generated-jobs.tf`) with no
 * retry or dead-letter policy, aimed at a `/pubsub/push` route this app no
 * longer has. Bring that route back and a document that keeps failing is
 * redelivered for the whole retention period.
 *
 * The log line carries the id and counts only. The thrown message adds the
 * first failure's reason (an error message, never a document), capped.
 */
function throwIfIndexFailed(
  ctx: JobContext,
  failure: {
    job: string;
    log: string;
    id: Record<string, string>;
    indexed: number;
    errors: ReadonlyArray<{ error: string }>;
  },
): void {
  const first = failure.errors[0];
  if (!first) return;
  ctx.logger.error(failure.log, {
    ...failure.id,
    indexed: failure.indexed,
    errors: failure.errors.length,
  });
  throw new Error(
    `${failure.job}: ${failure.errors.length} document(s) failed to index: ${first.error.slice(0, 300)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// search.index-event - Index a single event
// ─────────────────────────────────────────────────────────────────────────────
export const indexEvent = defineJob({
  name: "search.index-event",
  description: "Index a single event into the selected search backend.",
  input: z.object({
    eventId: z.string().uuid(),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.index_event_skipped", {
        eventId: input.eventId,
        reason: "MultiSearchPort not configured",
      });
      // A warn does not reach Sentry (CLAUDE.md), and app.ts answers 200 for
      // this return, so without the report a cleared search config is a
      // silent no-op. Once per process per job; same call in every job below.
      reportNotConfiguredOnce(ctx, {
        job: "search.index-event",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_event_started", { eventId: input.eventId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue-confirmation place-lookup swallow (address-only degrade) must
        // reach Sentry — ReporterPort convention.
        reportError: ctx.reportError,
      },
      { eventIds: [input.eventId] },
    );

    throwIfIndexFailed(ctx, {
      job: "search.index-event",
      log: "search.index_event_failed",
      id: { eventId: input.eventId },
      indexed: result.eventsIndexed,
      errors: result.errors,
    });

    ctx.logger.info("search.index_event_completed", {
      eventId: input.eventId,
      indexed: result.eventsIndexed,
      errors: result.errors.length,
    });

    return { success: true, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.index-human - Index a single human/profile
// ─────────────────────────────────────────────────────────────────────────────
export const indexHuman = defineJob({
  name: "search.index-human",
  description: "Index a single human/profile into the selected search backend.",
  input: z.object({
    humanId: z.string().uuid(),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.index_human_skipped", {
        humanId: input.humanId,
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.index-human",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_human_started", { humanId: input.humanId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue-confirmation place-lookup swallow (address-only degrade) must
        // reach Sentry — ReporterPort convention.
        reportError: ctx.reportError,
      },
      { humanIds: [input.humanId] },
    );

    throwIfIndexFailed(ctx, {
      job: "search.index-human",
      log: "search.index_human_failed",
      id: { humanId: input.humanId },
      indexed: result.humansIndexed,
      errors: result.errors,
    });

    ctx.logger.info("search.index_human_completed", {
      humanId: input.humanId,
      indexed: result.humansIndexed,
      errors: result.errors.length,
    });

    return { success: true, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.index-place - Index a single place/venue
// ─────────────────────────────────────────────────────────────────────────────
export const indexPlace = defineJob({
  name: "search.index-place",
  description: "Index a single place/venue into the selected search backend.",
  input: z.object({
    placeId: z.string().uuid(),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.index_place_skipped", {
        placeId: input.placeId,
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.index-place",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_place_started", { placeId: input.placeId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue-confirmation place-lookup swallow (address-only degrade) must
        // reach Sentry — ReporterPort convention.
        reportError: ctx.reportError,
      },
      { placeIds: [input.placeId] },
    );

    throwIfIndexFailed(ctx, {
      job: "search.index-place",
      log: "search.index_place_failed",
      id: { placeId: input.placeId },
      indexed: result.placesIndexed,
      errors: result.errors,
    });

    ctx.logger.info("search.index_place_completed", {
      placeId: input.placeId,
      indexed: result.placesIndexed,
      errors: result.errors.length,
    });

    return { success: true, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.index-organization - Index a single organization
// ─────────────────────────────────────────────────────────────────────────────
export const indexOrganization = defineJob({
  name: "search.index-organization",
  description: "Index a single organization into the selected search backend.",
  input: z.object({
    organizationId: z.string().uuid(),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.index_organization_skipped", {
        organizationId: input.organizationId,
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.index-organization",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_organization_started", {
      organizationId: input.organizationId,
    });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue-confirmation place-lookup swallow (address-only degrade) must
        // reach Sentry — ReporterPort convention.
        reportError: ctx.reportError,
      },
      { organizationIds: [input.organizationId] },
    );

    throwIfIndexFailed(ctx, {
      job: "search.index-organization",
      log: "search.index_organization_failed",
      id: { organizationId: input.organizationId },
      indexed: result.organizationsIndexed,
      errors: result.errors,
    });

    ctx.logger.info("search.index_organization_completed", {
      organizationId: input.organizationId,
      indexed: result.organizationsIndexed,
      errors: result.errors.length,
    });

    return { success: true, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.full-reindex - Rebuild entire search index (also runs nightly)
//
// NON-DESTRUCTIVE (upsert + per-type sweep), so a run cut short leaves the
// index serving, never empty. HEADROOM, measured 2026-09-30 on a clone of the
// local dev database (48 events, 23 humans, 17 places, 6 orgs = 94 docs):
// 2.5–5.8s per run, i.e. ~27–60 ms per document on a loaded laptop. The jobs
// service runs on Cloud Run's default 300s request timeout, so one request
// fits roughly 3,000+ documents at that rate. Past that, this needs a time
// budget and a resumable cursor re-enqueued as a continuation; a run that is
// cut off before then still records nothing and sweeps nothing it did not
// reach, and the next run retries.
// ─────────────────────────────────────────────────────────────────────────────
export const fullReindex = defineScheduledTask({
  schedule: getSchedule("search.full-reindex"),
  name: "search.full-reindex",
  description:
    "Rebuild the selected search backend index (events, humans, places, organizations) from scratch.",
  notify: true,
  input: z.object({
    // Capped by buildSearchIndex (MAX_INDEX_BATCH_SIZE): one page = one fence transaction.
    batchSize: z.number().int().min(1).max(200).default(100),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.full_reindex_skipped", {
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.full-reindex",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.full_reindex_started", {
      batchSize: input.batchSize,
    });

    // `buildSearchIndex({ fullReindex })` plus the edit-triggered reindex's
    // bookkeeping: clears the SearchReindexPending rows of the types it fully
    // refreshed (rewritten AND swept) and, when no page failed as a whole,
    // records this build's SEARCH_INDEX_FORMAT_VERSION (what
    // `search.ensure-format` compares against after a deploy).
    const result = await runFullSearchReindex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue-confirmation place-lookup swallow (address-only degrade) must
        // reach Sentry — ReporterPort convention.
        reportError: ctx.reportError,
      },
      { batchSize: input.batchSize },
    );

    ctx.logger.info("search.full_reindex_completed", {
      eventsIndexed: result.eventsIndexed,
      humansIndexed: result.humansIndexed,
      placesIndexed: result.placesIndexed,
      organizationsIndexed: result.organizationsIndexed,
      errorCount: result.errors.length,
      pendingCleared: result.pendingCleared,
      formatVersionRecorded: result.formatVersionRecorded,
    });

    return { success: result.errors.length === 0, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.ensure-format — the post-deploy search index format check.
//
// Fired ONCE per deploy by the workflow (a Pub/Sub publish after the jobs
// service has rolled; the push subscription POSTs this route). The code that
// compares SEARCH_INDEX_FORMAT_VERSION is the same code that rebuilds, so an
// older revision still serving the request sees "stored >= mine" and does
// nothing. Behind → claim (a redelivery during the rebuild finds the claim
// and returns), NON-DESTRUCTIVE full reindex, record the version. A missed
// trigger self-heals at the nightly run, which records the version too.
// ─────────────────────────────────────────────────────────────────────────────
export const ensureFormat = defineJob({
  name: "search.ensure-format",
  description:
    "Post-deploy: if the stored search index format version is behind this build's SEARCH_INDEX_FORMAT_VERSION, claim, run the non-destructive full reindex and record the version. No-op when current or ahead. Triggered by the deploy workflow, never by cron.",
  input: z
    .object({
      batchSize: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.ensure_format_skipped", {
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.ensure-format",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }
    const result = await ensureSearchIndexFormat(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      { batchSize: input.batchSize },
    );
    ctx.logger.info("search.ensure_format_completed", {
      outcome: result.outcome,
      codeVersion: result.codeVersion,
      ...(result.outcome === "rebuilt"
        ? {
            eventsIndexed: result.eventsIndexed,
            errorCount: result.errors.length,
            formatVersionRecorded: result.formatVersionRecorded,
          }
        : {}),
    });
    return {
      success: result.outcome !== "rebuilt" || result.errors.length === 0,
      outcome: result.outcome,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.drain-reindex-pending — the scheduled half of the edit-triggered,
// batched reindex (core `search/search-reindex-marks.ts`).
//
// NOT a cron job, on purpose: nothing may wake the database when nobody is
// editing. It runs only when a write that marked an entity asked the delayed
// scheduler for a run (one per time slot), or when a previous drain left rows
// behind and rescheduled itself with backoff. An empty list ends the chain.
// ─────────────────────────────────────────────────────────────────────────────
export const drainReindexPending = defineJob({
  name: "search.drain-reindex-pending",
  description:
    "Reindex the entities marked in SearchReindexPending by recent edits, clear the ones refreshed, and reschedule (with backoff) only while rows remain. Triggered by edits via the delayed scheduler; never on a timer.",
  input: drainSearchReindexPendingInputSchema,
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.drain_reindex_pending_skipped", {
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.drain-reindex-pending",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    const result = await drainSearchReindexPending(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // Per-row failures are swallowed (kept for a later run): ReporterPort.
        reportError: ctx.reportError,
        searchReindexDrain: ctx.searchReindexDrain ?? undefined,
      },
      input,
    );

    return { success: result.failed === 0, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.reindex-scheduled-price-flips
// FR-008 / Q-001: refresh the index for events whose ticket-type scheduled
// price change just crossed. A flip is evaluated at READ time, so no row is
// written when it happens and nothing in the normal mutation path triggers a
// reindex — this scan is the only thing that notices.
//
// Modelled on `events.address-reveal-notify`: a window scan with a lookback far
// wider than the tick, so cron drift or a short outage cannot silently skip a
// flip. Idempotent by construction (the document is rebuilt from source rows),
// so the overlap costs a duplicate write and nothing else.
//
// NOT an NFR-002 violation: this job cannot set a price or make anything
// purchasable. Every money-authoritative surface still resolves at read time.
// If this job never runs, browse cards show a stale "from $X" until the nightly
// full reindex; checkout still charges correctly.
// ─────────────────────────────────────────────────────────────────────────────

export const reindexScheduledPriceFlipsJob = defineScheduledTask({
  name: "search.reindex-scheduled-price-flips",
  description:
    "Re-index events whose ticket-type scheduled price change crossed inside " +
    "the scan window, so the index's materialized minPaidPriceCents stops " +
    "serving the pre-flip price. Read-time pricing is unaffected; this only " +
    "refreshes a derived cache.",
  // Reuse the use case's schema (strict, clamped window, defaulted maxEvents)
  // so the job contract can't drift from it.
  input: reindexScheduledPriceFlipsInputSchema,
  schedule: getSchedule("search.reindex-scheduled-price-flips"),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.reindex_scheduled_price_flips_skipped", {
        reason: "MultiSearchPort not configured",
      });
      reportNotConfiguredOnce(ctx, {
        job: "search.reindex-scheduled-price-flips",
        reason: "search_not_configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    const result = await reindexScheduledPriceFlips(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
        // The two failure modes here don't throw and don't reach any backstop:
        // the maxEvents circuit breaker binding (a silently INCOMPLETE refresh)
        // and per-event indexing errors, which buildSearchIndex returns rather
        // than raising.
        reportError: ctx.reportError,
      },
      input,
    );

    ctx.logger.info("search.reindex_scheduled_price_flips.completed", result);

    // A capped run is NOT a success: part of the window was never refreshed, so
    // some events are still serving a stale indexed price.
    return { success: result.errors === 0 && !result.capReached, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Export all search jobs
// ─────────────────────────────────────────────────────────────────────────────
export const searchJobs = [
  indexEvent,
  indexHuman,
  indexPlace,
  indexOrganization,
  fullReindex,
  ensureFormat,
  drainReindexPending,
  reindexScheduledPriceFlipsJob,
];

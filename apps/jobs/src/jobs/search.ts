/**
 * Search Jobs
 *
 * Background work for search index maintenance.
 */
import { z } from "zod";
import { defineJob, defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  buildSearchIndex,
  reindexScheduledPriceFlips,
  reindexScheduledPriceFlipsInputSchema,
} from "@th/core/use-cases/search";

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
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_event_started", { eventId: input.eventId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      { eventIds: [input.eventId] },
    );

    ctx.logger.info("search.index_event_completed", {
      eventId: input.eventId,
      indexed: result.eventsIndexed,
      errors: result.errors.length,
    });

    return { success: result.errors.length === 0, result };
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
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_human_started", { humanId: input.humanId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      { humanIds: [input.humanId] },
    );

    ctx.logger.info("search.index_human_completed", {
      humanId: input.humanId,
      indexed: result.humansIndexed,
      errors: result.errors.length,
    });

    return { success: result.errors.length === 0, result };
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
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.index_place_started", { placeId: input.placeId });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      { placeIds: [input.placeId] },
    );

    ctx.logger.info("search.index_place_completed", {
      placeId: input.placeId,
      indexed: result.placesIndexed,
      errors: result.errors.length,
    });

    return { success: result.errors.length === 0, result };
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
      },
      { organizationIds: [input.organizationId] },
    );

    ctx.logger.info("search.index_organization_completed", {
      organizationId: input.organizationId,
      indexed: result.organizationsIndexed,
      errors: result.errors.length,
    });

    return { success: result.errors.length === 0, result };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// search.full-reindex - Rebuild entire search index (also runs nightly)
// ─────────────────────────────────────────────────────────────────────────────
export const fullReindex = defineScheduledTask({
  schedule: getSchedule("search.full-reindex"),
  name: "search.full-reindex",
  description:
    "Rebuild the selected search backend index (events, humans, places, organizations) from scratch.",
  notify: true,
  input: z.object({
    batchSize: z.number().int().min(1).max(500).default(100),
  }),
  handler: async ({ input, ctx }) => {
    if (!ctx.multiSearch) {
      ctx.logger.warn("search.full_reindex_skipped", {
        reason: "MultiSearchPort not configured",
      });
      return { success: false, reason: "search_not_configured" };
    }

    ctx.logger.info("search.full_reindex_started", {
      batchSize: input.batchSize,
    });

    const result = await buildSearchIndex(
      {
        repos: ctx.repos,
        search: ctx.multiSearch,
        clock: ctx.clock,
        logger: ctx.logger,
      },
      { fullReindex: true, batchSize: input.batchSize },
    );

    ctx.logger.info("search.full_reindex_completed", {
      eventsIndexed: result.eventsIndexed,
      humansIndexed: result.humansIndexed,
      placesIndexed: result.placesIndexed,
      organizationsIndexed: result.organizationsIndexed,
      errorCount: result.errors.length,
    });

    return { success: result.errors.length === 0, result };
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
  reindexScheduledPriceFlipsJob,
];

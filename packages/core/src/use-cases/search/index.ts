/**
 * Search Use Cases
 *
 * Exports all search-related use cases for indexing and querying.
 */

export {
  buildSearchIndex,
  buildSearchIndexInputSchema,
  buildSearchIndexOutputSchema,
  type BuildSearchIndexInput,
  type BuildSearchIndexOutput,
  type BuildSearchIndexDeps,
} from "./build-search-index";

export {
  unifiedSearch,
  unifiedSearchInputSchema,
  unifiedSearchOutputSchema,
  type UnifiedSearchInput,
  type UnifiedSearchOutput,
  type UnifiedSearchDeps,
  type UnifiedSuggestion,
} from "./unified-search";

export {
  eventResultSchema,
  type DiscoveredEvent,
} from "./discover-events.shared";

export {
  nearbyEvents,
  nearbyEventsInputSchema,
  nearbyEventsOutputSchema,
  type NearbyEventsInput,
  type NearbyEventsOutput,
  type NearbyEventsDeps,
} from "./nearby-events";

export {
  featuredEvents,
  featuredEventsInputSchema,
  featuredEventsOutputSchema,
  type FeaturedEventsInput,
  type FeaturedEventsOutput,
  type FeaturedEventsDeps,
} from "./featured-events";

export {
  tieredPopularEvents,
  tieredPopularEventsInputSchema,
  tieredPopularEventsOutputSchema,
  type TieredPopularEventsInput,
  type TieredPopularEventsOutput,
  type TieredPopularEventsDeps,
} from "./tiered-popular-events";

export {
  discoverEventsByCategory,
  discoverEventsByCategoryInputSchema,
  discoverEventsByCategoryOutputSchema,
  type DiscoverEventsByCategoryInput,
  type DiscoverEventsByCategoryOutput,
  type DiscoverEventsByCategoryDeps,
} from "./discover-events-by-category";

export {
  searchOrgAdmin,
  searchOrgAdminInputSchema,
  searchOrgAdminOutputSchema,
  type SearchOrgAdminInput,
  type SearchOrgAdminOutput,
  type SearchOrgAdminDeps,
} from "./search-org-admin";

export {
  reindexAfterMutation,
  runReindexAfterMutation,
  reindexAllPublishedEvents,
  type ReindexAllPublishedEventsDeps,
  type ReindexAllPublishedEventsResult,
} from "./reindex-after-mutation";

export {
  reindexScheduledPriceFlips,
  reindexScheduledPriceFlipsInputSchema,
  reindexScheduledPriceFlipsOutputSchema,
  DEFAULT_FLIP_LOOKBACK_MS,
  DEFAULT_MAX_EVENTS,
  SCAN_PAGE_SIZE,
  type ReindexScheduledPriceFlipsInput,
  type ReindexScheduledPriceFlipsOutput,
  type ReindexScheduledPriceFlipsDeps,
} from "./reindex-scheduled-price-flips";

export { SEARCH_INDEX_FORMAT_VERSION } from "./search-index-format";

export {
  markForSearchReindex,
  scheduleSearchReindexDrain,
  drainSlot,
  SEARCH_REINDEX_DRAIN_JOB,
  DEFAULT_DRAIN_MIN_DELAY_MS,
  DEFAULT_DRAIN_WINDOW_MS,
  type SearchReindexSelector,
  type SearchReindexDrainTrigger,
  type ScheduleDrainOutcome,
} from "./search-reindex-marks";

export {
  drainSearchReindexPending,
  drainSearchReindexPendingInputSchema,
  type DrainSearchReindexPendingInput,
  type DrainSearchReindexPendingOutput,
  type DrainSearchReindexPendingDeps,
} from "./drain-search-reindex-pending";

export {
  runFullSearchReindex,
  ensureSearchIndexFormat,
  SEARCH_FULL_REINDEX_JOB,
  SEARCH_ENSURE_FORMAT_JOB,
  FORMAT_REBUILD_CLAIM_TTL_MS,
  type RunFullSearchReindexOutput,
  type EnsureSearchIndexFormatOutput,
} from "./search-index-format-rebuild";

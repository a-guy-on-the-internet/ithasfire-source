/**
 * Meilisearch Adapter
 *
 * Implements SearchQueryPort and SearchIndexPort against a Meilisearch instance.
 * Designed for event search with geo filtering, facets, and typo tolerance.
 */
import {
  MeiliSearch,
  type Index,
  type SearchParams,
  type SearchResponse,
  type TasksResults,
  type EnqueuedTask,
} from "meilisearch";

import type { SearchQueryPort } from "@th/ports/search/query.port";
import type { SearchIndexPort } from "@th/ports/search/index.port";
import {
  type SearchAutocompleteInput,
  type SearchAutocompleteOutput,
  type SearchQueryInput,
  type SearchQueryResult,
  type SearchRelatedInput,
  type SearchRelatedResult,
  type SearchIndexUpsertInput,
  type SearchIndexUpsertOutput,
  type SearchIndexDeleteInput,
  type SearchIndexDeleteOutput,
  type SearchIndexRefreshOutput,
  type SearchHealthStatus,
  type SearchDocument,
  type SearchResult,
  type SearchSuggestion,
  type QueryFilters,
  type Result,
  SearchPortError,
  ok,
  err,
} from "@th/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS_INDEX = "events";
const DEFAULT_AUTOCOMPLETE_LIMIT = 8;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RELATED_LIMIT = 6;

// Meilisearch document shape (matches SearchDocument but with Meili conventions)
interface MeiliEventDocument {
  id: string; // Meilisearch requires 'id' as primary key
  eventId: string;
  slug: string | null;
  orgId: string | null;
  ownerType: "ORG" | "HUMAN";
  ownerHumanId: string | null;
  title: string;
  artists: string[];
  tags: string[];
  venueId: string | null;
  venueName: string | null;
  addressText: string | null;
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
  _geo: { lat: number; lng: number } | null; // Meilisearch geo format
  startsAt: number | null; // Unix timestamp for filtering
  endsAt: number | null;
  startsAtIso: string | null; // ISO string for display
  endsAtIso: string | null;
  status: "DRAFT" | "PUBLISHED" | "HIDDEN";
  popularityScore: number;
  recencyScore: number;
  summary: string | null;
  // We don't store embeddings in Meilisearch - that's for vector DBs
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Options
// ─────────────────────────────────────────────────────────────────────────────

export interface MeilisearchAdapterOptions {
  host: string;
  apiKey: string;
  /** Optional custom index name (defaults to 'events') */
  indexName?: string;
  /** Request timeout in ms */
  timeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class MeilisearchAdapter implements SearchQueryPort, SearchIndexPort {
  private readonly client: MeiliSearch;
  private readonly indexName: string;
  private index: Index<MeiliEventDocument> | null = null;

  constructor(private readonly options: MeilisearchAdapterOptions) {
    this.client = new MeiliSearch({
      host: options.host,
      apiKey: options.apiKey,
      timeout: options.timeout ?? 10000,
    });
    this.indexName = options.indexName ?? EVENTS_INDEX;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Index initialization (lazy)
  // ─────────────────────────────────────────────────────────────────────────

  private async getIndex(): Promise<Index<MeiliEventDocument>> {
    if (this.index) {
      return this.index;
    }

    // Create index if it doesn't exist
    try {
      await this.client.createIndex(this.indexName, { primaryKey: "id" });
    } catch (e: unknown) {
      // Index might already exist - that's fine
      if (!(e instanceof Error && e.message.includes("already exists"))) {
        // Log but don't throw - we'll try to get the index anyway
      }
    }

    this.index = this.client.index<MeiliEventDocument>(this.indexName);

    // Configure index settings for event search
    await this.configureIndex(this.index);

    return this.index;
  }

  private async configureIndex(
    index: Index<MeiliEventDocument>,
  ): Promise<void> {
    // Searchable attributes in priority order
    await index.updateSearchableAttributes([
      "title",
      "artists",
      "venueName",
      "city",
      "tags",
      "summary",
      "addressText",
    ]);

    // Filterable attributes for faceted search
    await index.updateFilterableAttributes([
      "orgId",
      "ownerHumanId",
      "venueId",
      "status",
      "startsAt",
      "endsAt",
      "regionCode",
      "countryCode",
      "tags",
      "_geo",
    ]);

    // Sortable attributes
    await index.updateSortableAttributes([
      "startsAt",
      "popularityScore",
      "recencyScore",
      "_geo",
    ]);

    // Faceting settings
    await index.updateFaceting({
      maxValuesPerFacet: 100,
    });

    // Typo tolerance
    await index.updateTypoTolerance({
      enabled: true,
      minWordSizeForTypos: {
        oneTypo: 4,
        twoTypos: 8,
      },
    });

    // Ranking rules - customize for events
    await index.updateRankingRules([
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "exactness",
      "popularityScore:desc",
      "recencyScore:desc",
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SearchQueryPort Implementation
  // ─────────────────────────────────────────────────────────────────────────

  async autocomplete(
    input: SearchAutocompleteInput,
  ): Promise<Result<SearchAutocompleteOutput, SearchPortError>> {
    const start = Date.now();

    // Short-circuit for very short queries
    if (input.query.length < 2) {
      return ok({ suggestions: [], latencyMs: Date.now() - start });
    }

    try {
      const index = await this.getIndex();
      const searchParams = this.buildSearchParams(input.filters, {
        limit: input.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT,
        attributesToRetrieve: [
          "eventId",
          "slug",
          "title",
          "venueName",
          "city",
          "startsAtIso",
        ],
        attributesToHighlight: ["title"],
        showMatchesPosition: true,
      });

      const response = await index.search(input.query, searchParams);

      const suggestions: SearchSuggestion[] = response.hits.map((hit) => ({
        eventId: hit.eventId,
        slug: hit.slug,
        title: hit.title,
        subtitle: hit.venueName ?? undefined,
        helper: hit.city ?? undefined,
        matchReason: this.inferMatchReason(hit, response),
        confidence: this.calculateConfidence(hit, response),
      }));

      return ok({
        suggestions,
        latencyMs: Date.now() - start,
      });
    } catch (e) {
      return err(this.wrapError(e, "autocomplete"));
    }
  }

  async search(
    input: SearchQueryInput,
  ): Promise<Result<SearchQueryResult, SearchPortError>> {
    const start = Date.now();

    try {
      const index = await this.getIndex();
      const searchParams = this.buildSearchParams(input.filters, {
        limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
        offset: input.offset ?? 0,
        attributesToRetrieve: ["*"],
        attributesToHighlight: ["title", "summary"],
        facets: input.includeFacets
          ? ["regionCode", "tags", "status"]
          : undefined,
        showMatchesPosition: true,
      });

      // Add sorting - default to startsAt ascending for upcoming events
      if (!searchParams.sort) {
        searchParams.sort = ["startsAt:asc"];
      }

      // "*" is a browse-mode sentinel: pass "" to Meilisearch so it returns
      // all documents (filtered by geo / facets only).
      const meiliQuery = input.query === "*" ? "" : input.query;

      const response = await index.search(meiliQuery, searchParams);

      const results: SearchResult[] = response.hits.map((hit, idx) => ({
        eventId: hit.eventId,
        slug: hit.slug,
        title: hit.title,
        snippet: hit.summary ?? undefined,
        badges: hit.tags?.slice(0, 3),
        location: {
          venueId: hit.venueId,
          venueName: hit.venueName,
          addressText: hit.addressText,
          city: hit.city,
          regionCode: hit.regionCode,
          countryCode: hit.countryCode,
          lat: hit._geo?.lat,
          lng: hit._geo?.lng,
        },
        startsAt: hit.startsAtIso ? new Date(hit.startsAtIso) : null,
        endsAt: hit.endsAtIso ? new Date(hit.endsAtIso) : null,
        status: hit.status,
        matchReasons: this.extractMatchReasons(hit, response),
        score: hit.popularityScore,
        sgrank: idx + 1,
        confidence: this.calculateConfidence(hit, response),
      }));

      return ok({
        results,
        facets: response.facetDistribution
          ? this.mapFacets(response.facetDistribution)
          : undefined,
        latencyMs: Date.now() - start,
      });
    } catch (e) {
      return err(this.wrapError(e, "search"));
    }
  }

  async related(
    input: SearchRelatedInput,
  ): Promise<Result<SearchRelatedResult, SearchPortError>> {
    try {
      const index = await this.getIndex();

      // First, get the source event to find its tags/venue
      const sourceResponse = await index.search("", {
        filter: `eventId = "${input.eventId}"`,
        limit: 1,
      });

      const source = sourceResponse.hits[0];
      if (!source) {
        return ok({ results: [] });
      }

      // Build a filter to find related events (same tags, same venue, or same org)
      const filters: string[] = [
        `eventId != "${input.eventId}"`,
        `status = "PUBLISHED"`,
      ];

      // Search for events with similar tags or same venue/org
      const tagFilter =
        source.tags && source.tags.length > 0
          ? `(${source.tags.map((t) => `tags = "${t}"`).join(" OR ")})`
          : null;
      const venueFilter = source.venueId
        ? `venueId = "${source.venueId}"`
        : null;
      const orgFilter = source.orgId ? `orgId = "${source.orgId}"` : null;

      const relatedFilters = [tagFilter, venueFilter, orgFilter].filter(
        Boolean,
      );
      if (relatedFilters.length > 0) {
        filters.push(`(${relatedFilters.join(" OR ")})`);
      }

      const response = await index.search("", {
        filter: filters.join(" AND "),
        limit: input.limit ?? DEFAULT_RELATED_LIMIT,
        sort: ["popularityScore:desc"],
      });

      const results: SearchResult[] = response.hits.map((hit, idx) => ({
        eventId: hit.eventId,
        slug: hit.slug,
        title: hit.title,
        location: {
          venueId: hit.venueId,
          venueName: hit.venueName,
          city: hit.city,
        },
        startsAt: hit.startsAtIso ? new Date(hit.startsAtIso) : null,
        matchReasons: ["related"],
        score: hit.popularityScore,
        sgrank: idx + 1,
        confidence: 0.7,
      }));

      return ok({ results });
    } catch (e) {
      return err(this.wrapError(e, "related"));
    }
  }

  async health(): Promise<SearchHealthStatus> {
    try {
      const health = await this.client.health();
      return {
        ok: health.status === "available",
        details: { status: health.status },
      };
    } catch (e) {
      return {
        ok: false,
        details: { error: e instanceof Error ? e.message : "unknown" },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SearchIndexPort Implementation
  // ─────────────────────────────────────────────────────────────────────────

  async upsertDocuments(
    input: SearchIndexUpsertInput,
  ): Promise<Result<SearchIndexUpsertOutput, SearchPortError>> {
    try {
      const index = await this.getIndex();

      // Convert SearchDocument to MeiliEventDocument
      const meiliDocs = input.documents.map(this.toMeiliDocument);

      // Add or update documents
      const task = await index.addDocuments(meiliDocs, { primaryKey: "id" });

      // Wait for indexing to complete
      await this.client.tasks.waitForTask(task.taskUid, { timeout: 30000 });

      return ok({
        indexed: input.documents.length,
        failed: 0,
      });
    } catch (e) {
      return err(this.wrapError(e, "upsertDocuments"));
    }
  }

  async deleteDocuments(
    input: SearchIndexDeleteInput,
  ): Promise<Result<SearchIndexDeleteOutput, SearchPortError>> {
    try {
      const index = await this.getIndex();
      let deleted = 0;

      if (input.eventIds?.length) {
        // Delete by IDs (Meilisearch uses 'id' which we set to eventId)
        const task = await index.deleteDocuments(input.eventIds);
        await this.client.tasks.waitForTask(task.taskUid, { timeout: 30000 });
        deleted = input.eventIds.length;
      }

      if (input.orgId) {
        // Delete by filter
        const task = await index.deleteDocuments({
          filter: `orgId = "${input.orgId}"`,
        });
        await this.client.tasks.waitForTask(task.taskUid, { timeout: 30000 });
        // We don't know exact count for filter deletes
        deleted += 1;
      }

      if (input.slug) {
        const task = await index.deleteDocuments({
          filter: `slug = "${input.slug}"`,
        });
        await this.client.tasks.waitForTask(task.taskUid, { timeout: 30000 });
        deleted += 1;
      }

      return ok({ deleted });
    } catch (e) {
      return err(this.wrapError(e, "deleteDocuments"));
    }
  }

  async refreshIndexes(): Promise<
    Result<SearchIndexRefreshOutput, SearchPortError>
  > {
    try {
      // Meilisearch doesn't have an explicit refresh - it's eventually consistent
      // Just ensure the index exists
      await this.getIndex();

      return ok({ refreshedAt: new Date() });
    } catch (e) {
      return err(this.wrapError(e, "refreshIndexes"));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private toMeiliDocument(doc: SearchDocument): MeiliEventDocument {
    return {
      id: doc.eventId, // Use eventId as Meilisearch primary key
      eventId: doc.eventId,
      slug: doc.slug,
      orgId: doc.orgId,
      ownerType: doc.ownerType,
      ownerHumanId: doc.ownerHumanId,
      title: doc.title,
      artists: doc.artists,
      tags: doc.tags,
      venueId: doc.venueId,
      venueName: doc.venueName,
      addressText: doc.addressText,
      city: doc.city,
      regionCode: doc.regionCode,
      countryCode: doc.countryCode,
      _geo:
        doc.lat != null && doc.lng != null
          ? { lat: doc.lat, lng: doc.lng }
          : null,
      startsAt: doc.startsAt ? Math.floor(doc.startsAt.getTime() / 1000) : null,
      endsAt: doc.endsAt ? Math.floor(doc.endsAt.getTime() / 1000) : null,
      startsAtIso: doc.startsAt?.toISOString() ?? null,
      endsAtIso: doc.endsAt?.toISOString() ?? null,
      status: doc.status,
      popularityScore: doc.popularityScore,
      recencyScore: doc.recencyScore,
      summary: doc.summary,
    };
  }

  private buildSearchParams(
    filters: QueryFilters | undefined,
    base: SearchParams,
  ): SearchParams {
    const filterClauses: string[] = [];

    if (filters) {
      if (filters.orgId) {
        filterClauses.push(`orgId = "${filters.orgId}"`);
      }
      if (filters.ownerHumanId) {
        filterClauses.push(`ownerHumanId = "${filters.ownerHumanId}"`);
      }
      if (filters.venueId) {
        filterClauses.push(`venueId = "${filters.venueId}"`);
      }
      if (filters.status?.length) {
        const statusFilter = filters.status
          .map((s) => `status = "${s}"`)
          .join(" OR ");
        filterClauses.push(`(${statusFilter})`);
      }
      if (filters.dateRange) {
        if (filters.dateRange.gte) {
          const gte = Math.floor(filters.dateRange.gte.getTime() / 1000);
          filterClauses.push(`startsAt >= ${gte}`);
        }
        if (filters.dateRange.lte) {
          const lte = Math.floor(filters.dateRange.lte.getTime() / 1000);
          filterClauses.push(`startsAt <= ${lte}`);
        }
      }
      if (filters.regionCodes?.length) {
        const regionFilter = filters.regionCodes
          .map((r) => `regionCode = "${r}"`)
          .join(" OR ");
        filterClauses.push(`(${regionFilter})`);
      }
      if (filters.tags?.length) {
        const tagFilter = filters.tags.map((t) => `tags = "${t}"`).join(" OR ");
        filterClauses.push(`(${tagFilter})`);
      }
      if (filters.geo) {
        // _geoRadius(lat, lng, radiusInMeters)
        const radiusMeters = filters.geo.radiusKm * 1000;
        filterClauses.push(
          `_geoRadius(${filters.geo.lat}, ${filters.geo.lng}, ${radiusMeters})`,
        );

        // Sort by distance when geo filter is active
        base.sort = [`_geoPoint(${filters.geo.lat}, ${filters.geo.lng}):asc`];
      }
    }

    return {
      ...base,
      filter:
        filterClauses.length > 0 ? filterClauses.join(" AND ") : undefined,
    };
  }

  private inferMatchReason(
    hit: MeiliEventDocument,
    response: SearchResponse<MeiliEventDocument>,
  ): SearchSuggestion["matchReason"] {
    // Check _matchesPosition to determine what field matched
    const matchInfo = (response as any)._matchesPosition?.[hit.id];
    if (!matchInfo) return "title";

    if (matchInfo.title) return "title";
    if (matchInfo.artists) return "artist";
    if (matchInfo.venueName) return "venue";
    if (matchInfo.city) return "city";
    return "title";
  }

  private extractMatchReasons(
    hit: MeiliEventDocument,
    response: SearchResponse<MeiliEventDocument>,
  ): string[] {
    const reasons: string[] = [];
    const matchInfo = (response as any)._matchesPosition?.[hit.id];

    if (matchInfo) {
      if (matchInfo.title) reasons.push("title");
      if (matchInfo.artists) reasons.push("artist");
      if (matchInfo.venueName) reasons.push("venue");
      if (matchInfo.city) reasons.push("city");
      if (matchInfo.tags) reasons.push("tag");
    }

    return reasons.length > 0 ? reasons : ["relevance"];
  }

  private calculateConfidence(
    hit: MeiliEventDocument,
    response: SearchResponse<MeiliEventDocument>,
  ): number {
    // Meilisearch doesn't provide a raw score, so we estimate based on position
    const position = response.hits.indexOf(hit);
    const total = response.hits.length;

    if (total === 0) return 0;

    // First result gets highest confidence, decays linearly
    return Math.max(0.3, 1 - position / (total * 2));
  }

  private mapFacets(
    facetDistribution: Record<string, Record<string, number>>,
  ): Record<string, Array<{ label: string; count: number }>> {
    const result: Record<string, Array<{ label: string; count: number }>> = {};

    for (const [facetName, values] of Object.entries(facetDistribution)) {
      result[facetName] = Object.entries(values)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
    }

    return result;
  }

  private wrapError(e: unknown, operation: string): SearchPortError {
    const message = e instanceof Error ? e.message : "unknown error";

    // Determine error code based on error type
    if (message.includes("not found") || message.includes("404")) {
      return new SearchPortError("not_found", `${operation}: ${message}`);
    }
    if (
      message.includes("unauthorized") ||
      message.includes("forbidden") ||
      message.includes("403")
    ) {
      return new SearchPortError("forbidden", `${operation}: ${message}`);
    }
    if (message.includes("timeout") || message.includes("ECONNREFUSED")) {
      return new SearchPortError("transient", `${operation}: ${message}`);
    }

    return new SearchPortError(
      "dependency_failed",
      `${operation}: ${message}`,
      { cause: e },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

export function createMeilisearchAdapter(
  options: MeilisearchAdapterOptions,
): MeilisearchAdapter {
  return new MeilisearchAdapter(options);
}

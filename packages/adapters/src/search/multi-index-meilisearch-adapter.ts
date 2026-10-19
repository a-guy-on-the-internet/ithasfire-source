/**
 * Multi-Index Meilisearch Adapter
 *
 * Implements multi-entity search across events, humans, and places using Meilisearch.
 * Uses a single unified index with type-based filtering for simplicity and fast federation.
 */
import {
  MeiliSearch,
  type Index,
  type SearchParams,
  type SearchResponse,
} from "meilisearch";

import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type {
  MultiSearchAutocompleteInput,
  MultiSearchAutocompleteOutput,
  MultiSearchIndexInput,
  MultiSearchIndexOutput,
  MultiSearchDeleteInput,
  MultiSearchDeleteOutput,
  MultiSearchIndexStats,
  MultiSearchDocument,
  MultiSearchSort,
  MultiSearchSuggestion,
  EventSearchDocument,
  HumanSearchDocument,
  PlaceSearchDocument,
  OrganizationSearchDocument,
  EventSuggestion,
  HumanSuggestion,
  PlaceSuggestion,
  OrganizationSuggestion,
  SearchEntityType,
  MultiSearchSweepInput,
  SearchSweepToken,
} from "@th/ports/search/multi-index.types";
import {
  type Result,
  type SearchPortError,
  type SearchHealthStatus,
  ok,
  err,
  SearchPortError as SearchPortErrorClass,
} from "@th/ports/search";
import { formatEventMonthDay } from "@th/core/lib/event-local-date";

import { placeMapPosition } from "./place-map-position";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const UNIFIED_INDEX = "search";
const DEFAULT_AUTOCOMPLETE_LIMIT = 10;

/** See `beginSweep`: writers on other processes may run a little behind. */
const SWEEP_CLOCK_SKEW_MARGIN_MS = 60_000;

/**
 * Quote a value for interpolation into a Meilisearch filter expression as a
 * double-quoted string literal, escaping the two characters that are special
 * INSIDE such a literal: the backslash (`\`) and the double-quote (`"`). Every
 * interpolated filter literal (placeId, orgId, ownerHumanId, tags, regionCode,
 * type, …) MUST go through this so the adapter is injection-safe BY
 * CONSTRUCTION — independent of whatever validation upstream happens to apply.
 * Returns the value WITH its surrounding quotes, e.g. `foo"bar` → `"foo\"bar"`.
 */
export function meiliQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the Meilisearch `sort` spec for the requested event ordering. Returns
 * `undefined` for relevance-without-geo (Meili then uses its ranking rules).
 * Matches the Postgres adapter's `buildOrderByClause` + `resolveEffectiveSort`
 * on PRIMARY ordering per mode. Deep tiebreaks are NOT mirrored: PG appends
 * `popularityScore DESC, title ASC`; Meili has no `title` tiebreak and defers to
 * its ranking rules. Only observable for equal-startsAt/equal-distance events;
 * prod runs postgres so PG is authoritative.
 *
 * - `relevance` — EXACTLY today's behavior: geo present → sort by distance;
 *   otherwise no sort spec (pure ranking-rule relevance). Regression guard.
 * - `date`      — soonest-first; nearer breaks ties when geo is present.
 * - `distance`  — nearest-first, soonest breaks ties. Requires a coordinate;
 *   without one there is nothing to measure against, so it falls back to `date`.
 * - `date_desc` / `price_asc` / `price_desc` / `popularity` — single-key specs.
 *   Meili sorts its own NULLs last, so unpriced events trail in both price
 *   directions, matching the PG adapter's explicit NULLS LAST.
 */
export function buildMeiliSort(
  sort: MultiSearchSort,
  geo: { lat: number; lng: number; radiusKm: number } | undefined,
): string[] | undefined {
  // Distance needs a coordinate — degrade to date ordering when absent.
  const effective = sort === "distance" && !geo ? "date" : sort;
  const geoAsc = geo ? `_geoPoint(${geo.lat}, ${geo.lng}):asc` : null;

  switch (effective) {
    case "date":
      return geoAsc ? ["startsAt:asc", geoAsc] : ["startsAt:asc"];
    case "date_desc":
      return ["startsAt:desc"];
    // `lowestBuyerTotalCents` and `popularityScore` are both declared in
    // `updateSortableAttributes` — adding a mode here without adding the
    // attribute there makes Meili reject the whole search.
    case "price_asc":
      return ["lowestBuyerTotalCents:asc"];
    case "price_desc":
      return ["lowestBuyerTotalCents:desc"];
    case "popularity":
      return ["popularityScore:desc"];
    case "distance":
      // Only reached WITH geo (the fallback above handles the no-geo case).
      return geoAsc ? [geoAsc, "startsAt:asc"] : ["startsAt:asc"];
    case "relevance":
    default:
      return geoAsc ? [geoAsc] : undefined;
  }
}

// Meilisearch document shape (unified across all types)
interface MeiliDocument {
  // Common fields
  id: string;
  /**
   * Write marker for the non-destructive full rebuild (`deleteUnswept`):
   * epoch ms at the moment the adapter sent the write. Meilisearch applies an
   * index's tasks in order, so a later send is a later write.
   */
  indexedMarker?: number;
  type: SearchEntityType;
  title: string; // Primary display field (event title, username, venue name, org name)
  subtitle: string | null; // Secondary display (venue, bio, address, member count)
  helper: string | null; // Tertiary info (date, city, capacity, event count)
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
  _geo: { lat: number; lng: number } | null;
  /**
   * How to DRAW `_geo` (events + places): a pin only when true; a circle of
   * `locationRadiusMeters` when false with a radius; nothing otherwise. Both
   * come straight off the redacted document. A document indexed before these
   * attributes existed returns them `undefined` — read that as not-exact /
   * no-circle (fail closed).
   */
  locationIsExact: boolean;
  locationRadiusMeters: number | null;

  // Type-specific IDs (exactly one will be set)
  eventId: string | null;
  humanId: string | null;
  placeId: string | null;
  orgIdRef: string | null; // Organization document's own ID (distinct from orgId which is event's org)

  // Event-specific
  slug: string | null;
  orgId: string | null;
  ownerHumanId: string | null;
  artists: string[];
  tags: string[];
  /** Category name in every language; searchable at the lowest rank. */
  categoryNames: string[];
  venueName: string | null;
  /** Full street/address text for the event (redacted for non-EXACT locations upstream). */
  addressText: string | null;
  /** Long-form description; searchable so events with no descriptive title still surface. */
  summary: string | null;
  startsAt: number | null; // Unix timestamp
  startsAtIso: string | null;
  endsAt: number | null; // Unix timestamp
  endsAtIso: string | null;
  /**
   * `Event.timezone` (IANA), the zone `helper` was formatted in. Read back so
   * the card stamps the time in the event's zone. A document indexed before
   * the attribute existed returns it `undefined` (reader falls back).
   */
  timezone: string | null;
  eventStatus: "DRAFT" | "PUBLISHED" | "HIDDEN" | null;
  popularityScore: number;
  imageUrl: string | null; // Primary event image URL
  lowestPriceCents: number | null;
  lowestBuyerTotalCents: number | null;
  currency: string | null;
  paidTierCount: number;
  hasFreeTier: boolean;
  hasPayWhatYouWantTier: boolean;

  // Human-specific
  username: string | null;
  profileSlug: string | null;
  eventsHostedCount: number;
  isPublic: boolean;

  // Place-specific
  capacity: number | null;
  eventCount: number;
  placeStatus: "ACTIVE" | "SUSPENDED" | "ARCHIVED" | null;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "PENDING" | "REJECTED" | null;
  listedInDirectory: boolean;

  // Organization-specific
  orgSlug: string | null;
  orgStatus: "ACTIVE" | "SUSPENDED" | "ARCHIVED" | null;
  memberCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Options
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiIndexMeilisearchAdapterOptions {
  host: string;
  apiKey: string;
  /** Optional custom index name (defaults to 'search') */
  indexName?: string;
  /** Request timeout in ms */
  timeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class MultiIndexMeilisearchAdapter implements MultiSearchPort {
  private readonly client: MeiliSearch;
  private readonly indexName: string;
  private index: Index<MeiliDocument> | null = null;

  constructor(private readonly options: MultiIndexMeilisearchAdapterOptions) {
    this.client = new MeiliSearch({
      host: options.host,
      apiKey: options.apiKey,
      timeout: options.timeout ?? 30000,
    });
    this.indexName = options.indexName ?? UNIFIED_INDEX;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Index initialization
  // ─────────────────────────────────────────────────────────────────────────

  private async getIndex(): Promise<Index<MeiliDocument>> {
    if (this.index) {
      return this.index;
    }

    this.index = this.client.index<MeiliDocument>(this.indexName);
    return this.index;
  }

  async ensureIndexes(): Promise<Result<void, SearchPortError>> {
    try {
      // Create index if it doesn't exist
      try {
        await this.client.createIndex(this.indexName, { primaryKey: "id" });
      } catch (e: unknown) {
        // Index might already exist - that's fine
        if (!(e instanceof Error && e.message.includes("already exists"))) {
          // Log but continue
        }
      }

      const index = await this.getIndex();

      // Configure searchable attributes in priority order. Higher entries
      // weigh more in relevance — title (names) leads, supplementary text
      // (bio, summary) trails. Slug-style fields are intentionally absent:
      // users don't type slugs, and including them adds noise without
      // helping recall.
      await index.updateSearchableAttributes([
        "title", // Event title, displayName (humans), venue name, org name
        "subtitle", // Venue/address, bio (humans), formattedAddress (places)
        "username", // Better Auth handle for humans
        "tags", // Events
        "summary", // Event long-form description
        "city",
        "helper",
        // Category names (English + translations): searchable text, the
        // LOWEST rank, so a query for "música" finds a Music event but a
        // title match always outranks it. Applied by every ensureIndexes
        // (each full rebuild), which also adds it to existing indexes.
        "categoryNames",
      ]);

      // Filterable attributes
      await index.updateFilterableAttributes([
        "type",
        "eventStatus",
        "placeStatus",
        "listedInDirectory",
        "isPublic",
        "orgId",
        "ownerHumanId",
        "placeId",
        "regionCode",
        "countryCode",
        "tags",
        "startsAt",
        "lowestBuyerTotalCents",
        "_geo",
        // Non-destructive full rebuild sweep (deleteUnswept).
        "id",
        "indexedMarker",
      ]);

      // Sortable attributes
      await index.updateSortableAttributes([
        "startsAt",
        "popularityScore",
        "eventsHostedCount",
        "eventCount",
        "lowestBuyerTotalCents",
        "_geo",
      ]);

      // Typo tolerance
      await index.updateTypoTolerance({
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 4,
          twoTypos: 8,
        },
      });

      // Ranking rules
      await index.updateRankingRules([
        "words",
        "typo",
        "proximity",
        "attribute",
        "sort",
        "exactness",
        "popularityScore:desc",
      ]);

      return ok(undefined);
    } catch (e) {
      return err(this.wrapError(e, "ensureIndexes"));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Implementation
  // ─────────────────────────────────────────────────────────────────────────

  async autocomplete(
    input: MultiSearchAutocompleteInput,
  ): Promise<Result<MultiSearchAutocompleteOutput, SearchPortError>> {
    const start = Date.now();

    // Short-circuit only the genuinely-empty case: a 1-character typeahead
    // query with no filters at all. Everything else (browse-all on /search,
    // category pages, geo/region scoped queries, date-range pulls) is
    // intentional and should hit the index.
    const f = input.filters;
    const hasFilters = !!(
      f?.geo ||
      f?.regionCodes?.length ||
      f?.tags?.length ||
      f?.placeIds?.length ||
      f?.dateRange ||
      f?.priceRange ||
      f?.orgId ||
      f?.ownerHumanId ||
      f?.freeOnly ||
      f?.includeNonPublicEvents ||
      f?.listedInDirectoryOnly
    );
    if (input.query.length === 1 && !hasFilters) {
      return ok({ suggestions: [], latencyMs: Date.now() - start });
    }

    try {
      const index = await this.getIndex();
      const searchParams = this.buildSearchParams(input.filters, {
        limit: input.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT,
        offset: input.offset ?? 0,
        attributesToRetrieve: [
          "id",
          "type",
          "title",
          "subtitle",
          "helper",
          "eventId",
          "humanId",
          "placeId",
          "slug",
          "username",
          "profileSlug",
          "startsAtIso",
          // Event render payload for the embed widgets, which fully
          // search-serve their event lists (kept in LOCKSTEP with the PG
          // adapter's ends_at / address_text / region_code selects). Without
          // these, embed events would render null endsAt/location/region.
          "endsAtIso",
          // The zone `helper` was formatted in; Meili omits any attribute not
          // listed here, which would stamp every card in the fallback zone.
          "timezone",
          "addressText",
          "regionCode",
          // Venue coordinates for the /search results map. Meilisearch stores
          // the geo point under the reserved `_geo` key (see the indexing path
          // ~L524) and OMITS it from hits unless explicitly retrieved — without
          // this line every event returns lat/lng = null on the Meili backend.
          "_geo",
          // How to draw `_geo` — pin vs approximate circle. Same trap as
          // `_geo`: Meili omits any attribute not listed here, and a missing
          // flag reads as "not exact", which would silently un-pin every
          // exact venue and event on the map. Pinned by a guard test.
          "locationIsExact",
          "locationRadiusMeters",
          "city",
          "capacity",
          "imageUrl",
          "lowestPriceCents",
          "lowestBuyerTotalCents",
          "currency",
          "paidTierCount",
          "hasFreeTier",
          "hasPayWhatYouWantTier",
          // Type-specific identifiers — without these the org/place suggestion
          // mappers read `undefined` and fail Zod output validation, killing
          // the whole autocomplete response.
          "orgIdRef",
          "orgSlug",
          "orgStatus",
          "memberCount",
          "eventCount",
          "verificationStatus",
          "placeStatus",
          "listedInDirectory",
          "eventsHostedCount",
        ],
        attributesToHighlight: ["title"],
        showMatchesPosition: true,
      }, input.sort);

      const response = await index.search(input.query, searchParams);

      const suggestions: MultiSearchSuggestion[] = response.hits.map((hit) =>
        this.hitToSuggestion(hit, response),
      );

      return ok({
        suggestions,
        latencyMs: Date.now() - start,
        estimatedTotalHits: response.estimatedTotalHits,
      });
    } catch (e) {
      return err(this.wrapError(e, "autocomplete"));
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
        details: { error: e instanceof Error ? e.message : "Unknown error" },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Index Implementation
  // ─────────────────────────────────────────────────────────────────────────

  async upsertDocuments(
    input: MultiSearchIndexInput,
  ): Promise<Result<MultiSearchIndexOutput, SearchPortError>> {
    if (input.documents.length === 0) {
      return ok({ indexed: 0, failed: 0 });
    }

    try {
      const index = await this.getIndex();
      const indexedMarker = Date.now();
      const meiliDocs = input.documents.map((doc) => ({
        ...this.toMeiliDocument(doc),
        indexedMarker,
      }));

      // Chain waitTask on the promise - SDK v0.55+ pattern
      await index
        .addDocuments(meiliDocs, { primaryKey: "id" })
        .waitTask({ timeout: 30000 });

      return ok({
        indexed: input.documents.length,
        failed: 0,
      });
    } catch (e) {
      return err(this.wrapError(e, "upsertDocuments"));
    }
  }

  async deleteDocuments(
    input: MultiSearchDeleteInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>> {
    try {
      const index = await this.getIndex();
      let deleted = 0;

      if (input.ids?.length) {
        await index.deleteDocuments(input.ids).waitTask({ timeout: 30000 });
        deleted += input.ids.length;
      }

      if (input.type) {
        await index
          .deleteDocuments({ filter: `type = ${meiliQuote(input.type)}` })
          .waitTask({ timeout: 30000 });
        // We don't know exact count from filter delete
        deleted += 1;
      }

      if (input.orgId) {
        await index
          .deleteDocuments({ filter: `orgId = ${meiliQuote(input.orgId)}` })
          .waitTask({ timeout: 30000 });
        deleted += 1;
      }

      if (input.ownerHumanId) {
        await index
          .deleteDocuments({
            filter: `ownerHumanId = ${meiliQuote(input.ownerHumanId)}`,
          })
          .waitTask({ timeout: 30000 });
        deleted += 1;
      }

      return ok({ deleted });
    } catch (e) {
      return err(this.wrapError(e, "deleteDocuments"));
    }
  }

  async beginSweep(): Promise<Result<SearchSweepToken, SearchPortError>> {
    // App clock, not the engine's (Meilisearch has none to read). The margin
    // absorbs clock skew between this process and a concurrent writer's: a
    // document written up to a minute before the run is kept, never swept —
    // the safe direction (it was written by a live-state write).
    return ok({ marker: String(Date.now() - SWEEP_CLOCK_SKEW_MARGIN_MS) });
  }

  async deleteUnswept(
    input: MultiSearchSweepInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>> {
    const marker = Number(input.token.marker);
    if (!Number.isFinite(marker)) {
      return err(
        this.wrapError(new Error("invalid sweep token"), "deleteUnswept"),
      );
    }
    try {
      const index = await this.getIndex();
      const keep = input.keepIds ?? [];
      const filter =
        `type = ${meiliQuote(input.type)}` +
        ` AND (indexedMarker < ${Math.floor(marker)} OR indexedMarker NOT EXISTS)` +
        (keep.length > 0
          ? ` AND id NOT IN [${keep.map(meiliQuote).join(", ")}]`
          : "");
      await index.deleteDocuments({ filter }).waitTask({ timeout: 30000 });
      // A filter delete does not report a count.
      return ok({ deleted: 0 });
    } catch (e) {
      return err(this.wrapError(e, "deleteUnswept"));
    }
  }

  async getStats(): Promise<Result<MultiSearchIndexStats, SearchPortError>> {
    try {
      const index = await this.getIndex();
      const stats = await index.getStats();

      // Count documents by type using faceted search
      const [eventsResult, humansResult, placesResult, orgsResult] =
        await Promise.all([
          index.search("", { filter: 'type = "event"', limit: 0 }),
          index.search("", { filter: 'type = "human"', limit: 0 }),
          index.search("", { filter: 'type = "place"', limit: 0 }),
          index.search("", { filter: 'type = "organization"', limit: 0 }),
        ]);

      return ok({
        events: {
          count: eventsResult.estimatedTotalHits ?? 0,
          lastIndexedAt: stats.isIndexing ? new Date() : null,
        },
        humans: {
          count: humansResult.estimatedTotalHits ?? 0,
          lastIndexedAt: stats.isIndexing ? new Date() : null,
        },
        places: {
          count: placesResult.estimatedTotalHits ?? 0,
          lastIndexedAt: stats.isIndexing ? new Date() : null,
        },
        organizations: {
          count: orgsResult.estimatedTotalHits ?? 0,
          lastIndexedAt: stats.isIndexing ? new Date() : null,
        },
      });
    } catch (e) {
      return err(this.wrapError(e, "getStats"));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private toMeiliDocument(doc: MultiSearchDocument): MeiliDocument {
    const base: MeiliDocument = {
      id: doc.id,
      type: doc.type,
      title: "",
      subtitle: null,
      helper: null,
      city: null,
      regionCode: null,
      countryCode: null,
      _geo: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      eventId: null,
      humanId: null,
      placeId: null,
      orgIdRef: null,
      slug: null,
      orgId: null,
      ownerHumanId: null,
      artists: [],
      tags: [],
      categoryNames: [],
      venueName: null,
      addressText: null,
      summary: null,
      startsAt: null,
      startsAtIso: null,
      endsAt: null,
      endsAtIso: null,
      timezone: null,
      eventStatus: null,
      popularityScore: 0,
      imageUrl: null,
      lowestPriceCents: null,
      lowestBuyerTotalCents: null,
      currency: null,
      paidTierCount: 0,
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      username: null,
      profileSlug: null,
      eventsHostedCount: 0,
      isPublic: false,
      capacity: null,
      eventCount: 0,
      placeStatus: null,
      verificationStatus: null,
      listedInDirectory: false,
      orgSlug: null,
      orgStatus: null,
      memberCount: 0,
    };

    switch (doc.type) {
      case "event":
        return this.mapEventDocument(base, doc);
      case "human":
        return this.mapHumanDocument(base, doc);
      case "place":
        return this.mapPlaceDocument(base, doc);
      case "organization":
        return this.mapOrganizationDocument(base, doc);
      default:
        return base;
    }
  }

  private mapEventDocument(
    base: MeiliDocument,
    doc: EventSearchDocument,
  ): MeiliDocument {
    return {
      ...base,
      title: doc.title,
      subtitle: doc.venueName ?? doc.addressText,
      // In the event's zone, not the server's (UTC on Cloud Run).
      helper: doc.startsAt
        ? formatEventMonthDay(doc.startsAt, doc.timezone)
        : null,
      city: doc.city,
      regionCode: doc.regionCode,
      countryCode: doc.countryCode,
      _geo:
        doc.lat != null && doc.lng != null
          ? { lat: doc.lat, lng: doc.lng }
          : null,
      locationIsExact: doc.locationIsExact === true,
      locationRadiusMeters: doc.locationRadiusMeters ?? null,
      eventId: doc.eventId,
      // The event's venue IS a place; carry its id into placeId so the
      // placeIds filter can scope events by venue (mirrors the PG adapter).
      placeId: doc.venueId,
      slug: doc.slug,
      orgId: doc.orgId,
      ownerHumanId: doc.ownerHumanId,
      artists: doc.artists,
      tags: doc.tags,
      categoryNames: doc.categoryNames ?? [],
      venueName: doc.venueName,
      addressText: doc.addressText,
      summary: doc.summary ?? null,
      startsAt: doc.startsAt ? Math.floor(doc.startsAt.getTime() / 1000) : null,
      startsAtIso: doc.startsAt?.toISOString() ?? null,
      endsAt: doc.endsAt ? Math.floor(doc.endsAt.getTime() / 1000) : null,
      endsAtIso: doc.endsAt?.toISOString() ?? null,
      timezone: doc.timezone,
      eventStatus: doc.status,
      isPublic: doc.isPublic,
      popularityScore: doc.popularityScore,
      imageUrl: doc.imageUrl ?? null,
      lowestPriceCents: doc.lowestPriceCents ?? null,
      lowestBuyerTotalCents: doc.lowestBuyerTotalCents ?? null,
      currency: doc.currency ?? null,
      paidTierCount: doc.paidTierCount,
      hasFreeTier: doc.hasFreeTier,
      hasPayWhatYouWantTier: doc.hasPayWhatYouWantTier,
    };
  }

  private mapHumanDocument(
    base: MeiliDocument,
    doc: HumanSearchDocument,
  ): MeiliDocument {
    return {
      ...base,
      title: doc.displayName ?? doc.username ?? "Anonymous",
      subtitle: doc.bio,
      helper:
        doc.eventsHostedCount > 0 ? `${doc.eventsHostedCount} events` : null,
      city: doc.city,
      regionCode: doc.regionCode,
      countryCode: doc.countryCode,
      humanId: doc.humanId,
      username: doc.username,
      profileSlug: doc.profileSlug,
      eventsHostedCount: doc.eventsHostedCount,
      isPublic: doc.isPublic,
      popularityScore: doc.eventsHostedCount, // Use event count as popularity
    };
  }

  private mapPlaceDocument(
    base: MeiliDocument,
    doc: PlaceSearchDocument,
  ): MeiliDocument {
    return {
      ...base,
      title: doc.name,
      // Prefer the bio when populated — it's a richer search signal than
      // the address (which is already covered by city/regionCode and a
      // quick title-substring of "Brooklyn", "NYC", etc.). Fall back to
      // the formatted address so older venues without an EntityPage still
      // surface their location.
      // A withheld venue's street never becomes its subtitle: the document
      // is redacted at index time, but the fallback must not depend on that —
      // only an EXACT venue may fall back to its address (W5). The area
      // label is the only place string a withheld venue publishes.
      subtitle:
        doc.bio ??
        (doc.locationIsExact === true
          ? doc.formattedAddress
          : (doc.areaLabel ?? null)),
      helper: doc.capacity
        ? `Capacity: ${doc.capacity.toLocaleString()}`
        : null,
      city: doc.city,
      regionCode: doc.region,
      countryCode: doc.countryCode,
      _geo:
        doc.lat != null && doc.lng != null
          ? { lat: doc.lat, lng: doc.lng }
          : null,
      // Straight off the REDACTED document (`placeToDocument` runs
      // `redactPlaceLocation` first), so a withheld venue can only ever say
      // "not exact" here.
      locationIsExact: doc.locationIsExact === true,
      locationRadiusMeters: doc.locationRadiusMeters ?? null,
      placeId: doc.placeId,
      // A place writes NOTHING to the shared `slug` attribute (it stays null
      // from `base`): that used to carry the deprecated `Place.slug`, an
      // unroutable multi-segment directory key.
      //
      // `profileSlug` is the generic ENTITY-PAGE-SLUG field (a human's page
      // slug lives here too). Reused for the place's page slug — the ONLY
      // identifier `/places/[slug]` resolves on — so no new attribute has to
      // be added to `attributesToRetrieve`. Read back in `hitToSuggestion`.
      profileSlug: doc.pageSlug ?? null,
      capacity: doc.capacity,
      eventCount: doc.eventCount,
      placeStatus: doc.status,
      verificationStatus: doc.verificationStatus,
      listedInDirectory: doc.listedInDirectory,
      popularityScore: doc.eventCount, // Use event count as popularity
    };
  }

  private mapOrganizationDocument(
    base: MeiliDocument,
    doc: OrganizationSearchDocument,
  ): MeiliDocument {
    return {
      ...base,
      title: doc.name,
      // Bio is the only meaningful thing for users to search on. Fall back
      // to "X members" so the row still shows useful context when no bio
      // is set, but accept that nobody types "5 members" in the search box.
      subtitle:
        doc.bio ??
        (doc.memberCount > 0
          ? `${doc.memberCount} member${doc.memberCount === 1 ? "" : "s"}`
          : null),
      helper:
        doc.eventCount > 0
          ? `${doc.eventCount} event${doc.eventCount === 1 ? "" : "s"}`
          : null,
      orgIdRef: doc.orgId,
      orgSlug: doc.slug,
      orgStatus: doc.status,
      memberCount: doc.memberCount,
      eventCount: doc.eventCount,
      popularityScore: doc.eventCount + doc.memberCount, // Combined popularity
    };
  }

  private hitToSuggestion(
    hit: MeiliDocument,
    response: SearchResponse<MeiliDocument>,
  ): MultiSearchSuggestion {
    const confidence = this.calculateConfidence(hit, response);

    switch (hit.type) {
      case "event":
        return {
          type: "event",
          id: hit.id,
          eventId: hit.eventId!,
          title: hit.title,
          subtitle: hit.subtitle,
          helper: hit.helper,
          slug: hit.slug,
          startsAt: hit.startsAtIso ? new Date(hit.startsAtIso) : null,
          endsAt: hit.endsAtIso ? new Date(hit.endsAtIso) : null,
          timezone: hit.timezone ?? null,
          city: hit.city,
          region: hit.regionCode,
          location: hit.addressText,
          lat: hit._geo?.lat ?? null,
          lng: hit._geo?.lng ?? null,
          locationIsExact: hit.locationIsExact === true,
          locationRadiusMeters: hit.locationRadiusMeters ?? null,
          imageUrl: hit.imageUrl,
          lowestPriceCents: hit.lowestPriceCents ?? null,
          lowestBuyerTotalCents: hit.lowestBuyerTotalCents ?? null,
          currency: hit.currency ?? null,
          paidTierCount: hit.paidTierCount ?? 0,
          hasFreeTier: hit.hasFreeTier ?? false,
          hasPayWhatYouWantTier: hit.hasPayWhatYouWantTier ?? false,
          confidence,
        } satisfies EventSuggestion;

      case "human":
        return {
          type: "human",
          id: hit.id,
          humanId: hit.humanId!,
          title: hit.title,
          subtitle: hit.subtitle,
          helper: hit.helper,
          username: hit.username,
          profileSlug: hit.profileSlug,
          confidence,
        } satisfies HumanSuggestion;

      case "place":
        return {
          type: "place",
          id: hit.id,
          placeId: hit.placeId!,
          title: hit.title,
          subtitle: hit.subtitle,
          helper: hit.helper,
          // See mapPlaceDocument: a place's entity-page slug rides the shared
          // `profileSlug` field, and it is a place's only slug.
          pageSlug: hit.profileSlug ?? null,
          city: hit.city,
          capacity: hit.capacity,
          ...placeMapPosition(
            hit._geo?.lat ?? null,
            hit._geo?.lng ?? null,
            hit.locationIsExact,
            hit.locationRadiusMeters,
          ),
          confidence,
        } satisfies PlaceSuggestion;

      case "organization":
        return {
          type: "organization",
          id: hit.id,
          orgId: hit.orgIdRef!,
          title: hit.title,
          subtitle: hit.subtitle,
          helper: hit.helper,
          slug: hit.orgSlug!,
          eventCount: hit.eventCount,
          confidence,
        } satisfies OrganizationSuggestion;

      default:
        // Fallback - shouldn't happen
        return {
          type: "event",
          id: hit.id,
          eventId: hit.id,
          title: hit.title,
          subtitle: hit.subtitle,
          helper: hit.helper,
          slug: null,
          startsAt: null,
          endsAt: null,
          city: null,
          region: null,
          location: null,
          lat: null,
          lng: null,
          imageUrl: null,
          lowestPriceCents: null,
          lowestBuyerTotalCents: null,
          currency: null,
          paidTierCount: 0,
          hasFreeTier: false,
          hasPayWhatYouWantTier: false,
          confidence,
        } satisfies EventSuggestion;
    }
  }

  private buildSearchParams(
    filters: MultiSearchAutocompleteInput["filters"],
    base: SearchParams,
    sort?: MultiSearchSort,
  ): SearchParams {
    const filterClauses: string[] = [];

    if (filters) {
      // Type filter
      if (filters.types?.length) {
        const typeFilter = filters.types
          .map((t) => `type = ${meiliQuote(t)}`)
          .join(" OR ");
        filterClauses.push(`(${typeFilter})`);
      }

      // Only show published events (ignore for other types).
      // publishedOnly ASYMMETRY (deliberate, documented, no behavior change):
      // this adapter applies the PUBLISHED gate ONLY when `publishedOnly` is
      // truthy, whereas the Postgres adapter ALWAYS gates events to PUBLISHED.
      // Admin draft discovery does NOT flow through this path — it is served by
      // `adminOrgSearch` — so the divergence is harmless here.
      if (filters.publishedOnly) {
        filterClauses.push('(type != "event" OR eventStatus = "PUBLISHED")');
      }

      // Event visibility gate — PRIVATE events (isPublic = false) are excluded
      // by default. FAIL-CLOSED + OWNER-SCOPED, kept in LOCKSTEP with the
      // Postgres adapter: the gate is only relaxed when the caller opts into
      // includeNonPublicEvents AND supplies an owner scope (orgId or
      // ownerHumanId). When relaxed we drop the isPublic clause entirely and
      // rely on the orgId/ownerHumanId clauses below to constrain the surfaced
      // private events to that owner. A bare flag with no scope leaks nothing.
      const eventOwnerScoped = Boolean(filters.orgId || filters.ownerHumanId);
      const allowNonPublicEvents =
        Boolean(filters.includeNonPublicEvents) && eventOwnerScoped;
      if (!allowNonPublicEvents) {
        filterClauses.push('(type != "event" OR isPublic = true)');
      }

      // Only show public humans
      filterClauses.push('(type != "human" OR isPublic = true)');

      // Only show active places
      filterClauses.push('(type != "place" OR placeStatus = "ACTIVE")');

      // Directory listing filter
      if (filters.listedInDirectoryOnly) {
        filterClauses.push('(type != "place" OR listedInDirectory = true)');
      }

      // Region filter
      if (filters.regionCodes?.length) {
        const regionFilter = filters.regionCodes
          .map((r) => `regionCode = ${meiliQuote(r)}`)
          .join(" OR ");
        filterClauses.push(`(${regionFilter})`);
      }

      // Tags filter (used for category slugs, etc.) — scoped to events only
      if (filters.tags?.length) {
        const tagFilter = filters.tags
          .map((t) => `tags = ${meiliQuote(t)}`)
          .join(" OR ");
        filterClauses.push(`(type != "event" OR (${tagFilter}))`);
      }

      // Place filter — scope events to the given venue place ids. The event's
      // venue place id is carried on `placeId` (see mapEventDocument). Scoped to
      // events only; kept in LOCKSTEP with the Postgres `d.place_id = ANY(...)`.
      if (filters.placeIds?.length) {
        const placeFilter = filters.placeIds
          .map((id) => `placeId = ${meiliQuote(id)}`)
          .join(" OR ");
        filterClauses.push(`(type != "event" OR (${placeFilter}))`);
      }

      // Org scope filter — only event documents populate orgId
      if (filters.orgId) {
        filterClauses.push(
          `(type != "event" OR orgId = ${meiliQuote(filters.orgId)})`,
        );
      }

      // Owner human scope filter — only event documents populate ownerHumanId
      if (filters.ownerHumanId) {
        filterClauses.push(
          `(type != "event" OR ownerHumanId = ${meiliQuote(filters.ownerHumanId)})`,
        );
      }

      // Geo filter — scope events to the radius. The distance SORT is applied
      // below (buildMeiliSort) so it composes with the requested sort mode.
      if (filters.geo) {
        const radiusMeters = filters.geo.radiusKm * 1000;
        filterClauses.push(
          `_geoRadius(${filters.geo.lat}, ${filters.geo.lng}, ${radiusMeters})`,
        );
      }

      // Date range filter (expects ISO 8601 strings, converts to epoch seconds)
      if (filters.dateRange) {
        if (filters.dateRange.from) {
          const fromEpoch = Math.floor(
            new Date(filters.dateRange.from).getTime() / 1000,
          );
          filterClauses.push(`(type != "event" OR startsAt >= ${fromEpoch})`);
        }
        if (filters.dateRange.to) {
          const toEpoch = Math.floor(
            new Date(filters.dateRange.to).getTime() / 1000,
          );
          filterClauses.push(`(type != "event" OR startsAt <= ${toEpoch})`);
        }
      }

      // Price range filter (lowestBuyerTotalCents)
      if (filters.priceRange) {
        if (filters.priceRange.minCents != null) {
          filterClauses.push(
            `(type != "event" OR lowestBuyerTotalCents >= ${filters.priceRange.minCents})`,
          );
        }
        if (filters.priceRange.maxCents != null) {
          filterClauses.push(
            `(type != "event" OR lowestBuyerTotalCents <= ${filters.priceRange.maxCents})`,
          );
        }
      }

      // Free only filter
      if (filters.freeOnly) {
        filterClauses.push(
          `(type != "event" OR lowestBuyerTotalCents = 0 OR lowestBuyerTotalCents IS NULL)`,
        );
      }
    } else {
      // Default filters when none specified. No owner scope is possible here,
      // so the event visibility gate is always applied (fail closed).
      filterClauses.push('(type != "event" OR eventStatus = "PUBLISHED")');
      filterClauses.push('(type != "event" OR isPublic = true)');
      filterClauses.push('(type != "human" OR isPublic = true)');
      filterClauses.push('(type != "place" OR placeStatus = "ACTIVE")');
    }
    // Note: listedInDirectoryOnly is intentionally NOT applied in the default
    // (no-filters) path — directory filtering is only applied when explicitly
    // requested via filters.listedInDirectoryOnly.

    // Event ordering. Defaults to `relevance`, which preserves today's exact
    // behavior (distance sort when a geo filter is present, no sort otherwise).
    const sortSpec = buildMeiliSort(sort ?? "relevance", filters?.geo);

    return {
      ...base,
      filter:
        filterClauses.length > 0 ? filterClauses.join(" AND ") : undefined,
      ...(sortSpec ? { sort: sortSpec } : {}),
    };
  }

  private calculateConfidence(
    hit: MeiliDocument,
    response: SearchResponse<MeiliDocument>,
  ): number {
    // Meilisearch doesn't provide explicit scores, so we estimate based on position
    const position = response.hits.indexOf(hit);
    const total = response.hits.length;
    if (total <= 1) return 1;
    return Math.max(0.1, 1 - position / total);
  }

  private wrapError(e: unknown, operation: string): SearchPortError {
    const message =
      e instanceof Error ? e.message : "Unknown Meilisearch error";
    return new SearchPortErrorClass(
      "dependency_failed",
      `${operation}: ${message}`,
      {
        cause: e,
      },
    );
  }
}

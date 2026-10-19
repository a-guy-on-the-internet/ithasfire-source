/**
 * Multi-Index Search Types
 *
 * Extends the base search types to support searching across
 * multiple entity types: events, humans (profiles), places (venues), and organizations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entity Types
// ─────────────────────────────────────────────────────────────────────────────

export type SearchEntityType = "event" | "human" | "place" | "organization";

// ─────────────────────────────────────────────────────────────────────────────
// Document Types (what gets indexed)
// ─────────────────────────────────────────────────────────────────────────────

export interface EventSearchDocument {
  type: "event";
  id: string;
  eventId: string;
  slug: string | null;
  orgId: string | null;
  ownerType: "ORG" | "HUMAN";
  ownerHumanId: string | null;
  title: string;
  artists: string[];
  tags: string[];
  /**
   * The event's category name in every language it has (English first, then
   * each translation). SEARCHABLE TEXT only, at the lowest rank: never a tag
   * or a filter (the category slug in `tags` is the filter). Absent on a
   * document built before the field existed; read that as none.
   */
  categoryNames?: string[];
  venueId: string | null;
  venueName: string | null;
  addressText: string | null;
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
  /**
   * The PUBLIC projection's point (`projectPublicEventLocation`): the true pin
   * for an EXACT event, the keyed circle centre for an OBSCURED one, null when
   * hidden or gated.
   */
  lat: number | null;
  lng: number | null;
  /**
   * True only when the public projection is EXACT. A map draws a pin ONLY
   * for true; false with a radius is an approximate area (draw the circle,
   * never a pin); false with no radius is not drawn at all.
   */
  locationIsExact: boolean;
  /** The projection's drawn circle radius in metres; null unless a circle is published. */
  locationRadiusMeters: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * `Event.timezone` (IANA). The adapters format the result's date (`helper`,
   * "Oct 12") in this zone: the server runs in UTC, where a 7pm Chicago show
   * is already the next day.
   */
  timezone: string;
  status: "DRAFT" | "PUBLISHED" | "HIDDEN";
  /**
   * Event visibility, stamped from `Event.visibility` (PUBLIC → true, any other
   * value → false). Carried on the index so a later step can gate embed/widget
   * results at query time. NOTE: the indexer still EMITS non-public published
   * events (admin search needs them) — this flag only marks them.
   */
  isPublic: boolean;
  popularityScore: number;
  recencyScore: number;
  summary: string | null;
  /** Primary image URL for display */
  imageUrl: string | null;
  /**
   * Lowest ACTIVE ticket-tier price in cents. 0 when a free or floor-0
   * pay-what-you-want tier exists (`hasFreeTier` / `hasPayWhatYouWantTier`
   * pin it — see build-search-index.ts), the minimum PAID
   * price otherwise, and null ONLY when no ACTIVE tiers exist at all.
   * Treating 0 as "missing" here is a bug (it collapses "Free+" labels).
   */
  lowestPriceCents: number | null;
  /** Lowest buyer-facing all-in price in cents (fees + tax when applicable). */
  lowestBuyerTotalCents: number | null;
  /** ISO 4217 currency code for the event's pricing. */
  currency: string | null;
  /** Count of ACTIVE paid ticket tiers (priceCents > 0). Drives "$25" vs "$25+" labels. */
  paidTierCount: number;
  /**
   * True when at least one on-sale tier is genuinely free (fixed price 0). A
   * floor-0 pay-what-you-want tier does NOT set this; it sets
   * `hasPayWhatYouWantTier`.
   */
  hasFreeTier: boolean;
  /**
   * True when a pay-what-you-want tier with no minimum (floor 0) is on sale.
   * Listings say "Pay what you want" for it, never "Free" (owner ruling
   * 2026-10-06, F2). `lowestPriceCents` is still 0 for such an event.
   */
  hasPayWhatYouWantTier: boolean;
}

export interface HumanSearchDocument {
  type: "human";
  id: string;
  humanId: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  profileSlug: string | null;
  /** Event count for ranking */
  eventsHostedCount: number;
  /** Whether this user has a public profile */
  isPublic: boolean;
  /** Location for geo-aware search */
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
}

export interface PlaceSearchDocument {
  type: "place";
  id: string;
  placeId: string;
  name: string;
  /**
   * The place's EntityPage slug (flat, `{name}-{id8}`) — the ONLY identifier
   * `/places/[slug]` and `/p/[slug]` resolve on. Null for places with no
   * EntityPage row (places created before `upsertPlace` auto-provisioned one,
   * and bulk-imported venues), in which case callers must fall back to
   * `/places/id/{placeId}` rather than emit a known-404 link.
   *
   * Mirrors {@link HumanSearchDocument.profileSlug}, which is the same thing
   * for humans.
   */
  pageSlug: string | null;
  /**
   * REDACTED BEFORE INDEXING (`redactPlaceLocation` in `placeToDocument`).
   * Null for any venue that withholds its address.
   *
   * The search index is the single widest leak surface a place has: it is
   * queried anonymously, it is the autocomplete behind several pickers, and
   * documents survive in Meilisearch until something reindexes them. So the
   * withheld address never ENTERS the index — filtering it out at query time
   * would be one forgotten call site away from publishing the house.
   */
  formattedAddress: string | null;
  /** Coarse. Published for every venue — this is what keeps a withheld one findable. */
  city: string | null;
  region: string | null;
  countryCode: string | null;
  /**
   * True pin for an EXACT venue; the deterministically obfuscated circle
   * centre for an OBSCURED one with a radius; NULL when the venue is fully
   * hidden (it then ranks on text + `geohash6` alone).
   */
  lat: number | null;
  lng: number | null;
  /**
   * COARSE geohash (~1.2 km cell), exactly `redactPlaceLocation`'s `geohash6`:
   * the cell of the true point for an EXACT venue; for a withheld venue the
   * cell of the EMITTED circle centre (never the true point), and only while
   * the circle is smaller than a cell; null when the venue is fully hidden.
   * A FINE (geohash8, ~38 m) value is NEVER indexed for a place — 38 m is the
   * house.
   */
  geohash6: string | null;
  /** False when the venue withholds its address. Consumers must not draw a pin. */
  locationIsExact: boolean;
  /** True = fully hidden: no coordinates at all in this document. */
  locationHidden: boolean;
  /** Obfuscation circle radius in metres; null unless a circle is published. */
  locationRadiusMeters: number | null;
  /** Coarse area label — the only place string a withheld venue publishes. */
  areaLabel: string | null;
  capacity: number | null;
  /** Event count for ranking popular venues */
  eventCount: number;
  /** Optional bio/description from the place's EntityPage. */
  bio: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "PENDING" | "REJECTED";
  /** Whether this place appears in the public venue directory / autocomplete. */
  listedInDirectory: boolean;
}

export interface OrganizationSearchDocument {
  type: "organization";
  id: string;
  orgId: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  /** Number of events hosted by this organization (for ranking) */
  eventCount: number;
  /** Number of members in this organization */
  memberCount: number;
  /** Optional bio/description from the org's EntityPage. */
  bio: string | null;
}

export type MultiSearchDocument =
  | EventSearchDocument
  | HumanSearchDocument
  | PlaceSearchDocument
  | OrganizationSearchDocument;

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion Types (what autocomplete returns)
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseSearchSuggestion {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string | null;
  helper: string | null;
  confidence: number;
}

export interface EventSuggestion extends BaseSearchSuggestion {
  type: "event";
  eventId: string;
  slug: string | null;
  startsAt: Date | null;
  /** Event end timestamp (null when the event has no end). Rendered by the
   *  embed widgets alongside `startsAt`. */
  endsAt: Date | null;
  /**
   * `Event.timezone` (IANA), the zone `helper` was formatted in. OPTIONAL
   * because a document indexed before the field existed comes back without
   * it; the reader falls back to the platform default (`resolveTimeZone`).
   */
  timezone?: string | null;
  /** City (from the event's locality). */
  city: string | null;
  /** Region code (e.g. state/province) for the event's location. */
  region: string | null;
  /** Redacted public street/address text (already redacted for non-EXACT
   *  locations by the indexer). Rendered as the embed widgets' `location`. */
  location: string | null;
  /** Venue latitude (null when the event's venue has no geocoded pin). */
  lat: number | null;
  /** Venue longitude (null when the event's venue has no geocoded pin). */
  lng: number | null;
  /**
   * True only for an EXACT public location. OPTIONAL because a document
   * indexed before the field existed comes back without it; absent MUST be
   * read as false (fail closed — an approximate point is never drawn as a pin).
   */
  locationIsExact?: boolean;
  /** Drawn circle radius in metres for an approximate location; absent/null = no circle. */
  locationRadiusMeters?: number | null;
  /** Primary image URL for display */
  imageUrl: string | null;
  /** Lowest ticket-tier price in cents (null when unknown). */
  lowestPriceCents: number | null;
  /** Lowest buyer-facing all-in price in cents (null when unknown). */
  lowestBuyerTotalCents: number | null;
  /** ISO 4217 currency code. */
  currency: string | null;
  /** Count of ACTIVE paid ticket tiers. */
  paidTierCount: number;
  /** True when at least one ACTIVE ticket tier is genuinely free. */
  hasFreeTier: boolean;
  /**
   * True when a floor-0 pay-what-you-want tier is on sale. A document indexed
   * before the field existed reads false.
   */
  hasPayWhatYouWantTier: boolean;
}

export interface HumanSuggestion extends BaseSearchSuggestion {
  type: "human";
  humanId: string;
  username: string | null;
  profileSlug: string | null;
}

export interface PlaceSuggestion extends BaseSearchSuggestion {
  type: "place";
  placeId: string;
  /**
   * EntityPage slug — what `/places/[slug]` resolves on. Null ⇒ the venue has
   * no entity page; route to `/places/id/{placeId}` instead.
   *
   * A place has no other slug: `Place.slug` was a multi-segment directory key
   * that no route resolved, and it is deprecated.
   */
  pageSlug: string | null;
  city: string | null;
  capacity: number | null;
  /**
   * The INDEXED (already redacted) point: the true pin for an EXACT venue, the
   * keyed circle centre for an OBSCURED one, null when hidden. Nothing here is
   * read from anywhere but the redacted document.
   */
  lat: number | null;
  lng: number | null;
  /** True only for an EXACT venue. A stale document without it reads false. */
  locationIsExact: boolean;
  /** Drawn circle radius in metres; null unless an approximate circle is published. */
  locationRadiusMeters: number | null;
  /**
   * The venue publishes NO position at all (`redactPlaceLocation`'s `hidden`):
   * not exact and no point. Derived from the indexed document, so it matches
   * the redactor exactly once a row has been reindexed. False for an EXACT
   * venue with no coordinates (un-geocoded is not private) and for a stale
   * row that still has a point. Only this may be called "keeps its location
   * private".
   */
  locationHidden: boolean;
}

export interface OrganizationSuggestion extends BaseSearchSuggestion {
  type: "organization";
  orgId: string;
  slug: string;
  eventCount: number;
}

export type MultiSearchSuggestion =
  | EventSuggestion
  | HumanSuggestion
  | PlaceSuggestion
  | OrganizationSuggestion;

// ─────────────────────────────────────────────────────────────────────────────
// Query Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiSearchFilters {
  /** Filter to specific entity types */
  types?: SearchEntityType[];
  /** Geographic filter */
  geo?: { lat: number; lng: number; radiusKm: number };
  /** Region filter */
  regionCodes?: string[];
  /** Filter events by tags (e.g. category slugs). Matched with OR logic. */
  tags?: string[];
  /** Only return published events (ignored for other types) */
  publishedOnly?: boolean;
  /**
   * When true, non-public (PRIVATE) events are NOT excluded by the query-time
   * visibility gate. FAIL-CLOSED + OWNER-SCOPED: this flag is only honored by
   * the adapters when an owner scope (`orgId` or `ownerHumanId`) is ALSO
   * present, and the surfaced non-public events are constrained to that owner
   * by the owner-scope clauses. A bare flag with no owner scope leaks nothing —
   * the gate stays applied. Absent/false → PRIVATE events are always excluded.
   */
  includeNonPublicEvents?: boolean;
  /** When true, only return places that are listed in the public directory. */
  listedInDirectoryOnly?: boolean;
  /** Scope results to a specific org (events owned by this org). */
  orgId?: string;
  /** Scope results to a specific human owner (events owned by this human). */
  ownerHumanId?: string;
  /**
   * Filter events to those held at the given place ids (event.venue → place).
   * Matched with OR logic; ignored for non-event documents. Callers should cap
   * the array length (the use case bounds it to 50).
   */
  placeIds?: string[];
  /** Filter events by start-date range (ISO 8601 strings). */
  dateRange?: { from?: string; to?: string };
  /** Filter events by buyer-facing all-in price range in cents. */
  priceRange?: { minCents?: number; maxCents?: number };
  /** When true, only show events where the buyer-facing all-in price is 0 or null. */
  freeOnly?: boolean;
}

/**
 * Ordering directive for the EVENT rows an autocomplete/browse query returns.
 * Applies to event suggestions only; humans/places/orgs keep their existing
 * relative handling. The Postgres + Meilisearch adapters match on PRIMARY
 * ordering per mode; deep tiebreaks differ (PG carries explicit
 * `popularityScore DESC, title ASC` tails, Meili leans on its ranking rules and
 * has no `title` tiebreak). Prod runs SEARCH_BACKEND=postgres, so PG is
 * authoritative; the difference is only observable for equal-startsAt /
 * equal-distance events on the retired Meili backend.
 *
 * - `relevance` — DEFAULT. Exactly the pre-existing ranking (text-match score,
 *   then popularity, then title; distance leads when a geo filter is present).
 *   Every existing caller (typed text search, admin autocomplete) is unchanged.
 * - `date` — soonest-first (`startsAt ASC`), then nearer-first as a tiebreak
 *   when a geo filter is present, then popularity, then title. Browse surfaces.
 * - `distance` — nearest-first, then soonest as a tiebreak, then popularity,
 *   then title. Works off the `geo` lat/lng ALONE — no region filter required.
 *   If `distance` is requested WITHOUT a geo coordinate, distance is undefined,
 *   so the adapters gracefully fall back to `date` ordering (never error).
 * - `date_desc` — latest-first (`startsAt DESC`), then popularity, then title.
 * - `price_asc` / `price_desc` — by `lowestBuyerTotalCents` (the buyer-facing
 *   total, NOT the face price), then soonest, then title. Events with no price
 *   sort last in BOTH directions (NULLS LAST) rather than pretending to be
 *   free — an unpriced event is unknown, not cheapest.
 * - `popularity` — `popularityScore DESC`, then soonest, then title.
 *
 * `date` keeps its name rather than becoming `date_asc` so the six existing
 * browse callers (embeds, featured, tiered-popular, discover-by-category) need
 * no change.
 *
 * GUARD-RAIL: every non-`relevance` mode orders ALL rows on an event column, so
 * non-event rows (NULL startsAt / price) sink to the end. Only pass a
 * non-`relevance` sort on an event-scoped query — the transport enforces it.
 */
export type MultiSearchSort =
  | "relevance"
  | "date"
  | "date_desc"
  | "distance"
  | "price_asc"
  | "price_desc"
  | "popularity";

export interface MultiSearchAutocompleteInput {
  query: string;
  limit?: number;
  offset?: number;
  filters?: MultiSearchFilters;
  /**
   * How to order EVENT rows. Defaults to `relevance` (see {@link MultiSearchSort}).
   * Only BROWSE callers opt into `date`/`distance`; typed text search stays on
   * relevance so results keep their match ranking.
   */
  sort?: MultiSearchSort;
}

export interface MultiSearchAutocompleteOutput {
  suggestions: MultiSearchSuggestion[];
  latencyMs: number;
  estimatedTotalHits?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiSearchIndexInput {
  documents: MultiSearchDocument[];
  mode?: "merge" | "replace";
}

export interface MultiSearchIndexOutput {
  indexed: number;
  failed: number;
  failureReasons?: Record<string, string>;
}

export interface MultiSearchDeleteInput {
  /** Delete by document IDs */
  ids?: string[];
  /** Delete all documents of a specific type */
  type?: SearchEntityType;
  /** Delete events by org */
  orgId?: string;
  /** Delete events by owner human */
  ownerHumanId?: string;
}

export interface MultiSearchDeleteOutput {
  deleted: number;
}

/**
 * Opaque marker taken at the START of a full rebuild
 * (`MultiSearchIndexPort.beginSweep`). Every document written after it —
 * by the rebuild or by any concurrent incremental write — carries a write
 * marker at or after it, so the rebuild can delete exactly the documents
 * nobody rewrote (`deleteUnswept`).
 */
export interface SearchSweepToken {
  readonly marker: string;
}

export interface MultiSearchSweepInput {
  type: SearchEntityType;
  token: SearchSweepToken;
  /**
   * Document ids to keep even though they were not rewritten: entities whose
   * build failed this run (a content error) keep their previous document
   * rather than vanishing.
   */
  keepIds?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Index Stats
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiSearchIndexStats {
  events: { count: number; lastIndexedAt: Date | null };
  humans: { count: number; lastIndexedAt: Date | null };
  places: { count: number; lastIndexedAt: Date | null };
  organizations: { count: number; lastIndexedAt: Date | null };
}

import { Prisma, type PrismaClient } from "@prisma/client";
import { SEARCH_DOC_NOT_WITHHELD_SQL } from "../db/prisma/banned-owner";

import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type {
  EventSearchDocument,
  EventSuggestion,
  HumanSearchDocument,
  HumanSuggestion,
  MultiSearchAutocompleteInput,
  MultiSearchAutocompleteOutput,
  MultiSearchDeleteInput,
  MultiSearchDeleteOutput,
  MultiSearchSweepInput,
  SearchSweepToken,
  MultiSearchDocument,
  MultiSearchIndexInput,
  MultiSearchIndexOutput,
  MultiSearchIndexStats,
  MultiSearchSort,
  MultiSearchSuggestion,
  OrganizationSearchDocument,
  OrganizationSuggestion,
  PlaceSearchDocument,
  PlaceSuggestion,
  SearchEntityType,
} from "@th/ports/search/multi-index.types";
import {
  err,
  ok,
  SearchPortError as SearchPortErrorClass,
  type Result,
  type SearchHealthStatus,
  type SearchPortError,
} from "@th/ports/search";
import { formatEventMonthDay } from "@th/core/lib/event-local-date";

import { placeMapPosition } from "./place-map-position";

const DEFAULT_AUTOCOMPLETE_LIMIT = 10;
const UPSERT_BATCH_SIZE = 200;
const SIMILARITY_THRESHOLD = 0.18;
const STRICT_WORD_SIMILARITY_THRESHOLD = 0.5;
const STRICT_WORD_SIMILARITY_WITH_SIMILARITY_THRESHOLD = 0.35;

export interface MultiIndexPostgresAdapterWeights {
  fulltext: number;
  prefix: number;
  fuzzy: number;
  popularity: number;
  geo: number;
}

export interface MultiIndexPostgresAdapterOptions {
  prisma: PrismaClient;
  weights?: Partial<MultiIndexPostgresAdapterWeights>;
}

interface SearchDocumentRecord {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle: string | null;
  helper: string | null;
  imageUrl: string | null;
  eventId: string | null;
  humanId: string | null;
  placeId: string | null;
  orgIdRef: string | null;
  slug: string | null;
  username: string | null;
  profileSlug: string | null;
  orgSlug: string | null;
  startsAt: Date | null;
  // Selected by the autocomplete CTE and surfaced on the event suggestion so
  // the embed widgets can render the full event payload from search. Kept in
  // LOCKSTEP with the Meili adapter's `endsAtIso`.
  endsAt: Date | null;
  // `Event.timezone` (IANA), the zone `helper` was formatted in. Kept in
  // LOCKSTEP with the Meili adapter's `timezone`. Rows written before the
  // column existed read null (reader falls back to the platform default).
  timezone: string | null;
  // Selected by the autocomplete CTE and surfaced as the suggestion's
  // `location`. Already redacted upstream for non-EXACT locations by the indexer
  // (`publicEventAddressText`), same as the Meili `addressText`.
  addressText: string | null;
  eventStatus: string | null;
  regionCode: string | null;
  countryCode: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  // How to DRAW lat/lng (events + places): a pin only when true, a circle of
  // `locationRadiusMeters` otherwise. Straight off the redacted document.
  // Rows written before the columns existed read false / null (fail closed).
  locationIsExact: boolean;
  locationRadiusMeters: number | null;
  tags: string[];
  /** Category names in every language; weight D of `search_vector`. */
  categoryNames: string[];
  artists: string[];
  venueName: string | null;
  orgId: string | null;
  ownerHumanId: string | null;
  summary: string | null;
  popularityScore: number;
  lowestPriceCents: number | null;
  lowestBuyerTotalCents: number | null;
  currency: string | null;
  paidTierCount: number;
  hasFreeTier: boolean;
  hasPayWhatYouWantTier: boolean;
  isPublic: boolean;
  eventsHostedCount: number;
  capacity: number | null;
  eventCount: number;
  placeStatus: string | null;
  verificationStatus: string | null;
  listedInDirectory: boolean;
  orgStatus: string | null;
  memberCount: number;
}

interface SearchDocumentRow extends SearchDocumentRecord {
  score: number;
  totalCount: number;
}

interface StatsRow {
  type: SearchEntityType;
  count: number;
  lastIndexedAt: Date | null;
}

const defaultWeights: MultiIndexPostgresAdapterWeights = {
  fulltext: 1.0,
  prefix: 0.7,
  fuzzy: 0.5,
  popularity: 0.05,
  geo: 1.0,
};

export class MultiIndexPostgresAdapter implements MultiSearchPort {
  /** The index is the `SearchDocument` table: writes can join a transaction. */
  readonly indexLivesInPrimaryDatabase = true;
  private readonly prisma: PrismaClient;
  private readonly weights: MultiIndexPostgresAdapterWeights;

  constructor(options: MultiIndexPostgresAdapterOptions) {
    this.prisma = options.prisma;
    this.weights = { ...defaultWeights, ...(options.weights ?? {}) };
  }

  async autocomplete(
    input: MultiSearchAutocompleteInput,
  ): Promise<Result<MultiSearchAutocompleteOutput, SearchPortError>> {
    const start = Date.now();
    const query = input.query.trim();
    const filters = input.filters;
    const limit = Math.max(0, input.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT);
    const offset = Math.max(0, input.offset ?? 0);
    // Distance ordering needs a coordinate. When `distance` is requested but no
    // geo is supplied, distance is undefined for every row, so fall back to
    // `date` ordering (soonest-first) rather than returning arbitrary order.
    // Kept in LOCKSTEP with the Meilisearch adapter's identical fallback.
    const effectiveSort = resolveEffectiveSort(input.sort, filters?.geo);
    // Browse-all (no query, relevance, several types): rank within each type so
    // a page interleaves them. See `buildOrderByClause`.
    const interleaveTypes =
      effectiveSort === "relevance" &&
      query === "" &&
      (filters?.types?.length ?? 0) !== 1;

    try {
      const rows = await this.prisma.$queryRaw<SearchDocumentRow[]>(Prisma.sql`
        WITH raw_params AS (
          SELECT
            search_unaccent(${query}::text) AS q,
            ${filters?.geo?.lat ?? null}::double precision AS geo_lat,
            ${filters?.geo?.lng ?? null}::double precision AS geo_lng,
            ${filters?.geo ? filters.geo.radiusKm * 1000 : null}::double precision AS geo_radius_m,
            ${toNullableArray(filters?.types)}::text[] AS types,
            ${toNullableArray(filters?.regionCodes)}::text[] AS region_codes,
            ${filters?.dateRange?.from ?? null}::timestamptz AS date_from,
            ${filters?.dateRange?.to ?? null}::timestamptz AS date_to,
            ${filters?.priceRange?.minCents ?? null}::int AS price_min_cents,
            ${filters?.priceRange?.maxCents ?? null}::int AS price_max_cents,
            ${filters?.freeOnly ?? false}::boolean AS free_only,
            ${toNullableArray(filters?.tags)}::text[] AS tags,
            ${toNullableArray(filters?.placeIds)}::text[] AS place_ids,
            ${filters?.orgId ?? null}::text AS org_id,
            ${filters?.ownerHumanId ?? null}::text AS owner_human_id,
            ${filters?.includeNonPublicEvents ?? false}::boolean AS include_non_public,
            ${filters?.listedInDirectoryOnly ?? false}::boolean AS listed_in_directory_only,
            ${limit}::int AS limit_count,
            ${offset}::int AS offset_count,
            ${this.weights.fulltext}::double precision AS w_fulltext,
            ${this.weights.prefix}::double precision AS w_prefix,
            ${this.weights.fuzzy}::double precision AS w_fuzzy,
            ${this.weights.popularity}::double precision AS w_popularity,
            ${this.weights.geo}::double precision AS w_geo
        ),
        params AS (
          SELECT
            raw_params.*,
            CASE
              WHEN raw_params.q = '' THEN NULL
              ELSE websearch_to_tsquery('simple', raw_params.q)
            END AS fulltext_query,
            CASE
              WHEN raw_params.q = '' THEN NULL
              ELSE (
                SELECT to_tsquery('simple', prefix_text)
                FROM (
                  SELECT string_agg(quote_literal(parts.token) || ':*', ' & ') AS prefix_text
                  FROM regexp_split_to_table(
                    regexp_replace(raw_params.q, '[^[:alnum:][:space:]]', ' ', 'g'),
                    '[[:space:]]+'
                  ) AS parts(token)
                  WHERE parts.token <> ''
                ) prefix_parts
                WHERE prefix_text IS NOT NULL
              )
            END AS prefix_query,
            -- Tokens the trigram arms can judge (3+ chars); NULL when none.
            (
              SELECT array_agg(parts.token)
              FROM regexp_split_to_table(
                regexp_replace(raw_params.q, '[^[:alnum:][:space:]]', ' ', 'g'),
                '[[:space:]]+'
              ) AS parts(token)
              WHERE length(parts.token) >= 3
            ) AS fuzzy_tokens
          FROM raw_params
        ),
        -- Every row past the non-text filters, with how it meets the query.
        -- The text match itself is decided in \`matched\`, because the trigram
        -- arm compares each row against the best row (\`max_token_hits\`).
        candidates AS (
          SELECT
            d.id,
            d.type,
            d.title,
            d.subtitle,
            d.helper,
            d.image_url AS "imageUrl",
            d.event_id AS "eventId",
            d.human_id AS "humanId",
            d.place_id AS "placeId",
            d.org_id_ref AS "orgIdRef",
            d.slug,
            d.username,
            d.profile_slug AS "profileSlug",
            d.org_slug AS "orgSlug",
            d.starts_at AS "startsAt",
            d.ends_at AS "endsAt",
            d.timezone,
            d.address_text AS "addressText",
            d.event_status AS "eventStatus",
            d.region_code AS "regionCode",
            d.country_code AS "countryCode",
            d.city,
            d.lat,
            d.lng,
            d.location_is_exact AS "locationIsExact",
            d.location_radius_meters AS "locationRadiusMeters",
            d.tags,
            d.artists,
            d.venue_name AS "venueName",
            d.org_id AS "orgId",
            d.owner_human_id AS "ownerHumanId",
            d.summary,
            d.popularity_score AS "popularityScore",
            d.lowest_price_cents AS "lowestPriceCents",
            d.lowest_buyer_total_cents AS "lowestBuyerTotalCents",
            d.currency,
            d.paid_tier_count AS "paidTierCount",
            d.has_free_tier AS "hasFreeTier",
            d.has_pay_what_you_want_tier AS "hasPayWhatYouWantTier",
            d.is_public AS "isPublic",
            d.events_hosted_count AS "eventsHostedCount",
            d.capacity,
            d.event_count AS "eventCount",
            d.place_status AS "placeStatus",
            d.verification_status AS "verificationStatus",
            d.listed_in_directory AS "listedInDirectory",
            d.org_status AS "orgStatus",
            d.member_count AS "memberCount",
            hit.whole_query_hit,
            hit.token_hits,
            -- Per type: in the All scope an event matching more words must not
            -- hide a place that matches fewer.
            MAX(hit.token_hits) OVER (PARTITION BY d.type) AS max_token_hits,
            -- Only a row that can still match is worth scoring.
            CASE WHEN hit.whole_query_hit OR hit.token_hits >= 1 THEN (
              CASE
                WHEN p.q = '' OR p.fulltext_query IS NULL THEN 0
                ELSE ts_rank_cd(d.search_vector, p.fulltext_query) * p.w_fulltext
              END
              + CASE
                WHEN p.q = '' OR p.prefix_query IS NULL THEN 0
                ELSE ts_rank_cd(d.search_vector, p.prefix_query) * p.w_prefix
              END
              + CASE
                WHEN p.q = '' THEN 0
                ELSE GREATEST(
                  similarity(d.trigram_corpus, p.q),
                  power(strict_word_similarity(p.q, d.trigram_corpus), 2)
                ) * p.w_fuzzy
              END
              + ln(1 + GREATEST(d.popularity_score, 0)) * p.w_popularity
              + CASE
                WHEN geo.distance_km IS NULL THEN 0
                ELSE (1.0 / (1.0 + geo.distance_km)) * p.w_geo
              END
            ) ELSE 0 END::double precision AS score,
            geo.distance_km,
            p.geo_radius_m IS NOT NULL AS has_geo
          FROM "SearchDocument" d
          CROSS JOIN params p
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN p.geo_lat IS NULL OR p.geo_lng IS NULL OR d.geo_point IS NULL THEN NULL
              ELSE earth_distance(d.geo_point, ll_to_earth(p.geo_lat, p.geo_lng)) / 1000.0
            END AS distance_km
          ) geo
          -- OFFSET 0 keeps the planner from inlining these expressions into
          -- each place that reads them (score, window, output) and running the
          -- trigram tests more than once per row.
          CROSS JOIN LATERAL (
            SELECT
              COALESCE(
                p.q = ''
                OR d.search_vector @@ p.fulltext_query
                OR (p.prefix_query IS NOT NULL AND d.search_vector @@ p.prefix_query)
                OR (
                  p.fuzzy_tokens IS NULL
                  AND (
                    d.trigram_corpus % p.q
                    OR strict_word_similarity(p.q, d.trigram_corpus) >= ${STRICT_WORD_SIMILARITY_THRESHOLD}
                    OR (
                      similarity(d.trigram_corpus, p.q) >= ${SIMILARITY_THRESHOLD}
                      AND strict_word_similarity(p.q, d.trigram_corpus) >= ${STRICT_WORD_SIMILARITY_WITH_SIMILARITY_THRESHOLD}
                    )
                  )
                ),
                FALSE
              ) AS whole_query_hit,
              CASE
                WHEN p.fuzzy_tokens IS NULL THEN 0
                ELSE (
                  SELECT COUNT(*)::int
                  FROM unnest(p.fuzzy_tokens) AS t(token)
                  WHERE
                    COALESCE(d.trigram_corpus, '') % t.token
                    OR strict_word_similarity(t.token, COALESCE(d.trigram_corpus, '')) >= ${STRICT_WORD_SIMILARITY_THRESHOLD}
                    OR (
                      similarity(COALESCE(d.trigram_corpus, ''), t.token) >= ${SIMILARITY_THRESHOLD}
                      AND strict_word_similarity(t.token, COALESCE(d.trigram_corpus, '')) >= ${STRICT_WORD_SIMILARITY_WITH_SIMILARITY_THRESHOLD}
                    )
                )
              END AS token_hits
            OFFSET 0
          ) hit
          WHERE
            -- publishedOnly ASYMMETRY (deliberate, documented, no behavior
            -- change): this adapter ALWAYS gates events to event_status =
            -- 'PUBLISHED' regardless of the caller publishedOnly flag,
            -- whereas the Meili adapter only applies the PUBLISHED gate when
            -- publishedOnly is truthy. Admin draft discovery does NOT flow
            -- through this path — it is served by adminOrgSearch — so the
            -- divergence is harmless here. Kept as-is to avoid changing the
            -- public event-visibility guarantee.
            (d.type != 'event' OR d.event_status = 'PUBLISHED')
            AND (d.type != 'human' OR d.is_public = TRUE)
            AND (d.type != 'place' OR d.place_status = 'ACTIVE')
            -- Ban that sticks (2026-09-29): a BANNED human's profile, an org
            -- whose every OWNER is banned, and those owners' events are
            -- withheld. Derived from Human.status at query time — no reindex
            -- on ban or reactivation. Same withheld set as the list reads
            -- (db/prisma/banned-owner.ts), evaluated once per query.
            AND ${SEARCH_DOC_NOT_WITHHELD_SQL}
            -- Event visibility gate. PRIVATE (is_public = FALSE) events are
            -- excluded by default. They are only surfaced when the caller opts
            -- into include_non_public AND supplies an owner scope (org_id or
            -- owner_human_id); the owner-scope clauses below then constrain the
            -- surfaced private events to that owner. A bare include_non_public
            -- with no scope leaks nothing (fail closed) — must stay in LOCKSTEP
            -- with the Meili adapter's event isPublic gate.
            AND (
              d.type != 'event'
              OR d.is_public = TRUE
              OR (
                p.include_non_public = TRUE
                AND (p.org_id IS NOT NULL OR p.owner_human_id IS NOT NULL)
              )
            )
            AND (p.types IS NULL OR d.type = ANY(p.types))
            AND (p.region_codes IS NULL OR d.region_code = ANY(p.region_codes))
            AND (p.date_from IS NULL OR d.type != 'event' OR d.starts_at >= p.date_from)
            AND (p.date_to IS NULL OR d.type != 'event' OR d.starts_at <= p.date_to)
            AND (p.price_min_cents IS NULL OR d.type != 'event' OR d.lowest_buyer_total_cents >= p.price_min_cents)
            AND (p.price_max_cents IS NULL OR d.type != 'event' OR d.lowest_buyer_total_cents <= p.price_max_cents)
            AND (p.free_only = FALSE OR d.type != 'event' OR d.lowest_buyer_total_cents = 0 OR d.lowest_buyer_total_cents IS NULL)
            AND (p.tags IS NULL OR d.type != 'event' OR d.tags && p.tags)
            AND (p.place_ids IS NULL OR d.type != 'event' OR d.place_id = ANY(p.place_ids))
            AND (p.org_id IS NULL OR d.type != 'event' OR d.org_id = p.org_id)
            AND (p.owner_human_id IS NULL OR d.type != 'event' OR d.owner_human_id = p.owner_human_id)
            AND (p.listed_in_directory_only = FALSE OR d.type != 'place' OR d.listed_in_directory = TRUE)
            AND (
              p.geo_radius_m IS NULL
              OR (
                d.geo_point IS NOT NULL
                AND earth_box(ll_to_earth(p.geo_lat, p.geo_lng), p.geo_radius_m) @> d.geo_point
                AND earth_distance(d.geo_point, ll_to_earth(p.geo_lat, p.geo_lng)) <= p.geo_radius_m
              )
            )
        ),
        -- The trigram (typo-tolerance) arm judges each word of 3+ chars on its
        -- own and keeps the rows that match the most words. Judged as one
        -- string, a city word every place carries ("Cobra Nashville") matched
        -- the whole directory; requiring every word instead would empty the
        -- page over one extra word ("Cobra bar"). "Most words" does neither,
        -- and is the strict result whenever some row has them all. The best
        -- count is taken over the whole filtered set, so every page agrees.
        -- Shorter words ("in", "DJ") are skipped; with none left, the whole
        -- query is judged as one string (\`whole_query_hit\`).
        matched AS (
          SELECT *
          FROM candidates c
          WHERE c.whole_query_hit
            OR (c.token_hits >= 1 AND c.token_hits = c.max_token_hits)
        )
        SELECT
          matched.*,
          COUNT(*) OVER()::int AS "totalCount"
        FROM matched
        ORDER BY ${buildOrderByClause(effectiveSort, interleaveTypes)}
        LIMIT (SELECT limit_count FROM params)
        OFFSET (SELECT offset_count FROM params)
      `);

      const suggestions = rows.map((row) => this.rowToSuggestion(row, rows));

      return ok({
        suggestions,
        latencyMs: Date.now() - start,
        estimatedTotalHits: rows[0]?.totalCount ?? 0,
      });
    } catch (e) {
      return err(this.wrapError(e, "autocomplete"));
    }
  }

  async health(): Promise<SearchHealthStatus> {
    try {
      await this.prisma.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM "SearchDocument" LIMIT 1
      `;
      return { ok: true, details: { backend: "postgres" } };
    } catch (e) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          error:
            e instanceof Error ? e.message : "Unknown Postgres search error",
        },
      };
    }
  }

  async upsertDocuments(
    input: MultiSearchIndexInput,
  ): Promise<Result<MultiSearchIndexOutput, SearchPortError>> {
    if (input.documents.length === 0) {
      return ok({ indexed: 0, failed: 0 });
    }

    try {
      for (
        let index = 0;
        index < input.documents.length;
        index += UPSERT_BATCH_SIZE
      ) {
        const batch = input.documents
          .slice(index, index + UPSERT_BATCH_SIZE)
          .map((doc) => this.toRecord(doc));
        await this.upsertBatch(batch);
      }

      return ok({ indexed: input.documents.length, failed: 0 });
    } catch (e) {
      return err(this.wrapError(e, "upsertDocuments"));
    }
  }

  async deleteDocuments(
    input: MultiSearchDeleteInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>> {
    const ids = toNullableArray(input.ids);
    const hasSelector =
      ids !== null || input.type || input.orgId || input.ownerHumanId;
    if (!hasSelector) {
      return ok({ deleted: 0 });
    }

    try {
      const deleted = await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "SearchDocument"
        WHERE
          (${ids}::text[] IS NOT NULL AND id = ANY(${ids}::text[]))
          OR (${input.type ?? null}::text IS NOT NULL AND type = ${input.type ?? null}::text)
          OR (${input.orgId ?? null}::text IS NOT NULL AND org_id = ${input.orgId ?? null}::text)
          OR (${input.ownerHumanId ?? null}::text IS NOT NULL AND owner_human_id = ${input.ownerHumanId ?? null}::text)
      `);

      return ok({ deleted });
    } catch (e) {
      return err(this.wrapError(e, "deleteDocuments"));
    }
  }

  async beginSweep(): Promise<Result<SearchSweepToken, SearchPortError>> {
    try {
      // Text keeps the microseconds a JS Date would drop.
      const rows = await this.prisma.$queryRaw<Array<{ marker: string }>>`
        SELECT clock_timestamp()::text AS marker
      `;
      return ok({ marker: rows[0]!.marker });
    } catch (e) {
      return err(this.wrapError(e, "beginSweep"));
    }
  }

  async deleteUnswept(
    input: MultiSearchSweepInput,
  ): Promise<Result<MultiSearchDeleteOutput, SearchPortError>> {
    const keep = input.keepIds ?? [];
    try {
      // A row an uncommitted concurrent write is rewriting is locked: this
      // DELETE waits, then re-checks the WHERE against the committed row
      // (READ COMMITTED), whose fresh marker keeps it.
      const deleted = await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "SearchDocument"
        WHERE type = ${input.type}::text
          AND (indexed_marker IS NULL
               OR indexed_marker < ${input.token.marker}::timestamptz)
          AND NOT (id = ANY(${keep}::text[]))
      `);
      return ok({ deleted });
    } catch (e) {
      return err(this.wrapError(e, "deleteUnswept"));
    }
  }

  async getStats(): Promise<Result<MultiSearchIndexStats, SearchPortError>> {
    try {
      const rows = await this.prisma.$queryRaw<StatsRow[]>`
        SELECT
          type,
          COUNT(*)::int AS count,
          MAX(indexed_at) AS "lastIndexedAt"
        FROM "SearchDocument"
        GROUP BY type
      `;

      return ok(buildStats(rows));
    } catch (e) {
      return err(this.wrapError(e, "getStats"));
    }
  }

  async ensureIndexes(): Promise<Result<void, SearchPortError>> {
    return ok(undefined);
  }

  private async upsertBatch(records: SearchDocumentRecord[]): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "SearchDocument" (
        id,
        type,
        title,
        subtitle,
        helper,
        image_url,
        event_id,
        human_id,
        place_id,
        org_id_ref,
        slug,
        username,
        profile_slug,
        org_slug,
        starts_at,
        ends_at,
        timezone,
        address_text,
        event_status,
        region_code,
        country_code,
        city,
        lat,
        lng,
        location_is_exact,
        location_radius_meters,
        tags,
        category_names,
        artists,
        venue_name,
        org_id,
        owner_human_id,
        summary,
        popularity_score,
        lowest_price_cents,
        lowest_buyer_total_cents,
        currency,
        paid_tier_count,
        has_free_tier,
        has_pay_what_you_want_tier,
        is_public,
        events_hosted_count,
        capacity,
        event_count,
        place_status,
        verification_status,
        listed_in_directory,
        org_status,
        member_count,
        indexed_at
      ) VALUES ${Prisma.join(records.map((record) => recordToSql(record)))}
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        subtitle = EXCLUDED.subtitle,
        helper = EXCLUDED.helper,
        image_url = EXCLUDED.image_url,
        event_id = EXCLUDED.event_id,
        human_id = EXCLUDED.human_id,
        place_id = EXCLUDED.place_id,
        org_id_ref = EXCLUDED.org_id_ref,
        slug = EXCLUDED.slug,
        username = EXCLUDED.username,
        profile_slug = EXCLUDED.profile_slug,
        org_slug = EXCLUDED.org_slug,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        timezone = EXCLUDED.timezone,
        address_text = EXCLUDED.address_text,
        event_status = EXCLUDED.event_status,
        region_code = EXCLUDED.region_code,
        country_code = EXCLUDED.country_code,
        city = EXCLUDED.city,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        location_is_exact = EXCLUDED.location_is_exact,
        location_radius_meters = EXCLUDED.location_radius_meters,
        tags = EXCLUDED.tags,
        category_names = EXCLUDED.category_names,
        artists = EXCLUDED.artists,
        venue_name = EXCLUDED.venue_name,
        org_id = EXCLUDED.org_id,
        owner_human_id = EXCLUDED.owner_human_id,
        summary = EXCLUDED.summary,
        popularity_score = EXCLUDED.popularity_score,
        lowest_price_cents = EXCLUDED.lowest_price_cents,
        lowest_buyer_total_cents = EXCLUDED.lowest_buyer_total_cents,
        currency = EXCLUDED.currency,
        paid_tier_count = EXCLUDED.paid_tier_count,
        has_free_tier = EXCLUDED.has_free_tier,
        has_pay_what_you_want_tier = EXCLUDED.has_pay_what_you_want_tier,
        is_public = EXCLUDED.is_public,
        events_hosted_count = EXCLUDED.events_hosted_count,
        capacity = EXCLUDED.capacity,
        event_count = EXCLUDED.event_count,
        place_status = EXCLUDED.place_status,
        verification_status = EXCLUDED.verification_status,
        listed_in_directory = EXCLUDED.listed_in_directory,
        org_status = EXCLUDED.org_status,
        member_count = EXCLUDED.member_count,
        indexed_at = EXCLUDED.indexed_at,
        -- Non-destructive full rebuild: the DB clock at THIS write (an insert
        -- gets it from the column default). See deleteUnswept.
        indexed_marker = clock_timestamp()
    `);
  }

  private toRecord(doc: MultiSearchDocument): SearchDocumentRecord {
    const base: SearchDocumentRecord = {
      id: doc.id,
      type: doc.type,
      title: "",
      subtitle: null,
      helper: null,
      imageUrl: null,
      eventId: null,
      humanId: null,
      placeId: null,
      orgIdRef: null,
      slug: null,
      username: null,
      profileSlug: null,
      orgSlug: null,
      startsAt: null,
      endsAt: null,
      timezone: null,
      addressText: null,
      eventStatus: null,
      regionCode: null,
      countryCode: null,
      city: null,
      lat: null,
      lng: null,
      locationIsExact: false,
      locationRadiusMeters: null,
      tags: [],
      categoryNames: [],
      artists: [],
      venueName: null,
      orgId: null,
      ownerHumanId: null,
      summary: null,
      popularityScore: 0,
      lowestPriceCents: null,
      lowestBuyerTotalCents: null,
      currency: null,
      paidTierCount: 0,
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      isPublic: false,
      eventsHostedCount: 0,
      capacity: null,
      eventCount: 0,
      placeStatus: null,
      verificationStatus: null,
      listedInDirectory: false,
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
    base: SearchDocumentRecord,
    doc: EventSearchDocument,
  ): SearchDocumentRecord {
    return {
      ...base,
      title: doc.title,
      subtitle: doc.venueName ?? doc.addressText,
      // In the event's zone: this string is persisted, and the server runs
      // in UTC, where a 7pm Chicago show is already tomorrow.
      helper: doc.startsAt
        ? formatEventMonthDay(doc.startsAt, doc.timezone)
        : null,
      imageUrl: doc.imageUrl ?? null,
      eventId: doc.eventId,
      // The event's venue IS a place; carry its id into place_id so the
      // placeIds filter (`d.place_id = ANY(...)`) can scope events by venue.
      placeId: doc.venueId,
      slug: doc.slug,
      startsAt: doc.startsAt,
      endsAt: doc.endsAt,
      timezone: doc.timezone,
      addressText: doc.addressText,
      eventStatus: doc.status,
      regionCode: doc.regionCode,
      countryCode: doc.countryCode,
      city: doc.city,
      lat: doc.lat,
      lng: doc.lng,
      locationIsExact: doc.locationIsExact === true,
      locationRadiusMeters: doc.locationRadiusMeters ?? null,
      tags: doc.tags,
      categoryNames: doc.categoryNames ?? [],
      artists: doc.artists,
      venueName: doc.venueName,
      orgId: doc.orgId,
      ownerHumanId: doc.ownerHumanId,
      summary: doc.summary ?? null,
      popularityScore: doc.popularityScore,
      lowestPriceCents: doc.lowestPriceCents ?? null,
      lowestBuyerTotalCents: doc.lowestBuyerTotalCents ?? null,
      currency: doc.currency ?? null,
      paidTierCount: doc.paidTierCount,
      hasFreeTier: doc.hasFreeTier,
      hasPayWhatYouWantTier: doc.hasPayWhatYouWantTier,
      isPublic: doc.isPublic,
    };
  }

  private mapHumanDocument(
    base: SearchDocumentRecord,
    doc: HumanSearchDocument,
  ): SearchDocumentRecord {
    return {
      ...base,
      title: doc.displayName ?? doc.username ?? "Anonymous",
      subtitle: doc.bio,
      helper:
        doc.eventsHostedCount > 0 ? `${doc.eventsHostedCount} events` : null,
      humanId: doc.humanId,
      username: doc.username,
      profileSlug: doc.profileSlug,
      city: doc.city,
      regionCode: doc.regionCode,
      countryCode: doc.countryCode,
      eventsHostedCount: doc.eventsHostedCount,
      isPublic: doc.isPublic,
      popularityScore: doc.eventsHostedCount,
    };
  }

  private mapPlaceDocument(
    base: SearchDocumentRecord,
    doc: PlaceSearchDocument,
  ): SearchDocumentRecord {
    return {
      ...base,
      title: doc.name,
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
      placeId: doc.placeId,
      // A place writes NOTHING to the shared `slug` column (it stays null from
      // `base`): that used to carry the deprecated `Place.slug`, an unroutable
      // multi-segment directory key.
      //
      // `profile_slug` is the generic ENTITY-PAGE-SLUG column: for a human it
      // holds their EntityPage slug, and a place's page slug is the same
      // thing. Reused deliberately so places get a routable identifier on the
      // index without a schema migration. Read back out in `rowToSuggestion`
      // as `pageSlug`.
      profileSlug: doc.pageSlug ?? null,
      city: doc.city,
      regionCode: doc.region,
      countryCode: doc.countryCode,
      lat: doc.lat,
      lng: doc.lng,
      // Straight off the REDACTED document (`placeToDocument` runs
      // `redactPlaceLocation` first), so a withheld venue can only ever say
      // "not exact" here.
      locationIsExact: doc.locationIsExact === true,
      locationRadiusMeters: doc.locationRadiusMeters ?? null,
      capacity: doc.capacity,
      eventCount: doc.eventCount,
      placeStatus: doc.status,
      verificationStatus: doc.verificationStatus,
      listedInDirectory: doc.listedInDirectory,
      popularityScore: doc.eventCount,
    };
  }

  private mapOrganizationDocument(
    base: SearchDocumentRecord,
    doc: OrganizationSearchDocument,
  ): SearchDocumentRecord {
    return {
      ...base,
      title: doc.name,
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
      eventCount: doc.eventCount,
      memberCount: doc.memberCount,
      popularityScore: doc.eventCount + doc.memberCount,
    };
  }

  private rowToSuggestion(
    row: SearchDocumentRow,
    rows: SearchDocumentRow[],
  ): MultiSearchSuggestion {
    const confidence = calculateConfidence(row, rows);

    switch (row.type) {
      case "event":
        return {
          type: "event",
          id: row.id,
          eventId: row.eventId!,
          title: row.title,
          subtitle: row.subtitle,
          helper: row.helper,
          slug: row.slug,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          timezone: row.timezone ?? null,
          city: row.city,
          region: row.regionCode,
          location: row.addressText,
          lat: row.lat,
          lng: row.lng,
          locationIsExact: row.locationIsExact === true,
          locationRadiusMeters: row.locationRadiusMeters ?? null,
          imageUrl: row.imageUrl,
          lowestPriceCents: row.lowestPriceCents ?? null,
          lowestBuyerTotalCents: row.lowestBuyerTotalCents ?? null,
          currency: row.currency ?? null,
          paidTierCount: row.paidTierCount ?? 0,
          hasFreeTier: row.hasFreeTier ?? false,
          hasPayWhatYouWantTier: row.hasPayWhatYouWantTier ?? false,
          confidence,
        } satisfies EventSuggestion;

      case "human":
        return {
          type: "human",
          id: row.id,
          humanId: row.humanId!,
          title: row.title,
          subtitle: row.subtitle,
          helper: row.helper,
          username: row.username,
          profileSlug: row.profileSlug,
          confidence,
        } satisfies HumanSuggestion;

      case "place":
        return {
          type: "place",
          id: row.id,
          placeId: row.placeId!,
          title: row.title,
          subtitle: row.subtitle,
          helper: row.helper,
          // See mapPlaceDocument: a place's entity-page slug rides the shared
          // `profile_slug` column, and it is a place's only slug.
          pageSlug: row.profileSlug ?? null,
          city: row.city,
          capacity: row.capacity,
          ...placeMapPosition(
            row.lat,
            row.lng,
            row.locationIsExact,
            row.locationRadiusMeters,
          ),
          confidence,
        } satisfies PlaceSuggestion;

      case "organization":
        return {
          type: "organization",
          id: row.id,
          orgId: row.orgIdRef!,
          title: row.title,
          subtitle: row.subtitle,
          helper: row.helper,
          slug: row.orgSlug!,
          eventCount: row.eventCount,
          confidence,
        } satisfies OrganizationSuggestion;
    }
  }

  private wrapError(e: unknown, operation: string): SearchPortError {
    const message =
      e instanceof Error ? e.message : "Unknown Postgres search error";
    return new SearchPortErrorClass(
      "dependency_failed",
      `${operation}: ${message}`,
      {
        cause: e,
      },
    );
  }
}

function recordToSql(record: SearchDocumentRecord): Prisma.Sql {
  return Prisma.sql`(
    ${record.id},
    ${record.type},
    ${record.title},
    ${record.subtitle},
    ${record.helper},
    ${record.imageUrl},
    ${record.eventId},
    ${record.humanId},
    ${record.placeId},
    ${record.orgIdRef},
    ${record.slug},
    ${record.username},
    ${record.profileSlug},
    ${record.orgSlug},
    ${record.startsAt}::timestamptz,
    ${record.endsAt}::timestamptz,
    ${record.timezone},
    ${record.addressText},
    ${record.eventStatus},
    ${record.regionCode},
    ${record.countryCode},
    ${record.city},
    ${record.lat}::double precision,
    ${record.lng}::double precision,
    ${record.locationIsExact},
    ${record.locationRadiusMeters}::integer,
    ${record.tags}::text[],
    ${record.categoryNames}::text[],
    ${record.artists}::text[],
    ${record.venueName},
    ${record.orgId},
    ${record.ownerHumanId},
    ${record.summary},
    ${record.popularityScore},
    ${record.lowestPriceCents},
    ${record.lowestBuyerTotalCents},
    ${record.currency},
    ${record.paidTierCount},
    ${record.hasFreeTier},
    ${record.hasPayWhatYouWantTier},
    ${record.isPublic},
    ${record.eventsHostedCount},
    ${record.capacity},
    ${record.eventCount},
    ${record.placeStatus},
    ${record.verificationStatus},
    ${record.listedInDirectory},
    ${record.orgStatus},
    ${record.memberCount},
    now()
  )`;
}

function toNullableArray<T>(values: T[] | undefined): T[] | null {
  return values && values.length > 0 ? values : null;
}

/**
 * Resolve the ORDER BY mode, applying the distance→date fallback. `distance`
 * needs a geo coordinate; without one there is nothing to measure distance
 * against, so we degrade to `date` (soonest-first). MUST stay in LOCKSTEP with
 * the Meilisearch adapter's `resolveEffectiveSort`.
 */
function resolveEffectiveSort(
  sort: MultiSearchSort | undefined,
  geo: { lat: number; lng: number; radiusKm: number } | undefined,
): MultiSearchSort {
  const requested = sort ?? "relevance";
  if (requested === "distance" && !geo) return "date";
  return requested;
}

const RELEVANCE_ORDER = Prisma.sql`
        CASE WHEN has_geo THEN distance_km ELSE NULL END ASC NULLS LAST,
        score DESC,
        "popularityScore" DESC,
        title ASC`;

/**
 * Build the ORDER BY tail for the autocomplete query. Column identifiers come
 * from the `matched` CTE's output aliases (`"startsAt"`, `distance_km`,
 * `has_geo`, `score`, `"popularityScore"`, `title`). Matches the Meilisearch
 * adapter's `buildMeiliSort` on PRIMARY ordering per mode (deep tiebreaks differ
 * — see that function's note).
 *
 * - `relevance` — UNCHANGED from the original hardcoded order (regression guard),
 *                 except browse-all (`interleave`: empty query, several types):
 *                 rows are ranked within their own type first, so each page
 *                 mixes the types. An empty query has no cross-type relevance
 *                 and popularity sits on a different scale per type, so one
 *                 type would otherwise fill every page while `/search`'s All
 *                 tab renders per-type sections. The Meilisearch adapter does
 *                 not do this (it is not the configured backend: `SEARCH_BACKEND`
 *                 defaults to postgres).
 * - `date`      — soonest-first, nearer breaks same-time ties (when geo), then
 *                 popularity, then title.
 * - `distance`  — nearest-first, soonest breaks same-distance ties, then
 *                 popularity, then title. (Only reached WITH geo — the
 *                 distance→date fallback runs before this.)
 *
 * GUARD-RAIL: `date`/`distance` order ALL rows globally; non-event rows have
 * NULL `startsAt`/`distance_km` → NULLS LAST → shoved to the end. This is only
 * sane for event-only queries. Every current caller of a non-`relevance` sort
 * pins `types:["event"]` and the transport never exposes `sort` (mixed `/search`
 * autocomplete stays `relevance`, interleaved by per-type rank when browsing
 * with an empty query). A future mixed-type `date`/`distance` caller
 * would misorder non-event rows — scope it to events or add per-type handling.
 */
function buildOrderByClause(
  sort: MultiSearchSort,
  interleave = false,
): Prisma.Sql {
  switch (sort) {
    case "date":
      return Prisma.sql`
        "startsAt" ASC NULLS LAST,
        CASE WHEN has_geo THEN distance_km ELSE NULL END ASC NULLS LAST,
        "popularityScore" DESC,
        title ASC`;
    case "date_desc":
      return Prisma.sql`
        "startsAt" DESC NULLS LAST,
        "popularityScore" DESC,
        title ASC`;
    // Price sorts run on the BUYER TOTAL, matching the price the result card
    // shows and the `priceRange` filter above — sorting on face price while
    // filtering on buyer total would let a "under $20" filter return a list
    // ordered by a number the buyer never sees.
    //
    // NULLS LAST in BOTH directions is deliberate: an event with no priced tier
    // has an UNKNOWN price, not a zero one. Letting it lead `price_asc` would
    // put "no price on file" above genuinely free events.
    case "price_asc":
      return Prisma.sql`
        "lowestBuyerTotalCents" ASC NULLS LAST,
        "startsAt" ASC NULLS LAST,
        title ASC`;
    case "price_desc":
      return Prisma.sql`
        "lowestBuyerTotalCents" DESC NULLS LAST,
        "startsAt" ASC NULLS LAST,
        title ASC`;
    case "popularity":
      return Prisma.sql`
        "popularityScore" DESC,
        "startsAt" ASC NULLS LAST,
        title ASC`;
    case "distance":
      return Prisma.sql`
        distance_km ASC NULLS LAST,
        "startsAt" ASC NULLS LAST,
        "popularityScore" DESC,
        title ASC`;
    case "relevance":
    default:
      // `type, id` close the tie so OFFSET paging is deterministic.
      return interleave
        ? Prisma.sql`
        ROW_NUMBER() OVER (PARTITION BY type ORDER BY ${RELEVANCE_ORDER}, id ASC),
        ${RELEVANCE_ORDER},
        type ASC,
        id ASC`
        : Prisma.sql`${RELEVANCE_ORDER}, type ASC, id ASC`;
  }
}

function calculateConfidence(
  row: SearchDocumentRow,
  rows: SearchDocumentRow[],
): number {
  const maxScore = Math.max(
    ...rows.map((candidate) => Number(candidate.score) || 0),
  );
  if (maxScore > 0) {
    return Math.max(0.1, Math.min(1, (Number(row.score) || 0) / maxScore));
  }

  const position = rows.indexOf(row);
  const total = rows.length;
  if (total <= 1) return 1;
  return Math.max(0.1, 1 - position / total);
}

function buildStats(rows: StatsRow[]): MultiSearchIndexStats {
  const stats: MultiSearchIndexStats = {
    events: { count: 0, lastIndexedAt: null },
    humans: { count: 0, lastIndexedAt: null },
    places: { count: 0, lastIndexedAt: null },
    organizations: { count: 0, lastIndexedAt: null },
  };

  for (const row of rows) {
    if (row.type === "event") {
      stats.events = { count: row.count, lastIndexedAt: row.lastIndexedAt };
    } else if (row.type === "human") {
      stats.humans = { count: row.count, lastIndexedAt: row.lastIndexedAt };
    } else if (row.type === "place") {
      stats.places = { count: row.count, lastIndexedAt: row.lastIndexedAt };
    } else if (row.type === "organization") {
      stats.organizations = {
        count: row.count,
        lastIndexedAt: row.lastIndexedAt,
      };
    }
  }

  return stats;
}

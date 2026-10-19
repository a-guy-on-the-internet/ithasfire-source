/**
 * Unified Search Use Case
 *
 * Searches across multiple entity types (events, humans, places, organizations)
 * and returns a unified list of suggestions for the UI autocomplete.
 */
import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type {
  EventSuggestion,
  HumanSuggestion,
  PlaceSuggestion,
  OrganizationSuggestion,
  SearchEntityType,
} from "@th/ports/search/multi-index.types";

import { parseInput } from "../../lib/io";

const DEFAULT_LIMIT = 10;
/**
 * Upper bound on `limit` for a single autocomplete call. The PUBLIC `/search`
 * transport caps its own input at 50 independently (see the unified-search
 * router's input schema), so this higher ceiling does NOT widen the public
 * surface. It exists so DIRECT callers of this use case — notably the embed
 * widgets, which fully search-serve their event lists — can pull the calendar's
 * ~200-event window in one query without paging.
 */
const MAX_LIMIT = 200;
/**
 * Bounds on `categorySlugs`. A category slug is at most 32 characters
 * (`set-event-category.ts`), so 64 leaves headroom without accepting a
 * payload-sized string; 50 matches the `placeIds` cap.
 */
export const MAX_CATEGORY_SLUG_LENGTH = 64;
export const MAX_CATEGORY_SLUGS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion Types
// ─────────────────────────────────────────────────────────────────────────────

const eventSuggestionSchema = z.object({
  type: z.literal("event"),
  id: z.string(),
  eventId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  helper: z.string().nullable(),
  slug: z.string().nullable(),
  /** ISO 8601 start timestamp — needed by clients that want to sort by
   *  full date + time, not just the human-readable `helper` string. */
  startsAt: z.string().datetime().nullable(),
  /** ISO 8601 end timestamp — null when the event has no end. Consumed by the
   *  embed widgets, which render the full event render payload from search. */
  endsAt: z.string().datetime().nullable(),
  /** City (from the event's locality). */
  city: z.string().nullable(),
  /** Region code (state/province) for the event's location. */
  region: z.string().nullable(),
  /** Redacted public street/address text (already redacted upstream for
   *  non-EXACT locations by the indexer). */
  location: z.string().nullable(),
  /** Primary (hero) image URL. Already moderation-gated AT INDEX TIME by the
   *  indexer (non-APPROVED heroes are dropped before indexing), so it is safe
   *  to render on public surfaces without a second runtime gate. */
  imageUrl: z.string().nullable(),
  /** Venue latitude — null when the event's venue has no geocoded pin.
   *  Consumed by the /search results map; null-coord events are omitted. */
  lat: z.number().nullable(),
  /** Venue longitude — null when the event's venue has no geocoded pin. */
  lng: z.number().nullable(),
  /** True only for an EXACT public location — the only case a map may draw a
   *  pin. False = approximate (a circle of `locationRadiusMeters`) or, with no
   *  radius, not drawn at all. */
  locationIsExact: z.boolean(),
  /** Published approximate-area radius in metres; null unless a circle is drawn. */
  locationRadiusMeters: z.number().nullable(),
  /** Lowest ACTIVE tier price in cents — 0 when a free tier exists, null when
   *  the event has no ACTIVE tiers at all. Index semantics, carried verbatim. */
  lowestPriceCents: z.number().nullable(),
  lowestBuyerTotalCents: z.number().nullable(),
  currency: z.string().nullable(),
  /** Count of ACTIVE PAID tiers. Alone, `lowestPriceCents` cannot distinguish
   *  "Free" from "Free+" (both index as 0) nor "$25" from "$25+", so any
   *  surface rendering a price LABEL needs these two alongside it. */
  paidTierCount: z.number(),
  /** True when at least one ACTIVE tier is genuinely free. */
  hasFreeTier: z.boolean(),
  /** True when a floor-0 pay-what-you-want tier is on sale: the label reads
   *  "Pay what you want", never "Free" (owner ruling 2026-10-06, F2). */
  hasPayWhatYouWantTier: z.boolean(),
});

const humanSuggestionSchema = z.object({
  type: z.literal("human"),
  id: z.string(),
  humanId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  helper: z.string().nullable(),
  username: z.string().nullable(),
  profileSlug: z.string().nullable(),
});

const placeSuggestionSchema = z.object({
  type: z.literal("place"),
  id: z.string(),
  placeId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  helper: z.string().nullable(),
  /**
   * The venue's EntityPage slug — the ONLY value `/places/[slug]` resolves on
   * (the exact counterpart of `profileSlug` on the human suggestion), and a
   * place's only slug. Null when the venue has no entity page, in which case
   * clients must route to `/places/id/{placeId}` rather than emit a known 404.
   */
  pageSlug: z.string().nullable(),
  city: z.string().nullable(),
  /** The venue's PUBLIC map point from the redacted index: the pin when
   *  `locationIsExact`, the approximate circle's centre otherwise, null when
   *  the venue keeps its location private. */
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  locationIsExact: z.boolean(),
  /** Approximate-area radius in metres; null unless a circle is published. */
  locationRadiusMeters: z.number().nullable(),
  /** The venue publishes no position at all — the ONLY case a surface may
   *  say it "keeps its location private". Never true alongside coordinates. */
  locationHidden: z.boolean(),
});

const organizationSuggestionSchema = z.object({
  type: z.literal("organization"),
  id: z.string(),
  orgId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  helper: z.string().nullable(),
  slug: z.string(),
});

const unifiedSuggestionSchema = z.discriminatedUnion("type", [
  eventSuggestionSchema,
  humanSuggestionSchema,
  placeSuggestionSchema,
  organizationSuggestionSchema,
]);

export type UnifiedSuggestion = z.infer<typeof unifiedSuggestionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Input/Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const unifiedSearchInputSchema = z
  .object({
    /**
     * Free-text query. Empty string means "browse all" — returns the
     * filter-matching set ranked by Meilisearch's defaults (typically
     * insertion / popularity), suitable for /search with no query.
     */
    query: z.string().trim().max(120).default(""),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
    /** Filter to specific entity types. If not provided, searches all types. */
    types: z
      .array(z.enum(["event", "human", "place", "organization"]))
      .optional(),
    /** Optional geo filter — scopes event results to a radius around a coordinate. */
    geo: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        // Up to 20,000 km — covers nationwide (~5000 km for the US,
        // ~7000 km for Russia) and continent-scale searches. Worldwide
        // = drop the geo filter entirely instead of capping at a number.
        radiusKm: z.number().min(1).max(20_000),
      })
      .optional(),
    /** Scope results to a specific org. */
    orgId: z.uuid("orgId must be a UUID").optional(),
    /** Scope results to a specific human owner. */
    ownerHumanId: z.uuid("ownerHumanId must be a UUID").optional(),
    /**
     * When true, only published events are returned. Defaults to true.
     * Set to false in admin contexts so org owners can see their drafts.
     */
    publishedOnly: z.boolean().default(true),
    /**
     * When true, the query-time PRIVATE-event visibility gate is relaxed so an
     * owner-scoped admin can see its OWN non-public events. FAIL-CLOSED: this
     * is only ever honored when an owner scope (`orgId` or `ownerHumanId`) is
     * also present — otherwise it is ignored and PRIVATE events stay excluded.
     * Defaults to false (the public path), so any caller that doesn't opt in
     * gets PRIVATE events excluded.
     *
     * CALLER CONTRACT — READ BEFORE SETTING THIS: this use case does NOT
     * RBAC-check the `orgId` / `ownerHumanId` scope. Setting
     * `includeNonPublicEvents: true` presumes the CALLER has ALREADY authorized
     * that the actor may see the scoped owner's non-public events. The only
     * place that does so today is the admin transport path (`autocompleteAdmin`),
     * which verifies org membership before injecting this flag. PUBLIC callers
     * (e.g. the embed widgets) MUST NOT set it — even owner-scoped — because
     * they perform no such authorization and would leak PRIVATE events to any
     * visitor of the embedding site.
     */
    includeNonPublicEvents: z.boolean().default(false),
    /**
     * Filter events by free-form tags. Forwarded as given, never gated. A
     * CATEGORY goes in `categorySlugs`, which is gated on `Category.active`.
     */
    tags: z.array(z.string()).optional(),
    /**
     * Filter events by category. Each slug is checked against the ACTIVE
     * categories; a missing or inactive one is dropped, and the rest join the
     * tag filter (a category's slug is indexed in the event document's `tags`,
     * and the adapters OR the tags of one request). A request whose every slug
     * was dropped runs with no category filter at all.
     */
    categorySlugs: z
      .array(z.string().min(1).max(MAX_CATEGORY_SLUG_LENGTH))
      .max(MAX_CATEGORY_SLUGS)
      .optional(),
    /**
     * Filter events to those held at the given place ids. Capped at 50 to
     * bound the query. Composable with the visibility gate and owner scope.
     */
    placeIds: z.array(z.uuid()).max(50).optional(),
    /** Filter events by start-date range (ISO 8601 strings). */
    dateRange: z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .optional(),
    /** Filter events by price range in cents. */
    priceRange: z
      .object({
        minCents: z.number().optional(),
        maxCents: z.number().optional(),
      })
      .optional(),
    /** When true, only show free events. */
    freeOnly: z.boolean().optional(),
    /** When true, only surface places listed in the public directory. */
    listedInDirectoryOnly: z.boolean().optional(),
    /**
     * How to order EVENT rows. Defaults to `relevance` so every existing caller
     * (typed text search, admin autocomplete, SpotlightSearch) is UNCHANGED.
     * Browse surfaces opt into the others. See `MultiSearchSort` — this enum
     * MIRRORS it, and the two must stay in step or a value the transport
     * accepts gets rejected here.
     */
    sort: z
      .enum([
        "relevance",
        "date",
        "date_desc",
        "distance",
        "price_asc",
        "price_desc",
        "popularity",
      ])
      .default("relevance"),
  })
  .strict();

export const unifiedSearchOutputSchema = z
  .object({
    suggestions: z.array(unifiedSuggestionSchema),
    latencyMs: z.number(),
    estimatedTotalHits: z.number().optional(),
  })
  .strict();

export type UnifiedSearchInput = z.infer<typeof unifiedSearchInputSchema>;
export type UnifiedSearchOutput = z.infer<typeof unifiedSearchOutputSchema>;

export type UnifiedSearchDeps = {
  search: MultiSearchQueryPort;
  /**
   * Read for `Category.active`; the search index does not carry it. Needed
   * only by a caller that passes `categorySlugs` (the public and admin
   * transports); a request with `categorySlugs` and no `repos` throws
   * `not_configured` instead of searching ungated.
   */
  repos?: Pick<Repos, "categories">;
  logger?: LoggerPort;
};

/**
 * The subset of `slugs` that names an ACTIVE category, in the order given.
 *
 * `Category.active` is read here, on every request, and not at index time: an
 * event document keeps its category's slug tag whatever `active` is, so
 * switching a category off or on takes effect on the next search with no
 * reindex (the same arrangement as `discoverEventsByCategory`).
 *
 * One slug (the usual case) is a unique-index lookup; several are answered by
 * one read of the active list. A failed read is NOT caught: it propagates, like
 * a failed search does.
 */
async function resolveActiveCategorySlugs(
  deps: UnifiedSearchDeps,
  slugs: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return [];

  const categories = deps.repos?.categories;
  if (!categories) {
    throw {
      code: "not_configured",
      message: "categorySlugs requires the categories repo",
    } as const;
  }

  if (unique.length === 1) {
    const category = await categories.getBySlug(unique[0]!);
    return category?.active ? [category.slug] : [];
  }

  const active = new Set((await categories.listActive()).map((c) => c.slug));
  return unique.filter((slug) => active.has(slug));
}

const searchErrorCodeMap = {
  invalid_input: "invalid_input",
  forbidden: "forbidden",
  not_found: "not_found",
  dependency_failed: "transient",
  transient: "transient",
  unimplemented: "not_configured",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case Implementation
// ─────────────────────────────────────────────────────────────────────────────

export async function unifiedSearch(
  deps: UnifiedSearchDeps,
  rawInput: unknown,
): Promise<UnifiedSearchOutput> {
  const input = parseInput(unifiedSearchInputSchema, rawInput);
  // Empty query is allowed: it triggers a "browse all" fetch — returns
  // all filter-matching documents ranked by the search backend's
  // default ordering. This drives the `/search` "browse all events"
  // landing experience.
  const normalizedQuery = input.query.trim();

  // For public (publishedOnly) searches, default the date floor to "now" so
  // past events don't leak into discovery. Admin contexts (publishedOnly=false)
  // skip this so they can find historical events.
  const dateRange =
    input.dateRange ??
    (input.publishedOnly ? { from: new Date().toISOString() } : undefined);

  // Fail-closed, owner-scoped visibility bypass. Honoring
  // `includeNonPublicEvents` WITHOUT an owner scope would leak EVERY org's
  // PRIVATE events to any caller that flips the flag, so we only forward it
  // when an org or human owner scope is also present. Without a scope the flag
  // is dropped here (fail closed) and the adapters keep the PRIVATE-event gate
  // applied. The adapters additionally re-check owner-scope presence (defense
  // in depth) and constrain the surfaced non-public events to that owner.
  const hasOwnerScope = Boolean(input.orgId || input.ownerHumanId);
  const includeNonPublicEvents = input.includeNonPublicEvents && hasOwnerScope;

  // No category read unless a category was asked for: this is the hot public
  // search path. Free-form `tags` are forwarded ungated; only `categorySlugs`
  // is checked, and the surviving slugs join the same (OR'd) tag filter.
  const activeCategorySlugs = input.categorySlugs?.length
    ? await resolveActiveCategorySlugs(deps, input.categorySlugs)
    : [];
  const directTags = input.tags ?? [];
  const tags = [
    ...directTags,
    ...activeCategorySlugs.filter((slug) => !directTags.includes(slug)),
  ];

  const result = await deps.search.autocomplete({
    query: normalizedQuery,
    limit: input.limit,
    offset: input.offset,
    sort: input.sort,
    filters: {
      types: input.types as SearchEntityType[] | undefined,
      publishedOnly: input.publishedOnly,
      ...(includeNonPublicEvents ? { includeNonPublicEvents: true } : {}),
      ...(input.geo ? { geo: input.geo } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
      ...(input.ownerHumanId ? { ownerHumanId: input.ownerHumanId } : {}),
      ...(tags.length ? { tags } : {}),
      ...(input.placeIds?.length ? { placeIds: input.placeIds } : {}),
      ...(dateRange ? { dateRange } : {}),
      ...(input.priceRange ? { priceRange: input.priceRange } : {}),
      ...(input.freeOnly ? { freeOnly: input.freeOnly } : {}),
      ...(input.listedInDirectoryOnly
        ? { listedInDirectoryOnly: input.listedInDirectoryOnly }
        : {}),
    },
  });

  if (!result.ok) {
    deps.logger?.warn("unified_search.autocomplete_failed", {
      error: result.error.message,
      errorCode: result.error.code,
      query: normalizedQuery,
    });

    throw {
      code: searchErrorCodeMap[result.error.code] ?? "transient",
      message: result.error.message,
      meta: { searchErrorCode: result.error.code },
    } as const;
  }

  deps.logger?.info("unified_search.completed", {
    queryLength: normalizedQuery.length,
    limit: input.limit,
    types: input.types ?? "all",
    resultCount: result.value.suggestions.length,
    latencyMs: result.value.latencyMs,
  });

  const suggestions = result.value.suggestions.map((s): UnifiedSuggestion => {
    switch (s.type) {
      case "event": {
        const e = s as EventSuggestion;
        return {
          type: "event",
          id: e.id,
          eventId: e.eventId,
          title: e.title,
          subtitle: e.subtitle,
          helper: e.helper,
          slug: e.slug,
          startsAt: e.startsAt ? e.startsAt.toISOString() : null,
          endsAt: e.endsAt ? e.endsAt.toISOString() : null,
          city: e.city ?? null,
          region: e.region ?? null,
          location: e.location ?? null,
          imageUrl: e.imageUrl ?? null,
          lat: e.lat ?? null,
          lng: e.lng ?? null,
          // A document indexed before these fields existed omits them: read
          // as not-exact / no circle, so the map never draws it as a pin.
          locationIsExact: e.locationIsExact === true,
          locationRadiusMeters: e.locationIsExact === true ? null : (e.locationRadiusMeters ?? null),
          lowestPriceCents: e.lowestPriceCents ?? null,
          lowestBuyerTotalCents: e.lowestBuyerTotalCents ?? null,
          currency: e.currency ?? null,
          // Defaulted like the adapters do: the port declares both as required,
          // but a document indexed before these columns existed can come back
          // without them, and a missing tier count must degrade to "no paid
          // tiers" (⇒ a fallback label) rather than throw the whole search.
          paidTierCount: e.paidTierCount ?? 0,
          hasFreeTier: e.hasFreeTier ?? false,
          hasPayWhatYouWantTier: e.hasPayWhatYouWantTier ?? false,
        };
      }
      case "human": {
        const h = s as HumanSuggestion;
        return {
          type: "human",
          id: h.id,
          humanId: h.humanId,
          title: h.title,
          subtitle: h.subtitle,
          helper: h.helper,
          username: h.username,
          profileSlug: h.profileSlug,
        };
      }
      case "place": {
        const p = s as PlaceSuggestion;
        return {
          type: "place",
          id: p.id,
          placeId: p.placeId,
          title: p.title,
          subtitle: p.subtitle,
          helper: p.helper,
          pageSlug: p.pageSlug ?? null,
          city: p.city,
          // Fail closed: coordinates travel only with something to draw — a
          // pin (exact) or a circle (radius). The adapters already enforce
          // this; restated here because this is the public contract.
          // Only a venue with no coordinates can be private; a stale or
          // unknown flag reads false (no claim), never true.
          locationHidden: p.locationHidden === true && p.lat == null,
          ...(p.locationIsExact === true
            ? {
                lat: p.lat ?? null,
                lng: p.lng ?? null,
                locationIsExact: true,
                locationRadiusMeters: null,
              }
            : p.locationRadiusMeters != null && p.lat != null && p.lng != null
              ? {
                  lat: p.lat,
                  lng: p.lng,
                  locationIsExact: false,
                  locationRadiusMeters: p.locationRadiusMeters,
                }
              : {
                  lat: null,
                  lng: null,
                  locationIsExact: false,
                  locationRadiusMeters: null,
                }),
        };
      }
      case "organization": {
        const o = s as OrganizationSuggestion;
        return {
          type: "organization",
          id: o.id,
          orgId: o.orgId,
          title: o.title,
          subtitle: o.subtitle,
          helper: o.helper,
          slug: o.slug,
        };
      }
    }
  });

  return unifiedSearchOutputSchema.parse({
    suggestions,
    latencyMs: result.value.latencyMs,
    estimatedTotalHits: result.value.estimatedTotalHits,
  });
}

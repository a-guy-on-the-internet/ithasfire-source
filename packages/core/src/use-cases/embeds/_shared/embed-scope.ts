import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import { isPlausibleIndexedBuyerTotal } from "@th/types/money";

import { unifiedSearch, type UnifiedSuggestion } from "../../search/unified-search";

/**
 * Which events an ORGANIZATION / HUMAN embed renders.
 *
 * - `own`    — events the subject CREATED (owner-scoped `unifiedSearch`). The
 *              DEFAULT. As of the search-served rewrite this returns the same
 *              subject's PUBLISHED + PUBLIC upcoming events, sourced from the
 *              SAME search query the platform uses everywhere else.
 * - `venues` — published events AT places the subject OWNS, regardless of who
 *              created them. Answers "what's on at my room this month?".
 * - `all`    — union of `own` + `venues`, deduped by event id.
 *
 * `scope` is a widget PARAM, not a column on `Embed`. Deliberate: `Embed` is
 * unique per `[subjectType, subjectId, domain]`, so a column would force ONE
 * scope per domain and make "my events on page A, my venue's calendar on
 * page B" of the same site impossible. It is handled like `theme`/`promo`.
 *
 * It leaks nothing: every leg runs through `unifiedSearch` with
 * `publishedOnly: true` and WITHOUT `includeNonPublicEvents`, so the
 * fail-closed PRIVATE-event gate is always applied — a PRIVATE event the
 * subject owns is EXCLUDED. This is what finally closed the private-event leak
 * the old `events.listByOwner` path had.
 *
 * Meaningless for `event` / `place` subjects — those branches IGNORE it
 * rather than erroring, so a stale snippet carrying `?scope=` never breaks.
 *
 * ── CAPS (all silent to the viewer) ──
 * - PLACES: {@link EMBED_SCOPE_MAX_PLACES} (50) owned venues per subject,
 *   selected ALPHABETICALLY — see that constant.
 * - EVENTS: 200 total for the calendar widget, 50 for the events-grid widget.
 *   Both legs of `scope: "all"` fetch the FULL total; the merged union is
 *   date-ordered (soonest-first, `sort: "date"`) and truncated back to the
 *   total, so the drop is deterministic — the FURTHEST-future events fall off,
 *   NOT the least-popular. When a leg's search returns its full `limit`, the
 *   resolver LOGS `embed.events_search_hit_cap` so truncation is never silent
 *   in the logs (a busy subject with >200 upcoming public events can miss the
 *   tail of the window — acceptable at current scale, tracked not fixed here).
 */
export const EMBED_SCOPES = ["own", "venues", "all"] as const;

export const embedScopeSchema = z.enum(EMBED_SCOPES).optional().default("own");

export type EmbedScope = (typeof EMBED_SCOPES)[number];

/**
 * Upper bound on how many venues one subject fans out to. A subject owning
 * many venues must not turn one widget request into an unbounded query.
 *
 * TRUNCATION IS SILENT AND ALPHABETICAL. `places.listOwnedBySubject` orders by
 * `name ASC, id ASC`, so a subject with MORE than this many verified+active
 * owned places renders only the alphabetically-first 50 — with no signal to
 * the viewer or the organiser. The cap itself is deliberate (bounded fan-out);
 * the arbitrary selection is a known limitation, not a design intent. If a
 * real subject ever approaches 50 venues, the fix is a deliberate ordering
 * (e.g. by next-event-at) or an explicit place filter on the embed — NOT
 * quietly raising the number.
 *
 * NOTE: this MUST stay <= `unifiedSearch`'s `placeIds` cap (50); the venue leg
 * forwards these ids straight into that filter.
 */
export const EMBED_SCOPE_MAX_PLACES = 50;

/**
 * Event shape shared by the calendar and widget embed read paths, mapped from
 * a `unifiedSearch` event suggestion. Each use case projects this onto its own
 * output shape. `startsAt` is non-null (events with no start are dropped — they
 * can't be placed on a calendar/grid); everything else can be null.
 */
export type EmbedEvent = {
  id: string;
  title: string;
  slug: string | null;
  /**
   * Which search leg produced this event: `"own"` (owner-scoped search — for
   * ORGANIZATION subjects every hit carries the subject's `orgId` filter, so
   * DB `event.orgId === subjectId` by the same column the indexer mirrors) or
   * `"venues"` (place-scoped — the creator may be anyone). For `scope: "all"`
   * {@link dedupeEventsById} keeps the FIRST occurrence and the own leg is
   * always passed first, so an event present in BOTH legs stays `"own"`.
   * Consumed by the calendar use case to derive `checkoutEligible` — it must
   * mirror `assertEventAllowedForEmbed`'s org rule, never widen it.
   */
  leg: "own" | "venues";
  startsAt: Date;
  endsAt: Date | null;
  currency: string | null;
  /**
   * ── Pricing rollup, carried with INDEX semantics (not the card mapper's) ──
   *
   * `lowestPriceCents` is the lowest ACTIVE tier price, which is `0` whenever a
   * free tier exists and `null` only when the event has no ACTIVE tiers. That
   * makes it insufficient ON ITS OWN for a price label: "Free" and "Free+" both
   * index as 0, and "$25" vs "$25+" differ only by tier count. The other two
   * fields are what disambiguate, so they travel together — dropping one here
   * would silently collapse a widget card to the "See details" fallback, which
   * is exactly what the whole grid did before pricing was threaded through.
   *
   * Deliberately NOT pre-formatted into a label: the renderer owns wording and
   * currency formatting, and the calendar path ignores all three.
   */
  lowestPriceCents: number | null;
  /** Count of ACTIVE PAID tiers (`priceCents > 0`). */
  paidTierCount: number;
  /** True when at least one ACTIVE tier is genuinely free. */
  hasFreeTier: boolean;
  /**
   * True when a floor-0 pay-what-you-want tier is on sale: the card reads
   * "Pay what you want", never "Free" (owner ruling 2026-10-06, F2).
   */
  hasPayWhatYouWantTier: boolean;
  /**
   * The indexed ALL-IN price of the cheapest paid tier, or null. Already run
   * through `isPlausibleIndexedBuyerTotal` (a stale index total is dropped
   * here, once, so no consumer has to remember to).
   */
  lowestBuyerTotalCents: number | null;
  /** Hero image URL — already moderation-gated AT INDEX TIME by the indexer. */
  imageUrl: string | null;
  /**
   * The card's place label from the search index (the suggestion's
   * `subtitle`: a place name the index may print, else the public address),
   * carried ONLY for an event whose public location is exact.
   *
   * The index names a confirmed place whatever the event's location mode
   * (`cardVenueName`), and the site's cards print that. A widget sits on
   * someone else's page, so it stays as strict as it was before this field
   * existed: a gated event, an approximate location or a place that withholds
   * its address gets null here and the card keeps the coarse `location` /
   * `city` / `region` it always printed.
   */
  placeLabel: string | null;
  /** Redacted public street/address text. */
  location: string | null;
  city: string | null;
  region: string | null;
};

export type ResolveScopedEmbedEventsArgs = {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  places: Pick<PlacesRepo, "listOwnedBySubject">;
  ownerType: "ORGANIZATION" | "HUMAN";
  ownerId: string;
  scope: EmbedScope;
  /** Lower bound of the `startsAt` window. */
  from: Date;
  /** Total event cap. Split across legs for `scope: "all"`. */
  limit: number;
};

/**
 * Resolve the scoped, deduped event set for an org/human embed — entirely from
 * `unifiedSearch` (the same query the platform uses everywhere). Returns the
 * merged union ORDERED soonest-first; each caller applies its own final slice.
 *
 * - `own`    — owner-scoped search (`orgId` for org subjects, `ownerHumanId`
 *              for human subjects).
 * - `venues` — resolve the subject's OWNED places (authz stays in Postgres via
 *              `places.listOwnedBySubject`, which only returns verified,
 *              non-revoked ownership), then a `placeIds`-scoped search.
 * - `all`    — union of both, deduped by event id via {@link dedupeEventsById}.
 *
 * ORDERING: each leg runs with `sort: "date"`, so a single-leg scope
 * (`own`/`venues`) already comes back soonest-first. For `scope: "all"` the two
 * date-ordered legs are concatenated, so we re-sort the merged union by
 * `startsAt` to INTERLEAVE them (otherwise the caller's plain slice would drop
 * a whole leg's tail). Both legs fetch the FULL `limit`; the caller truncates
 * the interleaved union back to `limit`, deterministically dropping the
 * FURTHEST-future events.
 *
 * PUBLIC by construction: every search runs `publishedOnly: true` and NEVER
 * sets `includeNonPublicEvents`, so PRIVATE events are always excluded.
 */
export async function resolveScopedEmbedEvents(
  args: ResolveScopedEmbedEventsArgs,
): Promise<EmbedEvent[]> {
  const { search, logger, places, ownerType, ownerId, scope, from, limit } =
    args;
  const fromIso = from.toISOString();

  const ownEvents =
    scope === "own" || scope === "all"
      ? await searchEmbedEvents({
          search,
          logger,
          fromIso,
          limit,
          leg: "own",
          owner:
            ownerType === "ORGANIZATION"
              ? { orgId: ownerId }
              : { ownerHumanId: ownerId },
        })
      : [];

  const venueEvents =
    scope === "venues" || scope === "all"
      ? await searchVenueEmbedEvents({
          search,
          logger,
          places,
          ownerType,
          ownerId,
          fromIso,
          limit,
        })
      : [];

  // Interleave the two independently date-ordered legs (a no-op for a single
  // leg, which the query already returns soonest-first). `startsAt` is non-null
  // on every EmbedEvent (events without a start are dropped upstream).
  return dedupeEventsById(ownEvents, venueEvents).sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

async function searchEmbedEvents(args: {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  fromIso: string;
  limit: number;
  leg: "own" | "venues";
  owner?: { orgId: string } | { ownerHumanId: string };
  placeIds?: string[];
}): Promise<EmbedEvent[]> {
  // The embed is a PUBLIC surface. `publishedOnly: true` + the fail-closed
  // PRIVATE-event gate (we DELIBERATELY never set `includeNonPublicEvents`)
  // means only PUBLISHED + PUBLIC events come back — closing the leak the old
  // `events.listByOwner` path had.
  const { suggestions } = await unifiedSearch(
    { search: args.search, logger: args.logger },
    {
      query: "",
      types: ["event"],
      publishedOnly: true,
      // Calendars/grids want soonest-first — order by date in the query itself
      // so the caller can trust the result order (no client-side re-sort).
      sort: "date",
      dateRange: { from: args.fromIso },
      limit: args.limit,
      ...(args.owner ?? {}),
      ...(args.placeIds ? { placeIds: args.placeIds } : {}),
    },
  );

  // No SILENT truncation: if the leg came back full, a busy subject may have
  // upcoming public events beyond the window. Surface it in the logs. Because
  // the query is date-ordered, any events beyond the cap are the FURTHEST-future
  // ones — the deterministic tail, not an arbitrary/least-popular drop.
  if (suggestions.length >= args.limit) {
    args.logger?.info?.("embed.events_search_hit_cap", {
      leg: args.leg,
      limit: args.limit,
    });
  }

  return suggestions.flatMap((s) => suggestionToEmbedEvent(s, args.leg));
}

async function searchVenueEmbedEvents(args: {
  search: MultiSearchQueryPort;
  logger?: LoggerPort;
  places: Pick<PlacesRepo, "listOwnedBySubject">;
  ownerType: "ORGANIZATION" | "HUMAN";
  ownerId: string;
  fromIso: string;
  limit: number;
}): Promise<EmbedEvent[]> {
  const owned = await args.places.listOwnedBySubject({
    ownerType: args.ownerType,
    ownerId: args.ownerId,
    limit: EMBED_SCOPE_MAX_PLACES,
  });

  const placeIds = owned.map((p) => p.id);
  if (placeIds.length === 0) return [];

  return searchEmbedEvents({
    search: args.search,
    logger: args.logger,
    fromIso: args.fromIso,
    limit: args.limit,
    leg: "venues",
    placeIds,
  });
}

/**
 * Narrow a unified suggestion to an event and project it onto {@link EmbedEvent}.
 * `types: ["event"]` already scopes the search to events, but we narrow for TS
 * and drop any event with no `startsAt` (nothing to place on a calendar/grid).
 *
 * THE single place an {@link EmbedEvent} is built — both the `own` and `venues`
 * legs funnel through `searchEmbedEvents`, so a field added to `EmbedEvent`
 * only has to be mapped here to reach every scope. Keep it that way: a second
 * construction site is how one leg ends up quietly missing a field.
 */
function suggestionToEmbedEvent(
  s: UnifiedSuggestion,
  leg: "own" | "venues",
): EmbedEvent[] {
  if (s.type !== "event" || !s.startsAt) return [];
  return [
    {
      id: s.eventId,
      leg,
      title: s.title,
      slug: s.slug,
      startsAt: new Date(s.startsAt),
      endsAt: s.endsAt ? new Date(s.endsAt) : null,
      currency: s.currency,
      lowestPriceCents: s.lowestPriceCents,
      paidTierCount: s.paidTierCount,
      hasFreeTier: s.hasFreeTier,
      hasPayWhatYouWantTier: s.hasPayWhatYouWantTier ?? false,
      lowestBuyerTotalCents: plausibleIndexedBuyerTotal(s),
      imageUrl: s.imageUrl,
      placeLabel: s.locationIsExact === true ? s.subtitle : null,
      location: s.location,
      city: s.city,
      region: s.region,
    },
  ];
}

/**
 * The suggestion's indexed all-in total, or null when it fails the stale-index
 * guard. With a free or floor-0 pay-what-you-want tier the index's
 * `lowestPriceCents` is 0, not the paid face, so there is no face to check
 * against — but the label is "Free+" / "Pay what you want" then and never
 * prints the total.
 */
function plausibleIndexedBuyerTotal(s: {
  lowestBuyerTotalCents?: number | null;
  lowestPriceCents: number | null;
  hasFreeTier: boolean;
  hasPayWhatYouWantTier: boolean;
}): number | null {
  const total = s.lowestBuyerTotalCents ?? null;
  if (
    total == null ||
    s.hasFreeTier ||
    s.hasPayWhatYouWantTier ||
    s.lowestPriceCents == null
  ) {
    return null;
  }
  return isPlausibleIndexedBuyerTotal(total, s.lowestPriceCents) ? total : null;
}

/**
 * Union two event lists, deduped by event id, keeping the FIRST occurrence of
 * each id. Used by `scope: "all"` — an event that is both own-created AND at
 * an owned venue must appear exactly once.
 */
export function dedupeEventsById<T extends { id: string }>(
  ...lists: readonly T[][]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const event of list) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
    }
  }
  return out;
}

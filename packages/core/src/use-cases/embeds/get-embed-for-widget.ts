import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";

import { parseInput } from "../../lib/io";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import { resolvePlaceLocations } from "../../lib/location/resolve-place-locations";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { getCalendarEventsPublic } from "../events/get-calendar-events";
import { summarizePricing } from "../events/_shared/event-pricing";
import { loadListingBuyerTotalsByEventId } from "../events/_shared/listing-buyer-totals";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import {
  type EmbedGateType,
  embedGateTypeOf,
  embedGateTypeSchema,
  isEventUngatedForEmbed,
} from "./_shared/assert-event-ungated-for-embed";
import {
  embedScopeSchema,
  resolveScopedEmbedEvents,
} from "./_shared/embed-scope";
import { fail } from "@th/errors";

const WIDGET_EVENT_LIMIT = 50;

export const getEmbedForWidgetInputSchema = z
  .object({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
    /**
     * Which events an organization/human embed renders — see `embedScopeSchema`.
     * Defaults to "own" (pre-existing behavior). Ignored for event subjects.
     */
    scope: embedScopeSchema,
  })
  .strict();

const eventItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string().nullable(),
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  /**
   * `Event.timezone` (IANA), resolved to a usable zone (`resolveTimeZone`:
   * `DEFAULT_VENUE_TIMEZONE` when the stored one is unusable). The card's date
   * is printed in it, never in the renderer's zone: the server renders in UTC,
   * and everyone going to one show reads the same door time.
   *
   * Read from the event ROW on the grid (the batched row read below) rather
   * than the index, which lacks it for documents indexed before it was stored.
   */
  timezone: z.string(),
  currency: z.string(),
  /**
   * Pricing rollup for the card's price line. The widget renders the SHARED
   * event card, which shows a price label; without these it can only ever say
   * "See details". Index semantics (see `EmbedEvent`): `lowestPriceCents` is 0
   * when a free tier exists and null only when there are no ACTIVE tiers, so
   * the label needs all three — `paidTierCount` separates "$25" from "$25+"
   * and `hasFreeTier` separates "Free" from "Free+".
   *
   * OUTPUT-only, like `defaultView`: the widget INPUT schema stays frozen.
   */
  lowestPriceCents: z.number().int().nullable(),
  paidTierCount: z.number().int().min(0),
  hasFreeTier: z.boolean(),
  /**
   * A floor-0 pay-what-you-want tier is on sale: the card reads "Pay what you
   * want", never "Free" (owner ruling 2026-10-06, F2). `lowestPriceCents` is
   * 0 then, as with a free tier.
   */
  hasPayWhatYouWantTier: z.boolean(),
  /**
   * The ALL-IN price of the cheapest on-sale paid tier — ticket + platform fee
   * + processing fee + tax, as checkout charges (owner ruling 2026-10-02: a
   * listing quotes this, never the face). Null when there is no paid tier or
   * the figure cannot be computed honestly (venue unreadable, a fee read
   * failed, a stale index value); a paid card then says "See details".
   * Live for the single-event subject, from the search index (already
   * plausibility-checked, see `suggestionToEmbedEvent`) for org/human grids.
   */
  lowestBuyerTotalCents: z.number().int().nullable(),
  heroImageUrl: z.string().nullable(),
  /**
   * The card's preferred place line, printed ahead of the address. Org/human
   * grids take the search index's label, and only for an event whose public
   * location is exact (see `EmbedEvent.placeLabel`). Null on the calendar and
   * single-event subjects, which have no public place name in hand; the card
   * then falls back to `addressText` / `locality` / `region`.
   */
  placeLabel: z.string().nullable(),
  addressText: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  /**
   * The event's gate, for the card's badge (owner ruling 2026-10-12: a gated
   * event stays listed, with a badge). Read from the event ROW in one batch
   * for the grid and calendar subjects, never from the search index, which
   * does not carry it. A gated card opens the event on Ithas Fire; the
   * widget's detail read answers a gated preview and checkout refuses it.
   */
  gateType: embedGateTypeSchema,
});

const ticketTypeItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  capacity: z.number().int(),
  status: z.string(),
});

export const getEmbedForWidgetOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
      domain: z.string(),
      requireAuth: z.boolean(),
      linkOut: z.boolean(),
      /**
       * Config-time browse-view default. The widget resolves its view as
       * URL signal > this > "list", so an UNRECOGNISED stored value must be
       * survivable — hence a bare string here (matching `subjectType`) rather
       * than an enum that would make the whole payload throw.
       *
       * NOTE: this is an OUTPUT-only addition. The input schema above stays
       * byte-frozen: `view` is a client-side URL concern and must never become
       * a procedure input (`.strict()` would 400 the request).
       */
      defaultView: z.string(),
      /** Render the viewer-facing List/Calendar switcher. */
      viewToggle: z.boolean(),
    }),
    // For "event" embeds: single event + its ticket types
    event: eventItemSchema.optional(),
    ticketTypes: z.array(ticketTypeItemSchema).optional(),
    /**
     * For "organization" embeds ONLY. Kept exactly as-is for back-compat —
     * the live widget page reads `data.organization?.name`. New consumers
     * should prefer `owner`, which also covers "human" subjects.
     */
    organization: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
      })
      .optional(),
    /**
     * Subject-agnostic owner descriptor for "organization" AND "human"
     * embeds. `slug` is null for humans (no org-style slug on the model).
     */
    owner: z
      .object({
        kind: z.enum(["organization", "human"]),
        id: z.string(),
        name: z.string(),
        slug: z.string().nullable(),
      })
      .optional(),
    /**
     * For "calendar" embeds ONLY (venue-hierarchy FR-010): the named
     * calendar's header identity. Deliberately a NEW key rather than a new
     * `owner.kind` — the owner enum is a consumed contract, and a calendar is
     * not an events OWNER (its events belong to whoever created them). Only
     * the summary the public read already exposes; never availability,
     * conflicts, or booking internals (NFR-002).
     */
    calendar: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
      })
      .optional(),
    // For "organization"/"human"/"calendar" embeds: upcoming events.
    events: z.array(eventItemSchema).optional(),
  })
  .strict();

/**
 * Roll ACTIVE ticket types up into the same three pricing fields the search
 * index stamps, so a single-event embed's card reads identically to the same
 * event's card in the org/human grid (which is search-served).
 *
 * The 0-vs-null rule is load-bearing and MUST match the indexer
 * (`build-search-index.ts`): a free tier pins `lowestPriceCents` to 0, and null
 * means "no ACTIVE tiers at all" — the only case that legitimately renders the
 * card's fallback label. Diverging here would give the two surfaces different
 * prices for one event.
 *
 * Derived from the ticket types this use case ALREADY loaded, so it adds no
 * query.
 *
 * FR-004: the roll-up itself now lives in `summarizePricing`
 * (events/_shared/event-pricing.ts), shared with the indexer and the browse
 * listings, so "MUST match the indexer" is enforced by construction instead of
 * by three hand-copied loops staying in step. This wrapper only applies the
 * embed's own 0-vs-null projection on top.
 */
function summarizeTicketPricing(
  ticketTypes: Parameters<typeof summarizePricing>[0],
  now: Date,
): {
  lowestPriceCents: number | null;
  paidTierCount: number;
  hasFreeTier: boolean;
  hasPayWhatYouWantTier: boolean;
} {
  const {
    hasFreeTier,
    hasPayWhatYouWantTier,
    paidTierCount,
    minPaidPriceCents,
  } = summarizePricing(ticketTypes, now);

  return {
    lowestPriceCents:
      hasFreeTier || hasPayWhatYouWantTier ? 0 : minPaidPriceCents,
    paidTierCount,
    hasFreeTier,
    hasPayWhatYouWantTier,
  };
}

export type GetEmbedForWidgetInput = z.infer<
  typeof getEmbedForWidgetInputSchema
>;
export type GetEmbedForWidgetOutput = z.infer<
  typeof getEmbedForWidgetOutputSchema
>;

export type GetEmbedForWidgetDeps = {
  repos: Pick<
    Repos,
    | "embeds"
    | "events"
    | "organizations"
    | "humans"
    | "places"
    | "calendars"
    | "imageModerationRecords"
    // The single-event subject's all-in price (fee context + venue situs).
    | "payoutTerms"
    | "feePolicies"
    | "savedLocations"
  >;
  /**
   * Unified search — the org/human upcoming-events grid is fully search-served
   * through this (same query as the platform). Hero images come from the
   * INDEX-TIME-gated `imageUrl`, so the grid no longer needs a runtime
   * moderation gate. The single-event subject path still reads the event
   * directly and keeps its own runtime hero gate.
   */
  search: MultiSearchQueryPort;
  /**
   * Required (FR-003). The single-event path resolves prices live here; the
   * grid path reads them from the search index, which the FR-008 job keeps
   * fresh. Both must agree, so neither may default the clock.
   */
  clock: ClockPort;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter: a failed venue read renders the event's
   * location fully hidden (fail closed) instead of failing the widget.
   */
  reportError?: ReporterPort;
};

export async function getEmbedForWidget(
  deps: GetEmbedForWidgetDeps,
  rawInput: unknown,
): Promise<GetEmbedForWidgetOutput> {
  const logger = deps.logger?.child({ useCase: "getEmbedForWidget" });

  const execute = async () => {
    const input = parseInput(getEmbedForWidgetInputSchema, rawInput);

    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed || embed.status !== "ACTIVE") {
      throw fail("EMBED_NOT_FOUND");
    }

    assertEmbedOriginAllowed({
      embed,
      hostOrigin: input.hostOrigin,
      publicAppUrl: deps.publicAppUrl,
      logger,
    });

    const embedBase = {
      id: embed.id,
      subjectType: embed.subjectType,
      subjectId: embed.subjectId,
      domain: embed.domain,
      requireAuth: embed.requireAuth,
      linkOut: embed.linkOut,
      defaultView: embed.defaultView,
      viewToggle: embed.viewToggle,
    };

    // ── Organization / human embed: return upcoming events grid ──────
    if (embed.subjectType === "organization" || embed.subjectType === "human") {
      let ownerType: "ORGANIZATION" | "HUMAN";
      let owner: {
        kind: "organization" | "human";
        id: string;
        name: string;
        slug: string | null;
      };
      // Populated for organization subjects ONLY — the legacy field the live
      // widget page still reads. See the output schema note.
      let organization: { id: string; name: string; slug: string } | undefined;

      if (embed.subjectType === "organization") {
        const org = await deps.repos.organizations.getById(embed.subjectId);
        if (!org) {
          throw fail("ORGANIZATION_NOT_FOUND");
        }
        ownerType = "ORGANIZATION";
        organization = { id: org.id, name: org.name, slug: org.slug };
        owner = {
          kind: "organization",
          id: org.id,
          name: org.name,
          slug: org.slug,
        };
      } else {
        const human = await deps.repos.humans.getById(embed.subjectId);
        if (!human) {
          throw fail("HUMAN_NOT_FOUND");
        }
        ownerType = "HUMAN";
        // `Human.name` is the display name on the model and is nullable;
        // fall back to a neutral label rather than rendering "null".
        owner = {
          kind: "human",
          id: human.id,
          name: human.name ?? "Events",
          slug: null,
        };
      }

      // Only show upcoming events (startsAt >= now).
      const now = new Date();

      // Fully search-served: own + venues legs both come from `unifiedSearch`
      // with `publishedOnly` and WITHOUT `includeNonPublicEvents`, so PRIVATE
      // events are excluded (the leak the old `listByOwner` path had is closed).
      // Hero images are the INDEX-TIME-gated `imageUrl` — the indexer already
      // drops non-APPROVED heroes before indexing — so no runtime moderation
      // gate is needed here (consistent with the platform-wide search grid).
      const scopedEvents = await resolveScopedEmbedEvents({
        search: deps.search,
        logger,
        places: deps.repos.places,
        ownerType,
        ownerId: embed.subjectId,
        scope: input.scope,
        from: now,
        limit: WIDGET_EVENT_LIMIT,
      });

      // `resolveScopedEmbedEvents` returns the union already ordered
      // soonest-first (each leg runs `sort: "date"`; `scope: "all"` is
      // interleaved there), so we just cap to the window — the drop is the
      // deterministic FURTHEST-future tail.
      const upcomingEvents = scopedEvents.slice(0, WIDGET_EVENT_LIMIT);

      const eventRows = await loadEmbedEventRows(
        deps.repos,
        upcomingEvents.map((e) => e.id),
      );

      // An indexed event with no row is gone (index lag): no card, rather
      // than a card whose gate is unknown and whose link would 404.
      const events = upcomingEvents.flatMap((e) => {
        const row = eventRows.get(e.id);
        if (!row) return [];
        const { gateType } = row;
        return [
          {
            id: e.id,
            title: e.title,
            slug: e.slug,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            timezone: row.timezone,
            currency: e.currency ?? "usd",
            // Straight from the search index (see `EmbedEvent`) — the grid is
            // fully search-served, so pricing costs no extra query here.
            lowestPriceCents: e.lowestPriceCents,
            paidTierCount: e.paidTierCount,
            hasFreeTier: e.hasFreeTier,
            hasPayWhatYouWantTier: e.hasPayWhatYouWantTier,
            lowestBuyerTotalCents: e.lowestBuyerTotalCents,
            heroImageUrl: e.imageUrl,
            placeLabel: e.placeLabel,
            addressText: e.location,
            locality: e.city,
            region: e.region,
            gateType,
          },
        ];
      });

      return {
        embed: embedBase,
        // Legacy field: organization subjects only (undefined for humans).
        ...(organization ? { organization } : {}),
        owner,
        events,
      };
    }

    // ── Calendar embed: the named calendar's PUBLISHED events ────────
    // (venue-hierarchy FR-010 / NFR-002.) The whole read rides
    // `getCalendarEventsPublic` — ONE implementation of the public gates
    // (place VERIFIED+ACTIVE, PUBLISHED+PUBLIC events, moderation-gated
    // heroes, 90-day window, ≤100 rows); nothing is re-derived here, so the
    // embed can never drift ahead of the core read. Its output is `.strict()`
    // with ONLY {calendar, events} — availability/conflict internals are
    // structurally unrepresentable on this surface.
    if (embed.subjectType === "calendar") {
      const calendarResult = await getCalendarEventsPublic(
        { repos: deps.repos, logger },
        {
          mode: "public",
          calendarId: embed.subjectId,
          limit: WIDGET_EVENT_LIMIT,
        },
      );

      // The calendar read carries no gate; same batched row read as the grid.
      const calendarRows = await loadEmbedEventRows(
        deps.repos,
        calendarResult.events.map((e) => e.eventId),
      );

      return {
        embed: embedBase,
        calendar: {
          id: calendarResult.calendar.calendarId,
          name: calendarResult.calendar.name,
          slug: calendarResult.calendar.slug,
        },
        // A row gone between the two reads gets no card (see the grid).
        events: calendarResult.events.flatMap((e) => {
          const row = calendarRows.get(e.eventId);
          if (!row) return [];
          const { gateType } = row;
          return [
            {
              id: e.eventId,
              title: e.title,
              slug: e.slug,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
              // The calendar read projects the row's zone; resolved the same
              // way as the grid's.
              timezone: resolveTimeZone(e.timezone),
              // The calendar read doesn't project currency; "usd" matches the
              // fallback the org/human grid applies (`e.currency ?? "usd"`) and
              // is only consumed alongside price labels, which are null below.
              currency: "usd",
              // Pricing aggregation is deferred on the calendar read (see
              // toCalendarEvent's priceRange note — priceRange ships null until
              // batch aggregation lands). Null/0/false is the exact "no ACTIVE
              // tiers" projection, so the card renders its "See details"
              // fallback instead of a made-up price.
              lowestPriceCents: e.priceRange?.minCents ?? null,
              paidTierCount: 0,
              hasFreeTier: false,
              hasPayWhatYouWantTier: false,
              lowestBuyerTotalCents: null,
              // Already moderation-gated by the public path.
              heroImageUrl: e.primaryImageUrl,
              // The calendar read projects no place name (its `calendar.name` is
              // the calendar's, not the place's), and no query is added for one.
              placeLabel: null,
              // Address text isn't projected by the calendar read; city/region
              // are, and every event here is at the calendar's own place anyway.
              addressText: null,
              locality: e.city,
              region: e.region,
              gateType,
            },
          ];
        }),
      };
    }

    // ── Event embed: return single event + ticket types ──────────────
    if (embed.subjectType !== "event") {
      throw fail("UNSUPPORTED_SUBJECT_TYPE");
    }

    const event = await deps.repos.events.getById(embed.subjectId, {
      withOwnerStanding: true,
    });
    // A banned owner's event is withheld (ban-that-sticks).
    if (
      !event ||
      event.status !== "PUBLISHED" ||
      event.ownerBanned === true
    ) {
      throw fail("EVENT_NOT_FOUND");
    }

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    const activeTicketTypes = ticketTypes.filter(
      (tt) => tt.status === "ACTIVE",
    );

    const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, [event]);

    // The venue floors the event's public location (fails closed when the
    // venue row is gone or unreadable).
    const placeLocations = await resolvePlaceLocations(deps, [event.placeId], {
      useCase: "getEmbedForWidget",
    });
    const location = projectPublicEventLocation(event, {
      place: event.placeId ? (placeLocations.get(event.placeId) ?? null) : null,
    });

    // Same three pricing fields the grid gets from the index, derived from the
    // tiers already in hand — see `summarizeTicketPricing`. ONE instant, shared
    // with the per-tier list below.
    const now = deps.clock.now();
    const pricing = summarizeTicketPricing(activeTicketTypes, now);
    // The all-in figure over the same tiers at the same instant, through the
    // loader every listing uses. Degrades to null (reported), never to face.
    const buyerTotals = await loadListingBuyerTotalsByEventId(
      { repos: deps.repos, reportError: deps.reportError, logger },
      [event],
      new Map([[event.id, activeTicketTypes]]),
      now,
      { useCase: "getEmbedForWidget" },
    );

    return {
      embed: embedBase,
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        startsAt: event.startsAt,
        endsAt: event.endsAt ?? null,
        timezone: resolveTimeZone(event.timezone),
        currency: event.currency ?? "usd",
        lowestPriceCents: pricing.lowestPriceCents,
        paidTierCount: pricing.paidTierCount,
        hasFreeTier: pricing.hasFreeTier,
        hasPayWhatYouWantTier: pricing.hasPayWhatYouWantTier,
        lowestBuyerTotalCents: buyerTotals.get(event.id) ?? null,
        heroImageUrl: gateHeroUrl(event, visibleHeroKeys),
        // No place name here: whether a place may be NAMED on an event is the
        // place-confirmation decision (`cardVenueName`), which this branch
        // does not run. `resolvePlaceLocations` carries the place's location
        // privacy only, and the public projection has no name field.
        placeLabel: null,
        // THE public projection: an OBSCURED event (or one at a withheld
        // venue) shows "locality, region", never its street.
        addressText: location.label,
        locality: location.locality,
        region: location.region,
        gateType: embedGateTypeOf(event),
      },
      // A gated event's tier list (names, prices, stock) is page content the
      // embed can never unlock — the main site's card hover answers a gated
      // viewer with no tiers too (`events.ticketTiersForCard`). The card's
      // price line above stays, as on every listing card.
      ticketTypes: (isEventUngatedForEmbed(event)
        ? activeTicketTypes
        : []
      ).map((tt) => ({
        id: tt.id,
        name: tt.name,
        // Effective ONLINE price at `now` (FR-004) — same instant as `pricing`
        // above, so the card badge and the tier list cannot disagree.
        priceCents: resolveUnitPriceCents(tt, { now }),
        capacity: tt.capacity,
        status: tt.status,
      })),
    };
  };

  if (logger) {
    return logger.withTime("getEmbedForWidget", execute);
  }
  return execute();
}

/**
 * Each event's gate and zone from its ROW (the search index and the public
 * calendar read do not carry the gate; the index lacks the zone on documents
 * indexed before it was stored), in ONE batched read. An id with no row is
 * absent from the map; the callers drop that card. The gate is typed through
 * {@link embedGateTypeOf}, so an unknown stored value reads gated; the zone
 * through `resolveTimeZone`, so an unusable one reads as the platform default.
 */
async function loadEmbedEventRows(
  repos: Pick<Repos, "events">,
  ids: readonly string[],
): Promise<Map<string, { gateType: EmbedGateType; timezone: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const records = await repos.events.findManyByIds(unique);
  return new Map(
    records.map(
      (r) =>
        [
          r.id,
          {
            gateType: embedGateTypeOf(r),
            timezone: resolveTimeZone(r.timezone),
          },
        ] as const,
    ),
  );
}

import { z } from "zod";

import { listingPriceSchema } from "@th/types";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";

import { parseInput } from "../../lib/io";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import { resolvePlaceLocations } from "../../lib/location/resolve-place-locations";
import { DEFAULT_VENUE_TIMEZONE } from "../../lib/venue-local-time";
import type { ListingBuyerTotalEvent } from "../events/_shared/listing-buyer-totals";
import {
  calendarOccurrenceSchema,
  expandEventDates,
} from "../events/expand-event-dates";
import {
  CALENDAR_EVENTS_MAX_WINDOW_MS,
  getCalendarEventsPublic,
} from "../events/get-calendar-events";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { isEventUngatedForEmbed } from "./_shared/assert-event-ungated-for-embed";
import {
  loadCalendarSalesState,
  UNKNOWN_CALENDAR_SALES_STATE,
  type CalendarSalesState,
} from "./_shared/calendar-sales-state";
import {
  embedScopeSchema,
  resolveScopedEmbedEvents,
  type EmbedEvent,
} from "./_shared/embed-scope";
import { fail } from "@th/errors";

// ── Input / output schemas ───────────────────────────────────────────────────

/**
 * Hard ceiling on ITEMS in one response — applied to the search legs' fetch
 * AND re-applied after FR-003 expansion, because one 60-night listing among
 * 200 events would otherwise balloon an unauthenticated payload to ~12k rows.
 */
const CALENDAR_EVENT_LIMIT = 200;

/**
 * Month-view lookback: events from 30 days ago forward, so the grid has
 * context on either side of today. `to` is the core calendar read's own
 * clamp (`CALENDAR_EVENTS_MAX_WINDOW_MS`, 90 days from `from` = now + 60d);
 * which legs it bounds is stated per leg below.
 */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// Both bounds are fixed-ms arithmetic so `to − from === CALENDAR_EVENTS_MAX_WINDOW_MS`
// EXACTLY — the core read's input guard rejects a window one ms wider.
function embedWindow(now: Date): { from: Date; to: Date } {
  const from = new Date(now.getTime() - LOOKBACK_MS);
  return { from, to: new Date(from.getTime() + CALENDAR_EVENTS_MAX_WINDOW_MS) };
}

export const getEmbedCalendarEventsInputSchema = z
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

// `.strict()` (FR-001): the wire shape is exact — every leg projects its
// keys explicitly (`mapScopedEvent` / `mapEventRecord` / the calendar map)
// before expansion, and `expandEventDates` adds only `occurrence`.
const calendarEventSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startsAt: z.date().nullable(),
  endsAt: z.date().nullable(),
  status: z.string(),
  slug: z.string().nullable(),
  /**
   * The place name the list view's cards print first (`EmbedEvent.placeLabel`:
   * the search index's label, sent only for an event whose public location is
   * exact). Set on the org/human legs only; null on the calendar and
   * single-event legs, which have no public-safe name in hand — the same
   * values `getEmbedForWidget` sends, so one event reads the same in both
   * views.
   */
  placeLabel: z.string().nullable(),
  location: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  /**
   * `Event.timezone` (event-calendar-redesign FR-001) — the public embed
   * engine paints in the venue zone and needs each chip's own zone to flag
   * a mismatch. Search-served legs resolve it from the event row in one
   * batched read (the index does not carry it).
   */
  timezone: z.string(),
  /** "Date N of M" for an EventDate-expanded occurrence (FR-003); else null. */
  occurrence: calendarOccurrenceSchema,
  /**
   * Whether the in-iframe detail/checkout path (`embeds.getEventDetail` +
   * `embeds.createGuestCheckout`) will ACCEPT this event. Mirrors the rule
   * those use cases enforce via `assertEventAllowedForEmbed` — a UI hint
   * only, never a substitute for the server-side check:
   * - organization subject → true iff the event came from the OWN search leg
   *   (owner-scoped `orgId` filter ⇒ `event.orgId === embed.subjectId`, the
   *   exact org-branch rule). Venue-leg events are conservatively false.
   * - human subject → always false (checkout rejects human subjects with
   *   UNSUPPORTED_SUBJECT_TYPE).
   * - event subject → true (this branch only ever returns the pinned event,
   *   which is `assertEventAllowedForEmbed`'s fast path).
   * - time clamp, applied PER ITEM after FR-003 expansion: only an
   *   upcoming-or-ongoing occurrence (its OWN `endsAt ?? startsAt` not yet
   *   passed) stays eligible — a past night of a future-pinned listing is a
   *   past night.
   */
  checkoutEligible: z.boolean(),
  /**
   * FR-022: the chip renders dimmed with a "Sold out" tag when true. True only
   * when the event HAS ACTIVE ticket types and EVERY one of them is out of
   * stock on the `capacity - issued - held` basis the pre-charge gate refuses
   * on (`_helpers/load-ticket-type-availability.ts`) — NEVER the authored
   * `TicketType.capacity` column, which no write path decrements and which
   * therefore reads "available" for a fully-sold tier. RSVP, free and
   * ticketless listings are always false.
   *
   * A BOOLEAN, deliberately. This is an unauthenticated read served into a
   * third party's page: it answers "can I still buy this" and leaks neither
   * remaining stock nor a per-tier breakdown.
   */
  soldOut: z.boolean(),
  /**
   * FR-023: the week row's price line — "$25" / "From $25" / "Free+" /
   * "Free", the ALL-IN figure (ticket + fees + tax, as checkout charges) of
   * the cheapest ACTIVE, on-sale tier at the event's own currency. "Free" is a
   * free-only event; "Free+" has free and paid tiers. Null when there is no
   * price to show (ticketless, every tier outside its sales window, or a paid
   * event whose all-in figure cannot be computed), which is how the week row
   * decides to render nothing rather than "$0" or a face price. Month chips
   * never render it at all.
   */
  priceLabel: z.string().nullable(),
  /**
   * The same price as data (`resolveListingPrice`), worded by the embed in
   * the viewer's language. Null exactly when `priceLabel` is null.
   */
  listingPrice: listingPriceSchema.nullable(),
}).strict();

export const getEmbedCalendarEventsOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
      domain: z.string(),
      /**
       * When true the widget sends ALL clicks out to ithasfire.com instead of
       * the in-iframe checkout, regardless of per-event eligibility.
       */
      linkOut: z.boolean(),
      /**
       * Config-time browse-view default, mirrored from `getEmbedForWidget` so
       * the toggle can render identically no matter which query loaded first.
       * A bare string (not an enum) so an unrecognised stored value degrades to
       * "list" client-side instead of throwing the whole payload out.
       *
       * OUTPUT-only: the input schema above stays byte-frozen — `view` is
       * resolved from the URL client-side and must never become an input.
       */
      defaultView: z.string(),
      /** Render the viewer-facing List/Calendar switcher. */
      viewToggle: z.boolean(),
    }),
    /** Display name for the calendar owner (org name, venue name, or host name). */
    ownerName: z.string(),
    events: z.array(calendarEventSchema),
  })
  .strict();

export type GetEmbedCalendarEventsInput = z.infer<
  typeof getEmbedCalendarEventsInputSchema
>;
export type GetEmbedCalendarEventsOutput = z.infer<
  typeof getEmbedCalendarEventsOutputSchema
>;

// ── Dependencies ─────────────────────────────────────────────────────────────

export type GetEmbedCalendarEventsDeps = {
  repos: Pick<
    Repos,
    | "embeds"
    | "events"
    | "eventDates"
    | "organizations"
    | "places"
    | "humans"
    | "calendars"
    | "imageModerationRecords"
    /**
     * FR-022 sold-out only, through the LOCK-FREE batch counter. The LOCKING
     * counter must never be reached from here — this is a public read and
     * would queue behind live checkouts.
     */
    | "tickets"
    /** FR-023's all-in price label: the fee context and the venue tax situs. */
    | "payoutTerms"
    | "feePolicies"
    | "savedLocations"
  >;
  /**
   * REQUIRED (FR-003). The calendar window and the FR-023 price label are both
   * evaluated at this instant — the label resolves each tier's effective price
   * and sales window at `now`, so a defaulted clock would quote a pre-flip
   * price on a partner's site.
   */
  clock: ClockPort;
  /**
   * Unified search — the org/human event legs are fully search-served through
   * this (the SAME query the platform uses everywhere else). The single-event
   * subject path still reads the event directly from `repos.events`.
   */
  search: MultiSearchQueryPort;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  /**
   * CLAUDE.md swallow convention. The FR-022/FR-023 sales-state enrichment
   * DEGRADES rather than throwing (a failed stock read must never blank a
   * partner's calendar), so its catch branch reports here — the only path by
   * which that failure reaches Sentry.
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Public use case: resolves an embed and returns its associated events
 * in a shape suitable for the embeddable calendar widget.
 *
 * Subject types:
 * - `organization` / `human` — the subject's events, selected by `scope`
 *   (`own` | `venues` | `all`; see `_shared/embed-scope.ts`).
 * - `event` — the single event, so it shows on a calendar. `scope` is
 *   meaningless here and is ignored.
 * - `calendar` — the named Calendar's PUBLISHED events (venue-hierarchy
 *   FR-010), read through `getCalendarEventsPublic` so the public gates live
 *   in exactly one place. `scope` is ignored.
 */
export async function getEmbedCalendarEvents(
  deps: GetEmbedCalendarEventsDeps,
  rawInput: unknown,
): Promise<GetEmbedCalendarEventsOutput> {
  const logger = deps.logger?.child({ useCase: "getEmbedCalendarEvents" });

  const resolve = async () => {
    const input = parseInput(getEmbedCalendarEventsInputSchema, rawInput);

    // 1. Load and validate embed
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
      linkOut: embed.linkOut,
      defaultView: embed.defaultView,
      viewToggle: embed.viewToggle,
    };

    // ── Organization / human embed ───────────────────────────────────
    // Both resolve to "a subject that owns events and/or venues"; only the
    // owner lookup and display name differ.
    if (embed.subjectType === "organization" || embed.subjectType === "human") {
      let ownerType: "ORGANIZATION" | "HUMAN";
      let ownerName: string;

      if (embed.subjectType === "organization") {
        const org = await deps.repos.organizations.getById(embed.subjectId);
        if (!org) {
          throw fail("ORGANIZATION_NOT_FOUND");
        }
        ownerType = "ORGANIZATION";
        ownerName = org.name;
      } else {
        const human = await deps.repos.humans.getById(embed.subjectId);
        if (!human) {
          throw fail("HUMAN_NOT_FOUND");
        }
        ownerType = "HUMAN";
        // `Human.name` is the display name on the model and is nullable.
        // `ownerName` is a non-nullable header string, so fall back to a
        // neutral label rather than rendering "null" or leaking an id.
        ownerName = human.name ?? "Events";
      }

      // ORG/HUMAN LEG RULE: `from` only, no `to` — on the search legs AND
      // on the FR-003 expansion below. The search admits events from `from`
      // forward with no forward bound (soonest-first, capped), so a listing
      // it admitted may have EVERY night past `embedWindow().to`; trimming
      // to `to` would emit nothing for it (`expandEventDates` deliberately
      // drops a listing with rows but none in-window) while a row-less
      // event on the same night still rendered. Volume stays bounded by the
      // post-expansion re-cap to CALENDAR_EVENT_LIMIT in `withOccurrences`.
      const now = deps.clock.now();
      const window = { from: embedWindow(now).from };
      const cutoff = window.from;

      // Fully search-served: own + venues legs both come from `unifiedSearch`
      // with `publishedOnly` and WITHOUT `includeNonPublicEvents`, so PRIVATE
      // events are excluded (the leak the old `listByOwner` path had is closed).
      const scopedEvents = await resolveScopedEmbedEvents({
        search: deps.search,
        logger,
        places: deps.repos.places,
        ownerType,
        ownerId: embed.subjectId,
        scope: input.scope,
        from: cutoff,
        limit: CALENDAR_EVENT_LIMIT,
      });

      // `resolveScopedEmbedEvents` returns the union already ordered
      // soonest-first (each leg runs `sort: "date"`; `scope: "all"` is
      // interleaved there), so we just cap to the window — the drop is the
      // deterministic FURTHEST-future tail, not a least-popular one.
      // `checkoutEligible` mirrors `assertEventAllowedForEmbed` (the rule the
      // in-iframe detail/checkout use cases enforce):
      // - organization: its org branch requires `event.orgId === subjectId`.
      //   The OWN leg is exactly the `orgId: subjectId`-filtered search, so
      //   own-leg events satisfy it; venue-leg events (any creator) are
      //   conservatively ineligible. An event in BOTH legs keeps `leg: "own"`
      //   (dedupe keeps the first occurrence; own is passed first).
      // - human: checkout rejects human subjects outright ⇒ always false.
      // - time clamp: applied PER ITEM in `withOccurrences`, after expansion
      //   (the 30-day lookback means PAST events and past NIGHTS render for
      //   month context). Ineligible clicks aren't dead ends — the widget
      //   links them out to the canonical event page, which owns real
      //   sales-window handling.
      const orgSubject = embed.subjectType === "organization";
      const capped = scopedEvents.slice(0, CALENDAR_EVENT_LIMIT);
      // The search index carries neither timezone (FR-001) nor the event's
      // currency (FR-023 needs it to format a price label) — ONE batched row
      // read serves both. A hit whose row is gone (index lag) keeps rendering
      // with the platform default zone rather than vanishing from the calendar.
      const rowById = await loadEventRows(
        deps.repos,
        capped.map((e) => e.id),
      );
      // FR-022 / FR-023, batched for the WHOLE page (two queries total, not
      // two per event) — see `loadCalendarSalesState`.
      const salesStateById = await loadCalendarSalesState(
        { repos: deps.repos, reportError: deps.reportError, logger },
        {
          events: capped.map((e) => ({
            id: e.id,
            currency: rowById.get(e.id)?.currency ?? null,
            row: rowById.get(e.id)?.record ?? null,
          })),
          now,
        },
      );
      // A gated event is never sold in the widget (owner ruling 2026-10-12):
      // ineligible, so its click links out to the event on Ithas Fire. Read
      // from the row already loaded; a hit with no row fails closed.
      const events = capped.map((e) =>
        mapScopedEvent(
          e,
          rowById.get(e.id)?.timezone ?? DEFAULT_VENUE_TIMEZONE,
          orgSubject &&
            e.leg === "own" &&
            isEventUngatedForEmbed({
              gateType: rowById.get(e.id)?.gateType ?? null,
            }),
          salesStateById.get(e.id) ?? UNKNOWN_CALENDAR_SALES_STATE,
        ),
      );

      return {
        embed: embedBase,
        ownerName,
        events: await withOccurrences(deps.repos, events, window, now),
      };
    }

    // ── Named-calendar embed (venue-hierarchy FR-010 / NFR-002) ──────
    if (embed.subjectType === "calendar") {
      // CALENDAR LEG RULE: `[from, to]` on the read AND on the FR-003
      // expansion below — the ONE leg with a forward bound. `to` is passed
      // EXPLICITLY (it equals the core read's own clamp, so the read accepts
      // it unchanged) because the expansion must trim to the very window the
      // repo admitted events for. The limit ceiling (100 rows) is still the
      // core read's, not re-derived.
      //
      // `includeDateOccurrences`: the core read admits an event on ANY
      // in-window SCHEDULED night, not only its pinned instant — a recurring
      // listing pinned before the lookback still has nights on this
      // calendar. This leg is the one caller that expands afterwards, which
      // is why the flag is opt-in on the read (see its input doc).
      const now = deps.clock.now();
      const window = embedWindow(now);

      const calendarResult = await getCalendarEventsPublic(
        { repos: deps.repos, logger },
        {
          mode: "public",
          calendarId: embed.subjectId,
          from: window.from,
          to: window.to,
          limit: 100,
          includeDateOccurrences: true,
        },
      );

      // The calendar read projects no currency (its `.strict()` public shape
      // is deliberately narrow), so FR-023 needs one batched row read here
      // too. Timezone already rides on the calendar row, so only `currency`
      // is taken from it.
      const calendarRowById = await loadEventRows(
        deps.repos,
        calendarResult.events.map((e) => e.eventId),
      );
      const calendarSalesStateById = await loadCalendarSalesState(
        { repos: deps.repos, reportError: deps.reportError, logger },
        {
          events: calendarResult.events.map((e) => ({
            id: e.eventId,
            currency: calendarRowById.get(e.eventId)?.currency ?? null,
            row: calendarRowById.get(e.eventId)?.record ?? null,
          })),
          now,
        },
      );

      const events = calendarResult.events.map((e) => ({
        id: e.eventId,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        // publishedOnly by construction on the public read.
        status: e.status,
        slug: e.slug,
        // The calendar read projects no place name (its public shape is
        // deliberately narrow); the list view sends null here too.
        placeLabel: null,
        // Address text isn't projected by the calendar read; city/region
        // are, and every event here is at the calendar's own place.
        location: null,
        city: e.city,
        region: e.region,
        timezone: e.timezone,
        // Conservatively ineligible: `assertEventAllowedForEmbed` (the rule
        // the in-iframe detail/checkout use cases enforce) has no calendar
        // branch — the events on a venue's calendar can belong to ANY
        // creator, which is exactly the venue-leg posture above. Clicks
        // link out to the canonical event page.
        checkoutEligible: false,
        ...(calendarSalesStateById.get(e.eventId) ??
          UNKNOWN_CALENDAR_SALES_STATE),
      }));

      return {
        embed: embedBase,
        ownerName: calendarResult.calendar.name,
        events: await withOccurrences(deps.repos, events, window, now),
      };
    }

    // ── Single event embed ───────────────────────────────────────────
    if (embed.subjectType === "event") {
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

      const now = deps.clock.now();
      // One event, so the "batch" is a page of one — same code path, same two
      // queries, rather than a second hand-rolled derivation of sold-out.
      const salesStateById = await loadCalendarSalesState(
        { repos: deps.repos, reportError: deps.reportError, logger },
        {
          events: [
            { id: event.id, currency: event.currency ?? null, row: event },
          ],
          now,
        },
      );

      // The venue floors the event's public location (fails closed when the
      // venue row is gone or unreadable).
      const placeLocations = await resolvePlaceLocations(
        { repos: deps.repos, reportError: deps.reportError, logger },
        [event.placeId],
        { useCase: "getEmbedCalendarEvents" },
      );

      return {
        embed: embedBase,
        ownerName: event.title,
        // The pinned event itself — `assertEventAllowedForEmbed`'s event-subject
        // fast path (`embed.subjectId === event.id`) always accepts it. NOTE:
        // this branch returns ONLY the pinned event (no series-sibling dates),
        // so the series relaxation never needs modelling here. Same per-item
        // time clamp as the scoped branch (in `withOccurrences`): a pinned
        // event that has ENDED links out. A pinned multi-date LISTING still
        // expands to its own nights (FR-003) — those are the same event, not
        // siblings — and each night is clamped on its own instant.
        events: await withOccurrences(
          deps.repos,
          [
            mapEventRecord(
              event,
              event.placeId
                ? (placeLocations.get(event.placeId) ?? null)
                : null,
              salesStateById.get(event.id) ?? UNKNOWN_CALENDAR_SALES_STATE,
            ),
          ],
          null,
          now,
        ),
      };
    }

    throw fail("UNSUPPORTED_SUBJECT_TYPE");
  };

  // One exit: every branch's payload runs through the strict output schema,
  // so an extra key from any leg fails here rather than reaching the wire.
  const execute = async (): Promise<GetEmbedCalendarEventsOutput> =>
    getEmbedCalendarEventsOutputSchema.parse(await resolve());

  if (logger) {
    return logger.withTime("getEmbedCalendarEvents", execute);
  }
  return execute();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * True while the event hasn't finished: upcoming, or started but not yet over
 * (door sales during an in-progress event are legitimate). Events without an
 * `endsAt` are treated as over once `startsAt` passes.
 */
function isUpcomingOrOngoing(
  startsAt: Date,
  endsAt: Date | null,
  now: Date,
): boolean {
  return (endsAt ?? startsAt).getTime() >= now.getTime();
}

/**
 * The `Event` columns the search index and the public calendar read do NOT
 * carry: `timezone` (FR-001), `currency` (FR-023's price label must be in the
 * event's own currency, never an assumed USD) and the columns the all-in price
 * depends on (`record`: org, tax rate and instruction flag, venue / location
 * for the tax situs). ONE batched read, deduped by id. Ids with no row (index
 * lag) are simply absent from the map and the callers fall back.
 */
async function loadEventRows(
  repos: Pick<Repos, "events">,
  ids: readonly string[],
): Promise<
  Map<
    string,
    {
      timezone: string;
      currency: string | null;
      /** The event's gate: a gated event is never checkout-eligible. */
      gateType: string | null;
      record: ListingBuyerTotalEvent;
    }
  >
> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const records = await repos.events.findManyByIds(unique);
  return new Map(
    records.map(
      (r) =>
        [
          r.id,
          {
            timezone: r.timezone,
            currency: r.currency ?? null,
            gateType: r.gateType ?? null,
            record: r,
          },
        ] as const,
    ),
  );
}

/**
 * FR-003 on every leg through ONE path: one item per SCHEDULED EventDate of
 * each multi-date listing (`occurrence` set), everything else untouched
 * (`occurrence: null`). `window` trims a listing's nights to the bounds the
 * LEG admitted events on — `[from, to]` for the calendar leg, `from` only
 * for the search legs (see each leg's rule comment); null = no trim (the
 * single pinned event shows every night). Chronological, matching the legs'
 * soonest-first order, then RE-CAPPED to `CALENDAR_EVENT_LIMIT`: the legs
 * cap EVENTS before expansion, so without this a handful of long residencies
 * could multiply an unauthenticated response many times over. Earliest items
 * win — the drop is the deterministic furthest-future tail, same posture as
 * the search legs.
 *
 * `checkoutEligible` on input carries every NON-time factor (leg, subject
 * type); the time clamp is applied here PER EMITTED ITEM from its own
 * `startsAt`/`endsAt` — after expansion, so a past night of a future-pinned
 * listing is ineligible and a future night of a past-pinned one is not.
 *
 * `soldOut` / `priceLabel` (FR-022 / FR-023) ride through untouched, so every
 * expanded occurrence INHERITS its parent's values. That is correct, not an
 * approximation: a multi-date community listing has ONE set of ticket types
 * and one pool of stock for the whole run — inventory is per EVENT, not per
 * night — so all of its nights are sold out together or not at all. Per-night
 * stock would need per-EventDate ticket types, which the model does not have.
 */
async function withOccurrences<
  E extends {
    id: string;
    startsAt: Date | null;
    endsAt: Date | null;
    checkoutEligible: boolean;
  },
>(
  repos: Pick<Repos, "eventDates">,
  events: readonly E[],
  window: { from: Date; to?: Date } | null,
  now: Date,
) {
  const dates =
    events.length > 0
      ? await repos.eventDates.listByEventIds({
          eventIds: events.map((e) => e.id),
          statuses: ["SCHEDULED"],
        })
      : [];
  return expandEventDates(events, dates, {
    window: window ?? undefined,
    sort: "startsAt",
  })
    .slice(0, CALENDAR_EVENT_LIMIT)
    .map((item) => ({
      ...item,
      checkoutEligible:
        item.checkoutEligible &&
        item.startsAt !== null &&
        isUpcomingOrOngoing(item.startsAt, item.endsAt, now),
    }));
}

/**
 * Project a search-served {@link EmbedEvent} onto the calendar output shape.
 * `checkoutEligible` here is the leg/subject factor only — the per-item time
 * clamp is `withOccurrences`'.
 */
function mapScopedEvent(
  e: EmbedEvent,
  timezone: string,
  checkoutEligible: boolean,
  salesState: CalendarSalesState,
) {
  return {
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    // Every leg is `publishedOnly` — these are PUBLISHED by construction.
    status: "PUBLISHED",
    slug: e.slug,
    // Already exact-only at the source (`suggestionToEmbedEvent`).
    placeLabel: e.placeLabel,
    location: e.location,
    city: e.city,
    region: e.region,
    timezone,
    checkoutEligible,
    ...salesState,
  };
}

/** Single-event subject path: map the directly-loaded event record. */
function mapEventRecord(
  e: {
    id: string;
    title: string;
    startsAt: Date;
    endsAt: Date | null;
    status: string;
    slug: string | null;
    addressText: string | null;
    locality?: string | null;
    region?: string | null;
    timezone: string;
    orgId?: string | null;
    humanId?: string | null;
    /** Required (N5): a missing gate projects as gated (label only). */
    gateType: string | null | undefined;
    locationMode?: string | null;
    locationRadiusMeters?: number | null;
    lat?: number | null;
    lng?: number | null;
  },
  /** The event's venue privacy row; null for an event with no venue. */
  place: PlaceLocationSource | null,
  salesState: CalendarSalesState,
) {
  // THE public projection: an OBSCURED event (or one at a withheld venue)
  // shows "locality, region", never its street.
  const location = projectPublicEventLocation(e, { place });
  // Only the PINNED event is ever mapped here (`assertEventAllowedForEmbed`'s
  // fast path), so eligibility is the gate plus `withOccurrences`' per-item
  // time clamp. A gated event is never sold in the widget (owner ruling
  // 2026-10-12): its click links out to the event on Ithas Fire.
  const checkoutEligible = isEventUngatedForEmbed(e);
  return {
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    status: e.status,
    slug: e.slug,
    // Naming the place is the place-confirmation decision, which this branch
    // does not run; the list view's single-event branch sends null as well.
    placeLabel: null,
    location: location.label,
    city: location.locality,
    region: location.region,
    timezone: e.timezone,
    checkoutEligible,
    ...salesState,
  };
}

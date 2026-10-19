import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventRecord, EventStatus } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { parseInput } from "../../lib/io";
import {
  isVenueConfirmed,
  isVenueOwnedEvent,
  venueConfirmedFilterFor,
} from "../../lib/venue-confirmation";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { fail } from "@th/errors";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";
import {
  resolveBookingHoldOverlay,
  calendarHoldOverlaySchema,
  type CalendarHoldOverlayDeps,
} from "./_shared/booking-hold-overlay";
import {
  calendarOccurrenceSchema,
  expandEventDates,
  type CalendarOccurrence,
} from "./expand-event-dates";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum / default look-ahead window: 90 days in milliseconds. */
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const VALID_STATUSES: EventStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "COMPLETED",
  "CANCELLED",
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Shared calendar-event projection (also reused by get-calendar-events). */
export const calendarEventSchema = z
  .object({
    eventId: z.string().uuid(),
    slug: z.string().nullable(),
    title: z.string(),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    status: z.string(),
    primaryImageUrl: z.string().nullable(),
    priceRange: z
      .object({
        minCents: z.number().int(),
        maxCents: z.number().int(),
      })
      .nullable(),
    soldOut: z.boolean().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    seriesId: z.string().uuid().nullable(),
    seriesName: z.string().nullable(),
    /**
     * `Event.calendarId` — the named Calendar (programming stream) the event
     * sits on, null when unplaced (event-calendar-redesign phase 2: the
     * calendar filter chips key on this). Projected on every leg, admin and
     * public alike — it is a placement, not an internal.
     */
    calendarId: z.string().uuid().nullable(),
    /**
     * `Event.timezone` — the IANA zone the event's wall-clock times live in
     * (event-calendar-redesign FR-001). The grid paints in the venue zone;
     * this is what the per-chip mismatch glyph compares against.
     */
    timezone: z.string(),
    /**
     * "Date N of M" for an EventDate-expanded occurrence of a multi-date
     * community listing (FR-003); null for single-date and series events.
     */
    occurrence: calendarOccurrenceSchema,
    /**
     * Venue-confirmation spec (docs/specs/2026-08-27): whether the venue
     * vouches for this event at this place — venue-owned, or stamped and not
     * withdrawn (`lib/venue-confirmation`, THE derivation). PUBLIC reads only
     * ever return confirmed events (the repo filters on `venueConfirmedFor`),
     * so it is always `true` there. ADMIN reads return every event, flagged,
     * so the venue sees who is claiming its room; unconfirmed ones are
     * excluded from `conflicts` (they block nothing).
     */
    venueConfirmed: z.boolean(),
    /**
     * Confirmed BY CONSTRUCTION: the place's owner (org or direct human)
     * owns the event (`isVenueOwnedEvent`). Always implies `venueConfirmed`.
     * The venue calendar offers "Withdraw confirmation" only on confirmed
     * chips that are NOT venue-owned — `withdrawVenueConfirmation` refuses
     * a venue-owned event (`venue_owned_event`), so the projection must
     * let the UI tell the two apart.
     */
    venueOwned: z.boolean(),
  })
  .strict();

/** Shared space-conflict pair (also reused by get-calendar-events, admin). */
export const conflictSchema = z
  .object({
    eventAId: z.string().uuid(),
    eventBId: z.string().uuid(),
    overlapMinutes: z.number().int().min(1),
  })
  .strict();

const pageInfoSchema = z
  .object({
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    hasMore: z.boolean(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas (discriminated union on `mode`)
// ─────────────────────────────────────────────────────────────────────────────

const adminInputSchema = z
  .object({
    mode: z.literal("admin"),
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    from: z.date(),
    to: z.date(),
    statuses: z
      .array(z.enum(["DRAFT", "PUBLISHED", "COMPLETED", "CANCELLED"]))
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from.getTime() >= value.to.getTime()) {
      ctx.addIssue({ code: "custom", message: "invalid_time_window" });
    }
    if (value.to.getTime() - value.from.getTime() > MAX_WINDOW_MS) {
      ctx.addIssue({ code: "custom", message: "time_window_too_large" });
    }
  });

const publicInputSchema = z
  .object({
    mode: z.literal("public"),
    // `placeId` only. There is deliberately no slug input: `Place.slug` is
    // deprecated (a multi-segment directory key no route resolved) and a
    // place's public slug lives on its `EntityPage`, which callers resolve
    // through `entityPages` before reaching a calendar.
    placeId: z.string().uuid(),
    from: z.date().optional(),
    to: z.date().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from.getTime() >= value.to.getTime()) {
      ctx.addIssue({ code: "custom", message: "invalid_time_window" });
    }
  });

export const getVenueCalendarInputSchema = z.discriminatedUnion("mode", [
  adminInputSchema,
  publicInputSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Output schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUBLIC shape — byte-identical to the pre-holds output (booking-holds
 * FR-014: the public calendar never reads the hold table). Kept under its
 * historical name so the public procedure's `.output()` is unchanged.
 */
export const getVenueCalendarOutputSchema = z
  .object({
    events: z.array(calendarEventSchema),
    conflicts: z.array(conflictSchema),
    pageInfo: pageInfoSchema.nullable(),
    /**
     * `Place.timezone`, resolved to a valid IANA zone (FR-001; the column is
     * nullable — an unset/invalid zone falls back to the platform default
     * exactly as every other venue-local computation does). The place and
     * embed engines paint in THIS zone, never browser-local.
     */
    venueTimezone: z.string(),
  })
  .strict();

/**
 * ADMIN shape — the public shape plus the LIVE hold overlay (FR-014): stacked
 * tentative chips for the day view. Holds never enter `conflicts` — a hold
 * blocks nothing, only a confirmed event does.
 */
export const getVenueCalendarAdminOutputSchema = getVenueCalendarOutputSchema
  .extend({
    holds: z.array(calendarHoldOverlaySchema),
  })
  .strict();

export type GetVenueCalendarInput = z.infer<typeof getVenueCalendarInputSchema>;
export type GetVenueCalendarPublicOutput = z.infer<
  typeof getVenueCalendarOutputSchema
>;
export type GetVenueCalendarAdminOutput = z.infer<
  typeof getVenueCalendarAdminOutputSchema
>;
export type GetVenueCalendarOutput =
  | GetVenueCalendarPublicOutput
  | GetVenueCalendarAdminOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetVenueCalendarDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "eventDates"
    | "places"
    | "authz"
    | "seriesOccurrences"
    | "imageModerationRecords"
  > &
    CalendarHoldOverlayDeps["repos"];
  logger?: LoggerPort;
  /** Admin hold overlay only: a failed performer-name lookup degrades + reports. */
  reportError?: CalendarHoldOverlayDeps["reportError"];
  /** Admin hold overlay only (lazy-expiry projection). Defaults to wall time. */
  clock?: { now(): Date };
};

// ─────────────────────────────────────────────────────────────────────────────
// Conflict detection (pure helper)
// ─────────────────────────────────────────────────────────────────────────────

interface TimeBounded {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Detect overlapping event pairs, keyed by SPACE (venue-hierarchy FR-006).
 *
 * Two events conflict ONLY when they share the same NON-NULL `spaceId` and
 * overlap in time — the space is the physical resource being double-booked.
 * Events with a null/absent `spaceId` (freeform-address or pre-hierarchy rows
 * outside the space system) are EXEMPT from conflict analysis entirely: with
 * no space there is nothing physical to contend for, and flagging them would
 * cry wolf on every co-located pair.
 *
 * Backfill equivalence note: the Step-1 seed/backfill gives every
 * place-linked event the place's single default space, so on a one-space place
 * this per-space detection is behaviourally IDENTICAL to the old per-place
 * detection (pinned by test). Only genuinely multi-space places diverge —
 * which is the point: different spaces, same night, no conflict.
 *
 * Only considers events that have an `endsAt`; unbounded events are excluded.
 */
export function detectConflicts(
  events: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date | null;
    spaceId?: string | null;
  }>,
): Array<{ eventAId: string; eventBId: string; overlapMinutes: number }> {
  // Group by space; spaceless events never enter a group (exempt).
  const bySpace = new Map<string, TimeBounded[]>();
  for (const e of events) {
    if (e.spaceId == null || e.endsAt == null) continue;
    const group = bySpace.get(e.spaceId) ?? [];
    group.push({ id: e.id, startsAt: e.startsAt, endsAt: e.endsAt });
    bySpace.set(e.spaceId, group);
  }

  const conflicts: Array<{
    eventAId: string;
    eventBId: string;
    overlapMinutes: number;
  }> = [];

  for (const group of bySpace.values()) {
    detectOverlapsInGroup(group, conflicts);
  }

  return conflicts;
}

/** Sweep one space's bounded events for overlapping pairs (unchanged math). */
function detectOverlapsInGroup(
  bounded: TimeBounded[],
  conflicts: Array<{
    eventAId: string;
    eventBId: string;
    overlapMinutes: number;
  }>,
): void {
  const sorted = [...bounded].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.startsAt.getTime() < a.endsAt.getTime()) {
        // The overlap ends at whichever booking finishes FIRST. Using
        // `a.endsAt` alone assumes `b` outlasts `a`, which is false whenever
        // `b` is fully contained in `a` — e.g. a 12:00–23:00 festival and a
        // 19:00–20:00 side-space set overlap by 1h, not 4h. That number is
        // rendered to venue operators (chip tooltip, agenda caption, the
        // conflict icon's aria-label), so it has to be the real one.
        const overlapMs =
          Math.min(a.endsAt.getTime(), b.endsAt.getTime()) -
          b.startsAt.getTime();
        conflicts.push({
          eventAId: a.id,
          eventBId: b.id,
          overlapMinutes: Math.ceil(overlapMs / 60_000),
        });
      } else {
        // sorted by startsAt — no further overlaps possible for event i
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const toCalendarEvent = (
  // An EventRecord, or one already run through `expandEventDates` (its
  // `startsAt`/`endsAt` are then the occurrence's, and `occurrence` is set),
  // annotated by the producer with `venueConfirmed` (`isVenueConfirmed` on
  // the admin legs; `true` on the public legs, which the repo pre-filters).
  record: EventRecord & {
    occurrence?: CalendarOccurrence;
    venueConfirmed: boolean;
    venueOwned: boolean;
  },
  seriesInfo?: { seriesId: string; seriesName: string } | null,
  // PUBLIC path passes the moderation-gate set (hides pending/flagged heroes).
  // ADMIN (owner) path omits it — the owner still sees their pending hero.
  visibleHeroKeys?: ReadonlySet<string>,
) =>
  calendarEventSchema.parse({
    eventId: record.id,
    slug: record.slug ?? null,
    title: record.title,
    startsAt: record.startsAt,
    endsAt: record.endsAt ?? null,
    timezone: record.timezone,
    occurrence: record.occurrence ?? null,
    status: record.status,
    primaryImageUrl: visibleHeroKeys
      ? gateHeroUrl(record, visibleHeroKeys)
      : (record.heroImageUrl ?? null),
    // Price range requires a ticket-type aggregation join not available on
    // EventRecord. Will be populated when batch aggregation ships.
    priceRange: null,
    // Sold-out status requires ticket-type capacity vs. sold counts. Also
    // deferred until batch aggregation ships.
    soldOut: null,
    city: record.locality ?? null,
    region: record.region ?? record.regionCode ?? null,
    seriesId: seriesInfo?.seriesId ?? null,
    seriesName: seriesInfo?.seriesName ?? null,
    calendarId: record.calendarId ?? null,
    venueConfirmed: record.venueConfirmed,
    venueOwned: record.venueOwned,
  });

/**
 * FR-003 for both legs: one occurrence per SCHEDULED EventDate of each
 * multi-date listing, trimmed to the window (the repo admitted the EVENT for
 * any in-window night; its other nights are cut here), chronological. Events
 * without rows pass through unchanged. One batched EventDate read per page.
 */
async function expandCalendarEvents(
  repos: Pick<Repos, "eventDates">,
  events: readonly EventRecord[],
  window: { from: Date; to: Date },
) {
  const dates =
    events.length > 0
      ? await repos.eventDates.listByEventIds({
          eventIds: events.map((e) => e.id),
          statuses: ["SCHEDULED"],
        })
      : [];
  return expandEventDates(events, dates, { window, sort: "startsAt" });
}

async function resolvePlace(
  repos: Pick<Repos, "places">,
  placeId: string,
): Promise<PlaceRecord> {
  const place = await repos.places.getById(placeId);

  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  return place;
}

/**
 * The public-read gate for a place: it exists, is VERIFIED and is ACTIVE.
 * Every miss is a NOT_FOUND-category error (`PLACE_NOT_FOUND`,
 * `PLACE_NOT_VERIFIED`, `PLACE_NOT_ACTIVE`). Shared by the public calendar
 * leg and the place iCal feed, so the two cannot drift.
 */
export async function resolvePublicPlace(
  repos: Pick<Repos, "places">,
  placeId: string,
): Promise<PlaceRecord> {
  const place = await resolvePlace(repos, placeId);
  if (place.verificationStatus !== "VERIFIED") {
    throw fail("PLACE_NOT_VERIFIED", { category: "NOT_FOUND" });
  }
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE", { category: "NOT_FOUND" });
  }
  return place;
}

/**
 * The visibility predicates every public read of a place's events applies on
 * top of `listPublishedByPlace`'s PUBLIC filter. Confirmed-only
 * (docs/specs/2026-08-27): the venue's own events and the third-party ones it
 * vouched for, never an unconfirmed claim on its room; a banned owner's
 * events are withheld (ban-that-sticks).
 */
export function publicPlaceEventFilters(place: PlaceRecord) {
  return {
    excludeBannedOwners: true as const,
    venueConfirmedFor: venueConfirmedFilterFor(place),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function getVenueCalendar(
  deps: GetVenueCalendarDeps,
  rawInput: unknown,
): Promise<GetVenueCalendarOutput> {
  const input = parseInput(getVenueCalendarInputSchema, rawInput);

  if (input.mode === "admin") {
    return handleAdmin(deps, input);
  }

  return handlePublic(deps, input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin path — authed, ownership check, all statuses, conflict detection
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdmin(
  deps: GetVenueCalendarDeps,
  input: z.infer<typeof adminInputSchema>,
): Promise<GetVenueCalendarAdminOutput> {
  const place = await resolvePlace(deps.repos, input.placeId);

  // ── Ownership check (mirrors getPlaceForEdit) ──────────────────────────
  const isDirectHumanOwner = place.humanIdsWithAccess.includes(
    input.actorHumanId,
  );

  let isOrgOwner = false;
  if (!isDirectHumanOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectHumanOwner && !isOrgOwner) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  // ── Fetch events ────────────────────────────────────────────────────────
  // `includeDateOccurrences`: a multi-date listing with a night in the window
  // is admitted even when its pinned `Event.startsAt` is not (FR-003).
  const events = await deps.repos.events.listAllByPlace({
    placeId: input.placeId,
    from: input.from,
    to: input.to,
    statuses: input.statuses,
    includeDateOccurrences: true,
  });

  // ── Series enrichment ─────────────────────────────────────────────────
  const seriesInfos =
    await deps.repos.seriesOccurrences.getCalendarInfoForEventIds(
      events.map((e) => e.id),
    );
  const seriesMap = new Map(seriesInfos.map((s) => [s.eventId, s]));

  // ── Venue confirmation (docs/specs/2026-08-27) ────────────────────────
  // Every event is RETURNED (flagged) so the venue sees who is claiming its
  // room; only confirmed ones — venue-owned, or stamped and not withdrawn —
  // COUNT: an unconfirmed third-party event blocks nothing, so it is dropped
  // before conflict detection. Derived here via THE one rule, never stored.
  const confirmedById = new Map(
    events.map((e) => [e.id, isVenueConfirmed(e, place)] as const),
  );

  // ── Conflict detection ────────────────────────────────────────────────
  // Holds are NOT in this set — `detectConflicts` sees events only (FR-014).
  // Computed over the PARENT event spans, as before: a conflict pair is keyed
  // by event id, which cannot name one night of a multi-date listing. Per-
  // occurrence conflicts need an occurrence-keyed pair shape — out of scope
  // for this phase (data only).
  const conflicts = detectConflicts(
    events.filter((e) => confirmedById.get(e.id) === true),
  );

  // ── EventDate expansion (FR-003) ────────────────────────────────────────
  const occurrences = await expandCalendarEvents(deps.repos, events, {
    from: input.from,
    to: input.to,
  });

  // ── Hold overlay (booking-holds FR-014) ─────────────────────────────────
  const holds = await resolveBookingHoldOverlay(deps, {
    scope: { kind: "place", placeId: place.id },
    place,
    from: input.from,
    to: input.to,
  });

  deps.logger?.info("events.get_venue_calendar", {
    mode: "admin",
    placeId: input.placeId,
    actorHumanId: input.actorHumanId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    eventCount: events.length,
    occurrenceCount: occurrences.length,
    conflictCount: conflicts.length,
    holdCount: holds.length,
  });

  return getVenueCalendarAdminOutputSchema.parse({
    events: occurrences.map((e) =>
      toCalendarEvent(
        {
          ...e,
          venueConfirmed: confirmedById.get(e.id) === true,
          venueOwned: isVenueOwnedEvent(e, place),
        },
        seriesMap.get(e.id),
      ),
    ),
    conflicts,
    pageInfo: null,
    venueTimezone: resolveTimeZone(place.timezone),
    holds,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public path — unauthenticated, verified+active gating, published only
// ─────────────────────────────────────────────────────────────────────────────

async function handlePublic(
  deps: GetVenueCalendarDeps,
  input: z.infer<typeof publicInputSchema>,
): Promise<GetVenueCalendarPublicOutput> {
  // ── Public visibility gating ────────────────────────────────────────────
  const place = await resolvePublicPlace(deps.repos, input.placeId);

  // ── Time window defaults ────────────────────────────────────────────────
  const now = new Date();
  const from = input.from ?? now;
  const to = input.to ?? new Date(now.getTime() + MAX_WINDOW_MS);

  // ── Fetch published events ──────────────────────────────────────────────
  // `includeDateOccurrences` (FR-003): see the admin leg. Pagination stays
  // EVENT-shaped — `pageInfo.total` counts events, and a page can carry more
  // occurrences than `limit` when a listing on it has several nights inside.
  // ORDERING CAVEAT (known, this phase): the repo still sorts and pages on
  // `Event.startsAt`, so a listing admitted for a night deep in the window
  // sits at its (possibly stale, pre-`from`) pinned position and can occupy
  // page 1 ahead of genuinely upcoming events. `pageInfo.hasMore` is thus
  // "more EVENTS exist", not "more chips exist" — a page may be short of
  // chips while hasMore is false, or full of one listing's nights while
  // hasMore is true. Chip-shaped paging needs the repo to order on the
  // admitting night (see the adapter comment on listPublishedByPlace).
  // Confirmed-only (docs/specs/2026-08-27): the public venue calendar shows
  // the venue's own events and the third-party ones it vouched for — never an
  // unconfirmed claim on its room. The SQL predicate is `isVenueConfirmed`.
  const page = await deps.repos.events.listPublishedByPlace({
    placeId: place.id,
    from,
    to,
    status: "upcoming",
    limit: input.limit,
    offset: input.offset,
    includeDateOccurrences: true,
    ...publicPlaceEventFilters(place),
  });

  // ── Series enrichment ─────────────────────────────────────────────────
  const seriesInfos =
    await deps.repos.seriesOccurrences.getCalendarInfoForEventIds(
      page.items.map((e) => e.id),
    );
  const seriesMap = new Map(seriesInfos.map((s) => [s.eventId, s]));

  // ── EventDate expansion (FR-003) ────────────────────────────────────────
  const occurrences = await expandCalendarEvents(deps.repos, page.items, {
    from,
    to,
  });

  deps.logger?.info("events.get_venue_calendar", {
    mode: "public",
    placeId: place.id,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: input.limit,
    offset: input.offset,
    resultCount: page.items.length,
    total: page.pageInfo.total,
  });

  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, page.items);

  return getVenueCalendarOutputSchema.parse({
    // Repo-filtered to confirmed events, so the flag is true by construction;
    // `venueOwned` is still derived (a stamped third-party event is not).
    events: occurrences.map((e) =>
      toCalendarEvent(
        { ...e, venueConfirmed: true, venueOwned: isVenueOwnedEvent(e, place) },
        seriesMap.get(e.id),
        visibleHeroKeys,
      ),
    ),
    conflicts: [],
    venueTimezone: resolveTimeZone(place.timezone),
    pageInfo: {
      total: page.pageInfo.total,
      limit: page.pageInfo.limit,
      offset: page.pageInfo.offset,
      hasMore: page.pageInfo.offset + page.pageInfo.count < page.pageInfo.total,
    },
  });
}

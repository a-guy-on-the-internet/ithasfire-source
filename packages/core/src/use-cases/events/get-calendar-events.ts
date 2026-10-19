import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { CalendarAvailabilityRow } from "@th/ports/repos/calendars";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  isVenueConfirmed,
  isVenueOwnedEvent,
  venueConfirmedFilterFor,
} from "../../lib/venue-confirmation";
import { ensurePlaceOwnerAccess } from "../places/_shared/ensure-place-owner-access";
import { resolveVisibleHeroKeys } from "../moderation/gate-image-visibility";
import {
  calendarEventSchema,
  conflictSchema,
  detectConflicts,
  toCalendarEvent,
} from "./get-venue-calendar";
import {
  calendarHoldOverlaySchema,
  resolveBookingHoldOverlay,
} from "./_shared/booking-hold-overlay";

// ─────────────────────────────────────────────────────────────────────────────
// getCalendarEvents — events of ONE named Calendar (venue-hierarchy FR-005 /
// FR-010; docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
//
// THE SPACE-BLEED GUARD (FR-005, spec's #2 risk): both variants read via
// `EventsRepo.listByCalendar`, which filters on `Event.calendarId` DIRECTLY —
// NEVER via the CalendarSpace join. Two calendars sharing one space must each
// see ONLY their own events here, while `get-venue-calendar`'s space-keyed
// conflict detection still sees both (pinned by the space-bleed regression
// test).
//
// PUBLIC variant (embeds + public place page, NFR-002): PUBLISHED + PUBLIC
// events only, place must be VERIFIED + ACTIVE, hero images run the
// moderation gate. The public output shape structurally LACKS conflicts and
// availability keys — internals must never leak onto an unauthenticated
// surface (pinned by tests).
//
// ADMIN variant (owner calendar surface): ensure-place-owner-access, all
// non-ARCHIVED statuses, overlays
//   - availability rows: calendar-scoped PLUS place-wide (`calendarId` null
//     applies to every calendar — FR-007), via `listAvailabilityForPlace`;
//   - per-space conflict flags: space-keyed pairs computed over ALL of the
//     place's events in the window (a conflict with another calendar's event
//     on a shared space must still be flagged), then narrowed to pairs that
//     involve at least one of THIS calendar's events.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum / default look-ahead window: 90 days in milliseconds. Exported so
 * the calendar-embed read (`get-embed-calendar-events`) derives its own
 * expansion window from THE clamp instead of a hand-copied number.
 */
export const CALENDAR_EVENTS_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = CALENDAR_EVENTS_MAX_WINDOW_MS;

/**
 * Public limit bounds. MAX mirrors the adapter's SQL clamp on
 * `listByCalendar.limit` (≤100, same ceiling as `listPublishedByPlace`) so
 * the schema can never promise more rows than the query will take.
 */
const PUBLIC_DEFAULT_LIMIT = 100;
const PUBLIC_MAX_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas (discriminated union on `mode`)
// ─────────────────────────────────────────────────────────────────────────────

const publicInputSchema = z
  .object({
    mode: z.literal("public"),
    calendarId: z.string().uuid(),
    from: z.date().optional(),
    to: z.date().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PUBLIC_MAX_LIMIT)
      .default(PUBLIC_DEFAULT_LIMIT),
    /**
     * Event-calendar-redesign FR-003: ALSO admit an event when one of its
     * SCHEDULED `EventDate` rows lands in the window, not only when its
     * pinned `Event.startsAt` does — a recurring listing pinned before
     * `from` otherwise never surfaces although it has nights inside.
     *
     * OPT-IN and off by default because THIS read does not expand: it
     * returns one row per event at the pinned instant. A caller that sets
     * it MUST run `expandEventDates` with the same window afterwards (the
     * calendar-subject embed does); a caller that does not (the public
     * place page, `getEmbedForWidget`) would otherwise paint an admitted
     * stale-pinned listing on a night outside the window. Existing callers'
     * repo WHERE stays byte-identical.
     */
    includeDateOccurrences: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from.getTime() >= value.to.getTime()) {
      ctx.addIssue({ code: "custom", message: "invalid_time_window" });
    }
    // Same 90-day ceiling as the admin branch (an unauthenticated caller must
    // not be able to demand an unbounded scan). When `from` is omitted it
    // defaults to "now" at runtime, so the to-only case is CLAMPED
    // server-side in handlePublic instead of rejected here.
    if (
      value.from &&
      value.to &&
      value.to.getTime() - value.from.getTime() > MAX_WINDOW_MS
    ) {
      ctx.addIssue({ code: "custom", message: "time_window_too_large" });
    }
  });

const adminInputSchema = z
  .object({
    mode: z.literal("admin"),
    calendarId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    from: z.date(),
    to: z.date(),
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

export const getCalendarEventsInputSchema = z.discriminatedUnion("mode", [
  publicInputSchema,
  adminInputSchema,
]);

export type GetCalendarEventsInput = z.infer<typeof getCalendarEventsInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Output schemas
// ─────────────────────────────────────────────────────────────────────────────

const calendarSummarySchema = z
  .object({
    calendarId: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
  })
  .strict();

/**
 * PUBLIC shape: deliberately has NO conflicts / availability / status-internal
 * keys AT ALL (`.strict()`), so a future refactor cannot quietly start
 * leaking admin overlay data onto the unauthenticated surface (NFR-002).
 */
export const getCalendarEventsPublicOutputSchema = z
  .object({
    calendar: calendarSummarySchema,
    events: z.array(calendarEventSchema),
  })
  .strict();

const availabilityOverlaySchema = z
  .object({
    id: z.string().uuid(),
    /** Null = PLACE-WIDE row ("All calendars"). */
    calendarId: z.string().uuid().nullable(),
    dayOfWeek: z.number().int().min(0).max(6).nullable(),
    date: z.date().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    isOpen: z.boolean(),
    note: z.string().nullable(),
  })
  .strict();

export const getCalendarEventsAdminOutputSchema = z
  .object({
    calendar: calendarSummarySchema,
    events: z.array(calendarEventSchema),
    /**
     * Space-keyed conflict pairs involving at least one of this calendar's
     * events. The OTHER member of a pair may belong to a different calendar
     * sharing the space — its id will not appear in `events`.
     */
    conflicts: z.array(conflictSchema),
    /** Calendar-scoped + place-wide availability rows (FR-007). */
    availability: z.array(availabilityOverlaySchema),
    /**
     * LIVE holds on this calendar in the window (booking-holds FR-014) —
     * tentative chips only; never in `conflicts`.
     */
    holds: z.array(calendarHoldOverlaySchema),
  })
  .strict();

export type GetCalendarEventsPublicOutput = z.infer<
  typeof getCalendarEventsPublicOutputSchema
>;
export type GetCalendarEventsAdminOutput = z.infer<
  typeof getCalendarEventsAdminOutputSchema
>;
export type GetCalendarEventsOutput =
  | GetCalendarEventsPublicOutput
  | GetCalendarEventsAdminOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetCalendarEventsDeps = {
  /**
   * Full bag (ensurePlaceOwnerAccess takes `Repos`); `calendars` narrowed to
   * required here so core never sees `undefined` (optional on the aggregate
   * until the Step-5 adapters land — same staging as manage-calendars).
   */
  repos: Repos & Required<Pick<Repos, "calendars">>;
  logger?: LoggerPort;
  /** Admin hold overlay only: a failed performer-name lookup degrades + reports. */
  reportError?: ReporterPort;
  /** Admin hold overlay only (lazy-expiry projection). Defaults to wall time. */
  clock?: { now(): Date };
};

/**
 * Deps surface of the PUBLIC path only — narrow enough for callers that hold
 * a `Pick` of `Repos` (the embed use cases) to compose without widening their
 * own deps to the full bag. `getCalendarEvents({ mode: "public" })` delegates
 * to the same handler, so there is exactly ONE implementation of the public
 * gates (place VERIFIED+ACTIVE, PUBLISHED+PUBLIC events, moderation-gated
 * heroes) no matter which entry point runs it.
 */
export type GetCalendarEventsPublicDeps = {
  repos: Pick<
    Repos,
    "calendars" | "places" | "events" | "imageModerationRecords"
  >;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function getCalendarEvents(
  deps: GetCalendarEventsDeps,
  rawInput: unknown,
): Promise<GetCalendarEventsOutput> {
  const input = parseInput(getCalendarEventsInputSchema, rawInput);

  if (input.mode === "admin") {
    return handleAdmin(deps, input);
  }
  return handlePublic(deps, input);
}

/**
 * PUBLIC-only entry point (venue-hierarchy FR-010): the calendar-subject
 * embed resolvers call THIS instead of duplicating the public gates. Accepts
 * the same raw input as the `mode: "public"` branch of
 * {@link getCalendarEvents} (the `mode` literal included) and re-parses it —
 * callers stay raw-in, typed-out like every use-case entry point.
 */
export async function getCalendarEventsPublic(
  deps: GetCalendarEventsPublicDeps,
  rawInput: unknown,
): Promise<GetCalendarEventsPublicOutput> {
  const input = parseInput(publicInputSchema, rawInput);
  return handlePublic(deps, input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public path — unauthenticated; PUBLISHED + PUBLIC only, gated place
// ─────────────────────────────────────────────────────────────────────────────

async function handlePublic(
  deps: GetCalendarEventsPublicDeps,
  input: z.infer<typeof publicInputSchema>,
): Promise<GetCalendarEventsPublicOutput> {
  const calendar = await deps.repos.calendars.findById(input.calendarId);
  if (!calendar) {
    throw fail("CALENDAR_NOT_FOUND", { category: "NOT_FOUND" });
  }

  // Public gating: an unverified/suspended place's calendars read as MISSING —
  // and the CODE collapses to CALENDAR_NOT_FOUND, not just the 404 category
  // (Step-6 review). Distinct PLACE_NOT_VERIFIED / PLACE_NOT_ACTIVE appCodes
  // reach unauthenticated clients and would be an existence-and-state oracle
  // for places that never went public. Owner-gated surfaces keep the distinct
  // codes (they sit behind authz, so there is nothing to leak).
  const place = await deps.repos.places.getById(calendar.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  if (place.verificationStatus !== "VERIFIED" || place.status !== "ACTIVE") {
    throw fail("CALENDAR_NOT_FOUND", { category: "NOT_FOUND" });
  }

  const now = new Date();
  const from = input.from ?? now;
  // 90-day ceiling: schema rejects an oversized explicit window; a to-only
  // input (from defaulted to "now") is clamped here instead.
  const windowCap = new Date(from.getTime() + MAX_WINDOW_MS);
  const to =
    input.to && input.to.getTime() <= windowCap.getTime()
      ? input.to
      : windowCap;

  // Event.calendarId filter — NEVER the space join (module header). `limit`
  // rides into SQL as `take` (adapter clamps ≤100 — the schema max).
  // Confirmed-only (docs/specs/2026-08-27): the public calendar never shows
  // an unconfirmed third-party claim on the room.
  const records = await deps.repos.events.listByCalendar({
    calendarId: calendar.id,
    from,
    to,
    publishedOnly: true,
    limit: input.limit,
    venueConfirmedFor: venueConfirmedFilterFor(place),
    // Spread conditionally so callers that never opt in hand the repo the
    // exact argument they always did (see the input doc for why it is opt-in).
    ...(input.includeDateOccurrences ? { includeDateOccurrences: true } : {}),
  });
  // Belt-and-braces: the repo already takes `limit` rows.
  const items = records.slice(0, input.limit);

  const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, items);

  deps.logger?.info("events.get_calendar_events", {
    mode: "public",
    calendarId: calendar.id,
    placeId: calendar.placeId,
    from: from.toISOString(),
    to: to.toISOString(),
    resultCount: items.length,
  });

  return getCalendarEventsPublicOutputSchema.parse({
    calendar: {
      calendarId: calendar.id,
      name: calendar.name,
      slug: calendar.slug,
    },
    // Repo-filtered to confirmed events, so the flag is true by construction.
    events: items.map((e) =>
      toCalendarEvent(
        { ...e, venueConfirmed: true, venueOwned: isVenueOwnedEvent(e, place) },
        null,
        visibleHeroKeys,
      ),
    ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin path — owner-gated; availability + per-space conflict overlays
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdmin(
  deps: GetCalendarEventsDeps,
  input: z.infer<typeof adminInputSchema>,
): Promise<GetCalendarEventsAdminOutput> {
  const calendar = await deps.repos.calendars.findById(input.calendarId);
  if (!calendar) {
    throw fail("CALENDAR_NOT_FOUND");
  }

  // Owner gate on the calendar's OWN place (the calendarId is the only
  // client-supplied anchor — access derives from the row, never the client).
  await ensurePlaceOwnerAccess(deps.repos, calendar.placeId, input.actorHumanId);

  const events = await deps.repos.events.listByCalendar({
    calendarId: calendar.id,
    from: input.from,
    to: input.to,
    publishedOnly: false,
  });

  // The place row: owner ids for the venue-confirmation derivation below,
  // and the zone for the hold overlay. The owner gate above already
  // established access (and that the place exists).
  const place = await deps.repos.places.getById(calendar.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Venue confirmation (docs/specs/2026-08-27): every event on the calendar
  // is RETURNED flagged, so the venue sees who is claiming its room; only
  // confirmed ones — venue-owned, or stamped and not withdrawn — COUNT for
  // conflicts. Derived via THE one rule (`lib/venue-confirmation`).
  const venueConfirmedOf = (e: EventRecord) => isVenueConfirmed(e, place);

  // Conflicts are space-keyed across the WHOLE place: an event on this
  // calendar can conflict with another calendar's event on a shared space, so
  // the pair set is computed over all place events in the window — the
  // CONFIRMED ones; an unconfirmed claim blocks nothing — then narrowed to
  // pairs touching this calendar's events.
  const placeEvents = await deps.repos.events.listAllByPlace({
    placeId: calendar.placeId,
    from: input.from,
    to: input.to,
  });
  const ownEventIds = new Set(events.map((e: EventRecord) => e.id));
  const conflicts = detectConflicts(placeEvents.filter(venueConfirmedOf)).filter(
    (c) => ownEventIds.has(c.eventAId) || ownEventIds.has(c.eventBId),
  );

  // Availability overlay: this calendar's rows + place-wide rows (FR-007).
  const availabilityRows = await deps.repos.calendars.listAvailabilityForPlace(
    calendar.placeId,
  );
  const availability = availabilityRows.filter(
    (row: CalendarAvailabilityRow) =>
      row.calendarId === null || row.calendarId === calendar.id,
  );

  // Hold overlay (booking-holds FR-014) — this calendar's live holds.
  const holds = await resolveBookingHoldOverlay(deps, {
    scope: { kind: "calendar", calendarId: calendar.id },
    place,
    from: input.from,
    to: input.to,
  });

  deps.logger?.info("events.get_calendar_events", {
    mode: "admin",
    calendarId: calendar.id,
    placeId: calendar.placeId,
    actorHumanId: input.actorHumanId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    eventCount: events.length,
    conflictCount: conflicts.length,
    availabilityCount: availability.length,
    holdCount: holds.length,
  });

  return getCalendarEventsAdminOutputSchema.parse({
    calendar: {
      calendarId: calendar.id,
      name: calendar.name,
      slug: calendar.slug,
    },
    // Owner view: no moderation gate (the owner still sees a pending hero).
    events: events.map((e) =>
      toCalendarEvent({
        ...e,
        venueConfirmed: venueConfirmedOf(e),
        venueOwned: isVenueOwnedEvent(e, place),
      }),
    ),
    conflicts,
    availability: availability.map((row) => ({
      id: row.id,
      calendarId: row.calendarId,
      dayOfWeek: row.dayOfWeek,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      isOpen: row.isOpen,
      note: row.note,
    })),
    holds,
  });
}

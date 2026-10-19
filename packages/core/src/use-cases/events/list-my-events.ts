import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EventOwnerType,
  EventRecord,
  EventStatus,
} from "@th/ports/repos/events";
import type { OffsetPageInfo } from "@th/ports/pagination";

import { parseInput } from "../../lib/io";
import {
  projectPublicEventLocation,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import {
  requireOwnerAccess,
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
} from "../../lib/rbac";
import {
  calendarOccurrenceSchema,
  expandEventDates,
} from "./expand-event-dates";
import { isEditDelegateOfHumanOwner } from "../../lib/event-edit-rights";

const eventStatusSchema = z.enum([
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "CANCELLED",
  "COMPLETED",
]);

/**
 * Unrefined shape — the transport `.omit()`s `actorHumanId` from THIS (Zod 4
 * refuses `.omit()` on a refined object). The expandDates/dateRange rule
 * below still runs inside the use case's `parseInput`.
 */
export const listMyEventsInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
    status: z.array(eventStatusSchema).optional(),
    /**
     * Case-insensitive text filter over every string the owner-facing listing
     * SHOWS — title, addressText, AND the linked place's name (a place-linked
     * event legitimately has a null addressText, so matching only the first
     * two missed venues the user could see on screen). Applied by the repo
     * BEFORE pagination so `pageInfo.total` counts the filtered set.
     * Mirrors the places listing contract (trim + min 2 + max 140) — the
     * lower bound keeps a single keystroke from being a guaranteed
     * BAD_REQUEST while the caller is still typing.
     */
    query: z.string().trim().min(2).max(140).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    /**
     * Event-calendar-redesign FR-003: project one item per SCHEDULED
     * `EventDate` of a multi-date community listing (each with
     * `occurrence: { index, total, eventDateId }`) instead of one item at the
     * pinned `Event.startsAt`. OPT-IN, default off: this procedure also backs
     * the events table, the sell/scan pickers and the announcement composer,
     * none of which want a listing repeated per night. The dashboard
     * calendar passes `true`. Pagination stays EVENT-shaped either way —
     * `pageInfo.total` counts events, and a page's item count can exceed
     * `limit` when expanded.
     */
    expandDates: z.boolean().optional(),
    /**
     * Optional inclusive window. Applied TWICE, on purpose:
     *   · to the repo read, as a filter on `Event.startsAt` (the pinned
     *     instant) — this is what bounds the EVENT set and `pageInfo.total`;
     *   · to the FR-003 expansion, as the overlap window on each listing's
     *     SCHEDULED `EventDate` rows — without it every scheduled night of
     *     every admitted listing is emitted, and a two-year-old weekly
     *     listing contributes 150+ items to one page.
     * `occurrence.index` / `occurrence.total` stay ABSOLUTE over the
     * listing's scheduled rows ("Date 3 of 160" still means the third of
     * 160), only the emitted rows are trimmed. Without `expandDates` either
     * bound may be omitted.
     *
     * With `expandDates` the repo arm is widened via `includeDateOccurrences`:
     * a listing whose pin sits before `from` is still admitted when it has a
     * SCHEDULED night inside the range (the same opt-in the place/calendar
     * reads use). Without `expandDates` the repo matches on the pinned instant
     * only — a table row per event has no night to land on, so widening
     * would surface rows that appear to sit outside the range.
     *
     * REQUIRED, with BOTH bounds, when `expandDates` is true (see the
     * refinement): the expansion has no row cap of its own, so an unbounded
     * expanding read is 100 events x every scheduled night each.
     */
    dateRange: z
      .object({ from: z.date().optional(), to: z.date().optional() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The ONE expandDates ⇒ bounded-dateRange rule, shared with the transport:
 * `events.listMine` `.omit()`s `actorHumanId` from the base shape (which
 * drops this refinement) and re-attaches it via `.superRefine(assertExpandDatesBounded)`
 * so a client that forgets a bound is refused at the wire (BAD_REQUEST) and
 * not only inside the use case. Typed structurally so both packages' zod
 * builds accept it.
 */
export function assertExpandDatesBounded(
  value: {
    expandDates?: boolean;
    dateRange?: { from?: Date; to?: Date };
  },
  ctx: {
    addIssue: (issue: {
      code: "custom";
      path: (string | number)[];
      message: string;
    }) => void;
  },
): void {
  if (
    value.expandDates === true &&
    (!value.dateRange?.from || !value.dateRange.to)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["dateRange"],
      message: "expand_dates_requires_bounded_date_range",
    });
  }
}

export const listMyEventsInputSchema = listMyEventsInputSchemaBase.superRefine(
  assertExpandDatesBounded,
);

export const listMyEventsOutputSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        title: z.string().nullable(),
        status: eventStatusSchema,
        startsAt: z.date().nullable(),
        endsAt: z.date().nullable(),
        slug: z.string().nullable(),
        shortId: z.string().nullable(),
        visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]),
        /**
         * `addressText` / `lat` / `lng` are the stored row ONLY for a viewer
         * who may edit the event (the human owner; OWNER/ADMIN/EDITOR). Below
         * that bar (SCANNER / VIEWER / FINANCE) they are the PUBLIC projection
         * (`projectPublicEventLocation`): a withheld location shows its area
         * label and circle centre (or nothing), never the street or the pin.
         */
        addressText: z.string().nullable(),
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        /** When set, the event is at a registered Place (cross-link target). */
        placeId: z.string().uuid().nullable(),
        placeName: z.string().nullable(),
        ticketsSold: z.number().int().default(0),
        /**
         * Summed capacity across the event's ticket types, from the SAME
         * `getPopularityStats` read that produces `ticketsSold` (FR-002).
         * Null when the stats read has no row for the event (no ticket
         * types yet) — "unknown", not "zero".
         */
        totalCapacity: z.number().int().nullable(),
        /** `Event.timezone` — IANA zone the event's wall-clock times live in (FR-001). */
        timezone: z.string(),
        /** "Date N of M" when `expandDates` split a multi-date listing (FR-003); else null. */
        occurrence: calendarOccurrenceSchema,
        /**
         * The series this event is an occurrence of, via its occurrence link
         * (`seriesOccurrences.getCalendarInfoForEventIds`, ONE batched read
         * per page — event-calendar-redesign phase 2 groups/filters on it).
         * Both null for a standalone event. Expanded EventDate rows inherit
         * their parent's (a multi-date listing is one event).
         */
        seriesId: z.string().uuid().nullable(),
        seriesName: z.string().nullable(),
        createdAt: z.date(),
        updatedAt: z.date().nullable(),
      }),
    ),
    pageInfo: z.object({
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
      hasNextPage: z.boolean(),
      hasPreviousPage: z.boolean(),
    }),
  })
  .strict();

export type ListMyEventsInput = z.infer<typeof listMyEventsInputSchema>;
export type ListMyEventsOutput = z.infer<typeof listMyEventsOutputSchema>;

export type ListMyEventsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listMyEvents(
  deps: ListMyEventsDeps,
  rawInput: unknown,
): Promise<ListMyEventsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listMyEvents" });

  const execute = async (): Promise<ListMyEventsOutput> => {
    const input = parseInput(listMyEventsInputSchema, rawInput);
    scopedLogger?.info("list_my_events.parsed_input", { input });

    // Authorization: actor must have permission to view these events. An
    // edit-role delegate of a HUMAN owner lists the principal's events too
    // (owner ruling 2026-09-28) — they can already edit every one of them.
    const access = (await isEditDelegateOfHumanOwner(
      deps.repos.authz,
      input,
      input.actorHumanId,
    ))
      ? ({ ownerType: "HUMAN" } as const)
      : await requireOwnerAccess({
          repos: deps.repos,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          actorHumanId: input.actorHumanId,
          roles: ORG_ANY_ROLE,
          errorCode: "INSUFFICIENT_ROLE",
        });
    // ANY org role may LIST the events; only the edit roles may see where a
    // withheld one really is. For a freeform OBSCURED event (incl. a NEVER
    // reveal) the stored row IS the house, and a door SCANNER, a VIEWER or a
    // FINANCE member has no more claim to it than a stranger does. A HUMAN
    // owner is the actor themself or an edit-role delegate of theirs.
    const viewerSeesStoredLocation =
      access.ownerType === "HUMAN" ||
      ORG_EDIT_ROLES.includes(access.membership.role);

    const result = await deps.repos.events.listByOwner({
      ownerType: input.ownerType as EventOwnerType,
      ownerId: input.ownerId,
      status: input.status as EventStatus[] | undefined,
      query: input.query,
      limit: input.limit,
      offset: input.offset,
      dateRange: input.dateRange,
      // FR-003: only the expanding caller wants the repo to admit listings on
      // a scheduled night rather than the pin. Spread conditionally so the
      // non-expanding callers' repo argument stays key-identical.
      ...(input.expandDates === true ? { includeDateOccurrences: true } : {}),
    });

    // Batch-fetch ticket sold counts + capacity for all events in the page —
    // ONE stats read serves both `ticketsSold` and `totalCapacity` (FR-002).
    const eventIds = result.items.map((e) => e.id);
    const stats =
      eventIds.length > 0
        ? await deps.repos.events.getPopularityStats(eventIds)
        : [];
    const statsMap = new Map(stats.map((s) => [s.eventId, s]));

    // Series enrichment: ONE batched occurrence-link read for the page (same
    // read the venue calendar uses). Keyed by event id, so an expanded
    // listing's nights all resolve to the parent's series below.
    const seriesInfos =
      eventIds.length > 0
        ? await deps.repos.seriesOccurrences.getCalendarInfoForEventIds(
            eventIds,
          )
        : [];
    const seriesMap = new Map(seriesInfos.map((s) => [s.eventId, s]));

    // FR-003: one item per SCHEDULED EventDate when the caller opted in.
    // One batched read for the whole page; single-date and series events
    // have no rows and pass through unchanged (`occurrence: null`). The
    // caller's `dateRange` is the projector's window — the repo bounded the
    // EVENTS on their pinned instant, the projector bounds each listing's
    // NIGHTS (index/total stay absolute; see the input doc).
    const rows = input.expandDates
      ? expandEventDates(
          result.items,
          eventIds.length > 0
            ? await deps.repos.eventDates.listByEventIds({
                eventIds,
                statuses: ["SCHEDULED"],
              })
            : [],
          { window: input.dateRange },
        )
      : result.items.map((event) => ({ ...event, occurrence: null }));

    // Batch-fetch place names/slugs for events that have a placeId — avoids
    // an N+1 fetch when the address column wants to render "<Venue Name> ↗"
    // instead of the freeform addressText.
    const placeIds = Array.from(
      new Set(
        result.items
          .map((e) => e.placeId)
          .filter((p): p is string => Boolean(p)),
      ),
    );
    // The same read carries each venue's privacy row, which the public
    // projection needs below the edit bar: a place that is GONE projects as
    // fully hidden (`unreadablePlaceLocation`), never as "no venue" — that
    // would let the event row speak for a venue that may withhold its address.
    const placeMap = new Map<string, { name: string }>();
    const placeLocationMap = new Map<string, PlaceLocationSource>();
    if (placeIds.length > 0) {
      await Promise.all(
        placeIds.map(async (id) => {
          const place = await deps.repos.places.getById(id);
          if (place) placeMap.set(id, { name: place.name });
          placeLocationMap.set(
            id,
            place ? toPlaceLocationSource(place) : unreadablePlaceLocation(id),
          );
        }),
      );
    }

    const locationFor = (
      event: (typeof rows)[number],
    ): { addressText: string | null; lat: number | null; lng: number | null } => {
      if (viewerSeesStoredLocation) {
        return {
          addressText: event.addressText,
          lat: event.lat ?? null,
          lng: event.lng ?? null,
        };
      }
      const projected = projectPublicEventLocation(event, {
        place: event.placeId
          ? (placeLocationMap.get(event.placeId) ??
            unreadablePlaceLocation(event.placeId))
          : undefined,
      });
      return {
        // The street for EXACT; otherwise the area label a public card prints.
        addressText: projected.addressText ?? projected.areaLabel,
        lat: projected.lat,
        lng: projected.lng,
      };
    };

    const items = rows.map((event) => {
      const place = event.placeId ? placeMap.get(event.placeId) : null;
      const stat = statsMap.get(event.id);
      const series = seriesMap.get(event.id);
      const location = locationFor(event);
      return {
        id: event.id,
        title: event.title,
        status: event.status,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        slug: event.slug,
        shortId: event.shortId,
        visibility: event.visibility,
        addressText: location.addressText,
        lat: location.lat,
        lng: location.lng,
        placeId: event.placeId,
        placeName: place?.name ?? null,
        ticketsSold: stat?.ticketsSold ?? 0,
        totalCapacity: stat?.totalCapacity ?? null,
        timezone: event.timezone,
        occurrence: event.occurrence,
        seriesId: series?.seriesId ?? null,
        seriesName: series?.seriesName ?? null,
        createdAt: event.createdAt ?? new Date(),
        updatedAt: event.updatedAt ?? null,
      };
    });

    return listMyEventsOutputSchema.parse({
      items,
      pageInfo: {
        total: result.pageInfo.total,
        limit: result.pageInfo.limit,
        offset: result.pageInfo.offset,
        hasNextPage: result.pageInfo.hasNextPage,
        hasPreviousPage: result.pageInfo.offset > 0,
      },
    });
  };

  return execute();
}

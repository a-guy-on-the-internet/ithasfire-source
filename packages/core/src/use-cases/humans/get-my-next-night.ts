import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { EventStatus, OrderStatus } from "@th/types";

import { parseInput } from "../../lib/io";
import { ACTIVE_HOLDER_ORDER_STATUSES } from "../../lib/location/holder-eligibility";
import {
  projectPublicEventLocation,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import { isVenueConfirmed } from "../../lib/venue-confirmation";
import { publicVenueNameFor } from "../entity-pages/derive-human-upcoming-events";
import { MY_TICKETS_DEFAULT_ORDER_STATUSES } from "../orders/list-my-orders";

// ─────────────────────────────────────────────────────────────────────────────
// The signed-in person's NEXT NIGHT: the one soonest event they hold a ticket
// for, have RSVP'd to, or are on the lineup of. Feeds the small block at the
// top of the navbar account menu, so it runs on every signed-in page load:
// three bounded reads (one per source, NEXT_NIGHT_SOURCE_LIMIT rows each,
// soonest first, filters in SQL) plus one event read and at most one place
// read for the winner. Five queries, no fan-out.
//
// Each source reuses the ownership predicate of the page that lists it, so
// the block can never point at something that page would not show:
//   · tickets → /my-tickets: tickets the person OWNS (`ownerHumanId`; a
//     transfer moves the row, so transferred-away is gone and received
//     counts), ACTIVE (VALID | SCANNED | LISTED — not refunded/invalid), on an
//     order in the my-tickets default statuses that is ALSO a paid holder
//     order (ACTIVE_HOLDER_ORDER_STATUSES): SUCCEEDED or PART_REFUNDED.
//   · RSVPs → /my-rsvps: the person's RSVP rows. There is no RSVP status;
//     cancelling deletes the row, so every row is live.
//   · lineups → /my-lineups: the person's EventHuman rows. There is no
//     lineup status either: no pending invite, no "declined"; leaving or
//     being removed deletes the row.
//
// What counts as a night: the event is PUBLISHED (drafts, cancelled,
// completed and archived are out — a draft has no public page to link to)
// and has not ended (`endsAt > now`; `Event.endsAt` is required, so an
// in-progress show is still tonight's night — the rule /my-lineups and
// /my-rsvps already use).
//
// No source failure is swallowed: if one throws the query throws and the web
// hides the block (fail closed). There is nothing to report.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows read per source. Tiny on purpose: only the head of each is needed. */
export const NEXT_NIGHT_SOURCE_LIMIT = 5;

const NEXT_NIGHT_EVENT_STATUSES: readonly EventStatus[] = ["PUBLISHED"];

/**
 * Orders whose tickets count: the ones /my-tickets lists by default AND that
 * still make their buyer an active holder (paid, not fully refunded).
 */
export const NEXT_NIGHT_ORDER_STATUSES: readonly OrderStatus[] =
  MY_TICKETS_DEFAULT_ORDER_STATUSES.filter((status) =>
    ACTIVE_HOLDER_ORDER_STATUSES.has(status),
  );

export const getMyNextNightInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

const nextNightKindSchema = z.enum(["lineup", "ticket", "rsvp"]);

export const myNextNightSchema = z
  .object({
    /** Why it is the person's night. Precedence lineup > ticket > rsvp. */
    kind: nextNightKindSchema,
    eventId: z.uuid(),
    /** Public slug (the event is PUBLISHED); null falls back to eventId. */
    slug: z.string().nullable(),
    title: z.string(),
    startsAt: z.date(),
    /** IANA zone the event's times are shown in. */
    timezone: z.string(),
    /**
     * Venue name when the venue vouches for an ungated event, else the coarse
     * public area label. Never a street address. Omitted when nothing is
     * known.
     */
    placeLabel: z.string().optional(),
    /** The person's active tickets for the event; set only when > 0. */
    ticketCount: z.number().int().positive().optional(),
    /**
     * An order the person BOUGHT holding one of those tickets (the most
     * recent by `occurredAt`), so the block can open /my-tickets/<orderId>.
     * Unset when every ticket was transferred in on someone else's order —
     * `getMyOrder` opens only the buyer's own orders.
     */
    orderId: z.uuid().optional(),
  })
  .strict();

export const getMyNextNightOutputSchema = myNextNightSchema.nullable();

export type GetMyNextNightInput = z.infer<typeof getMyNextNightInputSchema>;
export type MyNextNight = z.infer<typeof myNextNightSchema>;
export type GetMyNextNightOutput = z.infer<typeof getMyNextNightOutputSchema>;
export type NextNightKind = z.infer<typeof nextNightKindSchema>;

export type GetMyNextNightDeps = {
  repos: Pick<
    Repos,
    "tickets" | "eventRsvps" | "eventHumans" | "events" | "places"
  >;
  clock: ClockPort;
};

const KIND_RANK: Record<NextNightKind, number> = {
  lineup: 0,
  ticket: 1,
  rsvp: 2,
};

type Candidate = {
  eventId: string;
  startsAt: Date;
  kind: NextNightKind;
  ticketCount?: number;
  orderId?: string;
};

/** (startsAt, eventId) ascending — the tie on start time breaks by id. */
function isSooner(a: Candidate, b: Candidate): boolean {
  const diff = a.startsAt.getTime() - b.startsAt.getTime();
  if (diff !== 0) return diff < 0;
  return a.eventId < b.eventId;
}

function coarseLabel(
  locality: string | null,
  region: string | null,
): string | null {
  const parts = [locality, region].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function getMyNextNight(
  deps: GetMyNextNightDeps,
  rawInput: unknown,
): Promise<GetMyNextNightOutput> {
  const input = parseInput(getMyNextNightInputSchema, rawInput);
  const now = deps.clock.now();
  const humanId = input.actorHumanId;

  const [held, rsvps, lineups] = await Promise.all([
    deps.repos.tickets.listUpcomingHeldEvents({
      humanId,
      now,
      eventStatuses: NEXT_NIGHT_EVENT_STATUSES,
      orderStatuses: NEXT_NIGHT_ORDER_STATUSES,
      limit: NEXT_NIGHT_SOURCE_LIMIT,
    }),
    deps.repos.eventRsvps.listUpcomingEventsForUser({
      humanId,
      now,
      eventStatuses: NEXT_NIGHT_EVENT_STATUSES,
      limit: NEXT_NIGHT_SOURCE_LIMIT,
    }),
    deps.repos.eventHumans.listLineupsByHuman({
      humanId,
      when: "upcoming",
      now,
      after: null,
      limit: NEXT_NIGHT_SOURCE_LIMIT,
      eventStatuses: NEXT_NIGHT_EVENT_STATUSES,
    }),
  ]);

  // One candidate per event; the strongest kind wins, tickets ride along.
  const byEvent = new Map<string, Candidate>();
  const offer = (next: Candidate) => {
    const current = byEvent.get(next.eventId);
    if (!current) {
      byEvent.set(next.eventId, next);
      return;
    }
    if (KIND_RANK[next.kind] < KIND_RANK[current.kind]) {
      current.kind = next.kind;
    }
    if (next.ticketCount !== undefined) current.ticketCount = next.ticketCount;
    if (next.orderId !== undefined) current.orderId = next.orderId;
  };

  for (const row of held) {
    if (row.ticketCount <= 0) continue;
    offer({
      eventId: row.eventId,
      startsAt: row.startsAt,
      kind: "ticket",
      ticketCount: row.ticketCount,
      ...(row.latestOwnOrderId ? { orderId: row.latestOwnOrderId } : {}),
    });
  }
  for (const row of rsvps) {
    offer({ eventId: row.eventId, startsAt: row.startsAt, kind: "rsvp" });
  }
  for (const row of lineups) {
    offer({ eventId: row.eventId, startsAt: row.startsAt, kind: "lineup" });
  }

  let winner: Candidate | null = null;
  for (const candidate of byEvent.values()) {
    if (!winner || isSooner(candidate, winner)) winner = candidate;
  }
  if (!winner) return null;

  const event = await deps.repos.events.getById(winner.eventId);
  // Deleted, unpublished or ended between the reads: show nothing rather
  // than a night the source pages would no longer list. (`endsAt` is a
  // required column; the record type allows null, so fall back to the start
  // the way /my-rsvps does.)
  if (
    !event ||
    !NEXT_NIGHT_EVENT_STATUSES.includes(event.status) ||
    (event.endsAt ?? event.startsAt).getTime() <= now.getTime()
  ) {
    return null;
  }

  // Place label = the PUBLIC projection, whoever the viewer is. The venue is
  // named only when it vouches for the event (`publicVenueNameFor`, the human
  // page's rule) AND the public location is EXACT and shown. A named venue is
  // a de-facto address (see `holderVenueLine`), so an obscured event, a venue
  // that withholds its address, and a gated event (projected label-only,
  // OBSCURED + hidden) all get the coarse area label instead: the author's
  // area label, else "locality, region". Never the street — the projection's
  // `addressText` / `label` are not read.
  const place = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;
  const location = projectPublicEventLocation(event, {
    place: event.placeId
      ? place
        ? toPlaceLocationSource(place)
        : unreadablePlaceLocation(event.placeId)
      : undefined,
  });
  const venueConfirmed = place ? isVenueConfirmed(event, place) : false;
  const placeLabel = publicVenueNameFor(
    {
      placeName:
        location.mode === "EXACT" && !location.hidden
          ? (place?.name ?? null)
          : null,
      locationLabel:
        location.areaLabel ?? coarseLabel(location.locality, location.region),
    },
    venueConfirmed,
  );

  return getMyNextNightOutputSchema.parse({
    kind: winner.kind,
    eventId: event.id,
    slug: event.slug ?? null,
    title: event.title,
    startsAt: event.startsAt,
    timezone: event.timezone,
    ...(placeLabel ? { placeLabel } : {}),
    ...(winner.ticketCount ? { ticketCount: winner.ticketCount } : {}),
    ...(winner.orderId ? { orderId: winner.orderId } : {}),
  });
}

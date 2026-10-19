import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  eventAttendanceModeSchema,
  eventRsvpRecordSchema,
  eventStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import { rsvpMayReceiveAddress } from "../../lib/location/holder-eligibility";
import { resolveHolderAddressesForEvents } from "../../lib/location/load-holder-addresses";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

/**
 * FR-004 (community-managed-event-listings spec): the events the signed-in
 * user said "I'm going" to — their OWN attendance intent only (distinct from
 * the separate saved/watchlist model). Hydrates a compact event summary via
 * the events bulk accessor (`findManyByIds`). Never exposes other attendees
 * or any count.
 */

export const listMyRsvpsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const rsvpEventSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    slug: z.string().nullable(),
    status: eventStatusSchema,
    attendanceMode: eventAttendanceModeSchema,
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    timezone: z.string(),
    /**
     * The street, ONLY once this attendee may see it (the same gate as a
     * ticket holder's: mode floored by the venue, reveal date, NEVER). Null
     * while locked, in which case `locality`/`region` still give the area.
     * For a venue that withholds its address it is the Place's street, not
     * the Event row (which only holds the venue's public projection).
     */
    addressText: z.string().nullable(),
    /** True while the street is withheld from this attendee. */
    addressLocked: z.boolean(),
    /** When a locked address is shared; null when unlocked, NEVER, or unset. */
    addressRevealAt: z.date().nullable(),
    /** True when the organizer chose never to share the address. */
    addressNeverShared: z.boolean(),
    /**
     * Why the street is withheld; null when it is not. `venueUnconfirmed` =
     * the venue withholds its address and has not confirmed this event (a
     * community listing at a private venue, for one), so no date is coming.
     * `placeUnavailable` = the venue could not be read just now.
     */
    addressLockReason: z
      .enum([
        "never",
        "placeUnavailable",
        "venueUnconfirmed",
        "notHolder",
        "notYetRevealed",
      ])
      .nullable(),
    locality: z.string().nullable(),
    region: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
  })
  .strict();

export const listMyRsvpsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          rsvp: eventRsvpRecordSchema,
          event: rsvpEventSummarySchema,
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListMyRsvpsInput = z.infer<typeof listMyRsvpsInputSchema>;
export type ListMyRsvpsOutput = z.infer<typeof listMyRsvpsOutputSchema>;

export type ListMyRsvpsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listMyRsvps(
  deps: ListMyRsvpsDeps,
  rawInput: unknown,
): Promise<ListMyRsvpsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listMyRsvps" });

  const execute = async (): Promise<ListMyRsvpsOutput> => {
    const input = parseInput(listMyRsvpsInputSchema, rawInput);

    const page = await deps.repos.eventRsvps.listForUser({
      humanId: input.actorHumanId,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });

    const eventIds = [...new Set(page.items.map((rsvp) => rsvp.eventId))];
    const events = await deps.repos.events.findManyByIds(eventIds);
    const eventsById = new Map(events.map((event) => [event.id, event]));

    // Moderation gate (FR-005): hide a pending/flagged hero even on the RSVPer's
    // own list (absent record = legacy = visible). One batched lookup.
    const visibleHeroKeys = await resolveVisibleHeroKeys(deps.repos, events);

    // Address gate: an RSVP is attendance, so the attendee gets exactly what
    // a ticket holder gets — nothing street-level before the reveal, nothing
    // ever for NEVER, and at a venue that withholds its address nothing
    // unless the venue vouched for the event. One place read per distinct
    // venue. Every row here is the actor's own RSVP (cancelling it deletes
    // the row), so the viewer holds each one unless the event's status is
    // off `RSVP_RELEASING_STATUSES`: cancelling or archiving keeps the rows,
    // and a CANCELLED or ARCHIVED event releases nothing to RSVP-ers
    // (`rsvpMayReceiveAddress`, the rule the event page uses too).
    // These are event-level RSVPs only (`eventRsvps`), so no night status.
    const holderAddresses = await resolveHolderAddressesForEvents({
      repos: deps.repos,
      events,
      activeHolder: (event) =>
        rsvpMayReceiveAddress({ eventStatus: event.status }),
      now: new Date(),
    });

    // A missing event can only be a delete race (RSVPs cascade-delete with
    // the event) — drop the row rather than failing the whole page.
    const items = page.items.flatMap((rsvp) => {
      const event = eventsById.get(rsvp.eventId);
      if (!event) return [];
      const holderAddress = holderAddresses.get(event.id);
      // Absent can only mean a resolution bug; fail closed.
      const locked = holderAddress?.locked ?? true;
      return [
        {
          rsvp,
          event: {
            id: event.id,
            title: event.title,
            slug: event.slug,
            status: event.status,
            attendanceMode: event.attendanceMode,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timezone: event.timezone,
            addressText:
              holderAddress && !holderAddress.locked
                ? holderAddress.addressText
                : null,
            addressLocked: locked,
            addressRevealAt: holderAddress?.locked
              ? holderAddress.revealAt
              : null,
            addressNeverShared: holderAddress?.locked
              ? holderAddress.never
              : false,
            // Absent can only mean a resolution bug; `locked` above already
            // fails closed, and this says why only when it knows.
            addressLockReason: holderAddress?.locked
              ? holderAddress.reason
              : holderAddress
                ? null
                : "notYetRevealed",
            locality: event.locality ?? null,
            region: event.region ?? null,
            heroImageUrl: gateHeroUrl(event, visibleHeroKeys),
          },
        },
      ];
    });

    return listMyRsvpsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listMyRsvps", execute);
  }

  return execute();
}

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { projectPublicEventLocation } from "../../../lib/location/project-public-event-location";
import { resolveVenueConfirmationByEvent } from "../../../lib/venue-confirmation";
import {
  buildPublicLineup,
  listPublicEventHumansOutput,
} from "../../event-humans/list-public-event-humans";
import {
  listOpenCallDates,
  loadOpenCallAnchor,
  openCallEndedReason,
  type OpenCallAnchorContext,
  type OpenCallDate,
} from "./_shared/open-call-anchor";
import { openCallPayKindSchema } from "./_shared/open-call-pay";

/** Upcoming series dates the page lists. */
const MAX_SERIES_DATES = 60;
/** Upcoming series dates whose lineup ("Booked so far") the page shows. */
const MAX_BOOKED_DATES = 12;
/**
 * Upcoming materialised series dates read to find the public ones (bounds
 * the event reads when many dates in a row are PRIVATE or called off).
 */
const MAX_SERIES_EVENT_READS = 30;
/** Event statuses a series call never shows a date's venue or lineup from. */
const HIDDEN_SERIES_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "CANCELLED",
  "ARCHIVED",
]);

export const getPublicOpenCallInputSchema = z
  .object({
    publicId: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]{1,32}$/),
  })
  .strict();

const locationSchema = z
  .object({
    /** The venue's name, only when the venue confirmed the event. */
    placeName: z.string().nullable(),
    mode: z.enum(["EXACT", "OBSCURED"]),
    hidden: z.boolean(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    radiusMeters: z.number().nullable(),
    label: z.string().nullable(),
    areaLabel: z.string().nullable(),
    addressText: z.string().nullable(),
    postalCode: z.string().nullable(),
    locality: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().nullable(),
  })
  .strict();

const questionSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(["SHORT_TEXT", "LONG_TEXT", "MULTI_CHOICE", "SINGLE_CHOICE"]),
    label: z.string(),
    description: z.string().nullable(),
    options: z.any().nullable(),
    isRequired: z.boolean(),
    order: z.number().int(),
  })
  .strict();

export const getPublicOpenCallOutputSchema = z
  .object({
    publicId: z.string(),
    anchor: z.enum(["event", "series"]),
    /** The event's title, or the series' name. */
    title: z.string(),
    timezone: z.string(),
    /**
     * Event call: every date of the event. Series call: the upcoming live
     * occurrences (at most 60).
     */
    dates: z.array(
      z
        .object({
          /**
           * The id an application names this date by (`dateIds`, FR-007):
           * the occurrence id on a series call, the EventDate id on an event
           * call. Null for an event with no date rows (the night is implied).
           */
          id: z.string().nullable(),
          startsAt: z.date(),
          endsAt: z.date().nullable(),
        })
        .strict(),
    ),
    /**
     * Address withholding exactly as on the event page's anonymous view
     * (NFR-005). Series call: the next materialised date whose event is
     * PUBLIC and not cancelled / archived, else null.
     */
    location: locationSchema.nullable(),
    introText: z.string().nullable(),
    pay: z
      .object({ kind: openCallPayKindSchema.nullable(), details: z.string().nullable() })
      .strict(),
    opensAt: z.date().nullable(),
    /** The deadline: stops new applications, does not close the call (FR-004). */
    closesAt: z.date().nullable(),
    /** "Closed" on the page. */
    closed: z.boolean(),
    closedReason: z.enum(["closed_by_poster", "last_date_started", "event_ended"]).nullable(),
    /** Not closed and inside the opensAt / closesAt window right now. */
    acceptingApplications: z.boolean(),
    /**
     * "Booked so far" (Q29): the public lineup. One group (startsAt null) for
     * an event call; one group per upcoming materialised date for a series
     * (PUBLIC, not cancelled / archived events only).
     */
    bookedSoFar: z.array(
      z.object({ startsAt: z.date().nullable(), acts: listPublicEventHumansOutput }).strict(),
    ),
    questions: z.array(questionSchema),
  })
  .strict();

export type GetPublicOpenCallInput = z.infer<typeof getPublicOpenCallInputSchema>;
export type GetPublicOpenCallOutput = z.infer<typeof getPublicOpenCallOutputSchema>;

export type GetPublicOpenCallDeps = {
  repos: Pick<
    Repos,
    | "eventApplications"
    | "events"
    | "series"
    | "seriesOccurrences"
    | "eventDates"
    | "places"
    | "eventHumans"
    | "humans"
    | "entityPages"
  >;
  clock: ClockPort;
  /**
   * Deliberate-swallow reporter: a failed venue read degrades the location
   * to fully hidden instead of failing the page (`resolveVenueConfirmationByEvent`).
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/**
 * The public call page (`/call/<publicId>`, open calls FR-003). No auth.
 *
 * Works while the event is a DRAFT (FR-003, Q11): the link is the way in, so
 * this does NOT use the event page's readability gate. It shows ONLY what the
 * call shows: name, dates, the place through the address-withholding
 * projection, intro, pay, deadline, closed state, "Booked so far" and the
 * questions. Every field is projected one by one; nothing is spread from a
 * record, so a column added later can't leak. No submission data of any kind.
 *
 * OPEN_CALL_NOT_FOUND for: an unknown publicId, an ATTEND form's publicId
 * (the attendee gate is not a call), a DRAFT call nobody posted yet (owner
 * ruling Q41), a missing anchor, and a banned owner's call (ban-that-sticks:
 * withheld reads look like missing ones).
 *
 * Closed (FR-005, FR-021, FR-022) when someone pressed Close, when the call's
 * last date has started, or when its event / series ended.
 */
export async function getPublicOpenCall(
  deps: GetPublicOpenCallDeps,
  rawInput: unknown,
): Promise<GetPublicOpenCallOutput> {
  const input = parseInput(getPublicOpenCallInputSchema, rawInput);
  const now = deps.clock.now();

  const form = await deps.repos.eventApplications.getOpenCallByPublicId(input.publicId);
  // A DRAFT call (never posted, owner ruling Q41) is not public yet.
  if (!form || form.ownerBanned || !form.postedAt) {
    throw fail("OPEN_CALL_NOT_FOUND");
  }
  const anchor = await loadOpenCallAnchor(deps.repos, form);

  const { reason: endedReason, upcoming } = await openCallEndedReason(
    deps.repos,
    anchor,
    now,
  );
  const closedReason = form.closedAt ? "closed_by_poster" : endedReason;
  const closed = closedReason !== null;
  const acceptingApplications =
    !closed &&
    (form.opensAt === null || form.opensAt.getTime() <= now.getTime()) &&
    (form.closesAt === null || form.closesAt.getTime() >= now.getTime());

  const dates: OpenCallDate[] =
    anchor.kind === "event"
      ? await listOpenCallDates(deps.repos, anchor, { now, upcomingOnly: false })
      : upcoming.slice(0, MAX_SERIES_DATES);

  const seriesEvents =
    anchor.kind === "series" ? await showableSeriesEvents(deps, upcoming) : [];
  const [location, bookedSoFar, questions] = await Promise.all([
    anchor.kind === "event"
      ? projectEventLocation(deps, anchor.event)
      : seriesEvents[0]
        ? projectEventLocation(deps, seriesEvents[0].event)
        : Promise.resolve(null),
    bookedSoFarFor(deps, anchor, seriesEvents),
    deps.repos.eventApplications.listQuestions(form.id),
  ]);

  return getPublicOpenCallOutputSchema.parse({
    publicId: form.publicId,
    anchor: anchor.kind,
    title: anchor.kind === "event" ? anchor.event.title : anchor.series.name,
    timezone: anchor.kind === "event" ? anchor.event.timezone : anchor.series.timezone,
    dates: dates.map((d) => ({
      id: d.occurrenceId ?? d.eventDateId,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
    })),
    location,
    introText: form.introText,
    pay: { kind: form.payKind, details: form.payDetails },
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    closed,
    closedReason,
    acceptingApplications,
    bookedSoFar,
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      label: q.label,
      description: q.description,
      options: q.options ?? null,
      isRequired: q.isRequired,
      order: q.order,
    })),
  });
}

/**
 * The event's location through THE public projection
 * (`projectPublicEventLocation`), with no gate access granted: what an
 * anonymous visitor of the event page sees (NFR-005). A withheld venue is a
 * floor, a gated event is label only, and the venue is named only when it
 * confirmed the event.
 */
async function projectEventLocation(
  deps: GetPublicOpenCallDeps,
  event: EventRecord,
): Promise<z.infer<typeof locationSchema>> {
  const venue = (
    await resolveVenueConfirmationByEvent(deps, [event], {
      useCase: "getPublicOpenCall",
    })
  ).get(event.id);
  const projected = projectPublicEventLocation(
    event,
    venue?.placeLocation ? { place: venue.placeLocation } : {},
  );
  return {
    placeName: venue?.confirmed ? venue.placeName : null,
    mode: projected.mode,
    hidden: projected.hidden,
    lat: projected.lat,
    lng: projected.lng,
    radiusMeters: projected.radiusMeters,
    label: projected.label,
    areaLabel: projected.areaLabel,
    addressText: projected.addressText,
    postalCode: projected.postalCode,
    locality: projected.locality,
    region: projected.region,
    countryCode: projected.countryCode,
  };
}

/**
 * The upcoming materialised dates of a series whose event a series call may
 * show (its venue, its lineup): PUBLIC, and not cancelled or archived. A
 * PRIVATE date is not advertised through the series' call, whatever the
 * call's own visibility. (An EVENT call shows its own event as-is: the poster
 * posted the call on that very event, Q11.) Ascending by date.
 */
async function showableSeriesEvents(
  deps: GetPublicOpenCallDeps,
  upcoming: OpenCallDate[],
): Promise<Array<{ startsAt: Date; event: EventRecord }>> {
  const materialised = upcoming
    .filter((d): d is OpenCallDate & { eventId: string } => d.eventId !== null)
    .slice(0, MAX_SERIES_EVENT_READS);
  const loaded = await Promise.all(
    materialised.map(async (d) => ({
      startsAt: d.startsAt,
      event: await deps.repos.events.getById(d.eventId),
    })),
  );
  return loaded.filter(
    (row): row is { startsAt: Date; event: EventRecord } =>
      row.event !== null &&
      row.event.visibility === "PUBLIC" &&
      !HIDDEN_SERIES_EVENT_STATUSES.has(row.event.status),
  );
}

async function bookedSoFarFor(
  deps: GetPublicOpenCallDeps,
  anchor: OpenCallAnchorContext,
  seriesEvents: Array<{ startsAt: Date; event: EventRecord }>,
): Promise<Array<{ startsAt: Date | null; acts: z.infer<typeof listPublicEventHumansOutput> }>> {
  if (anchor.kind === "event") {
    return [{ startsAt: null, acts: await buildPublicLineup(deps, anchor.event.id) }];
  }
  const groups = await Promise.all(
    seriesEvents.slice(0, MAX_BOOKED_DATES).map(async (d) => ({
      startsAt: d.startsAt,
      acts: await buildPublicLineup(deps, d.event.id),
    })),
  );
  return groups.filter((g) => g.acts.length > 0);
}

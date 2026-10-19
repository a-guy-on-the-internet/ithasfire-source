import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { venueConfirmedFilterFor } from "../../lib/venue-confirmation";
import { fail } from "@th/errors";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

const timeWindowSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from.getTime() >= value.to.getTime()) {
      ctx.addIssue({ code: "custom", message: "invalid_time_window" });
    }
  });

const eventSummarySchema = z
  .object({
    eventId: z.string().uuid(),
    slug: z.string().nullable(),
    title: z.string(),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    status: z.string(),
    timezone: z.string().nullable(),
    primaryImageUrl: z.string().nullable(),
    priceLabel: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
  })
  .strict();

export const listPlaceEventsInputSchema = z
  .object({
    placeId: z.string().uuid(),
    timeWindow: timeWindowSchema,
    status: z.enum(["upcoming", "past"] as const),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listPlaceEventsOutputSchema = z
  .object({
    events: z.array(eventSummarySchema),
    pageInfo: z
      .object({
        total: z.number().int().min(0),
        limit: z.number().int().min(1),
        offset: z.number().int().min(0),
        count: z.number().int().min(0),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ListPlaceEventsInput = z.infer<typeof listPlaceEventsInputSchema>;
export type ListPlaceEventsOutput = z.infer<typeof listPlaceEventsOutputSchema>;

export type ListPlaceEventsDeps = {
  repos: Pick<Repos, "events" | "places">;
  logger?: LoggerPort;
};

const toSummary = (record: EventRecord) =>
  eventSummarySchema.parse({
    eventId: record.id,
    slug: record.slug ?? null,
    title: record.title,
    startsAt: record.startsAt,
    endsAt: record.endsAt ?? null,
    status: record.status,
    timezone: null,
    primaryImageUrl: null,
    priceLabel: null,
    city: record.locality ?? null,
    region: record.region ?? record.regionCode ?? null,
  });

export async function listPlaceEvents(
  deps: ListPlaceEventsDeps,
  rawInput: unknown,
): Promise<ListPlaceEventsOutput> {
  const input = parseInput(listPlaceEventsInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place || place.status === "ARCHIVED") {
    throw fail("PLACE_NOT_FOUND");
  }

  // Public view: only published events.
  // (Private/admin mode can be introduced later via a separate endpoint/use-case.)

  const whereStatus = input.status;

  // Confirmed-only (venue-confirmation spec, docs/specs/2026-08-27): the
  // public place listing shows the venue's own events and the third-party
  // ones it vouched for — never an unconfirmed claim on its room. The SQL
  // predicate is `isVenueConfirmed`, keyed on the place's owner ids.
  const page = await deps.repos.events.listPublishedByPlace({
    placeId: input.placeId,
    from: input.timeWindow.from,
    to: input.timeWindow.to,
    status: whereStatus,
    limit: input.limit,
    offset: input.offset,
    venueConfirmedFor: venueConfirmedFilterFor(place),
    // A banned owner's events are withheld (ban-that-sticks).
    excludeBannedOwners: true,
  });

  deps.logger?.info("events.list_place", {
    placeId: input.placeId,
    status: input.status,
    from: input.timeWindow.from.toISOString(),
    to: input.timeWindow.to.toISOString(),
    limit: input.limit,
    offset: input.offset,
    resultCount: page.items.length,
    total: page.pageInfo.total,
  });

  return listPlaceEventsOutputSchema.parse({
    events: page.items.map(toSummary),
    pageInfo: {
      // Pick only the fields the strict output schema declares — the repo's
      // pageInfo also carries hasNextPage/nextOffset, which would trip the
      // `.strict()` parse below.
      total: page.pageInfo.total,
      limit: page.pageInfo.limit,
      offset: page.pageInfo.offset,
      count: page.pageInfo.count,
      hasMore: page.pageInfo.offset + page.pageInfo.count < page.pageInfo.total,
    },
  });
}

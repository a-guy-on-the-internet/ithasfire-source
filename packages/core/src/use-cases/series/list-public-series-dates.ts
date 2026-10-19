import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  listPublicSeriesDatesInputSchema,
  listPublicSeriesDatesResultSchema,
  type ListPublicSeriesDatesResult,
} from "./schemas";

export type ListPublicSeriesDatesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/** Hard cap on dates returned to the buyer-facing switcher. */
const MAX_PUBLIC_SERIES_DATES = 60;

/**
 * Buyer-facing, unauthenticated read. Given an event, resolve the series it
 * belongs to (if any) and return that series' published + public sibling
 * dates so the public event page can render a date switcher.
 *
 * Returns an empty date list (and null series fields) when the event is not
 * part of a series or the series has no other published dates — absence is
 * normal and must never throw.
 */
export async function listPublicSeriesDates(
  deps: ListPublicSeriesDatesDeps,
  rawInput: unknown,
): Promise<ListPublicSeriesDatesResult> {
  const input = parseInput(listPublicSeriesDatesInputSchema, rawInput);

  const series = await deps.repos.seriesOccurrences.findSeriesIdByEventId(
    input.eventId,
  );

  if (!series) {
    return listPublicSeriesDatesResultSchema.parse({
      seriesId: null,
      seriesName: null,
      dates: [],
    });
  }

  const rows = await deps.repos.seriesOccurrences.listPublishedDatesBySeriesId(
    series.seriesId,
    MAX_PUBLIC_SERIES_DATES,
  );

  const dates = rows.map((row) => ({
    occurrenceId: row.occurrenceId,
    eventId: row.eventId,
    slug: row.slug,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    timezone: row.timezone,
    isCurrent: row.eventId === input.eventId,
  }));

  return listPublicSeriesDatesResultSchema.parse({
    seriesId: series.seriesId,
    seriesName: series.seriesName,
    dates,
  });
}

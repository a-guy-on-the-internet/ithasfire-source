import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  listSeriesDatesForAdminInputSchema,
  listSeriesDatesForAdminResultSchema,
  type ListSeriesDatesForAdminResult,
} from "./schemas";
import { fail } from "@th/errors";

export type ListSeriesDatesForAdminDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Dates-page data source: one page of a series' occurrences (startsAt asc,
 * stable cursor) joined with a linked-event summary (title/slug/status +
 * ticketTypeCount + soldCount) and a series header (name, timezone, raw
 * schedule summary, totalCount).
 *
 * soldCount mirrors the admin events list (listMyEvents): a batched
 * `events.getPopularityStats` — SUM(qty) of active ticket order items on
 * SUCCEEDED orders per event. ticketTypeCount is a batched
 * `events.listTicketTypesForEventIds` grouped client-side.
 */
export async function listSeriesDatesForAdmin(
  deps: ListSeriesDatesForAdminDeps,
  rawInput: unknown,
): Promise<ListSeriesDatesForAdminResult> {
  const input = parseInput(listSeriesDatesForAdminInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({
    useCase: "listSeriesDatesForAdmin",
  });

  return deps.repos.tx(async (tx) => {
    const series = await tx.series.getById(input.seriesId);
    if (!series) {
      throw fail("SERIES_NOT_FOUND");
    }

    await ensureSeriesOwnerAccess(
      tx,
      series.ownerScope,
      series.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );

    const limit = input.limit ?? 50;
    const [page, totalCount] = await Promise.all([
      tx.seriesOccurrences.listBySeries({
        seriesId: series.id,
        limit,
        cursor: input.cursor ?? null,
      }),
      tx.seriesOccurrences.countBySeries(series.id),
    ]);

    const eventIds = [
      ...new Set(
        page.items
          .map((occ) => occ.eventId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const [events, ticketTypes, popularityStats] =
      eventIds.length > 0
        ? await Promise.all([
            tx.events.findManyByIds(eventIds),
            tx.events.listTicketTypesForEventIds(eventIds),
            tx.events.getPopularityStats(eventIds),
          ])
        : [[], [], []];

    const eventMap = new Map(events.map((event) => [event.id, event]));
    const ticketTypeCounts = new Map<string, number>();
    for (const ticketType of ticketTypes) {
      ticketTypeCounts.set(
        ticketType.eventId,
        (ticketTypeCounts.get(ticketType.eventId) ?? 0) + 1,
      );
    }
    const soldCounts = new Map(
      popularityStats.map((stats) => [stats.eventId, stats.ticketsSold]),
    );

    const items = page.items.map((occ) => {
      const event = occ.eventId ? (eventMap.get(occ.eventId) ?? null) : null;
      return {
        occurrenceId: occ.id,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
        status: occ.status,
        manual: occ.overrides?.manual === true,
        skipNote: occ.overrides?.skipNote ?? null,
        note: occ.overrides?.note ?? null,
        event: event
          ? {
              eventId: event.id,
              title: event.title,
              slug: event.slug,
              status: event.status,
              ticketTypeCount: ticketTypeCounts.get(event.id) ?? 0,
              soldCount: soldCounts.get(event.id) ?? 0,
            }
          : null,
      };
    });

    return listSeriesDatesForAdminResultSchema.parse({
      series: {
        seriesId: series.id,
        name: series.name,
        timezone: series.timezone,
        schedule: {
          kind: series.schedule.kind,
          rrule: series.schedule.rrule ?? null,
          until: series.schedule.until ?? null,
        },
        totalCount,
      },
      items,
      nextCursor: page.nextCursor ?? undefined,
    });
  });
}

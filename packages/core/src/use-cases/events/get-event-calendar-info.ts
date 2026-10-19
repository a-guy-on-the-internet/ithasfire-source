import { z } from "zod";

import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  canViewerReadEvent,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";

export const getEventCalendarInfoInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict();

export const getEventCalendarInfoOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          eventId: z.string(),
          seriesId: z.string(),
          seriesName: z.string(),
          occurrenceId: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type GetEventCalendarInfoInput = z.infer<
  typeof getEventCalendarInfoInputSchema
>;
export type GetEventCalendarInfoOutput = z.infer<
  typeof getEventCalendarInfoOutputSchema
>;

export type GetEventCalendarInfoDeps = {
  repos: Pick<Repos, "events" | "authz" | "seriesOccurrences"> &
    Partial<Pick<Repos, "tickets">>;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
};

/**
 * Which of these events belong to a series, and what the series is called.
 *
 * Scoped to events the actor may READ (F16, 2026-09-29 scanner report): this
 * used to hand series names out for any 50 event ids. Same bar as the event
 * page itself (`canViewerReadEvent`): publicly readable (published or once
 * live), or the actor holds edit rights. Ids the actor can't read — or that
 * don't exist — are silently omitted, so the answer can't be used to tell
 * one from the other.
 */
export async function getEventCalendarInfo(
  deps: GetEventCalendarInfoDeps,
  rawInput: unknown,
): Promise<GetEventCalendarInfoOutput> {
  const input = parseInput(getEventCalendarInfoInputSchema, rawInput);
  const requested = new Set(input.eventIds);

  const events = await deps.repos.events.findManyByIds([...requested], {
    withOwnerStanding: true,
  });
  const candidates = events.filter((event) => requested.has(event.id));
  const verdicts = await Promise.all(
    candidates.map((event) =>
      canViewerReadEvent(
        deps.repos.authz,
        event,
        input.actorHumanId,
        deps.repos.tickets,
        deps.authz,
      ),
    ),
  );
  const readable = new Set(
    candidates.filter((_, i) => verdicts[i]).map((event) => event.id),
  );
  if (readable.size === 0) return { items: [] };

  const items = await deps.repos.seriesOccurrences.getCalendarInfoForEventIds([
    ...readable,
  ]);
  return getEventCalendarInfoOutputSchema.parse({
    items: items
      .filter((item) => readable.has(item.eventId))
      .map((item) => ({
        eventId: item.eventId,
        seriesId: item.seriesId,
        seriesName: item.seriesName,
        occurrenceId: item.occurrenceId,
      })),
  });
}

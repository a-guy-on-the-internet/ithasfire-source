import { z } from "zod";

import { parseInput } from "../../lib/io";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import { resolvePlaceLocations } from "../../lib/location/resolve-place-locations";
import { resolveTimeZone } from "../../lib/venue-local-time";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";
import {
  listSavedEventsInputSchema,
  listSavedEventsOutputSchema,
} from "./schemas";
import { isVisibleInSavedList } from "./shared";

export type ListSavedEventsInput = z.infer<typeof listSavedEventsInputSchema>;
export type ListSavedEventsOutput = z.infer<typeof listSavedEventsOutputSchema>;

export type ListSavedEventsDeps = {
  repos: Pick<Repos, "eventSaves" | "imageModerationRecords" | "places">;
  clock?: ClockPort;
  logger?: LoggerPort;
  /** Deliberate-swallow reporter for a failed venue read (fails closed). */
  reportError?: ReporterPort;
};

/**
 * The actor's own saves, cursor-paginated with an upcoming|past scope.
 * Visibility is re-checked at read time (FR-004): events that are no longer
 * visible (unpublished/archived/etc.) are dropped from the page — never
 * leaked as stubs — while CANCELLED saved events ARE kept (seeing the
 * cancellation is watchlist value; the UI badges it). Filtering can shrink a
 * page below `limit`; the cursor still advances past the full repo page.
 */
export async function listSavedEvents(
  deps: ListSavedEventsDeps,
  rawInput: unknown,
): Promise<ListSavedEventsOutput> {
  const logger = deps.logger?.child({ useCase: "listSavedEvents" });

  const execute = async () => {
    const input = parseInput(listSavedEventsInputSchema, rawInput);
    const result = await deps.repos.eventSaves.listForHuman({
      humanId: input.actorHumanId,
      scope: input.scope,
      cursor: input.cursor,
      limit: input.limit,
      now: deps.clock?.now(),
    });

    const visibleItems = result.items.filter((item) =>
      isVisibleInSavedList(item.event.status),
    );
    // Moderation gate (FR-005): hide a pending/flagged hero even on the saver's
    // own list — consistency, and it's still a public-content leak. Absent
    // record = legacy = visible. One batched lookup for the page.
    const visibleHeroKeys = await resolveVisibleHeroKeys(
      deps.repos,
      visibleItems.map((item) => item.event),
    );

    // The location line is the PUBLIC projection, floored by each venue's
    // CURRENT privacy (one read per distinct venue) — a saved OBSCURED event
    // prints "locality, region", never its street, exactly like every card.
    const placeLocations = await resolvePlaceLocations(
      deps,
      visibleItems.map((item) => item.event.placeId),
      { useCase: "listSavedEvents" },
    );

    return listSavedEventsOutputSchema.parse({
      items: visibleItems.map((item) => ({
        saveId: item.id,
        savedAt: item.createdAt,
        event: {
          id: item.event.id,
          slug: item.event.slug,
          title: item.event.title,
          startsAt: item.event.startsAt,
          endsAt: item.event.endsAt,
          // A usable IANA zone, always: the strip formats the start in it,
          // and `Intl` throws on an unusable one (same rule as
          // `countryEventToDto`).
          timezone: resolveTimeZone(item.event.timezone),
          status: item.event.status,
          visibility: item.event.visibility,
          heroImageId: item.event.heroImageId,
          heroImageUrl: gateHeroUrl(item.event, visibleHeroKeys),
          addressText: projectPublicEventLocation(item.event, {
            place: item.event.placeId
              ? (placeLocations.get(item.event.placeId) ?? null)
              : null,
          }).label,
          locationLabel: item.event.locationLabel,
          placeId: item.event.placeId,
        },
      })),
      nextCursor: result.nextCursor,
    });
  };

  if (logger) {
    return logger.withTime("listSavedEvents", execute);
  }

  return execute();
}

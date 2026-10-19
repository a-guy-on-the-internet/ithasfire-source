import type { ReporterPort } from "@th/ports/reporter";
import type { PlacesRepo } from "@th/ports/repos/places";

import {
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "./project-public-event-location";
import type { PlaceLocationSource } from "./redact-place-location";

export type ResolvePlaceLocationsDeps = {
  repos: { places: Pick<PlacesRepo, "getById"> };
  /**
   * Deliberate-swallow reporter (ReporterPort convention): a failed place read
   * degrades that venue's events to fully hidden for this call instead of
   * failing the read, and must be visible in Sentry.
   */
  reportError?: ReporterPort;
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
};

/**
 * Each venue's location-privacy row, for `projectPublicEventLocation`'s
 * `place` option — ONE read per distinct place id. For callers that need the
 * floor but not venue confirmation (`resolveVenueConfirmationByEvent` carries
 * the same thing as `placeLocation` when a caller needs both).
 *
 * FAILS CLOSED: a place that is gone or whose read throws resolves to
 * `unreadablePlaceLocation` (fully hidden) — never to "no venue", which would
 * let the event row speak for a venue that may have withheld its address.
 */
export async function resolvePlaceLocations(
  deps: ResolvePlaceLocationsDeps,
  placeIds: ReadonlyArray<string | null | undefined>,
  options: { useCase: string },
): Promise<Map<string, PlaceLocationSource>> {
  const distinct = [
    ...new Set(placeIds.filter((id): id is string => typeof id === "string")),
  ];
  const out = new Map<string, PlaceLocationSource>();
  await Promise.all(
    distinct.map(async (placeId) => {
      try {
        const place = await deps.repos.places.getById(placeId);
        out.set(
          placeId,
          place ? toPlaceLocationSource(place) : unreadablePlaceLocation(placeId),
        );
      } catch (err) {
        out.set(placeId, unreadablePlaceLocation(placeId));
        deps.logger?.error("place_location.read_failed", { placeId, err });
        try {
          deps.reportError?.(err, {
            tags: { useCase: options.useCase, step: "resolvePlaceLocations" },
            extra: { placeId },
          });
        } catch {
          // A throwing reporter must never change behaviour.
        }
      }
    }),
  );
  return out;
}

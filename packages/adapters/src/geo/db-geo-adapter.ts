import type { PrismaClient } from "@prisma/client";
import {
  boxSearchParamsSchema,
  createGeoError,
  distanceParamsSchema,
  GeoHealthStatus,
  GeoPort,
  nearbySearchParamsSchema,
  PlaceDTO,
  EventDTO,
  GEO_DEFAULT_LIMIT,
  GEO_MAX_LIMIT,
} from "@th/ports/geo";
import { buildOffsetPageInfo } from "@th/ports/pagination";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import { encodeGeohash, geohashNeighbors } from "@th/core/lib/geo/geohash";
import { bboxForRadius } from "@th/core/lib/geo/geohash";
import { haversineDistance } from "@th/core/lib/geo/haversine";
import {
  projectPublicEventLocation,
  unreadablePlaceLocation,
} from "@th/core/lib/location/project-public-event-location";
import type { PlaceLocationSource } from "@th/core/lib/location/redact-place-location";
import type { EventLocationMode } from "@th/types";
import {
  MAX_OBFUSCATION_RADIUS_METERS,
  METERS_PER_DEGREE_LAT,
} from "./obfuscation";
import {
  eventOwnerNotWithheldWhere,
  resolveWithheldOwners,
} from "../db/prisma/banned-owner";

const DB_BACKEND = "db";

interface DbGeoAdapterOptions {
  logger?: LoggerPort;
  metrics?: MetricsPort;
  maxLimit?: number;
}

type PlaceRecord = {
  id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

type EventRecord = {
  id: string;
  /** Owner — keys the event's circle with its address. */
  orgId: string | null;
  humanId: string | null;
  title: string | null;
  addressText: string | null;
  lat: number | null;
  lng: number | null;
  slug: string | null;
  heroImage: { publicUrl: string; key: string } | null;
  /** Selected (N5): the projector treats a missing gate as gated. */
  gateType: string;
  locationMode: EventLocationMode;
  locationRadiusMeters: number | null;
  locality: string | null;
  region: string | null;
  placeId: string | null;
  place: {
    id: string;
    locationMode: EventLocationMode;
    locationRadiusMeters: number | null;
    locationLabel: string | null;
    lat: number | null;
    lng: number | null;
    city: string | null;
    region: string | null;
    country: string | null;
  } | null;
};

/** Prisma `select` for event rows — true coords stay server-side; the public
 * coordinate/address are derived in `mapEventRow` through THE public
 * projection (`projectPublicEventLocation`), floored by the joined venue. */
const EVENT_GEO_SELECT = {
  id: true,
  orgId: true,
  humanId: true,
  title: true,
  addressText: true,
  lat: true,
  lng: true,
  slug: true,
  heroImage: {
    select: { publicUrl: true, key: true },
  },
  gateType: true,
  locationMode: true,
  locationRadiusMeters: true,
  locality: true,
  region: true,
  placeId: true,
  place: {
    select: {
      id: true,
      locationMode: true,
      locationRadiusMeters: true,
      locationLabel: true,
      lat: true,
      lng: true,
      city: true,
      region: true,
      country: true,
    },
  },
} as const;

/**
 * Place geo reads (`nearbyPlaces`, `boxSearch` for places) return EXACT
 * venues ONLY. They answer with raw coordinates and decide inclusion by the
 * point, so a withheld venue in them would be a presence oracle for its true
 * location; nothing in the product calls them today, and a venue that
 * withholds its address has no business in a pin query anyway.
 */
const EXACT_PLACES_ONLY = { locationMode: "EXACT" as const };

/** "This event has no venue, or a venue that publishes its address." */
const VENUE_PUBLISHES = {
  OR: [{ placeId: null }, { place: { is: { locationMode: "EXACT" as const } } }],
};

/**
 * Which events a public map may show AT ALL: published, PUBLIC (a PRIVATE
 * event is link-only — never listed), and UNGATED (a password/application
 * gate protects the location like the rest of the page; the gated preview
 * carries title + hero only). The geo reads are anonymous, so this is the
 * whole of their authorisation.
 */
const PUBLIC_UNGATED_EVENT = {
  status: "PUBLISHED" as const,
  visibility: "PUBLIC" as const,
  gateType: "NONE" as const,
};

export class DbGeoAdapter implements GeoPort {
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly maxLimit: number;

  constructor(
    private readonly db: PrismaClient,
    options: DbGeoAdapterOptions = {},
  ) {
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.maxLimit = options.maxLimit ?? GEO_MAX_LIMIT;
  }

  async nearbyPlaces(params: Parameters<GeoPort["nearbyPlaces"]>[0]) {
    const parsed = nearbySearchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw createGeoError("invalid_input", parsed.error.message);
    }

    const { lat, lng, radiusM } = parsed.data;
    const limit = this.normalizeLimit(parsed.data.limit);
    const offset = this.normalizeOffset(parsed.data.offset);

    const run = async () => {
      const box = bboxForRadius(lat, lng, radiusM / 1_000);
      const rows = await this.db.place.findMany({
        where: {
          AND: [
            EXACT_PLACES_ONLY,
            { lat: { gte: box.minLat, lte: box.maxLat } },
            { lng: { gte: box.minLng, lte: box.maxLng } },
            { lat: { not: null } },
            { lng: { not: null } },
          ],
        },
        select: {
          id: true,
          name: true,
          address: true,
          lat: true,
          lng: true,
        },
      });

      const mapped = rows
        .map((row) => this.mapPlaceRow(row))
        .map((place) => ({
          place,
          distance: haversineDistance(lat, lng, place.lat, place.lng),
        }))
        .filter(({ distance }) => distance <= radiusM)
        .sort((a, b) =>
          a.distance === b.distance
            ? a.place.id.localeCompare(b.place.id)
            : a.distance - b.distance,
        );

      const sliced = mapped.slice(offset, offset + limit);
      const items = sliced.map(({ place, distance }) => ({
        ...place,
        distanceMeters: distance,
      }));
      this.metrics?.increment("geo.nearby_places.count");
      return {
        items,
        pageInfo: buildOffsetPageInfo({
          total: mapped.length,
          limit,
          offset,
          count: items.length,
        }),
      };
    };

    return this.runWithTiming("geo.nearbyPlaces", run);
  }

  async nearbyEvents(params: Parameters<GeoPort["nearbyEvents"]>[0]) {
    const parsed = nearbySearchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw createGeoError("invalid_input", parsed.error.message);
    }

    const { lat, lng, radiusM, startsAfter, startsBefore } = parsed.data;
    const limit = this.normalizeLimit(parsed.data.limit);
    const offset = this.normalizeOffset(parsed.data.offset);

    const run = async () => {
      // ANTI-ORACLE (FR-013/NFR-001): the Prisma query is only a CANDIDATE
      // fetch. Inclusion, distance, ordering, totals, and pagination are all
      // decided below from the EMITTED (obfuscated) coordinate — deciding
      // inclusion from the true pin would let an attacker grid-probe with a
      // tiny radiusM and recover the true location of an OBSCURED event.
      //
      // EXACT rows keep the tight bbox + geohash prefilter; non-EXACT rows
      // get a bbox widened by the max obfuscation radius, because their
      // emitted point can sit up to `locationRadiusMeters` (≤ the max) away
      // from the true coordinate the bbox/geohash columns are derived from.
      const tightBox = bboxForRadius(lat, lng, radiusM / 1_000);
      const wideBox = bboxForRadius(
        lat,
        lng,
        (radiusM + MAX_OBFUSCATION_RADIUS_METERS) / 1_000,
      );
      const geohashFilter = this.buildGeohashFilter(lat, lng, radiusM);
      //
      // A WITHHELD VENUE's events emit the VENUE's keyed circle centre —
      // within the venue's radius of the VENUE's true point, whatever the
      // event row holds — so they are candidates by the venue's point in the
      // wide box; every other row by its own point.
      // A banned owner's events are withheld (db/prisma/banned-owner.ts);
      // no filter at all while nothing is.
      const notWithheld = eventOwnerNotWithheldWhere(
        await resolveWithheldOwners(this.db),
      );
      const rows = await this.db.event.findMany({
        where: {
          AND: [
            PUBLIC_UNGATED_EVENT,
            ...(notWithheld ? [notWithheld] : []),
            {
              OR: [
                {
                  place: {
                    is: {
                      locationMode: { not: "EXACT" as const },
                      locationRadiusMeters: { not: null },
                      lat: { gte: wideBox.minLat, lte: wideBox.maxLat },
                      lng: { gte: wideBox.minLng, lte: wideBox.maxLng },
                    },
                  },
                },
                {
                  AND: [
                    VENUE_PUBLISHES,
                    { lat: { not: null } },
                    { lng: { not: null } },
                    { geohash6: { not: null } },
                    // FULLY-HIDDEN events (OBSCURED + null radius) are
                    // excluded here where the row alone says so; the rest
                    // (floored to hidden by a venue) drop out in mapEventRow.
                    // Totals/pages are computed AFTER that filter, so no
                    // hidden row is ever counted (count side-channel).
                    {
                      NOT: {
                        locationMode: "OBSCURED" as const,
                        locationRadiusMeters: null,
                      },
                    },
                    {
                      OR: [
                        {
                          locationMode: "EXACT" as const,
                          lat: { gte: tightBox.minLat, lte: tightBox.maxLat },
                          lng: { gte: tightBox.minLng, lte: tightBox.maxLng },
                          ...(geohashFilter ?? {}),
                        },
                        {
                          // Fail-closed: anything non-EXACT is obscured.
                          locationMode: { not: "EXACT" as const },
                          lat: { gte: wideBox.minLat, lte: wideBox.maxLat },
                          lng: { gte: wideBox.minLng, lte: wideBox.maxLng },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            ...(startsAfter ? [{ startsAt: { gte: startsAfter } }] : []),
            ...(startsBefore ? [{ startsAt: { lt: startsBefore } }] : []),
          ],
        },
        select: EVENT_GEO_SELECT,
      });

      const mapped = rows
        .map((row) => this.mapEventRow(row))
        // Fully-hidden events (null mapping) carry no public map point.
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .map((event) => ({
          event,
          // EMITTED-coordinate distance: event.lat/lng are already the public
          // (possibly obfuscated) point.
          distance: haversineDistance(lat, lng, event.lat, event.lng),
        }))
        // EMITTED-coordinate inclusion — the same value the client sees.
        .filter(({ distance }) => distance <= radiusM)
        .sort((a, b) =>
          a.distance === b.distance
            ? a.event.id.localeCompare(b.event.id)
            : a.distance - b.distance,
        );

      const sliced = mapped.slice(offset, offset + limit);
      const items = sliced.map(({ event, distance }) => ({
        ...event,
        distanceMeters: distance,
      }));
      this.metrics?.increment("geo.nearby_events.count");

      return {
        items,
        pageInfo: buildOffsetPageInfo({
          total: mapped.length,
          limit,
          offset,
          count: items.length,
        }),
      };
    };

    return this.runWithTiming("geo.nearbyEvents", run);
  }

  async boxSearch(
    params: Parameters<GeoPort["boxSearch"]>[0],
  ): Promise<Array<PlaceDTO | EventDTO>> {
    const parsed = boxSearchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw createGeoError("invalid_input", parsed.error.message);
    }

    const { entity, sw, ne, startsAfter, startsBefore } = parsed.data;
    const limit = this.normalizeLimit(parsed.data.limit);
    const offset = this.normalizeOffset(parsed.data.offset);

    if (sw.lat > ne.lat) {
      throw createGeoError(
        "invalid_input",
        "southwest latitude must be <= northeast latitude",
      );
    }
    if (sw.lng > ne.lng) {
      throw createGeoError(
        "invalid_input",
        "southwest longitude must be <= northeast longitude",
      );
    }

    const run = async () => {
      if (entity === "place") {
        const rows = await this.db.place.findMany({
          where: {
            AND: [
              EXACT_PLACES_ONLY,
              { lat: { gte: sw.lat, lte: ne.lat } },
              { lng: { gte: sw.lng, lte: ne.lng } },
              { lat: { not: null } },
              { lng: { not: null } },
            ],
          },
          select: {
            id: true,
            name: true,
            address: true,
            lat: true,
            lng: true,
          },
          orderBy: [{ lat: "asc" }, { lng: "asc" }, { id: "asc" }],
          skip: offset,
          take: limit,
        });

        return rows.map((row) => this.mapPlaceRow(row));
      }

      // ANTI-ORACLE (FR-013/NFR-001): the Prisma query is only a CANDIDATE
      // fetch. Non-EXACT rows are matched against a bbox widened by the max
      // obfuscation radius (their emitted point can be up to
      // `locationRadiusMeters` from the true pin); inclusion, ordering, and
      // pagination are decided below from the EMITTED coordinate against the
      // ORIGINAL bbox — otherwise a tiny probe box becomes a presence oracle
      // for the true pin.
      const wideBox = this.expandBox(sw, ne, MAX_OBFUSCATION_RADIUS_METERS);
      // A banned owner's events are withheld (db/prisma/banned-owner.ts);
      // no filter at all while nothing is.
      const notWithheld = eventOwnerNotWithheldWhere(
        await resolveWithheldOwners(this.db),
      );
      const rows = await this.db.event.findMany({
        where: {
          AND: [
            PUBLIC_UNGATED_EVENT,
            ...(notWithheld ? [notWithheld] : []),
            {
              OR: [
                {
                  // A withheld venue's events emit the VENUE's circle
                  // centre: candidates by the venue's point (nearbyEvents).
                  place: {
                    is: {
                      locationMode: { not: "EXACT" as const },
                      locationRadiusMeters: { not: null },
                      lat: { gte: wideBox.minLat, lte: wideBox.maxLat },
                      lng: { gte: wideBox.minLng, lte: wideBox.maxLng },
                    },
                  },
                },
                {
                  AND: [
                    VENUE_PUBLISHES,
                    { lat: { not: null } },
                    { lng: { not: null } },
                    // FULLY-HIDDEN events (OBSCURED + null radius) are
                    // excluded here where the row alone says so; venue-
                    // floored ones drop out in mapEventRow before paging.
                    {
                      NOT: {
                        locationMode: "OBSCURED" as const,
                        locationRadiusMeters: null,
                      },
                    },
                    {
                      OR: [
                        {
                          locationMode: "EXACT" as const,
                          lat: { gte: sw.lat, lte: ne.lat },
                          lng: { gte: sw.lng, lte: ne.lng },
                        },
                        {
                          // Fail-closed: anything non-EXACT is obscured.
                          locationMode: { not: "EXACT" as const },
                          lat: { gte: wideBox.minLat, lte: wideBox.maxLat },
                          lng: { gte: wideBox.minLng, lte: wideBox.maxLng },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            ...(startsAfter ? [{ startsAt: { gte: startsAfter } }] : []),
            ...(startsBefore ? [{ startsAt: { lt: startsBefore } }] : []),
          ],
        },
        select: EVENT_GEO_SELECT,
      });

      return (
        rows
          .map((row) => this.mapEventRow(row))
          // Fully-hidden events (null mapping) carry no public map point.
          .filter((event): event is NonNullable<typeof event> => event !== null)
          // EMITTED-coordinate inclusion against the ORIGINAL bbox.
          .filter(
            (event) =>
              event.lat >= sw.lat &&
              event.lat <= ne.lat &&
              event.lng >= sw.lng &&
              event.lng <= ne.lng,
          )
          // Deterministic ordering by the EMITTED coordinate (never the true
          // one — true-coord ordering leaks an obscured row's position
          // between exact-mode neighbors).
          .sort(
            (a, b) =>
              a.lat - b.lat || a.lng - b.lng || a.id.localeCompare(b.id),
          )
          .slice(offset, offset + limit)
      );
    };

    return this.runWithTiming("geo.boxSearch", run);
  }

  async distance(params: Parameters<GeoPort["distance"]>[0]): Promise<number> {
    const parsed = distanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw createGeoError("invalid_input", parsed.error.message);
    }

    const run = async () => {
      const meters = haversineDistance(
        parsed.data.a.lat,
        parsed.data.a.lng,
        parsed.data.b.lat,
        parsed.data.b.lng,
      );
      this.metrics?.increment("geo.distance.calls");
      return meters;
    };

    return this.runWithTiming("geo.distance", run);
  }

  async health(): Promise<GeoHealthStatus> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { ok: true, backend: DB_BACKEND };
    } catch (error) {
      this.logger?.error("DB geo health check failed", { error });
      this.metrics?.increment("geo.health.failures");
      return {
        ok: false,
        reason: (error as Error).message,
        backend: DB_BACKEND,
      };
    }
  }

  private async runWithTiming<T>(
    metricName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.logger) {
      return fn();
    }
    return this.logger.withTime(metricName, fn);
  }

  private normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return Math.min(GEO_DEFAULT_LIMIT, this.maxLimit);
    }
    return Math.min(Math.max(1, Math.floor(limit)), this.maxLimit);
  }

  private normalizeOffset(offset?: number): number {
    if (typeof offset !== "number" || !Number.isFinite(offset)) {
      return 0;
    }
    return Math.max(0, Math.floor(offset));
  }

  private mapPlaceRow(row: PlaceRecord): PlaceDTO {
    const lat = row.lat;
    const lng = row.lng;
    if (lat === null || lng === null) {
      throw createGeoError(
        "dependency_failed",
        "place row missing coordinates",
      );
    }
    const name = row.name ?? "";
    if (!name) {
      throw createGeoError("dependency_failed", "place row missing name");
    }

    return {
      id: row.id,
      name,
      lat,
      lng,
      formattedAddress: row.address ?? null,
    };
  }

  /**
   * Maps a DB row to the public EventDTO through THE public projection
   * (`projectPublicEventLocation`, floored by the joined venue) — the ONLY
   * coordinate this returns is the emitted (public) one. The true coordinate
   * is deliberately not surfaced past this point so callers can't
   * accidentally filter/order on it (presence-oracle prevention,
   * FR-013/NFR-001). Null = no public map point: the row is dropped.
   */
  private mapEventRow(row: EventRecord): EventDTO | null {
    const title = row.title ?? "";
    if (!title) {
      throw createGeoError("dependency_failed", "event row missing title");
    }

    const location = projectPublicEventLocation(row, {
      place: this.placeOf(row),
    });
    if (location.lat === null || location.lng === null) {
      // FULLY HIDDEN (or no coordinates at all): no public map point exists
      // — drop the row from map/discovery output entirely.
      return null;
    }

    return {
      id: row.id,
      title,
      lat: location.lat,
      lng: location.lng,
      addressText: location.label,
      heroImageUrl: row.heroImage?.publicUrl ?? null,
      heroImageKey: row.heroImage?.key ?? null,
      slug: row.slug ?? null,
      // Discriminant for map UIs (FR-013): an obfuscated point renders as a
      // soft circle/blob, never a sharp pin. Only the literal "EXACT" is exact.
      ...(location.mode !== "EXACT"
        ? { obscured: true, radiusMeters: location.radiusMeters }
        : {}),
    };
  }

  /** The joined venue as the projection reads it; fails closed if unjoined. */
  private placeOf(row: EventRecord): PlaceLocationSource | null {
    if (!row.placeId) return null;
    if (!row.place) return unreadablePlaceLocation(row.placeId);
    return {
      id: row.place.id,
      locationMode: row.place.locationMode,
      locationRadiusMeters: row.place.locationRadiusMeters,
      locationLabel: row.place.locationLabel,
      lat: row.place.lat,
      lng: row.place.lng,
      city: row.place.city,
      region: row.place.region,
      countryCode: row.place.country,
    };
  }

  /**
   * Expands a lat/lng box by a metre margin using the same planar conversion
   * as `obfuscateCoordinate`, so the widened candidate box is a complete
   * bound on where an obscured row's TRUE pin can sit while its EMITTED
   * point falls inside the original box.
   *
   * The longitude margin is converted at TWO latitude margins past the box:
   * a circle centre is a chain of steps, each converted at the latitude the
   * chain had reached, and an intermediate step can sit up to ~2R from the
   * emitted point — the narrower `cos` keeps the bound complete there.
   */
  private expandBox(
    sw: { lat: number; lng: number },
    ne: { lat: number; lng: number },
    marginMeters: number,
  ): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
    const latMargin = marginMeters / METERS_PER_DEGREE_LAT;
    const maxAbsLat = Math.min(
      Math.max(Math.abs(sw.lat), Math.abs(ne.lat)) + 2 * latMargin,
      89.9,
    );
    const lngMargin =
      marginMeters /
      (METERS_PER_DEGREE_LAT *
        Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 1e-6));
    return {
      minLat: sw.lat - latMargin,
      maxLat: ne.lat + latMargin,
      minLng: sw.lng - lngMargin,
      maxLng: ne.lng + lngMargin,
    };
  }

  private buildGeohashFilter(
    lat: number,
    lng: number,
    radiusM: number | null,
  ): { OR: Array<{ geohash6: { startsWith: string } }> } | null {
    if (
      radiusM === null ||
      radiusM === undefined ||
      !Number.isFinite(radiusM) ||
      radiusM <= 0
    ) {
      return null;
    }

    const prefixes = this.computeGeohashPrefixes(lat, lng, radiusM);
    if (!prefixes?.length) {
      return null;
    }

    const unique = Array.from(new Set(prefixes));
    return {
      OR: unique.map((prefix) => ({ geohash6: { startsWith: prefix } })),
    };
  }

  private computeGeohashPrefixes(
    lat: number,
    lng: number,
    radiusM: number,
  ): string[] | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    const precision = this.chooseGeohashPrecision(radiusM);
    if (!precision) {
      return null;
    }

    try {
      const center = encodeGeohash(lat, lng, precision);
      const neighbors = geohashNeighbors(center);
      return [center, ...neighbors];
    } catch (error) {
      this.logger?.warn("Failed to compute geohash prefixes", { error });
      return null;
    }
  }

  private chooseGeohashPrecision(radiusM: number): number | null {
    const km = radiusM / 1_000;
    const thresholds: Array<{ precision: number; maxKm: number }> = [
      { precision: 6, maxKm: 1.5 },
      { precision: 5, maxKm: 5 },
      { precision: 4, maxKm: 20 },
      { precision: 3, maxKm: 80 },
      { precision: 2, maxKm: 320 },
      { precision: 1, maxKm: 2_500 },
    ];

    for (const entry of thresholds) {
      if (km <= entry.maxKm) {
        return entry.precision;
      }
    }

    return null;
  }
}

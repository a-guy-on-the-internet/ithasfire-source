import { Prisma, PrismaClient } from "@prisma/client";
import type { Pool } from "pg";
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
  snappedObfuscationRadiusSql,
} from "./obfuscation";
import { eventOwnerNotWithheldSubquerySql } from "../db/prisma/banned-owner";

const POSTGIS_BACKEND = "postgis";

/**
 * Place geo reads (`nearbyPlaces`, `boxSearch` for places) return EXACT
 * venues ONLY. They answer with raw coordinates and decide inclusion by the
 * point, so a withheld venue in them would be a presence oracle for its true
 * location; nothing in the product calls them today, and a venue that
 * withholds its address has no business in a pin query anyway.
 */

/** "This event's venue withholds its address" — the joined `pl` row. */
const VENUE_WITHHOLDS = Prisma.sql`(pl.id IS NOT NULL AND pl.location_mode <> 'EXACT')`;

/**
 * Which events a public map may show AT ALL: published, PUBLIC (a PRIVATE
 * event is link-only — never listed), and UNGATED (a password/application
 * gate protects the location like the rest of the page; the gated preview
 * carries title + hero only). The geo reads are anonymous, so this is the
 * whole of their authorisation. A banned owner's events are withheld
 * (db/prisma/banned-owner.ts).
 */
const PUBLIC_UNGATED_EVENT = Prisma.sql`e.status = 'PUBLISHED'
          AND e.visibility = 'PUBLIC'
          AND e."gateType" = 'NONE'
          AND ${eventOwnerNotWithheldSubquerySql("e")}`;

/** The venue's / the event row's DRAWN radius (snapped up to the ladder). */
const VENUE_DRAWN_RADIUS = snappedObfuscationRadiusSql(
  Prisma.sql`pl.location_radius_meters`,
);
const EVENT_DRAWN_RADIUS = snappedObfuscationRadiusSql(
  Prisma.sql`e."locationRadiusMeters"`,
);

/** Event + venue columns every event geo query selects (see `NearbyRow`). */
const EVENT_LOCATION_COLUMNS = Prisma.sql`
  e.id,
  e.title,
  e."orgId",
  e."humanId",
  e."addressText",
  e.slug,
  e."gateType"::text AS "gateType",
  e."locationMode",
  e."locationRadiusMeters",
  e.locality,
  e.region,
  e."placeId",
  ST_Y(e.loc::geometry) AS lat,
  ST_X(e.loc::geometry) AS lng,
  hi."publicUrl" AS "heroImageUrl",
  hi."key" AS "heroImageKey",
  pl.id AS "placeRowId",
  pl.location_mode AS "placeLocationMode",
  pl.location_radius_meters AS "placeLocationRadiusMeters",
  pl.location_label AS "placeLocationLabel",
  pl.lat AS "placeLat",
  pl.lng AS "placeLng",
  pl.city AS "placeCity",
  pl.region AS "placeRegion",
  pl.country AS "placeCountry"
`;

type QueryClient = PrismaClient | Pool;

type NearbyRow = {
  id: string;
  name?: string;
  title?: string;
  formattedAddress?: string | null;
  addressText?: string | null;
  lat: number | string;
  lng: number | string;
  distance: number | string;
  total?: number | string;
  heroImageUrl?: string | null;
  heroImageKey?: string | null;
  slug?: string | null;
  /** Selected with every event row (N5): a missing gate projects as gated. */
  gateType?: string | null;
  locationMode?: EventLocationMode | null;
  locationRadiusMeters?: number | string | null;
  locality?: string | null;
  region?: string | null;
  // Owner — keys the event's circle with its address (`eventCircleSubject`).
  orgId?: string | null;
  humanId?: string | null;
  // The event's venue (LEFT JOIN "Place") — its address privacy floors the
  // event, and a withheld venue's events emit the VENUE's circle.
  placeId?: string | null;
  placeRowId?: string | null;
  placeLocationMode?: EventLocationMode | string | null;
  placeLocationRadiusMeters?: number | string | null;
  placeLocationLabel?: string | null;
  placeLat?: number | string | null;
  placeLng?: number | string | null;
  placeCity?: string | null;
  placeRegion?: string | null;
  placeCountry?: string | null;
};

type HealthRow = {
  v: string | null;
};

type DistanceRow = {
  meters: number | string;
};

interface PostGISGeoAdapterOptions {
  logger?: LoggerPort;
  metrics?: MetricsPort;
  maxLimit?: number;
}

function isPgPool(client: QueryClient): client is Pool {
  return typeof (client as Pool).query === "function";
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export class PostGISGeoAdapter implements GeoPort {
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly maxLimit: number;

  constructor(
    private readonly db: QueryClient,
    options: PostGISGeoAdapterOptions = {},
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
      const referencePoint = this.makeReferencePoint(lat, lng);
      const ranked = Prisma.sql`
        SELECT
          p.id,
          p.name,
          p.address AS "formattedAddress",
          ST_Y(p.loc::geometry) AS lat,
          ST_X(p.loc::geometry) AS lng,
          ST_Distance(p.loc, ${referencePoint}) AS distance,
          COUNT(*) OVER() AS total
        FROM "Place" AS p
        WHERE p.loc IS NOT NULL
          AND p.location_mode = 'EXACT'
          AND ST_DWithin(p.loc, ${referencePoint}, ${radiusM})
      `;

      const query = Prisma.sql`
        SELECT *
        FROM (${ranked}) AS ranked
        ORDER BY distance ASC, id ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const rows = await this.query<NearbyRow>(query);
      const total = toNumber(rows[0]?.total) ?? 0;
      const items = rows.map((row) => this.mapPlaceRow(row, true));
      this.metrics?.increment("geo.nearby_places.count");
      return {
        items,
        pageInfo: buildOffsetPageInfo({
          total,
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
      const referencePoint = this.makeReferencePoint(lat, lng);

      // Build optional date-range fragments
      const dateFragments: Prisma.Sql[] = [];
      if (startsAfter) {
        dateFragments.push(Prisma.sql`AND e."startsAt" >= ${startsAfter}`);
      }
      if (startsBefore) {
        dateFragments.push(Prisma.sql`AND e."startsAt" < ${startsBefore}`);
      }
      const dateSql = dateFragments.length
        ? Prisma.sql`${Prisma.join(dateFragments, " ")}`
        : Prisma.empty;

      // FULLY-HIDDEN events (OBSCURED + null radius) are excluded IN SQL
      // where the row alone says so; the rest (an event whose venue floors it
      // to hidden) are dropped by the mapEventRow null-filter. Totals and
      // pages are computed AFTER that filter, so no hidden row is counted —
      // counting them would open a side-channel on a hidden event.
      //
      // ANTI-ORACLE (FR-013/NFR-001): SQL is only a CANDIDATE fetch. For
      // non-EXACT rows the predicate is widened per-row by the DRAWN radius
      // (`locationRadiusMeters` snapped up to the ladder — the emitted point
      // is at most that far from the true pin), and inclusion, distance,
      // ordering, totals, and
      // pagination are all decided BELOW from the EMITTED (obfuscated)
      // coordinate. Deciding inclusion from the true pin would let an
      // attacker grid-probe with a tiny radiusM and recover the true
      // location. The constant widened ST_DWithin keeps the spatial index
      // usable; the CASE predicate tightens it per-row.
      //
      // A WITHHELD VENUE's events emit the VENUE's keyed circle centre, which
      // is within the venue's radius of the VENUE's true point — whatever the
      // event row holds (the public projection, or a stale true copy). So
      // those rows are candidates by the venue's point widened by the venue's
      // radius, and every other row by its own point widened by its own.
      const venuePoint = Prisma.sql`ST_SetSRID(ST_MakePoint(pl.lng, pl.lat), 4326)::geography`;
      const query = Prisma.sql`
        SELECT
          ${EVENT_LOCATION_COLUMNS},
          ST_Distance(e.loc, ${referencePoint}) AS distance
        FROM "Event" AS e
        LEFT JOIN "Place" AS pl ON pl.id = e."placeId"
        LEFT JOIN event_images AS hi ON hi.id = e.hero_image_id
        WHERE ${PUBLIC_UNGATED_EVENT}
          AND (
            (
              ${VENUE_WITHHOLDS}
              AND pl.lat IS NOT NULL
              AND pl.lng IS NOT NULL
              AND pl.location_radius_meters IS NOT NULL
              AND ST_DWithin(${venuePoint}, ${referencePoint}, ${radiusM}::float8 + ${VENUE_DRAWN_RADIUS})
            )
            OR (
              NOT ${VENUE_WITHHOLDS}
              AND e.loc IS NOT NULL
              AND NOT (e."locationMode" = 'OBSCURED' AND e."locationRadiusMeters" IS NULL)
              AND ST_DWithin(e.loc, ${referencePoint}, ${radiusM + MAX_OBFUSCATION_RADIUS_METERS})
              AND ST_DWithin(
                e.loc,
                ${referencePoint},
                ${radiusM}::float8 + CASE WHEN e."locationMode" = 'EXACT' THEN 0 ELSE COALESCE(${EVENT_DRAWN_RADIUS}, 0) END
              )
            )
          )
          ${dateSql}
      `;

      const rows = await this.query<NearbyRow>(query);
      const filtered = rows
        .map((row) => this.mapEventRow(row, true, { lat, lng }))
        // Fully-hidden events (null mapping) carry no public map point.
        .filter((item): item is NonNullable<typeof item> => item !== null)
        // EMITTED-coordinate inclusion: `distanceMeters` is measured from the
        // obfuscated point for non-EXACT rows (see mapEventRow), so this
        // filter — and everything downstream (order, total, page slice) — is
        // a function of the public coordinate only.
        .filter((item) => (item.distanceMeters ?? Infinity) <= radiusM)
        .sort((a, b) => {
          const da = a.distanceMeters ?? Infinity;
          const db = b.distanceMeters ?? Infinity;
          return da === db ? a.id.localeCompare(b.id) : da - db;
        });
      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);
      this.metrics?.increment("geo.nearby_events.count");
      return {
        items,
        pageInfo: buildOffsetPageInfo({
          total,
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
      const envelope = Prisma.sql`ST_MakeEnvelope(${sw.lng}, ${sw.lat}, ${ne.lng}, ${ne.lat}, 4326)`;

      if (entity === "place") {
        const query = Prisma.sql`
          SELECT
            p.id,
            p.name,
            p.address AS "formattedAddress",
            ST_Y(p.loc::geometry) AS lat,
            ST_X(p.loc::geometry) AS lng
          FROM "Place" AS p
          WHERE p.loc IS NOT NULL
            AND p.location_mode = 'EXACT'
            AND ST_Intersects(p.loc::geometry, ${envelope})
          ORDER BY lat ASC, lng ASC, p.id ASC
          LIMIT ${limit}
          OFFSET ${offset}
        `;

        const rows = await this.query<NearbyRow>(query);
        return rows.map((row) => this.mapPlaceRow(row, false));
      }

      // Build optional date-range fragments for event queries
      const dateFragments: Prisma.Sql[] = [];
      if (startsAfter) {
        dateFragments.push(Prisma.sql`AND e."startsAt" >= ${startsAfter}`);
      }
      if (startsBefore) {
        dateFragments.push(Prisma.sql`AND e."startsAt" < ${startsBefore}`);
      }
      const dateSql = dateFragments.length
        ? Prisma.sql`${Prisma.join(dateFragments, " ")}`
        : Prisma.empty;

      // FULLY-HIDDEN events (OBSCURED + null radius) are excluded IN SQL so
      // pages never reflect them; the mapEventRow null-filter below stays as
      // belt-and-braces only.
      //
      // ANTI-ORACLE (FR-013/NFR-001): SQL is only a CANDIDATE fetch. For
      // non-EXACT rows the envelope is widened by the max obfuscation radius
      // (the emitted point is at most `locationRadiusMeters` ≤ that bound
      // from the true pin); inclusion, ordering, and pagination are decided
      // BELOW from the EMITTED (obfuscated) coordinate against the ORIGINAL
      // bbox — otherwise a tiny probe box becomes a presence oracle for the
      // true pin.
      const latMarginDeg = MAX_OBFUSCATION_RADIUS_METERS / METERS_PER_DEGREE_LAT;
      // `cos` taken two margins past the box: a circle centre is a chain of
      // steps, each converted at the latitude the chain had reached (see
      // DbGeoAdapter.expandBox).
      const maxAbsLat = Math.min(
        Math.max(Math.abs(sw.lat), Math.abs(ne.lat)) + 2 * latMarginDeg,
        89.9,
      );
      const lngMarginDeg =
        MAX_OBFUSCATION_RADIUS_METERS /
        (METERS_PER_DEGREE_LAT *
          Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 1e-6));
      const expandedEnvelope = Prisma.sql`ST_Expand(${envelope}, ${lngMarginDeg}, ${latMarginDeg})`;

      // A withheld venue's events emit the VENUE's circle centre: candidates
      // by the venue's true point in the widened envelope (see nearbyEvents).
      const query = Prisma.sql`
        SELECT
          ${EVENT_LOCATION_COLUMNS}
        FROM "Event" AS e
        LEFT JOIN "Place" AS pl ON pl.id = e."placeId"
        LEFT JOIN event_images AS hi ON hi.id = e.hero_image_id
        WHERE ${PUBLIC_UNGATED_EVENT}
          AND (
            (
              ${VENUE_WITHHOLDS}
              AND pl.lat IS NOT NULL
              AND pl.lng IS NOT NULL
              AND pl.location_radius_meters IS NOT NULL
              AND ST_Intersects(ST_SetSRID(ST_MakePoint(pl.lng, pl.lat), 4326), ${expandedEnvelope})
            )
            OR (
              NOT ${VENUE_WITHHOLDS}
              AND e.loc IS NOT NULL
              AND NOT (e."locationMode" = 'OBSCURED' AND e."locationRadiusMeters" IS NULL)
              AND (
                (e."locationMode" = 'EXACT' AND ST_Intersects(e.loc::geometry, ${envelope}))
                OR (e."locationMode" <> 'EXACT' AND ST_Intersects(e.loc::geometry, ${expandedEnvelope}))
              )
            )
          )
          ${dateSql}
      `;

      const rows = await this.query<NearbyRow>(query);
      return (
        rows
          .map((row) => this.mapEventRow(row, false))
          // Fully-hidden events (null mapping) carry no public map point.
          .filter((item): item is NonNullable<typeof item> => item !== null)
          // EMITTED-coordinate inclusion against the ORIGINAL bbox.
          .filter(
            (item) =>
              item.lat >= sw.lat &&
              item.lat <= ne.lat &&
              item.lng >= sw.lng &&
              item.lng <= ne.lng,
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
      const query = Prisma.sql`
        SELECT ST_Distance(
          ${this.makeReferencePoint(parsed.data.a.lat, parsed.data.a.lng)},
          ${this.makeReferencePoint(parsed.data.b.lat, parsed.data.b.lng)}
        ) AS meters
      `;

      const rows = await this.query<DistanceRow>(query);
      const result = rows[0]?.meters;
      const distance = toNumber(result);
      if (distance === null) {
        throw createGeoError(
          "dependency_failed",
          "distance computation failed",
        );
      }
      this.metrics?.increment("geo.distance.calls");
      return distance;
    };

    return this.runWithTiming("geo.distance", run);
  }

  async health(): Promise<GeoHealthStatus> {
    try {
      const rows = await this.query<HealthRow>(
        Prisma.sql`SELECT PostGIS_Version() AS v`,
      );
      const version = rows[0]?.v ?? null;
      if (!version) {
        this.metrics?.increment("geo.health.failures");
        return {
          ok: false,
          reason: "postgis_extension_missing",
          backend: POSTGIS_BACKEND,
        };
      }

      // Ensure the schema supports the PostGIS queries used by this adapter.
      // This is a *capability probe* rather than metadata introspection:
      // - it validates the `loc` columns exist on Event + Place
      // - it validates the PostGIS functions/casts we rely on are usable
      // - it does not scan any table data (WHERE FALSE)
      try {
        await this.query(
          Prisma.sql`
            SELECT ST_DWithin(
              e.loc,
              ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
              1
            )
            FROM "Event" AS e
            WHERE FALSE
          `,
        );

        await this.query(
          Prisma.sql`
            SELECT ST_DWithin(
              p.loc,
              ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
              1
            )
            FROM "Place" AS p
            WHERE FALSE
          `,
        );
      } catch {
        // Any failure here means PostGIS isn't usable with our expected schema.
        // Keep the reason stable so the factory can fall back to the DB backend.
        this.metrics?.increment("geo.health.failures");
        return {
          ok: false,
          reason: "postgis_loc_columns_missing",
          backend: POSTGIS_BACKEND,
        };
      }

      return { ok: true, backend: POSTGIS_BACKEND };
    } catch (error) {
      // WARN, not error — the caller treats `{ ok: false }` as a soft
      // signal to fall back to the DB geo backend. Logging at error
      // level here would fire a Sentry exception (via pinoIntegration)
      // on every PostGIS-less environment, which is noise.
      this.logger?.warn("PostGIS health check failed", { error });
      this.metrics?.increment("geo.health.failures");
      return {
        ok: false,
        reason: (error as Error).message,
        backend: POSTGIS_BACKEND,
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

  private makeReferencePoint(lat: number, lng: number): Prisma.Sql {
    return Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
  }

  private mapPlaceRow(row: NearbyRow, includeDistance: boolean): PlaceDTO {
    const lat = toNumber(row.lat);
    const lng = toNumber(row.lng);
    const name = row.name ?? "";
    if (!name) {
      throw createGeoError("dependency_failed", "place row missing name");
    }
    if (lat === null || lng === null) {
      throw createGeoError(
        "dependency_failed",
        "place row missing coordinates",
      );
    }
    const distance = includeDistance
      ? (toNumber(row.distance) ?? undefined)
      : undefined;
    return {
      id: row.id,
      name,
      lat,
      lng,
      formattedAddress: row.formattedAddress ?? null,
      ...(distance !== undefined && { distanceMeters: distance }),
    };
  }

  /**
   * Maps a row to the public EventDTO through THE public projection
   * (`projectPublicEventLocation`) — the ONLY coordinate this returns is the
   * emitted one, so callers cannot filter/order on the true point
   * (presence-oracle prevention, FR-013/NFR-001). Null = no public position
   * (fully hidden): the row is dropped.
   */
  private mapEventRow(
    row: NearbyRow,
    includeDistance: boolean,
    /** Query reference point — distance for non-EXACT rows is re-measured
     * from the EMITTED point (anti-triangulation). */
    reference?: { lat: number; lng: number },
  ): EventDTO | null {
    const title = row.title ?? "";
    if (!title) {
      throw createGeoError("dependency_failed", "event row missing title");
    }

    const location = projectPublicEventLocation(
      {
        id: row.id,
        orgId: row.orgId ?? null,
        humanId: row.humanId ?? null,
        // The SQL admits `gateType = 'NONE'` only, but the projector decides
        // from the column it is handed, never from what a WHERE implied.
        gateType: row.gateType ?? null,
        locationMode: row.locationMode ?? null,
        locationRadiusMeters: toNumber(row.locationRadiusMeters),
        addressText: row.addressText ?? null,
        lat: toNumber(row.lat),
        lng: toNumber(row.lng),
        locality: row.locality ?? null,
        region: row.region ?? null,
      },
      { place: this.placeOf(row) },
    );
    if (location.lat === null || location.lng === null) {
      // No public map point (fully hidden, or no coordinates at all).
      return null;
    }

    let distance: number | undefined;
    if (includeDistance) {
      if (location.mode === "EXACT" || !reference) {
        // EXACT: the SQL ST_Distance (true coords) is correct to expose.
        distance = toNumber(row.distance) ?? undefined;
      } else {
        // non-EXACT: measured from the emitted point so the displayed
        // distance can't be differenced back to the true location.
        distance = haversineDistance(
          reference.lat,
          reference.lng,
          location.lat,
          location.lng,
        );
      }
    }

    return {
      id: row.id,
      title,
      lat: location.lat,
      lng: location.lng,
      addressText: location.label,
      heroImageUrl: row.heroImageUrl ?? null,
      heroImageKey: row.heroImageKey ?? null,
      slug: row.slug ?? null,
      ...(distance !== undefined && { distanceMeters: distance }),
      // Discriminant for map UIs (FR-013): an obfuscated point renders as a
      // soft circle/blob, never a sharp pin. Only the literal "EXACT" is exact.
      ...(location.mode !== "EXACT"
        ? { obscured: true, radiusMeters: location.radiusMeters }
        : {}),
    };
  }

  /** The joined venue as the projection reads it; fails closed if unjoined. */
  private placeOf(row: NearbyRow): PlaceLocationSource | null {
    if (!row.placeId) return null;
    if (!row.placeRowId) return unreadablePlaceLocation(row.placeId);
    return {
      id: row.placeRowId,
      locationMode: row.placeLocationMode ?? null,
      locationRadiusMeters: toNumber(row.placeLocationRadiusMeters),
      locationLabel: row.placeLocationLabel ?? null,
      lat: toNumber(row.placeLat),
      lng: toNumber(row.placeLng),
      city: row.placeCity ?? null,
      region: row.placeRegion ?? null,
      countryCode: row.placeCountry ?? null,
    };
  }

  private async query<T>(sql: Prisma.Sql): Promise<T[]> {
    try {
      if (isPgPool(this.db)) {
        const result = await this.db.query(sql.text, sql.values);
        return result.rows as T[];
      }
      return this.db.$queryRaw<T[]>(sql);
    } catch (error) {
      this.logger?.error("PostGIS query failed", { error });
      throw this.wrapDbError(error);
    }
  }

  private wrapDbError(error: unknown) {
    if (error instanceof Error) {
      const message = error.message ?? "unknown PostGIS error";
      if ((error as { code?: string }).code === "57014") {
        return createGeoError("transient", message);
      }
      return createGeoError("dependency_failed", message);
    }
    return createGeoError("dependency_failed", "unknown PostGIS error");
  }
}

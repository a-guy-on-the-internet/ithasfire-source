import type { EventRecord } from "@th/types/repos/events";
import type { PlaceRecord } from "@th/types/repos/places";
import { z } from "zod";

import type { OffsetPaginatedResult } from "./pagination";
import { offsetPaginatedResultSchema } from "./pagination";

export const GEO_DEFAULT_LIMIT = 20;
export const GEO_MAX_LIMIT = 200;

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const geoCoordinateSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});

export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(GEO_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export const nearbySearchParamsSchema = geoCoordinateSchema.extend({
  radiusM: z.number().positive(),
  /** Only include events that start at or after this instant. */
  startsAfter: z.coerce.date().optional(),
  /** Only include events that start before this instant. */
  startsBefore: z.coerce.date().optional(),
  ...paginationSchema.shape,
});

export const boxSearchParamsSchema = z.object({
  sw: geoCoordinateSchema,
  ne: geoCoordinateSchema,
  entity: z.enum(["place", "event"] as const),
  /** Only include events that start at or after this instant. */
  startsAfter: z.coerce.date().optional(),
  /** Only include events that start before this instant. */
  startsBefore: z.coerce.date().optional(),
  ...paginationSchema.shape,
});

export const distanceParamsSchema = z.object({
  a: geoCoordinateSchema,
  b: geoCoordinateSchema,
});

type PlaceRecordFields = Pick<
  PlaceRecord,
  "id" | "name" | "formattedAddress" | "lat" | "lng"
>;
type EventRecordFields = Pick<
  EventRecord,
  "id" | "title" | "addressText" | "lat" | "lng"
>;

export type PlaceDTO = {
  id: PlaceRecordFields["id"];
  name: PlaceRecordFields["name"];
  formattedAddress?: PlaceRecordFields["formattedAddress"];
  lat: NonNullable<PlaceRecordFields["lat"]>;
  lng: NonNullable<PlaceRecordFields["lng"]>;
  distanceMeters?: number;
};

export type EventDTO = {
  id: EventRecordFields["id"];
  title: EventRecordFields["title"];
  addressText?: EventRecordFields["addressText"];
  lat: NonNullable<EventRecordFields["lat"]>;
  lng: NonNullable<EventRecordFields["lng"]>;
  distanceMeters?: number;
  /** Public URL of the hero/cover image, if available. */
  heroImageUrl?: string | null;
  /**
   * R2 storage key of the hero image, for the read-time moderation visibility
   * gate (keyed by storage key). Populated by the geo adapters for the gating
   * step in the calling use case; intentionally NOT part of `eventDtoSchema`,
   * so it is stripped from the public output (the use case gates on it, then
   * `eventDtoSchema.parse` drops it — clients never receive the raw key).
   */
  heroImageKey?: string | null;
  /** URL-friendly slug — available when the underlying query includes it. */
  slug?: string | null;
  /**
   * True when `lat`/`lng` is an OBFUSCATED public point (OBSCURED location
   * mode) rather than the true venue pin — map UIs should render a soft
   * circle/blob instead of a sharp marker (FR-013). Absent/false = exact.
   * Fully-hidden events never reach this DTO (they are dropped upstream).
   */
  obscured?: boolean;
  /** Obfuscation circle radius in meters — only present when `obscured`. */
  radiusMeters?: number | null;
};

export const placeDtoSchema: z.ZodType<PlaceDTO> = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  lat: latitudeSchema,
  lng: longitudeSchema,
  formattedAddress: z.string().min(1).optional().nullable(),
  distanceMeters: z.number().nonnegative().optional(),
});

export const eventDtoSchema: z.ZodType<EventDTO> = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  lat: latitudeSchema,
  lng: longitudeSchema,
  addressText: z.string().min(1).optional().nullable(),
  distanceMeters: z.number().nonnegative().optional(),
  heroImageUrl: z.string().min(1).optional().nullable(),
  slug: z.string().min(1).optional().nullable(),
  obscured: z.boolean().optional(),
  radiusMeters: z.number().positive().optional().nullable(),
});

export const paginatedPlaceDtoSchema =
  offsetPaginatedResultSchema(placeDtoSchema);
export const paginatedEventDtoSchema =
  offsetPaginatedResultSchema(eventDtoSchema);

export const geoHealthStatusSchema = z.object({
  ok: z.boolean(),
  reason: z.string().min(1).optional(),
  backend: z.string().min(1).optional(),
});

export type GeoHealthStatus = z.infer<typeof geoHealthStatusSchema>;

export type GeoErrorCode =
  | "invalid_input"
  | "dependency_failed"
  | "transient"
  | "not_found";

export type GeoError<TCode extends GeoErrorCode = GeoErrorCode> = {
  code: TCode;
  message: string;
};

export function createGeoError<TCode extends GeoErrorCode>(
  code: TCode,
  message: string,
): GeoError<TCode> {
  return { code, message } as const;
}

export function isGeoError(error: unknown): error is GeoError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.length > 0
  );
}

export interface GeoPort {
  nearbyPlaces(
    params: z.infer<typeof nearbySearchParamsSchema>,
  ): Promise<OffsetPaginatedResult<PlaceDTO>>;
  nearbyEvents(
    params: z.infer<typeof nearbySearchParamsSchema>,
  ): Promise<OffsetPaginatedResult<EventDTO>>;
  boxSearch(
    params: z.infer<typeof boxSearchParamsSchema>,
  ): Promise<Array<PlaceDTO | EventDTO>>;
  distance(params: z.infer<typeof distanceParamsSchema>): Promise<number>;
  health(): Promise<GeoHealthStatus>;
}

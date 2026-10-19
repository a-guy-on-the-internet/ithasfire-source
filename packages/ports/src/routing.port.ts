import { z } from "zod";
import { geoCoordinateSchema } from "./geo";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const travelModeSchema = z.enum(["auto", "bicycle", "pedestrian"]);

export const routeRequestSchema = z.object({
  origin: geoCoordinateSchema,
  destination: geoCoordinateSchema,
  mode: travelModeSchema.optional().default("auto"),
});

export const routeResultSchema = z.object({
  /** Total travel time in seconds. */
  timeSeconds: z.number().nonnegative(),
  /** Total travel distance in meters. */
  distanceMeters: z.number().nonnegative(),
  /** Encoded polyline geometry (Valhalla shape), if available. */
  geometry: z.string().optional(),
});

export const routingHealthStatusSchema = z.object({
  ok: z.boolean(),
  reason: z.string().min(1).optional(),
  backend: z.string().min(1).optional(),
});

// ── Types ────────────────────────────────────────────────────────────────────

export type TravelMode = z.infer<typeof travelModeSchema>;
export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type RouteResult = z.infer<typeof routeResultSchema>;
export type RoutingHealthStatus = z.infer<typeof routingHealthStatusSchema>;

export type RoutingErrorCode =
  | "invalid_input"
  | "dependency_failed"
  | "transient"
  | "unavailable";

export type RoutingError<TCode extends RoutingErrorCode = RoutingErrorCode> = {
  code: TCode;
  message: string;
};

export function createRoutingError<TCode extends RoutingErrorCode>(
  code: TCode,
  message: string,
): RoutingError<TCode> {
  return { code, message } as const;
}

export function isRoutingError(error: unknown): error is RoutingError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

// ── Port interface ───────────────────────────────────────────────────────────

/**
 * Routing port — computes travel time/distance between two points.
 *
 * The primary implementation targets a self-hosted Valhalla instance, but the
 * interface is engine-agnostic so a Mapbox/OSRM/GraphHopper adapter could be
 * swapped in without touching any use case code.
 */
export interface RoutingPort {
  /**
   * Compute travel time and distance from origin to destination.
   *
   * Returns `null` when the routing service is unavailable — callers must
   * handle the absence gracefully (e.g. hide the "X min away" badge rather
   * than hard-failing the page).
   */
  getRoute(request: RouteRequest): Promise<RouteResult | null>;

  /** Readiness probe for the routing backend. */
  health(): Promise<RoutingHealthStatus>;
}

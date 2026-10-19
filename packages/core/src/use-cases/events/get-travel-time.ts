import { z } from "zod";

import { geoCoordinateSchema } from "@th/ports/geo";
import type { LoggerPort } from "@th/ports/logger";
import type { RoutingPort, TravelMode } from "@th/ports/routing.port";
import { travelModeSchema } from "@th/ports/routing.port";

import { parseInput } from "../../lib/io";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const getTravelTimeInputSchema = z
  .object({
    origin: geoCoordinateSchema,
    destination: geoCoordinateSchema,
    mode: travelModeSchema.optional().default("auto"),
  })
  .strict();

export const getTravelTimeOutputSchema = z
  .object({
    available: z.boolean(),
    timeSeconds: z.number().nonnegative().nullable(),
    distanceMeters: z.number().nonnegative().nullable(),
    mode: travelModeSchema,
  })
  .strict();

export type GetTravelTimeInput = z.infer<typeof getTravelTimeInputSchema>;
export type GetTravelTimeOutput = z.infer<typeof getTravelTimeOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type GetTravelTimeDeps = {
  routing?: RoutingPort | null;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Compute travel time from a user's location to a destination (e.g. event venue).
 *
 * Returns `{ available: false }` when the routing service is not configured or
 * unreachable, so callers can degrade gracefully (hide the "X min away" badge).
 */
export async function getTravelTime(
  deps: GetTravelTimeDeps,
  rawInput: unknown,
): Promise<GetTravelTimeOutput> {
  const input = parseInput(getTravelTimeInputSchema, rawInput);

  if (!deps.routing) {
    return {
      available: false,
      timeSeconds: null,
      distanceMeters: null,
      mode: input.mode,
    };
  }

  const result = await deps.routing.getRoute({
    origin: input.origin,
    destination: input.destination,
    mode: input.mode,
  });

  if (!result) {
    deps.logger?.warn("travel_time_unavailable", {
      origin: input.origin,
      destination: input.destination,
      mode: input.mode,
    });

    return {
      available: false,
      timeSeconds: null,
      distanceMeters: null,
      mode: input.mode,
    };
  }

  return {
    available: true,
    timeSeconds: result.timeSeconds,
    distanceMeters: result.distanceMeters,
    mode: input.mode,
  };
}

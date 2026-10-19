import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";

import { describeError, parseInput } from "../../lib/io";

/**
 * Resolve coordinates to an IANA timezone (venue-hierarchy FR-004).
 *
 * The read-only sibling of the derivations already baked into `upsertPlace`
 * (`Place.timezone`) and the event save chain (`SavedLocation.timezone`). It
 * exists so the event editor can adopt the ADDRESS's zone the moment an
 * organiser picks a freeform address, the same way it already adopts
 * `Place.timezone` on venue-select — instead of leaving the field on the
 * organiser's browser zone and shipping a New York show on Nashville time.
 *
 * It reads nothing and writes nothing: the port is a local pure-JS lookup over
 * packed timezone-boundary data, so this is a pass-through, not a second
 * source of truth. Whatever the client does with the answer, the SERVER
 * re-derives and stores its own on save — this procedure can only ever inform
 * the UI, never be trusted as the stored value.
 */
export const resolveTimezoneInputSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();

export const resolveTimezoneOutputSchema = z
  .object({
    /**
     * IANA identifier, or `null` for "unknown" — an ocean point, a gap in the
     * boundary data, or a lookup that failed. Callers keep their current zone
     * rather than guessing; this never invents a fallback.
     */
    timezone: z.string().nullable(),
  })
  .strict();

export type ResolveTimezoneInput = z.infer<typeof resolveTimezoneInputSchema>;
export type ResolveTimezoneOutput = z.infer<typeof resolveTimezoneOutputSchema>;

export type ResolveTimezoneDeps = {
  timezoneLookup?: TimezoneLookupPort | null;
  logger?: LoggerPort;
  /** Reports the deliberate swallow below (repo Sentry convention). */
  reportError?: ReporterPort;
};

export async function resolveTimezone(
  deps: ResolveTimezoneDeps,
  rawInput: unknown,
): Promise<ResolveTimezoneOutput> {
  const input = parseInput(resolveTimezoneInputSchema, rawInput);

  if (!deps.timezoneLookup) {
    return { timezone: null };
  }

  try {
    return { timezone: deps.timezoneLookup(input.lat, input.lng) };
  } catch (error) {
    // `tz-lookup` throws on out-of-range coordinates rather than returning a
    // fallback. Degrading to "unknown" is correct — the caller keeps its
    // current zone — but it is a swallow, so it gets reported, with the
    // reporter itself guarded.
    try {
      deps.reportError?.(error, {
        tags: { useCase: "resolveTimezone", stage: "timezone_lookup" },
        extra: { lat: input.lat, lng: input.lng },
      });
    } catch {
      // Reporting is best-effort and must never turn a degraded answer into a
      // failed request.
    }
    deps.logger?.error("timezone_lookup_failed", {
      lat: input.lat,
      lng: input.lng,
      error: describeError(error),
    });
    return { timezone: null };
  }
}

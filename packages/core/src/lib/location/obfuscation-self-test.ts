import type { ReporterPort } from "@th/ports/reporter";

/**
 * BOOT SELF-TEST for the location obfuscation key.
 *
 * The key is module state (`obfuscation-key.ts`). If a composition root
 * configures one COPY of that module while the adapters/use cases read
 * another — a second resolution of `@th/core` (a dist copy, a bundler
 * duplicate, a different realpath) — the copy the read paths use is keyless,
 * and every obscured location silently renders fully hidden. That fails
 * closed, but it is a silent, total outage of every map circle, and nothing
 * else would say so.
 *
 * So each root, right after `configureLocationObfuscation`, draws a canary
 * circle through the SAME import specifiers the read paths use and checks it
 * came back. Production THROWS (refuse to boot); elsewhere it logs an error
 * and reports, so a dev without the secret can still run the stack.
 */

/** One canary: a label for the report and a draw that must return a point. */
export interface LocationObfuscationCanary {
  /** Where the draw comes from, e.g. "@th/core/lib/location/redact-place-location". */
  source: string;
  draw: () => { lat: number; lng: number } | null;
}

interface SelfTestLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  /** Optional: the PASS line (`location_obfuscation.self_test_passed`). */
  info?(message: string, meta?: Record<string, unknown>): void;
}

export interface VerifyLocationObfuscationOptions {
  canaries: readonly LocationObfuscationCanary[];
  /** True in production: a failed canary throws instead of logging. */
  failHard: boolean;
  logger?: SelfTestLogger | null;
  reportError?: ReporterPort | null;
}

export class LocationObfuscationSelfTestError extends Error {
  readonly failed: readonly string[];
  constructor(failed: readonly string[]) {
    super(
      `location_obfuscation_self_test_failed: no circle from [${failed.join(", ")}] — ` +
        "the obfuscation key is missing, or the read paths load a different copy " +
        "of @th/core/lib/location than the one the root configured",
    );
    this.name = "LocationObfuscationSelfTestError";
    this.failed = failed;
  }
}

/**
 * Draw every canary; return which failed. Throws
 * {@link LocationObfuscationSelfTestError} when `failHard` and any failed.
 * Otherwise reports (guarded — a throwing logger or reporter never changes
 * the outcome).
 */
export function verifyLocationObfuscationLive(
  options: VerifyLocationObfuscationOptions,
): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const canary of options.canaries) {
    let point: { lat: number; lng: number } | null = null;
    try {
      point = canary.draw();
    } catch {
      point = null;
    }
    if (
      !point ||
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng)
    ) {
      failed.push(canary.source);
    }
  }
  if (failed.length === 0) {
    // Say so: a boot log that is silent on success cannot be told apart from
    // a boot that never ran the check.
    try {
      options.logger?.info?.("location_obfuscation.self_test_passed", {
        canaries: options.canaries.map((canary) => canary.source),
      });
    } catch {
      // Best-effort — a throwing logger never changes behaviour.
    }
    return { ok: true, failed };
  }

  const error = new LocationObfuscationSelfTestError(failed);
  if (options.failHard) throw error;
  try {
    options.logger?.error("location_obfuscation.self_test_failed", {
      failed,
      effect: "every obscured location renders fully hidden (no circle)",
    });
  } catch {
    // Best-effort — a throwing logger never changes behaviour.
  }
  try {
    options.reportError?.(error, {
      tags: { module: "location-obfuscation", check: "boot_self_test" },
      extra: { failed },
    });
  } catch {
    // Best-effort — a throwing reporter never changes behaviour.
  }
  return { ok: false, failed };
}

/**
 * The synthetic subject every canary draws: an OBSCURED event with an owner
 * and a point, at a ladder radius. Nothing real — the point is (0, 0).
 */
export const LOCATION_OBFUSCATION_CANARY_EVENT = Object.freeze({
  id: "00000000-0000-4000-8000-00000000ca11",
  orgId: "00000000-0000-4000-8000-00000000ca12",
  // Ungated, explicitly: the projector fails a missing gate CLOSED (label
  // only, no circle), which would read as "no key" and fail the canary.
  gateType: "NONE" as const,
  locationMode: "OBSCURED" as const,
  locationRadiusMeters: 500,
  lat: 0,
  lng: 0,
  locality: null,
  region: null,
});

/** The synthetic withheld PLACE every canary draws (same point). */
export const LOCATION_OBFUSCATION_CANARY_PLACE = Object.freeze({
  id: "00000000-0000-4000-8000-00000000ca13",
  locationMode: "OBSCURED" as const,
  locationRadiusMeters: 500,
  lat: 0,
  lng: 0,
});

/** A projection's point as a canary result (null when it drew no circle). */
export function canaryPoint(location: {
  lat: number | null;
  lng: number | null;
}): { lat: number; lng: number } | null {
  return location.lat !== null && location.lng !== null
    ? { lat: location.lat, lng: location.lng }
    : null;
}

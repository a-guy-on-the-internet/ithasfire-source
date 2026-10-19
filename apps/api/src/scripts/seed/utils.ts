import type { IdempotencyPort } from "@th/ports/idempotency";

// ── Concurrency helper ───────────────────────────────────────────────────
/** Promise.all with a concurrency cap to avoid overwhelming the DB pool. */
export async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Generate a URL-safe slug from a name.
 * - Lowercases
 * - Replaces spaces and special chars with hyphens
 * - Removes consecutive hyphens
 * - Trims leading/trailing hyphens
 */
export const slugify = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

// ── Coordinates ──────────────────────────────────────────────────────────

export type LatLng = { lat: number; lng: number };

// Deterministic city centers so `nearbyEvents` returns something even without a geocoder.
export const REGION_CENTERS: Record<string, LatLng> = {
  // San Francisco
  "ca-sf": { lat: 37.7749, lng: -122.4194 },
  // Oakland
  "ca-oak": { lat: 37.8044, lng: -122.2712 },
  // New York City
  "ny-nyc": { lat: 40.7128, lng: -74.006 },
  // Austin
  "tx-aus": { lat: 30.2672, lng: -97.7431 },
  // Chicago
  "il-chi": { lat: 41.8781, lng: -87.6298 },
  // Nashville
  "tn-nsh": { lat: 36.1627, lng: -86.7816 },
};

export const DEFAULT_REGION_CODE = (
  process.env.THC_EVENTS_DEFAULT_REGION_CODE ?? "ca-sf"
)
  .trim()
  .toLowerCase();

export function seededCoordsForFixture(
  regionCode: string,
  slug: string,
): LatLng {
  const base = REGION_CENTERS[regionCode] ??
    REGION_CENTERS[DEFAULT_REGION_CODE] ?? { lat: 37.7749, lng: -122.4194 };

  // Small deterministic jitter so events aren't all identical, but remain near their region center.
  // (~0.02deg is ~1-2km depending on latitude.)
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const jitterLat = ((hash % 2000) - 1000) / 100000; // [-0.01, 0.01]
  const jitterLng = ((((hash / 2000) | 0) % 2000) - 1000) / 100000;

  return {
    lat: Math.max(-90, Math.min(90, base.lat + jitterLat)),
    lng: Math.max(-180, Math.min(180, base.lng + jitterLng)),
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────

const dayInMs = 24 * 60 * 60 * 1000;

export const buildStartDate = (daysFromNow: number, hour = 19): Date => {
  const base = new Date(Date.now() + daysFromNow * dayInMs);
  base.setMinutes(0, 0, 0);
  base.setHours(hour, 0, 0, 0);
  return base;
};

/**
 * IANA zone for a seed region code (`<state>-<city>`, e.g. `ca-sf`). Keyed by
 * the two-letter state prefix so a new city in a known state needs no entry.
 * Unknown states throw: a silent Chicago default is the bug this replaces.
 */
const STATE_TIMEZONES: Record<string, string> = {
  ca: "America/Los_Angeles",
  wa: "America/Los_Angeles",
  or: "America/Los_Angeles",
  co: "America/Denver",
  az: "America/Phoenix",
  ny: "America/New_York",
  ma: "America/New_York",
  dc: "America/New_York",
  tx: "America/Chicago",
  il: "America/Chicago",
  mn: "America/Chicago",
  tn: "America/Chicago",
};

export const timezoneForRegionCode = (regionCode: string): string => {
  const state = regionCode.split("-")[0]?.toLowerCase() ?? "";
  const zone = STATE_TIMEZONES[state];
  if (!zone) {
    throw new Error(
      `No seed timezone for region "${regionCode}"; add its state to STATE_TIMEZONES in seed/utils.ts`,
    );
  }
  return zone;
};

/** Offset (ms, east positive) of `zone` from UTC at the instant `at`. */
const zoneOffsetMs = (zone: string, at: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const n = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    n("second"),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
};

/**
 * Like `buildStartDate`, but the calendar day and the wall-clock `hour` are
 * read in `zone`, so "7 PM" is 7 PM at the event, not on the seeding machine.
 */
export const buildStartDateInZone = (
  daysFromNow: number,
  hour: number | undefined,
  zone: string,
  now: number = Date.now(),
): Date => {
  const wallHour = hour ?? 19;
  // Calendar date at `now` in the zone, then add whole days to that date, so
  // a DST change between now and the target never shifts the day.
  const local = new Date(now + zoneOffsetMs(zone, now));
  const guess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + daysFromNow,
    wallHour,
  );
  // Try the offsets in force a day either side; keep one that reproduces the
  // wall time. A nonexistent wall time (spring-forward gap) matches neither
  // and resolves forward with the pre-gap offset (02:00 becomes 03:00).
  const before = zoneOffsetMs(zone, guess - dayInMs);
  const after = zoneOffsetMs(zone, guess + dayInMs);
  const valid = [before, after]
    .map((offset) => guess - offset)
    .filter((instant) => zoneOffsetMs(zone, instant) === guess - instant);
  const instant = valid.length ? Math.min(...valid) : guess - before;
  return new Date(instant);
};

// ── Idempotency ──────────────────────────────────────────────────────────

export function createInMemoryIdempotency(): IdempotencyPort {
  type Stored = { payloadHash: string; response: unknown };
  const store = new Map<string, Stored>();
  const locks = new Map<string, number>();
  const tokens = new Map<string, string>();

  return {
    begin: async (key: string, ttlSec = 60, ownerToken?: string) => {
      const now = Date.now();
      const lockUntil = locks.get(key);
      if (lockUntil && lockUntil > now) return false;
      locks.set(key, now + ttlSec * 1000);
      if (ownerToken !== undefined) tokens.set(key, ownerToken);
      else tokens.delete(key);
      return true;
    },
    commit: async (key: string, record: any, keepSec = 60) => {
      store.set(key, record as Stored);
      locks.set(key, Date.now() + keepSec * 1000);
      tokens.delete(key);
    },
    fail: async (key: string) => {
      locks.delete(key);
      tokens.delete(key);
    },
    // Owner-checked release (IdempotencyPort contract): frees the key only
    // for the holder whose begin() stored this token; otherwise touches
    // nothing. Seed flows don't hold refund mutexes, but the port requires
    // honest semantics rather than a stub that lies.
    release: async (key: string, ownerToken: string) => {
      if (tokens.get(key) !== ownerToken) return false;
      tokens.delete(key);
      locks.delete(key);
      return true;
    },
    get: async <T>(key: string) =>
      (store.get(key) ?? null) as unknown as T | null,
    run: async () => {
      throw new Error("idempotency.run not implemented for seed");
    },
    // The seed process is short-lived and this store dies with it, so there is
    // no retention to reclaim. Implemented rather than thrown so a seed run can
    // never fail on a housekeeping call it does not need.
    purgeExpired: async () => 0,
  };
}

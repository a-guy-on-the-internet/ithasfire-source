import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { EventStatus } from "@th/types";

import { describeError, parseInput } from "../../lib/io";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  projectEventLocationAtPlace,
  projectPlaceLocationForEvents,
} from "../../lib/location/place-event-location";
import {
  placeWithholdsAddress,
  redactPlaceLocation,
} from "../../lib/location/redact-place-location";
import { runReindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";

/**
 * RE-PROJECT the stored location of every event at every withheld venue.
 *
 * An event at a venue that withholds its address STORES the venue's public
 * projection — including the venue's circle centre (`place-event-location`,
 * D1). That centre is a keyed draw, so anything that moves it leaves the
 * stored rows stale:
 *
 *   · rotating `UNSUBSCRIBE_SECRET` (the obfuscation key's root);
 *   · a change to the circle geometry itself (the radius ladder + nested
 *     sampling moved every circle once).
 *
 * A stale row is not a leak of the true point — it is the OLD public centre —
 * but it IS a second, independent sample of the house next to the new one,
 * and it disagrees with the venue page. This runs part 1 of the upsertPlace
 * cascade (`projectPlaceLocationForEvents` → `reprojectLocationForPlace`, under
 * the same exclusive place-location lock) for each venue whose rows differ
 * from what the projection says NOW, then re-indexes those events and the
 * venue.
 *
 * IDEMPOTENT: a venue whose rows already match is not written at all — a
 * second run reports every venue `up_to_date` and touches nothing.
 * DRY RUN (the default) reads and reports, never writes.
 *
 * Freeform (place-less) events store their own true point and draw their
 * circle at read time; they need no re-projection, only the full search
 * reindex the rotation runbook ends with.
 */

const EVERY_STATUS: EventStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
];
const ALL_TIME = {
  from: new Date(0),
  to: new Date("9999-12-31T23:59:59.999Z"),
};
/** Single-entity index passes in flight at once (same pacing as upsertPlace). */
const REINDEX_CONCURRENCY = 4;

export const reprojectWithheldPlaceLocationsInputSchema = z
  .object({
    placeIds: z.array(z.uuid()).max(100_000),
    /** Report only. Defaults to TRUE: writing is always explicit. */
    dryRun: z.boolean().default(true),
  })
  .strict();

export type ReprojectWithheldPlaceLocationsInput = z.input<
  typeof reprojectWithheldPlaceLocationsInputSchema
>;

type Point = { lat: number; lng: number };

export interface ReprojectedPlaceReport {
  placeId: string;
  outcome:
    | "missing"
    | "not_withheld"
    | "up_to_date"
    | "would_reproject"
    | "reprojected";
  /** Event rows at the venue (every status). */
  eventCount: number;
  /** Rows whose stored location differs from the projection now. */
  staleEventIds: string[];
  /** The venue's public centre NOW (null when fully hidden / no key). */
  publicCentre: Point | null;
  /** Distinct centres the stale rows stored BEFORE (the old public centre). */
  staleCentres: Point[];
  /** Ids the UPDATE rewrote (write mode only). */
  reprojectedEventIds: string[];
}

export interface ReprojectWithheldPlaceLocationsOutput {
  dryRun: boolean;
  places: ReprojectedPlaceReport[];
  totals: {
    places: number;
    withheld: number;
    stalePlaces: number;
    staleEvents: number;
    reprojectedEvents: number;
    reindexFailures: number;
  };
}

export type ReprojectWithheldPlaceLocationsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Absent → rows are re-projected but nothing is re-indexed. */
  search?: MultiSearchPort;
  reportError?: ReporterPort;
};

function sameNumber(a: number | null | undefined, b: number | null | undefined) {
  return (a ?? null) === (b ?? null);
}

/**
 * Coordinates are compared within 1e-9° (~0.1 mm), not bit for bit: a
 * double does not always survive the trip into a float8 column and back in
 * its last digit, and a row that differs only there is not stale — treating
 * it as stale would rewrite (and re-index) it on every run.
 */
const COORDINATE_EPSILON_DEGREES = 1e-9;
function sameCoordinate(
  a: number | null | undefined,
  b: number | null | undefined,
) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) <= COORDINATE_EPSILON_DEGREES;
}
function sameText(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? null) === (b ?? null);
}

/**
 * Whether `event`, stored at withheld `place`, differs from what the cascade
 * would write for it now. The event's CURRENT privacy is its request — the
 * same reading `reprojectLocationForPlace`'s SQL floor takes — so an
 * up-to-date row is a fixed point.
 */
export function eventLocationIsStale(
  place: PlaceRecord,
  event: EventRecord,
): boolean {
  const expected = projectEventLocationAtPlace(place, {
    locationMode: event.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
    locationRadiusMeters: event.locationRadiusMeters ?? null,
  });
  if (!expected.withheld) return false;
  const c = expected.columns;
  return !(
    event.locationMode === expected.privacy.locationMode &&
    sameNumber(event.locationRadiusMeters, expected.privacy.locationRadiusMeters) &&
    sameCoordinate(event.lat, c.lat) &&
    sameCoordinate(event.lng, c.lng) &&
    sameText(event.addressText, c.addressText) &&
    sameText(event.locality, c.locality) &&
    sameText(event.region, c.region) &&
    sameText(event.countryCode, c.countryCode) &&
    sameText(event.postalCode, c.postalCode)
  );
}

export async function reprojectWithheldPlaceLocations(
  deps: ReprojectWithheldPlaceLocationsDeps,
  rawInput: unknown,
): Promise<ReprojectWithheldPlaceLocationsOutput> {
  const input = parseInput(reprojectWithheldPlaceLocationsInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "reprojectWithheldPlaceLocations" });
  const places: ReprojectedPlaceReport[] = [];
  let reindexFailures = 0;

  for (const placeId of [...new Set(input.placeIds)]) {
    const report: ReprojectedPlaceReport = {
      placeId,
      outcome: "missing",
      eventCount: 0,
      staleEventIds: [],
      publicCentre: null,
      staleCentres: [],
      reprojectedEventIds: [],
    };
    places.push(report);

    const place = await deps.repos.places.getById(placeId);
    if (!place) continue;
    if (!placeWithholdsAddress(place)) {
      report.outcome = "not_withheld";
      continue;
    }

    const venue = redactPlaceLocation(place);
    report.publicCentre =
      venue.lat !== null && venue.lng !== null
        ? { lat: venue.lat, lng: venue.lng }
        : null;

    const events = await deps.repos.events.listAllByPlace({
      placeId,
      ...ALL_TIME,
      statuses: EVERY_STATUS,
    });
    report.eventCount = events.length;
    const stale = events.filter((event) => eventLocationIsStale(place, event));
    report.staleEventIds = stale.map((event) => event.id);
    const seen = new Set<string>();
    for (const event of stale) {
      if (typeof event.lat !== "number" || typeof event.lng !== "number") continue;
      const key = `${event.lat},${event.lng}`;
      if (seen.has(key)) continue;
      seen.add(key);
      report.staleCentres.push({ lat: event.lat, lng: event.lng });
    }

    if (stale.length === 0) {
      report.outcome = "up_to_date";
      continue;
    }
    if (input.dryRun) {
      report.outcome = "would_reproject";
      continue;
    }

    // The upsertPlace cascade, verbatim in shape: exclusive lock BEFORE the
    // re-read, so no event save at this venue can straddle the rewrite.
    const now = deps.clock.now();
    const written = await deps.repos.tx(async (tx) => {
      await tx.events.lockLocationsAtPlace({ placeId, mode: "exclusive" });
      const current = await tx.places.getById(placeId);
      if (!current || !placeWithholdsAddress(current)) return null;
      const projection = projectPlaceLocationForEvents(current);
      const ids = await tx.events.reprojectLocationForPlace({
        placeId,
        projection,
        now,
        defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
      });
      await tx.audit.log({
        entity: "place",
        entityId: placeId,
        action: "place.event_locations_reprojected",
        data: {
          reason: "obfuscation_reprojection",
          actor: "ops:reproject-withheld-locations",
          toLocationMode: current.locationMode,
          toRadiusMeters: current.locationRadiusMeters ?? null,
          projection: projection.kind,
          eventCount: ids.length,
        },
        at: now,
      });
      // Durable marks: the paced reindex below clears them; whatever it
      // cannot refresh stays for the drain / nightly full reindex.
      await markForSearchReindex(
        tx,
        [
          { kind: "place", id: placeId },
          ...ids.map((id) => ({ kind: "event" as const, id })),
        ],
        now,
      );
      return ids;
    });
    if (written === null) {
      // Un-withheld (or deleted) between the read and the lock: its own
      // cascade already restored the rows.
      report.outcome = "not_withheld";
      continue;
    }
    report.outcome = "reprojected";
    report.reprojectedEventIds = written;
    reindexFailures += await reindexPaced(deps, placeId, written);
  }

  const withheld = places.filter(
    (p) => p.outcome !== "missing" && p.outcome !== "not_withheld",
  );
  const output: ReprojectWithheldPlaceLocationsOutput = {
    dryRun: input.dryRun,
    places,
    totals: {
      places: places.length,
      withheld: withheld.length,
      stalePlaces: withheld.filter((p) => p.staleEventIds.length > 0).length,
      staleEvents: withheld.reduce((n, p) => n + p.staleEventIds.length, 0),
      reprojectedEvents: places.reduce(
        (n, p) => n + p.reprojectedEventIds.length,
        0,
      ),
      reindexFailures,
    },
  };
  logger?.info("places.reproject_withheld_locations", output.totals);
  return output;
}

/**
 * Re-index the rewritten events and the venue, paced. Returns the number of
 * entities whose reindex REJECTED (per-id failures inside `buildSearchIndex`
 * are reported by `runReindexAfterMutation` itself). Never throws.
 */
async function reindexPaced(
  deps: ReprojectWithheldPlaceLocationsDeps,
  placeId: string,
  eventIds: string[],
): Promise<number> {
  if (!deps.search) return 0;
  const reindexDeps = {
    repos: deps.repos,
    search: deps.search,
    clock: deps.clock,
    logger: deps.logger,
    reportError: deps.reportError,
  };
  const selectors = [
    ...eventIds.map((id) => ({ kind: "event" as const, id })),
    { kind: "place" as const, id: placeId },
  ];
  let failures = 0;
  for (let i = 0; i < selectors.length; i += REINDEX_CONCURRENCY) {
    const settled = await Promise.allSettled(
      selectors
        .slice(i, i + REINDEX_CONCURRENCY)
        .map((selector) =>
          runReindexAfterMutation(
            reindexDeps,
            "reprojectWithheldPlaceLocations",
            selector,
          ),
        ),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        failures += 1;
        // Deliberate swallow (the rows are already right; the nightly full
        // reindex reconciles the index) — logged AND reported.
        try {
          deps.logger?.error("places.reproject_withheld_locations.reindex_failed", {
            placeId,
            error: describeError(outcome.reason),
          });
        } catch {
          // Best-effort.
        }
        try {
          deps.reportError?.(outcome.reason, {
            tags: {
              useCase: "reprojectWithheldPlaceLocations",
              op: "reindex",
            },
            extra: { placeId },
          });
        } catch {
          // A throwing reporter never changes behaviour.
        }
      }
    }
  }
  return failures;
}

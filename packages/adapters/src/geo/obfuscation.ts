import { Prisma } from "@prisma/client";
import {
  MAX_OBFUSCATION_RADIUS_METERS as MAX_LADDER_RADIUS_METERS,
  OBFUSCATION_RADIUS_LADDER_METERS,
} from "@th/core/lib/location/obfuscation-radius-ladder";
import {
  LOCATION_OBFUSCATION_CANARY_EVENT,
  canaryPoint,
} from "@th/core/lib/location/obfuscation-self-test";
import { projectPublicEventLocation } from "@th/core/lib/location/project-public-event-location";

/**
 * Shared anti-triangulation constants for the geo adapters (FR-013/NFR-001).
 *
 * INVARIANT: for non-EXACT events, inclusion in nearby/box results, emitted
 * distance, ordering, totals, and page composition must ALL be functions of
 * the EMITTED (obfuscated) coordinate only — never the true coordinate.
 * Deciding inclusion from the true pin turns any public geo endpoint into a
 * presence oracle: probe with a tiny radius on a grid and the event appears
 * iff the true pin is inside the probe, recovering a house-show's address in
 * a few dozen anonymous requests.
 *
 * The adapters therefore run a two-phase query:
 *   1. SQL/Prisma candidate fetch, WIDENED per-row (or by the max radius
 *      below) so every event whose EMITTED point could satisfy the query is
 *      fetched — `obfuscateCoordinate` keeps the emitted point within
 *      0.99 × the DRAWN radius (the stored `locationRadiusMeters` snapped UP
 *      to the ladder — `snappedObfuscationRadiusSql`) of the true point (for
 *      an event at a withheld venue: the VENUE's drawn radius of the VENUE's
 *      true point).
 *   2. JS post-filter/order/paginate against the emitted coordinate.
 */

/**
 * Upper bound of any drawn obfuscation radius — the top rung of the core
 * ladder (`@th/core/lib/location/obfuscation-radius-ladder`), which is also
 * the Zod bound every write validates against. Used to widen candidate
 * fetches where a per-row margin can't be expressed (Prisma bbox prefetch,
 * envelope expansion). A stored value above it draws no circle at all.
 */
export const MAX_OBFUSCATION_RADIUS_METERS = MAX_LADDER_RADIUS_METERS;

/**
 * Same planar conversion used by `obfuscateCoordinate` in
 * packages/core/src/lib/location/redact-location.ts — keeping the constant
 * identical makes degree-based candidate widening a tight, complete bound on
 * the emitted-point offset.
 */
export const METERS_PER_DEGREE_LAT = 111_320;

/**
 * SQL for the radius a stored `column` is DRAWN at: the smallest ladder rung
 * ≥ the stored value — `snapObfuscationRadiusUp` in SQL. NULL for a NULL
 * column or a value above the top rung (no circle), so a predicate that adds
 * it fails closed.
 *
 * Per-row candidate widening MUST use this, not the raw column: a legacy
 * off-ladder value (say 120 m) is drawn at the next rung (150 m), and its
 * emitted point can sit up to 0.99 × 150 m from the true one — widening by
 * the raw 120 m would drop a row whose SHOWN point is in range, and do so
 * depending on where the true point is.
 */
export function snappedObfuscationRadiusSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT min(rung) FROM unnest(${[...OBFUSCATION_RADIUS_LADDER_METERS]}::int[]) AS rung WHERE rung >= ${column})`;
}

/**
 * Boot canary (`verifyLocationObfuscationLive`): draws the canary event's
 * circle through the ADAPTERS' own resolution of
 * `@th/core/lib/location/project-public-event-location` — the module every
 * geo read and the events repo project through. Null means that copy of the
 * core location module has no key, whatever the root configured.
 */
export function adaptersLocationObfuscationCanary(): {
  lat: number;
  lng: number;
} | null {
  return canaryPoint(
    projectPublicEventLocation(LOCATION_OBFUSCATION_CANARY_EVENT),
  );
}

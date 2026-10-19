/**
 * THE allowed obfuscation radii — the one list every public circle is drawn
 * at, every write snaps to, and the web precision sliders offer.
 *
 * WHY A LADDER. A circle's centre is a keyed draw per (subject, radius). When
 * the radius was any integer 100..50,000 (reachable through the API, whatever
 * the slider offered), every distinct radius an owner ever saved was another
 * independent sample of the true point — and intersecting samples narrows the
 * house down. A fixed ladder bounds the set of circles one subject can ever
 * have, and the nested sampling in `redact-location.ts` makes the whole set
 * reveal no more than its smallest rung.
 *
 * WHY SO FEW RUNGS. Nesting builds a circle's centre out of one step per rung
 * below it, and a step can be no longer than the gap to the previous rung
 * (or the circle would stop containing the house). So the spread of a
 * centre around the house is bounded by the gaps: 39 fine rungs (the first
 * ladder) left a "5 km" centre within 1.6 km of the house 95 % of the time.
 * Nine rungs, roughly doubling, keep the RMS offset at ~0.6 × the drawn
 * radius (measured in `obfuscation-nesting.test.ts`), so the circle a viewer
 * sees is close to an honest statement of how well the house is hidden.
 *
 * WHERE IT IS ENFORCED.
 *   WRITE — `upsertPlace` and the event save (`save-event-shared.ts`) snap an
 *     accepted radius UP to the next rung before it is stored.
 *   READ  — every projection snaps a stored value that is not on the ladder
 *     (rows written before the ladder) UP to the next rung before drawing, and
 *     emits the snapped radius. Never down: a smaller circle is a promise the
 *     owner did not make.
 *
 * Browser-safe on purpose (no node imports): the web's radius slider imports
 * this list rather than keeping a copy that could drift.
 */

/** Allowed obfuscation radii (metres), strictly ascending. */
export const OBFUSCATION_RADIUS_LADDER_METERS: readonly number[] = Object.freeze([
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
]);

/** The smallest rung — the lower bound every write validates against. */
export const MIN_OBFUSCATION_RADIUS_METERS = 100;
/** The largest rung — the upper bound every write validates against. */
export const MAX_OBFUSCATION_RADIUS_METERS = 50_000;

/**
 * The smallest rung ≥ `radius` — the radius a circle is actually drawn at.
 *
 * NULL (callers render the location fully hidden) for a missing, non-finite
 * or non-positive value, and for anything ABOVE the top rung: no rung
 * contains it without shrinking the circle the owner asked for.
 */
export function snapObfuscationRadiusUp(
  radius: number | null | undefined,
): number | null {
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  for (const rung of OBFUSCATION_RADIUS_LADDER_METERS) {
    if (rung >= radius) return rung;
  }
  return null;
}

/**
 * Write-path snap for a radius a schema has ALREADY bounded to
 * [MIN, MAX]. Throws on anything the bound should have rejected rather than
 * inventing a rung.
 */
export function snapValidatedObfuscationRadius(radius: number): number {
  const snapped = snapObfuscationRadiusUp(radius);
  if (snapped === null) {
    throw new RangeError(
      `obfuscation radius ${radius} is outside ${MIN_OBFUSCATION_RADIUS_METERS}..${MAX_OBFUSCATION_RADIUS_METERS}`,
    );
  }
  return snapped;
}

/** Whether `radius` is exactly a rung. */
export function isObfuscationLadderRadius(radius: number): boolean {
  return OBFUSCATION_RADIUS_LADDER_METERS.includes(radius);
}

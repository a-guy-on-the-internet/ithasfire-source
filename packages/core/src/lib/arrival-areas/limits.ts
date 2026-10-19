/**
 * Arrival-area limits (arrival-areas spec FR-001 / FR-005, owner rulings R2
 * Q6 and R3 Q6, 2026-10-16). Core enforces every one of them; the editor
 * mirrors them for its messages.
 */

/** Areas per place, disabled included (the limit counts rows). */
export const MAX_ARRIVAL_AREAS_PER_PLACE = 10;

/** Event-only areas per event, disabled included. */
export const MAX_ARRIVAL_AREAS_PER_EVENT = 10;

/**
 * Positions per shape, counted AS STORED: a polygon's ring includes its
 * closing position (the repeat of the first), so a polygon carries at most
 * 199 distinct corners plus the closing point; a line carries 200 points.
 */
export const MAX_ARRIVAL_AREA_POINTS = 200;

/** Every position lies within this many metres of the place or event pin. */
export const MAX_ARRIVAL_AREA_DISTANCE_METERS = 3_000;

/** Label length (required, trimmed). */
export const ARRIVAL_AREA_LABEL_MAX = 80;

/** Optional price text length. */
export const ARRIVAL_AREA_PRICE_TEXT_MAX = 40;

/** Optional note length. */
export const ARRIVAL_AREA_NOTE_MAX = 280;

/**
 * A polygon smaller than this on the ground (m²) is refused (`TOO_THIN`):
 * nobody parks in it, and degenerate shapes are what make the Directions
 * point search slow.
 */
export const MIN_ARRIVAL_AREA_POLYGON_AREA_M2 = 1;

/**
 * A polygon whose mean width, `2 × area / perimeter` (metres), is under this
 * is refused (`TOO_THIN`): a sliver. A 100 m × 2 m strip of parallel parking
 * has a mean width of about 1.96 m; the reproduced 2 km × 1 cm sliver about
 * 0.005 m.
 */
export const MIN_ARRIVAL_AREA_POLYGON_MEAN_WIDTH_M = 0.5;

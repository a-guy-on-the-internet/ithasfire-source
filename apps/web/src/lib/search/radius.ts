import { KM_TO_MI } from "@/hooks/useImperial";

// ---------------------------------------------------------------------------
// Distance-radius constants and helpers — the single source of truth shared by
// every distance-radius control so they can never drift:
//   - the Spotlight overlay search (SpotlightSearch)
//   - the full search filter (UniversalSearchPage)
//   - the "/lucky" Surprise Me page (SurpriseMe)
//
// CANONICAL UNIT IS KILOMETRES. Each surface stores its radius state, the URL
// param, the query/geoFilter, and the getRandomEvent input in km. The SLIDER
// WIDGET, however, presents unit-appropriate stops: metric users get a 5→500 km
// track (5 km steps); imperial users get a 5→300 mi track (5 mi steps) so the
// thumb lands on ROUND miles. The `kmToSliderValue` / `sliderValueToKm` pair
// converts between the canonical km state and the widget's unit domain, and
// `normalizeRadiusForUnit` snaps the km value onto the active unit's grid when
// the unit flips. Nothing downstream of the widget ever sees miles.
//
// One sentinel stop past each track's max means "Worldwide" (drop the distance
// filter). There is no "nationwide" concept: it's meaningless without knowing
// the user's country, so the max real distance is simply 500 km (~300 mi).
// ---------------------------------------------------------------------------

// ── Canonical km domain (state / URL / query / backend) ─────────────────────
export const RADIUS_MIN_KM = 5;
/** Maximum real distance the slider expresses (km). */
export const RADIUS_MAX_KM = 500;
export const RADIUS_STEP_KM = 5;
export const DEFAULT_RADIUS_KM = 50;
/** Sentinel stop one step past the max: "Worldwide" (drop the distance filter). */
export const RADIUS_WORLDWIDE_KM = RADIUS_MAX_KM + RADIUS_STEP_KM; // 505
/** Top of the metric slider track (sentinel-inclusive). */
export const SLIDER_MAX_KM = RADIUS_WORLDWIDE_KM; // 505
/** @deprecated Back-compat alias for {@link SLIDER_MAX_KM}. */
export const SLIDER_MAX = SLIDER_MAX_KM;

// ── Imperial (miles) slider domain — presentation only ──────────────────────
export const RADIUS_MIN_MI = 5;
/** 300 mi ≈ 483 km, safely under the 500 km cap. */
export const RADIUS_MAX_MI = 300;
export const RADIUS_STEP_MI = 5;
/** Sentinel stop one step past the imperial max: "Worldwide". */
export const RADIUS_WORLDWIDE_MI = RADIUS_MAX_MI + RADIUS_STEP_MI; // 305
/** Top of the imperial slider track (sentinel-inclusive). */
export const SLIDER_MAX_MI = RADIUS_WORLDWIDE_MI; // 305

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** True when the (canonical km) value is at/above the "Worldwide" sentinel. */
export const isWorldwideRadius = (radiusKm: number): boolean =>
  radiusKm >= RADIUS_WORLDWIDE_KM;

/** Minimal translate function shape (mirrors how callers use `useTranslations`). */
type Translate = (key: string) => unknown;

/**
 * Format the (canonical km) radius for display: localized "Worldwide" at the
 * sentinel, otherwise miles or kilometres per the user's unit preference.
 * Reuses the existing `search.worldwide` message key. After
 * `normalizeRadiusForUnit`, the km value already sits on the active grid, so the
 * rounded mi label reads as a clean multiple of 5.
 */
export const formatRadiusLabel = (
  radiusKm: number,
  { imperial, t }: { imperial: boolean; t: Translate },
): string => {
  if (isWorldwideRadius(radiusKm)) return String(t("search.worldwide"));
  if (imperial) return `${Math.round(radiusKm * KM_TO_MI)} mi`;
  return `${radiusKm} km`;
};

/**
 * Slider widget bounds for the active unit. `min`/`max` include the worldwide
 * sentinel at the top (`max` = sliderMax), matching how the surfaces render the
 * "Worldwide" stop as the final slider position. `sliderMax` is provided
 * separately for clarity.
 */
export const radiusSliderConfig = (
  imperial: boolean,
): { min: number; max: number; step: number; sliderMax: number } =>
  imperial
    ? {
        min: RADIUS_MIN_MI,
        max: SLIDER_MAX_MI,
        step: RADIUS_STEP_MI,
        sliderMax: SLIDER_MAX_MI,
      }
    : {
        min: RADIUS_MIN_KM,
        max: SLIDER_MAX_KM,
        step: RADIUS_STEP_KM,
        sliderMax: SLIDER_MAX_KM,
      };

/**
 * Convert canonical km state → the slider widget's value in the active unit.
 * Worldwide maps to the unit's worldwide sentinel; otherwise imperial snaps to
 * the nearest 5-mi grid stop (clamped to [5, 300] mi), and metric is the km
 * value verbatim.
 */
export const kmToSliderValue = (
  radiusKm: number,
  imperial: boolean,
): number => {
  if (isWorldwideRadius(radiusKm)) {
    return imperial ? RADIUS_WORLDWIDE_MI : RADIUS_WORLDWIDE_KM;
  }
  if (!imperial) return radiusKm;
  const miles = radiusKm * KM_TO_MI;
  const snapped = Math.round(miles / RADIUS_STEP_MI) * RADIUS_STEP_MI;
  return clamp(snapped, RADIUS_MIN_MI, RADIUS_MAX_MI);
};

/**
 * Convert a slider widget value (in the active unit) → canonical km. Worldwide
 * maps back to `RADIUS_WORLDWIDE_KM`; imperial miles are converted to km and
 * rounded to whole km; metric is already km.
 */
export const sliderValueToKm = (value: number, imperial: boolean): number => {
  if (!imperial) return value; // already km (incl. the 505 sentinel)
  if (value >= RADIUS_WORLDWIDE_MI) return RADIUS_WORLDWIDE_KM;
  return Math.round(value / KM_TO_MI);
};

/**
 * Snap a canonical km value onto the active unit's grid. Used when the unit
 * flips (async auto-detect or the manual km/mi toggle) so the visible label,
 * the slider thumb, and the queried km all agree. Worldwide is preserved.
 */
export const normalizeRadiusForUnit = (
  radiusKm: number,
  imperial: boolean,
): number => {
  if (isWorldwideRadius(radiusKm)) return RADIUS_WORLDWIDE_KM;
  return sliderValueToKm(kmToSliderValue(radiusKm, imperial), imperial);
};

/**
 * Map a (canonical km) radius to the `near.radiusKm` used by `getRandomEvent`
 * (whose schema caps `radiusKm` at 500 km — kept in lockstep with
 * `RADIUS_MAX_KM`).
 *
 * - 5–500 km → `{ radiusKm }` (constrain the roll to that distance).
 * - Worldwide (505) → `null` (omit `near` entirely, i.e. a random event from
 *   anywhere — the roll can't send a radius above the cap).
 */
export const radiusToNearFilter = (
  radiusKm: number,
): { radiusKm: number } | null => {
  if (isWorldwideRadius(radiusKm)) {
    return null;
  }
  return { radiusKm };
};

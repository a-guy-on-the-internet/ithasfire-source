/**
 * The obfuscation-radius slider shared by every surface that lets someone
 * choose how fuzzy their public location is.
 *
 * Lifted out of the event builder when PLACES gained the same three-state
 * privacy model (place-address-withholding). The venue editor and the event
 * builder now drive the same column with the same bounds.
 *
 * THE STOPS ARE THE SERVER'S LADDER, imported — not a copy. The server only
 * ever draws a circle at a ladder rung and snaps every saved radius UP to one
 * (`@th/core/lib/location/obfuscation-radius-ladder`), so a slider stop that
 * is not a rung would be a value the server silently changes.
 */
import {
  MAX_OBFUSCATION_RADIUS_METERS,
  MIN_OBFUSCATION_RADIUS_METERS,
  OBFUSCATION_RADIUS_LADDER_METERS,
  snapObfuscationRadiusUp,
} from "@th/core/lib/location/obfuscation-radius-ladder";

// ── Location-precision slider mapping ────────────────────────────────────────
//
// The editor's precision slider runs 0..HIDDEN_SLIDER_POSITION. Positions
// 0..RADIUS_SLIDER_STOPS.length-1 index an explicit table of human-friendly
// radii spanning the server's allowed obfuscation-radius range
// (100 m .. 50,000 m — see baseSaveEventInputSchema.locationRadiusMeters) on a
// roughly doubling curve — nine stops, the server's whole ladder. The far
// end-stop
// (HIDDEN_SLIDER_POSITION) is the FULLY-HIDDEN sentinel:
// `locationRadiusMeters = null` — no public map at all.
//
// Round-trip safety: the position is always derived FROM the radius state; the
// radius is only recomputed when the user drags the slider. A saved radius
// that doesn't sit exactly on a stop (legacy values) is sent back unchanged
// on an untouched edit/save cycle — and the server snaps it UP to the next
// rung (the circle it has been drawn at since the ladder landed). It displays
// at that next rung up — the circle the public actually sees.

export const MIN_RADIUS_METERS = MIN_OBFUSCATION_RADIUS_METERS;
export const MAX_RADIUS_METERS = MAX_OBFUSCATION_RADIUS_METERS;

/** Distinct, human-friendly obfuscation radii (meters), ascending — the server's ladder. */
export const RADIUS_SLIDER_STOPS: readonly number[] =
  OBFUSCATION_RADIUS_LADDER_METERS;

/** One past the last radius stop — the "Hidden — no public map" end-stop. */
export const HIDDEN_SLIDER_POSITION = RADIUS_SLIDER_STOPS.length;

/** Slider position → radius in meters, or null for the Hidden end-stop. */
export const radiusForSliderPosition = (position: number): number | null => {
  if (position >= HIDDEN_SLIDER_POSITION) return null;
  const clamped = Math.min(
    RADIUS_SLIDER_STOPS.length - 1,
    Math.max(0, Math.round(position)),
  );
  return RADIUS_SLIDER_STOPS[clamped] ?? MIN_RADIUS_METERS;
};

/**
 * Radius in meters (null = hidden) → slider position: the stop the server
 * actually DRAWS it at — the next rung UP (`snapObfuscationRadiusUp`), never
 * the nearest one. A legacy 700 m radius is drawn at 1,000 m; showing it at
 * the "nearer" 500 m stop would claim more precision than the public circle
 * has. Anything above the top rung shows at the top stop.
 */
export const sliderPositionForRadius = (radius: number | null): number => {
  if (radius === null) return HIDDEN_SLIDER_POSITION;
  const rung = snapObfuscationRadiusUp(Math.max(radius, MIN_RADIUS_METERS));
  if (rung === null) return RADIUS_SLIDER_STOPS.length - 1;
  const index = RADIUS_SLIDER_STOPS.indexOf(rung);
  return index >= 0 ? index : RADIUS_SLIDER_STOPS.length - 1;
};

/**
 * The radius the public circle is DRAWN at, for display — the rung the slider
 * thumb sits on. Every preview line and `aria-valuetext` formats THIS, never
 * the stored number: a legacy 700 m row is drawn as a 1 km circle, and
 * "700 m" would tell the owner the public sees a tighter circle than it does.
 * Null (fully hidden) stays null.
 *
 * Above the top rung the server draws no circle at all; this follows the
 * slider and reports the top stop. The write path cannot produce such a row
 * (every schema bounds the radius at MAX_RADIUS_METERS), so the two only
 * disagree for data no save can create.
 */
export const drawnRadiusMeters = (radius: number | null): number | null =>
  radiusForSliderPosition(sliderPositionForRadius(radius));

// ── Radius display ───────────────────────────────────────────────────────────

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

/**
 * A ladder radius as people say it: "330 ft", "0.6 mi", "500 m", "1 km".
 *
 * Imperial reads in feet only below 1,000 ft (rounded to 10 ft — "328 ft" is
 * false precision for a deliberately fuzzy circle), then miles. Past that
 * point "3,281 ft" reads as a number, not a distance. Both systems show one
 * decimal under 10 units and none from 10 up, with a trailing ".0" dropped
 * ("1 km", not "1.0 km").
 *
 * `locale` is REQUIRED and passed to Intl explicitly: a bare
 * `toLocaleString()` formats with the server's locale during SSR and the
 * browser's after hydration, and es-ES vs en-US digits then mismatch.
 */
export function formatObfuscationRadius(
  meters: number,
  { imperial, locale }: { imperial: boolean; locale: string },
): string {
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const upToOne = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  const large = (value: number) =>
    (Math.round(value * 10) / 10 >= 10 ? whole : upToOne).format(value);

  if (imperial) {
    const feet = Math.round(meters / METERS_PER_FOOT / 10) * 10;
    if (feet < 1000) return `${whole.format(feet)} ft`;
    return `${large(meters / METERS_PER_MILE)} mi`;
  }
  if (meters < 1000) return `${whole.format(meters)} m`;
  return `${large(meters / 1000)} km`;
}

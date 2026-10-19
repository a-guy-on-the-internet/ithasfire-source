/**
 * Build deep-link URLs to popular mapping apps for turn-by-turn directions.
 */

export interface DirectionsTarget {
  latitude: number;
  longitude: number;
  /** Optional human-readable label used by some mapping apps. */
  label?: string;
}

/** Google Maps directions URL. Opens in browser / native app on mobile. */
export function googleMapsUrl({
  latitude,
  longitude,
  label,
}: DirectionsTarget): string {
  const params = new URLSearchParams({
    api: "1",
    destination: `${latitude},${longitude}`,
  });
  if (label) params.set("destination_place_id", ""); // Google ignores this, but we include label via query
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Apple Maps directions URL. Works on iOS/macOS; falls back to web. */
export function appleMapsUrl({
  latitude,
  longitude,
  label,
}: DirectionsTarget): string {
  const params = new URLSearchParams({
    daddr: `${latitude},${longitude}`,
  });
  if (label) params.set("q", label);
  return `https://maps.apple.com/?${params.toString()}`;
}

/** Waze deep-link. Opens Waze app on mobile; web fallback. */
export function wazeUrl({ latitude, longitude }: DirectionsTarget): string {
  const params = new URLSearchParams({
    ll: `${latitude},${longitude}`,
    navigate: "yes",
  });
  return `https://waze.com/ul?${params.toString()}`;
}

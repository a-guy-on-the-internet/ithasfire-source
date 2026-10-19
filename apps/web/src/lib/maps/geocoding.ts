const GEOAPIFY_GEOCODE_URL = "https://api.geoapify.com/v1/geocode";

const geoapifyApiKey =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY?.trim() || undefined
    : undefined;

export interface GeocodingResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  /**
   * The POI / venue name, when the hit is a named place rather than a plain
   * building (typically Geoapify `result_type: "amenity"`). Null otherwise,
   * including when the provider's `name` just repeats the street line, street
   * or locality.
   *
   * Without it a venue and the building it sits in are indistinguishable in a
   * suggestion list: querying "6 Delancey St, New York" returns BOTH the
   * amenity "Bowery Ballroom" and the building at that address, and both render
   * the same `streetLine`, so the list shows two identical-looking rows.
   */
  name: string | null;
  /** Street-level address line (e.g. "123 Main St"). Null when unavailable. */
  streetLine: string | null;
  locality: string | null;
  region: string | null;
  /** ISO 3166-2 subdivision code (e.g. "TN", "CA"). Null when unavailable. */
  regionCode: string | null;
  countryCode: string | null;
  postalCode: string | null;
}

// ---------------------------------------------------------------------------
// Geoapify helpers (preferred — cheapest hosted option, caching allowed)
// ---------------------------------------------------------------------------

/** Shared by both forward endpoints — Geoapify caps usefully around here. */
const RESULT_LIMIT = 5;

/** A suggestion lookup that takes longer than this is treated as failed. */
export const SUGGESTION_TIMEOUT_MS = 8000;

/**
 * Run `fn` with a signal that fires on the caller's abort OR after `ms`.
 *
 * The two reasons stay distinguishable on purpose: the caller's abort rejects
 * with an `AbortError` (we superseded the request, say nothing), the deadline
 * rejects with a `TimeoutError` (the provider hung, the UI must say so). Built
 * on a plain controller rather than `AbortSignal.any` so older Safari builds
 * need no fallback.
 */
async function withTimeout<T>(
  signal: AbortSignal | undefined,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  const timeoutError = () =>
    new DOMException(`Geocoding timed out after ${ms}ms`, "TimeoutError");
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    // Some runtimes reject an aborted fetch with a generic AbortError instead
    // of `signal.reason`. If our deadline fired, it was a timeout whatever the
    // runtime called it, or the UI would read it as a user abort and show a
    // stale "no matches".
    if (timedOut && !signal?.aborted) throw timeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function geoapifyForward(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodingResult[]> {
  if (!geoapifyApiKey) return [];
  const url = `${GEOAPIFY_GEOCODE_URL}/search?text=${encodeURIComponent(query)}&limit=${RESULT_LIMIT}&apiKey=${geoapifyApiKey}`;
  return withTimeout(signal, SUGGESTION_TIMEOUT_MS, async (s) => {
    const res = await fetch(url, { signal: s });
    if (!res.ok) throw new Error(`Geoapify geocoding failed: ${res.status}`);
    const data = await res.json();
    return (data.features ?? []).map(mapGeoapifyFeature);
  });
}

async function geoapifyAutocomplete(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodingResult[]> {
  if (!geoapifyApiKey) return [];
  const url = `${GEOAPIFY_GEOCODE_URL}/autocomplete?text=${encodeURIComponent(query)}&limit=${RESULT_LIMIT}&format=geojson&apiKey=${geoapifyApiKey}`;
  return withTimeout(signal, SUGGESTION_TIMEOUT_MS, async (s) => {
    const res = await fetch(url, { signal: s });
    if (!res.ok) throw new Error(`Geoapify autocomplete failed: ${res.status}`);
    const data = await res.json();
    return (data.features ?? []).map(mapGeoapifyFeature);
  });
}

async function geoapifyReverse(
  lat: number,
  lng: number,
): Promise<GeocodingResult | null> {
  if (!geoapifyApiKey) return null;
  const url = `${GEOAPIFY_GEOCODE_URL}/reverse?lat=${lat}&lon=${lng}&limit=1&apiKey=${geoapifyApiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const feat = data.features?.[0];
  return feat ? mapGeoapifyFeature(feat) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapGeoapifyFeature(feature: any): GeocodingResult {
  const props = feature.properties ?? {};
  const street = props.street ?? null;
  const housenumber = props.housenumber ?? null;
  const streetLine =
    street && housenumber
      ? `${housenumber} ${street}`
      : (street ?? housenumber ?? null);
  const locality = props.city ?? props.town ?? props.village ?? null;
  // Geoapify sets `name` on streets and cities too, where it just repeats the
  // address ("Broadway" over "Broadway, Nashville"). Keep it only when it adds
  // something: a business or venue name.
  const sameAs = (a: unknown, b: unknown) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.trim().toLowerCase() === b.trim().toLowerCase();
  const rawName: string | null = props.name ?? null;
  const name =
    rawName &&
    (sameAs(rawName, streetLine) ||
      sameAs(rawName, street) ||
      sameAs(rawName, locality))
      ? null
      : rawName;
  return {
    lat: props.lat ?? feature.geometry?.coordinates?.[1] ?? 0,
    lng: props.lon ?? feature.geometry?.coordinates?.[0] ?? 0,
    formattedAddress: props.formatted ?? "",
    name,
    streetLine,
    locality,
    region: props.state ?? null,
    regionCode: props.state_code?.toUpperCase() ?? null,
    countryCode: props.country_code?.toUpperCase() ?? null,
    postalCode: props.postcode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API — delegates to Geoapify (only supported provider)
// ---------------------------------------------------------------------------

/**
 * Forward geocode: address string -> coordinates.
 *
 * Tuned for a COMPLETE address. Called on form submit, or debounced behind
 * {@link useGeocodeSuggestions}'s default `mode: "search"` — never raw on every
 * keystroke.
 */
export async function forwardGeocode(
  query: string,
  opts?: { signal?: AbortSignal },
): Promise<GeocodingResult[]> {
  return geoapifyForward(query, opts?.signal);
}

/**
 * Address autocomplete: PARTIAL address string -> ranked candidates.
 *
 * Geoapify's `/geocode/autocomplete` endpoint (same key, same plan, same
 * GeoJSON feature shape as `/geocode/search`, so {@link mapGeoapifyFeature}
 * covers both). It is built for half-typed input, where `/search` degrades —
 * "6 Delan" returns nothing useful from `/search` and the right building from
 * `/autocomplete`.
 *
 * COST: one request = one credit, same as a geocode, and autocomplete fires
 * far more often than submit-time geocoding does. Geoapify exposes no
 * remaining-quota header, so callers MUST debounce and enforce a minimum query
 * length rather than rely on the provider to push back. See
 * `useGeocodeSuggestions`, which is the only intended caller.
 */
export async function autocompleteAddress(
  query: string,
  opts?: { signal?: AbortSignal },
): Promise<GeocodingResult[]> {
  return geoapifyAutocomplete(query, opts?.signal);
}

/**
 * Reverse geocode: coordinates -> address string.
 * Called after user drops a pin on the map.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodingResult | null> {
  return geoapifyReverse(lat, lng);
}

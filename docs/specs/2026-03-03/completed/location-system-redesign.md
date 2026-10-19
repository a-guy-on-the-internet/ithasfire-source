# Location System Redesign: MapLibre + MapTiler Migration & Visibility Controls

**Status:** complete
**Date:** 2026-02-19
**Branch:** TBD (from `chore/remove-core-template-shims` or new feature branch)

---

## 1. Overview

Replace all Google Maps dependencies with MapLibre GL JS (rendering) + MapTiler (tiles, geocoding, static maps). Add a location visibility system that controls how much location detail is exposed on public event pages, with a post-purchase reveal flow for private venues.

This is a house show / small venue platform. Location privacy is a core product feature, not an afterthought.

---

## 2. Terminology & Naming Conventions

The platform already uses `SCREAMING_SNAKE_CASE` single-word enum values in Prisma for event-related enums:

| Existing Enum | Values |
| --- | --- |
| `EventStatus` | `DRAFT`, `PUBLISHED`, `CANCELLED`, `COMPLETED`, `ARCHIVED` |
| `EventVisibility` | `PUBLIC`, `PRIVATE` |
| `EventGateType` | `NONE`, `APPLICATION`, `PASSWORD` |
| `EventUnlockSource` | `PASSWORD`, `APPLICATION`, `ADMIN`, `INVITE_LIST`, `MAGIC_LINK` |

The new location visibility enum follows the same convention:

```prisma
enum EventLocationMode {
  EXACT        // Full address + exact pin shown publicly
  APPROXIMATE  // Neighborhood-level circle shown publicly, no exact coords
  HIDDEN       // Approximate circle publicly, exact revealed post-purchase
}
```

**Mapping to the user's original names:**

| User term | Enum value | Public behavior | Post-purchase behavior |
| --- | --- | --- | --- |
| `PUBLIC_EXACT` | `EXACT` | Exact pin + full address | Same |
| `PUBLIC_APPROXIMATE` | `APPROXIMATE` | Radius circle + area label | Same (no reveal) |
| `PRIVATE_UNTIL_PURCHASE` | `HIDDEN` | Radius circle + area label | Exact pin + full address |

The enum is called `EventLocationMode` (not `EventLocationVisibility`) to avoid confusion with the existing `EventVisibility` enum which controls whether the event listing itself is public/private.

---

## 3. Database Changes

### 3.1 New Prisma enum

```prisma
// Add to packages/db/prisma/schema.prisma, near the other Event* enums (around line 132)

enum EventLocationMode {
  EXACT
  APPROXIMATE
  HIDDEN
}
```

### 3.2 New columns on `Event` model

```prisma
model Event {
  // ... existing fields ...

  // Location visibility control (defaults to EXACT for backward compat)
  locationMode          EventLocationMode @default(EXACT)

  // Radius in meters for the obfuscation circle (APPROXIMATE / HIDDEN modes)
  // Configurable by organizer: 300–5000m. Default 500m.
  locationRadiusMeters  Int?              @default(500)

  // Human-readable label the organizer can set (e.g. "Bushwick, Brooklyn")
  // Used in APPROXIMATE/HIDDEN mode as the public location name
  locationLabel         String?

  // ... rest of existing fields ...
}
```

**No existing columns are removed.** The existing `lat`, `lng`, `addressText`, `locality`, `region`, `countryCode`, `postalCode`, `placeId`, `savedLocationId` all stay. They continue to store the canonical exact location. The new `locationMode` column controls what subset of that data is exposed via public APIs.

### 3.3 Migration

```bash
pnpm -C packages/db prisma migrate dev --name add-event-location-mode
```

This is a non-breaking additive migration. `locationMode` defaults to `EXACT`, so all existing events behave exactly as they do today.

---

## 4. Backend: Location Redaction

### 4.1 Core principle

> The **database** always stores the exact lat/lng. The **API layer** redacts them based on `locationMode` and the caller's access level.

### 4.2 New utility: `packages/core/src/lib/location/redact-location.ts`

Pure function, no dependencies. Used by every use case or mapper that returns location data to the public.

```typescript
export interface ExactLocation {
  lat: number;
  lng: number;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  locationLabel: string | null;
}

export interface RedactedLocation {
  /** Obfuscated center point (randomly offset within radius) */
  lat: number;
  lng: number;
  /** Radius in meters for the circle overlay */
  radiusMeters: number;
  /** Human-readable area label (e.g. "Bushwick, Brooklyn" or "East Austin") */
  areaLabel: string | null;
  /** Whether the viewer can see the exact location */
  isExact: false;
}

export interface ExactLocationOutput {
  lat: number;
  lng: number;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  locationLabel: string | null;
  isExact: true;
}

export type PublicLocation = RedactedLocation | ExactLocationOutput;

export type EventLocationMode = "EXACT" | "APPROXIMATE" | "HIDDEN";

export interface RedactLocationInput {
  mode: EventLocationMode;
  exact: ExactLocation;
  radiusMeters: number;
  /** Whether the caller has purchased a ticket (for HIDDEN mode reveal) */
  callerIsTicketHolder: boolean;
}

/**
 * Returns location data appropriate for the caller's access level.
 *
 * EXACT → always returns exact coordinates
 * APPROXIMATE → always returns obfuscated coordinates + radius
 * HIDDEN → returns obfuscated unless callerIsTicketHolder is true
 *
 * The obfuscation applies a deterministic random offset to the center point
 * so the same event always returns the same approximate center (preventing
 * inference via repeated requests), but the offset is far enough from the
 * real point that the exact location cannot be determined.
 */
export function redactLocation(input: RedactLocationInput): PublicLocation {
  const { mode, exact, radiusMeters, callerIsTicketHolder } = input;

  // EXACT mode: always reveal
  if (mode === "EXACT") {
    return {
      lat: exact.lat,
      lng: exact.lng,
      addressText: exact.addressText,
      locality: exact.locality,
      region: exact.region,
      countryCode: exact.countryCode,
      postalCode: exact.postalCode,
      locationLabel: exact.locationLabel,
      isExact: true,
    };
  }

  // HIDDEN mode with ticket holder: reveal
  if (mode === "HIDDEN" && callerIsTicketHolder) {
    return {
      lat: exact.lat,
      lng: exact.lng,
      addressText: exact.addressText,
      locality: exact.locality,
      region: exact.region,
      countryCode: exact.countryCode,
      postalCode: exact.postalCode,
      locationLabel: exact.locationLabel,
      isExact: true,
    };
  }

  // APPROXIMATE or HIDDEN (non-holder): obfuscate
  return {
    lat: obfuscateCoordinate(exact.lat, exact.lng, radiusMeters).lat,
    lng: obfuscateCoordinate(exact.lat, exact.lng, radiusMeters).lng,
    radiusMeters,
    areaLabel: exact.locationLabel ?? buildAreaLabel(exact),
    isExact: false,
  };
}
```

### 4.3 Obfuscation algorithm: `obfuscateCoordinate`

```typescript
/**
 * Returns a deterministic offset from the true center.
 * Uses a hash of the coordinates as seed so the same input always
 * produces the same output (no inference via repeated calls).
 * Offset is between 30% and 70% of the radius in a random direction.
 */
function obfuscateCoordinate(lat: number, lng: number, radiusMeters: number): { lat: number; lng: number } {
  // Deterministic seed from the coordinates themselves
  const seed = simpleHash(`${lat.toFixed(8)}:${lng.toFixed(8)}`);

  // Offset distance: 30-70% of radius
  const distanceFraction = 0.3 + (seed % 1000) / 2500; // 0.3 to 0.7
  const offsetMeters = radiusMeters * distanceFraction;

  // Offset angle: 0-360 degrees
  const angle = ((seed >> 10) % 3600) / 10; // 0 to 360 degrees
  const angleRad = (angle * Math.PI) / 180;

  // Convert meters to approximate lat/lng offset
  const latOffset = (offsetMeters * Math.cos(angleRad)) / 111_320;
  const lngOffset = (offsetMeters * Math.sin(angleRad)) / (111_320 * Math.cos((lat * Math.PI) / 180));

  return {
    lat: lat + latOffset,
    lng: lng + lngOffset,
  };
}

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function buildAreaLabel(loc: ExactLocation): string | null {
  const parts = [loc.locality, loc.region].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}
```

### 4.4 Use cases to modify

Every use case or mapper that returns location data to clients must call `redactLocation`. The key files:

| File | What to change |
| --- | --- |
| `packages/core/src/use-cases/events/_shared/build-event-seo.ts` | The `location` block currently passes raw `event.lat`, `event.lng`. Must call `redactLocation` with `callerIsTicketHolder: false` (SEO is always public). Return `isExact` discriminator so frontend knows which UI to render. |
| `packages/core/src/use-cases/events/get-event-seo.ts` | Update `getEventSeoOutputSchema` to include `locationMode`, `isExact`, `radiusMeters`, `areaLabel` in the location object. |
| `packages/core/src/use-cases/events/list-events-by-location.ts` | Search results show approximate locations. Call `redactLocation` with `callerIsTicketHolder: false`. |
| `packages/core/src/use-cases/events/list-events-by-country.ts` | Same as above. |
| `packages/transport/trpc/src/event-summary-mapper.ts` | Same pattern — redact before returning. |

### 4.5 New use case: `reveal-event-location.ts`

Authenticated endpoint that returns the exact location for ticket holders.

```text
packages/core/src/use-cases/events/reveal-event-location.ts
```

**Input:**

```typescript
{
  eventId: string;       // UUID
  actorHumanId: string;  // from auth context
}
```

**Logic:**
1. Fetch the event by ID.
2. Check `event.locationMode`:
   - If `EXACT`: return exact location immediately (it's already public).
   - If `APPROXIMATE`: return error — approximate events never reveal exact.
   - If `HIDDEN`: verify the actor has a confirmed ticket for this event via `repos.tickets.findByEventAndHuman(eventId, actorHumanId)`. If yes, return exact. If no, throw `{ code: "forbidden", message: "ticket_required" }`.
3. Log the access attempt: `logger.info("events.location_reveal", { eventId, actorHumanId, granted: boolean })`.

**Output:**
```typescript
{
  lat: number;
  lng: number;
  addressText: string | null;
  locationLabel: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
}
```

**Transport:** Add to the events tRPC router as `authedProcedure`.

**Rate limiting:** Apply the existing rate limiter (if one exists) or add a simple per-user rate limit of 30 calls/minute.

### 4.6 Security checklist

- [ ] `getEventSeo` output never includes raw lat/lng when `locationMode` is `APPROXIMATE` or `HIDDEN`
- [ ] `getEventSeoOutputSchema` Zod schema enforces the redacted shape — no optional lat/lng fields that could leak
- [ ] Search index (`build-search-index.ts`) uses obfuscated coordinates for approximate/hidden events
- [ ] Event summary DTOs (`EventSummaryDto`) use redacted locations
- [ ] `reveal-event-location` validates ticket ownership, not just authentication
- [ ] No raw coordinates in SSR HTML (check Next.js serialized props)
- [ ] Static map image URLs use obfuscated center for approximate/hidden events
- [ ] Audit log on every reveal attempt

---

## 5. Google Maps Removal

### 5.1 Packages to uninstall

```bash
pnpm -F web remove @vis.gl/react-google-maps
```

Verify no other workspace packages depend on it:
```bash
grep -r "@vis.gl/react-google-maps" packages/*/package.json apps/*/package.json
```

### 5.2 Files to delete

| File | Replacement |
| --- | --- |
| `apps/web/src/components/maps/GoogleMapsProvider.tsx` | `MapProvider.tsx` (new, wraps MapLibre context) |
| `apps/web/src/components/maps/LocationAutocomplete.tsx` | `LocationSearchInput.tsx` (new, MapTiler geocoding on submit) |
| `apps/web/src/components/maps/CoordinatesSelectorMap.tsx` | `CoordinatesPicker.tsx` (new, MapLibre click-to-pin) |
| `apps/web/src/components/maps/LocationMapPreview.tsx` | `LocationMapPreview.tsx` (rewrite, MapLibre static or interactive) |
| `apps/web/src/components/maps/PlacesAutocomplete.tsx` | Delete (Google Places specific) |
| `apps/web/src/components/maps/AddressAutocompleteInput.tsx` | Delete (Google Places specific) |
| `apps/web/src/components/maps/place-utils.ts` | Replace with MapTiler-specific geocoding utils |

### 5.3 Files to modify

| File | What to change |
| --- | --- |
| `apps/web/src/config/maps.ts` | Replace `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` / `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` with `NEXT_PUBLIC_MAPTILER_API_KEY`. Export MapTiler style URL. Remove all Google references. |
| `apps/web/src/app/providers.tsx` | Replace `<GoogleMapsProvider>` with `<MapProvider>` (or remove if MapLibre doesn't need a global provider — it usually doesn't). |
| `apps/web/src/app/admin/[slug]/events/new/_components/EventBuilder.tsx` | Replace `LocationAutocomplete` with `LocationSearchInput`. Replace `CoordinatesSelectorMap` with `CoordinatesPicker`. Replace Google reverse-geocoding with MapTiler reverse geocoding. Remove `isGoogleMapsEnabled` guard. Add `locationMode` selector UI. |
| `apps/web/src/app/events/[...slug]/_components/EventDetail.tsx` | Update `LocationMapPreview` usage. Pass `locationMode` and render circle overlay or exact pin based on `isExact`. |
| `apps/web/src/lib/location/derive-region-code.ts` | Remove Google Maps reference in comments. |
| `apps/web/src/components/navigation/__tests__/AppNavbar.test.tsx` | Remove `isGoogleMapsEnabled` mock. |

### 5.4 Environment variables

| Old | New | Where |
| --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | `NEXT_PUBLIC_MAPTILER_API_KEY` | `apps/web/.env.local`, `infra/env/`, `docs/env.md`, `apps/web/README.md` |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | _(remove)_ | MapTiler uses style URLs, not map IDs |

---

## 6. MapLibre + MapTiler Integration

### 6.1 Packages to install

```bash
pnpm -F web add maplibre-gl
```

MapLibre GL JS is the only runtime dependency. No React wrapper library is strictly necessary — MapLibre works with refs. But if a wrapper is preferred:

```bash
pnpm -F web add react-map-gl maplibre-gl
# react-map-gl v7+ supports MapLibre as a backend
```

**Decision for implementer:** Choose one approach:
- **Option A:** Raw `maplibregl.Map` with React refs (lighter, full control)
- **Option B:** `react-map-gl` with `mapLib={maplibregl}` (more React-idiomatic, handles lifecycle)

Both work. Option B is recommended for consistency with how `@vis.gl/react-google-maps` was used.

### 6.2 MapTiler tile style URL

```typescript
// apps/web/src/config/maps.ts (new)

export const mapTilerApiKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";
export const isMapEnabled = Boolean(mapTilerApiKey);

// MapTiler provides light + dark styles. Use CSS media query or theme context to switch.
export const mapStyleLight = `https://api.maptiler.com/maps/streets-v2/style.json?key=${mapTilerApiKey}`;
export const mapStyleDark = `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${mapTilerApiKey}`;

export const usCentroid = { lat: 39.8283, lng: -98.5795 };
export const defaultMapZoom = 3;
export const detailMapZoom = 14;
export const coordinatesPickerZoom = 15;
```

### 6.3 MapTiler Geocoding API

MapTiler provides a REST geocoding API. **No per-keystroke autocomplete** — only geocode on submit.

```typescript
// apps/web/src/lib/maps/geocoding.ts

const MAPTILER_GEOCODE_URL = "https://api.maptiler.com/geocoding";

export interface GeocodingResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
}

/**
 * Forward geocode: address string → coordinates.
 * Called on form submit, NOT on every keystroke.
 */
export async function forwardGeocode(query: string, apiKey: string): Promise<GeocodingResult[]> {
  const url = `${MAPTILER_GEOCODE_URL}/${encodeURIComponent(query)}.json?key=${apiKey}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  return data.features.map(mapFeatureToResult);
}

/**
 * Reverse geocode: coordinates → address string.
 * Called after user drops a pin on the map.
 */
export async function reverseGeocode(lat: number, lng: number, apiKey: string): Promise<GeocodingResult | null> {
  const url = `${MAPTILER_GEOCODE_URL}/${lng},${lat}.json?key=${apiKey}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.features?.[0] ? mapFeatureToResult(data.features[0]) : null;
}

function mapFeatureToResult(feature: any): GeocodingResult {
  const [lng, lat] = feature.center ?? feature.geometry?.coordinates ?? [0, 0];
  const context = feature.context ?? [];
  return {
    lat,
    lng,
    formattedAddress: feature.place_name ?? "",
    locality: findContextType(context, "place")?.text ?? null,
    region: findContextType(context, "region")?.text ?? null,
    countryCode: findContextType(context, "country")?.short_code?.toUpperCase() ?? null,
    postalCode: findContextType(context, "postcode")?.text ?? null,
  };
}

function findContextType(context: any[], type: string) {
  return context.find((c: any) => c.id?.startsWith(type));
}
```

### 6.4 Static map images (MapTiler Static Maps API)

For event cards, email confirmations, and social previews.

```typescript
// apps/web/src/lib/maps/static-map.ts

/**
 * Build a MapTiler Static Maps URL.
 *
 * For EXACT mode: centered on exact coords with a pin marker.
 * For APPROXIMATE/HIDDEN mode: centered on obfuscated coords, no pin.
 * Circle overlay for approximate mode is rendered client-side via SVG, not in the static image.
 */
export function buildStaticMapUrl(options: {
  lat: number;
  lng: number;
  zoom?: number;
  width?: number;
  height?: number;
  isExact: boolean;
  apiKey: string;
}): string {
  const { lat, lng, zoom = 13, width = 600, height = 300, isExact, apiKey } = options;
  const style = "streets-v2"; // or "streets-v2-dark" for dark mode
  const marker = isExact ? `&markers=${lng},${lat},red` : "";
  return `https://api.maptiler.com/maps/${style}/static/${lng},${lat},${zoom}/${width}x${height}.png?key=${apiKey}${marker}`;
}
```

---

## 7. Frontend Components

### 7.1 New component inventory

| File | Purpose | Used in |
| --- | --- | --- |
| `apps/web/src/components/maps/MapProvider.tsx` | Optional context provider for MapLibre (may not be needed if using raw refs) | `providers.tsx` |
| `apps/web/src/components/maps/LocationMapPreview.tsx` | **Rewrite.** Public event detail map. Renders exact pin OR radius circle based on `isExact`. | `EventDetail.tsx` |
| `apps/web/src/components/maps/CoordinatesPicker.tsx` | **Rewrite.** Admin event builder: interactive map with click-to-pin. | `EventBuilder.tsx` |
| `apps/web/src/components/maps/LocationSearchInput.tsx` | **New.** Text input + "Search" button. Forward geocodes on submit via MapTiler. Replaces Google autocomplete. | `EventBuilder.tsx` |
| `apps/web/src/components/maps/RadiusCircleOverlay.tsx` | **New.** SVG or MapLibre circle layer that renders a translucent circle on the map. | `LocationMapPreview.tsx` |
| `apps/web/src/lib/maps/geocoding.ts` | **New.** Forward + reverse geocoding via MapTiler REST API. | `CoordinatesPicker.tsx`, `LocationSearchInput.tsx` |
| `apps/web/src/lib/maps/static-map.ts` | **New.** Static map URL builder for MapTiler. | Email templates, event cards, social previews |

### 7.2 `LocationMapPreview.tsx` (rewrite)

The existing component uses `@vis.gl/react-google-maps` `<Map>`, `<AdvancedMarker>`, `<Marker>`. Replace with MapLibre GL JS.

**Props (updated):**

```typescript
export type LocationMapPreviewProps = {
  lat: number;
  lng: number;
  /** When true, show an exact pin marker. When false, show a radius circle. */
  isExact: boolean;
  /** Radius in meters (only used when isExact is false). */
  radiusMeters?: number;
  /** Area label shown in a tooltip or badge (only when isExact is false). */
  areaLabel?: string | null;
  /** Full address label (only when isExact is true). */
  addressLabel?: string | null;
  className?: string;
};
```

**Behavior:**
- `isExact: true` → Render a pin marker at `(lat, lng)`. Standard map at zoom 14.
- `isExact: false` → Render a translucent circle (stroke + fill, ~20% opacity) centered at `(lat, lng)` with radius `radiusMeters`. No pin. Zoom level auto-calculated to fit the circle. Show `areaLabel` as a floating badge on the map.
- Map is non-interactive on the public event page (no pan/zoom). `interactive: false` in MapLibre options.
- Light/dark style based on user's color scheme (`prefers-color-scheme`).
- Graceful fallback when `NEXT_PUBLIC_MAPTILER_API_KEY` is not set.

### 7.3 `CoordinatesPicker.tsx` (rewrite)

Interactive MapLibre map for the admin event builder.

**Behavior:**
- Full pan/zoom/drag.
- Click anywhere to drop a pin (primary interaction mode).
- On pin drop: update parent state with `{ lat, lng }`, trigger reverse geocode via MapTiler to suggest `addressText`.
- Show coordinate badge overlay (bottom-left, like current `CoordinatesSelectorMap`).
- Support `initialCenter` prop (from geolocation or existing event data).
- "Use my location" button uses browser `navigator.geolocation` (existing logic).

### 7.4 `LocationSearchInput.tsx` (new)

Replaces Google Places autocomplete. **No per-keystroke API calls.**

**Behavior:**
- Text input with a "Search" button (or Enter key submit).
- On submit: call `forwardGeocode(query, apiKey)`.
- Display results in a dropdown below the input.
- User clicks a result → fires `onSelect({ lat, lng, formattedAddress, ... })`.
- Parent component updates the map pin to the selected location.

### 7.5 `RadiusCircleOverlay.tsx` (new)

Renders a translucent circle on a MapLibre map. Can be implemented as:
- A MapLibre `circle` layer with GeoJSON source (recommended for proper geo-projection), OR
- An SVG overlay (simpler but doesn't project correctly at extreme zooms)

**Recommended approach:** MapLibre GeoJSON source + `circle` layer type.

```typescript
// Pseudocode for MapLibre circle layer
map.addSource("radius-circle", {
  type: "geojson",
  data: turf.circle([lng, lat], radiusMeters / 1000, { units: "kilometers" }),
});
map.addLayer({
  id: "radius-circle-fill",
  type: "fill",
  source: "radius-circle",
  paint: {
    "fill-color": "#3b82f6",  // blue-500
    "fill-opacity": 0.12,
  },
});
map.addLayer({
  id: "radius-circle-stroke",
  type: "line",
  source: "radius-circle",
  paint: {
    "line-color": "#3b82f6",
    "line-width": 2,
    "line-opacity": 0.4,
  },
});
```

**Note:** If using `@turf/circle` for the GeoJSON polygon, install it:
```bash
pnpm -F web add @turf/circle @turf/helpers
```

Alternatively, generate the circle polygon manually (it's just 64 points around a center at a given radius — ~20 lines of math, avoids a dependency).

---

## 8. Admin Event Builder Changes

### 8.1 Location mode selector

Add a new UI control in the location section of `EventBuilder.tsx`. After the user has set a pin/address, show a segmented control or radio group:

```text
Location visibility:
  ○ Exact — Show full address and pin
  ○ Approximate — Show neighborhood area only
  ○ Hidden — Reveal exact location after ticket purchase
```

When `APPROXIMATE` or `HIDDEN` is selected, show additional controls:
- **Radius slider:** 300m – 5000m, default 500m. Show the circle preview on the map in real-time.
- **Area label input:** Pre-filled from reverse geocoding (e.g., "Bushwick, Brooklyn"), editable.

### 8.2 State changes in EventBuilder

Add to existing state:

```typescript
const [locationMode, setLocationMode] = useState<"EXACT" | "APPROXIMATE" | "HIDDEN">("EXACT");
const [locationRadiusMeters, setLocationRadiusMeters] = useState(500);
const [locationLabel, setLocationLabel] = useState("");
```

These must be included in the `createEvent` / `updateEvent` mutation payloads.

### 8.3 Backend: update `create-event` and `update-event` use cases

Add `locationMode`, `locationRadiusMeters`, and `locationLabel` to the input schemas. Validate:
- `locationMode` must be one of `EXACT`, `APPROXIMATE`, `HIDDEN`
- `locationRadiusMeters` must be between 300 and 5000 (only required when mode is not `EXACT`)
- `locationLabel` is optional, max 200 characters

---

## 9. Public Event Page: Location Display

### 9.1 `EventDetail.tsx` changes

The location section in `EventDetail.tsx` (lines ~320-370) currently renders `LocationMapPreview` with raw `event.location.latitude` / `event.location.longitude`. After the backend changes, the location object will include `isExact`, `radiusMeters`, and `areaLabel`.

**EXACT mode:** Same as today — pin on map, full address text.

**APPROXIMATE mode:**
- Map shows a circle at the obfuscated center.
- Address text replaced with `areaLabel` (e.g., "Bushwick, Brooklyn").
- No street address, no postal code.

**HIDDEN mode (public view):**
- Same as APPROXIMATE visually.
- Additional CTA: "Purchase a ticket to see the exact location" or similar.

**HIDDEN mode (ticket holder view, via client-side `revealEventLocation` call):**
- After purchase, the component calls `trpc.events.revealEventLocation.useQuery({ eventId })`.
- If successful, renders exact pin + full address.
- If not a ticket holder, stays in approximate view.

### 9.2 My Tickets / Order Detail: location reveal

After a user purchases a ticket, the exact location should be visible in:
1. **Order confirmation page** — call `revealEventLocation` and display.
2. **My Tickets page** — each ticket card shows the exact address.
3. **Email confirmation** — include exact address + static map image (exact mode) in the email.

---

## 10. Email Confirmation: Location Reveal

For HIDDEN events, the order confirmation email must include the exact location. This happens server-side (in the `create-checkout` post-payment webhook handler), so no client-side reveal is needed.

The email template should:
- Include the exact address text
- Include a static map image URL from MapTiler (using the exact coordinates, since the email is only sent to ticket holders)
- Include a Google Maps / Apple Maps deep link: `https://maps.google.com/?q={lat},{lng}`

---

## 11. Data Flow Summary

```text
                    ┌──────────────┐
                    │   Database   │
                    │  (exact lat/ │
                    │   lng always)│
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │  Use Case /  │
                    │  Mapper      │
                    │              │
                    │  redactLocation()
                    │              │
              ┌─────┴─────┐  ┌────┴──────┐
              │  EXACT     │  │ APPROX /  │
              │            │  │ HIDDEN    │
              │ raw coords │  │ obfuscated│
              │ full addr  │  │ + radius  │
              └─────┬──────┘  └────┬──────┘
                    │              │
              ┌─────┴──────────────┴─────┐
              │       tRPC / SSR         │
              │   (serialized to JSON)   │
              └─────┬──────────────┬─────┘
                    │              │
              ┌─────┴──────┐ ┌────┴──────┐
              │ Exact pin  │ │  Circle   │
              │ + address  │ │  + area   │
              │            │ │  label    │
              └────────────┘ └───────────┘

              For HIDDEN + ticket holder:
              ┌────────────────────────────┐
              │  revealEventLocation()     │
              │  → validates ticket        │
              │  → returns exact coords    │
              └────────────────────────────┘
```

---

## 12. Testing

### 12.1 Unit tests

| Test file | What to test |
| --- | --- |
| `packages/core/src/lib/location/__tests__/redact-location.test.ts` | EXACT returns raw coords. APPROXIMATE returns obfuscated coords within radius. HIDDEN without ticket returns obfuscated. HIDDEN with ticket returns raw. Obfuscation is deterministic (same input = same output). Obfuscated point is within the specified radius of the original. |
| `packages/core/src/use-cases/events/__tests__/reveal-event-location.test.ts` | Returns exact for EXACT events. Returns exact for HIDDEN events when actor has ticket. Throws forbidden for HIDDEN events when actor has no ticket. Throws error for APPROXIMATE events. |
| `packages/core/src/use-cases/events/__tests__/build-event-seo.test.ts` | Existing tests still pass. New tests: APPROXIMATE event SEO output has no raw lat/lng. HIDDEN event SEO output has no raw lat/lng. |

### 12.2 Integration tests

| Test | What to verify |
| --- | --- |
| `packages/adapters/test/reveal-location-flow.test.ts` | End-to-end: create event with HIDDEN mode → create order → confirm payment → call reveal → get exact coords. Without payment → reveal returns forbidden. |

### 12.3 Security tests

| Test | What to verify |
| --- | --- |
| Inspect serialized Next.js page props | For APPROXIMATE/HIDDEN events, `__NEXT_DATA__` JSON must NOT contain raw lat/lng. |
| Network tab audit | `getEventSeo` response for HIDDEN events must not contain raw coordinates. |
| Repeated reveal calls | Rate limiter blocks after 30 calls/minute. |

---

## 13. Migration Plan (Implementation Order)

### Phase 1: Backend (no frontend changes, no breaking changes)

1. Add `EventLocationMode` enum + new columns to Prisma schema. Migrate.
2. Implement `redact-location.ts` utility + unit tests.
3. Update `build-event-seo.ts` to call `redactLocation`. Add `isExact`, `radiusMeters`, `areaLabel` to the SEO output schema.
4. Implement `reveal-event-location.ts` use case + transport binding + tests.
5. Update `create-event` and `update-event` input schemas to accept `locationMode`, `locationRadiusMeters`, `locationLabel`.

**Validation:** All existing tests pass. New events default to `EXACT`, so behavior is identical.

### Phase 2: MapLibre migration (swap rendering, no visibility logic yet)

1. Install `maplibre-gl` (and optionally `react-map-gl`).
2. Rewrite `LocationMapPreview.tsx` using MapLibre. Keep same props interface initially (lat, lng, label).
3. Rewrite `CoordinatesSelectorMap.tsx` → `CoordinatesPicker.tsx` using MapLibre.
4. Create `LocationSearchInput.tsx` with MapTiler geocoding.
5. Create `geocoding.ts` utility.
6. Update `EventBuilder.tsx` to use new components.
7. Update `config/maps.ts` to MapTiler keys.
8. Update `providers.tsx` — remove `GoogleMapsProvider`.
9. Remove `@vis.gl/react-google-maps` dependency.
10. Delete old Google-specific files.

**Validation:** Admin can create events with map. Public event pages show maps. No Google API calls in network tab.

### Phase 3: Visibility UI (connect frontend to backend)

1. Add location mode selector to `EventBuilder.tsx`.
2. Add radius slider + area label input.
3. Update `LocationMapPreview.tsx` to support `isExact` / circle mode.
4. Create `RadiusCircleOverlay.tsx`.
5. Update `EventDetail.tsx` to pass new location shape to map component.
6. Add reveal flow to My Tickets / Order Detail pages.
7. Update email templates with static map images.

**Validation:** Full end-to-end: create event with each location mode → verify public page shows correct level of detail → purchase ticket → verify reveal works.

---

## 14. Files Inventory (Complete)

### New files

| File | Layer |
| --- | --- |
| `packages/core/src/lib/location/redact-location.ts` | Core (pure function) |
| `packages/core/src/lib/location/__tests__/redact-location.test.ts` | Core (tests) |
| `packages/core/src/use-cases/events/reveal-event-location.ts` | Core (use case) |
| `packages/core/src/use-cases/events/__tests__/reveal-event-location.test.ts` | Core (tests) |
| `apps/web/src/lib/maps/geocoding.ts` | Web (utility) |
| `apps/web/src/lib/maps/static-map.ts` | Web (utility) |
| `apps/web/src/components/maps/CoordinatesPicker.tsx` | Web (admin component) |
| `apps/web/src/components/maps/LocationSearchInput.tsx` | Web (admin component) |
| `apps/web/src/components/maps/RadiusCircleOverlay.tsx` | Web (public component) |

### Files to rewrite

| File | Why |
| --- | --- |
| `apps/web/src/components/maps/LocationMapPreview.tsx` | Google Maps → MapLibre GL JS |
| `apps/web/src/config/maps.ts` | Google env vars → MapTiler env vars |

### Files to modify

| File | What changes |
| --- | --- |
| `packages/db/prisma/schema.prisma` | Add `EventLocationMode` enum, add 3 columns to `Event` |
| `packages/types/src/repos/events.ts` | Add `locationMode`, `locationRadiusMeters`, `locationLabel` to `EventRecord` |
| `packages/core/src/use-cases/events/_shared/build-event-seo.ts` | Call `redactLocation()` |
| `packages/core/src/use-cases/events/get-event-seo.ts` | Update output schema with `isExact`, `radiusMeters`, `areaLabel` |
| `packages/core/src/use-cases/events/list-events-by-location.ts` | Redact location in output |
| `packages/core/src/use-cases/events/list-events-by-country.ts` | Redact location in output |
| `packages/core/src/use-cases/events/index.ts` | Export new use case |
| `packages/transport/trpc/src/routers/events.ts` | Add `revealEventLocation` procedure |
| `packages/transport/trpc/src/event-summary-mapper.ts` | Redact location in summaries |
| `apps/web/src/app/providers.tsx` | Remove `GoogleMapsProvider`, add MapLibre provider if needed |
| `apps/web/src/app/admin/[slug]/events/new/_components/EventBuilder.tsx` | New map components, location mode selector |
| `apps/web/src/app/events/[...slug]/_components/EventDetail.tsx` | Pass `isExact` to map, render circle vs pin |
| `apps/web/src/server/events.ts` | Update `loadEventSeo` mapper to handle new location shape |
| `packages/types/src/seo/types.ts` | Add `isExact`, `radiusMeters`, `areaLabel` to `SeoLocation` |
| `apps/web/README.md` | Update env var documentation |

### Files to delete

| File | Reason |
| --- | --- |
| `apps/web/src/components/maps/GoogleMapsProvider.tsx` | Google Maps removed |
| `apps/web/src/components/maps/LocationAutocomplete.tsx` | Replaced by `LocationSearchInput.tsx` |
| `apps/web/src/components/maps/CoordinatesSelectorMap.tsx` | Replaced by `CoordinatesPicker.tsx` |
| `apps/web/src/components/maps/PlacesAutocomplete.tsx` | Google Places specific |
| `apps/web/src/components/maps/AddressAutocompleteInput.tsx` | Google Places specific |
| `apps/web/src/components/maps/place-utils.ts` | Google Places specific type mappings |

---

## 15. Out of Scope

- **Geofencing / geo-restricted ticket sales:** Not part of this spec.
- **Multi-location events:** One event = one location. No change.
- **Location analytics / heatmaps:** Future feature.
- **Place model changes:** The `Place` model is unchanged. Location visibility is per-event, not per-place. A Place is a registered venue — events at that place can still choose HIDDEN mode (e.g., a house show host who registers their house as a Place but wants privacy per-event).
- **Mobile app map components:** `apps/mobile` and `apps/scanner` are React Native. MapLibre GL JS is web-only. React Native maps (if needed) would use `@maplibre/maplibre-react-native` or similar — separate spec.
- **LocationPinInput.tsx:** Existing file in `apps/web/src/components/maps/` — check if it's used. If it wraps Google Maps, it needs updating too. If unused, delete it.

# Artist Tour Routing Engine

**Date:** 2026-04-15
**Status:** draft
**Priority:** P2
**Supersedes:** `docs/specs/2026-03-17/completed/touring-guide-valhalla.spec.yaml` — infrastructure section preserved, use cases rewritten to be artist-forward
**Depends on:** Valhalla infrastructure (unchanged from original spec), `BookingRequest` model, `PlaceAvailability` model, `PlaceStats`, `HumanStats`

---

## Problem

A touring artist in Nashville wants to play shows between Nashville and Austin over 6 days. Today they: cold-email venues one at a time, guess at driving distances, have no idea which venues pay well or fit their genre, and hope for the best on routing. They plan tours in spreadsheets, DMs, and group texts. There is no tool that connects "I want to play between A and B" to "here are the venues and hosts along your route that match your act."

The original Valhalla spec (2026-03-17) proposed a routing engine for **attendees** — "plan your night out across multiple events." That's a nice-to-have for fans but doesn't solve the core pain. The routing engine should serve **artists first**: find venues and hosts along a tour corridor, rank them by fit, and let the artist send booking requests in bulk.

---

## Goal

An artist submits a tour corridor (start city, end city, date range, preferences). The engine returns a ranked list of available venues/hosts along the route, optimized for driving distance, genre fit, pay history, and logistics. The artist reviews matches, sends booking requests, and builds an itinerary — all without leaving Ithas Fire.

---

## Context

| What exists | Where |
|---|---|
| Valhalla routing engine (proposed, not deployed) | `docs/specs/2026-03-17/completed/touring-guide-valhalla.spec.yaml` |
| Map stack: TileServer GL + MapLibre GL JS | Self-hosted on Cloud Run |
| Geocoding: Geoapify | Hosted API |
| `BookingRequest` model (artist → venue pitch) | `packages/db/prisma/agreement.prisma` |
| `PlaceAvailability` (recurring + specific-date availability) | `packages/db/prisma/agreement.prisma` |
| `PlaceStats` (pay ranges, sound score, booker score, genre cloud) | `packages/db/prisma/place-review.prisma` |
| `HumanStats` (events performed, draw, top cities) | `packages/db/prisma/stats.prisma` |
| `Human.genreTags`, `Human.jobs` | `packages/db/prisma/auth.prisma` |
| Artist EPK / EntityPage | `packages/db/prisma/entity-page.prisma` |
| `Agreement` model (deal structure + payout terms) | `packages/db/prisma/agreement.prisma` |

---

## Infrastructure (Unchanged from Original Spec)

The Valhalla deployment plan from `touring-guide-valhalla.spec.yaml` is preserved in full:

- **Engine:** Valhalla (open-source C++ routing, self-hosted, zero per-request cost)
- **Image:** `ghcr.io/valhalla/valhalla-scripted:latest`
- **Data:** Geofabrik US OSM PBF extract (~9 GB raw, ~18 GB built graph)
- **Hosting:** Cloud Run (2 vCPU / 4 GB RAM, scales to zero, ~$5-15/mo)
- **Tile storage:** GCS bucket (~$0.30/mo for 18 GB)
- **Port:** `RoutingPort` at `packages/ports/src/routing.port.ts`
- **Adapter:** `ValhallaRoutingAdapter` at `packages/adapters/src/routing/valhalla-adapter.ts`

### Key Valhalla endpoints for this feature

| Endpoint | Purpose for artist routing |
|---|---|
| `/route` | Compute the driving corridor from start city to end city |
| `/sources_to_targets` | Time-distance matrix: rank all candidate venues by actual drive time from the route corridor |
| `/optimized_route` | Given confirmed stops, reorder for minimum total drive time (TSP solver) |
| `/isochrone` | "Show me all venues within 30 min of my route" — corridor buffer visualization |

---

## Data Model

### New model: `TourRequest`

```prisma
model TourRequest {
  id                 String            @id @default(uuid())
  humanId            String

  title              String            // "Fall Southeast Run"
  startCity          String            // "Nashville, TN"
  startLat           Float
  startLng           Float
  endCity            String            // "Austin, TX"
  endLat             Float
  endLng             Float
  startDate          DateTime
  endDate            DateTime

  // Preferences
  maxDriveMiles      Int               @default(300)  // max between stops
  preferredDaysOff   Int               @default(1)    // rest days per week
  acceptsVenues      Boolean           @default(true)
  acceptsOutdoor     Boolean           @default(true)
  minimumCapacity    Int?              // don't book me in a room of 5

  // Tour-specific logistics (per-request, not on profile)
  needsCrashSpace    Boolean           @default(false)
  needsBackline      Boolean           @default(false)
  needsPA            Boolean           @default(false)
  hasOwnPA           Boolean           @default(false)
  vehicleType        String?           // "2015 Transit 350"
  minimumGuarantee   Int?              // cents — null = door deal fine
  genreFilter        String[]          @default([])  // filter venues by genre compatibility

  // Route geometry (cached from Valhalla /route response)
  routeGeometry      String?           // encoded polyline from Valhalla
  routeDistanceM     Int?              // total route distance in meters
  routeTimeS         Int?              // total route time in seconds

  status             TourRequestStatus @default(DRAFT)

  human              Human             @relation(fields: [humanId], references: [id], onDelete: Cascade)
  stops              TourStop[]
  matches            TourMatch[]

  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  @@index([humanId, status])
  @@index([startDate])
}

enum TourRequestStatus {
  DRAFT              // artist is still editing
  SEEKING            // actively looking for stops — matching engine runs
  PARTIALLY_BOOKED   // some stops confirmed
  FULLY_BOOKED       // all dates filled
  ON_TOUR            // tour is happening
  COMPLETED          // all shows played
  CANCELLED
}
```

### New model: `TourMatch`

Candidate venues/hosts returned by the matching engine. The artist reviews these and converts the good ones into BookingRequests.

```prisma
model TourMatch {
  id                 String          @id @default(uuid())
  tourRequestId      String
  placeId            String

  // Match quality signals
  driveTimeFromRoute Int             // seconds from nearest point on route corridor
  driveDistanceM     Int             // meters from nearest route point
  genreScore         Float           @default(0)  // 0-1 genre overlap
  payScore           Float           @default(0)  // 0-1 based on PlaceStats payout data
  reviewScore        Float           @default(0)  // 0-1 based on PlaceStats overall ratings
  logisticsScore     Float           @default(0)  // 0-1 based on gear/crash space match
  compositeScore     Float           @default(0)  // weighted aggregate

  // Availability (from PlaceAvailability)
  availableDates     DateTime[]      // which tour dates this place is available

  // Artist action
  dismissed          Boolean         @default(false)  // artist passed on this one
  bookingRequestId   String?         @unique  // if artist sent a booking request

  tourRequest        TourRequest     @relation(fields: [tourRequestId], references: [id], onDelete: Cascade)
  place              Place           @relation(fields: [placeId], references: [id], onDelete: Cascade)
  bookingRequest     BookingRequest? @relation(fields: [bookingRequestId], references: [id], onDelete: SetNull)

  createdAt          DateTime        @default(now())

  @@unique([tourRequestId, placeId])
  @@index([tourRequestId, compositeScore])
  @@index([placeId])
}
```

### New model: `TourStop`

Confirmed stops on the tour. Created when a BookingRequest is accepted and an Agreement is formed.

```prisma
model TourStop {
  id                 String          @id @default(uuid())
  tourRequestId      String
  placeId            String
  date               DateTime
  city               String
  state              String?

  // Links
  eventId            String?         @unique  // once the show event is created
  agreementId        String?         @unique  // the deal
  bookingRequestId   String?         @unique  // the original pitch

  status             TourStopStatus  @default(CONFIRMED)
  notes              String?

  tourRequest        TourRequest     @relation(fields: [tourRequestId], references: [id], onDelete: Cascade)
  place              Place           @relation(fields: [placeId], references: [id], onDelete: Cascade)
  event              Event?          @relation(fields: [eventId], references: [id], onDelete: SetNull)

  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  @@index([tourRequestId, date])
  @@index([placeId])
}

enum TourStopStatus {
  CONFIRMED          // booking accepted, show is on
  CANCELLED          // fell through
  COMPLETED          // show happened
}
```

### Changes to existing models

**BookingRequest** — add optional tour link:

```prisma
// Add to BookingRequest in agreement.prisma:
tourMatchId     String?   @unique
tourMatch       TourMatch? @relation(fields: [tourMatchId], references: [id], onDelete: SetNull)
```

**Place** — add reverse relations:

```prisma
// Add to Place in place.prisma:
tourMatches     TourMatch[]
tourStops       TourStop[]
```

---

## Matching Algorithm

### Step 1: Compute the route corridor

Call Valhalla `/route` with start and end cities. Cache the polyline on `TourRequest.routeGeometry`.

### Step 2: Find candidate venues

Query all Places where:
- `status = ACTIVE`
- Has lat/lng coordinates
- Within `maxDriveMiles` of any point on the route corridor (use Valhalla `/sources_to_targets` with route waypoints as sources and venue coordinates as targets)
- Has at least one available date in the tour date range (query `PlaceAvailability`)

### Step 3: Score each candidate

| Signal | Weight | Source | Scoring |
|---|---|---|---|
| **Drive time from route** | 25% | Valhalla `/sources_to_targets` | Inverse linear: 0 min = 1.0, maxDriveMiles = 0.0 |
| **Genre compatibility** | 25% | `PlaceStats.genreCloud` vs `TourRequest.genreFilter` (or `Human.genreTags`) | Jaccard overlap of genre tags |
| **Pay history** | 20% | `PlaceStats.payoutMeanCents`, `payoutMedianCents` | Normalized against artist's `minimumGuarantee`. Above minimum = 1.0, below = proportional |
| **Review quality** | 15% | `PlaceStats.promotionScore`, `soundScore`, `bookerScore`, `wouldPlayAgainPct` | Weighted average of available scores |
| **Logistics match** | 15% | `PlaceStats.stageEquipmentScore`, place capacity vs artist minimum | Binary checks: has PA if artist needs PA, capacity >= minimum |

### Step 4: Store matches

Write ranked `TourMatch` rows. Artist reviews them in the UI.

### Step 5: Optimize confirmed stops

When the artist has confirmed multiple stops, call Valhalla `/optimized_route` to suggest the optimal ordering. Artist can override.

---

## Use Cases

### `create-tour-request.ts`

```
Input:  { humanId, title, startCity, endCity, startDate, endDate, preferences }
Steps:
  1. Geocode startCity and endCity via Geoapify.
  2. Create TourRequest in DRAFT status.
  3. Return the request.
Error codes: invalid_input (bad city, dates in past, end before start)
```

### `activate-tour-request.ts`

```
Input:  { tourRequestId, humanId }
Steps:
  1. Set status to SEEKING.
  2. Call Valhalla /route for the corridor. Cache geometry.
  3. Run the matching algorithm (steps 2-4 above).
  4. Write TourMatch rows.
  5. Return match count.
Error codes: not_found, forbidden (not your request), dependency_failed (Valhalla down)
```

### `send-tour-booking-request.ts`

```
Input:  { tourMatchId, humanId, message, preferredDate }
Steps:
  1. Validate the TourMatch exists and belongs to this human's TourRequest.
  2. Create a BookingRequest (reuse existing model) with:
     - placeId from the match
     - artistHumanId = humanId
     - message (artist's pitch)
     - preferredDates = [preferredDate]
     - genre = human.genreTags
     - links = from EntityPage / EPK
  3. Link BookingRequest to TourMatch.
  4. Return the BookingRequest.
Error codes: not_found, forbidden, conflict (already sent)
```

### `confirm-tour-stop.ts`

```
Input:  { tourRequestId, bookingRequestId, humanId }
Steps:
  1. BookingRequest must be ACCEPTED with a linked Agreement.
  2. Create a TourStop from the match + agreement.
  3. If all tour dates are filled, set TourRequest status to FULLY_BOOKED.
  4. Return the TourStop.
```

### `optimize-tour-order.ts`

```
Input:  { tourRequestId, humanId }
Steps:
  1. Fetch all confirmed TourStops.
  2. Call Valhalla /optimized_route with stop coordinates.
  3. Return suggested ordering with drive times between stops.
  4. (Does NOT reorder automatically — artist reviews and accepts.)
```

---

## Tour Route Ratings (Post-Tour)

After a completed tour, the artist can rate the route:

### `rate-tour.ts`

```
Input:  { tourRequestId, humanId, overallRating: 1-5, routeNotes?: string }
Steps:
  1. TourRequest must be COMPLETED.
  2. Store rating on TourRequest (new fields: tourRating, tourRatingNotes).
  3. Per-stop: each TourStop already generates a PlaceReview via the normal
     review flow. The tour context is captured via the TourStop → Event link.
```

This is the "rating tour routes" concept — complex in theory, but it decomposes into: per-venue reviews (already built) + overall tour quality rating (one new field). The aggregation happens naturally: PlaceStats already rolls up reviews, and HumanStats already tracks artist performance.

---

## UI

### Tour Planning View

```
┌──────────────────────────────────────────────────────────────┐
│  Fall Southeast Run                                          │
│  Nashville, TN → Austin, TX  •  Oct 12–18  •  SEEKING       │
│                                                              │
│  ┌──────────────────────────────────┐  ┌──────────────────┐  │
│  │ [MapLibre map showing:]         │  │ Matches (14)     │  │
│  │  - Route corridor polyline      │  │                  │  │
│  │  - Candidate venues as pins     │  │ ★ The Basement   │  │
│  │  - Confirmed stops highlighted  │  │   Memphis, TN    │  │
│  │  - Isochrone buffer around      │  │   Score: 92%     │  │
│  │    route                        │  │   Pays: $200-400 │  │
│  │                                 │  │   [Send Pitch →] │  │
│  │                                 │  │                  │  │
│  │                                 │  │ ★ Lamberts       │  │
│  │                                 │  │   Austin, TX     │  │
│  │                                 │  │   Score: 88%     │  │
│  │                                 │  │   Pays: $150-350 │  │
│  │                                 │  │   [Send Pitch →] │  │
│  └──────────────────────────────────┘  │                  │  │
│                                        │ ...              │  │
│  Confirmed Stops:                      └──────────────────┘  │
│  Oct 13 — The Basement, Memphis  ✓                           │
│  Oct 15 — TBD (looking)                                      │
│  Oct 17 — Lamberts, Austin  ✓                                │
│                                                              │
│  [Optimize Route Order]  [Export to Google Maps]             │
└──────────────────────────────────────────────────────────────┘
```

- Left panel: MapLibre map with route, matches, and confirmed stops
- Right panel: ranked match list with composite score, pay range, genre tags, and "Send Pitch" CTA
- Bottom: confirmed stops timeline with gaps highlighted
- "Optimize Route Order" calls Valhalla TSP solver
- "Export to Google Maps" generates multi-stop deep link

### Venue/Host Side

Venues that receive a tour booking request see a badge:

> "🎸 Tour request — [Artist Name] is passing through [City] on their [Tour Title]. [View pitch →]"

The booking request flow is the existing one — the only difference is the request originated from a tour match rather than a direct pitch.

---

## Attendee-Facing Features (Preserved from Original Spec)

The original Valhalla spec's attendee features — "plan my night," isochrone discovery on the event map, multi-event itinerary — are still valid and can be built using the same infrastructure. They're just P3 now, not the primary use case.

---

## Acceptance Criteria

- [ ] Artist can create a TourRequest with start/end cities, dates, and preferences
- [ ] Activating a request computes the Valhalla route and runs the matching algorithm
- [ ] TourMatch rows are created with composite scores from genre, pay, review, logistics, and drive time
- [ ] Artist can send a BookingRequest from a TourMatch (reuses existing booking flow)
- [ ] Confirmed BookingRequests create TourStops
- [ ] Valhalla `/optimized_route` suggests stop ordering for confirmed stops
- [ ] Tour map shows route corridor, candidate venues, and confirmed stops
- [ ] Per-request logistics fields (crash space, PA, backline) are on TourRequest, not on Human profile
- [ ] Post-tour rating: overall tour rating stored on TourRequest
- [ ] Venue-level reviews flow through existing PlaceReview system

---

## Open Questions

- **Corridor buffer distance:** How wide should the search corridor be around the route? The `maxDriveMiles` field caps it, but should we also use Valhalla isochrones to compute the exact reachable area? Isochrones are more accurate but more expensive (one API call per route waypoint). Start with crow-flies buffer, graduate to isochrones if matching quality is poor.
- **Refresh matches:** If a TourRequest stays in SEEKING for days, should we re-run the matching algorithm periodically (e.g., if new venues are added or availability changes)? Probably yes — add a `lastMatchedAt` timestamp and re-run if stale.
- **Bulk pitch:** Should the artist be able to send booking requests to multiple matches at once (e.g., "pitch all 5 Memphis venues")? Probably yes for UX, but needs rate limiting to prevent spam. Defer to implementation.
- **Transit routing:** Valhalla supports GTFS feeds for public transit. Irrelevant for touring artists in vans. Skip.

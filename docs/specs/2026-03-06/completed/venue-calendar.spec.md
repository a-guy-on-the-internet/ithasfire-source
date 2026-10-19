# Venue Calendar

> **Status:** complete
> **Domain:** Places, Events, Admin UI, Embeds
> **Depends on:** `Place`, `PlaceOwnership`, `Event`, venue-event-proposals (optional but recommended)

---

## 1. Problem

Event creators have no way to see what's already booked at a venue before
picking dates. Venue owners have no unified view of their lineup. And once
Ithas Fire supports the venue-event-proposal flow, there's no calendar to
review incoming proposals against existing bookings.

## 2. Goals

1. **Venue owners** see a calendar of all events at their place(s) from their
   admin dashboard, with status indicators (CONFIRMED, PENDING, DRAFT).
2. **Event creators** see occupied time slots when selecting a venue in the
   event builder, reducing double-bookings and back-and-forth.
3. **Public visitors** see an upcoming-events calendar on the venue's public
   profile page and in embeddable widgets.
4. **Embed consumers** (venue websites, third-party pages) render a
   branded calendar widget showing confirmed upcoming events with
   ticket purchase links.

## 3. Data model

### 3.1 No new tables required

The calendar is a **view** over existing data:

- `Event` records where `placeId = <this place>` and status is
  PUBLISHED / DRAFT / COMPLETED.
- If venue-event-proposals are implemented, filter by
  `placeEventStatus` (CONFIRMED for public, PENDING + CONFIRMED for
  owner views).
- Time range queries on `startsAt` / `endsAt`.

### 3.2 Recommended index additions

```prisma
// Already exists via the Place relation, but a composite helps calendar queries:
@@index([placeId, startsAt])
@@index([placeId, status, startsAt])
```

### 3.3 Optional: `PlaceCalendarSettings`

A future model for venue-specific preferences. Not needed for v1.

```prisma
model PlaceCalendarSettings {
  id                 String   @id @default(uuid())
  placeId            String   @unique
  autoConfirmEvents  Boolean  @default(false)
  bufferMinutes      Int      @default(0)    // gap between events
  operatingHoursJson Json?                   // e.g. {"mon": ["10:00","23:00"], ...}
  blackoutDatesJson  Json?                   // e.g. ["2026-12-25","2026-01-01"]
  place              Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

## 4. Use cases

### 4.1 `getVenueCalendar` (authenticated, owner/member)

Returns all events at a place within a time range, grouped by day. Includes
DRAFT, PENDING, CONFIRMED, and PUBLISHED events visible to the venue owner.

**Input:**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| placeId | uuid | Yes | |
| actorHumanId | uuid | Yes | Must be a place owner or org member |
| from | DateTime | Yes | Start of window |
| to | DateTime | Yes | End of window (max 90 days) |

**Output:**

```typescript
{
  events: Array<{
    eventId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    status: EventStatus;
    placeEventStatus?: PlaceEventStatus; // if proposals enabled
    orgName: string | null;
    creatorName: string | null;
    expectedAttendance: number | null;    // sum of ticket type capacities
  }>;
  conflicts: Array<{
    eventAId: string;
    eventBId: string;
    overlapMinutes: number;
  }>;
}
```

**RBAC:** Actor must hold `PlaceOwnership` (any verified status) or be a
member of an org that holds ownership. Same check as `getPlaceForEdit`.

### 4.2 `getPublicVenueCalendar` (unauthenticated)

Returns only PUBLISHED events at a VERIFIED place. Used by the public
venue profile page and the embeddable calendar widget.

**Input:**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| placeId or placeSlug | string | Yes | Supports slug for public URLs |
| from | DateTime | No | Defaults to now |
| to | DateTime | No | Defaults to now + 90 days |
| limit | number | No | Default 20, max 50 |
| offset | number | No | Default 0 |

**Output:** Same `events` array as above but without `placeEventStatus`
or `creatorName`. Adds `ticketAvailability` summary per event:

```typescript
{
  events: Array<{
    eventId: string;
    slug: string | null;
    title: string;
    startsAt: Date;
    endsAt: Date;
    primaryImageUrl: string | null;
    priceRange: { minCents: number; maxCents: number } | null;
    soldOut: boolean;
    city: string | null;
    region: string | null;
  }>;
  pageInfo: { total, limit, offset, hasMore };
}
```

**RBAC:** None (public). Place must be VERIFIED and ACTIVE.

### 4.3 `getAvailableSlots` (authenticated, event builder)

Used in the event builder when a creator selects a venue. Returns a
simplified view of occupied time ranges so the UI can gray out or warn
about conflicts.

**Input:**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| placeId | uuid | Yes | |
| from | DateTime | Yes | |
| to | DateTime | Yes | Max 30 days |

**Output:**

```typescript
{
  occupiedSlots: Array<{
    startsAt: Date;
    endsAt: Date;
    eventTitle: string; // for tooltip context
  }>;
  bufferMinutes: number; // from PlaceCalendarSettings, default 0
}
```

**RBAC:** Any authenticated user. Only exposes time ranges and titles
of PUBLISHED events (no private data).

## 5. UI surfaces

### 5.1 Admin dashboard (venue owner)

- **Location:** `apps/web/src/app/admin/[slug]/places/[placeId]/calendar/`
- **View:** Month/week/day toggle. Events color-coded by status:
  - CONFIRMED/PUBLISHED: primary color
  - PENDING: amber/dashed border
  - DRAFT: gray
- **Interactions:** Click event to view details. Click PENDING to
  confirm/decline (links to proposal review). Click empty slot to
  "suggest an event here" (future).
- **Navigation:** Add to `ADMIN_SECTIONS` in the places sub-layout.

### 5.2 Event builder (date picker)

- **Location:** Within the event builder's date/time section, after a
  place is selected.
- **View:** Small inline calendar showing occupied slots as colored
  blocks. Selecting a conflicting time shows a yellow warning (not a
  blocker).
- **Data source:** `getAvailableSlots` use case.

### 5.3 Public venue profile

- **Location:** `apps/web/src/app/places/[slug]/` (or similar public route)
- **View:** List or card grid of upcoming events. Optional calendar
  toggle for month view.
- **Data source:** `getPublicVenueCalendar` use case.

### 5.4 Embeddable widget

- See `embeddable-event-widgets.spec.md` for full embed architecture.
- The calendar variant uses `getPublicVenueCalendar` with the
  embed token for auth/domain validation.

## 6. Conflict detection

Conflicts are informational, not blocking (v1). The `getVenueCalendar`
use case computes overlaps:

```typescript
function detectConflicts(events: { startsAt: Date; endsAt: Date; id: string }[]) {
  const sorted = [...events].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const conflicts = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startsAt < sorted[i].endsAt) {
        const overlapMs = sorted[i].endsAt.getTime() - sorted[j].startsAt.getTime();
        conflicts.push({
          eventAId: sorted[i].id,
          eventBId: sorted[j].id,
          overlapMinutes: Math.ceil(overlapMs / 60_000),
        });
      } else break;
    }
  }
  return conflicts;
}
```

Future: `PlaceCalendarSettings.bufferMinutes` extends the effective end
time for conflict detection.

## 7. Relationship to existing code

| Existing | Reuse | Notes |
| -------- | ----- | ----- |
| `listPlaceEvents` use case | Partial | Already queries events by placeId + time window. Extend or create sibling use cases for owner vs public views. |
| `EventRecord` type | Full | Calendar entries map directly to EventRecord fields. |
| `PlaceOwnership` RBAC | Full | Same ownership check pattern as getPlaceForEdit. |
| `PlaceLayout` | None | Calendar doesn't need layout data. |

## 8. Implementation phases

| Phase | Scope | Effort |
| ----- | ----- | ------ |
| **P0** | `getVenueCalendar` use case + admin calendar page | 1-2 days |
| **P1** | `getPublicVenueCalendar` + public venue profile page | 1 day |
| **P2** | `getAvailableSlots` + event builder integration | 1 day |
| **P3** | `PlaceCalendarSettings` + buffer/operating hours | 0.5 day |
| **P4** | Embed widget variant (after embed infra ships) | See embed spec |

## 9. Open questions

1. Should conflict detection block event creation or just warn? (Recommend:
   warn only for v1, venue can decline via proposal flow.)
2. Max calendar range for public queries? (Recommend: 90 days to limit
   query cost.)
3. Should DRAFT events be visible to venue owners? (Recommend: yes, so
   they can see what's coming even before publication.)

---

*This spec pairs with `venue-event-proposals.spec.md` (for PENDING/CONFIRMED
status filtering) and `embeddable-event-widgets.spec.md` (for the public
calendar embed variant).*

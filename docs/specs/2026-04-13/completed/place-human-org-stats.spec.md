# Place, Human & Organization Stats

**Date:** 2026-04-13
**Status:** complete
**Depends on:** Event, Order, Ticket, PlaceReview, EventHuman, Human, Organization (all exist in schema)
**Related:** [Fan Attribution Analytics](fan-attribution-analytics.spec.md)

---

## Problem

Every key actor on Ithas Fire has meaningful performance data locked up in separate tables. Artists performed at ten venues but have no single view of which ones paid well and drew crowds. Venues hosted fifty events but don't know which artist brought more repeat attendees. Organizations run multiple venues but have no consolidated picture of what's working.

This spec defines the three stat surfaces that surface that data back to the actors who generated it — each scoped correctly by role and privacy rules.

---

## Core Concept: Three Interlocking Stat Surfaces

Stats are not isolated per-entity computations. They share the same underlying data sources (reviews, events, orders/tickets) and reference each other naturally:

- A **PlaceStat** for a venue is shaped by the artists who played there.
- A **HumanStat** for an artist is shaped by the venues where they drew crowds.
- An **OrgStat** is shaped by both the places it manages and the artists it books.

All three follow the same architectural pattern: aggregated facts computed from canonical transactions, stored as materialized stats updated by background jobs, exposed through role-scoped queries.

---

## Data Model

### PlaceStats

Aggregate performance facts for a single `Place` (venue). Updated by a background job when new reviews or completed events arrive.

```prisma
model PlaceStats {
  id              String   @id @default(uuid())
  placeId         String   @unique

  // ── Review-derived metrics ──────────────────────────────────────
  totalReviews    Int      @default(0)
  avgRating       Float?   // null until >= 3 reviews
  avgPayScore     Float?
  avgSoundScore   Float?
  avgCrowdScore   Float?
  avgStaffScore   Float?
  avgCapacity     Float?   // reviewer-reported turnout as % of stated cap

  // ── Event / ticketing-derived metrics ───────────────────────────
  totalEventsHosted     Int    @default(0)
  totalTicketsSold      Int    @default(0)
  avgTicketsPerEvent    Float?
  avgDrawByGenre        Json?  // { genre: string; avgTickets: number }[]
  topArtistHumanIds     Json?  // [humanId, ...] top 5 by attributed draw

  // ── Social ────────────────────────────────────────────────────────
  followerCount         Int    @default(0)  // from EntityFollow; see follows.spec.md

  // ── Trend windows ───────────────────────────────────────────────
  last90DayReviews      Int    @default(0)
  last90DayTickets      Int    @default(0)

  computedAt      DateTime @default(now())
  place           Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)

  @@index([placeId])
}
```

### HumanStats

Aggregate performance facts for a single `Human` (artist/performer). Updated when attribution data is finalized or a new event they performed at closes.

```prisma
model HumanStats {
  id              String   @id @default(uuid())
  humanId         String   @unique

  // ── Attribution-derived draw metrics ────────────────────────────
  totalEventsPerformed  Int    @default(0)
  totalTicketsAttributed Int   @default(0)  // from TicketAttribution
  avgDrawPerEvent       Float?
  topCities             Json?  // { city: string; state?: string; country: string; tickets: number }[]
  topPlaceIds           Json?  // [placeId, ...] top 5 venues by attributed draw
  topGenres             Json?  // [genre, ...] top 5 genres

  // ── Channel performance (UTM-derived) ───────────────────────────
  /// Attribution source breakdown: { source: "instagram" | ...; tickets: number }[]
  channelBreakdown     Json?

  // ── Fan metrics (consent-gated; see Privacy section) ────────────
  totalConsentedFans   Int    @default(0)   // fans with trackingConsent=GRANTED
  repeatFanCount       Int    @default(0)   // fans attributed to 2+ events

  // ── Social ────────────────────────────────────────────────────────
  followerCount         Int    @default(0)  // from EntityFollow; see follows.spec.md

  // ── Trend windows ───────────────────────────────────────────────
  last90DayTickets     Int    @default(0)
  last90DayEvents      Int    @default(0)

  computedAt      DateTime @default(now())
  human           Human    @relation(fields: [humanId], references: [id], onDelete: Cascade)

  @@index([humanId])
}
```

### OrgStats

Aggregate performance facts for an `Organization` (promoter, venue owner). Updated when events belonging to the org's venues close.

```prisma
model OrgStats {
  id              String   @id @default(uuid())
  orgId           String   @unique

  // ── Event / ticketing-derived metrics ───────────────────────────
  totalEventsOrganized  Int    @default(0)
  totalTicketsSold      Int    @default(0)
  totalVenues           Int    @default(0)   // distinct places events were held at
  avgTicketsPerEvent    Float?
  topPlaceIds           Json?  // [placeId, ...] top 5 by ticket volume
  topArtistHumanIds     Json?  // [humanId, ...] top 5 by draw across org events

  // ── Audience metrics ────────────────────────────────────────────
  uniqueAttendees       Int    @default(0)   // distinct Human buyers across all org events
  repeatAttendees       Int    @default(0)   // buyers who attended 2+ org events

  // ── Attribution breakdown ────────────────────────────────────────
  /// Per-event attribution summary (aggregated, no fan PII)
  /// { eventId: string; attributed: number; walkIn: number }[]
  attributionSummary    Json?

  // ── Genre mix ───────────────────────────────────────────────────
  topGenres             Json?  // [genre, ...] top 5 by ticket volume

  // ── Social ────────────────────────────────────────────────────────
  followerCount         Int    @default(0)  // from EntityFollow; see follows.spec.md

  // ── Trend windows ───────────────────────────────────────────────
  last90DayTickets      Int    @default(0)
  last90DayEvents       Int    @default(0)

  computedAt      DateTime @default(now())
  org             Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId])
}
```

### Modifications to Existing Models

**Place** — add relation:
```prisma
  stats    PlaceStats?
```

**Human** — add relation:
```prisma
  stats    HumanStats?
```

**Organization** — add relation:
```prisma
  stats    OrgStats?
```

---

## Computation Strategy

Stats are **not computed inline on read**. They are materialized by background jobs, indexed once, and read cheaply. Inline re-computation is retained only for preview/admin contexts.

### Trigger Sources

| Trigger event | Recomputes |
| --- | --- |
| Place review submitted or updated | `PlaceStats` for that place |
| Order finalized (tickets sold) | `PlaceStats`, `HumanStats` for attributed performers, `OrgStats` for org |
| Event cancelled | `PlaceStats`, `OrgStats` (subtract provisional counts) |
| `TicketAttribution` consent state changes | `HumanStats.totalConsentedFans`, `HumanStats.repeatFanCount` |
| Artist (EventHuman) added to event | No stat change until order close |

### Job Contract

Each stat surface has one dedicated job:

| Job | Trigger | Input | Output |
| --- | --- | --- | --- |
| `compute-place-stats` | Review/order event | `placeId` | Upsert `PlaceStats` |
| `compute-human-stats` | Attribution finalized | `humanId` | Upsert `HumanStats` |
| `compute-org-stats` | Order finalized | `orgId` | Upsert `OrgStats` |

Jobs must be idempotent (safe on retry). Use the existing `IdempotencyPort` pattern with key `{jobName}:{entityId}:{eventVersion}`.

---

## Query Layer

All three stat surfaces are exposed as tRPC queries. Visibility is role-scoped.

### Transport Contracts

**`place.getStats`**
- Input: `{ placeId: string }`
- Output: `PlaceStats` (public-facing fields only; no raw review text)
- Auth: public (no auth required for aggregate scores; UTM/channel data suppressed)

**`human.getStats`**
- Input: `{ humanId: string }`
- Output: `HumanStats` (fan-level aggregate counts; no raw fan PII)
- Auth: must be the Human themselves or platform admin

**`org.getStats`**
- Input: `{ orgId: string }`
- Output: `OrgStats`
- Auth: org member (`ensureOrgRole` MEMBER or above)

### Public vs Private Fields

| Field group | PlaceStats | HumanStats | OrgStats |
| --- | --- | --- | --- |
| Aggregate scores (ratings, draw counts) | Public | Self only | Org member only |
| City/venue breakdowns | Public (genre only) | Self only | Org member only |
| Fan-level ID or email data | Never exposed | Never in stats layer | Never in stats layer |
| UTM channel breakdown | — | Self only | — |
| Attribution per-event table | — | Self only | Org member only |

---

## Visibility Thresholds

Stats are suppressed from public display until sufficient data exists to prevent reverse-engineering individual reviews.

| Surface | Threshold | What is suppressed |
| --- | --- | --- |
| `PlaceStats` avg scores | `totalReviews >= 3` | `avgRating`, `avgPayScore`, `avgSoundScore`, `avgCrowdScore`, `avgStaffScore` |
| `PlaceStats` public display | `totalReviews >= 20` | Entire public card |
| `HumanStats` draw data | `totalEventsPerformed >= 1` | No hard threshold; always visible to self |
| `OrgStats` | `totalEventsOrganized >= 1` | No hard threshold; always visible to org members |

---

## Interrelationship: How the Three Connect

The three stat surfaces reference each other and can be cross-queried:

```
PlaceStats.topArtistHumanIds  →  HumanStats (for each artist)
HumanStats.topPlaceIds        →  PlaceStats (for each venue)
OrgStats.topPlaceIds          →  PlaceStats (for each org venue)
OrgStats.topArtistHumanIds    →  HumanStats (for each booked artist)
```

Example use cases:
- "Which artists drew the best at our venue?" → `OrgStats.topArtistHumanIds` → `HumanStats` cross-reference
- "Which venues pay the best?" → `HumanStats.topPlaceIds` → `PlaceStats.avgPayScore`
- "Is this artist growing in our city?" → `HumanStats.topCities` trend over time

This cross-reference graph is what unlocks the booking-intelligence use cases: an artist can compare venues, an org can compare artists, a venue's public profile shows how calibrated their scores are.

---

## Privacy & Access Boundaries

Stats are aggregate by design — no fan PII flows through this layer. The boundary rules:

1. Fan identity never enters stats. All fan metrics are counts only (`totalConsentedFans`, `repeatFanCount`).
2. `HumanStats` is always gated behind self-auth. An artist sees their own stats, nobody else's fan data.
3. `OrgStats` shows cross-event headcounts but no names or emails.
4. `PlaceStats` public fields show aggregate review scores only. Attribution data (which artists played) is linkable but not exposed as raw fan data.
5. Consent state changes propagate to `HumanStats.totalConsentedFans` counts via the `compute-human-stats` job.

---

## Implementation Checklist

- [ ] Create `PlaceStats` model + migration
- [ ] Create `HumanStats` model + migration
- [ ] Create `OrgStats` model + migration
- [ ] Add inverse relations to Place, Human, Organization
- [ ] Implement `compute-place-stats` job (review + order triggers)
- [ ] Implement `compute-human-stats` job (attribution finalized trigger)
- [ ] Implement `compute-org-stats` job (order finalized trigger)
- [ ] Wire idempotency keys for all three jobs
- [ ] Add `place.getStats` tRPC query with public-field projection
- [ ] Add `human.getStats` tRPC query with self-auth gate
- [ ] Add `org.getStats` tRPC query with org-member auth gate
- [ ] Apply visibility thresholds in query projection (not in DB; compute at read time)
- [ ] Expose `PlaceStats` on place public profile page
- [ ] Expose `HumanStats` on artist dashboard ("My Draw" surface from attribution spec)
- [ ] Expose `OrgStats` on org admin dashboard ("Event Intelligence" surface from attribution spec)

---

## Test & Acceptance Matrix

1. **Place stats computed after review submitted**
   - Given a completed place review
   - When `compute-place-stats` runs
   - Then `PlaceStats.totalReviews` increments and `avgPayScore` is updated.

2. **Place avg scores suppressed below threshold**
   - Given `PlaceStats.totalReviews = 2`
   - When `place.getStats` is queried
   - Then `avgRating`, `avgPayScore`, etc. return `null` in the public response.

3. **Human stats computed after attribution finalized**
   - Given a finalized `TicketAttribution` record
   - When `compute-human-stats` runs
   - Then `HumanStats.totalTicketsAttributed` increments and `topCities` reflects the fan's location.

4. **Human stats gated to self**
   - Given a human with stats
   - When queried by a different authenticated user
   - Then the query returns `forbidden`.

5. **Org stats include cross-event repeat attendees**
   - Given two events by the same org with one overlapping buyer
   - When `compute-org-stats` runs
   - Then `OrgStats.repeatAttendees = 1` and `uniqueAttendees = n`.

6. **Job is idempotent on duplicate delivery**
   - Given the same trigger fires twice for the same entity/version
   - When both job runs reach persistence
   - Then exactly one stat upsert is committed.

7. **Consent change propagates to HumanStats count**
   - Given a `TicketAttribution` row where consent changes from `GRANTED` to `DENIED`
   - When `compute-human-stats` runs
   - Then `HumanStats.totalConsentedFans` decrements accordingly.

8. **Fan PII never appears in any stats query**
   - Given any of the three stats queries are called by any role
   - When response is inspected
   - Then no `fanHumanId`, email, or name fields are present.

---

## Relationship to Fan Attribution Analytics

`HumanStats` is the aggregated read surface for data generated by [fan attribution](fan-attribution-analytics.spec.md). Where attribution stores the raw ordered facts, `HumanStats` stores the computed summaries artists actually see in their dashboard. The two complement each other:

| Attribution spec | Stats spec |
| --- | --- |
| `TicketAttribution` row per order | `HumanStats` aggregation across all orders |
| REF_LINK / CHECKOUT_SELECT / NONE source | `channelBreakdown` rollup |
| Fan city on attribution row | `topCities` array |
| Consent GRANTED/DENIED per row | `totalConsentedFans` count |
| Raw fan list (role-gated export) | Never in stats layer |

---

## Standards Alignment

- `docs/engineering-standards.md` section 4.2 (single transaction + audit logging per mutation), section 5 (use-case/adapter split for job logic), section 6 (idempotency).
- `docs/hot-paths.md` sections "Idempotency and concurrency" and "Security and access control".
- Background job conventions: `docs/jobs.md`.

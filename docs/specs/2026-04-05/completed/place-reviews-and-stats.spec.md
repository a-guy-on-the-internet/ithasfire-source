# Place Reviews & Place Stats

**Date:** 2026-04-05
**Status:** complete
**Depends on:** Place model, Human model, Event model

---

## Summary

Two-sided review system for Places (venues). Artists review venues they've played at. Venues can claim listings and respond. Aggregated stats are computed with real statistical methods (mean, median, standard deviation) from actual payout numbers — not pre-bucketed ranges. Every structured dropdown field has a freeform companion so the human voice is captured alongside the data point. Genre is freeform — never an enum.

The system serves dual purpose:
1. **Seed phase (pre-launch):** Public "Rate a Venue" form on the coming soon homepage. No login required. Collects structured data + freeform detail. Captures emails for waitlist.
2. **Platform phase (post-launch):** Per-event reviews prompted to performing artists 24-48 hours after an event. Linked to real eventId, cross-referenced against settlement data for verification.

---

## Design Decisions (2026-04-06)

1. **`Human.placeReviews PlaceOwnership[]` — drop and recreate.** The existing field on Human is a mislabeled reverse relation (the reviewer on ownership claims). No adapter code references it. We drop it and replace with the correct `placeReviewsAuthored` and `placeReviewResponses` relations. `PlaceOwnership` itself stays (accessed via `p.placeOwnership` in adapters) and gets renamed to a proper relation field name on Human: `placeOwnershipReviews` (ownership claims this human reviewed).
2. **Static form, no builder extraction.** The 3-page review form has known fields at compile time. Built as a purpose-built component. Generic form builder extraction deferred until a third form type appears.
3. **Stats recalculation as a scheduled job.** `submitPlaceReview` writes the review only. A cron job sweeps places with stale stats (e.g., every 15 min or hourly during seed phase) and recomputes. No inline aggregation, no queue — just a periodic sweep.
4. **Client-side venue search.** Fetch all listable places to the client, filter with substring match. No Meilisearch index on places until dataset scale warrants it (50k+).
5. **Dedup strategy.** We assume each review is unique. No hard unique constraint — dedup is deferred to the stats job which can detect and skip obvious duplicates if needed. The data is messy by nature (anonymous, self-reported dates) and a rigid constraint would reject legitimate reviews.
6. **All multi-choice/enum fields are required.** All freeform companion fields (`*Detail`, `comment`, `genre`) are optional.
7. **`bookerRating` is an enum** (`PlaceReviewBookerRating`: `EXCELLENT`, `GOOD`, `OKAY`, `POOR`, `TERRIBLE`) not a raw Int.
8. **Stub places are hidden until verified.** New `Place.listedInDirectory` Boolean (default `false`). Places from verified sources (PRO imports, Google Places) get `listedInDirectory: true`. User-submitted stub places remain unlisted until platform admin approves. Platform admin page gets a toggle.
9. **Venue responses are immediately public.** No moderation step — the venue owner typed it, it's their name on it.
10. **Review visibility:** Only platform admins can hide reviews (`hidden = true`). Venue owners and any authed user can flag reviews (`flagged = true`) which surfaces them for platform review. Flagged reviews remain visible until a platform admin hides them.
11. **Coming soon page is a separate page component** swapped in/out based on feature gate, not a branch inside the existing homepage.

---

## Data Model

### New file: `packages/db/prisma/place-review.prisma`

```prisma
model PlaceReview {
  id              String   @id @default(uuid())
  placeId         String

  // Auth: nullable for seed-phase anonymous reviews
  humanId         String?

  // Anonymous reviewer info (seed phase only)
  anonymousName   String?
  anonymousEmail  String?

  // ── Payout (actual number + context) ──────────────────────────────
  payoutCents     Int?              // actual dollar amount in cents — nullable if they skip
  paymentMethod   PlaceReviewPaymentMethod
  paymentDetail   String?  @db.VarChar(500)

  // ── Promotion ─────────────────────────────────────────────────────
  venuePromoted   PlaceReviewPromotionLevel
  promotionDetail String?  @db.VarChar(500)

  // ── Sound & Stage Equipment ───────────────────────────────────────
  soundQuality    PlaceReviewSoundQuality
  soundDetail     String?  @db.VarChar(500)

  stageEquipment        PlaceReviewStageEquipment
  stageEquipmentDetail  String?  @db.VarChar(500)

  // ── Audience ──────────────────────────────────────────────────────
  audienceFit     PlaceReviewAudienceFit
  audienceDetail  String?  @db.VarChar(500)

  // ── Parking & Load-In ─────────────────────────────────────────────
  parkingLoadIn       PlaceReviewParking
  parkingDetail       String?  @db.VarChar(500)

  // ── Booker / Staff ────────────────────────────────────────────────
  bookerRating    PlaceReviewBookerRating
  bookerDetail    String?  @db.VarChar(500)

  // ── Overall ───────────────────────────────────────────────────────
  wouldPlayAgain  PlaceReviewPlayAgain
  comment         String?  @db.VarChar(1000)

  // ── Genre (freeform, never an enum) ───────────────────────────────
  genre           String?  @db.VarChar(200)

  // ── Draw ──────────────────────────────────────────────────────────
  estimatedDraw   Int?

  // ── Source tracking ───────────────────────────────────────────────
  source          PlaceReviewSource  @default(SURVEY)
  eventId         String?  // links to specific event for post-event reviews

  // ── Venue response ────────────────────────────────────────────────
  responseText    String?  @db.VarChar(500)
  responseById    String?
  respondedAt     DateTime?

  // ── Moderation ────────────────────────────────────────────────────
  flagged         Boolean  @default(false)
  flagReason      String?
  hidden          Boolean  @default(false)

  place           Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
  human           Human?   @relation("PlaceReviewAuthor", fields: [humanId], references: [id], onDelete: SetNull)
  responseBy      Human?   @relation("PlaceReviewResponder", fields: [responseById], references: [id], onDelete: SetNull)
  event           Event?   @relation("PlaceReviewEvent", fields: [eventId], references: [id], onDelete: SetNull)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([placeId, createdAt])
  @@index([humanId])
  @@index([eventId])
  @@index([source])
}

model PlaceStats {
  id                    String   @id @default(uuid())
  placeId               String   @unique

  reviewCount           Int      @default(0)
  reviewCountPublic     Int      @default(0)

  // Payout stats — computed from actual payoutCents values
  payoutMeanCents       Int?
  payoutMedianCents     Int?
  payoutMinCents        Int?
  payoutMaxCents        Int?
  payoutStdDevCents     Int?
  payoutSampleSize      Int      @default(0)

  // Payment method distribution (percentages)
  payoutGuaranteePct    Float?
  payoutDoorSplitPct    Float?
  payoutTicketSalesPct  Float?
  payoutTipsPct         Float?
  payoutPayToPlayPct    Float?
  payoutUnpaidPct       Float?

  // Scores (0.0 - 1.0)
  promotionScore        Float?
  soundScore            Float?
  audienceFitScore      Float?
  wouldPlayAgainPct     Float?
  bookerScore           Float?
  parkingScore          Float?
  stageEquipmentScore   Float?

  // Draw stats
  drawMean              Int?
  drawMedian            Int?
  drawMin               Int?
  drawMax               Int?
  drawSampleSize        Int      @default(0)

  // Flags — triggered by pattern, not single review
  payToPlayFlagged      Boolean  @default(false)
  equipmentLiedFlagged  Boolean  @default(false)
  noPromotionFlagged    Boolean  @default(false)

  // Genre cloud — JSON array of { genre: string, count: number }
  genreCloud            Json     @default("[]")

  // Transaction-derived stats (post-launch, from real Ithas Fire events)
  totalEventCount       Int      @default(0)
  totalTicketsSold      Int      @default(0)
  avgTicketPriceCents   Int?
  avgAttendance         Int?

  lastCalculatedAt      DateTime @default(now())

  place                 Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)

  @@index([placeId])
  @@index([reviewCountPublic])
}
```

### Enums (add to `enums.prisma`)

```prisma
enum PlaceReviewPaymentMethod {
  GUARANTEE
  DOOR_SPLIT
  TICKET_SALES
  BAR_PERCENTAGE
  TIPS_ONLY
  PAY_TO_PLAY
  UNPAID
  OTHER
}

enum PlaceReviewPromotionLevel {
  ACTIVELY_PROMOTED
  POSTED_ONCE
  NO_PROMOTION
}

enum PlaceReviewSoundQuality {
  GREAT
  ADEQUATE
  BAD
  NONEXISTENT
  LIED_ABOUT_IT
}

enum PlaceReviewStageEquipment {
  FULL
  PARTIAL
  NONE
  LIED_ABOUT_IT
}

enum PlaceReviewAudienceFit {
  PERFECT_FIT
  OKAY
  WRONG_CROWD
}

enum PlaceReviewPlayAgain {
  YES
  MAYBE
  NO
}

enum PlaceReviewParking {
  DEDICATED_LOT
  STREET_NEARBY
  DIFFICULT
  NIGHTMARE
}

enum PlaceReviewBookerRating {
  EXCELLENT
  GOOD
  OKAY
  POOR
  TERRIBLE
}

enum PlaceReviewSource {
  SURVEY
  PLATFORM
  IMPORTED
}
```

### Relations to add

**Place model:** `reviews PlaceReview[]`, `stats PlaceStats?`, and new column `listedInDirectory Boolean @default(false)` — controls visibility in public venue autocomplete. Verified sources set `true` on import; user-submitted stubs stay `false` until platform admin approves.
**Human model:** Drop `placeReviews PlaceOwnership[]` (mislabeled, unused). Add `placeOwnershipReviews PlaceOwnership[]` (correct name for the reviewer reverse relation), `placeReviewsAuthored PlaceReview[] @relation("PlaceReviewAuthor")`, and `placeReviewResponses PlaceReview[] @relation("PlaceReviewResponder")`.
**Event model:** `placeReviews PlaceReview[] @relation("PlaceReviewEvent")`

---

## Aggregation Rules

### Payout statistics
```
payoutMeanCents   = sum(payoutCents) / count(non-null)
payoutMedianCents = middle value sorted
payoutMinCents    = min
payoutMaxCents    = max
payoutStdDevCents = population standard deviation
payoutSampleSize  = count of non-null payoutCents
```

Standard deviation is the killer insight — tells artists whether a venue pays consistently (low stddev) or is a gamble (high stddev).

Cross-correlation opportunity: when both `payoutCents` and `estimatedDraw` exist on the same review, compute payout-per-head at query time. "This venue pays $6/head on average" is data that doesn't exist anywhere.

### Visibility thresholds
| Data | Min reviews |
|------|------------|
| Payout stats (mean, median, range) | 3 |
| Standard deviation | 5 |
| Scores (sound, promotion, audience, booker, parking, equipment) | 2 |
| Would play again % | 3 |
| Draw stats | 3 |
| Flags | 2 independent reports |

### Flag triggers
- `payToPlayFlagged`: >= 2 reviews with `paymentMethod == PAY_TO_PLAY`
- `equipmentLiedFlagged`: >= 2 reviews with `stageEquipment == LIED_ABOUT_IT`
- `noPromotionFlagged`: >= 3 reviews with `venuePromoted == NO_PROMOTION`

### Genre cloud
Freeform genre strings lowercased, trimmed, counted. Top 10 stored as JSON. Heavy normalization deferred — human messiness > false precision.

---

## Use Cases

### `submitPlaceReview` (public, no auth required for seed phase)
- Accepts `placeId` (existing place) OR `placeName` + `city` (new stub)
- If creating a stub Place: sets `verification: UNVERIFIED`, `listedInDirectory: false` (hidden from autocomplete until platform admin approves)
- All enum/multi-choice fields are required; all freeform fields are optional
- Creates PlaceReview record
- Stores `anonymousEmail` for waitlist (does NOT create Human)
- Stats recalculation happens via scheduled job, not inline
- Audit log

### `recalculatePlaceStats` (scheduled job — cron, not inline)
- Runs on a schedule (e.g., every 15 min during seed phase, configurable)
- Sweeps places where `PlaceStats.lastCalculatedAt` is older than the most recent review's `createdAt` (or PlaceStats doesn't exist yet)
- Fetches non-hidden, non-flagged reviews for each stale place
- Computes all aggregation fields
- Upserts PlaceStats

### `getPlacePublicStats` (public)
- Applies visibility thresholds — redacts fields below minimum review count
- Returns public-safe stats

### `listPlaceReviews` (public)
- Paginated, newest first
- Strips `anonymousEmail` from output
- Includes venue response inline (responses are immediately public, no moderation)

### `respondToPlaceReview` (authed, place owner/admin)
- Verifies ownership via PlaceOwnership or OrgMember
- Sets response fields
- Response is immediately visible

### `flagPlaceReview` (authed — venue owner or any user)
- Sets `flagged = true` + `flagReason`
- Review remains visible until platform admin hides it
- Stats recalculation on next scheduled sweep will exclude if hidden

### `hidePlaceReview` (authed — platform admin only)
- Sets `hidden = true`
- Excluded from public listings and stats on next recalculation

### `listPlacesForDirectory` (public)
- Returns places where `listedInDirectory = true` and `status = ACTIVE`
- Used by the venue autocomplete on the review form
- Client-side substring filtering — no server-side search

### `togglePlaceDirectoryListing` (authed — platform admin)
- Sets `listedInDirectory` on a Place
- Used from platform admin page to approve user-submitted stubs

---

## Public Form — Three-Page Flow

### Page 1: Quick Form (8 fields, 90 seconds)
1. Venue name + city — autocomplete from existing Places (PRO imports, Google Places, prior submissions)
2. How much did they pay you? — dollar input (optional skip)
3. How were you paid? — dropdown
4. Did they promote? — dropdown
5. Sound system quality? — dropdown
6. Right crowd? — dropdown
7. Would you play again? — dropdown
8. What genre do you play? — freeform text

### Page 2: Tell Us More (all dropdowns required, freeform optional)
9. How many people came for you specifically? — number (optional)
10. Stage equipment provided? — dropdown (required)
11. Parking & load-in? — dropdown (required)
12. Rate the booker/staff — dropdown: Excellent/Good/Okay/Poor/Terrible (required)
13. Anything else? — freeform 1000 char (optional)
14. Details on sound/payment/promotion/parking? — freeform 500 char (optional)

### Page 3: Stay Connected (optional)
15. Email — waitlist
16. Name — optional

### Implementation note
The form is a static, purpose-built component with hardcoded fields — not a dynamic form builder. The fields are known at compile time and tightly coupled to the PlaceReview schema. Generic form builder extraction is deferred until a third form type appears in the platform.

---

## Coming Soon Page Strategy

### Route: `hearthfire.community/` (homepage, pre-launch)

The homepage shows:
1. Ithas Fire branding + one-liner
2. "Rate a Venue" form (the 3-page flow above)
3. "Get notified when we launch" email capture
4. Live counter: "X venues rated by Y artists"

Full event browsing, ticketing, and discovery features are behind a feature gate. The review form and email capture are the only active public features. When the gate flips, the homepage transitions to the full experience with venue data already populated.

**Implementation:** The coming soon page is a completely separate page component, not a branch inside the existing homepage. A feature gate check at the route level swaps between the coming-soon component and the full homepage component.

### Autocomplete sources for Place search
- PRO-imported venues (ASCAP, BMI, SESAC lists) — `listedInDirectory: true` on import
- Google Places enriched records — `listedInDirectory: true` on import
- Places created by prior artist submissions — `listedInDirectory: false` until platform admin approves
- Client-side substring match on name + city (no server-side search)

---

## Prepopulation Pipeline

### PRO venue lists (call Monday)
Import as Place records: `name`, `address`, `city`, `region`, `country`, `verification: UNVERIFIED`. Track source in metadata.

### Google Places enrichment
For each imported Place: lookup lat/lng, capacity, addressHash for dedup. Store Google Place ID.

### Other sources
- Songkick / Bandsintown (venue + artist data)
- Eventbrite listings (venue, ticket price, genre)
- Local music publications (Nashville Scene, Nashville is the Reason)
- Facebook Events (manual collection from groups)
- Yelp (audience-side venue reviews, photos, hours)

---

## Seed → Platform Transition

| Phase | Source | eventId | Verification |
|-------|--------|---------|-------------|
| Seed | Public form (SURVEY) | null | Self-reported, unverified |
| Platform | Post-event prompt (PLATFORM) | linked | Cross-referenced with settlement + ticket data |
| Import | Bulk import (IMPORTED) | null | External source, unverified |

Over time, PLATFORM reviews supplement and eventually outweigh SURVEY reviews. PlaceStats aggregation can weight PLATFORM reviews higher because they're anchored to verifiable transaction data. This weighting is a Phase 2 concern (see: decay-and-trends spec).

---

## Migration Checklist

### Schema & migration
- [x] Create `place-review.prisma` with PlaceReview and PlaceStats
- [x] Add 9 enums to `enums.prisma` (8 review enums + PlaceReviewBookerRating)
- [x] Add `listedInDirectory Boolean @default(false)` to Place model
- [x] Drop `Human.placeReviews PlaceOwnership[]`, add `Human.placeOwnershipReviews PlaceOwnership[]`
- [x] Add relations to Place (reviews, stats), Human (placeReviewsAuthored, placeReviewResponses), Event (placeReviews)
- [ ] `prisma migrate dev --name add-place-reviews`

### Core (ports, adapters, use cases)
- [x] `PlaceReviewRecord` and `PlaceStatsRecord` types (`packages/types/src/repos/place-reviews.ts`)
- [x] `PlaceReviewsRepo` and `PlaceStatsRepo` interfaces (`packages/ports/src/repos/place-reviews.ts`)
- [x] Prisma adapters: `makePlaceReviewsRepo()`, `makePlaceStatsRepo()` (`packages/adapters/src/db/prisma/place-reviews.ts`)
- [x] Implement `submitPlaceReview` use case + tests (7 tests)
- [x] Implement `recalculatePlaceStats` as a cron job + tests (15 tests)
- [x] Implement `getPlacePublicStats` + `listPlaceReviews` (public) + tests (9 + 9 tests)
- [x] Implement `respondToPlaceReview` + `flagPlaceReview` + `hidePlaceReview` + tests (7 + 4 + 6 tests)
- [x] Implement `listPlacesForDirectory` + `togglePlaceDirectoryListing` (no dedicated tests yet)
- [x] Refactored `requireOwnerAccess` into shared `packages/core/src/lib/rbac.ts` and migrated 8+ existing use cases

### Transport
- [x] Wire tRPC router (`placeReviews.*`) — 9 procedures (submit, getPublicStats, list, listDirectory, respond, flag, hide, toggleDirectoryListing, recalculateStats)
- [x] Register cron job for `recalculatePlaceStats`

### Web UI
- [x] Build 3-page static review form component
- [x] Build Place autocomplete (client-side filter from `listPlacesForDirectory`)
- [x] Build coming soon page component (separate from existing homepage)
- [x] Feature gate route swap at `/`
- [x] Live counter component ("X venues rated by Y artists")
- [ ] Platform admin: Place directory listing toggle
- [ ] Platform admin: Review moderation (flag/hide)

### Data seeding (operational)
- [ ] Import PRO venue lists (`listedInDirectory: true`)
- [ ] Google Places enrichment
- [ ] Post form in Facebook groups (YEP 40k, Musicians 16k)

---

## Implementation Notes (2026-04-07)

### Test results
All 57 tests pass across 7 test suites:
```
cd packages/core && npx vitest run src/use-cases/place-reviews/ --reporter=verbose
 Test Files  7 passed (7)
      Tests  57 passed (57)
```

### Commits (chronological)
1. `53b46e0` — feat(core): add Place Reviews & Place Stats system (schema, types, ports, adapters, 9 use cases)
2. `f114182` — refactor(core): consolidate owner access checks into requireOwnerAccess
3. `4273591` — refactor(core): use shared requireOwnerAccess in promo use cases
4. `0a306eb` — test(core): add place review use case tests + fix Zod/authz issues
5. `1c9f9ad` — fix(core): fix remaining nonneg to nonnegative and hasStaffRole mock

### Bugs found and fixed during implementation
- Zod v3 uses `.nonnegative()` not `.nonneg()` (3 occurrences)
- `requirePlatformStaff` calls `authz.hasStaffRole()` returning `{ allowed: boolean }`, not `getHumanRole`
- `PlaceReview` model has no `companions` field (removed from schema, types, and use case)
- `UpsertPlaceInput` requires `address` object for stub place creation
- `ListAllPlacesInput` uses flat params with `status: ["ACTIVE"]` array, not `filters: { ... }` wrapper
- `countByPlace` accepts optional `visibleOnly` second arg
- `genreCloud` adapter casts as `unknown as Prisma.InputJsonValue`

### Architecture notes
- `requireOwnerAccess()` was extracted from 8 use cases into `packages/core/src/lib/rbac.ts` as part of this work
- The `submit` endpoint is `publicProcedure` (no auth) for the seed phase
- Stats recalculation is batch-oriented: `listStalePlaceIds` uses raw SQL for `recalculatedAt < MAX(review.createdAt)` comparison
- Place adapter updated with `listedInDirectory` across 7+ call sites (select, toRecord, buildData, filter)

### Remaining work
- **Prisma migration** not yet run (requires local Docker infra)
- **Platform admin pages** — Place directory listing toggle, review moderation (flag/hide)
- **Integration tests** for adapters not yet written
- **`listPlacesForDirectory` and `togglePlaceDirectoryListing`** lack dedicated unit tests

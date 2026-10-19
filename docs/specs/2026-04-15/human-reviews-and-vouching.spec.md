# Human Reviews & Vouching

> Owner note 2026-10-08: "See someone vouching for someone is straight up just giving someone a link. The human review ends up being if they are a performer or not and want that kind of shit"

**Date:** 2026-04-15
**Status:** draft
**Priority:** P2
**Depends on:** `PlaceReview` (exists), `EntityPage` (exists), `EntityFollow` (exists), `EventHuman` (exists), `Agreement` (exists)

---

## Problem

PlaceReview lets artists rate venues. There is no mechanism for venues to rate artists. A venue that hosted a disrespectful act, or a host whose living room was trashed, has no way to signal that to other venues. Conversely, a venue that regularly books a great artist has no way to publicly endorse them. The trust system is one-directional.

Separately, there's no way for peers to vouch for each other — "I've played this living room, it's legit" or "I've hosted this band, they're respectful." These informal endorsements are how the DIY touring network actually works in real life (BYOFL was built on them). Digitizing vouches adds signal to the routing engine and helps new participants build trust faster.

---

## Goal

Venues and hosts can review artists after shows. Artists and hosts can vouch for each other. Both systems feed into `HumanStats` and the tour routing match algorithm.

---

## Context

| What exists | Where |
|---|---|
| `PlaceReview` (artist → venue, comprehensive, v3 form) | `place-review.prisma` |
| `PlaceStats` (aggregated venue scores) | `place-review.prisma` |
| `HumanStats` (artist performance aggregates) | `stats.prisma` |
| `EventHuman` (links artists to events, role=PERFORMER) | `event.prisma` |
| `EntityPage` (public pages for Human/Org/Place) | `entity-page.prisma` |
| `EntityFollow` (follow any entity) | `entity-page.prisma` |
| `FeedbackRequest` (post-event follow-up triggers) | `notification.prisma` |
| `Agreement` (deal between parties) | `agreement.prisma` |

---

## Data Model

### New model: `HumanReview`

A review of a Human (typically an artist/performer) by a venue owner, host, or organizer after an event.

```prisma
model HumanReview {
  id                 String   @id @default(uuid())

  // Who is being reviewed
  subjectHumanId     String
  eventId            String

  // Who is reviewing (the venue/host/org owner)
  reviewerHumanId    String

  // ── Ratings (1-5) ──────────────────────────────────────────
  overallRating      Int               // required, 1-5
  professionalismRating Int?           // showed up on time, communicated, etc.
  crowdRating        Int?              // did they bring people?
  respectForSpaceRating Int?           // left the space clean, followed house rules
  soundCheckRating   Int?              // prepared, efficient, reasonable volume

  // ── Freeform ───────────────────────────────────────────────
  text               String?  @db.VarChar(1000)
  wouldBookAgain     Boolean?

  // ── Blind review mechanics ─────────────────────────────────
  /// When this review was submitted by the reviewer.
  submittedAt        DateTime @default(now())

  /// When this review became visible to the subject.
  /// Null = not yet visible (waiting for counter-review or 14-day timer).
  publishedAt        DateTime?

  /// Whether the corresponding PlaceReview (artist → venue) exists.
  /// Used to determine when to publish.
  counterReviewId    String?  @unique

  // ── Moderation ─────────────────────────────────────────────
  flagged            Boolean  @default(false)
  flagReason         String?
  hidden             Boolean  @default(false)

  // ── Response ───────────────────────────────────────────────
  responseText       String?  @db.VarChar(500)
  respondedAt        DateTime?

  subjectHuman       Human    @relation("HumanReviewSubject", fields: [subjectHumanId], references: [id], onDelete: Cascade)
  reviewerHuman      Human    @relation("HumanReviewReviewer", fields: [reviewerHumanId], references: [id], onDelete: Cascade)
  event              Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)
  counterReview      PlaceReview? @relation("BlindReviewPair", fields: [counterReviewId], references: [id], onDelete: SetNull)

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([subjectHumanId, eventId, reviewerHumanId])
  @@index([subjectHumanId, publishedAt])
  @@index([reviewerHumanId])
  @@index([eventId])
}
```

### PlaceReview — add counter-review link

```prisma
// Add to PlaceReview in place-review.prisma:

/// Link to the corresponding HumanReview (venue → artist) for blind review mechanics.
humanReviewPair    HumanReview?  @relation("BlindReviewPair")
```

### New model: `Vouch`

A peer endorsement. Lightweight, public, optionally linked to a specific show.

```prisma
model Vouch {
  id              String    @id @default(uuid())
  voucherHumanId  String
  voucheeHumanId  String
  text            String?   @db.VarChar(500)  // "Played their basement twice, great people"
  eventId         String?                     // optionally linked to a specific show

  voucherHuman    Human     @relation("VouchesGiven", fields: [voucherHumanId], references: [id], onDelete: Cascade)
  voucheeHuman    Human     @relation("VouchesReceived", fields: [voucheeHumanId], references: [id], onDelete: Cascade)
  event           Event?    @relation(fields: [eventId], references: [id], onDelete: SetNull)

  createdAt       DateTime  @default(now())

  @@unique([voucherHumanId, voucheeHumanId])  // one vouch per pair
  @@index([voucheeHumanId])
  @@index([voucherHumanId])
}
```

### Human — add reverse relations

```prisma
// Add to Human in auth.prisma:

humanReviewsReceived    HumanReview[]  @relation("HumanReviewSubject")
humanReviewsGiven       HumanReview[]  @relation("HumanReviewReviewer")
vouchesGiven            Vouch[]        @relation("VouchesGiven")
vouchesReceived         Vouch[]        @relation("VouchesReceived")
```

### HumanStats — add review aggregates

```prisma
// Add to HumanStats in stats.prisma:

// ── Review-derived metrics (from HumanReview) ────────────────
humanReviewCount        Int      @default(0)
avgOverallRating        Float?   // null until >= 3 reviews
avgProfessionalismRating Float?
avgCrowdRating          Float?
avgRespectRating        Float?
wouldBookAgainPct       Float?

// ── Vouching ──────────────────────────────────────────────────
vouchCount              Int      @default(0)  // vouches received
```

---

## Blind Review Mechanics

Neither party sees the other's review until both have submitted OR 14 days have passed. This prevents retaliation reviews.

### How it works

1. **After an event:** Both the artist and the venue/host receive a `FeedbackRequest` (existing system) prompting them to leave a review.
2. **Artist submits PlaceReview:** `PlaceReview.publishedAt` remains null.
3. **Venue submits HumanReview:** `HumanReview.publishedAt` remains null. The `counterReviewId` links to the PlaceReview.
4. **Both submitted:** A use case detects both reviews exist for this event pair. Sets `publishedAt = now()` on both. Both become visible.
5. **14-day timer:** A background job runs daily. For any review where `submittedAt` is > 14 days ago and `publishedAt` is still null, set `publishedAt = now()`. The other party had their chance.

### Implementation

#### `publish-blind-reviews.ts` (triggered on review submission)

```
Input:  { eventId, placeId, humanId }
Steps:
  1. Find the PlaceReview for this event + place + human (artist's review).
  2. Find the HumanReview for this event + human as subject (venue's review).
  3. If both exist and both have publishedAt = null:
     - Set publishedAt = now() on both.
     - Link them via counterReviewId.
  4. Return.
```

#### `expire-blind-reviews` (daily job)

```
Steps:
  1. Find all reviews (PlaceReview + HumanReview) where:
     - publishedAt IS NULL
     - submittedAt < (now - 14 days)
  2. Set publishedAt = now() on each.
```

### PlaceReview changes

Add to `PlaceReview`:

```prisma
/// When this review became visible to the venue.
/// Null for legacy reviews (always visible) or reviews awaiting blind pair.
publishedAt        DateTime?
```

**Migration:** Existing PlaceReviews get `publishedAt = createdAt` (they were always visible). New reviews start with `publishedAt = null` when the event has an associated HumanReview flow (i.e., when the venue has an owner who can review back). Reviews for venues without owners continue to publish immediately.

---

## Vouching

### Use case: `create-vouch.ts`

```
Input:  { voucherHumanId, voucheeHumanId, text?, eventId? }
Steps:
  1. Validate: voucher != vouchee.
  2. If eventId is provided, validate both humans are linked to the event
     (via EventHuman or ticket ownership).
  3. Upsert Vouch (idempotent — one vouch per pair, update text if re-vouching).
  4. Increment voucheeHuman's HumanStats.vouchCount.
  5. Return the vouch.
Error codes: invalid_input (self-vouch), conflict (already vouched — update instead)
```

### Use case: `revoke-vouch.ts`

```
Input:  { voucherHumanId, voucheeHumanId }
Steps:
  1. Delete the Vouch.
  2. Decrement voucheeHuman's HumanStats.vouchCount.
```

### Where vouches appear

- **EntityPage:** "Vouched by [3 people]" with expandable list of voucher names + text
- **Tour routing matches:** `TourMatch.logisticsScore` includes vouch count as a signal (more vouches = higher trust)
- **Booking request:** When a venue receives a booking request, show "Vouched by [Name]: [text]" in the request detail

### Vouch weight in routing algorithm

Vouches contribute to the `logisticsScore` signal in `TourMatch`:
- 0 vouches = no signal (neutral, not negative)
- 1-2 vouches = small boost (+0.1)
- 3+ vouches = meaningful boost (+0.2)
- Vouches from humans the artist has played with before (shared EventHuman) are weighted higher

---

## HumanReview Form (Venue → Artist)

Shorter than PlaceReview. The reviewer is a venue owner or host, not an artist — they're busy, keep it fast.

### Required fields (30 seconds)

1. **Overall rating** — 1-5 stars
2. **Would you book them again?** — Yes / Maybe / No

### Optional fields

3. **Professionalism** — 1-5 stars ("Were they on time, communicative, prepared?")
4. **Crowd draw** — 1-5 stars ("Did they bring people?")
5. **Respect for space** — 1-5 stars ("Did they follow house rules, leave the space clean?")
6. **Sound check** — 1-5 stars ("Were they efficient, reasonable volume?")
7. **Written review** — freeform text, 1000 chars

### UI

Same one-question-at-a-time pattern as PlaceReview v3. But much shorter — 2 required screens, 5 optional. Target: under 60 seconds.

---

## Acceptance Criteria

- [ ] `HumanReview` model exists with ratings, blind mechanics, and moderation fields
- [ ] Venue owners can submit a HumanReview for any artist who performed at their venue (via EventHuman link)
- [ ] `Vouch` model exists with unique constraint per pair
- [ ] Blind review: neither party sees the other's review until both submit or 14 days pass
- [ ] `publishedAt` field on both PlaceReview and HumanReview controls visibility
- [ ] Daily job expires unpublished reviews after 14 days
- [ ] HumanStats aggregates review scores and vouch count
- [ ] Vouch count appears on EntityPage
- [ ] Vouch signal feeds into tour routing match algorithm
- [ ] Legacy PlaceReviews backfilled with `publishedAt = createdAt`
- [ ] HumanReview form is fast (2 required screens, <60 seconds)

---

## Open Questions

- **Who can review?** Only the Place owner, or any OrgMember with ADMIN+ role? Start with Place owner (via PlaceOwnership) or any Org admin for org-owned venues.
- **Review gating:** Should we require the event to be COMPLETED before reviews open? Yes — prevents pre-event gaming. Use `FeedbackRequest` trigger which already fires post-event.
- **Vouch spam:** Is one vouch per pair sufficient protection? Probably — you can't vouch for the same person twice, and the text is public so bad-faith vouches are visible. Add moderation (flagging) if needed later.
- **Blind review opt-in:** Should blind mechanics apply to all events or only events where both parties CAN review? Only when both parties can review (venue has a registered owner). Anonymous PlaceReviews from the survey form continue to publish immediately.

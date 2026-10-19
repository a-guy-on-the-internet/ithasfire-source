# Place Review Form — Completion & Retention

**Date:** 2026-04-15
**Status:** complete
**Priority:** P1
**Depends on:** `docs/specs/2026-04-08/completed/place-review-form-v3.spec.md` (fully implemented)
**Interview source:** Dan (2026-04-15 form walkthrough session)

---

## Problem

The v3 form is built and ships well. But it doesn't track who starts and doesn't finish, doesn't give artists a reason to complete beyond goodwill, and doesn't recover people who drop off mid-flow. Artists are, in Dan's words, "a little ADD and lazy" — the UX can carry them through, but only if we close the loop on abandonment and make finishing feel worth it.

Three specific gaps:

1. **Email is captured too late.** Page 3 is after completion. If someone drops off on Page 1 or 2, we have no way to reach them.
2. **No funnel visibility.** We have no data on where people bail. We're flying blind on form performance.
3. **No incentive to finish.** Completing the form is altruistic. A concrete reward (here's what we can give you) converts more completions than pure goodwill.

---

## Goal

Add session tracking, early email capture, mid-form nudges, abandonment recovery, and a completion incentive to the existing v3 form — without changing the core question flow.

---

## Context

| What exists | Where |
|---|---|
| `PlaceReviewFormV3` (one-question-at-a-time, progress bar, page-transition microcopy) | `apps/web/src/.../PlaceReviewFormV3.tsx` |
| Page 3 email capture (post-completion) | Same file — `PlaceReviewFormV3`, `Page3` section |
| `PlaceReview` model | `packages/db/prisma/place-review.prisma` |
| `PlaceStats` model | `packages/db/prisma/place-review.prisma` |
| `Human` model | `packages/db/prisma/human.prisma` |
| Email / mailer infra | `packages/core/src/lib/mailer` (existing) |

---

## Data Model

### New model: `PlaceReviewSession`

Tracks every form attempt, anonymous or identified. One row per browser session per form open.

```prisma
model PlaceReviewSession {
  id            String   @id @default(uuid())

  // Identity — at least one must be set
  sessionToken  String   // anonymous browser token (always set)
  humanId       String?  // set if logged in, or matched after email capture

  // What they were reviewing
  placeId       String

  // Email — captured early, before completion
  email         String?         // captured mid-form
  emailCapturedAt DateTime?     // when they gave it

  // Funnel tracking
  lastStepKey   String?         // step identifier: "screen_1_venue", "screen_4_promotion", etc.
  lastStepAt    DateTime?       // when they were last active
  pageReached   Int @default(1) // 1, 2, or 3 — which page they reached

  // Completion
  completedAt   DateTime?       // null = abandoned
  placeReviewId String? @unique // FK to the completed review

  // Abandonment recovery
  abandonmentEmailSentAt DateTime? // null = not sent yet

  // Incentive delivery
  incentiveShownAt DateTime?     // when we showed them the trusted venues list

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  place         Place         @relation(fields: [placeId], references: [id])
  human         Human?        @relation(fields: [humanId], references: [id])
  placeReview   PlaceReview?  @relation(fields: [placeReviewId], references: [id])

  @@index([sessionToken])
  @@index([email])
  @@index([placeId])
  @@index([humanId])
  @@index([completedAt])   // hot path: find abandoned sessions for recovery job
}
```

---

## Feature 1: Early Email Capture (Mid-Form Interstitial)

### Where it goes

After the last required question on Page 1 (currently Screen 7: "Would you play there again?"), before the optional "Want to go deeper?" transition to Page 2, insert a lightweight email interstitial.

**Placement rationale:** By Screen 7, the user has answered ~7 questions and is invested. Asking for email here captures a meaningful cohort before the drop-off cliff between Page 1 and Page 2.

### UI

```
┌─────────────────────────────────────────────┐
│  Nice work — that's the core stuff done.    │
│                                             │
│  Drop your email so we can show you         │
│  trusted venues near you when we launch.   │
│                                             │
│  [email input field]                        │
│                                             │
│  [Continue →]    [Skip for now]             │
│                                             │
│  ── Your email is never tied to your        │
│     review. Anonymous stays anonymous. ──  │
└─────────────────────────────────────────────┘
```

- Email is optional — "Skip for now" advances without it
- If they provide email, write to `PlaceReviewSession.email` + `emailCapturedAt`
- Anonymity callout is mandatory (same trust language as rest of form)
- If user is already logged in as a `Human`, skip this screen — email already known

### Backend

New use case: `capture-review-session-email.ts`

```
Input:  { sessionToken: string; email: string }
Steps:
  1. Find PlaceReviewSession by sessionToken.
  2. Validate email format.
  3. Set session.email = email, session.emailCapturedAt = now().
  4. If a Human exists with this email, set session.humanId.
  5. Return updated session.
```

---

## Feature 2: Form Funnel Analytics

### Session lifecycle

The frontend tracks `lastStepKey` on every step transition. Step keys use a consistent format:

```
page_{n}_screen_{n}_{slug}
```

Examples:
- `page_1_screen_1_venue`
- `page_1_screen_4_promotion`
- `page_1_screen_7_would_play_again`
- `page_1_email_interstitial`
- `page_2_draw_estimate`
- `page_3_email_capture`

Each step transition fires a lightweight background mutation (non-blocking, best-effort):

```
PATCH /api/review-session/:sessionToken
Body: { lastStepKey, pageReached }
```

### Abandonment definition

A session is "abandoned" when:
- `completedAt` is null
- `lastStepAt` is older than 1 hour
- `abandonmentEmailSentAt` is null

### Analytics queries (for internal dashboard — not user-facing)

From `PlaceReviewSession`:
- **Funnel by step:** `GROUP BY lastStepKey ORDER BY count DESC` — shows where people drop
- **Completion rate:** `completedAt NOT NULL / total sessions`
- **Email capture rate:** `emailCapturedAt NOT NULL / total sessions`
- **Page 2 reach rate:** `pageReached >= 2 / total sessions`
- **Abandonment by place:** which venues get the most abandoned reviews (signal: maybe confusing data or no place match)

No new model needed — all derivable from `PlaceReviewSession`.

---

## Feature 3: Mid-Form Progress Nudges

### Problem with current implementation

v3 has encouraging microcopy at page transitions (after Page 1, after Page 2). Dan specifically said every 4–5 *questions*, not pages. Since v3 is one-question-at-a-time, there's room for in-screen nudges without interrupting flow.

### Implementation

Add a `nudgeText` property to the form step definition that renders below the question's action button when present. Appears and fades out after 2.5 seconds, or stays if user is reading.

```typescript
type FormStep = {
  key: string
  question: string
  helperText?: string
  input: FormInput
  nudgeText?: string  // NEW: short motivational line shown after answering
}
```

**Nudge placement rule:** Every 4th step gets a nudge. So screens 4, 8, 12 (if they exist), plus the email interstitial always shows one.

**Nudge copy examples** (short, not patronizing, personality-first):

| After step | Copy |
|---|---|
| Screen 4 (Promotion) | "You're almost halfway. This is the stuff that actually matters." |
| Screen 7 (Would play again) | "Core questions done. You're helping someone avoid a bad gig." |
| Screen 11 (Booker/Staff) | "You went full depth. Other artists owe you a beer." |
| Email interstitial | "Nice work — that's the core stuff done." |

**Do not nudge:** Every step (patronizing). Randomly (inconsistent). With generic "Great job!" (meaningless).

---

## Feature 4: Abandonment Recovery Email

### Job: `send-abandonment-recovery-emails`

Runs hourly. Finds abandoned sessions with an email address and sends one recovery email.

```
find PlaceReviewSessions where:
  - completedAt IS NULL
  - email IS NOT NULL
  - lastStepAt < (now - 1 hour)
  - abandonmentEmailSentAt IS NULL

for each session:
  - send recovery email
  - set abandonmentEmailSentAt = now()
```

**One email only. Never a sequence.** This is not a drip campaign.

### Email content

```
Subject: You left your review halfway — here's where you stopped

Hey,

You started a review for [Venue Name] on Ithas Fire but didn't finish.

You got to: [human-readable step name, e.g., "Parking & Load-In"]

It only takes another minute to wrap up — and it genuinely helps
other artists know what to expect before booking there.

[Continue your review →]

──────────────────────────────
Your review is 100% anonymous.
This email is never connected to what you wrote.
Unsubscribe: [one-click unsubscribe link]
```

### Unsubscribe

Reuse the existing HMAC unsubscribe pattern from announcement preference compliance. Token payload: `"review-recovery:<email>"`. One-click unsubscribe sets a flag that prevents future recovery emails for this address.

New column on `PlaceReviewSession`: none needed — `abandonmentEmailSentAt` being set is the guard.
New table for global suppression: reuse `AnonymousUnsubscribe` (introduced in `announcement-preference-compliance.spec.md`) with a `context: "review_recovery"` discriminator field if not already there.

---

## Feature 5: Completion Incentive — Trusted Venues Near You

### What it is

When a user completes Page 1 (their first full review), show them a screen before Page 2's "want to go deeper?" prompt:

```
┌─────────────────────────────────────────────┐
│  You just helped other artists.             │
│                                             │
│  Here's your reward:                        │
│                                             │
│  ── Trusted venues near Nashville, TN ──   │
│                                             │
│  • The Basement East — 4.7★ (47 reviews)   │
│  • The 5 Spot — 4.3★ (23 reviews)          │
│  • Analog at Hutton Hotel — 4.1★ (18 rev)  │
│  • Emma — 3.9★ (31 reviews)                │
│  • [+12 more — join the waitlist to see]   │
│                                             │
│  [Continue adding detail →]  [I'm done]    │
└─────────────────────────────────────────────┘
```

- **Location:** derived from the venue they just reviewed (city/state), NOT from IP (too unreliable, and we already have it from the Place record)
- **Query:** `PlaceStats JOIN Place WHERE place.city = reviewedCity AND PlaceStats.totalReviews >= 5 ORDER BY avgRating DESC LIMIT 4`
- **Teaser:** show top 4 venues. Remaining count shown as "[+N more — join the waitlist to see]" — this ties to the email capture. If they already gave email, show all.
- **Data requirement:** This only shows if there are ≥ 2 other reviewed venues in the same city. If no data, skip the screen silently.

### Why this works

Per Dan: *"a curated list of trusted venues in your area… just doesn't exist."* This is genuinely valuable, it's directly tied to the platform, and it previews the core value proposition in a tangible way. The artist completes the form and immediately sees what they'll get when the network grows.

---

## Changes to Existing v3 Form

### Email on Page 3 — keep but simplify

Page 3's email field remains as the final fallback for users who skipped the mid-form interstitial. If they already gave email at the interstitial, skip Page 3 entirely and go straight to the success screen.

### Session initialization

When the form opens, create a `PlaceReviewSession` in the background:

```
POST /api/review-session
Body: { sessionToken, placeId }
Returns: { sessionId }
```

`sessionToken` is a random UUID stored in `localStorage` (persists across page refreshes, cleared on browser reset). Not a cookie — no consent issues.

---

## Use Cases

### `create-review-session.ts`

```
Input:  { sessionToken: string; placeId: string; humanId?: string }
Steps:
  1. Upsert PlaceReviewSession (sessionToken + placeId as unique lookup).
  2. Return session.
Error codes: not_found (invalid placeId)
```

### `update-review-session-step.ts`

```
Input:  { sessionToken: string; lastStepKey: string; pageReached: number }
Steps:
  1. Find session by sessionToken.
  2. Update lastStepKey, lastStepAt = now(), pageReached.
  3. Return ok.
Error codes: not_found
```
Best-effort — frontend fires-and-forgets, no retry on failure.

### `capture-review-session-email.ts`

Described above in Feature 1.

### `complete-review-session.ts`

Called when `PlaceReview` is successfully created.

```
Input:  { sessionToken: string; placeReviewId: string }
Steps:
  1. Find session by sessionToken.
  2. Set completedAt = now(), placeReviewId = placeReviewId.
  3. Return ok.
Error codes: not_found
```

### `get-trusted-venues-near-place.ts`

```
Input:  { placeId: string; limit?: number }
Steps:
  1. Look up Place by placeId → get city, state.
  2. Query PlaceStats JOIN Place WHERE city = city AND state = state
     AND placeId != placeId AND totalReviews >= 5
     ORDER BY avgRating DESC LIMIT limit (default 10).
  3. If results < 2, return empty (caller skips the incentive screen).
  4. Return [{ placeId, name, avgRating, totalReviews }].
Error codes: not_found
```

---

## Acceptance Criteria

- [ ] `PlaceReviewSession` is created when form opens (before any questions answered)
- [ ] `lastStepKey` and `lastStepAt` update on every step transition (non-blocking)
- [ ] Email interstitial appears after Screen 7 for unauthenticated users
- [ ] Email interstitial is skipped for authenticated users (humanId already known)
- [ ] Email capture is optional — "Skip for now" advances without error
- [ ] Captured email is never shown on or connected to the public review
- [ ] Progress nudge appears at steps 4, 7 (and any future step 11+) — not every step
- [ ] Abandonment job runs hourly, sends max one email per session, respects unsubscribe
- [ ] Recovery email links to resume the form at the last step reached
- [ ] Completion incentive screen shows after Page 1 completion when ≥ 2 local venues exist
- [ ] If user already gave email at interstitial, Page 3 email screen is skipped
- [ ] `completeReviewSession` is called when PlaceReview is created
- [ ] Funnel data is queryable from `PlaceReviewSession` (no separate analytics model needed yet)

---

## v3 Form Field Patches (from Dan session + follow-up)

These are changes to the implemented v3 form (`PlaceReviewFormV3.tsx`) that should ship alongside this spec.

### Gig Date: Replace "Day of Week" with Full Date + Time of Day

The v3 form asks "What day of the week was the gig?" as a single-select (Mon–Sun). This is insufficient — we need the **exact date** for temporal analysis (seasonality, specific event correlation) and the **time of day** for pattern detection (morning open mics vs late-night sets).

**Replace the current Day of Week screen with two screens:**

**Screen: "When was the gig?"**
- Full date picker (centered, prominent — this is important data)
- Helper text: *"The exact date helps us spot seasonal patterns and connect your review to the right show."*
- `dayOfWeek` is still derived from the date (computed, not asked)

**Screen: "What time did you play?"**
- Time-of-day chips (single-select):
  - Morning (9am–12pm)
  - Afternoon (12pm–5pm)
  - Evening (5pm–9pm)
  - Night (9pm+)
- Below the chips: optional specific time input (time picker, labeled "Or enter a specific time")
- Helper text: *"A rough window is fine — helps us compare morning open mics to late-night sets."*

**Schema changes:**

```prisma
// Add to PlaceReview in place-review.prisma:

  // ── Gig date (replaces dayOfWeek-only) ──────────────────────
  gigDate           DateTime?     // exact date of the gig
  gigTimeOfDay      PlaceReviewTimeOfDay?  // Morning, Afternoon, Evening, Night
  gigTimeExact      String?       // optional specific time, e.g. "21:30"
```

```prisma
// New enum:
enum PlaceReviewTimeOfDay {
  MORNING      // 9am–12pm
  AFTERNOON    // 12pm–5pm
  EVENING      // 5pm–9pm
  NIGHT        // 9pm+
}
```

`dayOfWeek` (existing Int field) is now **computed from `gigDate`** instead of asked directly. Keep the column for backward compat with existing reviews — just derive it on save.

### Payout: Remove "I'd rather not say" skip option

The v3 form's payout screen ("How much did they pay you?") has a "I'd rather not say" skip option. **Remove it.** The field is already nullable (`payoutCents Int?`) — if they skip the screen entirely via the existing skip/next flow, it stays null. The explicit "rather not say" chip is unnecessary and gives artists an easy out that reduces data quality.

---

## Open Questions

- **GA4 funnel visualization:** Fire a `form_step_complete` GA4 event on every step transition (same moment as the `update-review-session-step` mutation). Let GA4 own the dropout funnel chart — no dashboard to build or maintain. The `PlaceReviewSession` table exists for abandonment emails and session state; GA exists for visualization. Do not build a custom analytics UI.

- **Session deduplication:** If the same person opens the form twice (different sessionTokens), we'll get two rows. Acceptable for MVP — humanId match handles this for logged-in users. Anonymous duplicates are a minor data quality issue, not a blocker.
- **Recovery email link:** Does it link to a stateful resume URL (`/review?session=<token>&step=<lastStep>`) or just to the form root? Stateful is better UX but requires the form to read session state on load. Decide at implementation.
- **`AnonymousUnsubscribe` context field:** The announcement compliance spec introduced this table. Confirm it supports a `context` discriminator before using it for review recovery suppression. If not, add the column in this migration.

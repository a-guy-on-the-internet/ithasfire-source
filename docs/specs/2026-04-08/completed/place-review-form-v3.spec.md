# Place Review Form — Revised UX Spec (v3)

**Date:** 2026-04-08
**Status:** complete
**Supersedes:** Form section of place-reviews-and-stats.spec.md

---

## Design Philosophy: Typeform + TurboTax

### From Typeform:
- **One question at a time.** Don't show a wall of fields. Each question gets its own screen/section with large typography and plenty of whitespace. This makes the form feel like a conversation, not an interrogation.
- **Conversational tone.** Questions should read like a human asking, not a database requesting. "How much did they pay you?" not "Enter payout amount."
- **Keyboard-friendly.** Let users tab/enter through without touching their mouse.
- **Large text, simple inputs.** Each question uses the full screen width. Big fonts. One clear action per screen.

### From TurboTax:
- **Progress indicator.** Show where the user is in the flow — "Step 2 of 3" or a progress bar. Users need to see light at the end of the tunnel.
- **Encouraging microcopy.** Celebrate completion of each section. "Nice — that helps other artists a lot." "Almost done!" Not patronizing, just warm.
- **Contextual help.** Small helper text under questions explaining why you're asking. "This helps artists know what to expect before booking." Not required to read, but there if they need reassurance.
- **Real-time value preview.** TurboTax shows your refund updating as you go. Your equivalent: show a live counter — "You're review #47 for this venue" or "127 venues rated so far." Let them see they're contributing to something real.
- **Celebrate completion.** When they finish, don't just say "thanks." Show them what their contribution did — "You just helped 47 other artists make better booking decisions." Confetti optional but encouraged.

---

## Revised Form Flow

### Page 1: The Core (5-6 fields, 60 seconds)

**Screen 1: Venue Selection**
- **"What venue did you play at?"**
- Autocomplete input searching existing Places
- If no match: "Add [typed name] as a new venue" option
- When selected, auto-fill city/state from Place record
- Country and state are **dropdowns** (not freeform) — prepopulated from Place record or selectable
- Helper text: *"Start typing and we'll find it. If it's not listed, you can add it."*

**Screen 2: Payout**
- **"How much did they pay you?"**
- Dollar input (number field, stored as cents)
- "I'd rather not say" skip option
- Helper text: *"Your answer is 100% anonymous. This helps other artists know what to expect."*

**Screen 3: Payment Method**
- **"How were you paid?"**
- Single-select radio buttons (not dropdown — radio is faster per UX research):
  - Flat guarantee
  - Door split
  - Ticket sales percentage
  - Tips only
  - Pay-to-play (I had to pay or sell tickets)
  - Unpaid / exposure
  - Other
- If "Other" selected, reveal freeform text field
- Helper text: *"If it was a mix, pick the primary one."*

**Screen 4: Promotion**
- **"Did the venue promote the show?"**
- Single-select radio:
  - Yes, they actively promoted
  - They posted once on social media
  - No, it was all on me
- Helper text: *"Did they put in effort to get people there, or was that your job?"*

**Screen 5: Sound Quality**
- **"How was the sound system?"**
- Single-select radio:
  - Great — full PA, sounded professional
  - Fine — basic but it worked
  - Bad — had issues
  - No sound system at all
- Remove "Lied about it" per Dan's feedback — capture that in the freeform detail instead
- Helper text: *"Think about monitors, PA, and whether someone ran sound for you."*

**Screen 6: Audience Fit**
- **"Was it the right crowd for your music?"**
- Single-select radio:
  - Perfect fit
  - Mixed — some were into it
  - Totally wrong crowd
- Helper text: *"Playing folk to a metal crowd? We want to know."*

**Screen 7: Would Play Again**
- **"Would you play there again?"**
- Three big buttons: Yes / Maybe / No
- Helper text: *"Quick gut check. No wrong answer."*

**Screen 8: Genre**
- **"What genre do you play?"**
- Multi-select tag input with prepopulated common tags:
  - Rock, Indie, Folk, Country, Singer-Songwriter, Blues, Jazz, Hip-Hop, R&B, Electronic, Pop, Metal, Punk, Americana, Bluegrass, Soul, Funk, Classical, World, Other
- User can type and add custom tags not in the list
- Tags are freeform strings stored on the review — no genre enum
- Helper text: *"Pick what fits. Add your own if we're missing something."*

**Completion celebration:**
- "You just helped [X] other artists make better decisions. Thank you."
- Show venue review count: "This venue now has [N] reviews."
- Transition: "Want to share a bit more? It only takes another minute." → Page 2

---

### Page 2: Optional Depth (clearly marked "OPTIONAL")

Show as expandable sections, not separate screens. Each section has a header with "(optional)" label. User can fill any/all/none.

**Draw Estimate**
- **"How many people came to see you specifically?"** — number input
- Helper text: *"Your best guess. Not the whole bar — just people there for your set."*

**Day of Week**
- **"What day of the week was the gig?"**
- Single-select: Mon / Tue / Wed / Thu / Fri / Sat / Sun
- NOT a full date picker — day of week is what matters for patterns (Friday crowds vs Tuesday crowds)
- Helper text: *"This helps us spot patterns — Tuesday crowds are different from Saturday crowds."*

**Stage Equipment**
- **"Did the venue provide stage equipment? (amps, drums, PA monitors)"**
- Single-select radio:
  - Full setup — everything I needed
  - Partial — had some, brought the rest
  - None — I brought everything
- Freeform detail field below: *"Any details? (optional)"* — 500 char, fixed height, no resize handle

**Parking & Load-In**
- **"Free parking available?"** — Yes / No toggle
- **"How was load-in?"**
- Single-select: Easy / Manageable / Difficult
- Freeform detail field: *"Any details? (optional)"* — 500 char, fixed height

**Booker/Staff**
- **"Rate the booker or staff (1-5)"** — star rating
- **"Did staff help with setup or merch?"** — Yes / Somewhat / No
- Freeform detail: *"Any details? (optional)"* — 500 char, fixed height

**Merch**
- **"Could you sell merch?"** — Yes freely / Yes but venue took a cut / No
- If "venue took a cut": **"What percentage?"** — number input

**Photos**
- **"Got a photo of the stage or venue?"** — file upload (optional)
- Helper text: *"Helps other artists see what they're working with."*
- Accept jpg/png, max 5MB, store in R2

**General Comments**
- **"Anything else artists should know?"** — freeform text, 1000 char, fixed height, no resize handle
- Helper text: *"The good, the bad, the weird. Your voice matters more than checkboxes."*

**Completion celebration:**
- "Wow, you went deep. Other artists will seriously appreciate this."
- Transition to Page 3

---

### Page 3: Stay Connected

**Screen 1:**
- **"Want to know when Ithas Fire launches?"**
- Email input
- Name input (optional)
- Helper text: *"We'll let you know when venue data goes live. No spam. Ever."*
- Big submit button: "Count me in"

**After submit:**
- "You're artist #[N] on the waitlist."
- "127 venues rated. 342 artists contributing. You're part of something."
- Option: **"Rate another venue"** button to loop back to Page 1

---

## Data Model Changes

### Genre Tag System

Genre is stored as freeform strings on the review, but we need a `GenreTag` table for the autocomplete/multi-select UI:

```prisma
model GenreTag {
  id          String   @id @default(uuid())
  name        String   @unique  // lowercase, trimmed — "indie folk"
  displayName String             // display casing — "Indie Folk"
  usageCount  Int      @default(0)  // how many reviews use this tag
  isDefault   Boolean  @default(false)  // prepopulated vs user-created
  createdAt   DateTime @default(now())

  @@index([name])
  @@index([usageCount])
}
```

- Prepopulate with ~20 default tags (the list above) with `isDefault: true`
- When a user types a custom genre, create a new `GenreTag` with `isDefault: false`
- `usageCount` increments each time a review uses this tag
- Tags with high usage bubble to the top of the autocomplete
- PlaceReview stores genre as `String[]` (array of tag names, not IDs) for flexibility

### PlaceReview Model Updates

Add to the existing PlaceReview model:

```prisma
  // ── Day of week ──────────────────────────────────────────────
  dayOfWeek         Int?      // 0=Sun, 1=Mon, ... 6=Sat

  // ── Merch ────────────────────────────────────────────────────
  merchAllowed      PlaceReviewMerchPolicy?
  merchCutPct       Int?      // venue's percentage cut if applicable

  // ── Staff support ────────────────────────────────────────────
  staffSupport      PlaceReviewStaffSupport?

  // ── Photos ───────────────────────────────────────────────────
  photoKeys         String[]  // R2 storage keys for uploaded photos

  // ── Genre (changed from single string to array) ──────────────
  genreTags         String[]  // array of genre tag names
```

### New Enums

```prisma
enum PlaceReviewMerchPolicy {
  ALLOWED_FREELY
  ALLOWED_WITH_CUT
  NOT_ALLOWED
}

enum PlaceReviewStaffSupport {
  YES
  SOMEWHAT
  NO
}
```

### Remove from existing enums
- Remove `LIED_ABOUT_IT` from `PlaceReviewSoundQuality` — capture in freeform `soundDetail` instead
- Remove `LIED_ABOUT_IT` from `PlaceReviewStageEquipment` — same reason

### PlaceStats Updates

Add:
```prisma
  // ── Merch ────────────────────────────────────────────────────
  merchAllowedPct       Float?  // % of reviews where merch was allowed
  avgMerchCutPct        Float?  // average venue merch cut percentage

  // ── Day of week distribution ─────────────────────────────────
  dayOfWeekDistribution Json    @default("[]")  // [{ day: 0, count: 12 }, ...]

  // ── Staff support ────────────────────────────────────────────
  staffSupportScore     Float?  // 0-1 aggregated
```

### Visibility Threshold Update

Per Matt's feedback, increase minimums:

| Data | Min reviews to show |
|------|-------------------|
| Payout stats | 20 |
| Standard deviation | 25 |
| Scores (sound, promotion, etc.) | 10 |
| Would play again % | 15 |
| Booker rating | 10 |
| Draw stats | 15 |
| Flags (pay-to-play) | 3 independent reports |
| Merch policy | 5 |

These are significantly higher than v2. The tradeoff: venues need more reviews before data goes public, which means slower initial value — but the data is much more trustworthy when it does appear. Worth it.

---

## Form Builder Integration

The existing event application form builder uses `ApplicationQuestionType`:
- `SHORT_TEXT`
- `LONG_TEXT`
- `MULTI_CHOICE`
- `SINGLE_CHOICE`

The venue review form needs additional types:
- `NUMBER` (dollar input, draw estimate, merch percentage)
- `STAR_RATING` (booker rating)
- `TAG_MULTI_SELECT` (genre tags with autocomplete + custom)
- `TOGGLE` (yes/no for parking)
- `PHOTO_UPLOAD` (stage/venue photos)
- `DAY_OF_WEEK` (single-select Mon-Sun)

**Action:** Extract the form builder from event-specific context into a generic `FormBuilder` component. Add the new question types. Both the event application form and the venue review form use the same underlying system.

---

## UI Specifications

### Text Fields
- Fixed height (no resize handle on textarea)
- Character limit displayed as countdown: "247 / 500"
- Placeholder text in lighter color
- Static height regardless of content (scrollable internally if overflow)

### Required vs Optional
- Required fields: no special marking needed on Page 1 (everything on Page 1 is required except payout which has a skip)
- Page 2: Every section header includes "(optional)" in muted text
- Page 2: Each freeform detail field labeled "Any details? (optional)"

### Progress Indicator
- Top of form: thin progress bar showing completion percentage
- Below progress bar: "Step 2 of 8" text
- Bar fills with warm orange (`#FF5721`) as user progresses
- Animate smoothly between steps

### Encouragement Copy
Between pages / at transitions:
- After Page 1: "Nice — that helps other artists a lot."
- After Page 2: "Wow, you went deep. Other artists will seriously appreciate this."
- After Page 3: "You're part of something. Welcome."

### Mobile
- Full-width single column
- Large touch targets (48px minimum)
- Radio buttons as full-width tappable cards, not tiny circles
- Tag multi-select: tags as chips, tappable to toggle
- Fixed bottom bar with "Next" / "Skip" buttons

### Anonymity Messaging
- Top of form: "100% anonymous. Your identity is never attached to your review."
- Repeat near payout field: "This is anonymous — venues can't see who said what."
- On Page 3 email capture: "Your email is only for the waitlist. It's never connected to your review."

---

## Independent Venue Flag

Dan mentioned this. Add:
- **"Is this an independent venue?"** — Yes / No / Not sure
- Stored on PlaceReview, aggregated into PlaceStats
- Useful for filtering and for understanding the indie music ecosystem vs corporate venues

---

## Implementation Checklist

- [x] Extract form builder into generic reusable component (`@th/ui` forms barrel)
- [x] Add new question types (NUMBER, STAR_RATING, TAG_MULTI_SELECT, DAY_OF_WEEK) — PHOTO_UPLOAD deferred
- [x] Create GenreTag model + migration (`20260408000000_place_review_v3`)
- [x] Prepopulate GenreTag with ~20 default genres (seeded in migration)
- [x] Update PlaceReview model with new fields (dayOfWeek, merchAllowed, merchCutPct, staffSupport, photoKeys, genreTags, independentVenue)
- [x] Add new enums (PlaceReviewMerchPolicy, PlaceReviewStaffSupport, PlaceReviewIndependentVenue)
- [x] Remove LIED_ABOUT_IT from sound and equipment enums (migration migrates existing rows to BAD/NONE)
- [x] Update PlaceStats with new aggregation fields (merchAllowedPct, avgMerchCutPct, dayOfWeekDistribution, staffSupportScore, independentVenuePct)
- [x] Update visibility thresholds to 20-30 range
- [x] Build one-question-at-a-time form UI with progress bar (PlaceReviewFormV3.tsx)
- [x] Implement encouraging microcopy at transitions
- [x] Build genre tag multi-select with autocomplete + custom input (TagMultiSelect component)
- [x] Make all text fields fixed height with character countdown (CharCountTextarea component)
- [x] Mark optional fields clearly (FieldLabel `optional` prop)
- [x] Add anonymity messaging throughout (TrustLine component, 3 placement points)
- [ ] Add photo upload to R2 — **DEFERRED**: requires R2 presigned URL endpoint, upload UI component, and adapter. Tracked separately.
- [x] Build completion celebration screen with live counters (SuccessScreen with scale-in animation)
- [x] Build "Rate another venue" loop (handleReset → EMPTY state)
- [x] Mobile-optimize: full-width cards, large touch targets (44px min-height chips)
- [ ] Test form completion time target: Page 1 < 90 seconds, Page 1+2 < 3 minutes — manual QA after deploy
- [x] Delete old PlaceReviewForm.tsx (dead code — barrel now exports from V3)

---

## UI Package: Generic Input Components — COMPLETED

All inline form primitives have been extracted to `@th/ui` and the PlaceReviewFormV3 imports them from the shared package. The old inline PlaceReviewForm.tsx has been deleted.

### Extracted Components

| Component | Location | Status |
|-----------|----------|--------|
| `ChipGroup` | `packages/ui/.../forms/ChipGroup.tsx` | ✅ Done — single-select chips with detail reveal |
| `MultiChipGroup` | `packages/ui/.../forms/MultiChipGroup.tsx` | ✅ Done — multi-select variant |
| `FieldLabel` | `packages/ui/.../forms/FieldLabel.tsx` | ✅ Done — label + "(optional)" + helperText |
| `Reveal` | `packages/ui/.../effects/Reveal.tsx` | ✅ Done — max-height + opacity animation |
| `TagMultiSelect` | `packages/ui/.../forms/TagMultiSelect.tsx` | ✅ Done — tag chips + custom input |
| `StarRating` | `packages/ui/.../forms/StarRating.tsx` | ✅ Done — rectangular blocks, Swiss style |
| `DayOfWeekSelect` | `packages/ui/.../forms/DayOfWeekSelect.tsx` | ✅ Done — 7 chips, stores Int |
| `CharCountTextarea` | `packages/ui/.../forms/CharCountTextarea.tsx` | ✅ Done — fixed-height, char countdown |
| `StepIndicator` | Stays inline in PlaceReviewFormV3 | N/A — form-specific, not generic enough yet |
| `PlaceAutocomplete` | Stays inline in PlaceReviewFormV3 | N/A — tRPC-dependent, not generic |

All components export through `packages/ui/src/ui/tamagui/components/forms/index.ts` barrel.

### Remaining (deferred)

- [ ] Add Storybook stories for each new component
- [ ] Add `testIdBase` prop to all new components

# Living Room Mode — Feature Set

**Date:** 2026-04-15
**Status:** draft
**Priority:** P0
**Depends on:** `delayed-address-reveal.spec.md` (same date — address reveal is extracted into its own spec)
**Related:** Ithas Fire Product Spec v1.0 (sections 2, 3, 4, 8)

---

## Problem

Ithas Fire has two audiences: licensed venues selling tickets, and private hosts opening their spaces for house shows. The platform currently only serves the first. Living Room Mode is the feature set that serves the second — RSVP-based events with pay-what-you-can contributions, private address reveal, and host-specific space details.

The product spec proposed this as a rigid `EventMode` enum (VENUE | LIVING_ROOM | HYBRID) with separate models for everything. That's too heavy. The platform already has the building blocks — tickets, orders, places, settlements. Living Room Mode is a **feature preset** that configures existing systems differently, plus a handful of genuinely new capabilities.

---

## Goal

An artist can create a private event where attendees RSVP, contribute what they can, and receive the address close to show time. A host can describe their space, set capacity, and walk through a safety checklist. The money flows through the same Stripe + settlement pipeline as venue events.

---

## Context

| What exists | Where |
|---|---|
| `Event` model with `locationMode: HIDDEN` | `event.prisma` |
| `TicketType` with `priceCents`, `capacity` | `ticket.prisma` |
| `Order` → `OrderItem` → `OrderSplit` → `Settlement` pipeline | `order.prisma`, `finance.prisma` |
| `Payee` model (Stripe Connect for humans + orgs) | `finance.prisma` |
| `Place` model with address, capacity, verification, availability | `place.prisma` |
| `PlaceReview` + `PlaceStats` (artist-submitted venue reviews) | `place-review.prisma` |
| `EventVisibility`: PUBLIC / PRIVATE | `enums.prisma` |
| `EventGateType`: NONE / APPLICATION / PASSWORD | `enums.prisma` |
| `EventWaitlistEntry` (status lifecycle) | `application.prisma` |
| Delayed address reveal (new, same date) | `delayed-address-reveal.spec.md` |

---

## Design: Feature Preset, Not a Mode Enum

Instead of a rigid `EventMode` enum that partitions the world into VENUE / LIVING_ROOM / HYBRID, use a **feature preset** that configures a bundle of capabilities:

### New field on Event

```prisma
// Add to Event in event.prisma:

/// Feature preset that controls default settings for this event.
/// STANDARD = licensed venue, fixed-price tickets, public listing.
/// LIVING_ROOM = private space, RSVP + contribution, delayed address reveal.
/// CUSTOM = organizer has overridden individual settings.
featurePreset    EventFeaturePreset  @default(STANDARD)
```

### New enum

```prisma
enum EventFeaturePreset {
  STANDARD       // venue ticketing (current default behavior)
  LIVING_ROOM    // RSVP + contribution + delayed reveal + private
  CUSTOM         // organizer mixed and matched
}
```

### What the preset controls

When an organizer selects "Living Room" in the event creation flow, these defaults are set:

| Setting | STANDARD default | LIVING_ROOM default | Field |
|---|---|---|---|
| Visibility | PUBLIC | PRIVATE | `Event.visibility` |
| Gate type | NONE | APPLICATION | `Event.gateType` (APPLICATION = RSVP approval) |
| Location mode | EXACT | HIDDEN | `Event.locationMode` |
| Address reveal | immediate | DAY_BEFORE | `Event.addressRevealPreset` |
| Pricing mode | fixed | pay-what-you-can | `TicketType.pricingMode` (new) |

The organizer can override any individual setting. When they do, the preset flips to `CUSTOM`. This is purely a UI convenience — the underlying fields are the real source of truth.

---

## Feature 1: Contribution Pricing (Pay-What-You-Can)

### Approach: Extend TicketType, not a new model

A contribution tier IS a ticket type with flexible pricing. This keeps the entire Order → OrderItem → OrderSplit → Settlement pipeline intact. No new payment models needed.

### New fields on TicketType

```prisma
// Add to TicketType in ticket.prisma:

/// Pricing mode for this ticket type.
/// FIXED = standard fixed-price ticket (priceCents is the price).
/// CONTRIBUTION = pay-what-you-can (priceCents is the suggested amount).
pricingMode         TicketTypePricingMode  @default(FIXED)

/// Minimum price in cents. Only used when pricingMode = CONTRIBUTION.
/// Null or 0 = free RSVP allowed ("no one turned away for lack of funds").
minPriceCents       Int?

/// Maximum price in cents. Only used when pricingMode = CONTRIBUTION.
/// Null = no cap.
maxPriceCents       Int?

/// Label for contribution tier (e.g., "Support the Artist", "Keep This Alive").
/// Only used when pricingMode = CONTRIBUTION.
contributionLabel   String?
```

### New enum

```prisma
enum TicketTypePricingMode {
  FIXED          // standard: buyer pays exactly priceCents
  CONTRIBUTION   // pay-what-you-can: priceCents is the suggested amount
}
```

### How it works in the checkout flow

1. **Event creation:** Artist creates a Living Room event. A default `TicketType` is created with `pricingMode: CONTRIBUTION`, `priceCents: 2000` (suggested $20), `minPriceCents: 0` (free RSVP allowed).
2. **Checkout UI:** Instead of a fixed price, the attendee sees:
   - "Suggested contribution: $20 — pay what you can"
   - A slider or preset buttons: $0 / $15 / $20 / $30 / Custom
   - The $0 option is always available if `minPriceCents` is 0 or null
3. **Order creation:** The `OrderItem.unitPriceCents` is set to whatever the attendee chose. The `OrderItem.amountCents` = `unitPriceCents * qty`.
4. **Settlement:** The existing split pipeline handles it. `OrderSplit` distributes to the artist's `Payee` based on `PayoutTerms`.

**What about multiple tiers?** The artist can create multiple `TicketType` records with `pricingMode: CONTRIBUTION`:
- "I'll Be There" — suggested $0, min $0 (free RSVP)
- "Support the Artist" — suggested $20, min $0
- "Keep This Alive" — suggested $40, min $20

Each tier is a `TicketType` with its own `contributionLabel`, `priceCents` (suggested), `minPriceCents`, `maxPriceCents`. The checkout shows them as options, not as separate "ticket types."

### UI language change

The checkout needs mode-aware copy:
- FIXED: "Buy Tickets" → "Complete Purchase" → "Your tickets"
- CONTRIBUTION: "RSVP" → "Contribute" → "You're on the list"

This is a frontend concern — the API is identical.

---

## Feature 2: RSVP Approval Flow

### Approach: Reuse EventGateType.APPLICATION

The existing APPLICATION gate type already has:
- `EventApplicationForm` with configurable questions
- `EventApplicationSubmission` with PENDING → APPROVED → REJECTED status
- `EventUnlock` granted on approval

For Living Room Mode, the "application" IS the RSVP. The form can be as simple as:
- Name (auto-filled if logged in)
- "Are you bringing a +1?" (number input)
- Optional message to host

When the host approves, an `EventUnlock` is created. The attendee can then proceed to the contribution checkout (which may be $0).

### What's genuinely new

The existing application flow doesn't have:
- **Guest count** — need a `guestCount` field on `EventApplicationSubmission` (or use a form question)
- **Capacity tracking** — the host sets capacity on `TicketType.capacity`. As RSVPs are approved and orders created, capacity decrements. When full, new RSVPs are waitlisted.

### New field on EventApplicationSubmission

```prisma
// Add to EventApplicationSubmission in application.prisma:

/// Number of guests (including the applicant). Default 1.
/// Used for Living Room mode capacity tracking.
guestCount     Int   @default(1)
```

That's it. The rest of the RSVP flow is the existing APPLICATION gate with Living Room-specific form defaults.

---

## Feature 3: PlaceDetails (Extending Place for Host Spaces)

### Approach: New fields on Place, not a new model

The `Place` model already has address, capacity, lat/lng, verification, ownership, availability, and reviews. Host-specific details are additional fields, gated by a `placeKind` discriminator.

### New fields on Place

```prisma
// Add to Place in place.prisma:

/// Whether this is a traditional licensed venue or a private/DIY space.
placeKind           PlaceKind  @default(VENUE)

// ── Host space details (only populated when placeKind != VENUE) ────────

/// Type of private space.
spaceType           PlaceSpaceType?

/// Volume level the space can handle.
maxVolume           PlaceVolumeLevel?

/// Noise notes (e.g., "neighbors cool until 10pm").
noiseNotes          String?  @db.VarChar(500)

/// Whether the host offers crash space for touring artists.
hasCrashSpace       Boolean  @default(false)
crashSpaceNotes     String?  @db.VarChar(500)

/// Whether the space has a PA system.
hasPA               Boolean  @default(false)

/// Whether the space has backline (amps, drums, etc.).
hasBackline         Boolean  @default(false)

/// Acoustic-only space (no amplification allowed).
acousticOnly        Boolean  @default(false)

/// Parking notes.
parkingNotes        String?  @db.VarChar(500)

/// Accessibility information.
accessibilityNotes  String?  @db.VarChar(500)

/// Safety checklist completion state (JSON — see Feature 4).
safetyChecklist     Json?
```

### New enums

```prisma
enum PlaceKind {
  VENUE              // licensed commercial venue
  LIVING_ROOM        // primary residence interior
  BACKYARD           // outdoor residential
  BASEMENT           // below-grade residential
  STUDIO             // dedicated creative space
  WAREHOUSE          // industrial/commercial DIY
  COMMUNITY          // shared community space (church hall, library)
  OTHER
}

enum PlaceSpaceType {
  INDOOR
  OUTDOOR
  MIXED
}

enum PlaceVolumeLevel {
  ACOUSTIC_ONLY
  MODERATE
  LOUD
  FULL_VOLUME
}
```

### Why not a separate model?

- Place already has address, capacity, lat/lng, verification, ownership, availability, reviews, stats, slug, SEO
- PlaceReview already captures most of this from the artist's perspective (sound quality, stage equipment, parking, booker)
- A separate HostSpace model would duplicate all of that and create a fork in every query
- The `placeKind` discriminator gates the host-specific fields — venue owners never see them

---

## Feature 4: Host Safety Checklist

A guided checklist shown when a host creates or updates a non-VENUE Place. Not gatekeeping — education. The checklist state is stored as JSON on `Place.safetyChecklist`.

### Checklist schema

```typescript
interface SafetyChecklist {
  fireExits: {
    checked: boolean;
    note?: string;  // "Back door leads to alley"
  };
  capacity: {
    checked: boolean;
    value: number;  // realistic safe capacity (writes to Place.capacity)
  };
  neighborNotified: {
    checked: boolean;
    note?: string;  // "Talked to both neighbors, cool with it"
  };
  noiseCurfew: {
    checked: boolean;
    time?: string;  // "22:00"
  };
  parking: {
    checked: boolean;
    note?: string;  // "Street parking, arrive early"
  };
  insurance: {
    checked: boolean;
    note?: string;  // informational — not required
  };
  accessibility: {
    checked: boolean;
    note?: string;  // "3 steps to front door, no ramp"
  };
}
```

### UI

Progressive disclosure — show items one at a time with helper text explaining why it matters. Use the same Typeform-style one-question-at-a-time pattern from the PlaceReview v3 form.

Items marked "required" must be answered (but the answer can be "no" — we're not gatekeeping). Items marked "informational" can be skipped.

| Item | Required? | Helper text |
|---|---|---|
| Fire exits | Yes | "Can people get out if the front door is blocked?" |
| Capacity | Yes | "How many people can comfortably and safely fit?" |
| Neighbors | Recommended | "Have you talked to your neighbors about hosting shows?" |
| Noise curfew | Yes | "What time does noise need to stop?" |
| Parking | Recommended | "Where will guests park without blocking neighbors?" |
| Insurance | Informational | "Does your homeowner's/renter's insurance cover gatherings?" |
| Accessibility | Yes | "Are there stairs, narrow doorways, or other barriers?" |

---

## Event Creation Flow: Living Room Preset

When an artist selects "Living Room" in the event creation UI:

1. **Space selection:** Pick an existing Place (with `placeKind != VENUE`) or create a new one. If new, walk through safety checklist first.
2. **Event details:** Title, date, time, description — same as venue events.
3. **Contribution setup:** Default TicketType created with `pricingMode: CONTRIBUTION`, suggested $20. Artist can adjust or add tiers.
4. **RSVP settings:** `gateType: APPLICATION`, approval required by default. Artist can set max capacity.
5. **Address reveal:** Defaults to `DAY_BEFORE`. Artist can change.
6. **Visibility:** Defaults to PRIVATE. Artist can make it PUBLIC (rare for house shows, but possible).

The event is created with `featurePreset: LIVING_ROOM`. All the underlying fields are set independently — the preset is just a UI shortcut.

---

## Acceptance Criteria

- [ ] `EventFeaturePreset` enum exists with STANDARD, LIVING_ROOM, CUSTOM
- [ ] Selecting "Living Room" preset sets: visibility PRIVATE, gateType APPLICATION, locationMode HIDDEN, addressRevealPreset DAY_BEFORE, default TicketType with pricingMode CONTRIBUTION
- [ ] `TicketTypePricingMode` enum exists with FIXED, CONTRIBUTION
- [ ] Contribution TicketType has `priceCents` (suggested), `minPriceCents`, `maxPriceCents`, `contributionLabel`
- [ ] Checkout UI shows slider/presets for CONTRIBUTION pricing mode
- [ ] $0 RSVP is allowed when `minPriceCents` is 0 or null
- [ ] Orders from contribution events flow through the existing settlement pipeline (no new payment models)
- [ ] APPLICATION gate type handles RSVP approval with `guestCount` on submissions
- [ ] `PlaceKind` discriminator on Place gates host-specific fields
- [ ] Host safety checklist stored as JSON on `Place.safetyChecklist`
- [ ] Safety checklist UI uses one-question-at-a-time pattern
- [ ] Overriding any preset default flips `featurePreset` to CUSTOM
- [ ] Existing STANDARD events are completely unaffected (backward compatible)

---

## Open Questions

- **Multiple contribution tiers vs single slider:** The DOCX spec proposed 4 tiers (Free, Support, Generous, Custom). Micah mentioned it "feels like a ticket type." Should the default Living Room event have one TicketType with a slider, or multiple TicketTypes as preset tiers? Start with one + slider, let artists add tiers if they want.
- **Host profit:** The DOCX spec says "host does NOT profit (patron model)." Should the platform enforce this (no Payee for the host, all money goes to artist) or just frame it as convention? Enforce it — don't create PayoutTermsLines for the host/place owner. Only the artist Payee gets splits.
- **HYBRID preset:** The DOCX spec proposed HYBRID (venue with contribution option alongside tickets). Defer — ship STANDARD and LIVING_ROOM first. HYBRID is CUSTOM with specific settings.

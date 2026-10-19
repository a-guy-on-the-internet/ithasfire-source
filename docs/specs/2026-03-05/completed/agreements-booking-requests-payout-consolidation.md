# Agreements, Booking Requests & Payout Consolidation

> **Status**: Draft
> **Created**: 2026-03-05
> **Authors**: Engineering Team

## Overview

Three related features that share infrastructure:

1. **Agreement model** -- A lightweight deal structure between parties (artist + place, org + venue, etc.) that can optionally link to PayoutTerms but exists as its own entity with lifecycle, signatures, and waivers.
2. **Booking requests** -- The formalized pitch flow: an artist discovers a place, proposes a show, and the place owner accepts/declines/counters. Acceptance creates an Agreement and optionally scaffolds an Event.
3. **Payout consolidation** -- Solve the "$2-per-payee Stripe transfer cost" problem by batching multiple payees' settlements into fewer transfers and offering configurable payout thresholds.

Events continue to support arbitrary payout structures directly (`Event.payoutTermsId` + `PayoutTermsLine[]`). Agreements are an **optional** wrapper for when two parties need to formalize terms before an event exists.

---

## The Stripe Transfer Cost Problem

### Current state

Each `executeSettlementTransfer` call creates one `stripe.transfers.create()` per payee per settlement. Stripe charges:

- **$0.25 per transfer** (standard Connect payout)
- Plus **0.25% of the transfer amount** (payout fee)

For a $200 house show split between 3 artists, a venue, and a sound engineer (5 payees):

| Payee | Split | Stripe transfer fee |
|-------|-------|-------------------|
| Headliner | $80 | $0.25 + $0.20 = $0.45 |
| Opener A | $40 | $0.25 + $0.10 = $0.35 |
| Opener B | $40 | $0.25 + $0.10 = $0.35 |
| Venue | $30 | $0.25 + $0.08 = $0.33 |
| Sound | $10 | $0.25 + $0.03 = $0.28 |
| **Total** | **$200** | **$1.76** |

That's **0.88% of gross** eaten by transfer fees alone -- on top of the 2.9% + $0.30 card processing fee. For small shows this is brutal. A $50 show with 3 payees costs ~$0.87 in transfer fees = **1.74% of gross**.

### The FeePolicy already models this

`FeePolicy` has `payoutPct` (0.25%), `payoutFixedCents` ($0.25), and `monthlyPayoutCents`. These are tracked but **never actually deducted from payee amounts or consolidated across events**. They're informational only right now.

### Solutions (implement in priority order)

**Solution 1: Payout minimum threshold (simple, high impact)**

Don't transfer until a payee has accumulated at least N cents across settlements. The `Settlement` model already groups by `(payeeId, scheduledPayoutDate)`. Change the batch runner to:

- Sum all pending settlements for a payee
- If `totalCents < payoutMinimumCents` (configurable per FeePolicy, default $10/1000 cents), skip and re-schedule
- When threshold is met, create ONE transfer for the batch total

This turns 5 transfers of $10 from 5 separate events into 1 transfer of $50. Transfer cost drops from $1.38 to $0.38.

**Solution 2: Per-event payee consolidation (medium complexity)**

Currently `createSettlementsFromOrder` creates one settlement per payee per order. For a 3-artist show where 50 people buy tickets, that's 50 orders x 3 payees = 150 settlement lines but only 3 transfers (settlements already batch by `(payeeId, scheduledPayoutDate)`).

This is already correct. The consolidation is at the `Payout` → `PayoutItem` level: one `PayoutItem` per `(payoutId, payeeId, currency)`. The batch runner groups settlements into a single transfer per payee. **This is already designed correctly in the schema** -- `run-batch.ts` just needs implementation.

**Solution 3: Platform-mediated payouts for small amounts**

For payees below a threshold (e.g., sound engineer getting $10), offer the option to receive payout via the platform's own mechanism (e.g., platform credit, manual check, or deferred to next event) instead of a Stripe transfer. This avoids the $0.25 fixed fee entirely for micro-payouts.

This is a v2 concern. Model it as a `PayoutMethod` enum on `Payee`: `STRIPE_CONNECT | PLATFORM_CREDIT | MANUAL`.

**Solution 4: Absorb transfer fees into platform fee**

The `FeePolicy.payoutPct` and `payoutFixedCents` already exist. When computing splits in `computeTicketPriceForAgreement`, deduct the estimated transfer cost from payee amounts (or add to buyer fees in PASS_THROUGH mode). This makes the cost visible and explicit rather than a surprise margin hit.

### Recommended implementation

1. **Implement `run-batch.ts`** -- the payout batch runner that groups settlements into PayoutItems. This already consolidates per-payee. (Spec: separate, but prerequisite.)
2. **Add `payoutMinimumCents`** to `FeePolicy` (default 1000 = $10). Batch runner skips payees below threshold.
3. **Deduct transfer fees from payee splits** using existing `payoutPct`/`payoutFixedCents` in the pricing math. Make this visible in OrderSummary as "Transfer processing" or similar.

---

## 1. Agreement Model

### Why separate from PayoutTerms?

PayoutTerms is a financial structure: who gets what percentage, floor guarantees, caps, rounding. It's the math.

An Agreement is a **relationship artifact**: "Artist X will perform at Place Y on Date Z under these conditions." It wraps PayoutTerms but also carries:

- Who proposed it and who accepted
- Waiver/liability acknowledgment
- Rider/notes (PA provided, no drums after 10pm, etc.)
- Lifecycle (proposed → accepted → fulfilled → disputed)
- Link to the resulting Event (if one was created)

### Schema

```prisma
enum AgreementType {
  PERFORMANCE     // artist plays at a place
  VENUE_RENTAL    // org rents a place for an event
  SERVICES        // sound, lighting, etc.
  REVENUE_SHARE   // ongoing revenue split
  CUSTOM
}

enum AgreementStatus {
  DRAFT           // creator is still editing
  PROPOSED        // sent to counterparty
  COUNTERED       // counterparty modified terms, sent back
  ACCEPTED        // both parties agreed
  DECLINED        // counterparty rejected
  CANCELLED       // creator withdrew
  FULFILLED       // event happened, settlements complete
  EXPIRED         // expiresAt passed without acceptance
  DISPUTED        // post-event disagreement (links to Claim)
}

model Agreement {
  id                String          @id @default(uuid())
  type              AgreementType
  status            AgreementStatus @default(DRAFT)

  // Parties
  proposerType      String          // "human" | "organization"
  proposerId        String          // who initiated
  counterpartyType  String          // "human" | "organization"
  counterpartyId    String          // who needs to accept

  // Links
  placeId           String?         // the place this agreement is about
  eventId           String?         // created after acceptance
  payoutTermsId     String?         // the financial terms

  // Deal details
  title             String          // "Fri Night Set @ The Hideout"
  description       String?         // notes, rider info, equipment provided
  proposedDate      DateTime?       // when the show would happen
  proposedEndDate   DateTime?
  guaranteeCents    Int?            // shorthand for "artist minimum" (maps to floorCents on PayoutTermsLine)

  // Lifecycle
  proposedAt        DateTime?       // when status moved to PROPOSED
  acceptedAt        DateTime?
  declinedAt        DateTime?
  declinedReason    String?
  expiresAt         DateTime?       // auto-expire if not accepted by this time
  fulfilledAt       DateTime?

  // Waiver
  waiverAccepted    Boolean         @default(false)
  waiverAcceptedAt  DateTime?
  waiverVersion     Int?            // which version of the place's waiver was signed

  metadata          Json            @default("{}")

  place             Place?          @relation(fields: [placeId], references: [id], onDelete: SetNull)
  event             Event?          @relation(fields: [eventId], references: [id], onDelete: SetNull)
  payoutTerms       PayoutTerms?    @relation(fields: [payoutTermsId], references: [id], onDelete: SetNull)

  createdAt         DateTime        @default(now())
  updatedAt         DateTime        @updatedAt

  @@index([proposerType, proposerId, status])
  @@index([counterpartyType, counterpartyId, status])
  @@index([placeId, status])
  @@index([eventId])
}
```

### Relationship to events and PayoutTerms

```
Agreement (optional deal wrapper)
    ├── PayoutTerms (financial structure -- the math)
    │   └── PayoutTermsLine[] (per-payee splits)
    └── Event (the actual show)
        └── Event.payoutTermsId (points to the same PayoutTerms)

Event (can also exist without an Agreement)
    └── Event.payoutTermsId (arbitrary payout structure, set by organizer directly)
```

Events do NOT require an Agreement. An organizer can create an event, set up PayoutTerms directly, and sell tickets. Agreements are for when **two parties who don't already have a relationship** need to formalize terms.

---

## 2. Booking Requests

A booking request is the **pitch**: an artist finds a place and says "I want to play there." It's lighter than an Agreement -- it's the conversation that leads to one.

### Schema

```prisma
enum BookingRequestStatus {
  PENDING         // artist sent the pitch
  VIEWED          // place owner opened it
  ACCEPTED        // place owner wants to proceed -> creates Agreement
  DECLINED        // not interested
  WITHDRAWN       // artist pulled back
  EXPIRED         // no response within TTL
}

model BookingRequest {
  id              String              @id @default(uuid())
  placeId         String
  artistHumanId   String              // the human who wants to perform

  // The pitch
  message         String              // "Hey, I'm a solo acoustic act..."
  preferredDates  Json                @default("[]") // array of { date, startTime?, endTime? }
  expectedDraw    Int?                // "I usually bring ~30 people"
  genre           String?
  links           Json                @default("[]") // social/music links

  status          BookingRequestStatus @default(PENDING)
  viewedAt        DateTime?
  respondedAt     DateTime?
  declineReason   String?

  // If accepted, the resulting agreement
  agreementId     String?             @unique
  expiresAt       DateTime?           // auto-expire after N days without response

  place           Place               @relation(fields: [placeId], references: [id], onDelete: Cascade)
  artist          Human               @relation("BookingRequestArtist", fields: [artistHumanId], references: [id], onDelete: Cascade)
  agreement       Agreement?          @relation(fields: [agreementId], references: [id], onDelete: SetNull)

  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([placeId, status])
  @@index([artistHumanId, status])
}
```

### Flow

```
Artist browses places
    → finds interesting venue/house
    → sends BookingRequest (message, preferred dates, expected draw)

Place owner sees request in dashboard
    → PENDING → VIEWED (on open)
    → reviews artist's links/message
    → ACCEPTS:
        1. System creates Agreement (DRAFT, pre-populated from place's default PayoutTerms)
        2. Place owner can tweak terms or accept defaults
        3. Agreement moves to PROPOSED → artist accepts → ACCEPTED
        4. "Create Event from Agreement" action scaffolds the Event
    → DECLINES:
        with optional reason

Auto-expiry:
    BookingRequests expire after 14 days (configurable) if no response
    Agreements in PROPOSED status expire per expiresAt
```

---

## 3. Place Waivers

```prisma
model PlaceWaiver {
  id        String  @id @default(uuid())
  placeId   String
  title     String  // "Liability Waiver", "House Rules & Safety"
  content   String  @db.Text // markdown
  version   Int     @default(1)
  isActive  Boolean @default(true)

  place     Place   @relation(fields: [placeId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([placeId, isActive])
}
```

Waivers are signed via the Agreement (`waiverAccepted`, `waiverAcceptedAt`, `waiverVersion`). For ticket buyers at house shows, the waiver acknowledgment happens at checkout (a required checkbox). Store the signature as metadata on the Order: `order.metadata.waiverPlaceId`, `order.metadata.waiverVersion`, `order.metadata.waiverAcceptedAt`.

No separate signature table for v1. The Agreement and Order records are the audit trail.

---

## 4. Place Availability

```prisma
model PlaceAvailability {
  id        String    @id @default(uuid())
  placeId   String
  dayOfWeek Int?      // 0=Sun..6=Sat (null = specific date only)
  date      DateTime? // specific date (null = recurring weekday)
  startTime String?   // "19:00" local time
  endTime   String?   // "23:00"
  note      String?   // "PA provided", "no drums after 10pm"
  isOpen    Boolean   @default(true) // false = explicitly blocked/booked

  place     Place     @relation(fields: [placeId], references: [id], onDelete: Cascade)

  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([placeId, isOpen])
  @@index([placeId, dayOfWeek])
  @@index([placeId, date])
}
```

---

## 5. Default PayoutTerms Templates for Places

Places can set a default PayoutTerms that pre-populates when an Agreement is created.

Already supported: `PayoutTerms.subjectType = "PLACE"`, `PayoutTerms.subjectId = placeId`, `PayoutTerms.isDefault = true`.

### Needed

- **Use case**: `setPlaceDefaultPayoutTerms(placeId, lines[])` -- creates or updates the default PayoutTerms for a place.
- **Use case**: `getPlaceDefaultPayoutTerms(placeId)` -- returns the active default, if any.
- **Clone on Agreement creation**: when a BookingRequest is accepted, clone the place's default PayoutTerms into a new instance linked to the Agreement. Both parties can then modify the clone without affecting the template.

---

## 6. Use Cases (implementation order)

### Phase 1: Payout consolidation (unblocks the financial model)

| Use case | Description | Priority |
|----------|-------------|----------|
| `run-payout-batch` | Implement the empty `run-batch.ts`. Group pending settlements by payee, create PayoutItems, execute transfers. Respect `payoutMinimumCents`. | P0 |
| Add `payoutMinimumCents` to FeePolicy | Migration + update `upsert-org-fee-policy` and `get-org-fee-policy`. Default 1000 ($10). | P0 |
| Deduct transfer fees in split math | Use `payoutPct`/`payoutFixedCents` from FeePolicy when computing splits. Currently informational only. | P1 |

### Phase 2: Place infrastructure (unblocks discovery and pitching)

| Use case | Description | Priority |
|----------|-------------|----------|
| `create-place-availability` | CRUD for PlaceAvailability. Org-scoped authz. | P0 |
| `list-place-availability` | Public query for verified places. | P0 |
| `set-place-default-payout-terms` | Create/update default PayoutTerms for a place. | P1 |
| `get-place-default-payout-terms` | Fetch active default. | P1 |
| `create-place-waiver` | CRUD for PlaceWaiver (org-scoped). | P1 |
| Place search (Meilisearch) | Index verified public places. Filter by location, type, capacity, genre. | P1 |

### Phase 3: Agreements & booking requests

| Use case | Description | Priority |
|----------|-------------|----------|
| `create-booking-request` | Artist pitches a place. Validates place is public + verified. Creates PENDING request. | P0 |
| `list-booking-requests` | Place owner sees incoming requests. Artist sees their sent requests. | P0 |
| `respond-to-booking-request` | Accept (creates Agreement draft) or decline (with reason). | P0 |
| `create-agreement` | Creates Agreement. If from booking request, pre-populates from place defaults. | P0 |
| `update-agreement` | Modify terms while DRAFT or COUNTERED. | P1 |
| `propose-agreement` | Move DRAFT → PROPOSED (sends to counterparty). | P1 |
| `accept-agreement` | Counterparty accepts. Status → ACCEPTED. Waiver signed if required. | P0 |
| `decline-agreement` | Counterparty rejects with reason. | P1 |
| `create-event-from-agreement` | Scaffold Event from accepted Agreement: place, date, PayoutTerms, payees. Event starts as DRAFT. | P0 |

### Phase 4: Notifications

| Use case | Description | Priority |
|----------|-------------|----------|
| Booking request received | Email/in-app to place owner | P0 |
| Agreement proposed | Email/in-app to counterparty | P0 |
| Agreement accepted/declined | Email/in-app to proposer | P0 |
| Booking request expiring | 48h warning to place owner | P1 |

---

## 7. Schema changes summary

### New models
- `Agreement`
- `BookingRequest`
- `PlaceWaiver`
- `PlaceAvailability`

### Modified models
- `FeePolicy`: add `payoutMinimumCents Int @default(1000)`
- `Place`: add relations to `PlaceAvailability[]`, `PlaceWaiver[]`, `Agreement[]`, `BookingRequest[]`
- `Event`: add relation to `Agreement?` (optional)
- `Human`: add relation to `BookingRequest[]`
- `PayoutTerms`: add relation to `Agreement[]`

### New enums
- `AgreementType`
- `AgreementStatus`
- `BookingRequestStatus`

### No changes to
- `PayoutTerms` / `PayoutTermsLine` (already correct)
- `Settlement` / `SettlementLine` (already correct)
- `Payout` / `PayoutItem` / `PayoutItemSettlement` (already correct)
- `OrderSplit` (already correct)
- Core pricing math in `computeTicketPriceForAgreement` (already handles splits)

---

## 8. Key invariants

- `sum(PayoutTermsLine.percent) == 100` for any PayoutTerms
- `sum(OrderSplit.amountCents) == basis` after rounding (existing invariant, unchanged)
- An Event can have PayoutTerms without an Agreement (direct organizer setup)
- An Agreement can exist without an Event (deal agreed but show not yet created)
- A BookingRequest can exist without an Agreement (pitch not yet accepted)
- `payoutMinimumCents` only defers transfers, never loses money. Settlements still accrue.
- Transfer fees (`payoutPct` + `payoutFixedCents`) are deducted from the payee's share, not added to the buyer (unless PASS_THROUGH mode is configured to include them)

---

## 9. Test matrix

| Test | What it validates |
|------|-------------------|
| Booking request → accept → agreement → event pipeline | Full happy path |
| Booking request auto-expiry (14d) | Cron/job correctly expires |
| Agreement with place default PayoutTerms clone | Clone is independent of template |
| Agreement decline + re-pitch | Artist can send new request after decline |
| Payout batch with 3 payees, one below minimum | 2 transfers created, 1 deferred |
| Payout batch idempotency | Repeated run doesn't duplicate transfers |
| Transfer fee deduction in split math | Payee receives (split - transferFee) |
| Transfer fee with PASS_THROUGH mode | Buyer total includes transfer fee estimate |
| Waiver signed on agreement acceptance | `waiverAccepted=true`, version stamped |
| Waiver required at checkout for house show | Order blocked without waiver checkbox |
| Place availability: recurring weekday + specific date block | Correct availability returned |
| Agreement without event (deal agreed, show TBD) | Valid state, no errors |
| Event without agreement (direct organizer setup) | Existing flow unchanged |

---

## 10. Open questions

1. **Should transfer fees be visible to payees?** Currently `payoutPct`/`payoutFixedCents` exist in FeePolicy but are never shown to artists. Should the Agreement UI show "estimated transfer fee: $0.35" per payee?

2. **Counter-offer flow**: When a place owner modifies terms on an Agreement and sends it back, do we version the PayoutTerms (PayoutTerms.version++) or create a new PayoutTerms row? Versioning is simpler; new row is more auditable.

3. **Buyer waiver at checkout**: For house shows, should the waiver checkbox be on the checkout page or a separate interstitial? Checkout page is simpler but adds visual weight.

4. **Payout minimum UX**: When a payee's balance is below the minimum, what do they see? "Your payout of $8.50 will be included in your next qualifying payout (minimum $10.00)" -- need to surface this in a payee dashboard.

5. **Place availability timezone**: `startTime`/`endTime` are stored as strings ("19:00"). We need the place's timezone to interpret these. Add `timezone` to Place model or always store/display in the place's local tz?

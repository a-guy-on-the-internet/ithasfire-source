# Venue Confirmation & Booking Intents

> Not built yet (2026-10-08 docs consolidation): Rental payment: RentalPaymentsPort, StripeRentalPayments adapter, rental charge ledger kinds, webhook. Only rentalRateCents on calendars exists

**Date:** 2026-08-27
**Status:** draft — grilled to an empty frontier 2026-08-27 (six rounds, owner-locked); one discussion parked (form fields). **Amended 2026-09-25:** unclaimed venues take no requests; parking is removed (see the amendment at the end).
**Priority:** P2 (High Value)
**Depends on:** venue hierarchy (`Calendar`, `Space`, `CalendarSpace`, `CalendarAvailability` — venue.prisma), booking requests + thread + system entries, holds (`BookingHold`, `docs/specs/2026-08-25/completed/booking-holds.spec.yaml`), agreements + `createEventFromAgreement`, `Payee` + Express Connect, Stripe webhook (Connect secret already verified), claim-venue flow, `record-deals-not-execute`
**Supersedes:** `docs/specs/2026-08-26/completed/room-rental-payment-link.spec.md` — its payment mechanism survives intact as §Rental payment below; its spine (fee-on-agreement, rental as the subject) does not

---

## Problem

Today any organizer can name any verified venue as their event's place. Nothing asks the venue. The venue's own calendar lists that event and its availability counts it, so a stranger's draft occupies a room the venue never agreed to give — and a fan reading the public page sees "at The Blue Room" with the venue's name lent to something the venue may know nothing about.

Meanwhile the *legitimate* version of that — an act, a poetry night, a community meeting, a room rental — has a booking request, a thread, holds, and an agreement, but the result is always a **venue-owned** event. The person who asked never ends up owning their own show, can't sell their own tickets, and the venue is the one editing a night it only hosts.

Both are the same missing fact: **whether the venue stands behind this event.** This spec makes that a first-class property of the event, makes the request flow produce it in either direction (ask first, or build the event and ask), and adds the two intents the request form can't express today — renting a room, and just using it.

Evidence: one observed booking-room session (Drkmttr, 2026-07-27 — N=1, not demand) and an artist reporting rooms that rent instead of taking the door. Everything here is owner-decided design, built greenfield.

---

## Goal

A human — performer or not — can ask to *play at*, *rent*, or *use* a room on a venue's calendar, or build their event naming that room and let the request follow. The venue confirms, and confirmation is stamped on the event: it may now say the venue's name in public and it now blocks that room. Until then the event still records its intended place (for the organizer and for our data) but shows only an address and blocks nothing. The venue can withdraw. For rentals, paying the venue's fee — collected by Stripe directly into the venue's account, never ours — is what confirms. Owners of the resulting event default to whoever it's really for: the venue for a performance, the requester for a rental or a use. Trusted regulars get a standing per-place grant so their events are confirmed by construction.

---

## Vocabulary (→ `CONTEXT.md`)

| Term | Meaning | Avoid |
|---|---|---|
| **Intent** — `PERFORM \| RENT \| USE` | What the requester wants from the room. Public verbs: *Play here / Rent a space / Use a space*. | "request type", "booking kind" |
| **Requester** | The human or org asking. | "act" when the intent isn't PERFORM; "guest"; "customer" |
| **Venue side** | The place's owner (human or org) and their staff. | "host" — collides with nothing in code now, but reads as Airbnb |
| **Venue-confirmed** | The venue has stamped this event. Shown as *Confirmed by venue*. | "verified" (that's the Place), "approved" |
| **Address-only** | The public rendering of an event whose place is not venue-confirmed: location shown as an address, no venue name or link. | "hidden" |
| **Booking grant** | A standing per-place permission for one human to place holds and/or create venue-confirmed events there. | "role", "member" |

`HostSpace` / `LIVING_ROOM` / `EventMode` existed only in agent prompt text and were removed from `.claude/commands/spec.md` on 2026-08-27. House shows will be Places when they come; no separate concept.

---

## Context

| What exists | Where |
|---|---|
| `Calendar` (programming stream) ↔ `Space` (physical room) via `CalendarSpace`; `CalendarAvailability` (calendarId NULL = place-wide); a calendar with zero spaces makes placement "unknowable" | `venue.prisma:20-69`, `places/get-place-booking-availability.ts:67-221` |
| `BookingRequest` already has `calendarId` (nullable, form doesn't set it), `direction TO_VENUE\|TO_PERFORMER`, `preferredDates Json`, performer-shaped pitch fields, anonymous embed path with claim token | `agreement.prisma:65-205` |
| `BookingHold`: own table, (calendar, date, space?) ordered line, 24h challenge, lazy expiry, confirm = accept + draft event + release siblings; **owner-locked "Money never gates a hold"** | `agreement.prisma:280`, `booking-holds/*` |
| Thread system entries — plain-string kinds, exhaustive Zod contract; venue-internal kinds gated by side | `booking-requests/messages/_shared/system-entries.ts` |
| `createEventFromAgreement` — **owner is always the venue counterparty**; asserts `NOT_RESOURCE_OWNER` otherwise | `booking-agreements/create-event-from-agreement.ts:200-213, 613` |
| `Event.placeId` — **no ownership check anywhere**; XOR with saved-location/address | `event.prisma:518`, `events/create-event.ts` |
| Venue calendar + availability fetch by `placeId` with **no owner filter**: third-party events appear and block today | `events/get-calendar-events.ts:309,354,386` |
| `EventVisibility PUBLIC \| PRIVATE`; unlisted handled separately (`isPublic` listing) | `enums.prisma:261` |
| `Place.acceptsBookingRequests` (VERIFIED-gated) as the public-CTA switch; place-page CTA in `BookingInfoBlock` | `place.prisma:52`, `p/[slug]/_components/blocks/BookingInfoBlock.tsx` |
| Claim-venue flow (invite → claim) — the acquisition loop for unclaimed places | `places/*claim*`, memory `claim venue loop CLOSED` |
| Performer mode: a `PerformerProfile` with `enabledAt` set and `disabledAt` null (`isPerformerEnabled`) | `lib/performer-mode.ts:10` |
| Org roles `OWNER ADMIN EDITOR FINANCE SCANNER VIEWER`; EDITOR is the booking role (locked); a HUMAN-owned place has no org and no roles | `enums.prisma:64`, `PlaceOwnerType HUMAN\|ORGANIZATION` |
| Event builder: `QuickCreateEventForm` accepts `?calendarId=&spaceId=` from cell-create; `LocationSection` place selector is calendar-blind | `admin/[slug]/events/new/_components/` |
| `Payee` per owner (HUMAN/ORG) → `stripeAccountId`; eligible iff ACTIVE + chargesEnabled + payoutsEnabled; Express accounts; never mint a placeholder | `finance.prisma:10`, `stripe-connect/sync-connect-account.ts` |
| Stripe webhook: one endpoint, `STRIPE_WEBHOOK_SECRET` then `STRIPE_CONNECT_WEBHOOK_SECRET`; connected-account events verified; `event.account` never read; no `checkout.session.*` case; `invoice.payment_succeeded` is membership-only and throws on anything else | `apps/api/src/routes/stripe/webhook.ts:1121,1691` |
| Second Stripe adapter precedent (port + class + `dep.ts` composition) | `membership-billing-port.ts`, `membership-billing-adapter.ts` |
| Money posture: **record deals, don't execute them**; per-order floors removed; zero platform fee anywhere but tickets | memory `record-deals-not-execute` |

---

## Locked decisions (owner, 2026-08-27, six grilling rounds)

**Intents & who asks**
- Three intents: `PERFORM`, `RENT`, `USE`. USE is non-transactional — a meeting, a reading, a movie night, a prayer group. **USE always produces an event**; visibility is orthogonal and must work uniformly across all three.
- The requester is **any human** (or org). Performer mode sets the *default* intent (PERFORM); the intent is a **choice** on the form. A performer can rent or use.
- Intent picks the **form variant**. PERFORM = today's pitch form. RENT/USE = calendar → space → date + start/end → what it is (one line) → expected attendance → public or private → contact; RENT also shows the rate when the venue made it visible. No genre, EPK, lineup, stats. *(Field set is the parked discussion — this is the floor, not the ceiling.)*

**Calendar is the config layer; the space is what gets blocked**
- Per **Calendar**: which intents it accepts, a flat rental rate per booking (a day or a stated time slot), whether the rate is shown publicly, and `rentalMode` (`REQUEST` now; `INSTANT` reserved, own spec, **mutually exclusive** with rental requests on that calendar; performance requests are unaffected by it).
- The request dialog is **place-level with a space dropdown filtered by the chosen calendar**; the calendar dictates which intents are offered.
- **Every Place gets a default Calendar and a "Default room" Space at creation**, claimed or not. Every calendar has ≥1 space, enforced; backfill auto-creates "Default room" wherever missing. A venue rental blocks a **space**, never the whole venue (whole-venue rental is a later date).
- ~~`RENT` and `USE` **require** a space.~~ **Superseded 2026-09-22** (see the amendment under the data model below): a space is optional for EVERY intent — a request routes to a calendar and a window, and the room is chosen at accept/confirm on the draft event. A supplied space must still be on the routed calendar.

**Confirmation lives on the Event**
- Trust is **per event**, not per person: the venue vouches for *this* event at *this* place. Stamped `venueConfirmedAt` / `…ByHumanId` / `…BookingRequestId`.
- **Confirmed by construction:** events owned by the place's owner (human or org, via role), and events created by a human holding an active **booking grant** with `canCreateEvents`.
- **Unconfirmed events block nothing and mean nothing** until the venue looks and confirms. They *show* on the venue calendar as unconfirmed (so the venue sees who's claiming its room) but count for neither availability nor conflicts. **Behaviour change** for every venue; tested.
- **Public rendering:** venue name and link appear **only** when venue-owned or venue-confirmed; otherwise **address-only**. Unconfirmed and withdrawn render identically.
- **Withdrawal:** the venue can withdraw confirmation. The event keeps its `placeId` (the organizer's intent and our data are preserved), drops to address-only, stops blocking, the requester is notified with the reason and can edit afterwards. Any rental payment is untouched — refund is its own managed flow.
- **Unclaimed venues:** the event **still attaches to the specific `placeId`** (owner-required, for data). The request is parked as *venue not yet claimed* and fires the existing **claim invite** — every request at an unclaimed room is an acquisition touch. Confirmation is impossible until claimed. Claiming gates *responding*, never *requesting*. `Place.acceptsBookingRequests` becomes an **opt-out** for claimed venues.
- **Migration of existing third-party published events at places:** create a request to the venue for each, notify, and apply the address-only rule after a 14-day grace window. Greenfield makes the window near-moot; the mechanism is the durable one. No grandfathering.

**Two entry paths, one request**
- **Request-first:** place page CTA → dialog → request → thread → holds → confirm.
- **Event-first:** the builder names a place **and a calendar** (the place selector gains a calendar picker). If that calendar accepts the chosen intent, saving the event **auto-creates the booking request** — the request is now the venue *approving an event*. The builder asks the intent, offering only what the calendar allows. A place with no calendar accepting that intent can still be chosen as a plain address-only location: no request, no badge, nothing to confirm.

**Who mints, who owns**
- Owner **defaults by intent**: PERFORM → venue (today's behaviour); RENT / USE → **requester**. Venue side may override at confirm.
- **The requester never triggers the mint.** The venue confirms (or, for RENT, payment confirms) and the DRAFT lands in the requester's own admin. Mint authorization stays venue-side; only the owner assignment changes. Event-first needs no mint — confirm stamps the existing event.
- Payout defaults on a requester-owned event: **100% requester, no venue line**; the venue may add a door percentage in the agreement editor if negotiated. USE assumed free; paid tickets on a USE event still 100% requester.
- **Ticketing is unchanged.** A requester selling tickets on their own event needs their own Payee like anyone else; our platform fee applies to those tickets as always; **no rental-specific fee or payout path exists**. Tickets are where we earn; rentals are where we don't.

**Holds carry the rental**
- For RENT, **sending the payment link places a position-1 hold** for that calendar + date + space; **paying confirms it** (release siblings and competitors, mint/stamp the event); expiry releases it. This is an explicit, **RENT-scoped exception** to "money never gates a hold." Sending the link is the act that settles the date.
- One date per booking. A **run** concept is wanted; not in this spec.

**Payment: Stripe executes, we record** (unchanged from 08-26; see §Rental payment)
- Single-use Payment Link on the **venue's connected account** (direct charge). Venue is merchant of record for fees, refunds, disputes. **Zero platform fee, unplumbed.** No ledger, order, split, or settlement row — grep-guarded.
- Payment is its **own entity** anchored on the booking request; the event can be deleted and the payment survives, refundable, re-attachable by venue staff.
- **Managed refunds:** the requester asks with a reason; venue staff approve **any amount up to what was paid** (cumulative), decline with a reason, or refund unprompted. Nothing automatic on the event — human approval is what replaces the policy engine we don't have.
- Venue not on Stripe → **record a payment** (cash, Venmo, whatever) and the flow is identical from there.

**Trust for regulars — the booking grant**
- A **standalone per-place grant**, not an org role: `PlaceBookingGrant(placeId, calendarId?, humanId, canPlaceHolds, canCreateEvents, grantedBy, expiresAt?, revokedAt?)`. Works for human- and org-owned venues, scopes to a venue or one calendar, revocable, never touches membership. "Venues have agents they trust; they just add them."
- **This spec defines the model and the hook only** — confirmation and hold authorization check `place owner OR org-EDITOR OR active grant`. Granting/revoking UI ships with instant-book, which is what a grant is the prerequisite for. A `BOOKER` org role is **not** added (roles are load-bearing; role-action sweep still open).

---

## Data Model

```prisma
// ── Calendar: the config layer ────────────────────────────────────────────
enum RentalMode {
  REQUEST   // this spec
  INSTANT   // RESERVED — own spec; not selectable in UI. Mutually exclusive with rental requests on this calendar.
}

model Calendar {
  // … existing …
  acceptsPerform        Boolean     @default(true)   // preserves today
  acceptsRent           Boolean     @default(false)
  acceptsUse            Boolean     @default(false)
  rentalRateCents       Int?                          // flat per booking (day or stated slot)
  rentalRateCurrency    String?     @db.VarChar(3)
  rentalRateVisible     Boolean     @default(false)
  rentalMode            RentalMode  @default(REQUEST)
}
// Invariant (use-case + migration): every Calendar has ≥1 CalendarSpace.
// Every Place has ≥1 Calendar (isDefault) — created with the Place.

// ── Booking request: intent + the room + the window ───────────────────────
enum BookingIntent { PERFORM RENT USE }

model BookingRequest {
  // … existing …
  intent            BookingIntent  @default(PERFORM)   // existing rows = PERFORM
  spaceId           String?                            // optional for every intent (2026-09-22; see the amendment below)
  requestedStartsAt DateTime?                          // RENT/USE window; PERFORM keeps preferredDates
  requestedEndsAt   DateTime?
  purpose           String?        @db.VarChar(200)    // "what is it" — RENT/USE
  expectedAttendance Int?
  /// Event-first: the event that created this request (nullable; SetNull).
  originEventId     String?        @unique
  /// Unclaimed venue at request time — parked until the place is claimed.
  parkedUnclaimedAt DateTime?

  space         Space?  @relation(fields: [spaceId], references: [id], onDelete: SetNull)
  originEvent   Event?  @relation("BookingRequestOriginEvent", fields: [originEventId], references: [id], onDelete: SetNull)
  @@index([intent, status])
}
// SQL CHECK "BookingRequest_intent_shape_check":
//   intent IN ('RENT','USE') ⇒ requestedStartsAt IS NOT NULL AND requestedEndsAt IS NOT NULL
//
// AMENDED 2026-09-22 (owner ruling): `spaceId IS NOT NULL` was a third
// conjunct of this CHECK as originally shipped, and the use case demanded a
// room for RENT/USE. Both are gone — migration
// 20260922120000_booking_request_space_optional re-adds the CHECK under the
// same name without it. This follows the 2026-08-31 holds ruling ("THE SPACE
// PICKER IS GONE" — a hold is a place in line for a DATE on a CALENDAR):
// a RENT/USE request likewise routes to a calendar and a window. Nothing
// downstream reads a room off the request, and accept/mint already mints
// spacelessly rather than refusing. The room is chosen at accept/confirm, on
// the draft event, where it is real. Passing a `spaceId` stays legal, and a
// supplied room is still asserted onto the ROUTED calendar. The WINDOW stays
// required for RENT/USE.

// ── Event: confirmation is a fact on the event ────────────────────────────
model Event {
  // … existing; placeId ALWAYS retained regardless of confirmation ("attach it to the specific place for data") …
  venueConfirmedAt               DateTime?
  venueConfirmedByHumanId        String?     // plain id, house style
  venueConfirmationRequestId     String?     // the BookingRequest that produced it (nullable; SetNull)
  venueConfirmationWithdrawnAt   DateTime?
  venueConfirmationWithdrawnReason String?   @db.VarChar(500)

  @@index([placeId, venueConfirmedAt])       // calendar/availability: confirmed-only reads
}
// Derived, never stored: isVenueConfirmed = venueConfirmedAt != null && venueConfirmationWithdrawnAt == null
//                        OR event owner == place owner (venue-owned).
// Public rendering + blocking read this derivation ONLY.

// ── Rental payment: its own entity, outlives the event ────────────────────
enum RentalPaymentStatus {
  REQUESTED REFUND_REQUESTED PAID EXPIRED CANCELLED REFUNDED RECORDED
}

model RentalPayment {
  id                    String               @id @default(uuid())
  bookingRequestId      String                                   // the stable anchor
  agreementId           String?                                  // SetNull
  eventId               String?                                  // SetNull — "delete the event, payment survives"
  spaceId               String?                                  // SetNull
  holdId                String?              @unique             // the position-1 hold this link placed
  amountCents           Int
  currency              String               @db.VarChar(3)
  status                RentalPaymentStatus
  note                  String?              @db.VarChar(1000)   // what it covers, refund terms (venue prose = the policy)
  windowStartsAt        DateTime                                 // the paid-for window; named on the checkout line item
  windowEndsAt          DateTime
  requestedByHumanId    String
  requestedAt           DateTime             @default(now())
  dueAt                 DateTime
  paidAt                DateTime?
  refundedCents         Int                  @default(0)         // cumulative; ≤ amountCents
  recordedMethod        String?              @db.VarChar(40)     // RECORDED only
  refundRequestReason   String?              @db.VarChar(500)
  // Stripe objects — all on the VENUE's connected account.
  stripeAccountId       String?                                  // acct_… (tenant check on webhook); NULL when RECORDED
  stripePaymentLinkId   String?              @unique
  stripePaymentLinkUrl  String?
  stripeCheckoutSessionId String?            @unique
  stripePaymentIntentId String?              @unique

  bookingRequest BookingRequest @relation(fields: [bookingRequestId], references: [id], onDelete: Cascade)
  agreement      Agreement?     @relation(fields: [agreementId], references: [id], onDelete: SetNull)
  event          Event?         @relation(fields: [eventId], references: [id], onDelete: SetNull)
  space          Space?         @relation(fields: [spaceId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([bookingRequestId, status])
  @@index([status, dueAt])                                        // overdue sweep
}
// Shape: REQUESTED|PAID|EXPIRED|CANCELLED|REFUNDED|REFUND_REQUESTED ⇒ stripe* set; RECORDED ⇒ stripe* NULL.
// Payee.stripeRentalProductId String? — the lazily-created "Room rental" Product per connected account.

// ── Booking grant: model + hook only (UI with instant-book) ───────────────
model PlaceBookingGrant {
  id               String    @id @default(uuid())
  placeId          String
  calendarId       String?                     // NULL = whole place
  humanId          String
  canPlaceHolds    Boolean   @default(true)
  canCreateEvents  Boolean   @default(true)    // events they create at this place are confirmed by construction
  grantedByHumanId String
  expiresAt        DateTime?
  revokedAt        DateTime?
  place    Place     @relation(fields: [placeId], references: [id], onDelete: Cascade)
  calendar Calendar? @relation(fields: [calendarId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@index([placeId, humanId, revokedAt])
}
```

**Migrations, in order:** (1) backfill a default Calendar per Place lacking one and a "Default room" Space per Place lacking one, attach; enforce ≥1 space per calendar going forward. (2) Add columns/enums above; existing requests → `PERFORM`. (3) Stamp `venueConfirmedAt` on every existing event whose owner is its place's owner. (4) For every other PUBLISHED event with a `placeId`: create a `PERFORM` request (event-first shape, `originEventId`), notify the venue, schedule the address-only rule for +14 days. Unclaimed places: park + claim invite.

---

## Use Cases

House conventions: stateless factories, Zod in/out, typed errors, one `repos.tx()` per mutation, `IdempotencyPort` on anything externally triggered, `ReporterPort` on every catch-and-fallback branch, notification intents stripped from wire output.

### Authorization primitive (new, shared)
**`requirePlaceBookingAuthority(place, actor)`** — passes for the place's human owner, an org member with EDITOR+ on the owning org, or a human with an active `PlaceBookingGrant` (respecting `calendarId` scope and the capability flag asked for). Replaces `requirePlaceOwnership` at every hold/confirm/withdraw site. Grants are checked, never granted, in this spec.

### Requests
- **`createBookingRequest`** — extended: `intent`, `calendarId` (now set by the form), `spaceId`, window, purpose, attendance, visibility hint. Validates the intent is accepted by the calendar; a space, when one is given, must belong to that calendar (RENT/USE no longer require one — 2026-09-22). If the place is unclaimed → `parkedUnclaimedAt`, fire the claim invite, entry `booking_request.parked_unclaimed`; the request is otherwise complete. If `Place.acceptsBookingRequests === false` on a claimed place → `precondition_failed: venue_not_accepting`.
- **`createBookingRequestFromEvent`** (event-first) — called by `createEvent`/`updateEvent` when the builder names a place + calendar whose toggles accept the chosen intent. Idempotent on `originEventId`. Request `direction = TO_VENUE`, requester = the event's owner (human, or org via the performer-owner pair). No mint later — confirm stamps the origin event.
- **`unparkBookingRequestsForPlace`** — on claim: every parked request for the place becomes PENDING, venue notified.

### Confirmation
- **`confirmVenueEvent`** — venue side (authority primitive). Input: request id (+ optional owner override). Stamps `venueConfirmed*` on the event (minting first via the existing path when there is no event yet — with `ownerOverride` defaulting by intent). Entry `booking_event.venue_confirmed`. Intents: requester ← `event.venue_confirmed`.
- **`withdrawVenueConfirmation`** — venue side, reason required. Sets `venueConfirmationWithdrawnAt/Reason`; the event keeps `placeId`; stops blocking; entry `booking_event.venue_confirmation_withdrawn`; requester ← intent with reason. Idempotent.
- Hold **`confirmBookingHold`** — modified: calls `confirmVenueEvent` semantics (owner default by intent; stamp confirmation). For a RENT hold with a live `RentalPayment`, confirm is reached **only** via `recordRentalCheckoutCompleted` (the RENT exception).

### Reads that change behaviour
- **`getCalendarEvents`** / **`getPlaceBookingAvailability`** / conflict detection — third-party events count **only when venue-confirmed**; unconfirmed ones are returned to the venue calendar flagged `unconfirmed: true` and excluded from availability and conflicts.
- **Public event read** — location payload carries `venue` (name, slug, link) only when `isVenueConfirmed`; otherwise address fields only. `placeId` never leaves the server on the public shape for an unconfirmed event.

### Rental payment (port `RentalPaymentsPort`, adapter `StripeRentalPayments` — direct charges only; must not be added to `StripeAdapter`)
- **`requestRentalFee`** — venue side; RENT request with a settled space + window; venue Payee eligible else `precondition_failed: venue_not_on_stripe` (UI offers *Set up payments* / *Record a payment instead*). Creates Price + single-use Payment Link on the venue's account (`metadata.kind = "room_rental"`, request/agreement/place ids), **places the position-1 hold** for calendar+date+space, writes `RentalPayment(REQUESTED)`, entry `booking_rental.requested`, requester ← link. Refuses a second live link (`conflict`).
- **`recordRentalCheckoutCompleted`** — webhook. Guards in order: `metadata.kind === "room_rental"` else **return quietly**; `event.account === stripeAccountId` and `session.payment_link === stripePaymentLinkId` else `conflict: rental_account_mismatch` (DLQ + alert); amount/currency match; idempotent on session id. Then `PAID`, stamp ids, **confirm the hold** (mint/stamp event, release competitors), entry `booking_rental.paid`, intents both sides. A late completion on an `EXPIRED` row is accepted (`late: true`) — money moved.
- **`cancelRentalFeeRequest`**, **`recordRentalPaidOffPlatform`** (→ `RECORDED`, method, confirms the hold), **`requestRentalRefund`** (requester, reason → `REFUND_REQUESTED`), **`resolveRentalRefund`** (venue: approve with amount ≤ remaining, or decline with reason; approve calls the port with `stripeAccount`; cumulative `refundedCents`; full refund → `REFUNDED`; **nothing automatic to the event**), **`reattachRentalPayment`** (venue staff: set `eventId`/`agreementId` on a payment whose event was deleted).
- **`settleOverdueRentalRequests`** — jobs app, same schedule as `expire-booking-requests`: `REQUESTED` past `dueAt` → `EXPIRED`, deactivate link, **release the hold**, entries + intents; one reminder at `dueAt − 48h`. Not lazy — deactivation is an external side effect.

### Ledger kinds (all `.strict()`, all visible to the requester unless noted)
`booking_request.parked_unclaimed`, `booking_request.unparked`, `booking_event.venue_confirmed { eventId, ownerSide }`, `booking_event.venue_confirmation_withdrawn { eventId, reason }`, `booking_rental.requested { amountCents, currency, dueAt, windowStartsAt, windowEndsAt }`, `.paid { amountCents, late }`, `.expired {}`, `.cancelled {}`, `.recorded { method }`, `.refund_requested { reason }`, `.refund_approved { amountCents }`, `.refund_declined { reason }`.

### Webhook
`case "checkout.session.completed"` — reads `event.account`; delegates; returns quietly on non-rental sessions. Optional `charge.refunded` for connected accounts → reconcile dashboard-issued refunds. Documented at the case as the first `event.account` readers in the file.

---

## UI / Flow

**Place page.** Two CTAs on `BookingInfoBlock`, each visible only if some calendar on the place accepts it: *Play here* (today's), and *Rent or use a space*. One dialog. Step 1: intent (defaulted by performer mode, filtered by what the place's calendars allow). Step 2: calendar (only those accepting the intent) → date + start/end (availability from that calendar); the calendar's rooms are shown, not picked (2026-09-22). Step 3: the variant's fields. Unclaimed place: the dialog still submits; confirmation copy says *"This venue hasn't claimed its page yet — we've asked them to."*

**Event builder.** `LocationSection` place selector gains a **calendar picker** (no space picker — 2026-09-22) when the chosen place has a calendar accepting any intent; asks the intent inline. Saving creates the request and shows *"Sent to The Blue Room for confirmation — your event shows an address only until they confirm."* A place with no accepting calendar is selectable as a plain location with no request.

**Thread.** The existing stage rail gains the confirmation state. Venue-side actions: *Confirm* (with owner override: *Venue owns it / They own it*), *Withdraw confirmation* (reason), *Request rental fee* (RENT only; amount prefilled from the calendar rate; due date default 7 days, capped at the event date; note). Status card for the rental — same card both sides, updated in place:

```
Room rental · $500.00 · Sat 4 Oct, 6–11pm              Due Mon 29 Sep
Requested → Paid → Confirmed                            ● Requested
"Covers the room and house PA. Non-refundable within 14 days."
[ Pay $500.00 ]  (requester)      [ Cancel ] [ Record a payment ]  (venue)
```
After PAID: receipt link, *Request a refund* (requester, reason) / *Refund…* (venue, amount ≤ remaining). Refund requests show as a pending line with *Approve amount* / *Decline*.

**Venue calendar.** Unconfirmed third-party events render with a distinct *unconfirmed* treatment and a one-click *Confirm* / *Not mine*; they never block. Rental events carry a *Rental · paid/unpaid* chip. Withdrawn events disappear from the calendar's blocking layer but remain listed under the calendar as unconfirmed.

**Public event page.** *Confirmed by venue* badge next to the venue name when confirmed; address-only otherwise — identical for never-confirmed and withdrawn.

**Requester's admin.** A RENT/USE confirm lands a DRAFT event in *their* admin (personal or org) with a banner: *"Confirmed by The Blue Room. Finish the details and publish when ready."* Their payout terms default to 100%.

**Help center.** Venue article: new sections *Confirming events at your venue*, *Rental fees*, *Trusted bookers (coming)*. Act/organizer article: *Naming a venue on your event* (address-only until confirmed), *Renting or using a space*. Both state plainly: rental money goes to the venue directly; Ithas Fire takes nothing and holds nothing; refunds are the venue's decision.

---

## Non-Goals

- **Instant book** (`INSTANT`): reserved in the enum, not selectable. Own spec — it is the act's payment minting hold + confirm + event with no venue action, its own conflict check, and the grant UI.
- **Booking-grant UI** (grant/revoke/list). Model + hook only here.
- **A `BOOKER` org role.**
- **Multi-date runs.** One date per booking; a run concept is wanted, later.
- **Whole-venue rental.** A rental blocks one space.
- **Stripe Invoicing** (0.4% per paid invoice to the venue) — opt-in later for AP-department rooms; same port, one more method.
- **Platform fee on rentals**, ledger entries, orders, splits, settlement — none, ever, in this spec; grep-guard test.
- **Tax on rentals** — the venue's as merchant of record; never ZipTax.
- **W-9 / 1099** — direct charges put reporting on the venue's own Stripe account; we touch no tax form.
- **Form-field expansion** for RENT/USE beyond the floor above — parked for a dedicated discussion.
- **House shows / `HostSpace`** — houses will be Places; no separate concept.
- **Automatic anything on refund** — approve/decline only.

---

## Acceptance Criteria

**Config & defaults**
- [ ] Every existing Place has ≥1 Calendar and every Calendar ≥1 Space after migration; creating a Place creates both; a calendar cannot be saved with zero spaces
- [ ] Calendar intent toggles default `perform=on, rent=off, use=off`; existing behaviour for every venue is byte-identical until a venue flips a toggle

**Requests**
- [ ] A non-performer human can submit a RENT and a USE request; a performer can choose any intent; the form variant follows the intent
- [ ] RENT/USE without a space is ACCEPTED (2026-09-22) and persists `spaceId: null`; with a space not on the chosen calendar it is rejected `invalid_input`. RENT/USE without a WINDOW is rejected `invalid_input`, and the SQL CHECK rejects it at the DB too
- [ ] A request to an unclaimed place attaches `placeId`, is parked, and sends exactly one claim invite; claiming unparks it and notifies the venue
- [ ] Event-first: saving an event with a place + accepting calendar creates one request (idempotent on re-save); the same event with a non-accepting calendar creates none and is selectable as address-only

**Confirmation**
- [ ] Venue-owned events and events by a granted human are `isVenueConfirmed` without any request
- [ ] A third-party event at a place is **absent** from availability and conflict detection until confirmed, and **present** on the venue calendar flagged unconfirmed; confirming flips both in one tx
- [ ] Public event read omits venue name/link/`placeId` for an unconfirmed event and includes them + the badge once confirmed; withdrawn behaves exactly as never-confirmed
- [ ] Withdrawal keeps `placeId`, records the reason, notifies the requester, and the requester can still edit the event
- [ ] Owner default by intent is applied on confirm; the override is honoured; the requester-owned DRAFT appears in the requester's admin with 100% payout terms
- [ ] Migration creates a request for each existing third-party published event and stamps confirmation on venue-owned ones; a job flips the rendering rule after the grace window

**Rental**
- [ ] `requestRentalFee` creates the Payment Link on the venue's connected account (adapter test asserts the `Stripe-Account` request option, no `application_fee_amount`, `completed_sessions.limit = 1`) **and** places a position-1 hold in one flow
- [ ] `checkout.session.completed` with matching `event.account` + `payment_link` moves to `PAID` and confirms the hold exactly once; replay is a no-op; a mismatched account is DLQ'd and never applied; a non-rental session is ignored without throwing
- [ ] Expiry deactivates the link and releases the hold; a late completion is accepted with `late: true`
- [ ] Refund: requester request → venue approve (partial, cumulative ≤ paid) or decline; full refund leaves the event untouched; dashboard-issued refunds reconcile via `charge.refunded`
- [ ] Deleting the event leaves the `RentalPayment` intact and refundable; `reattachRentalPayment` links it to a new event
- [ ] `RECORDED` path works with no Stripe account on the venue
- [ ] Grep-guard: no path in this feature writes `Order`, `OrderSplit`, `PayeeLedgerEntry`, or settlement rows

**Grant hook**
- [ ] A human with an active grant can place a hold / confirm (per capability) on a human-owned venue; expired or revoked grants fail `forbidden`; no UI creates grants (fixture-only)

**Run it**
- [ ] Driven in the real app: request-first RENT through payment in Stripe test mode on a connected test account; event-first PERFORM through confirm; an unclaimed-venue request; 320px on the dialog, the status card, and the builder's calendar picker

---

## Open Questions

1. **Form fields for RENT/USE** — parked by the owner for a dedicated discussion. The floor is fixed; the ceiling isn't.
2. **Grace window** for the migration — 14 days proposed.
3. **Default intents on the default calendar of an unclaimed place** — perform on, others off (proposed); a claimed venue flips them.
4. **Currency** — refuse a non-USD venue Payee for rentals rather than guess (proposed).
5. **`charge.refunded` on connected accounts** — confirm the Connect webhook subscription includes it; if not, dashboard refunds reconcile only when someone looks (acceptable, flagged in help).
6. **Who may override the owner at confirm** — any venue-side confirmer (proposed), or OWNER/ADMIN only.

---

## Review Posture

Not settlement code — the grep-guard proves it — but three places where a bug is someone's money or someone's room: the webhook tenant check (`event.account` ↔ `stripeAccountId`), the availability/conflict change (an unconfirmed event must never block; a confirmed one must always), and the public-read rule (an unconfirmed event must never leak the venue). Full `reviewer` plus Codex on the adapter and webhook; `security-review` lens on the public read and the webhook; drive it in Stripe test mode before calling it done.

---

## Amendment 2026-09-25: no requests to unclaimed venues

**Owner decision:** an unclaimed venue cannot be requested. Parking a request at an unclaimed room is parasitic: it takes an ask that should go to a real contact and holds it on a page nobody answers. This reverses the parking half of the :87 locked decision ("Claiming gates responding, never requesting") and the :293 unclaimed-place dialog copy. Venue confirmation and the event-first path are unchanged.

**What already holds:** every web entry point to the request dialog is gated on a VERIFIED place that accepts requests (`packages/types/src/repos/entity-pages.ts:228-234`), and an unclaimed place cannot own a booking embed (`embeds/upsert-embed.ts:201-216`). The place page already offers "Claim this venue" (`PlaceHeroActions.tsx:208-215`). So the rule is true for users today; the backend still parks anything that reaches it through the API or the event-first path.

**Change:**

1. `createBookingRequest`, `createBookingRequestFromEvent` and the embed inquiry refuse a place that is not claimed with `PLACE_NOT_TAKING_REQUESTS` (translated: "{venue} isn't taking requests on Ithas Fire yet."). The refusal runs before the bill, standards or any notification.
2. Parking is removed: `parkedUnclaimedAt` stops being written (the column goes in a later migration once no row has it), `unpark-booking-requests-for-place` and its callers in `submit-place-claim.ts:434` / `review-place-verification.ts:458`, the `booking.venue-claim-invite` and `booking.requests-unparked` variants, the `MAX_OPEN_PARKED_REQUESTS_PER_SENDER` cap, the `parked_unclaimed` / `unparked` ledger kinds (kept readable for old rows), the dialog's parked success copy, and the parked branch in `load-effective-booking-standards.ts:165`.
3. Any request still parked when this ships is expired with one thread note to the sender: "{venue} isn't on Ithas Fire yet, so this request can't reach them." (Likely none exist, since no web path reaches parking.)

**Cross-references:** `docs/specs/2026-09-25/lineup-booking-requests-v3.spec.yaml` (L9), `docs/specs/2026-09-25/venue-booking-standards.spec.yaml` (v1.1, V8).

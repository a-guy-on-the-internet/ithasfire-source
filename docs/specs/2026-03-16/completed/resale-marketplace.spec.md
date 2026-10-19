# Resale Marketplace Spec

> **Status**: complete
> **Created**: 2026-03-09
> **Authors**: Engineering Team

## Overview

Build a peer-to-peer ticket resale marketplace on Ithas Fire. Sellers list tickets they can no longer use; buyers purchase them at fair, organizer-controlled prices. The system reuses the existing checkout/settlement/payout infrastructure and leaves a clear integration seam for future external-platform inventory (AXS, Ticketmaster, etc.).

### Design principles

- **Organizer control** — resale is opt-in per event (`resalePayoutTermsId`) and per ticket type (`resaleAllowed`, `resaleCapCents`). The organizer decides whether resale is permitted and at what price ceiling.
- **Buyer protection** — a 3-day post-event claims window blocks seller payout until the buyer confirms entry. The `Claim` model already exists in the schema.
- **Fee transparency** — buyers see a clear breakdown (ask price + platform fee + processing fee). Sellers see their net payout. No hidden margins.
- **Platform-agnostic inventory** — the `ResaleListing` model gains an optional `source` field to distinguish internal TH tickets from future external-platform imports. Use cases and ports are designed so an external adapter can create listings without owning a TH `Ticket` row.

## What already exists

| Layer | What's built | What's missing |
|-------|-------------|----------------|
| **Schema** | `ResaleListing`, `ResaleListingHold`, `Claim`, `TicketType.resaleAllowed/resaleCapCents/transferAllowed`, `Order.source = RESALE`, `TicketTransfer.reason = "resale"`, `Event.resalePayoutTermsId`, `PayoutTerms(kind=RESALE)`, `ResalePriceSnapshot`, `TicketStatus.LISTED`, `OrderItem.transferredAt/status` | `ResaleListing.source` (internal vs external), `ResaleListing.eventId` denorm for queries |
| **Ports** | `ResaleListingsRepo` (hold, commit, cancelHold) | CRUD methods (create, cancel, getById, listByEvent, listBySeller, listByBuyer, expireStale), Claims port |
| **Adapters** | Prisma adapter for hold/commit/cancelHold | Full CRUD adapter, Claims adapter |
| **Use cases** | `estimate-resale-price`, `compute-resale-price-snapshots` | create-listing, cancel-listing, purchase-resale-ticket (checkout), expire-listings (job), create-claim, review-claim, expire-claims (job), list-claims, get-claim, list-resale-listings (buyer-facing), get-resale-listing |
| **Transport** | None | tRPC router for resale + claims |
| **Web UI** | "Coming soon" placeholder with estimate display, i18n strings, `LISTED` ticket status badge, resell button on order detail | Seller Hub (`/sell/*`), buyer browse/purchase flow, admin resale dashboard, claim filing UI, platform claims dashboard |

---

## Schema changes

### 1. Extend `ResaleListing`

```prisma
model ResaleListing {
  id            String              @id @default(uuid())
  ticketId      String              @unique
  eventId       String                           // ← ADD: denormalized for efficient queries
  sellerHumanId String
  askPriceCents Int
  currency      String              @default("usd") @db.VarChar(3)  // ← ADD
  status        ResaleListingStatus @default(ACTIVE)
  expiresAt     DateTime?

  /// "internal" = TH-minted ticket, "external" = imported from AXS/TM/etc.
  /// Validated in app code.
  source        String              @default("internal")  // ← ADD

  /// For external-platform tickets: opaque reference to the upstream system.
  /// Null for internal listings.
  externalRef   Json?               // ← ADD: { provider: "axs", externalId: "...", barcode?: "..." }

  /// Snapshot of the resale payout terms ID at listing creation.
  /// Ensures the seller's listing is governed by the terms in effect when they listed.
  resalePayoutTermsId String?       // ← ADD

  /// The order that purchased this listing (set on commit).
  buyerOrderId  String?  @unique    // ← ADD

  ticket Ticket            @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  event  Event             @relation(fields: [eventId], references: [id], onDelete: Cascade)  // ← ADD relation
  seller Human             @relation("SellerResaleListings", fields: [sellerHumanId], references: [id], onDelete: Restrict)
  hold   ResaleListingHold?
  buyerOrder Order?        @relation("ResaleListingBuyerOrder", fields: [buyerOrderId], references: [id], onDelete: SetNull)  // ← ADD

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("Listing")
  @@index([sellerHumanId])
  @@index([eventId, status])            // ← ADD: browse listings by event
  @@index([status, expiresAt])          // ← ADD: expire stale listings job
}
```

### 2. Add reverse relation on Event and Order

```prisma
// event.prisma — add to Event:
resaleListings ResaleListing[]

// order.prisma — add to Order:
resaleListingPurchase ResaleListing? @relation("ResaleListingBuyerOrder")
```

### 3. No changes to Claim

The `Claim` model is already complete in `resale.prisma`. Two additions:

- **`sellerEvidence Json @default("{}")`** — the seller's response to a claim. Same shape as `evidence` but from the seller's perspective. Support staff see both sides.
- **`sellerRespondedAt DateTime?`** — when the seller submitted their response. Null if they haven't responded.

This gives sellers a voice in the claims process without changing the resolution flow (still support-only).

---

## Port expansions

### `ResaleListingsRepo` (expand existing)

```typescript
export interface ResaleListingsRepo {
  // ── Existing ──
  hold(listingId: string, buyerHumanId: string, heldUntil: Date): Promise<ResaleListingHoldResult>;
  commit(listingId: string, buyerHumanId: string, buyerOrderId: string): Promise<ResaleListingCommitResult>;
  cancelHold(listingId: string): Promise<void>;

  // ── New: CRUD ──
  create(input: CreateResaleListingInput): Promise<ResaleListingRecord>;
  cancel(listingId: string, sellerHumanId: string): Promise<void>;
  getById(id: string): Promise<ResaleListingRecord | null>;
  getByTicketId(ticketId: string): Promise<ResaleListingRecord | null>;

  // ── New: Queries ──
  listByEvent(input: { eventId: string; status?: ResaleListingStatus[]; limit?: number; offset?: number }): Promise<PaginatedResult<ResaleListingRecord>>;
  listBySeller(input: { sellerHumanId: string; status?: ResaleListingStatus[]; limit?: number; offset?: number }): Promise<PaginatedResult<ResaleListingRecord>>;

  // ── New: Batch ops ──
  expireStale(now: Date): Promise<{ expiredCount: number }>;

  // ── New: External inventory ──
  createExternal(input: CreateExternalListingInput): Promise<ResaleListingRecord>;
}
```

### `ClaimsRepo` (new port)

```typescript
export interface ClaimsRepo {
  create(input: CreateClaimInput): Promise<ClaimRecord>;
  getById(id: string): Promise<ClaimRecord | null>;
  getByOrderItemId(orderItemId: string): Promise<ClaimRecord | null>;
  updateStatus(id: string, input: UpdateClaimStatusInput): Promise<ClaimRecord>;
  listByEvent(input: { eventId: string; status?: string[]; limit?: number; offset?: number }): Promise<PaginatedResult<ClaimRecord>>;
  listByClaimant(humanId: string, input: { limit?: number; offset?: number }): Promise<PaginatedResult<ClaimRecord>>;
  expireOpen(now: Date): Promise<{ expiredCount: number }>;
  hasOpenClaims(orderId: string): Promise<boolean>;
  // Record a seller's response/evidence to a claim. Support will see both sides.
  recordSellerResponse(claimId: string, payload: { sellerEvidence: unknown; respondedAt: Date }): Promise<ClaimRecord>;
}
```

---

## Use cases

### Seller flow

| Use case | File | Actor | Description |
|----------|------|-------|-------------|
| `create-resale-listing` | `use-cases/resale/create-resale-listing.ts` | Ticket owner | Validates: ticket is VALID, owner matches actor, event has `resalePayoutTermsId`, ticket type has `resaleAllowed`, ask price <= `resaleCapCents` (if set), event hasn't ended. Sets ticket status to `LISTED`. Idempotent on `(ticketId, clientKey)`. |
| `cancel-resale-listing` | `use-cases/resale/cancel-resale-listing.ts` | Seller | Validates: listing is ACTIVE (not HELD/SOLD), seller matches actor. Sets listing to CANCELLED, ticket back to VALID. |
| `list-my-resale-listings` | `use-cases/resale/list-my-resale-listings.ts` | Seller | Paginated list of a seller's listings with status filter. |

### Buyer flow

| Use case | File | Actor | Description |
|----------|------|-------|-------------|
| `list-event-resale-listings` | `use-cases/resale/list-event-resale-listings.ts` | Any user | Browse ACTIVE listings for an event. Returns ask price, ticket type name, demand tier (from snapshot), and seller display name. |
| `get-resale-listing` | `use-cases/resale/get-resale-listing.ts` | Any user | Detail view of a single listing. |
| `create-resale-checkout` | `use-cases/resale/create-resale-checkout.ts` | Buyer | Hold listing → create `Order(source=RESALE)` → create Stripe PaymentIntent → return `clientSecret`. Reuses `checkout-helpers` for fee computation with the resale PayoutTerms. Idempotent on `(listingId, buyerHumanId, clientKey)`. |
| `finalize-resale-purchase` | `use-cases/resale/finalize-resale-purchase.ts` | Webhook | On `payment_intent.succeeded`: commit listing (transfer ticket ownership), mint new QR code, create `TicketTransfer(reason=resale)`, set original `OrderItem.status=transferred`. |

### Claims flow

| Use case | File | Actor | Description |
|----------|------|-------|-------------|
| `create-claim` | `use-cases/resale/create-claim.ts` | Buyer | File a claim on a resale order item. Validates: `order.source = RESALE`, `now >= event.startsAt`, `now <= event.endsAt + 3 days`, no existing claim on item. |
| `review-claim` | `use-cases/resale/review-claim.ts` | Support staff | Transition claim to `under_review` / `approved` / `denied`. On approval: trigger refund, block seller payout. On denial: unblock payout. |
| `list-claims` | `use-cases/resale/list-claims.ts` | Support staff | Filter claims by status, event, date range. |
| `get-claim` | `use-cases/resale/get-claim.ts` | Buyer / Support | View claim details + evidence + resolution. |

### Background jobs

| Job | File | Schedule | Description |
|-----|------|----------|-------------|
| `expire-resale-listings` | `use-cases/resale/expire-resale-listings.ts` | Hourly | Find ACTIVE listings where `expiresAt < now()` or event has ended. Set status to EXPIRED, restore ticket to VALID. Also expire stale HELD listings where `ResaleListingHold.heldUntil < now()`. |
| `expire-claims` | `use-cases/resale/expire-claims.ts` | Daily | Find OPEN claims where `deadline < now()`. Set status to `expired`, resolution to `expired`. Unblock payout. |

---

## Resale checkout flow (detailed)

This is the highest-risk flow. It mirrors primary checkout but with key differences:

```
1. Buyer calls create-resale-checkout(listingId, clientKey)
2. Validate listing is ACTIVE, not held by someone else
3. Hold the listing (15-min TTL via ResaleListingHold)
4. Load resale PayoutTerms for the event
5. Compute fees:
   - Basis = askPriceCents (seller's price, NOT face value)
   - Platform fee = computed from resale FeePolicy
   - Processing fee = Stripe's cut
   - Tax = same admissionTaxRateBps as primary (if applicable)
6. Create Order(source=RESALE, amountGrossCents=askPrice+buyerFees+tax)
7. Create OrderItem(kind="ticket", unitPriceCents=askPriceCents, qty=1)
8. Create OrderSplits — seller gets askPriceCents minus platform take
9. Create Stripe PaymentIntent(amount=paymentIntentAmountCents)
   - Funds land on Ithas Fire's platform account (same as primary sales)
   - No transfer_data, no destination charge — matches existing model
   - destinationAccountId stored in PI metadata for audit trail
10. Return { orderId, clientSecret }

On payment_intent.succeeded webhook:
11. Commit listing (status=SOLD)
12. Transfer ticket ownership: Ticket.ownerHumanId = buyerHumanId
13. Regenerate QR code (new scan token)
14. Create TicketTransfer(reason="resale", orderId=newOrder.id)
15. Update original OrderItem: status="transferred", transferredAt=now()
16. Create settlement (held until claim window closes)
```

### Stripe payment model decision

Two options for collecting resale payments:

**Option A: Direct charge to seller's Connect account**
- Buyer pays seller directly via Stripe Connect
- Platform takes application_fee
- Simpler money flow, but seller needs Stripe Connect

**Option B: Platform collects, settles later (recommended)**
- Buyer pays Ithas Fire
- Settlement job pays seller after claim window (same as primary sales)
- Seller doesn't need their own Stripe account
- Matches existing settlement infrastructure
- Reseller payout blocked while open claims exist

**Decision**: Option B — reuse the existing settlement/payout infrastructure. The `PayoutTerms(kind=RESALE)` + `OrderSplit` + `Settlement` pipeline handles everything. The only addition is that settlement jobs must check `ClaimsRepo.hasOpenClaims(orderId)` before releasing resale payouts.

---

## External inventory integration seam

To support future AXS/Ticketmaster/etc. inventory:

1. **`ResaleListing.source`** — `"internal"` (default) vs `"axs"` | `"ticketmaster"` | etc.
2. **`ResaleListing.externalRef`** — JSON blob with provider-specific identifiers.
3. **`ResaleListingsRepo.createExternal()`** — creates a listing without requiring a TH `Ticket` row. The `ticketId` field would reference a synthetic "external ticket" record (or we make `ticketId` nullable + add a check constraint `ticketId IS NOT NULL OR externalRef IS NOT NULL`).
4. **`ExternalInventoryPort`** (future) — interface for fetching/syncing listings from external providers. Not built now, but the data model accommodates it.

For now, `source` defaults to `"internal"` and `externalRef` is always null. The schema and port shape are forward-compatible.

---

## Settlement & payout integration

Resale orders flow through the same settlement pipeline as primary sales:

1. `createSettlementsFromOrder` creates `OrderSplit` → `SettlementLine` → `OrderItemSettlementLine` for the resale order.
2. The payout terms used are `Event.resalePayoutTermsId` (kind=RESALE), which may have different splits/schedule than primary.
3. **Claim guard**: the payout batch job (`executeSettlementTransfer`) must check `ClaimsRepo.hasOpenClaims(orderId)` for RESALE orders. If true → skip this settlement (keep status "pending"). If false and claim deadline has passed → include in payout.
4. Seller Payee: the seller must have a `Payee` record (they need to be eligible to receive payouts). If they don't have one, listing creation should be blocked (pre-condition: seller has payout setup).

---

## How claims work (deep dive)

Claims are Ithas Fire's buyer protection mechanism for resale transactions. They exist because resale introduces a trust gap: the buyer is purchasing a ticket from another person, not from the event organizer. If the ticket turns out to be invalid, the buyer needs recourse.

### Why claims exist

In primary sales, the organizer mints the ticket and controls entry. If something goes wrong, the organizer is both the seller and the gate operator — disputes are straightforward. In resale, the seller is a third party. Common failure modes:

- **Ticket invalid at gate**: seller's original ticket was revoked (e.g., chargeback on their original order, organizer cancelled the ticket, barcode already scanned).
- **Entry denied**: venue rejected the ticket for reasons outside the buyer's control (wrong name on a name-verified ticket, ticket type restrictions).
- **Wrong seat/section**: seller listed "Section A Row 1" but the ticket is actually "Section C Row 20".

Industry precedent: StubHub's "FanProtect Guarantee" and SeatGeek's "Buyer Guarantee" both promise valid entry or your money back. They're able to enforce this because they hold seller funds until after the event. We do the same.

### The claim timeline

```
Purchase day              Event day           Event + 3 days         Payout batch
    |                         |                    |                     |
    v                         v                    v                     v
  Buyer pays             Claims window        Claims window          If no open claim
  Order created          OPENS                CLOSES                 → seller gets paid
  Settlement created     (event.startsAt)     (event.endsAt + 3d)    If open claim
  (status: pending)                                                  → payout blocked
```

1. **Purchase**: Buyer pays. `Order(source=RESALE)` is created. Settlement is created with `status=pending` and `scheduledPayoutDate` set to `event.endsAt + claimWindowDays` (3 days default).

2. **Pre-event**: Settlement sits in `pending`. No payout yet. The weekly payout batch job (`runPayoutBatch`) sees this settlement but it's not due yet (`scheduledPayoutDate > now()`).

3. **Event day**: The claims window opens at `event.startsAt`. Before this point, the buyer can't file a claim (they haven't tried to use the ticket yet).

4. **Post-event (0–3 days)**: Buyer can file a claim. The `Claim` model captures:
   - `kind`: "ticket_invalid" | "entry_denied" | "wrong_seat" | "other"
   - `evidence`: JSON blob with buyer's description, screenshots, scan log refs
   - `deadline`: `event.endsAt + 3 days` (set at creation, immutable)
   - `status`: starts as "open"

5. **Claim resolution**: Support staff reviews and transitions the claim:
   - `open` → `under_review` (support is looking at it)
   - `under_review` → `approved` (buyer gets refund, seller payout cancelled)
   - `under_review` → `denied` (buyer's claim rejected, seller payout unblocked)

6. **Claim expiry**: If no claim is filed within the window, or if an open claim's `deadline` passes without resolution, the `expire-claims` batch job sets `status=expired`, `resolution=expired`, and the payout is unblocked.

7. **Payout**: The `runPayoutBatch` job (weekly cron) processes due settlements. For RESALE orders, it additionally checks `ClaimsRepo.hasOpenClaims(orderId)`. If any claim is open/under_review → skip. If no claims or all claims are resolved → proceed with transfer.

### What happens on claim approval

When support approves a claim (`resolution = "full_refund"` or `"partial_refund"`):

1. **Buyer refund**: The platform refunds the buyer's original payment via `stripe.refunds.create()`. Since we collected the payment on our platform account (not destination charge), the refund comes from our account. No need to reverse a transfer because no transfer has happened yet — the settlement was still pending.

2. **Seller settlement cancelled**: The settlement for this order is marked `status=cancelled`. The seller receives nothing. Their Stripe Express account balance is unaffected because funds were never transferred.

3. **Ticket restoration**: The ticket is restored to the seller (or invalidated entirely, depending on the claim type). If the claim is "ticket_invalid", the ticket stays invalid. If it's "wrong_seat" or "other", the ticket is returned to the seller as VALID.

4. **Notification**: Both buyer and seller are notified of the resolution.

### What happens on claim denial

1. **No refund**: Buyer's payment stands.
2. **Payout unblocked**: The settlement remains `status=pending` and becomes eligible for the next payout batch.
3. **Notification**: Both parties notified.

### Why this works with our Stripe model

The key insight is that our existing "separate charges and transfers" model is **perfect** for resale claims:

- **Funds sit on our platform account** until we explicitly transfer them. There's no automatic movement to the seller.
- **The settlement batch controls timing**. We set `scheduledPayoutDate = event.endsAt + 3 days`, so the batch job won't even consider this settlement until the claim window closes.
- **If a claim is approved, we simply cancel the settlement**. No need to reverse a Stripe transfer (which is messy and can fail if the seller's balance is insufficient).
- **The refund is clean**: refund the buyer from our platform account. Done.

Compare this to destination charges, where Stripe automatically transfers funds to the connected account at charge time. With that model, we'd have to reverse the transfer on claim approval — and the seller might have already withdrawn the funds, leaving a negative balance on their Express account. Our model avoids this entirely.

### Claim vs. Stripe dispute

Claims are **not** Stripe disputes (chargebacks). They're an in-platform resolution mechanism:

| | Claim | Stripe Dispute |
| --- | --- | --- |
| Initiated by | Buyer, via our UI | Buyer's bank/card issuer |
| Timeline | 3 days post-event | 120 days from charge |
| Resolved by | Our support team | Stripe + card network |
| Cost | Free | $15 dispute fee |
| Evidence | Our platform data | Must submit to Stripe |

A buyer who is unhappy could also file a Stripe dispute (chargeback) instead of or in addition to a claim. Our claims system exists to resolve issues *before* they escalate to chargebacks. Quick, fair claim resolution reduces chargeback rates.

If a buyer files both a claim AND a Stripe dispute, support should prioritize the claim resolution to provide evidence for the dispute response.

---

## tRPC router

New router: `packages/transport/trpc/src/routers/resale.ts`

Register in `router.ts` as `resale`.

**Procedures:**

| Procedure | Type | Auth | Description |
|-----------|------|------|-------------|
| `createListing` | mutation | authed | Create a resale listing |
| `cancelListing` | mutation | authed | Cancel a resale listing |
| `myListings` | query | authed | Seller's listings |
| `eventListings` | query | optional | Browse listings for an event |
| `getListing` | query | optional | Detail view |
| `createCheckout` | mutation | authed | Hold listing + create payment intent |
| `createClaim` | mutation | authed | File a claim |
| `getClaim` | query | authed | View claim |
| `myClaims` | query | authed | Buyer's claims |
| `listClaims` | query | authed (support/admin) | Support dashboard |
| `reviewClaim` | mutation | authed (support/admin) | Resolve a claim |
| `respondToClaim` | mutation | authed (seller) | Seller submits their side of the story |

---

## Web UI surfaces

### Design philosophy: simple seller, complex organizer

The admin panel (`/admin/[slug]/*`) serves organizers managing events, ticket types, payments, teams, audiences, embeds, etc. It's intentionally feature-rich and complex — those users are running businesses.

Resellers are not organizers. They bought a ticket they can no longer use, or they're flipping tickets casually. Their experience should be **radically simpler**: a handful of pages, minimal navigation, zero configuration overhead. Think "Venmo listing" not "Shopify dashboard."

To achieve this, resellers get their own lightweight shell: `/sell/*`. It reuses the `NavigationShell` infrastructure from `@th/ui` (same as admin and platform) but with a minimal nav (3-4 items) and a `"personal"` account context type. No org switching, no team management, no event creation.

### Seller Hub: `/sell/*`

A dedicated, simple panel for individual resellers. Route structure:

```
/sell                      → redirect to /sell/listings
/sell/listings             → My Listings (active, sold, expired)
/sell/listings/new         → List a ticket for resale (ticket picker → price → confirm)
/sell/payouts              → Payout history & Stripe Connect status
/sell/claims               → Claims filed against my sales (if any)
```

**Shell & navigation**:

- New layout at `apps/web/src/app/sell/layout.tsx`.
- Uses `NavigationShell` with `accountContext.type = "personal"`.
- Navigation sections (3 items):
  - **Listings** (`Repeat` icon) — the main page, default route.
  - **Payouts** (`Banknote` icon) — payout history, Stripe onboarding status.
  - **Claims** (`ShieldAlert` icon) — claims filed against the seller's sold tickets.
- "Return to attendee view" link goes back to `/my-tickets`.
- No workspace switcher (single personal context).

**Auth gate**: Requires authenticated user with verified email. If no Payee record exists, the Listings page shows a one-time Stripe Express onboarding card before they can list anything.

#### `/sell/listings` — My Listings

The home screen. Three tabs or filter chips:

| Tab | What it shows |
|-----|---------------|
| **Active** | Listings with `status=ACTIVE`. Each card: event name, ticket type, ask price, expiry countdown, "Cancel" button. |
| **Sold** | Listings with `status=SOLD`. Each card: event name, ticket type, sold price, buyer (anonymized), payout status (pending/paid/claim-blocked). |
| **Expired / Cancelled** | Terminal states. Minimal detail, just for history. |

Empty state for new users: illustration + "You don't have any listings yet" + **"List a ticket"** CTA.

#### `/sell/listings/new` — List a Ticket

A short, linear flow (not a form-heavy page):

1. **Pick a ticket**: Show the user's eligible tickets (VALID, `resaleAllowed`, event hasn't ended, not already listed). Grouped by event. Each shows event name, date, ticket type, face value.
2. **Set your price**: Pre-filled with the estimated resale value from `estimate-resale-price`. Slider or input, capped at `resaleCapCents`. Shows "You'll receive" (after platform fee) and "Buyer pays" (including fees) in real-time.
3. **Confirm**: Summary card with ticket details, price breakdown, expiry date (`event.startsAt`). "List for Sale" button.

That's it. Three steps, one screen each. No settings, no advanced options, no fee configuration.

#### `/sell/payouts` — Payouts

- **Stripe Connect status card**: If `payoutsEnabled` → green "Connected" badge + last 4 of bank. If not → "Set up payouts" button that triggers Express onboarding.
- **Payout history**: Simple list of completed payouts (date, amount, listing reference). Sourced from settlements with `source=RESALE`.
- **Pending payouts**: Sold listings waiting for claim window to close. Shows countdown.

#### `/sell/claims` — Claims Against Me

Most sellers will never see this page populated. But when a buyer files a claim:

- List of claims with status badge (open / under review / resolved).
- Each claim card: event name, ticket type, buyer's claim reason, deadline, resolution (if any).
- **Respond** button (available while status is "open" or "under_review" and within the deadline). Opens a simple form: text description + optional file uploads. Submits a seller response entry that support staff see alongside the buyer's evidence.
- No *resolve* buttons — sellers can't approve or deny claims, only support staff can. But they have a voice in the process.

### Buyer: "My Tickets" order detail — resale CTA

The existing `/my-tickets/[orderId]/resell` flow changes:

- **Remove** the "Coming soon" placeholder.
- The "Resell" button on eligible ticket items now navigates to `/sell/listings/new?ticketId=<id>` instead of the current `/my-tickets/[orderId]/resell` route.
- This means the resell placeholder page (`ResellPlaceholder.tsx`) goes away entirely — its estimate display is absorbed into the `/sell/listings/new` flow.

### Buyer: Event page — resale listings

On event pages where resale is enabled:

- "Resale Tickets Available" section below primary ticket types.
- Shows available listings with ask price, ticket type, demand indicator.
- "Buy" button → resale checkout flow (separate from primary checkout).

### Admin: Resale dashboard (organizer)

New admin section at `/admin/[slug]/resale/`:

- Overview of resale activity for the org's events.
- Listing volume, revenue, average markup.
- Claims requiring attention for their events.
- Toggle resale on/off per event, set/edit `resaleCapCents` per ticket type.
- This is the **organizer's** view of resale — they control policy, not individual listings.

### Platform: Claims dashboard (support staff)

For internal support staff at `/platform/claims/`:

- Filter by status, event, date, seller, buyer.
- Review evidence, approve/deny claims.
- See refund impact before approving.

---

## Implementation phases

### Phase 1: Schema + ports + adapters (no UI, no transport)

1. Prisma migration: add new fields to `ResaleListing`, add `Event.resaleListings` relation, add `Order.resaleListingPurchase` relation.
2. Expand `ResaleListingsRepo` port with CRUD methods.
3. Create `ClaimsRepo` port.
4. Implement Prisma adapters for both.
5. Register in `Repos` and `TxRepos`.

### Phase 2: Core use cases

1. Seller: `create-resale-listing`, `cancel-resale-listing`, `list-my-resale-listings`.
2. Buyer browse: `list-event-resale-listings`, `get-resale-listing`.
3. Buyer purchase: `create-resale-checkout`, `finalize-resale-purchase`.
4. Claims: `create-claim`, `review-claim`, `list-claims`, `get-claim`.
5. Claims: `respond-to-claim` (seller) — seller can submit evidence/response to a claim within the claim deadline.
6. Jobs: `expire-resale-listings`, `expire-claims`.
7. Settlement guard: modify payout batch to check open claims.
8. Tests for all use cases including money math invariants and idempotency.

### Phase 3: Transport + Web UI

1. tRPC `resale` router.
2. **Seller Hub** (`/sell/*`): layout + shell, listings page, new-listing flow, payouts page, claims page.
3. Update "My Tickets" order detail: resell button navigates to `/sell/listings/new?ticketId=<id>` instead of placeholder.
4. Remove `ResellPlaceholder.tsx` and `/my-tickets/[orderId]/resell` route.
5. Buyer browse on event page (resale listings section).
6. Resale checkout flow.
7. Admin resale dashboard (`/admin/[slug]/resale/`).
8. Platform claims dashboard (`/platform/claims/`).
9. Add "Sell Tickets" link to account page menu.
10. E2E tests.

### Phase 4: External inventory (future)

1. `ExternalInventoryPort` interface.
2. AXS/Ticketmaster adapter(s).
3. Inventory sync job.
4. External listing display in buyer browse.

---

## Error codes

| Code | HTTP | When |
|------|------|------|
| `resale_not_enabled` | 422 | Event has no `resalePayoutTermsId` |
| `resale_not_allowed_for_type` | 422 | `TicketType.resaleAllowed` is false |
| `resale_price_exceeds_cap` | 422 | Ask price > `resaleCapCents` |
| `ticket_not_eligible_for_resale` | 422 | Ticket is not VALID, or already listed, or event ended |
| `not_ticket_owner` | 403 | Actor doesn't own the ticket |
| `listing_not_found` | 404 | |
| `listing_not_active` | 409 | Listing is HELD/SOLD/CANCELLED/EXPIRED |
| `listing_already_held` | 409 | Another buyer holds this listing |
| `cannot_buy_own_listing` | 422 | Buyer == seller |
| `seller_payout_not_setup` | 422 | Seller has no Payee record |
| `claim_window_not_open` | 422 | Before event start |
| `claim_window_expired` | 422 | After claim deadline |
| `claim_already_exists` | 409 | Claim on this order item already filed |
| `claim_not_resale_order` | 422 | Order source is not RESALE |
| `claim_response_deadline_passed` | 422 | Seller tried to respond after the claim deadline |
| `claim_not_respondent` | 403 | Actor is not the respondent (seller) on this claim |
| `claim_already_resolved` | 409 | Claim has already been approved/denied/expired |

---

## Money math invariants (must test)

- `askPriceCents` is always integer cents, never floats.
- `sum(OrderSplit.amountCents)` == order basis after rounding (same as primary).
- Seller payout = `askPriceCents - platformTake` (per resale PayoutTerms lines).
- Buyer pays = `askPriceCents + buyerFees + processingFees + tax`.
- `resaleCapCents` is enforced at listing creation AND at checkout (double-check).
- Claim approval refund amount = buyer's total payment (including fees).
- If claim approved: seller's settlement stays "pending" forever (or is cancelled).
 - Royalty splits: when `PayoutTermsLine` entries include multiple payees (seller, organizer, platform), the sum of `OrderSplit.amountCents` across payees for the ask price MUST equal the askPriceCents after deterministic rounding. Tests must cover per-ticket-type overrides and rounding edge cases.

---

## Security considerations

- **Email verification**: `create-resale-listing` and `create-resale-checkout` require verified email (per `ensure-email-verified` helper).
- **Rate limiting**: listing creation rate-limited per human (prevent spam listings).
- **Ownership verification**: only the ticket's `ownerHumanId` can list it.
- **Idempotency**: listing creation, checkout, and claim creation are all idempotent.
- **QR regeneration**: on resale, the old QR/scan token is invalidated and a new one is minted. The old ticket code becomes unusable.
- **Concurrent holds**: only one buyer can hold a listing at a time (enforced by `@@unique` on `ResaleListingHold.listingId`).

---

## Creator royalty

Organizers (or the artists/humans they designate) can receive a percentage of every resale transaction for their event. This is a first-class feature — not an afterthought — and it requires **zero new financial primitives**. The existing `PayoutTermsLine` model already supports multi-payee percentage splits.

### How it works

When an organizer enables resale for an event, they set up resale `PayoutTerms` with one or more `PayoutTermsLine` entries:

| Line | `payeeId` | `percent` | Purpose |
| --- | --- | --- | --- |
| 1 | Seller's Payee | 85 | Seller receives 85% of ask price |
| 2 | Organizer's Payee | 10 | Creator royalty — goes to org/artist |
| 3 | (implicit) | 5 | Platform take (remainder) |

The `PayoutTermsLine.ticketTypeId` field (nullable) enables per-ticket-type royalty rates. A VIP ticket might carry a 15% royalty while GA carries 5%.

### Concrete money example

A seller lists a ticket for $100 (10 000 cents). Resale FeePolicy: `buyerFeePct = 10%`.

```
Buyer pays:     $110.00  (ask + 10% buyer fee)
  ├─ Ask price:          $100.00
  └─ Buyer fee:           $10.00  → platform revenue (FeePolicy)

Ask price split (via PayoutTermsLine):
  ├─ Seller (85%):        $85.00  → OrderSplit(payeeId=seller)
  ├─ Organizer (10%):     $10.00  → OrderSplit(payeeId=org)
  └─ Platform (5%):        $5.00  → OrderSplit(payeeId=platform)

Total platform revenue:   $15.00  ($10 buyer fee + $5 ask split)
Stripe processing:        deducted from platform revenue per FeePolicy
```

### Settlement flow

`createSettlementsFromOrder` already groups `OrderSplit` entries by `payeeId` and creates a separate `Settlement` per payee per `scheduledPayoutDate`. For the example above, three settlements are created:

1. **Seller settlement** — $85.00, held until claim window closes.
2. **Organizer settlement** — $10.00, same schedule. Blocked by same claim guard.
3. **Platform settlement** — $5.00, immediate (or same schedule, configurable).

If a claim is approved, **all** settlements for that order are cancelled — the organizer royalty is refunded alongside the seller's share. This is correct: the event's creator shouldn't profit from a bad ticket.

### Organizer configuration

The organizer sets royalty rates through the admin resale dashboard (`/admin/[slug]/resale/`). The UI creates or updates `PayoutTermsLine` entries on the event's resale `PayoutTerms`:

- **Default royalty %**: applies to all ticket types unless overridden.
- **Per-ticket-type overrides**: using `PayoutTermsLine.ticketTypeId` to scope.
- **Royalty payee**: defaults to the org's primary `Payee`, but could point to a specific artist's Payee (future: multi-artist royalty splits).

The `create-resale-listing` use case snapshots `resalePayoutTermsId` at listing time (already in the schema). This ensures the seller's listing is governed by the terms in effect when they listed — the organizer can't retroactively increase the royalty on already-listed tickets.

### Why this is a differentiator

Most ticket resale platforms treat organizers as passive bystanders — tickets get resold, the platform takes a cut, and the people who created the experience get nothing. Ithas Fire's creator royalty makes organizers **active beneficiaries** of secondary market activity. This:

- Incentivizes organizers to **enable** resale (they earn from it, rather than fighting it).
- Aligns with the music/entertainment industry trend toward artist-friendly economics (see Spotify's royalty model debates, NFT royalties on OpenSea, etc.).
- Gives smaller organizers a revenue stream they've never had access to before.

---

## Organizer resale oversight

Organizers are not passive participants in resale. They control policy, monitor activity, and earn royalties. All of this is surfaced through the admin resale dashboard.

### Admin resale dashboard: `/admin/[slug]/resale/`

This is a new admin section (add to `ADMIN_SECTIONS` in `apps/web/src/app/admin/[slug]/layout.tsx`).

**Navigation entry**:

```typescript
{ title: "Resale", icon: Repeat, href: "resale" }
```

**Sub-pages / tabs**:

#### Overview tab

- **Resale volume**: total listings created, sold, expired, cancelled across the org's events.
- **Revenue earned**: total royalty revenue collected (sum of organizer OrderSplits from RESALE orders).
- **Average markup**: mean ask price vs. face value across sold listings.
- **Claim rate**: percentage of resale orders that resulted in a claim.
- **Top resold events**: ranked by listing count or revenue.

- **Organizer tracking**: admins need a dedicated view that aggregates resales per organizer (or event owner). This view should show total secondary-market volume, number of resales, total royalties owed, outstanding disputes/claims, and filters for date ranges and events. Each organizer row links to an organizer detail page where admins can review the payout terms that applied to sold listings and an auditable breakdown (raw askPriceCents, applied payout term lines, final split amounts per payee) so the finance team can reproduce the calculations.

#### Policy tab

Per-event resale policy configuration:

| Setting | Control | Default |
| --- | --- | --- |
| Resale enabled | Toggle | Off |
| Price cap mode | "No cap" / "Face value" / "Custom" | Face value |
| Custom cap | Cents input (if mode = Custom) | — |
| Royalty % | Slider 0–50% | 10% |
| Per-ticket-type overrides | Expandable section per type | Inherits event default |

Saving updates the event's `resalePayoutTermsId` (creates one if null) and the associated `PayoutTermsLine` entries. If resale is toggled off, `resalePayoutTermsId` is set to null.

#### Listings tab

- Table of all resale listings for the org's events.
- Columns: event, ticket type, seller (anonymized), ask price, face value, markup %, status, listed date.
- Filters: event, status, date range.
- No edit/delete actions — organizers control policy, not individual listings.

#### Claims tab

- Claims filed against resale orders for the org's events.
- Columns: event, buyer, seller, claim kind, status, deadline, resolution.
- Click-through to claim detail (read-only — resolution is support staff only).
- This gives organizers visibility into quality issues at their events without granting them resolution power.

### Discoverability

Authenticated users who own at least one eligible ticket (VALID, `resaleAllowed`, event hasn't ended) should see an entry point to the Seller Hub. Two locations:

1. **Account page** (`/account`): Add "Sell Tickets" menu item between "My Tickets" and "Settings", with the `Repeat` icon. Links to `/sell/listings`.

2. **My Tickets order detail**: The existing "Resell" button on eligible tickets navigates to `/sell/listings/new?ticketId=<id>` (already specified in the Seller Hub section above).

A user with no eligible tickets can still navigate to `/sell/listings` directly — they'll see the empty state with an explanation of how resale works.

---

## Resolved questions (with reasoning)

### 1. Seller payout eligibility — Stripe Connect is required

**Decision**: Sellers must have a Stripe Connect Express account (Payee record with `stripeAccountId` + `payoutsEnabled`).

**Reasoning**: We already use the "separate charges and transfers" Stripe model (confirmed in `stripe-adapter.ts` — the comment explicitly says "We do NOT use destination charges"). Money flows like this today:

1. Buyer pays Ithas Fire's platform Stripe account (PaymentIntent, no `transfer_data`).
2. Later, the settlement batch job calls `stripe.transfers.create({ destination: acct_xxx, source_transaction: ch_xxx })` to move funds to a connected account.

This is the only legal way to move money to a seller via Stripe. We cannot do a bank transfer to an arbitrary bank account — Stripe requires a connected account as the destination for any transfer. There's no "pay by bank details" option for marketplace payouts.

The existing `Payee` model already supports both `HUMAN` and `ORGANIZATION` subject types. Organizers go through this flow today. Individual resellers would do the same: Express account onboarding (lightweight — name, DOB, SSN last 4, bank account). The onboarding link is generated via `stripe.accountLinks.create()`.

**What this means for UX**: Before a user can list a ticket for resale, they need a Payee record. If they don't have one, the "List for Resale" button triggers Stripe Express onboarding first. This is the same friction StubHub/SeatGeek impose (both require bank/payment info before you can sell).

### 2. Tax on resale — same `admissionTaxRateBps`

**Decision**: Apply the same admission tax rate as primary sales.

**Reasoning**: In the US, admission taxes are generally levied on the *buyer's admission to an event*, not on the *seller's sale channel*. Most state/local admission tax statutes (e.g., Illinois Amusement Tax, NYC Admission Tax) don't distinguish between primary and secondary market transactions. The tax applies to the price paid for admission, period.

We stamp `Event.admissionTaxRateBps` at publish time from the venue's `SavedLocation.admissionTaxRateBps` (resolved via Ziptax). Resale transactions happen for the same event at the same venue, so the same rate applies. The tax basis for resale is the `askPriceCents` (the resale price), not the original face value.

We are not a tax advisor. If a jurisdiction ever creates a secondary-market-specific rate, we can add `Event.resaleAdmissionTaxRateBps` later. For now, one rate per event keeps it simple and legally defensible.

### 3. Resale fee structure — separate FeePolicy via resale PayoutTerms

**Decision**: Use the `FeePolicy` linked to the event's resale `PayoutTerms`, which can differ from primary.

**Reasoning**: Primary sales fees compensate the platform for ticketing infrastructure, marketing, and organizer support. Resale fees compensate the platform for a different service: marketplace hosting, buyer protection (claims), fraud prevention, and QR regeneration. These are different value propositions with different cost structures.

The schema already supports this cleanly:

- `Event.agreementId` → primary PayoutTerms → primary FeePolicy
- `Event.resalePayoutTermsId` → resale PayoutTerms → resale FeePolicy

The resale FeePolicy can have:

- Different `platformFeeBps` (e.g., higher because of claims risk)
- Different `feeMode` (e.g., always `inclusive` even if primary is `pass_through`)
- Different `payoutMinimumCents` (lower threshold since resale payouts are smaller)

Industry context: StubHub charges ~15% to buyers + ~15% to sellers. SeatGeek charges ~20% to buyers. We should be competitive, and having a separate FeePolicy lets us tune resale fees independently.

### 4. Listing expiry — auto-expire at `event.startsAt`

**Decision**: Default `expiresAt = event.startsAt`. Sellers can set an earlier custom expiry but not later than event start.

**Reasoning**: A ticket listed for resale after the event has started is useless (you can't enter an event that's already happening). The expire-resale-listings job runs hourly and catches:

- Listings where `expiresAt < now()`
- Listings where the linked event's `startsAt < now()` (belt-and-suspenders)
- Held listings where `ResaleListingHold.heldUntil < now()` (abandoned checkouts)

On expiry: listing status → EXPIRED, ticket status → VALID (so the original owner can use it).

Sellers may want shorter windows (e.g., "e

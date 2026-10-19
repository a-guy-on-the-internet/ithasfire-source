# Donation Ticket Type

**Date:** 2026-04-18
**Status:** complete
**Priority:** P1 (Important)
**Depends on:** `TicketType` model (`packages/db/prisma/ticket.prisma`), checkout flow (`packages/core/src/use-cases/orders/create-checkout.ts`), refund flow (`packages/core/src/use-cases/orders/refund-full-order.ts`)
**Supersedes:** N/A

---

> **Implementation note (2026-05-16 audit):** This feature shipped, but with a
> different schema shape than the spec originally proposed. The spec drafts a
> new `TicketKind: DONATION` enum value; the actual implementation extended
> the existing `TicketTypePricingMode` enum with an `ADJUSTABLE` value, plus
> `minimumCents` and `suggestedCents` fields on `TicketType`. See migration
> `20260418174813_add_adjustable_pricing_mode` and the `pricingMode` checks
> throughout `create-checkout.ts` / `refund-full-order.ts`. Treat references
> to `TicketKind: DONATION` below as historical — the realised behaviour is
> the same (buyer enters amount within a min/suggested floor; non-refundable;
> flat platform fee), only the field names differ.

---

## Problem

House shows, community events, and fundraisers can't use Ithas Fire because the platform only supports fixed-price tickets. These events operate on a "suggested donation" model where attendees pay what they can. Without this, organizers either don't use Ithas Fire or hack around it with $0 tickets and a Venmo link — losing the ticketing, capacity tracking, and attendee management benefits.

Legally, donation-based events avoid entertainment permit requirements in most jurisdictions, making this the default model for DIY/punk house shows, community gatherings, and grassroots fundraisers.

---

## Goal

Add a "donation" pricing mode to ticket types where the buyer enters their own amount at checkout. The organizer sets a minimum (can be $0) and an optional suggested amount. Donations are non-refundable. The platform charges the same $0.50 flat fee per transaction. This enables the house show circuit, community events, and fundraisers to use Ithas Fire for discovery, ticketing, and capacity management.

---

## Context

| What exists | Where |
|---|---|
| `TicketType` model (fixed price only) | `packages/db/prisma/ticket.prisma` |
| `TicketTypeStatus` enum | `packages/db/prisma/enums.prisma` |
| Checkout flow | `packages/core/src/use-cases/orders/create-checkout.ts` |
| Ticket price computation | `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts` |
| Refund flow | `packages/core/src/use-cases/orders/refund-full-order.ts` |
| Refund eligibility check | `packages/core/src/use-cases/orders/get-refund-eligibility.ts` |
| Event cancel + auto-refund | `packages/core/src/use-cases/events/cancel-event.ts` |
| Order model | `packages/db/prisma/order.prisma` |
| Fee policy ($0.50 flat) | `packages/core/src/lib/pricing/` |

---

## Data Model

### Enum: `TicketTypePricingMode`

```prisma
enum TicketTypePricingMode {
  FIXED       // Current behavior — organizer sets a fixed price
  ADJUSTABLE    // Buyer chooses amount at checkout
}
```

### Changes to `TicketType`

```prisma
model TicketType {
  // ... existing fields ...

  priceCents    Int                     // For FIXED: the ticket price. For ADJUSTABLE: ignored (use minimumCents).
  pricingMode   TicketTypePricingMode   @default(FIXED)

  // ── Donation mode fields ──────────────────────────────────────
  minimumCents    Int?                  // Minimum donation amount in cents. Null or 0 = truly pay-what-you-want.
  suggestedCents  Int?                  // Suggested donation amount shown as a default in the input. Optional.

  // ... rest of model ...
}
```

### Changes to `OrderItem`

```prisma
model OrderItem {
  // ... existing fields ...

  /// The actual amount the buyer chose to pay for this item (in cents).
  /// For FIXED tickets, equals the ticket type's priceCents.
  /// For ADJUSTABLE tickets, equals the buyer's chosen donation amount.
  paidAmountCents  Int
}
```

### Changes to `Order`

```prisma
model Order {
  // ... existing fields ...

  /// When true, this order cannot be refunded via self-serve.
  /// Set automatically for orders containing only ADJUSTABLE ticket types.
  /// Event cancellation by the organizer still refunds regardless.
  nonRefundable  Boolean  @default(false)
}
```

---

## Use Cases

### `create-checkout.ts` (modify existing)

**Changes:**
1. Accept `donationAmountCents` per item in the checkout input when the ticket type is `ADJUSTABLE` mode.
2. Validate `donationAmountCents >= ticketType.minimumCents` (or >= 0 if no minimum).
3. Use `donationAmountCents` instead of `ticketType.priceCents` for price computation.
4. Set `order.nonRefundable = true` when ALL items in the order are ADJUSTABLE ticket types.
5. Store `paidAmountCents` on each `OrderItem`.

**Input schema addition:**
```typescript
items: z.array(z.object({
  ticketTypeId: z.string().uuid(),
  qty: z.number().int().positive(),
  donationAmountCents: z.number().int().nonnegative().optional(),
  // Required when ticketType.pricingMode === "ADJUSTABLE"
}))
```

**Validation:**
```
For each item:
  if ticketType.pricingMode === "ADJUSTABLE":
    - donationAmountCents is required
    - donationAmountCents >= (ticketType.minimumCents ?? 0)
    - donationAmountCents must be > 0 if minimumCents > 0
  else:
    - donationAmountCents is ignored
    - priceCents from ticketType is used
```

### `get-refund-eligibility.ts` (modify existing)

**Changes:**
- If `order.nonRefundable === true`, return `{ eligible: false, reason: "non_refundable_donation" }`.
- Exception: if the refund is triggered by `cancelEvent`, donations ARE refunded (organizer cancelled = buyer should get money back regardless).

### `refund-full-order.ts` (modify existing)

**Changes:**
- Before processing, check `order.nonRefundable`. If true AND the refund is buyer-initiated (not a cancel-event flow), throw `{ code: "forbidden", message: "order_non_refundable" }`.
- The `cancelEvent` flow bypasses this check (it already processes all SUCCEEDED orders).

### `upsert-ticket-type.ts` (modify existing)

**Changes:**
- Accept `pricingMode`, `minimumCents`, `suggestedCents` in the input.
- Validate:
  - If `pricingMode === "ADJUSTABLE"`: `priceCents` is optional (ignored), `minimumCents` defaults to 0.
  - If `pricingMode === "FIXED"`: existing behavior, `minimumCents` and `suggestedCents` are ignored.
  - `suggestedCents >= minimumCents` when both are set.
- ADJUSTABLE ticket types cannot be resold (`resaleAllowed` forced to `false`).

### `compute-ticket-price-for-agreement.ts` (modify existing)

**Changes:**
- Accept an optional `overridePriceCents` parameter that replaces `unitPriceCents` when present.
- The checkout passes `donationAmountCents` as `overridePriceCents` for ADJUSTABLE items.
- Platform fee ($0.50) applies the same way regardless of pricing mode.

---

## UI / Flow

### Event Builder — Ticket Type Editor

When creating/editing a ticket type, add a pricing mode toggle:

```
┌─────────────────────────────────────────────┐
│  Pricing                                    │
│                                             │
│  [FIXED PRICE]  [ADJUSTABLE / PAY WHAT YOU WANT]│
│                                             │
│  ── ADJUSTABLE mode selected ──               │
│                                             │
│  Minimum amount (optional)                  │
│  [$] [0.00]                                 │
│  Helper: "Leave at $0 for truly open"       │
│                                             │
│  Suggested amount (optional)                │
│  [$] [10.00]                                │
│  Helper: "Shown as the default in checkout" │
│                                             │
│  ⚠ Donations are non-refundable.           │
│    Attendees will be informed at checkout.  │
└─────────────────────────────────────────────┘
```

### Checkout — Donation Amount Input

When a buyer selects a ADJUSTABLE ticket type at checkout:

```
┌─────────────────────────────────────────────┐
│  General Admission (Donation)               │
│                                             │
│  Choose your amount                         │
│  [$] [10.00]  ← pre-filled with suggested  │
│                                             │
│  Minimum: $5.00                             │
│                                             │
│  Quick amounts:                             │
│  [$5]  [$10]  [$20]  [$50]  [Custom]       │
│                                             │
│  ── This is a donation and is               │
│     non-refundable. ──                      │
└─────────────────────────────────────────────┘
```

**Quick amount chips:** Show 4 preset amounts based on the suggested amount. If suggested is $10: show $5, $10, $20, $50. If no suggested: show $5, $10, $25, $50.

### Order Confirmation / My Tickets

- Show "Donation" instead of the ticket price.
- Show the amount the buyer chose.
- Show "Non-refundable" badge.

### Refund UI

- If order is non-refundable, the "Request Refund" button is hidden.
- If the buyer contacts support, staff can still issue a manual refund via the platform admin panel (staff refund bypasses the non-refundable flag).

---

## Fee Computation Example

**$10 donation:**
```
Donation amount:     $10.00  (1000 cents)
Platform fee:         $0.50  (50 cents, flat)
Stripe processing:    $0.60  (2.9% of $10.50 + $0.30 = $0.60)
────────────────────────────
Buyer pays:          $11.10
Organizer receives:  $10.00
Ithas Fire keeps:     $0.50
Stripe keeps:         $0.60
```

**$0 donation (free entry):**
```
Donation amount:      $0.00
Platform fee:         $0.00  (no fee on $0 orders — no payment intent created)
Stripe processing:    $0.00
────────────────────────────
Buyer pays:           $0.00  (free ticket issued, no Stripe involved)
```

**$5 minimum, buyer pays $5:**
```
Donation amount:      $5.00  (500 cents)
Platform fee:         $0.50  (50 cents)
Stripe processing:    $0.46  (2.9% of $5.50 + $0.30)
────────────────────────────
Buyer pays:           $5.96
Organizer receives:   $5.00
Ithas Fire keeps:     $0.50
Stripe keeps:         $0.46
```

---

## Acceptance Criteria

- [ ] `TicketType` supports `pricingMode: ADJUSTABLE` with `minimumCents` and `suggestedCents`
- [ ] Checkout accepts `donationAmountCents` per item for ADJUSTABLE ticket types
- [ ] `donationAmountCents < minimumCents` is rejected with `invalid_input`
- [ ] Orders with only ADJUSTABLE items are marked `nonRefundable: true`
- [ ] Self-serve refund is blocked for non-refundable orders
- [ ] Staff refund still works for non-refundable orders
- [ ] Event cancellation refunds donation orders (organizer-initiated override)
- [ ] $0 donations issue a free ticket (no Stripe payment intent)
- [ ] Platform fee ($0.50) applies to non-zero donations
- [ ] ADJUSTABLE ticket types cannot be listed for resale
- [ ] Checkout UI shows amount input with suggested/minimum for ADJUSTABLE types
- [ ] Order confirmation shows "Donation" label and "Non-refundable" badge
- [ ] Event builder shows pricing mode toggle (FIXED / ADJUSTABLE)
- [ ] Mixed orders (FIXED + ADJUSTABLE items) are allowed — order is refundable only for the FIXED items

---

## Open Questions

- **Mixed orders:** If an order has both FIXED and ADJUSTABLE items, should the FIXED items be refundable while ADJUSTABLE items aren't? Currently spec'd as: order-level `nonRefundable` is only set when ALL items are donations. Mixed orders remain refundable for the fixed-price items. This means item-level refund granularity is needed (already exists via `refund-order-items.ts`).

- **Tax on donations:** Are donations subject to sales/admission tax? In most US jurisdictions, charitable donations are tax-exempt, but "suggested donations" for event entry may be treated as admission fees. For MVP, apply the same tax logic as fixed-price tickets. Organizers can set `admissionTaxRateBps: 0` if they qualify for exemption.

- **Receipt language:** Should the order confirmation email say "Donation receipt" or "Ticket receipt"? For tax purposes, donors may want a receipt that documents the donation amount. This is a future enhancement — MVP uses standard receipt.

- **Recurring donations:** Out of scope for MVP. A "monthly supporter" model could be built later using Stripe Subscriptions.

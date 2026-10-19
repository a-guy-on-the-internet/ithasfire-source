# Item-Level Settlements & Resale Spec

> **Status**: Implemented (Settlement & Refund Eligibility) / Draft (Resale)  
> **Last Updated**: 2026-01-24  
> **Authors**: Engineering Team

## Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| OrderItem.paidOutAt | ✅ Implemented | Migration applied |
| OrderItem.refundedAt | ✅ Implemented | Migration applied |
| OrderItem.transferredAt | ✅ Implemented | Migration applied |
| OrderItem.status | ✅ Implemented | "active" / "refunded" / "transferred" |
| OrderItemSettlementLine | ✅ Implemented | Join table linking items to settlement lines |
| createSettlementsFromOrder | ✅ Updated | Creates OrderItemSettlementLine records |
| executeSettlementTransfer | ✅ Updated | Marks items as paid out via join table |
| getRefundEligibility | ✅ Updated | Checks item-level paidOutAt |
| getMyOrder | ✅ Updated | Returns item-level status fields |
| E2E Tests | ✅ Created | `item-level-settlements.spec.ts` |
| Partial Item Refund UI | 🚧 Not Started | Future work |
| Resale Marketplace | 🚧 Not Started | Future work |

## Overview

This spec defines how we track settlements, refunds, and resales at the **OrderItem level** rather than the Order level. This enables:

- Partial refunds (refund some items, keep others)
- Item-level payout tracking (know exactly which items have been settled)
- Resale marketplace (transfer tickets between users)

## Guiding Principles

Per company philosophy:
- **"Don't be greedy"** - Minimize extraction; fees should be transparent and fair
- **Transparency** - Show users exactly what fees they pay and why
- **Simplicity** - Don't clutter UI with unnecessary complexity

---

## Data Model Changes

### Current Model (Order-Level)

```
Order
 ├─ paidOutAt: DateTime?  ← DEPRECATED (use OrderItem.paidOutAt instead)
 └─ OrderItem[]
 └─ OrderSplit[] (money division by payee per Agreement)
       └─ SettlementLine[]
             └─ Settlement
```

**Problem**: We couldn't track which individual tickets have been paid out.

### New Model (Item-Level, One Item Per Ticket)

```
OrderItem (one per ticket, qty always = 1)
 ├─ qty: 1                    // Always 1 - each OrderItem represents a single ticket
 ├─ paidOutAt: DateTime?      // When this ticket was settled to organizer
 ├─ refundedAt: DateTime?     // When this ticket was refunded (if applicable)
 ├─ transferredAt: DateTime?  // When this ticket was resold/transferred
 └─ status: "active" | "refunded" | "transferred"

OrderItemSettlementLine (join table)
 ├─ orderItemId: String
 ├─ settlementLineId: String
 ├─ amountCents: Int          // This ticket's contribution to the settlement
 └─ (unique: orderItemId + settlementLineId)
```

**Key Design Decision**: When a buyer purchases 2 tickets of the same type, we create **2 OrderItems with qty=1** (not 1 OrderItem with qty=2). This enables:
- Partial refunds: refund ticket #1 but keep ticket #2
- Granular settlement tracking: ticket #1 can be paid out while ticket #2 is not
- Per-ticket resale: transfer ticket #1 to a new owner independently

### Why a Join Table?

When a settlement is executed, multiple OrderItems (tickets) may contribute to a single SettlementLine. The join table tracks:
- Which tickets are included in which settlement
- How much of the settlement amount came from each ticket
- Enables partial refunds post-settlement (though organizer discretion required)

---

## Settlement Flow

### 1. Order Completes (Payment Intent Succeeded)

```
1. Order.status → SUCCEEDED
2. OrderSplits created (based on Agreement lines)
3. Tickets minted → OrderItem created for each
4. Each OrderItem.status = "active", paidOutAt = null
```

### 2. Settlement Created (Batch Job)

```
1. createSettlementsFromOrder runs
2. For each OrderSplit → SettlementLine created
3. For each OrderItem in Order:
   - Create OrderItemSettlementLine linking item → settlement line
   - amountCents = item's proportional share of the split
```

### 3. Settlement Transferred (Stripe Transfer Succeeds)

```
1. executeSettlementTransfer completes
2. Settlement.status → "transferred"
3. For each SettlementLine in Settlement:
   - For each OrderItemSettlementLine:
     - OrderItem.paidOutAt = now()
```

---

## Refund Flow

### Pre-Payout Refund (Self-Service)

**Condition**: `OrderItem.paidOutAt IS NULL`

```
1. User selects items to refund
2. For each selected item:
   - Calculate refund amount (item price + proportional buyer fee)
   - Mark item.status = "refunded", item.refundedAt = now()
3. Issue Stripe refund for total amount
4. If ALL items refunded → Order.status = REFUNDED
5. If SOME items refunded → Order.status = PART_REFUNDED
```

### Post-Payout Refund (Organizer Discretion)

**Condition**: `OrderItem.paidOutAt IS NOT NULL`

```
1. User sees "Contact organizer for refund" message
2. Organizer decides whether to refund
3. If approved:
   - Platform may need to claw back from organizer's next payout
   - Or organizer provides funds separately
   - Mark item.status = "refunded"
```

---

## Resale Flow

### Seller Lists Ticket

```
1. Seller owns OrderItem where status = "active"
2. Seller sets asking price (may be capped by TicketType.resaleCap or Seat policy)
3. Create ResaleListing:
   - orderItemId: original item
   - askingPriceCents: seller's price
   - status: "active"
```

### Buyer Purchases Resale

```
1. Buyer pays: askingPrice + platformFees
   - Platform fees: Stripe processing (2.9% + $0.30) + platform fee (split per Agreement)
2. Create new Order for buyer:
   - source: "RESALE"
   - New OrderItem created
   - New Ticket minted with new QR code
3. Original OrderItem:
   - status → "transferred"
   - transferredAt = now()
4. Seller receives: askingPrice (via payout)
5. Platform fee split per Agreement lines (same as primary sales)
```

### Listing lifecycle (recorded 2026-10-11)

A `ResaleListing` row (table `Listing`) is kept after it ends. A ticket has at most one live listing (ACTIVE or HELD) and any number of past ones (SOLD, CANCELLED, EXPIRED). The past rows are the record of what a ticket was offered and sold for, and to whom.

| Operation | Decision |
| --- | --- |
| Create | Built: `createResaleListing`. Allowed whenever the ticket has no live listing, so a ticket can be listed again after a cancel or an expiry. A ticket bought on resale can be listed again too, any number of times (owner ruling 2026-10-11). Each sale in the chain is its own SOLD row and its own RESALE order. On a RESALE order's item, `resaleListingId` stays the listing the item was bought through: listing the ticket again, cancelling that listing or selling it never writes the column. Whether such a ticket is listed now is read from the ticket (status LISTED), not from the item. A refund of a resale purchase whose buyer listed the ticket again does one of three things. (a) The buyer's listing is ACTIVE: it is cancelled first, then the ticket goes back to the seller it was bought from, as in any resale refund. (b) The buyer's listing is HELD by someone's checkout: that listing is closed and its hold dropped, the ticket goes back to the seller it was bought from, and the first sale is cancelled, not put back on sale. The refund commits, with an audit row and an error report that name the checkout that was ended. That checkout can no longer complete: if its payment lands, finalizing it fails and the paid order goes to the Stripe webhook dead-letter queue for a person to refund. (c) The ticket has already been sold on: the refund goes to manual review (ruling 2026-10-05). Nothing is written, nobody is debited and nothing is taken from the person who holds the ticket now; an error report tells a person, who settles it. Until they do, the refunded buyer's order still reads SUCCEEDED. This holds whether the later sale committed before the refund was reconciled or while it was being reconciled: the reconcile locks the ticket row and reads the order again under that lock before it decides. What, if anything, is recovered from the refunded buyer in (c) is an open owner question. Only a full refund made in the Stripe dashboard reaches (a) and (b). Refunds started in the app do not move money for a relisted ticket: a buyer, organiser or staff refund skips a ticket that is listed and refuses one that was sold on, and a ticket under a resale claim cannot be listed, so a claim approval does not meet one. The unwind keeps a branch for a sold-on ticket as a defence (it leaves the ticket with its holder and reports, and a later refund of that holder hands the ticket back to the already refunded buyer with their listing closed, reported), but no refund path reaches it today. A ticket whose own purchase is recorded as refunded cannot be listed (`TICKET_NOT_ELIGIBLE_FOR_RESALE`, reason `purchase_refunded`): a holder who has their money back is not paid for the ticket again. Known gap: a buyer refunded through manual review in (c) has no refund recorded on their order until a person records it, so if the ticket later comes back to them they can list it. Closing that needs a marker on the order at manual review, which is an open owner question with the one on recovery. Two things count as that: the ticket's purchase item is refunded, or the ticket sits on a refunded resale order (a resale order has one ticket, so the order's status speaks for it). A refunded order of any other kind does not count by itself, because an order is marked refunded when each of its tickets was refunded or given away, and a ticket that was given away is not paid back. So a gifted ticket can be listed when the rest of its order was refunded, and so can a ticket that came back to its seller from a refund of their buyer on such an order. Built: on a cancelled event every sale in a chain is refunded, last buyer first (`cancelEvent`). Each resale buyer is refunded what they paid less that charge's processing fee, the seller is debited what the sale credited them, and the ticket goes back one step; the original order's item is refunded last and the ticket is voided with it. A sale is refunded only when the sale after it was refunded in the same cancellation. If one is not (the refund failed, the charge is disputed, or the order was skipped), every earlier resale order is left unrefunded, counts in the failed-refund count, and is recorded in the `cancelled` audit row under `failedRefundReasons` as `later_resale_not_refunded`; the original item stays `transferred`. The original buyer's order is not counted in the failed-refund count in that case: it has nothing left to refund, so the cancellation skips it. Not built: a retry for those orders. A cancellation does not run twice for an event, so a person settles them. |
| Read | Built: single (`getById`, `getByTicketId` returns the live listing, else the most recent) and lists by event and by seller. |
| Update | Not built, on purpose. A listing's price and terms are a snapshot; a seller who wants a different price cancels and lists again. Only `status` moves, through hold, commit, cancel, expire and the refund unwind. |
| Remove | Not built, on purpose. Listings are append-only once they end: cancel and expire are status changes, never deletes. Rows go only when the ticket or event they hang off is deleted (FK CASCADE). |
| `/platform` | No page. Platform staff see resale through orders and claims. |

The one-live-listing rule is a partial unique index, `Listing_ticketId_live_key` (migration `20261011120000_listing_live_unique_per_ticket`). Prisma cannot express it, so it lives in SQL only. It replaced a unique index on `ticketId` that allowed one listing per ticket ever and made every second listing fail.

### Fee Transparency

Display to buyer:
```
Ticket Price:        $50.00 (set by seller)
    <!-- Also include ticket split based off the agreement lines so the user knows where the money is flowing to -->
Service Fee:          $1.75 (platform fee)
Processing Fee:       $1.75 (Stripe 2.9% + $0.30)
─────────────────────────────
Total:               $53.50
```

Display to seller:
```
Your Payout:         $50.00
(Platform fees paid by buyer)
```

---

## Seat-Level Policies (Future)

Seats can override TicketType defaults:

```prisma
model Seat {
  id            String @id
  ticketTypeId  String
  
  // Policy overrides (null = inherit from TicketType)
  salePolicy    SalePolicy?   // "fixed" | "auction" | "lottery"
  resaleAllowed Boolean?
  resaleCap     Int?          // Max resale price in cents
  transferAllowed Boolean?
  refundOnly    Boolean?      // If true, no resale - refund to pool only
  
  // Constraints
  timeLock      DateTime?     // Can't transfer/resell until this time
  eligibility   Json?         // Rules for who can buy (membership, etc.)
  botRisk       String?       // Risk level for bot detection
}
```

Resolution order:
1. Seat policy (if set)
2. TicketType policy (if set)  
3. Event defaults

---

## Schema Changes Required

### 1. Add fields to OrderItem

```prisma
model OrderItem {
  // ... existing fields ...
  
  paidOutAt     DateTime?
  refundedAt    DateTime?
  transferredAt DateTime?
  status        String    @default("active") // "active" | "refunded" | "transferred"
}
```

### 2. Remove paidOutAt from Order

```prisma
model Order {
  // paidOutAt DateTime?  ← REMOVE
}
```

### 3. Create OrderItemSettlementLine

```prisma
model OrderItemSettlementLine {
  id               String @id @default(uuid())
  orderItemId      String
  settlementLineId String
  amountCents      Int

  orderItem      OrderItem      @relation(fields: [orderItemId], references: [id], onDelete: Cascade)
  settlementLine SettlementLine @relation(fields: [settlementLineId], references: [id], onDelete: Cascade)

  @@unique([orderItemId, settlementLineId])
  @@index([settlementLineId])
}
```

### 4. Create ResaleListing (for marketplace)

```prisma
model ResaleListing {
  id              String   @id @default(uuid())
  orderItemId     String   @unique  // One listing per item
  sellerHumanId   String
  askingPriceCents Int
  currency        String   @default("usd")
  status          String   @default("active") // "active" | "sold" | "canceled" | "expired"
  expiresAt       DateTime?
  
  orderItem OrderItem @relation(fields: [orderItemId], references: [id])
  seller    Human     @relation(fields: [sellerHumanId], references: [id])
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

---

## Migration Strategy

1. **Phase 1**: Add new fields/tables (non-breaking)
   - Add `paidOutAt`, `refundedAt`, `transferredAt`, `status` to OrderItem
   - Create `OrderItemSettlementLine` table
   - Remove `Order.paidOutAt`

2. **Phase 2**: Backfill existing data
   - For orders where `Order.paidOutAt IS NOT NULL`:
     - Set all `OrderItem.paidOutAt = Order.paidOutAt`
   - Create `OrderItemSettlementLine` records for existing settlements

3. **Phase 3**: Update use cases
   - `executeSettlementTransfer`: Mark items as paid out via join table
   - `getRefundEligibility`: Check at item level
   - `createInstantRefund`: Support partial item refunds

4. **Phase 4**: Remove Order.paidOutAt
   - Drop column after all code uses item-level tracking

---

## Open Questions

1. **Buyer fee distribution on partial refunds**: If order has 3 items and buyer refunds 1, how do we calculate the proportional buyer fee for that item?
   - Proposal: `itemBuyerFee = totalBuyerFee * (itemPrice / orderSubtotal)`

2. **Stripe fee on partial refunds**: Stripe doesn't refund their processing fee. Who absorbs this?
   - Current: Deduct from refund amount with clear disclosure. Add the option for us to absorb it if we want to change it over to that.

3. **Resale fee split**: Does the resale platform fee follow the same Agreement as primary sales?
   - Proposal: Yes, same Agreement lines determine split

---

## Related Documents

- `docs/hot-paths.md` - Money flow cautions
- `docs/engineering-standards.md` - Error handling patterns
- `packages/core/src/lib/pricing/` - Fee calculation utilities

# 20261012190000_resale_share_clause: prod pre-check

Spec: `docs/specs/2026-10-12/organiser-resale-share.spec.yaml` (FR-004, FR-014, FR-015).

This file supersedes the "PROD PRE-CHECK" comment block at the top of
`migration.sql`. That block cannot be edited: the migration is applied, and
any byte change breaks its checksum.

The owner runs these on prod before the B5 migration (which cancels live
listings and drops the markup columns). They are read-only, and none of them
reads a column added by this migration, so they run before or after it ships.
Run them in a read-only session:

```sql
SET default_transaction_read_only = on;

-- 1. Live resale listings.
SELECT status, count(*) FROM "Listing"
WHERE status IN ('ACTIVE', 'HELD')
GROUP BY status;

-- 2. RESALE payout terms rows.
SELECT status, count(*) FROM "PayoutTerms"
WHERE kind = 'RESALE'
GROUP BY status;

-- 3. (a) Unfinished resale checkouts: PENDING orders holding a resale item.
SELECT count(DISTINCT o.id) AS pending_resale_orders
FROM "Order" o
JOIN "OrderItem" oi ON oi."orderId" = o.id
WHERE o.status = 'PENDING'
  AND oi."resaleListingId" IS NOT NULL;

-- 4. (b) Resale items whose seller payout is not finished.
SELECT oi."resalePayoutStatus", count(*)
FROM "OrderItem" oi
WHERE oi."resaleListingId" IS NOT NULL
  AND oi."resalePayoutStatus" IN ('PENDING', 'HELD', 'READY', 'BLOCKED')
GROUP BY oi."resalePayoutStatus";

-- 5. (c) FR-004's population: VALID tickets on ticket types with resale on.
SELECT count(*) AS valid_tickets_resale_allowed
FROM "Ticket" t
JOIN "TicketType" tt ON tt.id = t."ticketTypeId"
WHERE t.status = 'VALID'
  AND tt."resaleAllowed" = true;
```

What a non-zero answer means:

1. **Live listings.** B5 must cancel them and send each seller a notice to
   list again (FR-015). Their asks were priced under the markup split.
2. **RESALE terms.** Each row reads `resaleShareType` NULL after this
   migration, so resale stays off on those events until a clause is set
   (FR-001). Any of these on events with resale switched on means organisers
   must set a clause before their tickets can be resold.
3. **Pending resale orders.** A buyer is mid-checkout on a listing priced
   under the markup split. B5 must not drop the markup columns until these
   finish or expire, or finalize reads columns that are gone.
4. **Unfinished resale payouts.** These sellers are still owed money computed
   from the markup snapshot columns (`resaleSellerMarkupShareCents` and
   friends). B5 must keep those columns, or carry the amounts over, until
   these reach PAID.
5. **FR-004's population.** These tickets have no FR-003 record. Each one gets
   the event's clause written onto its purchase OrderItem at its first listing
   (a one-time conditional write where `resaleClauseType IS NULL`). The count
   is how many tickets that path will touch.

Enum values and column names were checked against the schema on 2026-10-13:
`ListingStatus` (ACTIVE, HELD, SOLD, CANCELLED, EXPIRED), `PayoutTermsKind`
(RESALE), `OrderStatus` (PENDING), `ResaleOrderItemPayoutStatus` (PENDING,
HELD, READY, PAID, BLOCKED), `TicketStatus` (VALID), `TicketType.resaleAllowed`.

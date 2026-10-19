# PayoutTerms Rename, Claims, Resale Controls & PlaceLayout 1:Many

> **Status**: complete
> **Created**: 2026-02-09
> **Authors**: Engineering Team

## Overview

This spec covers four related changes:

1. **Rename Agreement → PayoutTerms** across schema, types, ports, adapters, core, and transport layers.
2. **Delete AgreementProposal & AgreementProposalReview** — proposal negotiation is out of scope; terms are set at event creation time by the organizer/org.
3. **Delete AgreementTemplate** — templates were tied to the proposal workflow and are unused.
4. **Add `Claim` model** for post-event buyer disputes on resale orders (3-day grace period, support-handled).
5. **Add resale controls to `TicketType`** (`resaleAllowed`, `resaleCapCents`, `transferAllowed`).
6. **Fix `PlaceLayout` from 1:1 to 1:many per Place** and add `Event.placeLayoutId` FK.

## Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| Rename Agreement → PayoutTerms (schema) | 🚧 Not Started | |
| Rename Agreement → PayoutTerms (types/ports/adapters/core/transport) | 🚧 Not Started | ~104 files |
| Delete AgreementProposal + AgreementProposalReview | 🚧 Not Started | 2 files reference proposals |
| Delete AgreementTemplate | 🚧 Not Started | Schema only, no use case code |
| Add Claim model | 🚧 Not Started | |
| Add resale controls to TicketType | 🚧 Not Started | |
| PlaceLayout 1:many + Event.placeLayoutId | 🚧 Not Started | |

---

## 1. Rename Agreement → PayoutTerms

### Why

"Agreement" implies a legal contract with negotiation. What the model actually stores is:
- Who gets what % of each ticket sale (split lines)
- When money moves (payout schedule)
- Who absorbs fees (fee mode)
- What basis the split is calculated on (gross vs net)

"PayoutTerms" describes what it is: the financial terms governing how ticket revenue is split and paid out.

### Schema Changes

**Rename models:**

| Old | New |
|-----|-----|
| `Agreement` | `PayoutTerms` |
| `AgreementLine` | `PayoutTermsLine` |
| `AgreementKind` | `PayoutTermsKind` |
| `AgreementStatus` | `PayoutTermsStatus` |
| `AgreementSubjectType` | `PayoutTermsSubjectType` |
| `AgreementBasis` | `PayoutTermsBasis` |
| `AgreementLineRounding` | `PayoutTermsLineRounding` |

**Rename Event FKs:**

| Old | New |
|-----|-----|
| `Event.agreementPrimaryId` | `Event.payoutTermsId` |
| `Event.agreementResaleId` | `Event.resalePayoutTermsId` |

**Rename Settlement FK:**

| Old | New |
|-----|-----|
| `Settlement.agreementId` | `Settlement.payoutTermsId` |

**Rename FeePolicy relation:**

| Old | New |
|-----|-----|
| `FeePolicy.agreements` | `FeePolicy.payoutTerms` |

### New Schema (PayoutTerms)

```prisma
enum PayoutTermsKind {
  PRIMARY
  RESALE
}

enum PayoutTermsStatus {
  PENDING
  ACTIVE
  ARCHIVED
}

enum PayoutTermsSubjectType {
  EVENT
  ORGANIZATION
  HUMAN
}

enum PayoutTermsBasis {
  GROSS
  NET_AFTER_PLATFORM_FEES
}

enum PayoutTermsLineRounding {
  FLOOR
  NEAREST
}

model PayoutTerms {
  id                 String                  @id @default(uuid())
  subjectType        PayoutTermsSubjectType
  subjectId          String
  kind               PayoutTermsKind
  version            Int                     @default(1)
  isDefault          Boolean                 @default(false)
  settlementCurrency String                  @default("usd") @db.VarChar(3)
  basis              PayoutTermsBasis        @default(NET_AFTER_PLATFORM_FEES)
  effectiveFrom      DateTime?
  effectiveTo        DateTime?
  status             PayoutTermsStatus       @default(PENDING)
  feeMode            PaymentFeeType?
  feePolicyId        String?
  payoutSchedule     PayoutSchedule          @default(WEEK_OF_EVENT)

  lines PayoutTermsLine[]

  feePolicy   FeePolicy?   @relation(fields: [feePolicyId], references: [id], onDelete: SetNull)
  settlements Settlement[]

  eventsPrimary Event[] @relation("EventPrimaryPayoutTerms")
  eventsResale  Event[] @relation("EventResalePayoutTerms")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([subjectType, subjectId, kind, isDefault, status])
}

model PayoutTermsLine {
  id             String                  @id @default(uuid())
  payoutTermsId  String
  payeeId        String
  percent        Int
  floorCents     Int                     @default(0)
  capPercent     Int?
  priority       Int                     @default(0)
  rounding       PayoutTermsLineRounding @default(FLOOR)

  payoutTerms PayoutTerms @relation(fields: [payoutTermsId], references: [id], onDelete: Cascade)
  payee       Payee       @relation(fields: [payeeId], references: [id])

  @@index([payoutTermsId])
  @@index([payeeId])
}
```

### Type/Port/Adapter Rename Map

| Layer | Old | New |
|-------|-----|-----|
| `@th/types` | `repos/agreements.ts` | `repos/payout-terms.ts` |
| `@th/types` | `AgreementRecord` | `PayoutTermsRecord` |
| `@th/types` | `AgreementLineRecord` | `PayoutTermsLineRecord` |
| `@th/types` | `AgreementLineInput` | `PayoutTermsLineInput` |
| `@th/types` | `CreateAgreementDraftInput` | `CreatePayoutTermsDraftInput` |
| `@th/types` | `UpdateAgreementDraftInput` | `UpdatePayoutTermsDraftInput` |
| `@th/ports` | `repos/agreements.ts` | `repos/payout-terms.ts` |
| `@th/ports` | `AgreementsRepo` | `PayoutTermsRepo` |
| `@th/ports` | `Repos.agreements` | `Repos.payoutTerms` |
| `@th/adapters` | `db/prisma/agreements.ts` | `db/prisma/payout-terms.ts` |
| `@th/core` | `use-cases/agreements/` | `use-cases/payout-terms/` |
| `@th/core` | `upsert-agreement-for-event.ts` | `upsert-payout-terms-for-event.ts` |
| `@th/core` | `upsert-agreement-for-org.ts` | `upsert-payout-terms-for-org.ts` |
| `@th/core` | `upsert-agreement-for-human.ts` | `upsert-payout-terms-for-human.ts` |
| `@th/core` | `upsert-agreement-lines.ts` | `upsert-payout-terms-lines.ts` |
| `@th/core/lib` | `compute-ticket-price-for-agreement.ts` | `compute-ticket-price-for-payout-terms.ts` |
| `@th/core` | `AgreementContext` (checkout-helpers) | `PayoutTermsContext` |
| `@th/core` | `loadAgreementContext()` | `loadPayoutTermsContext()` |
| `@th/core` | `buildPricingAgreementContext()` | `buildPricingPayoutTermsContext()` |
| `@th/core` | `buildFeePolicySnapshot()` output key `agreementId` | `payoutTermsId` |
| transport | `routers/agreements.ts` | `routers/payout-terms.ts` |
| test-utils | `create-agreement-deps.ts` | `create-payout-terms-deps.ts` |
| test-utils | `upsert-agreement-test-context.ts` | `upsert-payout-terms-test-context.ts` |

### Migration Strategy

1. Create Prisma migration that renames tables + columns (using `ALTER TABLE ... RENAME TO` and `ALTER TABLE ... RENAME COLUMN` to avoid data loss).
2. Rename files, types, and exports across all layers.
3. Update all 104 referencing files.
4. Run full build + test suite.

---

## 2. Delete Proposals & Templates

### What's Removed

| Model | Reason |
|-------|--------|
| `AgreementProposal` | Unused — terms are set at event creation, not negotiated |
| `AgreementProposalReview` | Unused — depends on proposals |
| `AgreementTemplate` | Unused — no use case code references it |
| `ProposalStatus` enum | Only used by proposals |
| `ReviewDecision` enum | Only used by proposal reviews |

### Files to Update

- `packages/db/prisma/schema.prisma` — drop 3 models + 2 enums
- `apps/api/src/scripts/seed/seed-data.ts` — remove any proposal seeding

### Migration

Prisma migration that drops the 3 tables. No data loss concern since they're unused in production.

---

## 3. Add Claim Model

### Purpose

When a buyer purchases a resale ticket and can't get into the event (invalid ticket, entry denied, wrong seat), they need a formal process to request a refund **after the event**. This is distinct from the existing pre-event refund flow.

### Policy

- Claims are only valid for `Order.source = RESALE` orders.
- Buyer can file a claim from `event.startsAt` until `event.endsAt + 3 days` (grace period).
- While an open claim exists, payout to the reseller is **blocked**.
- If no claim by deadline → reseller gets paid automatically.
- If claim approved → refund buyer from held funds, reseller gets nothing for that item.
- If claim denied → reseller gets paid, decision is final.
- All resolution is handled by internal support staff.

### Schema

```prisma
model Claim {
  id            String   @id @default(uuid())
  orderId       String
  orderItemId   String
  eventId       String
  claimantId    String   // buyer (Human)
  respondentId  String   // reseller (Human)

  // Free-text kind validated in app code.
  // Expected values: "ticket_invalid" | "entry_denied" | "wrong_seat" | "other"
  kind          String

  // "open" | "under_review" | "approved" | "denied" | "expired"
  // Validated in app code, not an enum.
  status        String   @default("open")

  evidence      Json     @default("{}") // buyer description, screenshots, scan log refs
  deadline      DateTime // event.endsAt + 3 days — enforced at creation time

  resolvedAt    DateTime?
  resolvedById  String?  // support staff Human who resolved
  resolutionNote String?
  // "full_refund" | "partial_refund" | "denied" | "expired" — validated in app code
  resolution    String?

  order     Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  orderItem OrderItem @relation(fields: [orderItemId], references: [id], onDelete: Cascade)
  event     Event  @relation(fields: [eventId], references: [id], onDelete: Cascade)
  claimant  Human  @relation("ClaimClaimant", fields: [claimantId], references: [id], onDelete: Restrict)
  respondent Human @relation("ClaimRespondent", fields: [respondentId], references: [id], onDelete: Restrict)
  resolvedBy Human? @relation("ClaimResolver", fields: [resolvedById], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([orderItemId]) // one claim per order item
  @@index([orderId])
  @@index([eventId, status])
  @@index([claimantId])
  @@index([respondentId])
  @@index([status, deadline])
}
```

### Required Relation Additions

- `Order.claims Claim[]`
- `OrderItem.claim Claim?`
- `Event.claims Claim[]`
- `Human.claimsAsBuyer Claim[] @relation("ClaimClaimant")`
- `Human.claimsAsSeller Claim[] @relation("ClaimRespondent")`
- `Human.claimsResolved Claim[] @relation("ClaimResolver")`

### Payout Integration

The settlement/payout flow must check for open claims before releasing resale funds:

```
When computing payout eligibility for a resale order's settlement:
1. Check: any Claim where orderId = order.id AND status IN ("open", "under_review")?
2. If yes → skip this settlement in the payout batch (keep status "pending")
3. If no open claims AND deadline has passed → include in payout
```

This check goes in the payout batch job, not in `createSettlementsFromOrder` (settlements are still created immediately; they're just held from payout).

### Use Cases Needed

| Use Case | Actor | Description |
|----------|-------|-------------|
| `create-claim` | Buyer | File a claim on a resale order item. Validates: order.source = RESALE, now >= event.startsAt, now <= event.endsAt + 3 days, no existing claim on item. |
| `review-claim` | Support staff | Transition claim to "under_review", "approved", or "denied". On approval: trigger refund from held funds, mark OrderItem as refunded. On denial: unblock payout. |
| `expire-claims` | Batch job | Find claims where status = "open" AND deadline < now(). Set status = "expired", resolution = "expired". Unblock payout. |
| `list-claims` | Support staff | List/filter claims by status, event, date range for the support dashboard. |
| `get-claim` | Support staff / Buyer | View claim details including evidence and resolution. |

---

## 4. Resale Controls on TicketType

### Why

Resale policy varies by ticket tier. GA tickets might allow resale with no cap. VIP tickets might cap at 150% of face value. Some tiers might prohibit resale entirely.

### Event-Level Gate

The event-level gate for resale is: does `Event.resalePayoutTermsId` exist? If null → resale is disabled for the entire event regardless of per-TicketType settings.

### Schema Addition

```prisma
model TicketType {
  // ... existing fields ...

  /// Whether tickets of this type can be listed for resale.
  /// Only effective if the event has a resalePayoutTermsId set.
  resaleAllowed   Boolean @default(false)

  /// Maximum resale price in cents. Null = no cap.
  /// Enforced at listing creation time.
  resaleCapCents  Int?

  /// Whether tickets of this type can be transferred (gifted) to another user.
  /// Distinct from resale — transfers are free, no money changes hands.
  transferAllowed Boolean @default(true)
}
```

### Resolution Order for Resale Eligibility

```
1. Event.resalePayoutTermsId is null? → resale disabled for entire event
2. TicketType.resaleAllowed is false? → resale disabled for this tier
3. TicketType.resaleCapCents is set? → enforce price cap at listing time
```

Per-seat overrides are explicitly out of scope. TicketType is the granularity that matters.

---

## 5. PlaceLayout 1:Many + Event FK

### Problem

`PlaceLayout` has `@@unique([placeId])` — forcing exactly one layout per Place. Large venues have multiple standard configurations (e.g., arena mode, theater mode, half-house). Events at the same venue need different layouts.

### Schema Changes

```prisma
model PlaceLayout {
  id               String   @id @default(uuid())
  placeId          String   @map("place_id")
  name             String   // e.g. "Arena Mode", "Theater Mode", "Half-House"
  checksum         String
  glyphSnapshotKey String   @map("glyph_snapshot_key")
  metadata         Json     @default("{}")
  seatIndex        Json     @default("{}") @map("seat_index")
  stage            Json     @default("{}")
  issues           Json     @default("[]")
  createdByHumanId String   @map("created_by_human_id")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")
  notes            String?

  place          Place   @relation(fields: [placeId], references: [id], onDelete: Cascade)
  createdByHuman Human   @relation("PlaceLayoutCreatedBy", fields: [createdByHumanId], references: [id], onDelete: Restrict)
  events         Event[] @relation("EventPlaceLayout")

  // CHANGED: @@unique([placeId]) removed — now 1:many
  @@unique([placeId, name])
  @@index([placeId])
  @@index([createdByHumanId])
  @@map("place_layouts")
}
```

**Event FK addition:**

```prisma
model Event {
  // ... existing fields ...

  /// Optional link to a specific PlaceLayout for this event.
  /// When creating an event at a Place, the organizer picks from the place's saved layouts.
  /// The layout is used to stamp out SeatSection + Seat rows for this event.
  placeLayoutId String? @map("place_layout_id")

  placeLayout PlaceLayout? @relation("EventPlaceLayout", fields: [placeLayoutId], references: [id], onDelete: SetNull)
}
```

### Migration

1. Add `name` column to `place_layouts` (default to `'Default'` for existing rows).
2. Drop `@@unique([placeId])` constraint.
3. Add `@@unique([placeId, name])` constraint.
4. Add `place_layout_id` column to `Event` table (nullable).
5. Backfill: for existing events with a `placeId` that has a layout, optionally set `placeLayoutId` to the existing layout's id.

---

## Execution Order

Phase 1 and 2 are the schema migration (single Prisma migration):
1. Rename Agreement → PayoutTerms (tables + columns)
2. Drop AgreementProposal, AgreementProposalReview, AgreementTemplate, ProposalStatus, ReviewDecision
3. Add Claim model
4. Add resale fields to TicketType
5. Fix PlaceLayout (add name, drop unique, add Event FK)

Phase 3 is the code rename (~104 files):
- Types → Ports → Adapters → Core → Transport → Test Utils → Seeds → E2E

Phase 4 is new code:
- Claim use cases (create, review, expire, list, get)
- Payout batch job claim check
- Resale listing validation against TicketType controls

---

## Open Questions

1. **Grace period configurability**: Is 3 days always the right grace period, or should it be configurable per event? Current decision: hardcoded 3 days, revisit later.
2. **Claim evidence format**: What fields should the `evidence` JSON contain? Proposed: `{ description: string, attachmentUrls?: string[], scanLogIds?: string[] }`.
3. **Resale cap as percentage**: Should we also support `resaleCapPct` (e.g., 150 = 1.5x face value) in addition to absolute `resaleCapCents`? Current decision: start with `resaleCapCents` only, add percentage later if organizers ask for it.

---

## Related Documents

- `docs/specs/item-level-settlements-and-resale.md` — item-level settlement tracking (implemented)
- `docs/hot-paths.md` — money flow cautions
- `docs/engineering-standards.md` — error handling patterns
- `docs/prompts/place-layout.md` — place layout architecture guide

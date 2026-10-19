# Platform Commerce Admin — Orders, Tickets & Carts

**Status:** complete
**Author:** Copilot + human
**Date:** 2026-02-16

---

## 1. Overview

Two related features:

1. **Org-level "Active Carts" tab** — surface PENDING orders (active carts) inside the existing `/admin/[slug]/orders` page so org admins can see who is mid-checkout.
2. **Platform-level commerce pages** — cross-org staff views at `/platform/orders` and `/platform/tickets` for support, ops, and debugging.

### Goals

- Let org admins see abandoned/active carts without leaving the Orders page.
- Give platform staff (ADMIN, REVIEWER, SUPPORT, DEVELOPER) full cross-org visibility into orders, tickets, carts, transfers, and scans.
- Maintain the existing RBAC model (blanket staff access for now; no per-action role splitting).

### Non-goals

- Dynamic role/permission creation (deferred; noted in roles.md).
- Meilisearch indexing for orders/tickets (see Search Strategy below).
- Financial actions from the platform view (refunds stay in the existing `staff-refund-order` flow).

---

## 2. Search Strategy: Postgres vs Meilisearch

### When to use each

| Use case | Engine | Rationale |
|---|---|---|
| Consumer-facing event/place/profile discovery | **Meilisearch** | Typo tolerance, geo ranking, faceted filters, instant autocomplete, relevance scoring. Worth the index sync cost because the UX is search-first and the dataset is public. |
| Admin/staff order & ticket lookup | **Postgres** (`contains` / `mode: insensitive`) | Closed dataset, authenticated users only, exact-match and prefix queries are the norm (order ID, email, ticket code). Volume per query is bounded by pagination. Index sync overhead not justified. |
| Future: if platform order volume makes Postgres `ILIKE` slow | **Postgres GIN/trigram index** first, Meili second | Add `pg_trgm` + GIN index on `(buyer.name, buyer.email)` before introducing a new Meili index. Keeps infra simple. |

### Current pattern (already in codebase)

The existing `orders.listForOrg` adapter uses Prisma `contains` + `mode: "insensitive"` across `buyer.name` and `authUser.email`. The platform queries will follow the same pattern but without org scoping. If performance degrades at scale, the migration path is:

1. Add a Postgres `pg_trgm` GIN index on the join columns.
2. Only if that is insufficient, add a `platform-orders` Meilisearch index with a sync job.

---

## 3. Feature A — Org-level Active Carts Tab

### 3.1 UI changes

Add a tab strip to the existing `OrdersTable` component at `/admin/[slug]/orders`:

| Tab | Filter | Description |
|---|---|---|
| **All Orders** (default) | Current behavior, no change | All statuses |
| **Active Carts** | `status: PENDING`, hold not expired | PENDING orders where at least one hold is still active |

The "Active Carts" tab shows:
- Buyer name/email
- Event name
- Cart total (gross cents)
- Ticket type breakdown (qty x type name)
- Hold expiration countdown (relative time, e.g. "expires in 12m")
- Created at

### 3.2 Backend changes

**No new use case needed.** The existing `list-org-orders` use case already accepts a `status` filter. The UI just needs to pass `status: "PENDING"` when the Active Carts tab is selected.

For hold expiration and ticket breakdown, we have two options:

**Option A (recommended):** Enrich the existing `ListOrdersForOrgItem` type to optionally include `items` (the `OrderItem[]` with ticket type names) and a computed `holdExpiresAt`. This keeps it one query.

**Option B:** Separate `getActiveCartHoldsForOrg` use case. More isolated but adds a new endpoint.

### 3.3 Hold expiration — resolved

The canonical cart hold timer is **application-level, set in `create-checkout.ts`:**

```
ORDER_HOLD_TTL_SECONDS = 900   (15 minutes)
SEAT_HOLD_TTL_SECONDS  = 900
COUPON_HOLD_TTL_SECONDS = 900
```

At checkout creation, `holdExpiresAt` is stamped into each ticket `OrderItem.meta`
as an ISO string. The `listPendingCarts` adapter reads this back to filter active
carts. A scheduled job (`release-expired-holds`) runs periodically to clean up
stale seat holds using the same 900s TTL.

Stripe Payment Intent expiry is **not** the hold timer. Stripe PIs default to an
expiry window that varies by payment method (card PIs don't truly expire; they
stay `requires_payment_method` indefinitely until canceled). Our app-level 15-min
hold is the authoritative timer — it governs seat reservation, coupon holds, and
cart recovery visibility. The PENDING order itself lives until explicitly canceled
by the cleanup job or by the buyer releasing the cart.

For the Active Carts tab, we surface `OrderItem.meta.holdExpiresAt` (the latest
across all items in the order) as the countdown value. This is already what the
consumer-facing `CartRecoveryBanner` uses.

**PI cleanup:** Neither `releaseCartHold` nor `release-expired-holds` currently
cancels the Stripe Payment Intent. This is addressed in
`place-verification-review.spec.md` section 7 — adds `cancelPaymentIntent` to
`PaymentProcessorPort` and a new `release-expired-carts` cron job.

---

## 4. Feature B — Platform Orders Page (`/platform/orders`)

### 4.1 Route

`/platform/orders` — new page in the platform area.

### 4.2 UI

A `DataTable` (reusing `@th/ui` DataTable) with:

**Columns:**
| Column | Source |
|---|---|
| Order ID | `id` (truncated, copyable) |
| Status | Badge (PENDING / SUCCEEDED / REFUNDED / etc.) |
| Buyer | Name + email |
| Event | Title (linked to event admin if applicable) |
| Org | Org name (linked to org admin) |
| Gross | Formatted currency |
| Platform Fee | Formatted currency |
| Source | PRIMARY / RESALE badge |
| Date | `occurredAt` formatted |

**Filters:**
- Free-text search (buyer name/email, order ID)
- Status multi-select
- Date range
- Source (PRIMARY / RESALE)

**Tabs:**
- **All Orders** — no status filter
- **Active Carts** — `status: PENDING`
- **Disputed** — `status: DISPUTED`

**Detail panel:** Clicking a row opens a slide-out with:
- Full order record
- Order items with ticket type names, amounts, payout status
- Buyer profile link
- Stripe payment intent link (external)
- Related tickets (linked to platform ticket view)
- Coupon redemptions
- Refund history / eligibility

### 4.3 Use case: `list-platform-orders`

**Location:** `packages/core/src/use-cases/orders/list-platform-orders.ts`

```
Input:
  actorHumanId: uuid
  searchQuery?: string (max 200)      — searches buyer name, email, order ID
  status?: OrderStatus
  statuses?: OrderStatus[]
  source?: OrderSource
  orgId?: uuid                         — optional org filter
  eventId?: uuid                       — optional event filter
  occurredAtGte?: Date
  occurredAtLte?: Date
  sort?: "occurredAt_desc" | "occurredAt_asc"
  limit?: number (default 25, max 100)
  offset?: number

Output:
  items: ListPlatformOrdersItem[]
  total: number
  limit: number
  offset: number

ListPlatformOrdersItem:
  id: uuid
  eventId: uuid
  eventTitle: string
  orgId: uuid | null
  orgName: string | null
  buyerHumanId: uuid
  buyerName: string | null
  buyerEmail: string | null
  amountGrossCents: int
  feesPlatformCents: int
  currency: string
  status: OrderStatus
  source: OrderSource
  stripePaymentIntentId: string | null
  occurredAt: Date
  itemCount: int
```

**Auth:** `authz.hasStaffRole({ actorHumanId, requiredRoles: PLATFORM_STAFF_ROLES })`

### 4.4 Repo method: `orders.listAll`

New method on `OrdersRepo`:

```typescript
listAll(input: ListAllOrdersInput): Promise<ListAllOrdersResult>;
```

Same shape as `listForOrg` but without the mandatory `orgId` scoping. Optional `orgId` filter instead. Adds `searchQuery` matching on order ID in addition to buyer name/email.

### 4.5 Use case: `get-platform-order`

**Location:** `packages/core/src/use-cases/orders/get-platform-order.ts`

For the detail panel. Returns the full `OrderRecord` with items, related tickets, coupon redemptions, splits, and settlement lines. Staff-gated.

---

## 5. Feature C — Platform Tickets Page (`/platform/tickets`)

### 5.1 Route

`/platform/tickets` — new page in the platform area.

### 5.2 UI

A `DataTable` with:

**Columns:**
| Column | Source |
|---|---|
| Ticket Code | `code` (copyable) |
| Status | Badge (VALID / SCANNED / REFUNDED / etc.) |
| Owner | Name + email of `ownerHumanId` |
| Event | Title |
| Ticket Type | Name |
| Order | Order ID (linked to platform order detail) |
| Issued At | `issuedAt` formatted |
| Scanned At | `scannedAt` formatted or "—" |

**Filters:**
- Free-text search (ticket code, owner name/email)
- Status multi-select
- Event name

**Detail panel:** Clicking a row opens a slide-out with:
- Full ticket record
- Owner profile info
- Event + ticket type details
- **Transfer history** — list of `TicketTransfer` records (from → to, reason, date)
- **Scan history** — list of `TicketScan` records (outcome, scannedBy, timestamp)
- Order link
- Seat info (if assigned)
- Resale listing (if any)

### 5.3 Use case: `list-platform-tickets`

**Location:** `packages/core/src/use-cases/tickets/list-platform-tickets.ts`

```
Input:
  actorHumanId: uuid
  searchQuery?: string (max 200)      — searches ticket code, owner name/email
  status?: TicketStatus
  statuses?: TicketStatus[]
  eventId?: uuid
  orgId?: uuid
  sort?: "issuedAt_desc" | "issuedAt_asc"
  limit?: number (default 25, max 100)
  offset?: number

Output:
  items: ListPlatformTicketsItem[]
  total: number
  limit: number
  offset: number

ListPlatformTicketsItem:
  id: uuid
  code: string
  status: TicketStatus
  eventId: uuid
  eventTitle: string
  ticketTypeId: uuid | null
  ticketTypeName: string | null
  orderId: uuid | null
  ownerHumanId: uuid
  ownerName: string | null
  ownerEmail: string | null
  issuedAt: Date
  scannedAt: Date | null
  seatLabel: string | null
  transferCount: int
  scanCount: int
```

**Auth:** Same `hasStaffRole` check.

### 5.4 Use case: `get-platform-ticket`

**Location:** `packages/core/src/use-cases/tickets/get-platform-ticket.ts`

Returns the full ticket record plus:
- Transfer history (`TicketTransfer[]` with human names)
- Scan history (`TicketScan[]` with actor name, outcome)
- Owner profile summary
- Event + ticket type details
- Order summary
- Resale listing (if any)

### 5.5 Repo additions

New methods on `TicketsRepo`:

```typescript
/** Cross-org paginated ticket search for platform staff */
listAll(input: ListAllTicketsInput): Promise<ListAllTicketsResult>;

/** Full ticket with relations for platform detail view */
getByIdWithRelations(ticketId: string): Promise<TicketDetailRecord | null>;

/** Transfer history for a ticket */
listTransfers(ticketId: string): Promise<TicketTransferRecord[]>;

/** Scan history for a ticket */
listScans(ticketId: string): Promise<TicketScanRecord[]>;
```

---

## 6. Platform Shell Consolidation

### Current state

`PlatformShell` (`/platform/_components/PlatformShell.tsx`) is a separate component that duplicates most of `AdminShell`'s logic — both ultimately render `NavigationShell` from `@th/ui`. The key differences:

| Concern | AdminShell | PlatformShell |
|---|---|---|
| Auth gate | Org ownership via `useEventOwnerEntities` | Staff role via `trpc.platform.checkStaffAccess` |
| Base path | `/admin/{slug}` | `/platform` |
| Context switching | Multiple org/personal workspaces | Single platform context |
| Email verification gate | Yes (`AdminEmailVerificationGate`) | No |
| Page transitions | Yes (`AdminPageTransition`) | No |

### Recommendation

Refactor `PlatformShell` to delegate to `NavigationShell` (which it already does) but add the missing polish from `AdminShell`:
- Add `AdminPageTransition` wrapper for consistent animations.
- Keep the staff-role gate (this is the correct auth model for platform).
- Do NOT add org ownership checks or context switching (platform is a single workspace).

This is a cosmetic alignment, not a structural merge. Both shells correctly use `NavigationShell` under the hood, so the sidebar/nav behavior is already shared.

---

## 7. Navigation Updates

### Platform layout (`/platform/layout.tsx`)

Add to `PLATFORM_SECTIONS`:

```typescript
{
  id: "orders",
  label: "Orders",
  route: "orders",
  icon: <ShoppingCart size={18} />,
},
{
  id: "tickets",
  label: "Tickets",
  route: "tickets",
  icon: <Ticket size={18} />,
},
```

### Platform overview page

Add cards for Orders and Tickets to the overview grid.

---

## 8. Roles Documentation Update

Update `docs/roles.md` to add the `HumanRole` (platform staff) section. See implementation below.

---

## 9. Implementation Order

| Phase | Layer | Work | Depends on |
|---|---|---|---|
| **1** | Docs | Update `roles.md` with HumanRole section | — |
| **2a** | Types/Ports | `ListAllOrdersInput/Result`, `ListPlatformOrdersItem` | — |
| **2b** | Types/Ports | `ListAllTicketsInput/Result`, `ListPlatformTicketsItem`, `TicketDetailRecord`, transfer/scan record types | — |
| **3a** | Adapter | `orders.listAll()` implementation | 2a |
| **3b** | Adapter | `tickets.listAll()`, `getByIdWithRelations()`, `listTransfers()`, `listScans()` | 2b |
| **4a** | Core | `list-platform-orders` use case + tests | 2a, 3a |
| **4b** | Core | `get-platform-order` use case + tests | 3a |
| **4c** | Core | `list-platform-tickets` use case + tests | 2b, 3b |
| **4d** | Core | `get-platform-ticket` use case + tests | 3b |
| **5** | Transport | Add procedures to `platformRouter` | 4a-4d |
| **6a** | UI | Org-level Active Carts tab on existing Orders page | — (uses existing endpoint) |
| **6b** | UI | `/platform/orders` page + detail panel | 5 |
| **6c** | UI | `/platform/tickets` page + detail panel | 5 |
| **7** | UI | Platform nav + overview updates | 6b, 6c |
| **8** | UI | PlatformShell polish (page transitions) | — |

---

## 10. Testing Plan

| Scope | What to test |
|---|---|
| `list-platform-orders` | Staff gate (allowed/denied), pagination, status filter, search by buyer name/email/order ID, org filter, date range, sort |
| `get-platform-order` | Staff gate, returns items + tickets + splits, not-found case |
| `list-platform-tickets` | Staff gate, pagination, search by code/owner, status filter, transfer/scan counts |
| `get-platform-ticket` | Staff gate, returns transfer + scan history, not-found case |
| Org Active Carts tab | Tab switching, PENDING filter applied, hold expiry display |
| Platform Orders UI | Table renders, filters work, detail panel opens, Stripe link |
| Platform Tickets UI | Table renders, search by code works, detail panel shows history |

---

## 11. Open Items

- **Reviewer role definition:** The REVIEWER `HumanRole` currently only gates place verification. Its scope for order/ticket access is included in blanket staff access for now but should be revisited when the role's responsibilities are better defined. Place/business verification may eventually integrate with a third-party KYB service (Middesk, Persona, etc.) rather than manual review.
- **Dynamic role/permission system:** Noted as a future consideration. Current code-level role definitions work at our scale but won't scale to customer-defined roles.
- **Hold expiration source:** Need to confirm the canonical source for "cart hold expiry" — is it Stripe PI expiry, `CouponHold.expiresAt`, or an application-level timer?
- **PII masking:** Platform ticket/order views expose buyer email and name. Confirm this is acceptable for all staff roles or if we need per-field masking for REVIEWER/DEVELOPER.

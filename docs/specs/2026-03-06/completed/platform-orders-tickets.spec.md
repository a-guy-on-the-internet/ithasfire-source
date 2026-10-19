# Spec: Platform Orders & Tickets Views + Org-level Active Carts

## Meta

| Field        | Value                           |
| ------------ | ------------------------------- |
| Owner        | platform                        |
| Status       | complete                           |
| Last updated | 2026-02-16                      |
| Reviewers    | product, engineering, support   |
| Depends on   | `roles.md` HumanRole additions  |

## Summary

Add three capabilities:

1. **Org-level "Active Carts" tab** on the existing `/admin/[slug]/orders` page — shows PENDING orders with live hold timers so org admins can see who is mid-checkout.
2. **Platform `/platform/orders`** — cross-org, staff-only paginated order list with search, filters, and detail drill-down. Includes an "Active Carts" tab mirroring the org-level one but across all orgs.
3. **Platform `/platform/tickets`** — cross-org, staff-only ticket lookup by code, buyer, event, or status. Includes transfer history, scan history, and all relevant relations.

All platform views are gated by `HumanRole` staff access (blanket: ADMIN, REVIEWER, SUPPORT, DEVELOPER) using the existing `hasStaffRole` mechanism.

## Goals

- Let org admins see real-time shopping activity (carts) alongside completed orders.
- Give platform support staff a single pane to find any order or ticket across the system without switching org contexts.
- Provide full ticket lifecycle visibility (issuance, scans, transfers, refunds) for support triage.

## Non-goals

- Staff-initiated refunds from these views (already exists via `staff-refund-order` — link to it, don't rebuild).
- Meilisearch indexing for orders/tickets (see Search Strategy below).
- Cart abandonment notifications or recovery nudges (separate feature).
- PII export/download from these views (future spec, requires watermarking per super-admin-control-room.spec).

---

## Search strategy: Postgres vs Meilisearch

**Decision: Start with Postgres `ILIKE` / trigram search for both platform views.**

Rationale:

| Factor                         | Meilisearch                        | Postgres ILIKE + trigram           |
| ------------------------------ | ---------------------------------- | ---------------------------------- |
| Setup cost                     | New index, sync pipeline, schema   | Zero — query existing tables       |
| Data freshness                 | Eventual (sync lag)                | Real-time                          |
| Query volume                   | Low (staff-only, ~10s of users)    | Easily handled                     |
| Typo tolerance / fuzzy         | Excellent                          | Adequate with `pg_trgm`            |
| Faceted filtering              | Built-in                           | WHERE clauses (fine for this)      |
| Operational burden             | Another index to maintain          | None                               |

For a staff-only support tool with low concurrency, Postgres is the right call. The existing `listForOrg` already does `ILIKE` search on buyer name/email and it works fine at org scale. The platform-level queries will hit more rows but can rely on indexed columns (`status`, `eventId`, `occurredAt`) plus `ILIKE` on joined `Human.name` / `AuthUser.email`.

**Upgrade path:** If query latency becomes noticeable (>500ms p95) or we want typo-tolerant search, we can add a `platform_orders` Meilisearch index later. The use-case layer already supports an optional search port pattern (see `search-published-events.ts`).

For ticket lookup by code, a direct `WHERE code = $1` on the unique index is instant — no search engine needed.

---

## Part 1: Org-level Active Carts tab

### What changes

**File: `apps/web/src/app/admin/[slug]/orders/_components/OrdersTable.tsx`**

Add a view toggle above the existing filter bar:

```
[All Orders] [Active Carts]
```

- **All Orders** — current behavior, unchanged.
- **Active Carts** — filters to `status: PENDING` and adds columns for hold expiration and cart item breakdown.

### Data requirements

The existing `listOrgOrders` use case already supports `status: "PENDING"` filtering. We need to extend it (or the underlying repo query) to include:

- `holdExpiresAt` — the soonest-expiring hold time across the order's items (derived from coupon holds or a future hold-tracking field).
- `cartItemSummary` — array of `{ ticketTypeName, qty, unitPriceCents }` for each order item.

### New types (in `@th/types/repos/orders`)

```ts
export interface ListOrdersForOrgItem {
  // ... existing fields ...
  // Add:
  holdExpiresAt: Date | null;       // only populated for PENDING orders
  itemSummary: Array<{
    ticketTypeName: string;
    qty: number;
    unitPriceCents: number;
  }> | null;                         // only populated when requested
}
```

### UI behavior

- Active Carts tab auto-sets `status=PENDING` and hides the status filter chips.
- Shows a countdown or relative time for `holdExpiresAt` (e.g. "Expires in 4m 23s" or "Expired").
- Expired carts (holdExpiresAt < now) shown greyed out with "Expired" badge.
- Cart item summary shown inline or in an expandable row.
- Refresh interval: 30s auto-refetch when Active Carts tab is selected (carts are ephemeral).

### Layer changes

| Layer      | Change                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Types      | Add `holdExpiresAt`, `itemSummary` to `ListOrdersForOrgItem`             |
| Adapter    | Extend `listForOrg` Prisma query to LEFT JOIN holds + aggregate items     |
| Port       | No interface change (fields are optional/nullable)                        |
| Use case   | `list-org-orders`: pass-through, no new logic                             |
| Transport  | Update output schema to include new fields                                |
| UI         | Tab toggle, countdown timer, cart summary column                          |

---

## Part 2: Platform Orders page (`/platform/orders`)

### Route

`/platform/orders` — new page in the platform area.

### Navigation

Add to `PLATFORM_SECTIONS` in `apps/web/src/app/platform/layout.tsx`:

```ts
{
  id: "orders",
  label: "Orders",
  route: "orders",
  icon: <ShoppingCart size={18} />,
},
```

### Tabs

```
[All Orders] [Active Carts]
```

Same tab pattern as org-level, but cross-org.

### Features

- **Paginated DataTable** with columns: Date, Buyer (name + email), Event, Org, Amount, Platform Fee, Status, Source (PRIMARY/RESALE).
- **Search** by buyer name, buyer email, order ID, or Stripe payment intent ID.
- **Filters**: status (multi-select), date range, org (typeahead), event (typeahead).
- **Sort**: by `occurredAt` asc/desc.
- **Detail panel**: expandable row showing order items, ticket types, quantities, Stripe link, refund eligibility, link to `staff-refund-order`.
- **Active Carts tab**: same as org-level but cross-org. Shows all PENDING orders with hold timers.

### New use case: `list-platform-orders`

**Location:** `packages/core/src/use-cases/orders/list-platform-orders.ts`

```ts
// Input
{
  actorHumanId: string;          // staff user
  searchQuery?: string;          // buyer name, email, order ID, or PI ID
  status?: OrderStatus;
  statuses?: OrderStatus[];
  orgId?: string;                // optional org filter
  eventId?: string;              // optional event filter
  occurredAtGte?: Date;
  occurredAtLte?: Date;
  sort?: "occurredAt_desc" | "occurredAt_asc";
  limit?: number;                // default 25, max 100
  offset?: number;
}

// Output — offset-paginated
{
  items: Array<{
    id: string;
    eventId: string;
    eventTitle: string;
    orgId: string | null;
    orgName: string | null;
    buyerHumanId: string;
    buyerName: string | null;
    buyerEmail: string | null;
    amountGrossCents: number;
    feesPlatformCents: number;
    currency: string;
    status: OrderStatus;
    source: OrderSource;
    stripePaymentIntentId: string | null;
    occurredAt: Date;
    holdExpiresAt: Date | null;
    itemSummary: Array<{
      ticketTypeName: string;
      qty: number;
      unitPriceCents: number;
    }> | null;
  }>;
  pageInfo: { total, limit, offset, hasMore };
}
```

**Auth:** `hasStaffRole({ actorHumanId, requiredRoles: PLATFORM_STAFF_ROLES })`. Throws `forbidden` if not staff.

### New repo method: `orders.listAll`

```ts
listAll(input: ListAllOrdersInput): Promise<ListAllOrdersResult>;
```

Cross-org query. Joins `Event` (for title), `Organization` (for name), `Human`/`AuthUser` (for buyer info). Supports the same filter/sort/search interface as `listForOrg` but without org scoping.

### Layer changes

| Layer      | Change                                                              |
| ---------- | ------------------------------------------------------------------- |
| Types      | `ListAllOrdersInput`, `ListAllOrdersItem`, `ListAllOrdersResult`   |
| Port       | Add `listAll` to `OrdersRepo`                                      |
| Adapter    | Implement `listAll` in Prisma orders adapter                        |
| Use case   | `list-platform-orders` (staff-gated)                                |
| Transport  | Add `platform.listOrders` to `platformRouter`                       |
| UI         | `/platform/orders/page.tsx` with DataTable + tabs                   |

---

## Part 3: Platform Tickets page (`/platform/tickets`)

### Route

`/platform/tickets` — new page in the platform area.

### Navigation

Add to `PLATFORM_SECTIONS` in `apps/web/src/app/platform/layout.tsx`:

```ts
{
  id: "tickets",
  label: "Tickets",
  route: "tickets",
  icon: <Ticket size={18} />,  // from lucide-react
},
```

### Features

- **Search**: by ticket code (exact match, fast), buyer name/email (ILIKE), event name, or ticket ID.
- **Filters**: status (VALID, SCANNED, INVALID, REFUNDED, LISTED), event (typeahead), date range (issuedAt).
- **Paginated DataTable** with columns: Code, Status, Event, Ticket Type, Owner (name + email), Order ID, Issued At.
- **Detail panel** (expandable or side panel): full ticket record plus:
  - **Scan history** — list of `TicketScan` records: timestamp, outcome (ACCEPTED/REJECTED), scanner actor, location.
  - **Transfer history** — list of `TicketTransfer` records: from → to, reason, timestamp, linked order.
  - **Order link** — click-through to the order detail (in platform orders page or Stripe).
  - **Event link** — event name + date.
  - **Ticket type** — name, price, capacity, resale/transfer settings.
  - **Seat** — if assigned, seat label/section.
  - **Resale listing** — if LISTED, link to resale listing record.

### New use case: `list-platform-tickets`

**Location:** `packages/core/src/use-cases/tickets/list-platform-tickets.ts`

(Create `packages/core/src/use-cases/tickets/` directory if it doesn't exist.)

```ts
// Input
{
  actorHumanId: string;
  searchQuery?: string;          // ticket code, buyer name/email, event name
  code?: string;                 // exact code lookup (fast path)
  status?: TicketStatus;
  statuses?: TicketStatus[];
  eventId?: string;
  issuedAtGte?: Date;
  issuedAtLte?: Date;
  sort?: "issuedAt_desc" | "issuedAt_asc";
  limit?: number;                // default 25, max 100
  offset?: number;
}

// Output — offset-paginated
{
  items: Array<{
    id: string;
    code: string;
    status: TicketStatus;
    eventId: string;
    eventTitle: string;
    eventStartsAt: Date | null;
    ticketTypeId: string | null;
    ticketTypeName: string | null;
    ownerHumanId: string;
    ownerName: string | null;
    ownerEmail: string | null;
    orderId: string | null;
    seatLabel: string | null;
    issuedAt: Date;
    scannedAt: Date | null;
  }>;
  pageInfo: { total, limit, offset, hasMore };
}
```

### New use case: `get-platform-ticket-detail`

**Location:** `packages/core/src/use-cases/tickets/get-platform-ticket-detail.ts`

```ts
// Input
{
  actorHumanId: string;
  ticketId: string;              // or ticketCode for code-based lookup
}

// Output
{
  ticket: {
    id: string;
    code: string;
    status: TicketStatus;
    issuedAt: Date;
    scannedAt: Date | null;
    // Event
    eventId: string;
    eventTitle: string;
    eventStartsAt: Date | null;
    eventEndsAt: Date | null;
    // Ticket type
    ticketTypeId: string | null;
    ticketTypeName: string | null;
    ticketTypePriceCents: number | null;
    resaleAllowed: boolean;
    transferAllowed: boolean;
    // Owner
    ownerHumanId: string;
    ownerName: string | null;
    ownerEmail: string | null;
    // Order
    orderId: string | null;
    orderStatus: OrderStatus | null;
    orderAmountCents: number | null;
    // Seat
    seatLabel: string | null;
    seatSection: string | null;
    // Resale
    resaleListingId: string | null;
    resaleListingStatus: string | null;
  };
  scanHistory: Array<{
    id: string;
    outcome: TicketScanOutcome;    // ACCEPTED | REJECTED
    scannedAt: Date;
    actorHumanId: string;
    actorName: string | null;
    rejectionReason: string | null;
  }>;
  transferHistory: Array<{
    id: string;
    fromHumanId: string;
    fromName: string | null;
    toHumanId: string;
    toName: string | null;
    reason: "primary" | "resale" | "gift" | "admin";
    orderId: string | null;
    transferredAt: Date;
  }>;
}
```

### New repo methods

On `TicketsRepo`:

```ts
/** Cross-org paginated ticket search for platform staff. */
listAll(input: ListAllTicketsInput): Promise<ListAllTicketsResult>;

/** Full ticket detail with scan + transfer history. */
getDetailById(ticketId: string): Promise<TicketDetailRecord | null>;

/** Full ticket detail by code. */
getDetailByCode(code: string): Promise<TicketDetailRecord | null>;
```

### Layer changes

| Layer      | Change                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Types      | `ListAllTicketsInput/Item/Result`, `TicketDetailRecord`                |
| Port       | Add `listAll`, `getDetailById`, `getDetailByCode` to `TicketsRepo`    |
| Adapter    | Implement in Prisma tickets adapter with joins                         |
| Use cases  | `list-platform-tickets`, `get-platform-ticket-detail` (staff-gated)   |
| Transport  | Add `platform.listTickets`, `platform.getTicketDetail`                 |
| UI         | `/platform/tickets/page.tsx` with DataTable + detail panel             |

---

## Part 4: Platform Shell alignment

### Current state

`PlatformShell` is a separate component from `AdminShell`. Both wrap `NavigationShell` from `@th/ui` but `PlatformShell`:
- Has its own staff access gate (`trpc.platform.checkStaffAccess`)
- Uses a hardcoded `PLATFORM_CONTEXT` instead of derived owner entities
- Skips `AdminEmailVerificationGate`
- Skips workspace switching (no `availableContexts`)
- Has its own loading/access-denied states with raw inline styles

### Recommendation

**Do not merge them into a single component yet.** The auth models are fundamentally different:

- `AdminShell` gates on org membership (Better Auth organizations → `OrgRole`).
- `PlatformShell` gates on `HumanRole` staff roles (site-wide).

However, `PlatformShell` should be improved to:
1. Use `@th/ui` components for loading/error states instead of raw `<div>`s with inline styles.
2. Support an `environmentBadge` prop (already partially there with `"staging"` hardcoded — make it dynamic from env).
3. Share the brand element pattern (already does).

This is a cleanup task, not a blocker for the orders/tickets feature.

---

## Implementation order

1. **Types + Ports** — add new input/output types and repo method signatures.
2. **Adapter** — implement `orders.listAll` and `tickets.listAll` / `getDetailById` / `getDetailByCode`.
3. **Use cases** — `list-platform-orders`, `list-platform-tickets`, `get-platform-ticket-detail`. Extend `list-org-orders` output with `holdExpiresAt` + `itemSummary`.
4. **Transport** — wire into `platformRouter`.
5. **UI — org carts tab** — add Active Carts tab to existing OrdersTable.
6. **UI — platform orders** — new page at `/platform/orders`.
7. **UI — platform tickets** — new page at `/platform/tickets`.
8. **Docs** — update `roles.md` with HumanRole section (can land independently).

### Testing expectations

| Scope                      | Test approach                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| `list-platform-orders`     | Unit test: staff gate, pagination, filter combos                 |
| `list-platform-tickets`    | Unit test: staff gate, code lookup fast path, pagination         |
| `get-platform-ticket-detail` | Unit test: staff gate, scan/transfer history assembly          |
| Adapter `listAll` methods  | Integration test against local Postgres                          |
| Org carts tab              | Verify PENDING filter + holdExpiresAt display                    |
| Platform UI pages          | Manual smoke test (staff access gate, data loads, filters work)  |

---

## Open items for future

- **Meilisearch upgrade**: if Postgres search latency degrades, add `platform_orders` and `platform_tickets` indices. The use-case layer already has the optional-search-port pattern to follow.
- **PII watermarking**: before enabling PII exports (CSV download of orders/tickets with buyer info), implement the watermark + audit trail from `super-admin-control-room.spec`.
- **Dynamic role-based column visibility**: e.g. REVIEWER sees fewer PII columns than SUPPORT. Deferred until we have real role differentiation beyond blanket access.
- **REVIEWER role definition**: the Reviewer role needs a clearer charter — what exactly are they reviewing? Place verification is the only current use. Consider whether third-party verification services could automate parts of this (utility bill verification, business registration lookup). Spec separately.

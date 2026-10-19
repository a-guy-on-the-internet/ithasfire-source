# Comp Ticket Issuance Spec

> **Status**: complete
> **Created**: 2026-06-26
> **Authors**: Engineering Team

## Overview

Allow event admins to issue **complimentary (free) tickets** directly to people by email, without requiring the admin to own the ticket first. This is distinct from the existing ticket *transfer* system, which moves an already-purchased ticket from one human to another.

### Current state

The platform already supports:

- **Ticket transfers** (`TicketTransfer` model) with reasons: `"primary"`, `"resale"`, `"gift"`, `"admin"`. These require an existing ticket owned by the sender.
- **Email-based pending transfers** (`PendingTicketTransfer` model) — token-based claiming for sending tickets to people who don't have an account yet.
- **Order sources**: `DIRECT`, `RESALE`. No `COMP` source exists.

**What's missing**: An admin flow to *create* tickets (bypassing checkout/payment) and issue them to recipients by email.

### Design principles

- **Audit trail** — every comp ticket is logged with the issuing admin, reason, and timestamp.
- **No money involved** — comp tickets have `$0` price, no Stripe charges, no settlement splits. But they do consume inventory (reduce available count on the ticket type).
- **Inventory-aware** — comp issuance respects ticket type capacity. Admins see remaining inventory and are warned (but not blocked) if issuing would exceed capacity.
- **Recipient flexibility** — recipients can be existing users (by email lookup) or non-users (shadow profile created via `ensureGuestHuman`, pending claim via email link).

---

## Schema changes

### New enum value

```prisma
// Extend OrderSource enum
enum OrderSource {
  DIRECT
  RESALE
  COMP       // ← NEW
}
```

### New model

```prisma
// comp.prisma (or add to ticket.prisma)

/// Record of a complimentary ticket issuance by an admin.
model CompTicketIssuance {
  id              String   @id @default(uuid())
  eventId         String
  ticketTypeId    String
  quantity        Int      @default(1)

  /// Recipient info
  recipientEmail  String
  recipientName   String?
  recipientHumanId String?         // Resolved via ensureGuestHuman

  /// Issuer info
  issuedByHumanId String
  reason          String?          // Admin-provided reason ("VIP guest", "sponsor", etc.)

  /// Resulting records
  orderId         String?  @unique // The $0 Order created for the recipient
  status          CompIssuanceStatus @default(PENDING)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  event      Event     @relation(fields: [eventId], references: [id], onDelete: Cascade)
  ticketType TicketType @relation(fields: [ticketTypeId], references: [id], onDelete: Cascade)
  issuedBy   Human     @relation("CompTicketIssuedBy", fields: [issuedByHumanId], references: [id], onDelete: Cascade)
  recipient  Human?    @relation("CompTicketRecipient", fields: [recipientHumanId], references: [id], onDelete: SetNull)
  order      Order?    @relation("CompTicketOrder", fields: [orderId], references: [id], onDelete: SetNull)

  @@index([eventId])
  @@index([issuedByHumanId])
  @@index([recipientHumanId])
  @@index([recipientEmail])
}

enum CompIssuanceStatus {
  PENDING     // Created, email sent, awaiting claim
  CLAIMED     // Recipient claimed (account created/linked, order generated)
  EXPIRED     // Claim window expired
  REVOKED     // Admin revoked before claim
}
```

### Extend `Order`

Comp orders use the existing `Order` model with `source = COMP` and `totalCents = 0`. No new fields needed on `Order` itself, but the `CompTicketIssuance` links back to the order via `orderId`.

---

## Use cases

### 1. `issue-comp-tickets`

**Purpose**: Admin creates comp tickets for a recipient.

**Input**:
```typescript
{
  eventId: string;
  ticketTypeId: string;
  quantity: number;          // Usually 1, but bulk is allowed
  recipientEmail: string;
  recipientName?: string;
  reason?: string;           // Admin note
}
```

**Flow**:
1. Auth: `ensureOrgRole(ADMIN | OWNER)` on the event's org.
2. Validate event exists and is not cancelled/archived.
3. Validate ticket type exists, belongs to the event, and has `quantity` available (warn if exceeding, but allow).
4. Resolve recipient: `ensureGuestHuman({ email: recipientEmail, name: recipientName })`.
5. Create `CompTicketIssuance` record with status = `PENDING`.
6. **If recipient already has a full account** (not just shadow): immediately create the `$0 Order` + `OrderItem` + `Ticket` records, set status = `CLAIMED`.
7. **If recipient is a shadow/new user**: send a "You've been gifted tickets" email with a claim link. Status stays `PENDING`.
8. Audit log the action within the transaction.
9. Return the issuance record.

**Errors**: `event_not_found`, `ticket_type_not_found`, `insufficient_inventory` (warning, not blocking), `invalid_input`.

### 2. `claim-comp-tickets`

**Purpose**: Recipient with a shadow profile completes account creation and claims their comp tickets.

**Flow**:
1. Triggered after the recipient completes registration / signs in (the `ensureAuthedHuman` flow links their shadow `Human`).
2. Look up any `CompTicketIssuance` records with `recipientEmail` matching the new user's email and status = `PENDING`.
3. For each: create the `$0 Order` + `OrderItem` + `Ticket` records, set status = `CLAIMED`.
4. Send "Your tickets are ready" confirmation email.

This can be a post-auth hook or a background job triggered by account creation.

### 3. `revoke-comp-tickets`

**Purpose**: Admin revokes a comp issuance before it's claimed.

**Flow**:
1. Validate issuance exists and status = `PENDING`.
2. Set status = `REVOKED`.
3. If an order was already created (for existing users), this is more complex — treat like a cancellation. (Deferred: for V1, only allow revocation of unclaimed issuances.)

### 4. `list-comp-issuances`

**Purpose**: Admin views all comp ticket issuances for an event.

**Input**: `{ eventId, status?, recipientEmail? }`

Returns paginated list with recipient info, ticket type, quantity, status, issuer, reason.

---

## Transport (tRPC)

```
compRouter
  ├── issue         (mutation, org-authed)
  ├── revoke        (mutation, org-authed)
  ├── list          (query, org-authed — paginated, filterable)
  └── getByEmail    (query, org-authed — lookup by recipient email)
```

---

## Admin UI

### Event-level comp ticket page

New tab/section within the event admin detail at `apps/web/src/app/admin/[slug]/events/[id]/comp-tickets/`.

**Content**:
- "Issue Comp Tickets" form: ticket type dropdown, quantity, recipient email, recipient name, reason textarea.
- Table of past issuances with status badges, revoke action for pending ones.
- Inventory indicator showing remaining capacity per ticket type.

This is a sub-page of the event detail (like Applications, Volunteers), not a top-level `ADMIN_SECTIONS` entry.

---

## Relationship to existing transfer system

| Aspect | Ticket Transfer | Comp Issuance |
| --- | --- | --- |
| Requires existing ticket | Yes | No (creates new tickets) |
| Payment | None (already paid) | None ($0 order) |
| Inventory impact | None (ticket already allocated) | Yes (consumes inventory) |
| Admin-only | No (any ticket owner) | Yes |
| Audit trail | `TicketTransfer` record | `CompTicketIssuance` record |
| Non-user recipients | `PendingTicketTransfer` (token) | `ensureGuestHuman` + claim flow |

---

## Open questions

- **Bulk issuance**: Allow CSV upload for bulk comp tickets (e.g., 50 VIP passes for sponsors)? Deferred to V2 — can reuse the `ContactImport` infrastructure.
- **Comp ticket visibility**: Should comp tickets be visually distinct in the admin order list? A badge or filter by `source = COMP` seems sufficient.
- **Expiration**: Should unclaimed comp issuances expire? If so, after how long? Suggest 30 days with a configurable default.
- **Volunteer comp tie-in**: Should approved volunteers automatically receive comp tickets? This could be a simple trigger in `review-volunteer-signup` that calls `issue-comp-tickets` internally. Defer to the volunteering spec.

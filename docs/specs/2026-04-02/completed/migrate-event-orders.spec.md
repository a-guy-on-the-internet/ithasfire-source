# Migrate Event Orders

> **Status**: complete
> **Created**: 2026-04-01
> **Related**: `reconcile-series-schedule.spec.md`, `cancel-event.ts` (existing use case)

## Summary

Allow an admin to **move all orders (and their tickets) from one event to another** within the same org. This is the primary tool for handling schedule changes in recurring series — instead of refunding buyers when an occurrence is removed, the organizer migrates tickets to the replacement date. Buyers who don't want the new date request a refund themselves through the existing self-serve refund flow.

## Motivation

When an organizer edits a recurring series schedule, `reconcileSeriesSchedule` detaches orphaned occurrences that have ticket sales. Today the detached event just sits there — the organizer has no in-product way to move those orders to the next occurrence. The only option is manual cancellation + refund, which:

- Burns Stripe processing fees on every refund.
- Creates a bad buyer experience (refund + re-purchase).
- Requires the organizer to email buyers manually.

A migration use case eliminates all three problems. The organizer points the old event's orders at the new event, buyers get a notification ("your show moved to May 12"), and nobody loses money.

## Non-goals

- **Automated refunds.** This use case does not refund anything. If a buyer doesn't want the new date, they use the existing buyer-initiated or admin-initiated refund flow.
- **Cross-owner migration.** Source and target events must belong to the same owner (same org, or same human).
- **Partial migration.** V1 moves *all* orders for the source event. Per-order cherry-picking is future work.
- **Price reconciliation.** If ticket prices differ between source and target events, V1 does not charge or credit the difference. The order retains its original financials. Price-delta handling is future work.
- **Seat reassignment.** If the target event has assigned seating, migrated tickets get GA admission. Seat-to-seat mapping is future work.

## Invariants

1. **Same owner.** Source and target events must share the same owner — either the same `orgId` (org events) or the same `humanId` (human-owned events).
2. **Target must be active.** Target event status must be `DRAFT` or `PUBLISHED` (not `CANCELLED`, `ARCHIVED`, etc.).
3. **Source must have orders.** At least one `SUCCEEDED` or `PROCESSING` order on the source event.
4. **No double-migration.** Idempotent — re-running with the same `clientKey` replays the stored result.
5. **Ticket capacity.** The target event must have enough remaining capacity to absorb the migrated tickets. If `ticketType` matching is possible (same name + price), map to the matching type. Otherwise fall back to the first available GA type. If no capacity, reject with `insufficient_capacity`.
6. **RBAC.** For org events: actor must hold `ADMIN` or `OWNER` role on the org. For human-owned events: actor must be the event owner.

## Inputs

```typescript
migrateEventOrdersInputSchema = z.object({
  actorHumanId: z.uuid(),
  sourceEventId: z.uuid(),
  targetEventId: z.uuid(),
  clientKey: z.string().min(8),
});
```

## Outputs

```typescript
migrateEventOrdersOutputSchema = z.object({
  migratedOrderCount: z.number().int().nonnegative(),
  migratedTicketCount: z.number().int().nonnegative(),
  sourceEventId: z.uuid(),
  targetEventId: z.uuid(),
});
```

## Algorithm

```text
1. Parse + validate input.
2. Idempotency check (key: `migrate-orders:${sourceEventId}:${targetEventId}:${clientKey}`).
3. Load source event and target event.
   - Verify same orgId.
   - Verify target event is active/published.
4. RBAC: ensureOrgRole(actorHumanId, orgId, ADMIN_ROLES).
5. Load all SUCCEEDED + PROCESSING orders for sourceEventId.
   - If none → throw not_found("no_orders_to_migrate").
6. Load all tickets for sourceEventId that belong to those orders.
7. Capacity check:
   - Count migrated tickets by ticketType.
   - For each type, try to match a ticketType on the target event (by name).
   - Sum required capacity, compare against target availability.
   - If insufficient → throw conflict("insufficient_capacity").
8. Begin transaction (repos.tx):
   a. For each order:
      - Update order.eventId → targetEventId.
   b. For each ticket:
      - Update ticket.eventId → targetEventId.
      - If ticket.ticketTypeId matched a target type, update it.
      - Regenerate ticket.code (new QR) to prevent stale scans.
   c. Record a TicketTransfer for each ticket:
      - reason: "admin"
      - fromHumanId / toHumanId: same owner (migration, not ownership change)
   d. Audit log:
      - entity: "event", entityId: sourceEventId, action: "orders_migrated"
      - data: { targetEventId, orderCount, ticketCount, actorHumanId }
   e. If sourceEvent has no remaining orders, optionally mark it CANCELLED
      (or leave that to the admin — TBD).
9. Commit idempotency record.
10. Return output.
```

## Side effects

| Layer | Effect |
| --- | --- |
| DB: `orders` | `eventId` updated from source → target |
| DB: `tickets` | `eventId`, `ticketTypeId`, `code` updated |
| DB: `ticket_transfers` | Migration audit trail (reason: `"admin"`) |
| DB: `audit_logs` | `orders_migrated` entry |
| Notifications (post-tx) | Email/push to each affected buyer: "Your event has moved to {targetEvent.title} on {targetEvent.startsAt}" |

## Concurrency / Idempotency

- **Key**: `migrate-orders:${sourceEventId}:${targetEventId}:${clientKey}`
- **TTL**: 300s
- **Behavior**: Replay stored result on duplicate. Reject if same key but different payload hash.

## Error codes

| Code | When |
| --- | --- |
| `invalid_input` (422) | Missing/malformed fields |
| `forbidden` (403) | Actor lacks ADMIN role on the org |
| `not_found` (404) | Source or target event doesn't exist, or no orders to migrate |
| `conflict` (409) | Events belong to different orgs, target not active, insufficient capacity, idempotency key conflict |
| `transient` (503) | Idempotency lock in progress |

## Port changes

### OrdersRepo

```typescript
/** Bulk-update eventId for all orders matching a source event. */
bulkMigrateToEvent(input: {
  sourceEventId: string;
  targetEventId: string;
  statuses: OrderStatus[];
}): Promise<{ updatedCount: number }>;
```

### TicketsRepo

```typescript
/** Bulk-update eventId (and optionally ticketTypeId) for tickets on a source event. */
bulkMigrateToEvent(input: {
  sourceEventId: string;
  targetEventId: string;
  ticketTypeMapping: Record<string, string>; // old typeId → new typeId
  regenerateCodes: boolean;
}): Promise<{ updatedCount: number }>;
```

## UI integration

### Not part of the reconcile flow

The reconcile confirmation dialog (`pendingConfirmation` in `reconcileSeriesSchedule`) only informs the organizer that certain events have sales and will be **detached** — disconnected from the series as standalone events. The reconcile flow does not prompt for migrate/refund decisions.

Migration and refund are **separate, post-detach actions** the organizer takes on their own time from the event's admin page.

### Admin event detail page

On the event detail page (`/admin/[slug]/events/[eventId]`), the actions menu gains two options (available whenever the event has orders):

1. **"Move Orders to Another Event"**
   - Opens an event picker scoped to the same org.
   - Shows target event name, date, and remaining capacity.
   - On confirm → calls `migrateEventOrders`.
   - On success → toast: "N orders moved to {target event}. Buyers have been notified."

2. **"Cancel & Refund All Orders"**
   - Existing `cancelEvent` flow. No new work needed.

These actions are useful beyond series detachment:

- Venue changes (move all orders from old-venue event to new-venue event)
- Date conflicts discovered after sales open
- Merging duplicate events

## Notifications

After a successful migration, enqueue a notification for each affected buyer:

```text
Subject: "Your event has been rescheduled"
Body: "{sourceEvent.title} on {sourceEvent.startsAt} has been moved to
       {targetEvent.title} on {targetEvent.startsAt}.
       Your tickets have been automatically transferred.
       If you can no longer attend, you can request a refund from your order page."
```

Channel: email (required) + push (if enabled).

## Relationship to deferred-capture spec

This use case **replaces** the cancel+refund path that the deferred-capture spec was designed to optimize. With migration as the primary tool:

- Organizer changes schedule → tickets migrate → no refunds needed.
- Buyers who can't attend the new date → self-serve refund (existing flow).
- Deferred capture becomes a nice-to-have optimization for the minority of cases where refunds do happen, not a critical path.

The `deferredOrderCount` field in `reconcileSeriesSchedule` output can be removed or repurposed — it was a placeholder for a flow that's no longer the primary strategy.

## Migration plan

1. Add `bulkMigrateToEvent` to `OrdersRepo` port + Prisma adapter.
2. Add `bulkMigrateToEvent` to `TicketsRepo` port + Prisma adapter.
3. Implement `migrateEventOrders` use case in `packages/core/src/use-cases/orders/`.
4. Add tRPC procedure in transport layer.
5. Add "Move Orders to Another Event" action on admin event detail page.
6. Add buyer notification templates (email + push).
7. Tests: happy path, cross-org rejection, capacity overflow, idempotency replay, empty source.

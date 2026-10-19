# Reconcile Series Schedule

> **Status:** complete
> **Author:** Copilot + human
> **Created:** 2026-04-01
> **Depends on:** `event-series.md` (series model, expand, update, generate, resync)
> **Related:** `migrate-event-orders.spec.md` (move tickets to replacement event after detach)

## Problem

When an organizer changes a series schedule (e.g. "every Friday" becomes "every Saturday", or the `until` date shrinks), two things go wrong today:

1. **Stale occurrences persist.** `expandSeries` is purely additive — it inserts new `PLANNED` rows that match the updated RRULE but never removes occurrences that no longer match. The organizer sees ghost dates that shouldn't exist.
2. **No guidance for sold events.** If a now-orphaned occurrence has a `GENERATED` or `PUBLISHED` event with ticket sales, there is no mechanism to notify the organizer, release deferred holds, or issue refunds.

The gap is a **reconciliation step** between the old set of occurrence timestamps and the new set implied by the updated RRULE/FIXED_DATES schedule.

## Goals

- After a schedule change, the set of future `PLANNED` occurrences matches the new schedule exactly — no leftover ghosts, no missing slots.
- `GENERATED` (DRAFT, no sales) occurrences that no longer match are cleaned up or detached with organizer awareness.
- `PUBLISHED` or sold occurrences are never silently deleted. The organizer must explicitly confirm cancellation/refund actions.
- The reconciliation is idempotent, transactional, and audited.
- The UI surfaces a clear confirmation dialog when the change affects events with ticket sales.

## Non-goals (future work)

- **Ticket migration** — a generic `moveOrdersToEvent` use case for moving orders between events. Not series-specific; useful for venue changes, date conflicts, rebooking. Tracked separately.
- **Per-occurrence time shifts** (e.g. "move all remaining Fridays to Saturdays, keeping ticket assignments"). Complex; requires a dedicated use case.
- **Template re-sync on schedule change.** `resyncDraftFromSeries` already exists; this spec does not change its behavior.
- **Series detail admin page** — a dedicated `/admin/[slug]/series/[seriesId]` timeline view. Separate UI spec.

---

## Industry patterns

| Platform | Model | Notes |
| --- | --- | --- |
| Google Calendar / Apple Calendar | "This event / This and following / All events" split | RFC 5545 EXDATE/RDATE. No money involved. |
| Eventbrite / DICE | Freeze published, expand forward | Published events with sales are individually editable only. Orphaned occurrences shown to organizer for archival. |
| Stripe Subscriptions | Prorate and migrate at next boundary | Schedule changes take effect at next billing cycle. In-flight items are prorated. |

Our model is closest to **Eventbrite's "freeze published, expand forward"** with the addition of **Stripe-style financial awareness** for deferred-capture holds.

---

## Domain model changes

### New occurrence status: `DETACHED`

Add `DETACHED` to the `OccurrenceStatus` enum:

```text
PLANNED | SKIPPED | GENERATED | PUBLISHED | CANCELLED | DETACHED
```

`DETACHED` means: "this occurrence no longer matches the current series schedule but still has an associated event that may have sales." It is a soft-orphan state that preserves the event while removing it from future schedule displays. The event remains independently manageable.

### New repo methods

```typescript
EventSeriesOccurrencesRepo:
  bulkDeletePlanned(seriesId: string, excludeStartsAt: Set<Date>): Promise<{ deletedCount: number }>
    — Deletes PLANNED occurrences whose startsAt is NOT in the exclude set.
    — Must NOT touch occurrences with status != PLANNED.

  bulkDetach(seriesId: string, occurrenceIds: string[]): Promise<{ detachedCount: number }>
    — Sets status = DETACHED on the given occurrences.
    — Precondition: each must have status in {GENERATED, PUBLISHED}.

  listBySeriesAndStatuses(seriesId: string, statuses: OccurrenceStatus[]): Promise<OccurrenceRecord[]>
    — Fetch all occurrences matching any of the given statuses.
    — No pagination (bounded by maxOccurrencesPerExpand cap of 500).
```

---

## Use case: `reconcileSeriesSchedule`

**Location:** `packages/core/src/use-cases/series/reconcile-series-schedule.ts`

### Input

```typescript
ReconcileSeriesScheduleInput {
  actorHumanId: string          // who is performing the action
  seriesId: string              // the series that was just updated
  windowStart: string           // ISO — effective start for the new schedule
  windowEnd: string             // ISO — effective end (the new `until`)
  maxOccurrences?: number       // cap (default from series.schedule)
  confirmedCancellations?: string[]  // occurrence IDs the organizer approved for cancellation
  clientKey: string             // idempotency key
}
```

### Output

```typescript
ReconcileSeriesScheduleResult {
  seriesId: string
  planned: {
    added: number               // new PLANNED occurrences created
    removed: number             // stale PLANNED occurrences deleted
  }
  generated: {
    detached: number            // GENERATED (no-sales) occurrences detached
    kept: number                // GENERATED occurrences that still match
  }
  published: {
    detached: number            // PUBLISHED occurrences detached (organizer confirmed)
    kept: number                // PUBLISHED occurrences that still match
    pendingConfirmation: Array<{  // returned when confirmedCancellations is missing/incomplete
      occurrenceId: string
      eventId: string
      eventTitle: string
      startsAt: string
      deferredOrderCount: number   // orders with captureStrategy=DEFERRED && !capturedAt
      capturedOrderCount: number   // orders already captured
    }>
  }
}
```

When `pendingConfirmation` is non-empty, the UI must show a confirmation dialog and re-call with `confirmedCancellations`. The use case does **not** proceed with cancellations until the organizer confirms.

### Algorithm

```text
1.  Parse & validate input.
2.  Idempotency check (key: series:reconcile:${seriesId}:${clientKey}).
3.  Begin transaction.
4.  Fetch series record; verify ownership (ensureSeriesOwnerAccess).
5.  Compute NEW_TIMESTAMPS: the full set of occurrence startsAt values
    from the updated schedule within [windowStart, windowEnd],
    using the same RRULE/FIXED_DATES expansion logic as expandSeries.
6.  Fetch ALL existing FUTURE occurrences for this series
    (startsAt > now, any status, within window).
7.  Classify each existing occurrence:

    a.  MATCHES  — occurrence.startsAt is in NEW_TIMESTAMPS.
    b.  ORPHANED — occurrence.startsAt is NOT in NEW_TIMESTAMPS.

8.  For ORPHANED occurrences, bucket by status:

    PLANNED (no event)
      → Delete immediately (bulkDeletePlanned).

    GENERATED (DRAFT event, no orders)
      → Detach (bulkDetach). The event becomes a standalone draft.

    GENERATED or PUBLISHED (event has orders)
      → If occurrence.id is in confirmedCancellations:
          • Mark occurrence DETACHED.
          • For deferred orders: release payment holds (via PaymentProcessorPort.cancelPaymentIntent).
          • For captured orders: queue refund (via existing refund flow).
          • Mark the event as CANCELLED.
          • Audit: series.occurrence_cancelled_with_refunds.
      → If NOT in confirmedCancellations:
          • Add to pendingConfirmation response array.
          • Do NOT delete, detach, or cancel.

9.  For NEW_TIMESTAMPS that have no existing occurrence:
      → Insert PLANNED occurrences (same logic as expandSeries).

10. Audit log: series.reconciled { added, removed, detached, pendingCount }.
11. Commit transaction.
12. Commit idempotency record.
13. Return result.
```

### Idempotency

- Key: `series:reconcile:${seriesId}:${actorHumanId}:${clientKey}`
- TTL: 120s
- Payload hash covers: `windowStart`, `windowEnd`, `maxOccurrences`, `confirmedCancellations`

### Error codes

| Code | When |
| --- | --- |
| `invalid_input` | Bad dates, window, or missing required fields |
| `not_found` | Series doesn't exist |
| `forbidden` | Actor lacks owner/admin/editor on the series owner |
| `precondition_failed` | Series is archived/inactive |
| `conflict` | Idempotency key conflict (different payload for same key) |
| `transient` | Idempotency lock in progress |
| `dependency_failed` | Payment processor failure during hold release/refund |

---

## Transport: tRPC

```text
series.reconcileSeriesSchedule
  - input: ReconcileSeriesScheduleInput (minus actorHumanId, injected from session)
  - output: ReconcileSeriesScheduleResult
  - auth: requireAuth
```

---

## UI flow

### EventBuilder save (edit mode with series)

The current flow is:

```text
updateSeries → expandSeries → toast → navigate
```

The new flow replaces `expandSeries` with `reconcileSeriesSchedule`:

```text
updateSeries → reconcileSeriesSchedule(confirmedCancellations: [])
  → if result.published.pendingConfirmation.length > 0:
      show confirmation dialog
      → on confirm: reconcileSeriesSchedule(confirmedCancellations: [...ids])
      → on cancel: revert (schedule already saved, but no destructive action taken)
  → toast → navigate
```

### Confirmation dialog

When the reconciliation returns `pendingConfirmation` items:

```text
┌─────────────────────────────────────────────────────────┐
│  Schedule change affects events with ticket sales        │
│                                                          │
│  The following events no longer match the new schedule:  │
│                                                          │
│  ☐ "Friday Jazz Night" — Apr 11, 2026                   │
│     3 deferred holds (will be released, no charge)       │
│     1 captured order (will be refunded)                  │
│                                                          │
│  ☐ "Friday Jazz Night" — Apr 18, 2026                   │
│     5 deferred holds (will be released, no charge)       │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│  Select events to cancel, or leave unchecked to keep     │
│  them as standalone (detached) events.                   │
│                                                          │
│  [ Keep All as Standalone ]    [ Cancel Selected ]       │
└─────────────────────────────────────────────────────────┘
```

The organizer can:

- **Cancel selected** — those occurrences are cancelled, holds released, refunds issued.
- **Keep all as standalone** — orphaned events become `DETACHED` occurrences with their events untouched. They no longer appear on the series timeline but remain independently manageable.

---

## Migration

### DB

1. Add `DETACHED` to the `EventSeriesOccurrenceStatus` enum:

   ```sql
   ALTER TYPE "EventSeriesOccurrenceStatus" ADD VALUE 'DETACHED';
   ```

2. No new tables required. The existing `EventSeriesOccurrence` table gains the new status value.

### Schema (Zod)

Update `occurrenceStatusSchema` in `packages/core/src/use-cases/series/schemas.ts`:

```typescript
const occurrenceStatusSchema = z.enum([
  "PLANNED", "SKIPPED", "GENERATED", "PUBLISHED", "CANCELLED", "DETACHED"
]);
```

### Prisma

Add `DETACHED` to the `EventSeriesOccurrenceStatus` enum in `packages/db/prisma/`.

---

## Testing

Colocate tests in `reconcile-series-schedule.test.ts`.

| Case | What to verify |
| --- | --- |
| Happy path: no orphans | Schedule change adds new PLANNED, removes nothing. `result.planned.removed === 0`. |
| Prune PLANNED | Change RRULE from weekly-Friday to weekly-Saturday. Old Friday PLANNEDs are deleted, Saturday PLANNEDs are created. |
| Detach GENERATED (no sales) | GENERATED occurrence with a DRAFT event and zero orders → `status = DETACHED`. Event still exists. |
| pendingConfirmation returned | PUBLISHED occurrence with orders → `pendingConfirmation` array populated, no destructive action taken. |
| Confirm cancellation | Re-call with `confirmedCancellations` → occurrence DETACHED, event CANCELLED, deferred holds released, captured orders refunded. |
| Keep as standalone | Organizer does not include occurrence in `confirmedCancellations` → occurrence set to DETACHED, event untouched (still published). |
| Idempotent replay | Same `clientKey` + same payload → identical result, no duplicate deletes or inserts. |
| Idempotent conflict | Same `clientKey` + different payload → `conflict` error. |
| AuthZ forbidden | Actor without edit permission → `forbidden`. |
| Archived series | Series is archived → `precondition_failed`. |
| Window boundary | Occurrences outside `[windowStart, windowEnd]` are untouched regardless of RRULE match. |
| FIXED_DATES schedule | Works with explicit date lists, not just RRULE. |

---

## Sequence diagram

```text
Organizer           UI (EventBuilder)         tRPC              Core
  │                       │                     │                  │
  │  Save (edit series)   │                     │                  │
  │──────────────────────>│                     │                  │
  │                       │  updateEventSeries  │                  │
  │                       │────────────────────>│  updateEventSeries
  │                       │                     │─────────────────>│
  │                       │                     │<─────────────────│
  │                       │<────────────────────│                  │
  │                       │                     │                  │
  │                       │  reconcile (no      │                  │
  │                       │  confirmations)     │                  │
  │                       │────────────────────>│  reconcileSeries │
  │                       │                     │─────────────────>│
  │                       │                     │  (prune PLANNED, │
  │                       │                     │   add new, check │
  │                       │                     │   for sold)      │
  │                       │                     │<─────────────────│
  │                       │<────────────────────│  pendingConfirmation: [...]
  │                       │                     │                  │
  │  Confirmation dialog  │                     │                  │
  │<──────────────────────│                     │                  │
  │  "Cancel selected"    │                     │                  │
  │──────────────────────>│                     │                  │
  │                       │  reconcile (with    │                  │
  │                       │  confirmed IDs)     │                  │
  │                       │────────────────────>│  reconcileSeries │
  │                       │                     │─────────────────>│
  │                       │                     │  (detach, cancel,│
  │                       │                     │   release holds) │
  │                       │                     │<─────────────────│
  │                       │<────────────────────│  done            │
  │  "Series updated"     │                     │                  │
  │<──────────────────────│                     │                  │
```

---

## Resolved decisions

1. **`DETACHED` occurrences in `listOccurrences`:** Yes, returned by default with a status filter option. The admin series detail view (`/admin/[slug]/series/[seriesId]`) shows all occurrences ordered by date. Detached ones are visually muted with a "detached" badge. Each occurrence links to its event for individual editing. This is not too much data — the hard cap is 500 occurrences, and the list is paginated at 50.

2. **Auto-detach GENERATED (no-sales) occurrences:** Yes, auto-detach. Events with sales get detached (not cancelled) and the organizer can use a generic **"move tickets to event"** use case (tracked separately) to migrate orders to another occurrence. This is a generic use case, not series-specific.

3. **Separate vs. automatic reconciliation:** Separate. The two-step flow (`updateEventSeries` then `reconcileSeriesSchedule`) lets the UI show the preview/confirmation dialog between the steps.

4. **Window scope:** Future only. Occurrences with `startsAt <= now` are untouched regardless of schedule changes. Past occurrences are historical records.

## Future work (out of scope)

- **Series detail admin page** (`/admin/[slug]/series/[seriesId]`): timeline view of all occurrences with status badges, per-occurrence actions (generate, edit, detach), and series-level edit. Separate UI spec.
- **Generic ticket migration** (`migrateEventOrders`): standalone use case for moving orders from one event to another. Useful beyond series (venue changes, date conflicts, cancellations with rebooking). See `migrate-event-orders.spec.md`.

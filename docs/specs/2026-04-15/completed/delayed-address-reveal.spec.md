# Delayed Address Reveal

**Date:** 2026-04-15
**Status:** complete
**Priority:** P0
**Depends on:** `EventLocationMode` (EXACT | APPROXIMATE | HIDDEN) — exists in schema and `redactLocation` lib

---

## Problem

When an event uses `locationMode: HIDDEN`, the exact address is revealed **immediately** when a ticket is purchased. This is the correct behavior for gated venue events (password-protected warehouse shows, invite-only galleries). But for Living Room / DIY events, the host wants the address to stay hidden until closer to show time — typically 24 hours before — regardless of when the attendee bought their ticket.

Currently there's no way to express "reveal the address at a specific time." It's a binary: you have a ticket → you see it. You don't → you see the obfuscated circle.

---

## Goal

Add a configurable reveal time to events using `HIDDEN` location mode. The address stays obfuscated for all ticket holders until the reveal time, then flips to exact. Organizer sets the timing when creating the event.

---

## Context

| What exists | Where |
|---|---|
| `EventLocationMode` enum: EXACT, APPROXIMATE, HIDDEN | `packages/db/prisma/enums.prisma` |
| `Event.locationMode` field | `packages/db/prisma/event.prisma` |
| `Event.locationRadiusMeters` (default 500) | `packages/db/prisma/event.prisma` |
| `Event.locationLabel` (human-readable area name) | `packages/db/prisma/event.prisma` |
| `redactLocation()` — core lib that obfuscates or reveals coordinates based on mode + ticket holder status | `packages/core/src/lib/location/redact-location.ts` |
| Background job infrastructure | `apps/jobs/` |
| Event creation use cases | `save-event-for-human.ts`, `save-event-for-org.ts`, `save-event-shared.ts` |

### Current `redactLocation` behavior

```
EXACT       → always reveals exact coordinates
APPROXIMATE → always obfuscates (circle overlay)
HIDDEN      → obfuscated unless callerIsTicketHolder === true
```

The change: `HIDDEN` mode gains a **time gate** in addition to the ticket gate.

---

## Data Model

### New fields on Event

```prisma
// Add to existing Event model in event.prisma:

/// When the exact address should be revealed to ticket holders.
/// Null = reveal immediately on ticket purchase (current behavior).
/// When set, ticket holders see obfuscated location until this time,
/// then exact location after.
addressRevealAt       DateTime?  @map("address_reveal_at")

/// Preset that generated addressRevealAt. Stored so the UI can show
/// "24 hours before" in the edit form rather than raw datetime.
addressRevealPreset   AddressRevealPreset?  @map("address_reveal_preset")
```

### New enum

```prisma
enum AddressRevealPreset {
  IMMEDIATELY       // addressRevealAt = null (current default)
  ONE_HOUR_BEFORE   // addressRevealAt = startsAt - 1h
  DAY_BEFORE        // addressRevealAt = startsAt - 24h (recommended default for HIDDEN)
  WEEK_BEFORE       // addressRevealAt = startsAt - 7d
  CUSTOM            // organizer picked a specific datetime
}
```

---

## Core Logic Change

### `redactLocation` — add time gate

Current signature:
```typescript
export interface RedactLocationInput {
  mode: EventLocationMode;
  exact: ExactLocation;
  radiusMeters: number;
  callerIsTicketHolder: boolean;
}
```

New signature:
```typescript
export interface RedactLocationInput {
  mode: EventLocationMode;
  exact: ExactLocation;
  radiusMeters: number;
  callerIsTicketHolder: boolean;
  addressRevealAt: Date | null;  // NEW
  now: Date;                      // NEW — injected for testability
}
```

New reveal logic for `HIDDEN` mode:

```typescript
// Full reveal: EXACT mode, or HIDDEN + ticket holder + past reveal time
if (
  mode === "EXACT" ||
  (mode === "HIDDEN" &&
    callerIsTicketHolder &&
    (addressRevealAt === null || now >= addressRevealAt))
) {
  return { ...exact, isExact: true };
}
```

In plain English:
- `EXACT` → always show exact (unchanged)
- `APPROXIMATE` → always obfuscate (unchanged)
- `HIDDEN` + no ticket → obfuscate (unchanged)
- `HIDDEN` + ticket + `addressRevealAt` is null → reveal immediately (backward compatible)
- `HIDDEN` + ticket + `addressRevealAt` is in the future → **obfuscate** (new behavior)
- `HIDDEN` + ticket + `addressRevealAt` is in the past → reveal (new behavior)

### No background job needed

This is a **lazy evaluation** — `redactLocation` is called on every event detail page render. When the time passes, the next render reveals the address. No job, no cron, no state mutation. The address was always stored in the database; we're just controlling when the caller gets to see it.

**Notification job (optional, P1):** A background job that sends a push/email to ticket holders when `addressRevealAt` passes: "The address for [Event] has been revealed — check the event page." This is a notification trigger, not a state change.

---

## Use Case Changes

### `save-event-shared.ts` — accept new fields

Add to the shared event save schema:

```typescript
addressRevealPreset: z
  .enum(["IMMEDIATELY", "ONE_HOUR_BEFORE", "DAY_BEFORE", "WEEK_BEFORE", "CUSTOM"])
  .optional(),
addressRevealAt: z.date().optional().nullable(),
```

Validation:
- If `locationMode !== "HIDDEN"`, `addressRevealAt` and `addressRevealPreset` are ignored (silently nulled)
- If `addressRevealPreset` is set and not `CUSTOM`, compute `addressRevealAt` from `startsAt`:
  - `IMMEDIATELY` → null
  - `ONE_HOUR_BEFORE` → `startsAt - 1 hour`
  - `DAY_BEFORE` → `startsAt - 24 hours`
  - `WEEK_BEFORE` → `startsAt - 7 days`
  - `CUSTOM` → use the provided `addressRevealAt` value
- If `startsAt` changes (event reschedule), recompute `addressRevealAt` from the preset unless preset is `CUSTOM`

### Callers of `redactLocation` — actual enumeration

Verified via grep (2026-04-16). Today there is **exactly one** non-test caller:

- `packages/core/src/use-cases/events/_shared/build-event-seo.ts` — SEO metadata. Currently passes `callerIsTicketHolder: false`. Must be extended to pass `addressRevealAt: event.addressRevealAt ?? null` and `now: new Date()`.

**Other use cases that return `event.addressText` directly** (e.g. `get-my-order.ts`, `get-random-event.ts`, `list-events-by-category.ts`, `generate-wallet-pass.ts`, `send-ticket-issued-email.ts`) **do not call `redactLocation`** and will leak the address regardless of the new field. Gating those is a separate concern outside this spec's scope — track in a follow-up.

### Organizer edit view — bypass entirely, do not special-case the helper

The edit form (`get-event-for-edit.ts` and equivalents) already reads raw `event.addressText` / `event.lat` / `event.lng` directly and does not pass through `redactLocation`. No change needed. Do **not** add a `callerIsOrganizer` flag to `RedactLocationInput` — it's an anti-pattern (mixing authorization into a pure obfuscation helper). Callers that need the full address on behalf of an owner should skip the helper.

---

## UI Changes

### Event creation/edit form

When `locationMode` is set to `HIDDEN`, show a new field:

```
┌─────────────────────────────────────────────┐
│  When should attendees see the address?      │
│                                              │
│  (•) 24 hours before the event  [default]    │
│  ( ) 1 hour before                           │
│  ( ) 1 week before                           │
│  ( ) Immediately after purchase              │
│  ( ) Custom date & time                      │
│                                              │
│  If "Custom": [date/time picker]             │
└─────────────────────────────────────────────┘
```

- Only visible when `locationMode === "HIDDEN"`
- Default preset: `DAY_BEFORE` (new events with HIDDEN mode get this by default)
- When `IMMEDIATELY` is selected, this matches the current behavior — no migration needed

### Event detail page (attendee view)

When the address is still hidden (ticket holder but before reveal time):

```
┌─────────────────────────────────────────────┐
│  📍 Bushwick, Brooklyn                       │
│  [obfuscated map circle]                     │
│                                              │
│  Exact address revealed Apr 19 at 7:00 PM    │
│  (24 hours before the show)                  │
└─────────────────────────────────────────────┘
```

**Timezone rule:** All reveal-time copy rendered to attendees must be formatted in `event.timezone`, not the viewer's local zone. Different attendees may be in different zones but the event has one canonical reveal moment. Label the zone in parentheses: `"7:00 PM CT"` or `"Apr 19 at 7:00 PM (America/Chicago)"`. Use `formatEventDate` / `formatEventTimeRange` from `@th/locale` with `{ timeZone: event.timezone }`.

After reveal:

```
┌─────────────────────────────────────────────┐
│  📍 142 Troutman St, Brooklyn, NY 11206      │
│  [exact map pin]                             │
│                                              │
│  [Get Directions]                            │
└─────────────────────────────────────────────┘
```

### Ticket confirmation email

The `TicketIssued` email template (`packages/ui-email/src/templates/TicketIssued.tsx`) already renders venue info. When `addressRevealAt` is set and in the future at send time, swap the address block for a reveal notice:

> "The exact address will be shared on {date} at {time} ({event.timezone}). We'll send you a reminder."

The date/time must be formatted in **`event.timezone`** (not the viewer's locale), since different ticket holders may be in different zones but the event has one canonical clock. Use `formatEventDate` from `@th/locale` with `{ timeZone: event.timezone }`.

`TicketIssued` already uses the translator-context pattern — add new message keys under `emails.ticketIssued.addressReveal.*`. The i18n interpolation in `packages/locale` handles the formatted date string.

No changes to `OrderReceipt` — it doesn't render venue address today.

---

## Backward Compatibility

- Existing events have `addressRevealAt = null` and `addressRevealPreset = null`
- `redactLocation` with `addressRevealAt = null` behaves exactly as before (ticket holder → immediate reveal)
- Migration: add nullable columns, no data backfill needed
- Zero breaking changes to existing events or tickets

---

## Acceptance Criteria

- [ ] New events with `locationMode: HIDDEN` default to `addressRevealPreset: DAY_BEFORE`
- [ ] `redactLocation` obfuscates for ticket holders when `now < addressRevealAt`
- [ ] `redactLocation` reveals for ticket holders when `now >= addressRevealAt`
- [ ] `addressRevealAt = null` reveals immediately (backward compat)
- [ ] Changing `startsAt` recomputes `addressRevealAt` for non-CUSTOM presets
- [ ] Event detail page shows countdown to reveal for ticket holders
- [ ] Ticket confirmation email includes reveal timing
- [ ] Non-HIDDEN events ignore `addressRevealAt` (silently null)
- [ ] Organizer always sees exact address in edit form regardless of reveal time

---

## Open Questions

- **Notification job:** Should we send a push notification when `addressRevealAt` passes? Good UX but adds a job. Mark as P1 — ship the lazy reveal first, add the notification later.
- **APPROXIMATE mode:** Should APPROXIMATE also support a reveal-to-exact transition? Currently no use case for this — APPROXIMATE is for events that never want exact shown publicly. Leave it alone.

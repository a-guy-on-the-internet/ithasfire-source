# Volunteer role templates — bundle shift times with the role

**Date:** 2026-04-28
**Status:** complete
**Priority:** P2
**Depends on:** `VolunteerRoleTemplate`, `VolunteerRoleTemplateShift` (new), volunteer roles use cases, `RolesTab` "From template" flow, `VolunteerTemplatesView`
**Supersedes:** N/A

---

## Problem

Volunteer role templates today store only role-level fields: `name`, `description`, `defaultCapacity`. When an organizer applies a template to an event, they get the role with no shifts attached — every event needs the same shift schedule typed in by hand.

For recurring patterns (a venue that always staffs Setup / Doors / Main / Cleanup at the same offsets from event start), this means re-creating the same four shifts for every event. The whole point of a template was to avoid that.

## Goal

Let templates carry a list of "shift presets" — a label, a start offset (relative to event start), an end offset, and a capacity. Applying the template instantiates the role *and* fills the shift drafts in `InlineShiftComposer` ready for the organizer to tweak and save.

User said it best: "When a user adds a shift template they just get added underneath whatever the date is or just whatever today is, then the user can adjust the days themselves."

## Context

| What exists | Where |
|---|---|
| `VolunteerRoleTemplate` model (id, orgId, name, description, defaultCapacity, status) | `packages/db/prisma/volunteering.prisma` |
| Template editor UI | `apps/web/src/app/admin/[slug]/volunteer-templates/_components/VolunteerTemplatesView.tsx` |
| Apply-template flow | `RolesTab.tsx` "From template" button → `FromTemplatesDialog` → `volunteer.roles.createFromTemplate` |
| `InlineShiftComposer` (in-place batch shift draft) | `apps/web/src/app/admin/[slug]/events/[id]/volunteers/_components/InlineShiftComposer.tsx` |
| Shift composer helpers (preset rows already use start/end offset math) | `apps/web/src/app/admin/[slug]/events/[id]/volunteers/_components/shift-composer-helpers.ts:106-158` |
| Existing presets (`Setup`/`Doors`/`Main`/`Cleanup`) — same idea, hardcoded | same file |

The hardcoded presets are essentially "templates" already. We just need to let organizers define their own.

## Data Model

Add a child table — stored as time-of-day plus day offset, matching how
real shift schedulers (When I Work, Sling, Mobilize) model recurring
templates:

```prisma
model VolunteerRoleTemplateShift {
  id               String   @id @default(uuid())
  templateId       String
  template         VolunteerRoleTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  label            String
  /** 0..1439 — minute-of-day in the event's timezone. */
  startMinuteOfDay Int
  endMinuteOfDay   Int
  /** Day offset from the event date (0 = event day, -1 = day before, etc.). */
  startDayOffset   Int      @default(0)
  /** True when end is the next calendar day vs start (set when end <= start). */
  endsNextDay      Boolean  @default(false)
  capacity         Int?
  /** Display order within the template editor and when applying. */
  position         Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([templateId, position])
}
```

Migration is additive (no data backfill needed — existing templates just have zero shifts attached).

**Why time-of-day, not "offset from event start":** organizers think in
clock time ("Setup is 4pm, doors at 6:30") not deltas. Mainstream shift
schedulers all use this pattern. Offset arithmetic also creates
surprising behavior at DST boundaries and for events that cross
midnight.

## Use Cases

Two new methods on the volunteer roles repo / use case layer:

1. `volunteer.templates.upsertShifts({ templateId, shifts: ShiftDraft[] })` — replaces the shift list for a template (idempotent; matches how the role editor already works for shifts within an event).
2. `volunteer.roles.createFromTemplate` already exists. Extend it to:
   - Accept a `forEventStartsAt: Date` parameter (already plumbed; it's the event's `startsAt`).
   - When the template has shifts and the event has a `startsAt`, return the materialized shift drafts (label + computed start/end ISO + capacity) alongside the created role.
   - Return them — **don't auto-create the shifts**. The organizer should land in `InlineShiftComposer` with the rows pre-populated so they can review, adjust dates (especially for multi-day events), and save.

## Apply Behavior

When applying a template to an event:

| Event has `startsAt`? | Template has shifts? | Behavior |
|---|---|---|
| Yes | Yes | Materialize shifts using offsets from event start. Open composer with drafts. |
| Yes | No | Create role only; composer opens empty (today's behavior). |
| No  | Yes | Materialize shifts using **today** (browser local) as the reference, with a banner: "Shifts default to today's date — adjust before saving." |
| No  | No | Create role only. |

The `today` fallback matches the user's spec: "underneath whatever the date is or just whatever today is then the user can adjust the days themselves."

## UI

### Template editor

In `VolunteerTemplatesView`'s template dialog, add a section below the existing fields:

```
Default shifts
┌────────────────────────────────────────────────────────────┐
│ Setup    │ 16:00 → 18:30 │ Event day      │ 2 slots │ ✕  │
│ Doors    │ 18:30 → 20:00 │ Event day      │ 1 slot  │ ✕  │
│ Main     │ 20:00 → 23:00 │ Event day      │ 4 slots │ ✕  │
│ Cleanup  │ 23:00 → 00:30 │ Event day      │ 2 slots │ ✕  │
└────────────────────────────────────────────────────────────┘
[+ Add shift]
```

Each row uses native `<input type="time">` for start and end, a
`<select>` for the day offset (event day, day before, day after, etc.),
and a numeric capacity input. When end ≤ start, the helper sets
`endsNextDay: true` automatically (so 23:00 → 00:30 wraps cleanly).

### Apply-template flow

`FromTemplatesDialog`'s confirmation: when the chosen template has shifts, show a preview list:

```
Applying "Standard show" will create:
  Role: Front of house
  4 draft shifts (you can adjust before saving):
    • Setup        — {date} 17:00 to 18:30
    • Doors        — {date} 18:15 to 20:00
    • Main         — {date} 19:00 to 23:00
    • Cleanup      — {date} 23:00 to 00:30
```

After confirming, the composer opens pre-populated with those drafts. User can edit individual rows or use the new "Repeat on more days" control (already shipped) to copy across festival days.

## Acceptance criteria

- [ ] Template dialog supports adding/editing/removing shifts inline.
- [ ] `VolunteerRoleTemplateShift` rows persist with the template; cascading delete works.
- [ ] Applying a template with shifts to an event with `startsAt` opens `InlineShiftComposer` with rows whose start/end ISO timestamps equal `eventStartsAt + offsetMinutes`.
- [ ] Applying a template to an event with no `startsAt` falls back to today; banner is visible.
- [ ] No shifts are auto-created — organizer must hit Save in the composer to persist.
- [ ] Existing templates without shifts continue to work (apply creates role only).
- [ ] Spanish strings mirror English.

## Out of scope

- Importing the existing hardcoded presets (`Setup`/`Doors`/`Main`/`Cleanup`) into a default template. Could be a follow-up "starter templates" feature.
- Cross-org template sharing.
- Template versioning (existing templates aren't versioned).

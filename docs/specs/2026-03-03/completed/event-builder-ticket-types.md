# Event Builder — Ticket Types Section Spec

> **Status:** complete — decisions resolved 2026-02-11
> **Author:** Copilot + human
> **Date:** 2026-02-11
> **Scope:** EventBuilder UI sections for ticket types, event humans, payout terms, resale policy, seating, and revenue projections.

---

## 1. Overview

The EventBuilder currently has: Hero Image, Title, Dates, Location, Body editor, and a Preview tab.
This spec adds the remaining sections needed to make an event actually sellable:

1. **Ticket Types** — name, price, capacity, seat assignment, resale/transfer policy
2. **Event Humans** — linking registered or free-text humans to the event (performers, hosts, instructors, etc.)
3. **Payout Terms** — selecting or creating payout terms for primary and resale revenue, with lines applied per-ticket-type
4. **Revenue Summary** — derived projection card

All sections are collapsible. A **Simple / Advanced toggle** at the top of the builder controls which sections start expanded and which fields are visible.

---

## 2. View Modes: Simple vs Advanced

This is an explicit user toggle (segmented control or switch at the top of the page), not auto-detected. It is a UI-only preference — not stored in the database. It controls:

| Aspect | Simple | Advanced |
|---|---|---|
| Ticket types: core fields | Expanded (name, price, capacity) | Expanded (all fields) |
| Ticket types: resale/transfer policy | Collapsed / hidden | Visible per type |
| Ticket types: seat section assignment | Hidden (unless place with layout selected) | Always shown |
| Attached Humans section | Collapsed | Expanded |
| Payout Terms section | Collapsed (uses org/human default) | Expanded |
| Revenue Summary | Shown (read-only total) | Shown with per-type breakdown |

In **Simple mode**, the builder auto-applies the org/human's default pa`yout terms and hides resale toggles. The user can still expand any collapsed section manually — the mode just sets initial visibility.

Future: Template presets (e.g., "Workshop", "Concert", "Solo show") could set both the view mode AND pre-fill default values (capacity, roles, etc.) via the existing `EventTemplate.defaults` JSON column. This is deferred but the `EventTemplate` model is already in place for it.

> **Note:** `EventFormat` will be dropped (model + `Event.formatId` FK removed). View-mode switching and future template presets replace its role. See §9.

---

## 3. Ticket Types Section

### 3.1 Fields per ticket type

| Field | Type | Required | Simple | Advanced | Notes |
|---|---|---|---|---|---|
| Name | string (1-80) | Yes | Visible | Visible | Unique per event |
| Description | string (≤280) | No | Visible | Visible | |
| Price | int (cents, ≥0) | Yes | Visible | Visible | 0 = free. Paid tickets gated behind Stripe Connect. |
| Capacity | int (≥1) | Yes | Visible | Visible | If linked to a seat section, auto-populated from section seat count. |
| Seat Section | select | No | Hidden (unless place layout selected) | Visible | Dropdown of sections from the event's selected `PlaceLayout`, or a generic label if no place. See §4. |
| Resale Allowed | boolean | No | Hidden | Visible | Only meaningful when event has `resalePayoutTermsId`. Disabled with hint when not. |
| Resale Price Cap | int (cents) | No | Hidden | Visible | Conditional: shown when Resale Allowed is on. Null = no cap. Shows face value next to it for reference. |
| Transfer Allowed | boolean | No | Hidden | Visible | Default true. Distinct from resale (transfers are free). |

### 3.2 Aggregate display

Below the ticket type list, show a summary row:
- **Total capacity:** sum of all ticket types' capacity
- **Resale cap aggregate:** for types with resale enabled, show the aggregate maximum resale ceiling (sum of `resaleCapCents * capacity`), making the total exposure obvious at a glance.

### 3.3 Stripe Connect gate

Per `docs/ticketing-and-stripe.md`:
- "Create free tickets" is always available (price = 0).
- "Create paid tickets" (price > 0) is disabled until the org/human has a connected Stripe account with `chargesEnabled = true`.
- The section shows a "Connect Stripe" CTA linking to the Payments admin page when gated.
- This is already enforced in the `upsertTicketType` use case; the UI should mirror it.

### 3.4 Data model changes needed

**`TicketTypeRecord`** (in `packages/types/src/repos/tickets.ts`): Add `resaleAllowed`, `resaleCapCents`, `transferAllowed` to match the Prisma model fields that already exist in the DB.

**`CreateTicketTypeInput`**: Same — add the three fields.

**`upsertTicketType` use case input Zod schema**: Add `resaleAllowed` (boolean, default false), `resaleCapCents` (int, nullable), `transferAllowed` (boolean, default true).

These fields already exist in `schema.prisma` on `TicketType`. The work is syncing TypeScript types and use case validation.

---

## 4. Seat Assignment / Section Linking

### 4.1 When a Place with a PlaceLayout is selected

The event's Location section already lets the user pick a `Place`. Once a place is selected:

1. **Layout picker**: Show a dropdown of `PlaceLayout` records for that place (fetched via `placeLayouts` relation). The user selects which layout applies to this event. This sets `Event.placeLayoutId`.

2. **Auto-create sections & seats**: When a layout is selected, `SeatSection` and `Seat` rows for this event are **automatically created** from the layout data (`PlaceLayout.seatIndex`, `metadata`, etc.). The layout already defines the sections, their types (GA/Reserved), capacities, and individual seats. No manual section creation needed — the data mapping already exists.

3. **Capacity derived from layout**: The total event capacity is the sum of all sections' capacities from the selected layout. Individual ticket type capacity is bound to the section it's assigned to. This means **layouts define the capacity ceiling for the event**.

4. **Section assignment**: Each ticket type can be assigned to a section from the auto-created set via a dropdown. The section's seat count auto-fills the ticket type's capacity as read-only.

### 4.2 When no Place / no layout

The ticket type just has a generic text label for the section (or no section at all). Capacity is manually entered. No seat-level assignment. The `seatSectionId` remains null.

### 4.3 Mixed

An event can have some ticket types linked to sections (e.g., "VIP Front Row") and others unlinked (e.g., "General Admission" with just a capacity number). The UI should handle both cleanly.

---

## 5. Resale Policy

### 5.1 Resale payee fee — per-ticket-type payout term lines (unified by default)

When a ticket is resold, the original payees (org, event humans, etc.) may receive a fee from the resale transaction.

**Approach:** Payout term lines are modeled **per ticket type**, but the UI surfaces a single unified configuration that applies to all ticket types by default. Only when a user actively decides they need differentiated splits (e.g., "VIP resales pay the artist more") do they break individual types out.

This means:
- `PayoutTermsLine` rows can be scoped to a specific `TicketType` (new optional FK on `PayoutTermsLine`).
- The default/initial state is: all resaleable ticket types share one set of lines (the "event-level" lines with no ticket type FK set).
- A user in Advanced mode can override lines for a specific ticket type, creating type-scoped `PayoutTermsLine` rows.
- Resolution order: type-specific lines first, then fall back to event-level lines.

**Schema change needed on `PayoutTermsLine`:**

```prisma
model PayoutTermsLine {
  id             String                  @id @default(uuid())
  payoutTermsId  String
  payeeId        String
  /// Optional: scope this line to a specific ticket type.
  /// Null = applies to all ticket types under these payout terms.
  ticketTypeId   String?
  percent        Int
  floorCents     Int                     @default(0)
  capPercent     Int?
  priority       Int                     @default(0)
  rounding       PayoutTermsLineRounding @default(FLOOR)

  payoutTerms PayoutTerms @relation(fields: [payoutTermsId], references: [id], onDelete: Cascade)
  payee       Payee       @relation(fields: [payeeId], references: [id])
  ticketType  TicketType? @relation(fields: [ticketTypeId], references: [id], onDelete: Cascade)

  @@index([payoutTermsId])
  @@index([payeeId])
  @@index([ticketTypeId])
}
```

**UI flow in the builder:**
- Advanced mode shows a "Resale Payout Terms" sub-section (or inline on the Payout Terms section, see §6).
- By default, one set of payee lines applies to all resaleable types. A "Customize per ticket type" toggle lets the user break out individual overrides.
- The per-ticket-type `resaleAllowed` toggle controls which types participate.

### 5.2 Two-level control (recap)

1. **Event level:** Does `resalePayoutTermsId` exist? If no, resale is globally off for this event. All per-type resale toggles are disabled with hint text.
2. **Ticket type level:** When event-level resale is enabled, each type has its own `resaleAllowed` toggle + optional `resaleCapCents`.

---

## 6. Payout Terms Section

### 6.1 What exists today

- `PayoutTerms` model with `kind` (PRIMARY or RESALE), `payoutSchedule` enum (`DAY_AFTER_EVENT`, `WEEK_OF_EVENT`, `ONE_WEEK_AFTER`, `TWO_WEEKS_AFTER`, `FOUR_WEEKS_AFTER`), `basis` (GROSS or NET_AFTER_PLATFORM_FEES), and `PayoutTermsLine` rows that split revenue among `Payee` records.
- `Event.payoutTermsId` (primary) and `Event.resalePayoutTermsId` (resale) link to these.
- The admin Payments page manages Stripe Connect status but does NOT yet have payout terms UI.

### 6.2 Builder section behavior

In the EventBuilder, the Payout Terms section should:

1. **Simple mode (collapsed):** Auto-assign the org/human's default payout terms (`isDefault = true`). Show a one-liner summary: "Using default payout terms — Payouts: [schedule]. [Expand to customize]."

2. **Advanced mode (expanded):** Show:
   - **Primary payout terms:** Schedule dropdown (the `PayoutSchedule` enum values, with human-readable labels). Who gets paid (payee lines with percentages). Basis (gross vs net).
   - **Resale payout terms:** Same structure, but for `kind = RESALE`. Only shown if at least one ticket type has `resaleAllowed = true`. Payee lines here can include attached humans.

### 6.3 Payout timing — "instant" = event end + 2 days

**Decided:** "Instant" payouts mean **event end + 2 days** to allow time for refund processing and dispute handling. After the 2-day window, funds are released to payees.

All event payouts follow this principle: the earliest a payout can execute is 2 days after the event ends. Payouts that aren't processed within that cycle get pushed to the next scheduled cycle.

**Schema change:** Rename/redefine `PayoutSchedule` to reflect this:

```prisma
enum PayoutSchedule {
  ASAP              // 2 days after event ends (fastest possible, replaces DAY_AFTER_EVENT)
  WEEK_OF_EVENT     // Sunday of the week the event occurs (still ≥ event end + 2 days)
  ONE_WEEK_AFTER    // Sunday of the following week
  TWO_WEEKS_AFTER   // Sunday 2 weeks after event week
  FOUR_WEEKS_AFTER  // Sunday 4 weeks after event week (~1 month)
}
```

The `DAY_AFTER_EVENT` value is renamed to `ASAP` to better communicate that it's "as soon as possible given the refund window" rather than a literal promise. All schedules implicitly respect the 2-day post-event floor.

This is exposed in the EventBuilder's Payout Terms section and the Payments admin page.

---

## 7. Event Humans (new model: `EventHuman`)

### 7.1 Naming — resolved

**`EventHuman`** — follows the `Event*` join table convention (`EventImage`, `EventDailyStats`, etc.) and is self-descriptive: "a human attached to an event." Answers the implicit question "attached to what?" directly in the name.

### 7.2 Schema

```prisma
model EventHuman {
  id        String   @id @default(uuid())
  eventId   String
  /// When linked to a registered human. Null for free-text entries.
  humanId   String?
  /// Free-text name for unregistered humans.
  externalName  String?
  /// Free-text URL (social, website) for unregistered humans.
  externalUrl   String?
  /// Role on this event. Constrained enum with OTHER escape hatch.
  role      EventHumanRole @default(PERFORMER)
  /// Display order (0 = headliner/primary, ascending = supporting).
  sortOrder Int      @default(0)

  event Event  @relation(fields: [eventId], references: [id], onDelete: Cascade)
  human Human? @relation("EventHumans", fields: [humanId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([eventId, humanId]) // one link per registered human per event; free-text duplicates are allowed (user's problem, not ours)
  @@index([humanId])
  @@index([eventId, sortOrder])
}

enum EventHumanRole {
  PERFORMER
  HOST
  DJ
  INSTRUCTOR
  SPEAKER
  VENDOR
  OTHER
}
```

### 7.3 Registered vs free-text

- **Registered (`humanId` set):** The UI searches existing Humans (by name/slug). When linked, the event page auto-pulls the human's Profile data (avatar, bio, slug, genre tags, social links, music, etc.). The human also shows up in future analytics queries.
- **Free-text (`humanId` null, `externalName` set):** For "my friend's band isn't on the platform." Just a name and optional URL. No profile enrichment, no analytics linkage. Can be "upgraded" to a registered link later if the human joins.

Validation: exactly one of `humanId` or `externalName` must be non-null (enforced in the use case, not DB constraint, to keep migrations simple).

### 7.4 Payee linkage

An attached human who is also a `Payee` (has a Stripe Connect account via `Payee.subjectType = HUMAN, subjectId = humanId`) can be added as a `PayoutTermsLine` on the event's payout terms. This is how attached humans receive revenue splits.

The EventBuilder UI could surface a hint: "This person has a connected payout account. Add them to the payout split?" — but actually adding them is done in the Payout Terms section, not the Attached Humans section. Keep the concerns separate.

### 7.5 UI in the builder

- **Simple mode:** Section is collapsed. Empty state: "No performers or hosts added yet."
- **Advanced mode:** Section is expanded. Shows:
  - List of attached humans with: avatar (or placeholder), name, role dropdown, drag handle for sort order, remove button.
  - "Add person" button opens a search-or-create flow: search registered humans by name/slug, or toggle to "Add manually" for free-text.
  - Role dropdown: PERFORMER (default), HOST, DJ, INSTRUCTOR, SPEAKER, VENDOR, OTHER.

---

## 8. Revenue Summary

Pure derived data, no new tables.

### 8.1 Calculation

```
potentialRevenue = sum(ticketType.priceCents * ticketType.capacity) for all types
```

### 8.2 Display

- **Simple mode:** Single line: "If all tickets sell: $X,XXX"
- **Advanced mode:** Per-type breakdown table:

| Type | Price | Capacity | Subtotal |
|---|---|---|---|
| GA | $25 | 200 | $5,000 |
| VIP | $75 | 50 | $3,750 |
| **Total** | | **250** | **$8,750** |

Free tickets shown with $0 subtotal. Mixed free/paid events note the paid subtotal separately.

### 8.3 Analytics placeholder (deferred)

Leave a commented-out section or empty-state slot in the UI component:

```tsx
{/* TODO: Historical sell-through analytics.
    Future: query past events by attached humans, org, and place
    to show average sell-through rates.
    e.g., "Events at [Venue] average 78% sell-through"
    See docs/specs/event-builder-ticket-types.md §8.3 */}
```

And a corresponding note in the use case layer:

```ts
// TODO: getEventAnalyticsHints use case
// Inputs: performerHumanIds[], orgId?, placeId?
// Returns: { avgSellThrough, sampleSize, breakdowns[] }
// Data source: EventDailyStats + Order/TicketType aggregates
// See docs/specs/event-builder-ticket-types.md §8.3
```

This ensures the idea doesn't get lost without building anything.

---

## 9. EventFormat — Delete

**Decided:** Drop the `EventFormat` model, the `Event.formatId` FK, and the `Event.format` relation. It has no clear use case and template presets + the Simple/Advanced toggle replace any role it might have served.

**Migration:**
1. Remove `formatId` column from `Event`.
2. Drop the `EventFormat` table.
3. Remove any seed data for `EventFormat`.

This is a clean cut with no data loss risk — `formatId` is nullable and unused in any business logic or UI.

---

## 10. Section Order in EventBuilder

Proposed final section order (all collapsible unless noted):

1. **Hero Image** (existing)
2. **Title** (existing)
3. **Date & Time** (existing)
4. **Location** (existing) — expanded to include PlaceLayout picker when a Place is selected
5. **Event Humans** — new, collapsed in Simple, expanded in Advanced
6. **Ticket Types** — new, always expanded
7. **Payout Terms** — new, collapsed in Simple (auto-default), expanded in Advanced
8. **Revenue Summary** — new, always visible (read-only card, not a form section)
9. **Save Draft / Publish** actions (existing) — always above the body editor so the editor can scroll freely below
10. **Details / Body Editor** (existing, ProseMirror) — at the bottom so it can grow unbounded without pushing actions out of view

---

## 11. Data Model Change Summary

| Change | Type | Priority |
| --- | --- | --- |
| Sync `TicketTypeRecord` type: add `resaleAllowed`, `resaleCapCents`, `transferAllowed` | Type sync | P1 |
| Sync `CreateTicketTypeInput` type: same fields | Type sync | P1 |
| Expand `upsertTicketType` Zod input schema: same fields | Use case | P1 |
| New model: `EventHuman` + `EventHumanRole` enum | Migration | P1 |
| Add `ticketTypeId` (optional FK) to `PayoutTermsLine` | Migration | P1 |
| Rename `PayoutSchedule.DAY_AFTER_EVENT` → `ASAP` | Migration | P1 |
| Drop `EventFormat` model + `Event.formatId` FK | Migration | P1 |
| New use cases: `attachEventHuman`, `detachEventHuman`, `listEventHumans`, `reorderEventHumans` | Core | P1 |
| New ports: `EventHumansRepo` (or methods on existing `EventsRepo`) | Ports | P1 |
| New adapter: Prisma implementation for EventHuman CRUD | Adapter | P1 |
| New tRPC procedures: `eventHuman.attach`, `.detach`, `.list`, `.reorder` | Transport | P1 |
| PlaceLayout picker + auto-create sections/seats from layout | UI + Use case | P1 |
| Payout Terms selection/creation in builder | UI | P2 (can use defaults for now) |
| Per-ticket-type payout term line overrides UI | UI | P2 |
| Analytics hints (`getEventAnalyticsHints`) | Core + UI | Deferred |

---

## 12. Implementation Phases

### Phase 1 — Core ticket types + event humans

- Sync TicketType types and use case (resale/transfer fields)
- `EventHuman` migration + `EventHumanRole` enum
- `PayoutTermsLine.ticketTypeId` optional FK migration
- `PayoutSchedule` rename: `DAY_AFTER_EVENT` → `ASAP`
- Drop `EventFormat` model + `Event.formatId`
- EventHuman ports, adapter, use cases, tRPC
- EventBuilder UI: Ticket Types section, Event Humans section, Revenue Summary card
- Simple/Advanced toggle
- PlaceLayout picker in Location section + auto-create sections/seats

### Phase 2 — Payout terms in builder

- Payout Terms section in EventBuilder (primary + resale selection/creation)
- Payee line management (add event humans as payees)
- Per-ticket-type payout term line overrides (unified default → break out per type)
- Resale payee fee awareness in ticket type UI

### Phase 3 — Polish & deferred

- Analytics placeholder code/comments
- Template presets (leveraging `EventTemplate.defaults`)
- Instant payout refinement if `ASAP` (event end + 2 days) needs tuning

---

## 13. Resolved Decisions

All original open questions have been resolved:

1. **Naming:** `EventHuman` — follows `Event*` convention and is self-descriptive.
2. **Instant payouts:** Event end + 2 days to handle refunds. `PayoutSchedule.DAY_AFTER_EVENT` renamed to `ASAP`. All schedules respect this 2-day floor.
3. **Resale payee fee granularity:** Per-ticket-type `PayoutTermsLine` rows (via new `ticketTypeId` FK), but the UI surfaces one unified split by default. Users can break out per-type overrides in Advanced mode.
4. **PlaceLayout sync:** Auto-create `SeatSection` and `Seat` rows from layout data when a layout is selected. Layouts define capacity ceilings.
5. **Free-text human duplicates:** Allowed. Duplicate free-text `externalName` values on the same event are a user problem, not a tech constraint. The `@@unique([eventId, humanId])` only prevents duplicate registered human links.
6. **EventFormat:** Delete the model, FK, and relation. No use case; template presets replace it.
7. **View modes:** Simple / Advanced explicit toggle. Not tied to EventFormat. UI-only preference.
8. **Save Draft position:** Always above the body editor so the ProseMirror editor can scroll freely at the bottom.
9. **Payout terms in builder:** Simple mode auto-applies org/human defaults. Advanced mode expands for customization. Primary and resale terms handled in the same section.

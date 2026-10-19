# Venue Event Proposals

> **Status:** Spec (uncompleted)
> **Domain:** Places, Events
> **Depends on:** `Place`, `PlaceOwnership`, `Event`, notifications infra

---

## 1. Problem

Today, any event creator can set `Event.placeId` to any VERIFIED place. The
venue owner has no visibility or control over what gets promoted "at" their
space. This is how Eventbrite and Dice work too, but it creates real problems
at scale: fake events at real venues (scam vector), scheduling conflicts the
venue never agreed to, and diluted venue branding when low-quality events are
associated with a reputable space.

## 2. Insight

Instead of adding a permission gate that slows down event creation, treat
place assignment as an **implicit proposal**. The event creator's workflow
doesn't change at all (pick a venue, keep building). But the venue owner now
has a lightweight confirmation layer that unlocks venue-exclusive features.

This makes it *easy* for venues to hold events (someone else does the
legwork of creating the event and proposing it) while giving venues control
over their brand, calendar, and seat map access.

## 3. Proposal lifecycle

```
Event creator sets placeId
        │
        ▼
  ┌─────────────┐
  │   PENDING    │  Event is valid and publishable.
  │              │  Shows the venue address but NOT the venue's
  │              │  branding, layout, or embed listing.
  └──────┬──────┘
         │
    Venue owner action
         │
    ┌────┴────┐
    ▼         ▼
CONFIRMED   DECLINED
    │         │
    │         └─► Event keeps address/geo but loses placeId
    │             association. Falls back to raw address mode.
    │
    └─► Event gains:
        - Venue branding (logo, name link)
        - Access to PlaceLayout / seat maps
        - Listing on the venue's public event calendar
        - Inclusion in venue embed widgets
        - Venue calendar conflict detection
```

## 4. Data model changes

### 4.1 New enum: `PlaceEventStatus`

```prisma
enum PlaceEventStatus {
  PENDING     // default when placeId is set
  CONFIRMED   // venue owner accepted
  DECLINED    // venue owner rejected
}
```

### 4.2 Event model addition

```prisma
model Event {
  ...
  placeEventStatus  PlaceEventStatus  @default(PENDING)
  placeConfirmedAt  DateTime?
  placeConfirmedBy  String?           // humanId of the venue-side actor
  ...
}
```

### 4.3 No new join table needed

A join table (`PlaceEventLink`) was considered but adds complexity without
benefit. The `placeId` FK already exists on Event, and a status enum + two
timestamp/actor fields are sufficient. If multi-venue events become a
requirement later, we can introduce the join table then.

## 5. Behavioral rules

| Rule | Detail |
|------|--------|
| **Default status** | When `Event.placeId` is set (create or update), `placeEventStatus` defaults to `PENDING`. |
| **Auto-confirm for owners** | If the event creator (human or org) is also a `PlaceOwnership` holder for the target place, auto-set `CONFIRMED`. No notification needed. |
| **Notification on PENDING** | Venue owners receive an in-app + email notification: "New event proposed at [Venue]". Links to a review screen. |
| **Venue review screen** | Shows event title, dates, organizer info, expected attendance. Confirm / Decline buttons. Optional message to organizer. |
| **Decline behavior** | Sets `placeEventStatus = DECLINED`. Clears `placeId` and `placeLayoutId`. Event keeps raw address fields. Organizer notified. |
| **Confirm behavior** | Sets `placeEventStatus = CONFIRMED`, `placeConfirmedAt`, `placeConfirmedBy`. Organizer notified. Venue calendar updated. |
| **Re-proposal** | If declined, the event creator can re-assign the same or different place. Status resets to `PENDING`. |
| **Place removal** | If the event creator removes `placeId`, status resets to `null` (no proposal). |
| **Published events** | An event can be published while PENDING. It just won't appear on the venue's calendar or embed until CONFIRMED. |
| **Calendar conflicts** | On confirm, warn (but don't block) if the event overlaps with another CONFIRMED event at the same venue. Blocking is a future option. |

## 6. Access control impact

| Feature | PENDING | CONFIRMED | DECLINED / No place |
|---------|---------|-----------|---------------------|
| Event is publishable | Yes | Yes | Yes |
| Shows venue name + address | Address only | Full branding | Address only |
| Access to PlaceLayout / seat maps | No | Yes | No |
| Listed on venue public calendar | No | Yes | No |
| Included in venue embed widget | No | Yes | No |
| Venue can see event details | Yes (review) | Yes | No |

## 7. Use cases

| Use case | Layer | Notes |
|----------|-------|-------|
| `proposeEventAtPlace` | Implicit in `saveEventForOrg` / `upsertEvent` when `placeId` changes | Set status to PENDING, fire notification |
| `confirmEventAtPlace` | Core | Venue owner confirms. Sets CONFIRMED + timestamps. |
| `declineEventAtPlace` | Core | Venue owner declines. Clears placeId. Notifies organizer. |
| `listPendingProposals` | Core | For venue dashboard: all PENDING events at owned places. |
| `getVenueCalendar` | Core | Only CONFIRMED events (feeds calendar UI + embed). |

## 8. Migration path

This is a **non-breaking, additive** change:

1. Add `placeEventStatus`, `placeConfirmedAt`, `placeConfirmedBy` columns.
2. Backfill all existing events that have a `placeId` to `CONFIRMED`
   (grandfather existing associations).
3. Deploy new code. Old events work as-is. New events get the proposal flow.
4. Venue dashboard and notification infra can ship incrementally.

## 9. What this is NOT

- **Not a booking system.** Venues don't manage holds, deposits, or
  contracts here. That's a separate feature if needed later.
- **Not a blocker.** Events are always valid and publishable regardless of
  proposal status. The proposal layer is about venue features, not
  event validity.
- **Not mandatory.** Places that want the old Eventbrite-style behavior can
  enable an "auto-confirm all" setting on their place record.

## 10. Payee / payout terms integration

### 10.1 Does confirmation need to create payout splits?

**Short answer: not at confirmation time, but it should prompt for them.**

The existing payout system works like this:

- `PayoutTerms` is scoped to an event (via `Event.payoutTermsId`).
- `PayoutTermsLine` rows split revenue among `Payee` records (orgs or
  humans with Stripe Connect accounts).
- The event creator sets up payout terms during event building.

The venue's role in payouts depends on the deal:

| Scenario | Payout integration |
| -------- | ------------------ |
| **Venue charges a flat rental fee** | No platform involvement. Handled off-platform. PayoutTerms unchanged. |
| **Venue takes a % of ticket revenue** | Venue's `Payee` is added as a `PayoutTermsLine` on the event's payout terms. |
| **Venue is the primary promoter** | Venue's org already owns the event. Normal payout flow. |
| **Door deal / guarantee** | Future: needs a `GuaranteeAmount` concept. Out of scope for v1. |

### 10.2 Recommended flow

1. **On confirmation**, the system does NOT auto-create payout lines.
   Revenue splits are a negotiation, not a default.
2. **After confirmation**, the venue owner sees a prompt:
   "Want to add a revenue share for this event?" This links to the
   event's payout terms editor (if the venue has permission) or sends
   a request to the event organizer.
3. **Optional: venue default terms.** A `Place` could have a
   `defaultVenuePayoutPercent` field. When the event creator picks a
   venue, the event builder could pre-fill a `PayoutTermsLine` for the
   venue's `Payee` at that percentage. The organizer can accept, modify,
   or remove it. This is a v2 feature.

### 10.3 What this means for the schema

No schema changes needed for v1. The existing `PayoutTermsLine` model
already supports adding a venue's `Payee` to any event's payout terms.
The integration is purely UX: prompting the right people at the right
time.

Future (v2):

```prisma
model Place {
  ...
  defaultVenuePayoutPercent  Int?    // e.g. 15 = 15% of net
  defaultVenuePayoutBasis    PayoutTermsBasis?
}
```

## 11. Admin UI: event proposals tab

### 11.1 Navigation entry

Add to `ADMIN_SECTIONS` in `apps/web/src/app/admin/[slug]/layout.tsx`:

```tsx
{
  id: "proposals",
  label: "Proposals",
  route: "proposals",
  icon: <Handshake size={18} />,
}
```

(`Handshake` from `lucide-react`.)

### 11.2 Page location

`apps/web/src/app/admin/[slug]/proposals/`

### 11.3 Views

**Default view: incoming proposals (venue owner perspective)**

| Column | Source |
| ------ | ------ |
| Event title | `Event.title` |
| Organizer | `Event.org.name` or `Event.human.displayName` |
| Proposed date | `Event.startsAt` — `Event.endsAt` |
| Venue | `Place.name` (for multi-venue owners) |
| Status | `placeEventStatus` badge (PENDING / CONFIRMED / DECLINED) |
| Actions | Confirm / Decline / View Event |

**Filters:**

- Status: PENDING (default), CONFIRMED, DECLINED, All
- Venue: dropdown of owned places (for multi-venue owners)
- Date range

**Outgoing proposals (event creator perspective)**

Same table, but filtered to events the current user/org created that
have a `placeId` set. Shows the venue's response status. Available
when viewing as an event-creating org.

### 11.4 Confirm/decline flow

- **Confirm**: modal with optional message to organizer. Sets
  `placeEventStatus = CONFIRMED`. Fires notification.
- **Decline**: modal with required reason (dropdown: "Date conflict",
  "Not a good fit", "Contact us directly", "Other" + free text).
  Sets `placeEventStatus = DECLINED`. Clears `placeId`. Fires
  notification to organizer.

### 11.5 Notifications

| Event | Recipients | Channel |
| ----- | ---------- | ------- |
| New proposal (placeId set on event) | Place owners / org admins | In-app + email |
| Proposal confirmed | Event creator (human or org admins) | In-app + email |
| Proposal declined | Event creator (human or org admins) | In-app + email |
| Re-proposal after decline | Place owners / org admins | In-app only |

## 12. Future extensions

- **Auto-confirm rules**: Venue sets criteria (e.g., "auto-confirm if
  organizer has 3+ past events with >80% sell-through at my venue").
- **Counter-proposals**: Venue suggests alternative dates/times.
- **Default venue payout terms**: Pre-fill a `PayoutTermsLine` when a
  venue is selected in the event builder (see section 10.3).
- **Venue calendar holds**: Reserve time slots before an event is fully
  built.
- **Proposal expiration**: Auto-decline proposals that go unreviewed for
  N days (configurable per venue).

---

*This spec should be reviewed alongside `venue-calendar.spec.md` and
`embeddable-event-widgets.spec.md` since all three features share the
concept of "venue-confirmed events."*

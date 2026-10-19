# Competitive UX Features — Spec

> Not built yet (2026-10-08 docs consolidation): #7 wallet passes blocked on Apple/Google credentials; the last item is deferred. Items 2, 4, 9 were shipped then removed

> Tracks the 10 competitive UX features identified from Eventbrite, Dice, DICE,
> and AXS analysis. Each item lists scope, data dependencies, and acceptance
> criteria.

---

## 1. "Presented by" Organizer Badge  **[SHIPPED]**

> **History note (2026-07-05):** A later redesign of `EventContent.tsx`
> silently dropped this badge along with two manipulative patterns (items 2,
> 4, 9 below). It has since been restored — as a genuinely honest,
> non-manipulative disclosure — via
> `docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml` (FR-003), which links
> internally to `/orgs/{slug}` instead of `organizer.url` (no such field
> exists on `Organization`).

**Where:** Event detail page, below title row (above meta row).

**Data:** `SeoEvent.organizer.name` and `.url` already flow through the tRPC
`getEventSeo` endpoint. `buildEventSeo` in core currently sets `organizer: null`
— to populate it, the use case must join through the event's `orgId` relation.

**Behaviour:**
- Renders a pill badge: `User` icon + "Presented by {name}".
- If `organizerHref` is present, the badge is an internal `<Link>` to
  `/orgs/{slug}` (no `target="_blank"` — it's a same-site navigation).
- When organizer data is absent, badge is not rendered.

**Props added:** `organizerName?: string | null`, `organizerHref?: string | null`
on `EventContentProps`.

**i18n:** `eventDetail.presentedBy` (`en` / `es`).

---

## 2. Low-Availability Urgency Indicators  **[SUPERSEDED — see docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml]**

> **History note (2026-07-05):** This shipped, then was silently dropped by
> a later `EventContent.tsx` redesign. It is **intentionally not coming
> back** — threshold-triggered scarcity framing ("Almost gone", red flame
> icon) is exactly the manufactured-urgency pattern the org's calm/honest UX
> stance (see the linked spec, principle P1) rejects. This is a deliberate
> non-goal, not an unfinished backlog item.

**Where:** Each ticket-type row in EventContent's tickets section.

**Data:** New optional prop `remainingCapacityMap?: Record<string, number>`.
Populated by the event detail page from a future tRPC query or by computing
`capacity - soldCount` from existing data.

**Behaviour:**
- Badge shown when remaining < 20% of total capacity OR remaining < 10.
- When remaining <= 3: shows "Almost gone" (red flame icon).
- Otherwise: "Only {count} left".
- Zero remaining tickets are handled by the existing sold-out flow.

**Props added:** `remainingCapacityMap?: Record<string, number> | null` on
`EventContentProps`.

**i18n:** `eventDetail.lowAvailability`, `eventDetail.lastFew`.

---

## 3. "More Events from This Organizer" / Related Events  **[FUTURE]**

**Where:** Below body content on event detail page, or as a separate section.

**Data:** Requires a new tRPC query: `events.listByOrg({ orgId, exclude, limit })`.
Alternatively, use the existing `localEvents` query filtered by org/category.

**Behaviour:**
- Horizontal scrollable card row of 3-6 events.
- Each card links to `"/events/{slug}"`.
- Hidden when no related events exist.
- Fallback: show events in the same category if org has fewer than 3 events.

**Backend work needed:**
1. New use case: `list-related-events.ts` in `packages/core`.
2. New tRPC procedure: `events.listRelated`.
3. Server loader: `loadRelatedEvents(eventId)` in `apps/web/src/server/events.ts`.

---

## 4. Attendee Count / Social Proof  **[SUPERSEDED — see docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml]**

> **History note (2026-07-05):** This shipped, then was silently dropped by
> a later `EventContent.tsx` redesign. It is **intentionally not coming
> back** as originally specced — a live "Flame icon + N going" pill is a
> vanity social-proof/FOMO mechanic (see the linked spec, principle P3), not
> a plain fact. This is a deliberate non-goal, not an unfinished backlog
> item.

**Where:** Event detail page, badges row (below meta row).

**Data:** `EventDailyStats.ticketsSold` or `orderCount`. New optional prop
`attendeeCount?: number | null`.

**Behaviour:**
- Shows `Flame` icon + "{count} going" pill.
- Hidden when count is 0 or null.
- Server populates from `EventDailyStats` or a direct count query.

**Props added:** `attendeeCount?: number | null` on `EventContentProps`.

**i18n:** `eventDetail.nGoing`.

---

## 5. Waitlist CTA When Sold Out  **[SHIPPED]**

**Where:** Sticky CTA bar on event detail page.

**Data:** Existing tRPC route `events.joinEventWaitlist`. New callback prop
`onJoinWaitlist?: (email: string) => Promise<void>`.

**Behaviour:**
- When `ticketAvailability === "sold_out"` and `onJoinWaitlist` is provided:
  - CTA bar shows an email input + "Join waitlist" button.
  - On submit, calls the callback.
  - On success, shows a green "You're on the waitlist" confirmation.
- When `onJoinWaitlist` is not provided, falls back to the disabled "Sold out" button.

**Props added:** `onJoinWaitlist?: (email: string) => Promise<void> | null`.

**i18n:** Reuses existing `eventDetail.joinWaitlist`, `eventDetail.onWaitlist`.
Added `eventDetail.waitlistJoining`, `eventDetail.waitlistEmailPlaceholder`.

---

## 6. "Add to Calendar" on Order Confirmation  **[SHIPPED]**

**Where:** OrderConfirmation component (`apps/web/src/app/events/checkout/[...slug]/_components/OrderConfirmation.tsx`).

**Data:** Uses existing `eventDate`, new `eventEndDate` prop, plus venue info.
Reuses existing calendar helpers: `buildGoogleCalendarUrl`, `buildOutlookCalendarUrl`,
`downloadICalFile`.

**Behaviour:**
- Section rendered between email notice and action buttons.
- Three buttons: Google Calendar, Outlook Calendar, Download .ics.
- Each pre-fills event title, date/time, and venue location.

**Props added:** `eventEndDate?: Date | null` on `OrderConfirmationProps`.

**i18n:** `confirmation.addToCalendarSection`.

---

## 7. Apple / Google Wallet Passes  **[DEFERRED — needs external config]**

**Where:** Order confirmation page and My Tickets page.

**Data:** Requires Apple Developer account (Pass Type ID certificate) and
Google Pay API credentials for Passes.

**Implementation outline:**
1. Apple: Use `passkit-generator` npm package. Needs `.p12` cert + Pass Type ID.
2. Google: Use Google Wallet API. Needs service account + issuer ID.
3. New use case: `generate-wallet-pass.ts` — takes orderId, returns pass URL/file.
4. New adapter: `WalletPassAdapter` implementing `WalletPassPort`.
5. UI: "Add to Apple Wallet" / "Add to Google Wallet" buttons on confirmation.

**Status:** Blocked on Apple/Google credential setup.

---

## 8. Refund Policy Disclosure  **[SHIPPED]**

> **History note (2026-07-05):** A later redesign of `EventContent.tsx`
> silently dropped this section along with item 1 above. It has since been
> restored via `docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml` (FR-004),
> unchanged in intent — a plain factual disclosure with no urgency framing.
>
> **Correction (2026-07-05, round 2):** The first restoration fabricated a
> static "N hours before event" cutoff sourced from a dead
> `INSTANT_REFUND_CUTOFF_HOURS` constant with zero call sites in the real
> refund-enforcement path. The actual, live deadline
> (`packages/core/src/use-cases/orders/get-refund-eligibility.ts`) is
> `event.refundCutoffAt ?? event.startsAt` — an absolute, organizer-settable
> datetime, not an hours-before-event window. The section below reflects the
> corrected implementation.

**Where:** Event detail page, after tickets section in logistics block.

**Data:** New optional prop `refundCutoffAt?: string | null` (ISO datetime),
threaded from `EventRecord.refundCutoffAt` through `getEventSeo` /
`PublicSeoEvent`. `null` means the organizer never overrode it — the real
enforced deadline then defaults to the event's own `startsAt`.

**Behaviour:**
- When `refundCutoffAt` is omitted/undefined: section is hidden entirely
  (RSVP/community listings have no ticketing, so no refund policy applies).
- When `refundCutoffAt` is `null` (no organizer override): shows shield icon
  + "Full refund available until this event starts."
- When `refundCutoffAt` is an ISO datetime earlier than `startsAt` (organizer
  set a custom, earlier cutoff): shows "Full refund available until
  {formatted date/time}."

**Props added:** `refundCutoffAt?: string | null` on `EventContentProps`.

**i18n:** `eventDetail.refundPolicySection`, `eventDetail.refundPolicyUntilStart`,
`eventDetail.refundPolicyUntilDate`.

---

## 9. Countdown Timer for Imminent Events  **[SUPERSEDED — see docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml]**

> **History note (2026-07-05):** This shipped, then was silently dropped by
> a later `EventContent.tsx` redesign. It is **intentionally not coming
> back** — a red countdown pill ("Starts in N hours") is exactly the
> countdown-styling/urgency-copy pattern the org's calm/honest UX stance
> (see the linked spec, principle P1) rejects. This is a deliberate
> non-goal, not an unfinished backlog item.

**Where:** Event detail page, badges row.

**Data:** Computed client-side from `startsAt`.

**Behaviour:**
- `> 24 hours before start`: hidden.
- `1-24 hours before`: "Starts in {n} hours" (red pill with timer icon).
- `< 1 hour before`: "Starts in {n} minutes".
- `0-4 hours after start`: "Happening now".
- `> 4 hours after start`: hidden.

**i18n:** `eventDetail.startsInHours`, `eventDetail.startsInMinutes`,
`eventDetail.happeningNow`.

---

## 10. Structured "About the Organizer" Mini-Card  **[FUTURE]**

**Where:** Below body content or in a dedicated section.

**Data:** Requires enriching organizer data beyond name/URL — e.g., avatar,
bio, total events hosted, social links.

**Implementation outline:**
1. Extend `SeoOrganizerInput` with optional fields: `avatarUrl`, `bio`,
   `eventCount`, `socials`.
2. New use case: `get-organizer-public-profile.ts`.
3. UI: Card with avatar, name, bio, event count, and "View all events" link.

**Status:** Deferred to a future sprint; requires new data model + API work.

---

## Testing Checklist

| Feature | Unit test | Integration test | E2E test |
|---------|-----------|-----------------|----------|
| 1. Organizer badge | Render with/without data | — | Visual check |
| 2. Low availability | Threshold math + badge render | — | Seed low-cap ticket |
| 3. Related events | Use case test | tRPC smoke | Visual check |
| 4. Attendee count | Render with count=0/50/1000 | — | — |
| 5. Waitlist CTA | Submit flow + success state | tRPC integration | E2E signup |
| 6. Confirmation calendar | Render 3 buttons, URLs correct | — | Visual check |
| 7. Wallet passes | Pass generation unit test | — | Manual |
| 8. Refund policy | Render with hours=4/0/null | — | Visual check |
| 9. Countdown | Time-based label computation | — | — |
| 10. Organizer card | — | — | — |

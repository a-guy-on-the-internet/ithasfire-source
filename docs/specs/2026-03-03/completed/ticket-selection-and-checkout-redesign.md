# Ticket Selection & Checkout Redesign

**Status:** complete  
**Date:** 2026-02-19  
**Branch:** `chore/remove-core-template-shims` (or new feature branch)

---

## 1. Overview

Redesign the public ticket-buying experience from event detail through payment confirmation. The current flow dumps users onto a narrow, left-aligned checkout page with a basic list of ticket types and a sidebar summary. The goal is a Ticketmaster-inspired layout: immersive, centered, and professional — with a venue seat map as the centerpiece when one exists, falling back to GA-style ticket type blocks when it doesn't.

---

## 2. User Journey (3 screens)

### Screen 1: Event Detail (`/events/{slug}`)

**Purpose:** Marketing page. Convince the user to buy.

**Existing file:** `apps/web/src/app/events/[...slug]/_components/EventDetail.tsx` (416 lines, client component)

**What exists today:**
- Hero image (2:1 aspect, rounded-2xl) or placeholder
- Title (h1, 3xl/4xl), description, meta row (date, location, price)
- Lineup label
- "Get tickets" CTA button linking to `/events/checkout/{slug}`
- Body content rendered via `EventPageRenderer` (rich text with embedded images)
- Details grid: left column (ticket types list, lineup), right sidebar (schedule, location with map, pricing, organizer)

**Required changes:** Minimal — this page is in decent shape. The CTA should remain a simple link to the ticket selection page. No ticket selection logic belongs here.

**One optional improvement:** The ticket type rows on this page are read-only info. Consider removing them entirely from the event detail page (they duplicate what's on the selection page) or making them clickable cards that link to checkout with a query param pre-selecting that ticket type.

---

### Screen 2: Ticket Selection (`/events/checkout/{slug}`) — THE MAIN REDESIGN

**Purpose:** Select tickets and hold them. This is where 90% of the work goes.

**Existing files:**
- `apps/web/src/app/events/checkout/[...slug]/page.tsx` (server component, 59 lines)
- `apps/web/src/app/events/checkout/[...slug]/_components/Checkout.tsx` (client component, 547 lines)

#### 2a. Layout Architecture

The page currently renders inside `AppShell > MainContent` (max-width 1440px, paddingHorizontal $6). The `Checkout` component adds its own `max-w-4xl mx-auto` wrapper. This creates a narrow, left-biased layout on wide screens.

**New layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  AppNavbar (existing, unchanged)                                │
├─────────────────────────────────────────────────────────────────┤
│  Compact event info bar (event name, date, back link)           │
├──────────────────────────┬──────────────────────────────────────┤
│                          │                                      │
│   Ticket type blocks     │   Order summary sidebar              │
│   (centered grid)        │   (sticky, 340–380px wide)           │
│                          │                                      │
│   OR future seat map     │   - Selected items list              │
│                          │   - Subtotal / fees                  │
│                          │   - Hold countdown                   │
│                          │   - CTA button                       │
│                          │                                      │
├──────────────────────────┴──────────────────────────────────────┤
│  Mobile: sticky bottom bar (qty badge + subtotal + CTA)         │
└─────────────────────────────────────────────────────────────────┘
```

**Responsive behavior:**
- **Desktop (lg+):** Two-column layout. Main content area fills remaining width. Sidebar is fixed 340–380px, sticky to viewport top.
- **Tablet (md):** Same two-column but sidebar narrows slightly.
- **Mobile (<md):** Single column. Ticket blocks stack full-width. Sidebar becomes a sticky bottom bar (fixed to bottom of viewport) showing: total qty pill, subtotal, and CTA button. Tapping the bar or CTA scrolls to / reveals a slide-up summary sheet.

#### 2b. Compact Event Info Bar (replaces the current hero card)

The current design has a large hero card with image + event info taking ~200px of vertical space. Replace with a slim, full-width info bar:

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Back to event    |  EVENT NAME  •  Mon, Feb 23 · 8:00 PM    │
│                      |  Venue Name                    ⏱ 4:32    │
└─────────────────────────────────────────────────────────────────┘
```

- Left: Back arrow + "Back to event" link (to `/events/{slug}`)
- Center/left: Event name (truncated if long), date + time, venue name — all compact, single or two lines
- Right: Hold countdown timer (only visible after tickets are held), pill style like current design
- Height: ~60-72px max. No hero image. No step indicators.
- Border-bottom with subtle `border-foreground/[0.06]`

#### 2c. Ticket Type Blocks (GA mode — no seat map)

When the event has no place layout (which is currently always the case), render ticket types as **cards in a grid**, not as a flat list.

Each card:
```
┌─────────────────────────────────┐
│  TICKET TYPE NAME               │
│  $45.00                         │
│  23 remaining                   │
│                                 │
│  ┌───┐ ┌───┐ ┌───┐             │
│  │ - │ │ 0 │ │ + │             │
│  └───┘ └───┘ └───┘             │
└─────────────────────────────────┘
```

- Grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3` (2 columns is fine for most events with 2-5 ticket types; 3 on extra-wide)
- Card has rounded-xl border, subtle background when selected (`bg-foreground/[0.025]`)
- Card highlight: when qty > 0, add a left accent border (2-3px, `bg-foreground`) or a subtle ring
- Ticket name: bold, 15-16px
- Price: bold, tabular-nums
- Availability: muted text, smaller. "Sold out" state dims the entire card + disables stepper
- Qty stepper: connected minus/count/plus buttons at bottom of card. Same connected-button design as current (rounded-l/rounded-r with shared borders). Centered in the card.
- No "section heading" with a circled "1" — just the cards.

**Future seat map placeholder:** Leave a clear code seam so that when a public `getPlaceLayout` endpoint exists, the center area can swap to a `<SeatMapPicker>` component. Add a `// TODO: seat map mode` comment and structure the component so the center content is conditionally rendered:

```tsx
{hasPlaceLayout ? (
  <SeatMapPicker layout={layout} onSeatSelect={...} />
) : (
  <TicketTypeGrid ticketTypes={ticketTypes} quantities={quantities} onChange={handleQuantityChange} />
)}
```

#### 2d. Order Summary Sidebar (desktop)

Sticky sidebar on the right. Only visible on `lg+` screens.

Structure:
1. **Header:** "Order summary" text, no step indicator circle
2. **Line items:** Each selected ticket type as a row: `2× GA Admission    $90.00`
3. **Subtotal line:** After a dashed divider
4. **Service fees line:** "Calculated at checkout" until order is held, then actual amount
5. **Total line** (bold, larger): After solid divider. Only shown after hold succeeds.
6. **Hold countdown:** If active, show inline with clock icon and countdown. Expired state in red.
7. **CTA button:** Full-width, `bg-foreground text-background`, rounded-xl. 
   - Before selection: disabled, "Select tickets"
   - After selection, before hold: "Hold {n} ticket(s)"  
   - While mutating: spinner + "Reserving..."
   - After hold: "Proceed to payment" (this will call `createCheckout` in Phase 2)
   - Expired: "Re-select tickets" (resets state)
8. **Trust bar:** "Secure checkout · Instant confirmation" with ShieldCheck icon, muted

#### 2e. Mobile Sticky Bottom Bar

On screens `< lg`, hide the sidebar entirely and show a fixed-bottom bar:

```
┌─────────────────────────────────────────────────────┐
│  🎫 2 tickets  ·  $90.00          [ Hold tickets ]  │
└─────────────────────────────────────────────────────┘
```

- Fixed to bottom, `z-50`, safe-area padding for iOS
- Left: ticket count + subtotal
- Right: CTA button (same label logic as sidebar)
- Background: `bg-background` with top border and subtle shadow (`shadow-[0_-2px_8px_rgba(0,0,0,0.06)]`)
- When no tickets selected: bar is hidden or shows "Select tickets to continue" in muted text
- Account for `MobileBottomNav` height — this bar sits ABOVE it, or replaces it on checkout pages

#### 2f. Error Handling

- Error banner: below the event info bar, full-width, same red styling as current but not inside the sidebar
- Auth gate: if user clicks CTA while not signed in, trigger `showSignInOverlay` (existing behavior, keep it)
- Hold expiry: show inline in sidebar countdown + in the info bar. When expired, disable CTA, show message.

#### 2g. Cart Recovery / Resume

Existing logic with `resumeOrderId` query param and `useCartRecovery` should continue working. When resuming:
- Pre-populate quantities from the resumed order (existing logic)
- Show the countdown immediately
- Highlight the pre-selected ticket type cards

---

### Screen 3: Payment (future — out of scope for this ticket but design for it)

After the hold succeeds, the next step is payment. The `createCheckout` use case already exists and returns `{ orderId, clientSecret }`.

**Two options (decide later):**
1. **Stripe Checkout redirect:** Call `createCheckout`, get a Stripe Checkout Session URL, redirect. Simplest.
2. **Embedded Stripe Elements:** Use the `clientSecret` with `@stripe/react-stripe-js` to render a payment form inline on the same page, below the summary.

For now, the CTA after hold should say "Proceed to payment" and be wired to call `createCheckout` → redirect to Stripe Checkout. This is a ~20 line addition to the existing component.

---

## 3. File Inventory

### Files to modify

| File | What to do |
|------|-----------|
| `apps/web/src/app/events/checkout/[...slug]/_components/Checkout.tsx` | **Full rewrite of the render output.** Keep all existing state management, mutations, hooks, and business logic. Replace the JSX return with the new layout described above. Extract sub-components (see below). |
| `apps/web/src/app/events/checkout/[...slug]/page.tsx` | Remove `max-w-4xl` constraint. Let the component fill the `MainContent` container (1440px). Minimal padding changes. |
| `apps/web/src/components/layout/AppChrome.tsx` | Possibly: on checkout routes, hide `MobileBottomNav` since the checkout has its own sticky bottom bar. Check `isCheckoutPage` flag — it's already detected but only used for `CartRecoveryProvider`. |

### New files to create

| File | Purpose |
|------|---------|
| `apps/web/src/app/events/checkout/[...slug]/_components/TicketTypeGrid.tsx` | Presentational component: ticket type card grid. Props: `ticketTypes`, `quantities`, `onQuantityChange`, no business logic. |
| `apps/web/src/app/events/checkout/[...slug]/_components/CheckoutInfoBar.tsx` | Compact event info bar at top. Props: `event` (name, date, venue), `countdown`, `backHref`. |
| `apps/web/src/app/events/checkout/[...slug]/_components/OrderSummary.tsx` | Sidebar order summary. Props: `ticketTypes`, `quantities`, `order`, `countdown`, `isExpired`, `isPending`, `onSubmit`, `selectedQty`, `subtotalCents`. |
| `apps/web/src/app/events/checkout/[...slug]/_components/MobileCheckoutBar.tsx` | Sticky bottom bar for mobile. Props: `selectedQty`, `subtotalCents`, `isPending`, `onSubmit`, `disabled`. |

### Files to NOT touch

| File | Reason |
|------|--------|
| `apps/web/src/app/events/[...slug]/_components/EventDetail.tsx` | Event detail page. Not part of this ticket. |
| `packages/core/src/use-cases/orders/update-order-items.ts` | Business logic is correct. No changes needed. |
| `packages/core/src/use-cases/orders/create-checkout.ts` | Will be called from the frontend in Phase 2 but the use case itself doesn't change. |
| `packages/transport/trpc/src/routers/orders.ts` | Transport layer is fine. |
| `apps/web/src/hooks/useCartRecovery.ts` | Cart recovery hooks are fine. |

---

## 4. Data Contracts (no backend changes)

All data is already available. No new tRPC endpoints or use cases needed.

### Checkout page server component receives:

```typescript
// From loadEventSeo(slug) — SeoEvent shape:
{
  id: string;
  slug: string;
  url: string;
  name: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  status: EventStatus;  // "DRAFT" | "PUBLISHED" | "CANCELLED" | "COMPLETED"
  ticketingUrl?: string | null;
  images: string[];       // hero image at index 0
  location?: {
    name?: string;
    addressLine1?: string;
    city?: string;
    region?: string;
    // ... full SeoLocation
    latitude?: number;
    longitude?: number;
  };
  organizer?: { name?: string; url?: string };
  pricing?: {
    currency: string;
    minPriceCents?: number;
    maxPriceCents?: number;
    availability: "in_stock" | "limited" | "sold_out" | "preorder";
  };
}
```

### Ticket types (from `listEventTicketTypes` tRPC query):

```typescript
{
  id: string;          // UUID
  name: string;        // e.g. "General Admission", "VIP"
  priceCents: number;  // integer cents, e.g. 4500 = $45.00
  capacity: number;    // remaining capacity (0 = sold out)
  seatSectionId: string | null;  // null for GA, UUID for seated
}
```

### `updateOrderItems` mutation input/output:

```typescript
// Input
{
  eventId: string;
  orderId?: string;     // omit on first call, include to update existing hold
  items: Array<{
    ticketTypeId: string;
    qty: number;        // positive integer
    seatIds?: string[]; // for seated events (future)
  }>;
}

// Output
{
  order: {
    id: string;
    eventId: string;
    buyerHumanId: string;
    amountGrossCents: number;
    feesPlatformCents: number;
    currency: string;
    status: "PENDING" | "CONFIRMED" | ...;
    items: Array<{
      id: string;
      kind: "ticket";
      ticketTypeId: string;
      qty: number;
      unitPriceCents: number;
      amountCents: number;
      meta: {};
    }>;
  };
  holdExpiresAt: string;  // ISO datetime
}
```

### `createCheckout` mutation (for Phase 2):

```typescript
// Input
{
  orderId: string;
  currency?: string;
  items: Array<{ ticketTypeId: string; qty: number; seatIds?: string[] }>;
  couponCodes?: string[];
}

// Output
{
  orderId: string;
  clientSecret: string | null;  // Stripe PaymentIntent client secret
}
```

---

## 5. Styling & Design System

### Tokens (from `globals.css`)

```css
--background: #ffffff;          /* dark: #0a0a0a */
--foreground: #171717;          /* dark: #ededed */
--font-body: Neuton;
--font-mono: IBM Plex Mono;
```

### Tailwind utilities to use

- Backgrounds: `bg-background`, `bg-foreground`, `bg-foreground/[0.02]`, `bg-foreground/[0.04]`
- Borders: `border-foreground/[0.06]`, `border-foreground/[0.08]`, `border-foreground/[0.12]`
- Text: `text-foreground`, `text-foreground/55`, `text-foreground/40`, `text-foreground/35`
- Cards: `rounded-xl` or `rounded-2xl`, subtle border, no heavy shadows
- Buttons: primary = `bg-foreground text-background rounded-xl`, disabled = `opacity-35`
- Spacing: use Tailwind spacing scale (`gap-4`, `gap-6`, `p-5`, etc.)
- Dark mode: handled automatically via CSS variables. Do NOT use `dark:` modifiers — all colors use opacity on `foreground`/`background` which auto-invert.
- Icons: `lucide-react` only. Common sizes: 12, 14, 16, 20, 24.

### Typography

- Headings: `font-bold tracking-tight`
- Body: default weight
- Labels: `text-xs font-semibold uppercase tracking-widest text-foreground/40`
- Prices: `font-bold tabular-nums`
- Monospace (countdown): `font-mono tabular-nums` or use the `--font-mono` variable

### Component patterns from existing codebase

- Connected stepper buttons: `rounded-l-lg` / `rounded-r-lg` with shared `border-y` count display (see current `Checkout.tsx` lines 365-395)
- Muted metadata with icons: `<span className="inline-flex items-center gap-1.5"><Icon size={14} className="text-foreground/40" /> Text</span>`
- Section labels: `<h2 className="text-xs font-semibold uppercase tracking-widest text-foreground/40">LABEL</h2>`

---

## 6. Behavior Specification

### State machine

```
IDLE (no tickets selected)
  → user adjusts qty → SELECTING (quantities > 0, no hold yet)
  → user clicks CTA →
    → not signed in? → show sign-in overlay, return to SELECTING after auth
    → signed in? → call updateOrderItems → HOLDING

HOLDING (hold active, countdown running)
  → user adjusts qty → re-enters SELECTING (can re-hold with updated quantities)
  → countdown expires → EXPIRED
  → user clicks "Proceed to payment" → call createCheckout → redirect to Stripe

EXPIRED
  → user adjusts qty → back to SELECTING
  → user clicks CTA → re-hold with current quantities → HOLDING
```

### Countdown timer

- Starts when `holdExpiresAt` is set (after successful `updateOrderItems`)
- Ticks every 1 second, displays `M:SS` format
- At 0 → shows "Expired" state
- Displayed in: info bar (always visible), sidebar (desktop), bottom bar (mobile)

### Auth gate

- If user clicks CTA while not authenticated, call `showSignInOverlay({ redirect: currentUrl })`
- After sign-in completes, user returns to the same page with their selections preserved (quantities are in React state)

### Cart release

- `useCartRelease(orderId, eventId)` — existing hook. Sends `sendBeacon` on page unload to release hold.
- Keep this behavior unchanged.

### Cart recovery / resume

- If URL has `?resumeOrderId=xxx`, fetch the active cart via `trpc.orders.getActiveCartHolds`
- Pre-populate quantities and countdown from the resumed order
- If the resumed order is expired or not found, show error message and let user start fresh

---

## 7. Acceptance Criteria

- [ ] Checkout page is horizontally centered on all screen sizes
- [ ] On desktop (lg+): two-column layout with ticket grid on left, sticky order summary sidebar on right
- [ ] On mobile (<lg): single column with ticket cards stacked, sticky bottom bar with qty + subtotal + CTA
- [ ] Ticket types render as cards in a responsive grid, not a flat list
- [ ] Selected ticket cards have a visual highlight (accent border or ring)
- [ ] Sold-out ticket types are visually dimmed with disabled stepper
- [ ] Compact info bar at top replaces the large hero card (no image, just text)
- [ ] Hold countdown is visible in the info bar and sidebar/bottom bar
- [ ] CTA button label changes dynamically based on state (select → hold → payment → expired)
- [ ] Error messages display prominently below the info bar, not buried in the sidebar
- [ ] Existing business logic preserved: `updateOrderItems` mutation, auth gate, cart recovery, cart release
- [ ] No new tRPC endpoints or backend changes required
- [ ] Dark mode works correctly (all colors use foreground/background opacity tokens)
- [ ] No regressions to event detail page
- [ ] Code is structured with clear seam for future seat map integration

---

## 8. Out of Scope (Future Work)

- **Public seat map picker:** Requires a new public `getPlaceLayout` endpoint (current one is admin-only behind `authedProcedure`). Design the code seam but don't implement.
- **Stripe Elements embedded payment:** The `createCheckout` use case returns a `clientSecret`. A future phase can embed `<PaymentElement>` on-page instead of redirecting to Stripe Checkout.
- **Coupon code input:** The `createCheckout` input supports `couponCodes` but there's no UI for it yet. Can be added to the sidebar later.
- **Seat selection for seated events:** `updateOrderItems` input supports `seatIds` per item. Wire this up when the seat map picker exists.
- **Mobile bottom nav conflict:** Currently `MobileBottomNav` renders on all pages inside `AppShell`. The checkout sticky bar may need to suppress it. Check `AppChrome.tsx` — it already detects `isCheckoutPage`. May need to pass this down or add a checkout-specific layout.

---

## 9. Testing

### Manual smoke test

1. Navigate to a published event detail page → click "Get tickets"
2. Verify checkout page loads centered, with ticket type cards in a grid
3. Select quantities for multiple ticket types → verify cards highlight, sidebar/bottom bar updates
4. Click CTA while signed out → verify sign-in overlay appears
5. Sign in → verify quantities are preserved
6. Click CTA while signed in → verify hold is created, countdown starts
7. Adjust quantities while hold is active → verify mutation fires again
8. Wait for hold to expire → verify expired state in UI
9. Test on mobile viewport → verify sticky bottom bar behavior
10. Test dark mode → verify all colors invert correctly
11. Test cart recovery: navigate away, come back via cart recovery banner → verify `?resumeOrderId` flow
12. Test with 0 ticket types → verify "Tickets aren't on sale yet" empty state

### Unit tests

No new business logic is being added, so no new unit tests are required. The existing `update-order-items.test.ts` and `create-checkout.test.ts` cover the backend.

### E2E test (optional)

If time permits, add a Playwright spec in `apps/web/e2e/checkout-selection.spec.ts` that:
1. Navigates to a seeded event's checkout page
2. Selects tickets via the grid
3. Verifies the sidebar updates
4. (Does not attempt payment — just validates the selection UI)

---

## 10. Implementation Notes

### Extracting sub-components

The current `Checkout.tsx` is 547 lines with all logic and render in one component. Split into:

1. **`Checkout.tsx`** — orchestrator. Owns all state (`quantities`, `orderId`, `order`, `holdExpiresAt`, etc.), mutations, and effects. Renders the layout shell and passes props down to:
2. **`CheckoutInfoBar.tsx`** — pure presentational. ~40-60 lines.
3. **`TicketTypeGrid.tsx`** — pure presentational. ~80-120 lines. Renders the card grid with steppers.
4. **`OrderSummary.tsx`** — pure presentational. ~100-140 lines. Desktop sidebar with line items, totals, CTA.
5. **`MobileCheckoutBar.tsx`** — pure presentational. ~40-60 lines. Sticky bottom bar.

### Preserving existing hooks

These must remain in the orchestrator (`Checkout.tsx`):
- `useAppOverlay()` — for auth gate
- `useCurrentUrl()` — for redirect after sign-in
- `useCartRelease(orderId, eventId)` — for beacon on unload
- `trpc.orders.updateOrderItems.useMutation()` — hold mutation
- `trpc.orders.getActiveCartHolds.useQuery()` — cart resume
- `trpc.entityPages.getByOwner.useQuery()` — auth check

### Currency formatting

Keep the existing `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })` formatter. In the future this should use the event's actual currency from `order.currency` or `event.pricing.currency`, but USD-only is fine for now.

### Container width

The checkout page server component (`page.tsx`) should remove its `max-w-4xl` constraint and let the content fill the `MainContent` container (1440px max). The two-column grid within `Checkout.tsx` will handle its own width distribution.

```tsx
// page.tsx — simplified
return (
  <div className="flex w-full flex-col">
    <Checkout event={eventData} ticketTypes={ticketTypes.ticketTypes} resumeOrderId={resumeOrderId} />
  </div>
);
```

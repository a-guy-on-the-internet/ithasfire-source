# Deferred Payment Capture

> **Status**: Design (RFC)
> **Created**: 2026-02-16
> **Authors**: Engineering Team

## Motivation

When an organizer reschedules or cancels events in a recurring series, all purchased tickets need refunds. With the current `capture_method: "automatic_async"` flow, every captured charge that gets refunded burns the processing fee — Stripe keeps its cut regardless. Over a series of 12 weekly events, a single schedule tweak can cost dozens of processing fees that the platform eats.

**Goal**: Defer payment capture until the event date. Uncaptured authorizations can be **cancelled for free** (no processing fee lost). If a buyer resells their ticket, capture immediately so the seller gets paid.

## Stripe Constraints

| Feature | Default capture window | Extended auth window |
| --- | --- | --- |
| `capture_method: "manual"` (cards) | **7 days** | Up to **31 days** with `request_extended_authorization: "if_available"` (Visa/Mastercard only; other brands fall back to 7 days) |
| Cash App Pay, other non-card methods | 7 days | Not available |
| After window expires | PaymentIntent auto-cancels, hold released | Same |

**Critical constraint**: Even with extended auth, **31 days is the maximum hold**. Events further than ~30 days out cannot rely on a single manual-capture hold. Options:

1. **Capture immediately** if event is > 30 days away (current behavior, refund if needed).
2. **Authorize close to the event** — delay the PaymentIntent creation itself. The buyer "reserves" tickets but isn't charged until ~7 days before the event. This is riskier (card may decline later) but avoids holds entirely.
3. **Hybrid**: manual capture for events within 30 days; immediate capture for events further out. Organizer cancellations on far-future events still incur refund fees, but those are rarer (series events tend to repeat weekly/biweekly).

**Recommended approach: Option 3 (Hybrid).**

## Design

### Capture strategy decision

```text
if event.startsAt <= now + 30 days:
    captureMethod = "manual"
    requestExtendedAuth = "if_available"
else:
    captureMethod = "automatic_async"   # current behavior
```

This is decided at **checkout time** inside `createCheckout` and passed down to the payment adapter.

### New PaymentIntent states

```text
Order.captureStrategy: "IMMEDIATE" | "DEFERRED"
Order.captureAt: DateTime?          # scheduled capture time (null = already captured)
Order.capturedAt: DateTime?         # actual capture time
```

- `IMMEDIATE` — charge captured at checkout (events > 30 days out, or non-card methods).
- `DEFERRED` — hold placed, capture scheduled for `event.startsAt - 24h` (gives a 24h buffer before the event).

### Port changes

```typescript
// PaymentProcessorPort.createPaymentIntent — add optional captureMethod
createPaymentIntent(input: {
  amountCents: number;
  currency: string;
  metadata?: Record<string, string>;
  captureMethod?: "automatic" | "manual";         // NEW
  requestExtendedAuthorization?: boolean;          // NEW
}): Promise<{ paymentIntentId: string; clientSecret: string }>;

// NEW method
capturePaymentIntent(input: {
  paymentIntentId: string;
  amountToCaptureCents?: number;   // partial capture support
}): Promise<{ captured: boolean; amountCapturedCents: number }>;
```

### Adapter changes (Stripe)

```typescript
// stripe-adapter.ts
async createPaymentIntent(input) {
  const pi = await this.stripe.paymentIntents.create({
    amount: input.amountCents,
    currency: input.currency,
    metadata: input.metadata,
    capture_method: input.captureMethod ?? "automatic_async",
    ...(input.requestExtendedAuthorization && {
      payment_method_options: {
        card: { request_extended_authorization: "if_available" },
      },
    }),
  });
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret! };
}

async capturePaymentIntent(input) {
  const pi = await this.stripe.paymentIntents.capture(
    input.paymentIntentId,
    input.amountToCaptureCents
      ? { amount_to_capture: input.amountToCaptureCents }
      : undefined,
  );
  return {
    captured: pi.status === "succeeded",
    amountCapturedCents: pi.amount_received,
  };
}
```

### Checkout flow changes (`createCheckout`)

```text
1. Look up event.startsAt
2. Determine captureStrategy:
     withinCaptureWindow = event.startsAt <= now + 30 days
     captureMethod = withinCaptureWindow ? "manual" : "automatic_async"
3. Create PaymentIntent with chosen captureMethod
4. Store captureStrategy + captureAt on Order:
     if captureMethod === "manual":
       order.captureStrategy = "DEFERRED"
       order.captureAt = event.startsAt - 24h
     else:
       order.captureStrategy = "IMMEDIATE"
       order.captureAt = null
       order.capturedAt = now
```

### Scheduled capture job

A new Cloud Run job (or cron task in `apps/jobs`):

```text
captureOrders job — runs every hour
  1. SELECT orders WHERE captureStrategy = 'DEFERRED'
       AND captureAt <= now
       AND capturedAt IS NULL
       AND status = 'CONFIRMED'
  2. For each order:
       a. Call paymentProcessor.capturePaymentIntent(order.paymentIntentId)
       b. If success: set order.capturedAt = now
       c. If payment_intent_expired / card_declined:
            - Mark order as FAILED_CAPTURE
            - Release tickets back to inventory
            - Notify buyer: "Your payment could not be captured"
            - Audit log entry
```

Idempotency: the job is safe to retry — `capturedAt IS NULL` guard prevents double-capture. The `capturePaymentIntent` call is itself idempotent on Stripe's side.

### Cancellation / schedule change flow

When an organizer cancels or reschedules a series occurrence:

```text
For each order on the affected event:
  if order.captureStrategy === "DEFERRED" && !order.capturedAt:
    → Cancel the PaymentIntent (FREE, no processing fee)
    → Mark order as CANCELLED
    → Release tickets
    → Notify buyer: "Event cancelled, your hold has been released"

  if order.captureStrategy === "IMMEDIATE" || order.capturedAt:
    → Refund the charge (processing fee is lost)
    → Mark order as REFUNDED
    → Release tickets
    → Notify buyer: "Event cancelled, refund issued"
```

This is the key win: events within the 30-day window that get cancelled or rescheduled **avoid processing fees entirely** because the hold is simply released.

### Resale / transfer trigger

When a ticket is resold or transferred:

```text
1. Capture the original buyer's payment immediately
     (so the seller's payout can be calculated and transferred)
2. Create a new PaymentIntent for the new buyer
     (with the same deferred/immediate logic based on event date)
3. Mark original OrderItem as "transferred"
4. Create new Order + OrderItem for the new buyer
```

Resale capture is immediate because money needs to flow to the seller.

### Organizer prompt on series changes

When an organizer edits a series schedule (via `updateEventSeries` or occurrence-level changes):

```text
1. Identify affected occurrences (GENERATED/PUBLISHED with events that have orders)
2. For each affected event, count:
     - deferredOrders: orders with captureStrategy = "DEFERRED" && !capturedAt
     - capturedOrders: orders with captureStrategy = "IMMEDIATE" || capturedAt
3. Show confirmation dialog:
     "This change affects N events with ticket sales.
      • X orders will have their holds released (no charge)
      • Y orders will require refunds (processing fees will be lost)
      Are you sure you want to proceed?"
4. On confirm → execute cancellations/refunds
5. On cancel → no changes
```

## Schema changes (Prisma)

```prisma
enum CaptureStrategy {
  IMMEDIATE
  DEFERRED
}

model Order {
  // ... existing fields ...
  captureStrategy   CaptureStrategy @default(IMMEDIATE)
  captureAt         DateTime?       // when to capture (DEFERRED only)
  capturedAt        DateTime?       // when actually captured
}
```

## Migration plan

1. Add `captureStrategy`, `captureAt`, `capturedAt` columns to `Order` (default `IMMEDIATE`, null, null).
2. Backfill existing orders: all get `captureStrategy = IMMEDIATE`, `capturedAt = createdAt`.
3. Update `PaymentProcessorPort` interface + Stripe adapter.
4. Update `createCheckout` to calculate strategy.
5. Build capture job in `apps/jobs`.
6. Update cancellation/refund flows.
7. Build organizer confirmation UI for series changes.
8. Add resale capture trigger (when resale is implemented).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Card declined at capture time (7-31 days later) | Notify buyer immediately, release tickets back to inventory, show "payment failed" in order history |
| Extended auth not available (non-Visa/MC) | Graceful fallback: 7-day window still works for most weekly events |
| Event > 30 days out still needs refund on cancel | Accept this tradeoff; most series events are weekly/biweekly (within window) |
| Buyer disputes hold on their statement | Stripe handles auth holds differently from charges; banks typically don't allow disputes on pending auths |
| Job downtime misses capture window | Alert on orders with `captureAt` in the past + `capturedAt IS NULL`; manual capture via admin tool |

## Out of scope (future)

- **Option 2 (delayed authorization)**: Don't create PaymentIntent until close to event. Requires "reservation" model, card-on-file with SetupIntent, and decline handling. Much more complex.
- **Partial capture**: Capture less than the authorized amount (e.g., if ticket price drops). Stripe supports this but adds complexity.
- **Multi-currency**: Extended auth availability varies by region. Needs testing.

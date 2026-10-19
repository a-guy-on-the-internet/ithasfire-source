# Stripe PI Cleanup for Expired & Released Carts

**Status:** complete
**Date:** 2026-02-16
**Related:** `platform-commerce-admin.spec.md` (section 3.3), `place-verification-review.spec.md`

## 1. Problem

When a cart hold expires or the buyer explicitly abandons checkout, the PENDING
order is canceled and seat holds are released. However, the associated Stripe
Payment Intent is **never canceled**. This leaves orphaned PIs in Stripe in
`requires_payment_method` state indefinitely.

### Impact

- Clutters the Stripe dashboard, making reconciliation harder.
- A buyer who still has the `clientSecret` could theoretically confirm the PI
  after the hold has expired and seats have been released (unlikely but possible).
- Makes it difficult to distinguish genuinely active checkouts from stale ones
  in Stripe reporting.

### Current code paths

| Path | Cancels order? | Releases seats? | Cancels PI? |
| --- | --- | --- | --- |
| `releaseCartHold` (buyer abandons) | Yes | Yes | **No** |
| `release-expired-holds` (cron) | No (seats only) | Yes | **No** |
| Buyer completes payment | N/A (SUCCEEDED) | N/A | N/A |

## 2. Solution

### 2.1 New port method: `cancelPaymentIntent`

Add to `PaymentProcessorPort`:

```typescript
cancelPaymentIntent(input: {
  paymentIntentId: string;
}): Promise<{ canceled: boolean }>;
```

### 2.2 Stripe adapter implementation

```typescript
async cancelPaymentIntent({ paymentIntentId }: { paymentIntentId: string }) {
  try {
    await this.s.paymentIntents.cancel(paymentIntentId);
    return { canceled: true };
  } catch (err: unknown) {
    // PI already succeeded, captured, or canceled — safe to ignore
    if (
      typeof err === "object" && err !== null &&
      "code" in err && err.code === "payment_intent_unexpected_state"
    ) {
      return { canceled: false };
    }
    throw err;
  }
}
```

The `payment_intent_unexpected_state` error fires when the PI is in a terminal
state (succeeded, canceled, requires_capture). We swallow it because the goal —
preventing future confirmation — is already achieved.

### 2.3 Integration point 1: `releaseCartHold`

**File:** `packages/core/src/use-cases/orders/release-cart-hold.ts`

After `cancelPendingOrder` succeeds and `order.stripePaymentIntentId` is set,
call `cancelPaymentIntent` as **best-effort** (log failure, don't throw).

Changes:
- Add `payments: Pick<PaymentProcessorPort, "cancelPaymentIntent">` to
  `ReleaseCartHoldDeps`.
- After the existing seat-release + order-cancel logic, add:
  ```typescript
  if (order.stripePaymentIntentId) {
    try {
      await deps.payments.cancelPaymentIntent({
        paymentIntentId: order.stripePaymentIntentId,
      });
    } catch (err) {
      logger?.warn("cancel_pi_failed", {
        orderId: input.orderId,
        paymentIntentId: order.stripePaymentIntentId,
        error: describeError(err),
      });
    }
  }
  ```

### 2.4 Integration point 2: new use case `release-expired-carts`

**File:** `packages/core/src/use-cases/orders/release-expired-carts.ts`

A companion to `release-expired-holds` that operates on **orders**, not just
seat holds. This completes the lifecycle:

```
Input:
  ttlSeconds?: number (default 900)
  limit?: number (default 50)

Output:
  releasedCount: number
  canceledPICount: number
```

**Logic:**
1. Query PENDING orders where ALL items' `holdExpiresAt` < `now - ttlSeconds`.
   (Reuses the same TTL as hold expiration for consistency.)
2. For each expired order:
   a. `cancelPendingOrder(orderId)` — sets status to CANCELLED.
   b. Release any remaining seat holds for the order's items.
   c. If `stripePaymentIntentId` is set, `cancelPaymentIntent` (best-effort).
3. Return counts.

**Auth:** None (cron/internal). Gated by being registered as a job, not as a
tRPC procedure.

**Repo addition:** New method on `OrdersRepo`:
```typescript
listExpiredPendingOrders(input: {
  holdExpiredBefore: Date;
  limit: number;
}): Promise<Array<{
  id: string;
  stripePaymentIntentId: string | null;
  seatIds: string[];
}>>;
```

### 2.5 Cron registration

Register `release-expired-carts` alongside the existing `release-expired-holds`
on the same schedule. They can run in either order — the seat hold release is
idempotent, and order cancellation is guarded by the PENDING status check.

## 3. Repo changes summary

| Repo | Method | Purpose |
| --- | --- | --- |
| `OrdersRepo` | `listExpiredPendingOrders` | Find PENDING orders with all holds expired |
| `PaymentProcessorPort` | `cancelPaymentIntent` | Cancel a Stripe PI |

## 4. Testing plan

| Scenario | Type |
| --- | --- |
| `cancelPaymentIntent` on active PI — returns `{ canceled: true }` | Unit |
| `cancelPaymentIntent` on already-succeeded PI — returns `{ canceled: false }` | Unit |
| `cancelPaymentIntent` on already-canceled PI — returns `{ canceled: false }` | Unit |
| `cancelPaymentIntent` on unknown PI — throws | Unit |
| `releaseCartHold` with PI — cancels order + PI | Unit |
| `releaseCartHold` with PI cancel failure — still returns released: true | Unit |
| `releaseCartHold` without PI — cancels order only | Unit |
| `release-expired-carts` — finds expired orders, cancels + releases | Unit |
| `release-expired-carts` — skips orders with active holds | Unit |
| `release-expired-carts` — idempotent on already-cancelled orders | Unit |
| Stripe adapter e2e — cancel a test-mode PI | Integration |

## 5. Implementation order

1. Add `cancelPaymentIntent` to `PaymentProcessorPort`.
2. Implement in Stripe adapter.
3. Add `listExpiredPendingOrders` to `OrdersRepo` types + Prisma adapter.
4. Update `releaseCartHold` deps + logic.
5. Create `release-expired-carts` use case.
6. Register cron job.
7. Add tests for all paths.

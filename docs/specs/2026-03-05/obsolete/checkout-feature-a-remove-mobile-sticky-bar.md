# Feature A — Remove Mobile Sticky Bottom Bar

## Objective
Delete the fixed-position mobile bottom bar from the checkout page. The sidebar `OrderSummary` (which collapses on top of the left column on mobile via the existing `@media (max-width: 900px)` rule) already contains a CTA button and total, making the mobile bar redundant.

## Scope
**One file, pure frontend.**

| File | Action |
|------|--------|
| `apps/web/src/app/events/checkout/[...slug]/_components/Checkout.tsx` | Remove the mobile bar JSX block and the helper variable that powers it |

## Exact Changes

### 1. Remove `estimatedTotalForMobile` computation
Lines ~321–332 define a `useMemo` that computes `estimatedTotalForMobile`. Delete the entire block:

```ts
// Estimated total for the mobile bar (subtotal + estimated fees)
const estimatedTotalForMobile = useMemo(() => {
  const estimates = feeRatesQuery.data?.perTicketEstimates;
  if (!estimates || estimates.length === 0) return subtotalCents;
  let fees = 0;
  for (const est of estimates) {
    const qty = quantities[est.ticketTypeId] ?? 0;
    if (qty > 0) {
      fees += qty * (est.platformFeeCents + est.processorFeeCents);
    }
  }
  return subtotalCents + fees;
}, [subtotalCents, quantities, feeRatesQuery.data]);
```

### 2. Remove the mobile sticky bottom bar JSX
Lines ~582–651 (everything between the `{/* ── Mobile sticky bottom bar */}` comment and the closing `</>`). Delete the entire `{selectedQty > 0 && !hasPaymentReady && ( ... )}` block including:
- The fixed-position container
- The ticket count label (`checkout.nTickets`)
- The estimated/actual total display (with `~` prefix)
- The duplicate `<Button>` with `handleCheckout`

### 3. Cleanup
After removal, check that `estimatedTotalForMobile` is not referenced anywhere else in the file. It was only used inside the mobile bar.

## How to Verify
1. `pnpm build` — should pass with no TS errors.
2. Resize the browser below 900px on the checkout page — the order summary should stack above/below the left column content with its own CTA button. No fixed bottom bar should appear.

## Dependencies
None. This is fully independent and can be done in any order.

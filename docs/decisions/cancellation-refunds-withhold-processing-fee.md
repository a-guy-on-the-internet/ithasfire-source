# Decision Record: A cancellation refund withholds the processing fee

**Status:** accepted (2026-09-15, owner ruling)

## Context

Every refund path but one returned what the buyer paid minus the Stripe
processing fee: `quote-full-refund`, `quote-item-refund`, `refund-full-order`,
`refund-order-items` and `get-refund-eligibility` all read the fee off the
PaymentIntent and allocate it across ticket items with the same allocator
(`allocateFullRefundShares` / `allocateRefundFeeShares`). The rule is uniform
across `ABSORB` and `PASS_THROUGH` and is stated in the refund policy shown at
checkout.

`cancel-event` was the exception. It refunded each ticket item's buyer-paid
amount plus its tax share and subtracted nothing, so a buyer whose event was
cancelled got the processing fee back while a buyer who refunded the same
ticket a day earlier did not. Stripe keeps its fee on a refund either way, so
on every cancelled order the platform paid the fee out of its own balance. The
help centre had been rewritten to describe that behaviour ("fees included") and
the cancel confirm dialog described the opposite ("minus payment processing
fees").

## Decision

Cancellation follows the same rule as every other refund. The buyer gets the
ticket price, the platform fee and the tax back; the payment processing fee is
withheld, because the processor does not return it.

The owner's words: we cannot refund the processing fee, Stripe has to process
it.

## Mechanism

- `cancel-event.ts` reads the fee per order with
  `getProcessingFeeForPaymentIntent` before building the plan and computes
  per-item nets through `allocateFullRefundShares` imported from
  `refund-full-order.ts`, which stays the source of truth. A cancelled order
  refunds the identical cents a staff full refund of it would; a parity test
  drives both real use cases through one fake payments port.
- The allocation basis is `computeExpectedPaymentAmount(order)`, the
  tax-inclusive total net of credit and discount lines. The old per-item sum
  ignored those lines and could ask Stripe for more than the charge on a
  promo-covered order.
- Because the refund is now smaller than the charge, Stripe reports it as a
  partial refund and the `charge.refunded` reconciler takes its metadata-driven
  arm. Cancel therefore stamps the refund with the refunded item ids and
  `useCase: "cancelEvent"`, exactly as `refundFullOrder` does, so a
  cancellation that dies after Stripe accepts the refund is still healed.
- Free and comp orders have no PaymentIntent and are skipped before the fee
  read. A failed fee read fails that one order, is reported, and leaves the
  buyer in the pending-refund set; it does not stop the cancellation.

## Consequences

- Help centre: `refunds-and-cancellations.md` no longer says fees are included
  on cancellation; `create-an-event.md` links there instead of stating a fee
  rule.
- The cancel confirm copy (`ebCancelConfirmRefundNote`) was already right.
- Not changed by this record: which items a cancellation refunds (see
  `buyer-refunds-stop-at-payout.md` and
  `cancellation-refunds-gifted-tickets-to-the-payer.md`). Those decide the set;
  this decides the amount.
- Operators: a cancel that ran on the previous build and died before its
  transaction committed will, on retry after deploy, send the same Stripe
  idempotency key with a different amount and fail with `idempotency_error`.
  Drain in-flight cancellations before rolling out.

# Decision Record: Cancellation refunds a gifted ticket to whoever paid for it

**Status:** accepted (2026-09-15)

## Context

`cancelEvent` refunds every order for the event and voids every ticket,
gifted ones included. Its refund plan skipped any order item marked
`transferred` unless the transfer was a resale whose resale order was also
refunded. A ticket the buyer had GIFTED (transferred with no resale behind
it) was therefore voided without anyone being refunded for it: the recipient
paid nothing, and the payer got nothing back. Money audit 2026-09-08,
finding #18.

The skip exists for a good reason on the buyer-initiated paths: a sender must
not claw back a gifted ticket while the recipient still holds a live pass.
That reason does not apply when the event is gone.

## Decision

On event cancellation, a gifted ticket is refunded to the order that paid for
it, on the same terms as the order's other tickets. A resale-transferred
ticket keeps today's handling: the resale buyer is refunded on the resale
order, the seller's resale proceeds are unwound, and the original order item
is refunded only once that resale refund succeeded.

## Why

- The payer is the only party out of pocket. The recipient loses a pass to a
  show that will not happen, which is nothing they still had.
- Every other item on the order is refunded to the same PaymentIntent; leaving
  one out is a silent shortfall the buyer cannot see or request.
- The distinction that matters is resale versus gift, not transferred versus
  not: a resale parent has a counter-party who was paid, a gift does not.

## Consequences

- `buildRefundPlan` in `cancel-event.ts` treats a transferred item with no
  resale linkage as refundable; items linked to a resale order keep the
  existing gate on that resale order's refund outcome.
- `refundFullOrder`, `refundOrderItems` and the eligibility screen are
  unchanged: outside cancellation a gifted ticket remains non-refundable to
  the sender.
- No refund amount formula changes; the gifted item takes the same per-item
  allocation as its siblings.
- The gift allowance covers primary orders only. A resale buyer who gifted the
  ticket onward is not refunded for it by cancellation.
- When the gift-versus-resale linkage cannot be loaded completely, an order
  holding a transferred ticket of unknown origin fails closed: nothing on it
  is refunded, it stays in the pending-refund set and `failedRefundCount`
  flags it for a human. It is never refunded short.
- A resale chain of any length unwinds last buyer first (owner ruling
  2026-10-11); each hop's refund gates the one before it.

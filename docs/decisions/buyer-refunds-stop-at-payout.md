# Decision Record: Buyer self-serve refunds stop at payout

**Status:** accepted (2026-09-15)

## Context

Two surfaces disagreed about a paid-out ticket. The buyer-facing eligibility
query (`get-refund-eligibility.ts`) has always said a paid-out item is not
refundable and shows `order_already_paid_out`; the help centre has promised
the same rule since launch. The refund mutations (`refundFullOrder`,
`refundOrderItems`) never checked: a buyer who called the API directly got a
refund, and the organiser's Stripe transfer was reversed to fund it. That is
the "server never re-checks what the UI promises" class from the 2026-09-08
money audit (finding #23), in the direction where the server is looser than
the screen.

## Decision

A **buyer-initiated** refund stops at payout: once any item's revenue has been
paid out, the buyer cannot self-serve a refund of it, and the server enforces
this with the same rule the screen shows. **Organiser-, staff-, and
cancel-event-initiated** refunds keep reversing the transfer and refunding,
because there the payee is either the one pressing the button or the platform
is acting under a policy the payee agreed to.

## Why

- Money that has been paid out belongs to the payee. A buyer's unilateral
  action must not claw it back; the organiser can still choose to refund, and
  a buyer who disagrees has the dispute path, where the organiser is heard.
- Payouts land after the event ends, and the buyer window closes when the
  event starts, so a paid-out item inside the buyer window only exists when
  the organiser chose an early payout schedule. That is the organiser
  choosing cash-in-hand over refundability, and the refund policy should
  respect the choice rather than silently undo it.
- The screen and the help article have stated this rule for months. Widening
  them to match the mutations would change what buyers were told, not fix a
  drift.

## Considered and rejected

Making the display match the mutations (paid-out items refundable with a
transfer reversal). Rejected: it exposes organiser balances to buyer-initiated
clawbacks with no consent step, and a reversal against a connected account
that has since withdrawn its balance fails at Stripe, leaving the buyer told
"refunded" with nothing moved.

## Consequences

- `classifyRefundItem` grows an `already_paid_out` reason that applies only
  when `buyerInitiated`; `get-refund-eligibility.ts` drops its private
  paid-out special case and reads the classifier, so there is one rule.
- `refundFullOrder` and `quoteItemRefund` / `refundOrderItems` refuse a buyer
  the moment a paid-out item is in scope. Organiser and staff paths are
  unchanged (`_skipBuyerCheck`); `cancel-event` classifies paid-out items with
  its own inline rule and never called the shared classifier.
- A buyer's full-order refund on a mixed order now skips the paid-out item and
  lands `PART_REFUNDED`. The organiser's route to that leftover item is the
  item path (`orgRefundOrderItems`): the full-order idempotency key is shared
  per order and would replay the buyer's result.
- No refund amount formula changes.

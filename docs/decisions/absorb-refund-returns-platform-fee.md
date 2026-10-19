# Decision Record: A refunded order gives the platform fee back

> Status 2026-10-11: new sales credit the organiser the full ticket price
> (`platform-fee-charged-once.md`). The basis expression in Context and the
> `PASS_THROUGH` rows of the worked example describe orders sold before that
> change. The refund rule and the invariant are unchanged.
>
> Status 2026-10-09: no new sale has been priced `ABSORB` since 2026-10-01 (`docs/decisions/absorb-removed.md`; `SALE_FEE_MODE` in `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts`). This rule still governs refunds of past `ABSORB` orders and of every `PASS_THROUGH` order.

**Status:** accepted (2026-09-15, owner ruling)

## Context

Two fee modes decide who funds the platform fee at checkout. In
`PASS_THROUGH` the buyer pays face + platform fee (+ a grossed-up processor
fee). In `ABSORB` the buyer pays face only and the fee comes out of the
organiser's settlement basis. The basis is the same expression in both modes:
`computeAgreementBasis = amountGrossCents − feesPlatformCents`
(`finalize-from-payment-intent.ts`), so for a $10.00 ticket with a 33¢ fee the
organiser is credited $9.67 either way; the modes differ only in what the buyer
was charged.

A refund returns everything the buyer paid except the processor fee
(`quote-full-refund.ts`, `quote-item-refund.ts`; uniform across modes). The
question was what the ORGANISER is docked when an `ABSORB` item is refunded:
the $10.00 face the buyer gets back, or the $9.67 they were credited. Docking
face would leave the organiser 33¢ negative on every refunded ticket, with the
platform keeping a fee on a sale that no longer exists.

## Decision

On a refunded `ABSORB` order the platform gives its platform fee back. The
organiser is docked exactly what they were credited, never more.

The same holds in `PASS_THROUGH` by the same mechanism: the buyer-paid fee is
refunded to the buyer out of the platform's take, and the organiser's debit is
their credited share.

## Mechanism

- **The debit reads the credit.** `SETTLEMENT_CREDIT.metadata.items` is the
  organiser's credit spread over ticket items by face
  (`attributeCreditToItems`, `create-credits-from-order.ts`). A per-item
  `REFUND_DEBIT` is the sum of those attributed shares
  (`write-refund-debits.ts`, item mode) — the CREDITED cents, which by
  construction carry no fee component. No fee-mode branch exists or is needed.
- **A full refund debits `credit − Σ prior debits`**, so partial-then-full
  sums to the credit exactly and a later attributed refund clamps to zero and
  reports drift (`refund_debit_clamped`).
- **The returned fee is recorded.** `OrderItem.refundedPlatformFeeCents`
  (migration `20260915000000`) is stamped at refund execution by both
  `refundFullOrder` and `refundOrderItems`, beside `refundedTaxCents`, via
  `_shared/refund-platform-fee-share.ts`: the item's own
  `meta.platformFeePerTicketCents` when checkout's invariant
  (Σ per-item fee === `feesPlatformCents`) holds on the row, otherwise
  `feesPlatformCents` allocated by buyer-paid weight with
  `allocateProportionalCents` — the allocator the refund money already uses.
  Shares are computed over every ticket item on the order, so stamps across
  separate refunds add up to the order fee once. `NULL` means "not attributed"
  and is never written as 0; a zero fee stamps a measured 0. `cancel-event`
  stamps both from the same allocation its refund money uses (one allocation
  per order, over every ticket item). Paths with no per-item attribution
  (Stripe-dashboard reconciliation, `bulkUpdateStatus`) leave it `NULL`.

## Invariant

**Organiser debit ≤ organiser credit, per item and per order.** Per item the
debit is the attributed credit share; per order Σ `REFUND_DEBIT` ≤
`SETTLEMENT_CREDIT` − realised dispute principal. The conservation sweep
(`listConservationViolations`) checks the order-level form.

Worked example, one $10.00 ticket, 33¢ fee, processor fee withheld from the
buyer only:

| | Organiser | Platform | Buyer |
| --- | --- | --- | --- |
| `ABSORB` sale | +967 credit | +33 | −1000 |
| `ABSORB` refund | −967 debit | −33 | +1000 − processor |
| `PASS_THROUGH` sale | +967 credit | +66 (33 buyer-paid, 33 basis) | −1033 − processor |
| `PASS_THROUGH` refund | −967 debit | −66 | +1033 (processor gross-up nets against the withheld fee) |

## Not decided here

> Superseded 2026-10-11 by `platform-fee-charged-once.md`: the two-unit take
> was not intended. New sales credit the full ticket price; the paragraph
> below describes orders sold before that change.

That `PASS_THROUGH` retains the fee twice on a sale (once from the buyer, once
out of the basis) is a property of `computeAgreementBasis` this record only
observes. The refund side gives both back, so it does not affect the
invariant above.

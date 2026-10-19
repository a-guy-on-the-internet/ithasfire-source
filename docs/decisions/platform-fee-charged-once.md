# Decision Record: The platform fee is charged once

**Status:** accepted (2026-10-11, owner ruling: "WE SHOULD ONLY BE CHARGING
THEM ONCE", in reply to "buyer pays the fee once, organiser gets the full
price?")

Supersedes the "Not decided here" section of
`absorb-refund-returns-platform-fee.md` and the "What changes for an organiser
whose event converts" section of `absorb-removed.md`. Wherever else those two
records state the basis as `amountGrossCents − feesPlatformCents` (the Context
and the `PASS_THROUGH` rows of the worked example in the first, deploy step 5
in the second), read it as describing orders sold before this change. Their
refund rule, invariant and migrations stand.

## Context

The organiser's settlement basis was `amountGrossCents − feesPlatformCents` in
both fee modes. Under `ABSORB` that deduction was the platform's only take.
`PASS_THROUGH` added a buyer-side charge and kept the deduction, and since
2026-10-01 every sale is `PASS_THROUGH`. So every paid sale took the fee twice.
Measured 2026-10-10 on a dev order: ticket 7500, fee 50, organiser credited
7450, platform kept 100.

The 2026-09-15 record observed this and parked it. The owner had believed it
was already gone.

## Decision

On a paid ticket the platform fee is taken once. The buyer pays it on top of
the ticket price, and the organiser is credited the full ticket price.

- "Ticket price" is `Order.amountGrossCents`: what the buyer paid for the
  tickets after discounts, before fees and tax. On a discounted ticket the
  buyer still pays the fee computed on full face; the organiser is credited the
  discounted price and no longer carries the fee.
- The buyer's charge does not change.
- A refund still gives the platform fee back to the buyer, and the organiser is
  docked what they were credited. On a new order that is the full price.

## Orders sold before the change

They keep the amounts they were credited. Nothing re-derives an old order's
credit from the new rule, and a refund of one docks what it was credited.
Whether to pay organisers the difference on those orders is not decided here.

## Mechanism

- **The order records its rule.** `buildFeePolicySnapshot` stamps
  `feePolicySnapshot.organiserCredit: "FULL_PRICE"` (`SALE_ORGANISER_CREDIT`)
  on every order it prices. An order without the key was sold before the
  change.
- **One function decides.** `computeAgreementBasis(order)`
  (`finalize-from-payment-intent.ts`) returns the gross for a marked order and
  gross minus fee otherwise. Finalize, the credit-covered checkout path and the
  deal settlement sheet call it with the order's own snapshot. The builder's
  fee preview has no order and passes the new-sale marker explicitly.
- **A key with an unknown value is reported.** It means a new sale was
  mis-stamped; the order is credited under the old rule and both split writers
  report `organiser_credit_unknown` after commit.
- **Net kept.** The platform revenue query counts the basis-side unit and its
  refund give-back only on unmarked orders.
- **No migration.** The marker is a JSON key, so a deploy cannot leave the
  payment path waiting on a column.

Worked example, one $10.00 ticket, 33¢ fee:

| | Organiser | Platform | Buyer |
| --- | --- | --- | --- |
| Sale, before | +967 | +66 | −1033 − processor |
| Sale, now | +1000 | +33 | −1033 − processor |
| Refund, now | −1000 | −33 | +1033 |

## Limits

- An order priced before the deploy and paid after it (a held cart, a bank
  payment still clearing) has no marker and is credited under the old rule.
- The marker and the splits must be written by the same code version. Deploy
  without a traffic split. After a rollback, old settlement-sheet code would
  refuse every event with a new order, so a rollback needs a forward fix.

Spec: `docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml`.

# Stripe Platform Payout Settings

**Why this exists:** our settlement batch pays organizers by creating Connect transfers that draw on the **platform account's available balance**. Stripe reserves nothing against pending transfers. If the platform account is set to automatic payouts, Stripe sweeps that balance to our bank on its own cadence, and the nightly batch finds nothing to transfer. Nothing in the codebase can prevent that — it is a dashboard setting, and this file records what it needs to be and why.

**Status:** the live values are **UNVERIFIED**. Nobody has read the platform account's payout settings since this was written. Everything below is what the setting should be, not a record of what it is.

## The mechanism

Money moves in two hops, and only the second one is ours:

1. Buyer pays → charge lands on the **platform** account, `pending`. We do not use destination charges — see the `NOTE` at the top of `createPaymentIntent` in `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts`. Funds become `available` after Stripe's settlement window.
2. `settlements.run-batch` (daily, `0 0 * * *` `America/Chicago`) creates one transfer per `(payee, currency)` from the available balance → the organizer's connected account. From there Stripe pays out to their bank on **their** account's schedule, which we never set.

The batch's `deps.payments.createTransfer` call passes **no** `sourceTransaction`, so the adapter's `transfers.create` goes out without `source_transaction` (`runPayoutBatch` in `packages/core/src/use-cases/settlements/run-batch.ts`). That is deliberate, whatever the adapter's `NOTE` says about `source_transaction`: `source_transaction` pins one transfer to one charge, and the ledger-authoritative design aggregates many credits into one transfer per payee. The cost of that choice is that we need real available balance at transfer time.

## Settlement windows that feed the balance

Ours is a **US** account, so:

| What | Window | Source | Checked |
| --- | --- | --- | --- |
| Card charges (US) | **2 business days.** Business days, so a Saturday charge has Monday as day 0 and is available Wednesday. | https://docs.stripe.com/payments/balances | 2026-09-05 |
| ACH Debit (`us_bank_account`) | **4 business days from payment creation** — not from when the PaymentIntent succeeds. ACH takes "up to 4 business days to receive acknowledgement of success or failure", so `payment_intent.succeeded` already sits at roughly that mark. Reducible to 2 for eligible merchants; worth applying for, we enable ACH in `paymentMethodsForCurrency`. | https://docs.stripe.com/payments/ach-direct-debit | 2026-09-06 |
| First payout on a new account | 7–14 days, **one time only**. Frequently confused with the settlement window; it is not one. It gates the first bank payout, not fund availability. | https://docs.stripe.com/payouts | 2026-09-05 |

US has no separate "initial" and "default" settlement timing — it is 2 business days from the first charge onward. The 7–14 day figure applies to no part of the transfer path.

**Why the code applies a flat 2 business days regardless of payment method.** Settlement credits are minted at `payment_intent.succeeded`. For a card that instant is the charge, so 2 business days from it is exactly the card window. For ACH that instant is already ~T+4 from creation, so the ACH wait has elapsed by the time we compute anything — adding another 4 would double-count and delay every ACH payout for nothing. A flat 2 is exact for cards, conservative for ACH, and lands on T+4 anyway in the case where Stripe acknowledges an ACH success early. There is deliberately no per-method branch; see the comment in `settlement-availability.ts` before adding one.

## What to set

**Payout schedule — Settings → Payouts on the platform account.** (The dashboard moves this around; look for Balances → payout settings if it is not under Settings.)

Stripe's own guidance, from the balances page: *"As a general practice, setting your payout schedule to manual or monthly automatic payouts gives you better control over managing your funds flows."*

Either works for us:

- **Manual** — nothing leaves except when someone triggers it. Strongest guarantee that the batch always has float. Costs a recurring human task.
- **Automatic with a minimum balance** — Stripe holds back a floor before sweeping. Set the floor above a typical night's payout run. See https://docs.stripe.com/payouts/minimum-balances-for-automatic-payouts.

What must not stay in place is **automatic daily with no minimum**, which is the default and which drains exactly the balance the batch depends on.

**Connected accounts.** We set no payout schedule on connected accounts — `createConnectAccount` (`stripe-adapter.ts`) passes only `type: "express"`, `business_type`, the individual's email for individual accounts, and the `card_payments` + `transfers` capabilities, so every organizer inherits Stripe's country default. That is a reasonable default and does not need changing, but it does mean the organizer's bank-arrival date is later than the date our UI shows them. The copy has been corrected to say so; the setting itself is fine as is.

## Verifying

1. Read the platform account's payout schedule and minimum balance. Record them here with a date.
2. Check whether ACH 2-day settlement is available to us: https://support.stripe.com/questions/two-day-settlement-for-ach-direct-debit. Applying halves the ACH window, which shortens how long an ACH sale sits before it can be paid out. It does not change the floor — that is already flat 2 for every method.
3. Watch `itemsFailedInsufficientPlatformBalance` in the `settlements.run-batch` result. Per currency it counts the first item Stripe refused with `balance_insufficient`, plus every later item in that currency the circuit breaker skipped without calling Stripe. A non-zero value means the float ran out that night — the money is safe and re-plans the next run, but it is the signal that these settings are wrong. More than one in a run is also reported to Sentry as `platform_float_exhausted`, with an unfunded total per currency; treat that total as the minimum top-up, not the exact one. Top the balance up and let the next nightly batch re-plan. A hand-triggered retry within about 24 hours can replay Stripe's cached rejection for the item that reached Stripe, because it reuses the same credit-derived idempotency key.

## Related

- `packages/core/src/lib/payout-scheduling/settlement-availability.ts` — the availability floor that keeps a payout date from landing inside the settlement window, and `business-days.ts` next to it for the Mon–Fri arithmetic.
- `packages/core/src/lib/payout-scheduling/compute-payout-date.ts` — the schedule-to-date mapping the floor is applied on top of.
- `docs/stripe-fee-reference.md` — the fee numbers, same re-check discipline.
- `apps/web/content/help/organising-events/payouts-and-settlements.md` — the organizer-facing version of the two-hop timeline.

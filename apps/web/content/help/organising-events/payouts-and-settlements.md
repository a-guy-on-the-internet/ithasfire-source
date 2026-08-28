---
title: "Payouts and settlements"
description: "How you get paid, Stripe Connect setup, and payout schedules."
category: "organising-events"
order: 3
tags: ["payouts", "stripe", "fees", "settlements", "cash"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/manage-ticket-types",
    "organising-events/memberships",
    "organising-events/selling-at-the-door",
  ]
---

Ithas Fire uses Stripe Connect to pay organisers. You need an active Stripe Connect account before you can publish a ticketed event.

## Setting up Stripe Connect

1. Go to **/admin/{your-slug}/payments**.
2. Click **Connect with Stripe**.
3. Complete Stripe's onboarding — business details, ID verification, and a bank account.
4. Return to Ithas Fire when done. Status updates to **Active** once Stripe confirms both `chargesEnabled` and `payoutsEnabled`.

:::tip
Stripe approval usually takes minutes but can take up to 2 business days for manual review. Start the process early — you can't publish ticketed events until it's complete.
:::

## Payout schedule

Each event has its own payout schedule. Every schedule is measured from when the **event ends** — funds are never transferred before the event is over. Pick one per event:

| Option             | When funds transfer                   |
| ------------------ | ------------------------------------- |
| `ASAP`             | ~2 days after the event ends          |
| `WEEK_OF_EVENT`    | Sunday of the week the event happens  |
| `ONE_WEEK_AFTER`   | One Sunday after the event            |
| `TWO_WEEKS_AFTER`  | Two Sundays after the event (default) |
| `FOUR_WEEKS_AFTER` | Four Sundays after the event          |

New events default to **`TWO_WEEKS_AFTER`**. Change it per event in the builder under **Settings** → **Money & compliance** (shown once payouts are set up).

Later schedules reduce your chargeback risk — if a buyer disputes a charge after the event, the funds are still in your Stripe balance rather than your bank account.

## Fees

The platform fee is per-ticket. Each event is either:

- `PASS_THROUGH` — the fee is added on top of your price at checkout (buyer pays it)
- `ABSORB` — the fee comes out of your ticket price (you receive less per ticket)

You choose the mode per event with the fee toggle in the builder's **Tickets** section. See [manage ticket types](/help/organising-events/manage-ticket-types).

## Your balance, and when it pays out

You have one running balance per currency:

- **A sale adds to it** on the date that sale becomes payable — the payout schedule you chose for the event.
- **A refund subtracts from it immediately**, whether or not that sale has been paid out yet.
- **Once a night** we pay out whatever is payable, provided it is above the payout minimum ($10).

If a payout cannot go out — your Stripe account needs attention, the balance is under the minimum, a refund pushed it negative — nothing is lost and nothing needs resetting. The money stays on your balance and goes out on the next run that can pay it, including everything that accumulated in the meantime.

A refund that is bigger than your current balance takes it negative. That is normal: the next sales bring it back up, and only what is left over transfers.

When a payout is sent, we email you and post an in-app notification with the amount. For organisations, owners, admins, and finance members all receive it.

## Cash you took at the door

Cash never reaches your balance, and it never appears in a payout. Nothing has gone wrong — you already have the money. Stripe only moves funds it collected, and a note handed across a table at your own door was never Stripe's to move.

The same goes for comped tickets, which are recorded at $0.

So the totals on this page cover card sales only. To see what the door took in cash, open **Sell** under **Door & crew** and expand **Cash taken tonight**: it gives you the figure that should be in the box for that event, the number of comps, and anything handed back. That panel is the only place cash is counted.

Card sales taken on a reader at the door behave like any other card sale — same balance, same schedule, same payout.

## Why is part of my membership payout held back?

If you offer [memberships](/help/organising-events/memberships), a percentage of your **membership** revenue is held back for 90 days when you are new to memberships, then released with a later payout. Ticket revenue is never held this way.

| Your membership payout history | Held back |
| ------------------------------ | --------- |
| First 90 days                  | 10%       |
| 90–180 days                    | 5%        |
| After 180 days                 | Nothing   |

If you were already selling tickets with us for at least 90 days before turning memberships on, you start at **5%** instead of 10% — you have a payout track record with us already.

Two things worth being precise about:

- **This is deferred payout, not a fee.** The money is yours. It is held, then paid out with a later payout once the 90 days are up — you can see it as "Reserve" on the payout notification.
- **A lost membership chargeback restarts the clock.** For 180 days after one, the rate returns to 10% and held amounts wait rather than releasing. This is why the reserve exists: a membership charge can be disputed months after you have been paid, and we are the merchant of record.

Your payout notification names the reserve explicitly whenever any is held or released. If the reserve holds back an entire payout, we send you a message saying so rather than silently sending nothing.

## Refunds and chargebacks

Refunds are deducted from your next payout. If your pending balance is insufficient, Stripe debits the linked bank account.

:::warning
Keep a buffer in your bank account during the days after an event. Chargebacks and late refund approvals can trigger unexpected debits from Stripe.
:::

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
specs: ["2026-10-14/freeze-the-deal"]
---

Ithas Fire uses Stripe Connect to pay organisers. You need an active Stripe Connect account before you can publish a ticketed event.

## Setting up Stripe Connect

1. Go to **/admin/{your-slug}/payouts**. Until Stripe is connected, setup is at the top of the page.
2. Read the chargeback and payout-hold terms shown on that page, tick **I understand and accept the chargeback and payout-hold terms**, then click **Accept terms**. They cover what happens to your payouts when a buyer disputes a charge — see [refunds and chargebacks](#refunds-and-chargebacks) below. **Set up Stripe Connect** stays disabled until you have accepted. Only an owner or admin of the group can accept on its behalf.
3. Click **Set up Stripe Connect**.
4. Complete Stripe's onboarding — business details, ID verification, and a bank account.
5. Return to Ithas Fire when done. The **Stripe account** badge under **Settings** on the **Payouts** page reads **Connected** once Stripe has your details and has turned on both charges and payouts.

Until then the badge reads **Incomplete**, and a banner at the top of the page says what Stripe still needs, whether payouts are paused, and carries the **Continue onboarding** button.

:::tip
Stripe approval usually takes minutes but can take up to 2 business days for manual review. Start the process early — you can't publish ticketed events until it's complete.
:::

## Payout schedule

Each event has its own payout schedule, measured from when the **event ends**. Funds are never released before the event is over. Pick one per event:

| Option                  | When we release your funds                          |
| ----------------------- | --------------------------------------------------- |
| **As soon as possible** | The day after the event ends                         |
| **Week of event**       | The Sunday of the event's week                       |
| **1 week after**        | The Sunday after the event's week                    |
| **2 weeks after**       | Two Sundays after the event's week (default)         |
| **~1 month after**      | Four Sundays after the event's week                  |

New events default to **2 weeks after**. To change your default, open **Settings** at the bottom of the **Payouts** page and click **Change schedule** under **Payout schedule**. Every schedule costs the same. A change applies to events created after you save; earlier events keep their schedule. To change a single event, use the builder under **Settings** → **Money & compliance** (shown once payouts are set up). Once an event's deal is frozen, change it as described in [The deal freezes](#the-deal-freezes).

Two rules adjust those dates:

- **Saturday and Sunday events on "Week of event"** move to the following Sunday. A Sunday one or two days after the show is too tight to be a useful settlement window, so the payout skips to the next one.
- **Card payments take two business days to clear** into our account before we can send them anywhere. A sale is never released before its own money has cleared. That makes no difference to tickets sold in advance, but tickets sold on the night of the show are released a couple of business days later than the date in the table. Business days, so a Saturday sale clears on Wednesday.

Because that second rule applies per sale rather than per event, an event with both advance and door sales can pay out in **two transfers a few days apart** — the advance sales on the scheduled date, the door sales once they clear.

Later schedules reduce your chargeback risk — if a buyer disputes a charge after the event, the funds are still in your Stripe balance rather than your bank account.

## The deal freezes

An event's deal is who gets paid from its ticket sales and how: each payee's share, costs taken off the top, the resale share and who receives it, and the payout schedule. Payees are the acts, places and co-promoters on the deal.

The deal freezes when the event is first published. Unpublishing does not unfreeze it. You can also press **Freeze the deal** in the deal editor before then. Events already on sale when freezing arrived were frozen without notice. There is no unfreezing.

To change a frozen deal:

1. Click **Change the frozen terms** and edit. Nothing is saved until you save.
2. Click **Save and tell them**.

The deal stays frozen after the save. Everyone on the deal before or after the change gets an email and an in-app notice showing each changed line before and after, who changed it, and when. When a group is a payee, its owners, admins and finance members are told. You are not told about your own change, and a save that changes nothing tells nobody. Payees can still confirm or decline their own line while the deal is frozen.

The notice links to the event's deal page, which shows the deal as it stands and every change since it froze. Each payee sees the lines that concern them; you see the whole deal. Everyone who was on the deal sees the changes, including anyone a change took off it. The deal editor lists the same changes.

:::tip
Tickets already sold keep the resale share they were sold with. A change applies to tickets sold after it. See the [resale marketplace](/help/buying-tickets/resale-marketplace).
:::

## When the money reaches your bank

Your payout makes two hops, and the dates above only describe the first one.

1. **We release your funds** into your own Stripe account, on the schedule above.
2. **Stripe pays out from there to your bank**, on the payout schedule attached to your Stripe account.

That second hop adds its own delay, which Stripe controls and which is typically a couple of business days. If your Stripe account is new, Stripe holds the first payout longer — usually 7 to 14 days — while it completes its review. That one-time hold applies to your first payout only, not to later ones.

:::tip
You can see and change the second hop yourself. Open **Stripe Dashboard** from your **Payouts** page (owners, admins, and finance members see that button) and look at your payout settings there — that's where the bank timing lives.
:::

## Fees

The platform fee is per-ticket, and it is added on top of your price at checkout along with the processing fee, so the buyer pays both. Every event works this way.

The platform fee is taken once, from the buyer. Your event is credited the full ticket price. Take a $10.00 ticket with a 33¢ platform fee: the buyer pays $10.33 plus the processing fee and tax, and your event is credited $10.00. See [manage ticket types](/help/organising-events/manage-ticket-types#platform-and-processing-fees).

Tickets sold before 13 October 2026 were credited the ticket price minus the platform fee. Those orders keep the amounts they were credited, and a refund of one takes back what it was credited.

:::tip
A few older events used to take the platform fee out of the organiser's share instead of charging it to buyers. They have moved to fees on top: their buyers now pay the platform fee and the processing fee as well. Orders placed before the change keep the amounts they were charged.
:::

## Your balance, and when it pays out

You have one running balance per currency:

- **A sale adds to it** on the date that sale becomes payable — the payout schedule you chose for the event.
- **A refund subtracts from it immediately**, whether or not that sale has been paid out yet.
- **Once a night** we pay out whatever is payable, provided it is above the payout minimum. The **Payouts** page in your admin shows what that minimum is and where your balance sits against it.

If a payout cannot go out — your Stripe account needs attention, the balance is under the minimum, a refund pushed it negative — nothing is lost and nothing needs resetting. The money stays on your balance and goes out on the next run that can pay it, including everything that accumulated in the meantime. A payable balance under the minimum waits until it grows past it, as more sales come in or as sales you already made become payable.

A refund that is bigger than your current balance takes it negative. That is normal: the next sales bring it back up, and only what is left over transfers.

When a payout is sent, we email you and post an in-app notification. The email lists the events each part of the payout came from, anything withheld, what is still owed to you and when it next becomes payable, and links to your **Payouts** page. For organisations, owners, admins, and finance members all receive it. We send the money to your Stripe account; Stripe moves it on to your bank on its own schedule.

## Reading the Payouts page

The top of the page answers one question: how much we send to your Stripe account in the next run, and when. Beside it is **Owed to you**, your whole balance. **Ready now** appears too when it differs from what we send, for example while the balance is under the minimum or Stripe can't take payouts yet. Anything held for a dispute or in reserve is listed under it, and a single line shows the payout minimum.

- **Coming up** lists the dates the rest of your balance becomes payable, with the amount and the events behind each date.
- **Ledger** shows your five newest entries. Click **Show all entries** for the full list, then **Load more** for older ones. Every row carries the balance after it. **Download CSV** saves every entry as a spreadsheet file, oldest first, in every currency, with dates in UTC.
- **Settings** holds your **Payout schedule** (see above) and your **Stripe account**: its badge, and **Details** for whether charges and payouts are on, whether your details are submitted, and your account ID.

If Stripe still needs something from you, the banner at the top says what, and **Settings** points you back to it.

## Cash you took at the door

The cash itself never goes through a payout: you are already holding it, and Stripe only moves money it collected.

Not all of that cash is yours, though. A cash sale charges the buyer the ticket price and tax, with no platform fee and no processing fee. Ithas Fire collects the tax and pays it to the state, so each cash sale records the tax against your balance, and it comes off your next payout.

If the door took only cash, or the tax you owe is more than your card sales, your balance goes negative. No payout goes out, and nothing needs doing: the amount carries forward and your next card sales pay it off before anything is transferred. You don't need Stripe set up to sell cash.

Comped tickets are recorded at $0 and owe nothing. Refund a cash sale at the door, or cancel the event, and its tax is no longer owed.

To see what the door took in cash, open **Sell** under **Door & crew** and expand **Cash taken tonight**: it gives you the figure that should be in the box for that event, the number of comps, and anything handed back. That figure includes the tax on each sale, and the panel shows how much of it you owe.

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

Refunds come off your balance when they happen. If a refund takes your balance below zero, the shortfall carries forward and is recovered from your next payouts.

When a buyer disputes a charge with their card issuer, the disputed amount is held out of your payable balance while the card network reviews it. Ithas Fire is the merchant of record, so we respond to the dispute with the network and email you at each step. The rest of your balance keeps paying out as normal.

### If a dispute is lost

- The disputed amount is deducted from your upcoming payouts. If that money had already been paid out, the deduction carries forward until your next sales cover it.
- The card network's dispute fee is not passed on to you for ticket sales. For memberships, the fee is deducted along with the disputed amount.
- If the order had already been refunded, nothing further is deducted.

If a dispute is won, the hold is released and anything already deducted for it is credited back.

:::warning
A dispute can arrive weeks after an event, after you have been paid for it. Bear that in mind before spending a payout in full.
:::

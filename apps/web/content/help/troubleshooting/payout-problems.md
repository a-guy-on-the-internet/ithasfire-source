---
title: "My payout is stuck or late"
description: "Why a payout hasn't arrived yet, and what actually gets it moving."
category: "troubleshooting"
order: 3
tags: ["payouts", "stripe", "settlements", "organiser"]
related:
  [
    "organising-events/payouts-and-settlements",
    "organising-events/create-an-event",
  ]
---

Payouts involve two steps: Ithas Fire transfers funds to your Stripe Connect balance, then Stripe deposits them in your bank. This article covers the first step — if your Stripe balance looks right but hasn't landed in your bank, that's on Stripe's side, not ours.

## How a payout is worked out

You have one running balance per currency. Every sale adds to it on the date that sale becomes payable (its payout schedule), and every refund subtracts from it immediately. Once a night, we pay out whatever has become payable.

Two things follow, and they explain most "where is my money" questions:

- **Nothing is ever stuck in a broken state.** If a payout does not go out tonight, the money stays on your balance and goes out on the next run that can pay it. There is no failed record to reset and nothing for you to retry. A payable balance under the minimum waits until it grows past it, as more sales come in or as sales you already made become payable.
- **A refund reduces the very next payout.** Even if the sale it refunds has not been paid out yet. If a refund is larger than your current balance, the balance goes negative and the next sales top it back up before anything transfers.

Your balance, and everything that makes it up, is on the **Payouts** page in your admin. The top says what the next run sends to your Stripe account, beside **Owed to you**. **Coming up** lists the dates the rest becomes payable. The **Ledger** shows your five newest entries; **Show all entries** opens the rest, and every row carries the balance after it.

## Common reasons a payout hasn't arrived

- **The event's payout date hasn't come yet** — each event pays out on the schedule chosen for it (**As soon as possible**, **Week of event**, **1 week after**, **2 weeks after** or **~1 month after**), counted from when the event ends, so nothing pays out while an event is still to come. The **Payouts** page lists the date each event's sales become payable.
- **The payment hasn't cleared** — no sale is paid out before its own funds clear, which takes two business days (a weekend sale counts from the Monday). On the later schedules this makes no difference, but on **As soon as possible**, or **Week of event** for a Friday show, tickets sold on the night pay out a day or two behind the ones sold in advance.
- **Resale hold** — if the settlement is from a resale sale, we hold funds until the resale release date before transferring: 7 days after the event, unless you set a different hold. The hold never ends before the buyer's 3-day claim window closes, so a shorter setting is treated as 3 days.
- **Refunds ate the balance** — refunds come off the balance the moment they happen. A large refund can take a payout below the minimum, or negative; the next sales rebuild it.
- **Below the payout minimum** — a small balance waits rather than paying out, so transfer fees don't eat the payment. The **Payouts** page shows the current minimum and how far your balance is from it. The wait ends once enough sales become payable to pass it.
- **An open dispute or resale claim** — money from a disputed order is held out of the payable balance while the dispute is open. The rest of your balance still pays normally. If the dispute is lost, the disputed amount is deducted from your upcoming payouts; if the order had already been refunded, nothing further comes off. See [refunds and chargebacks](/help/organising-events/payouts-and-settlements#refunds-and-chargebacks).

## If nothing has paid out for a while

When we cannot pay you, we skip — we never mark your money lost. Common causes:

- **Stripe account restriction** — Stripe may have temporarily restricted your account (KYC review, suspected activity, bank issue). Check the banner in your [Stripe dashboard](https://dashboard.stripe.com/).
- **Deauthorised Stripe connection** — if you disconnected Ithas Fire from Stripe, or revoked API access, further transfers fail. Reconnecting from **/admin/{your-slug}/payouts** is not enough on its own: a deauthorised payout account stays restricted on our side even after you reconnect, so email [support@ithasfire.com](mailto:support@ithasfire.com) and we'll clear it. After you reconnect, the **Payouts** page still shows the **Stripe account** badge as **Incomplete**, and the banner says the account is still restricted on our side.
- **Transfers capability not active** — your Stripe account can be able to take payments and pay out to your own bank while still not being cleared to *receive* transfers from us (Stripe verifies these separately). Your **Payouts** page shows the **Stripe account** badge as **Incomplete**, and the banner at the top shows **Payouts** as **off** with this reason, even though Stripe's own dashboard looks fine. Finish any outstanding verification Stripe asks for; if there's nothing outstanding, contact support.
- **Insufficient platform balance** — rare; a platform-side issue we investigate automatically.

:::tip
We get an alert whenever a payout is skipped or fails, so support has usually seen it before you do. Whatever the cause, **your balance is untouched** — once the blocker clears, the next nightly run pays it in full, including everything that built up while you were blocked. If it has been more than a business day with no contact, email [support@ithasfire.com](mailto:support@ithasfire.com).
:::

## Where refund money comes from

Refunds come out of your pending balance first. If your pending balance is too small, we reverse the transfer we already sent you; if your Stripe balance doesn't cover that either, the shortfall carries forward against your next payouts.

Refunds and chargebacks can land weeks after an event, so keep a small buffer in your account during that period.

## If you disconnected Stripe by mistake

Once you're deauthorised in Stripe, we can no longer transfer to you. Your balance keeps accruing the whole time — nothing is lost. Reconnect at **/admin/{your-slug}/payouts** and the next nightly run pays out everything that accumulated while you were disconnected.

:::warning
Don't delete your Stripe Connect account while you still have a balance with us — the funds get stuck in Stripe's system rather than being returned to you automatically. Contact support before closing a Stripe account linked to Ithas Fire.
:::

## Still stuck?

Open **/admin/{your-slug}/payouts** and email support. Include:

- Your organisation name and the currency involved
- The balance you see, and what you expected
- Event name and date, if it's about one specific event
- The date of the most recent payout you did receive

We reply within one business day.

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

- **Nothing is ever stuck in a broken state.** If a payout does not go out tonight, the money stays on your balance and goes out on the next run that can pay it. There is no failed record to reset and nothing for you to retry.
- **A refund reduces the very next payout.** Even if the sale it refunds has not been paid out yet. If a refund is larger than your current balance, the balance goes negative and the next sales top it back up before anything transfers.

You can see the list in **/admin/{your-slug}/payouts**.

## Common reasons a payout hasn't arrived

- **Payout schedule hasn't hit yet** — check which option this event uses (ASAP / WEEK_OF_EVENT / ONE_WEEK_AFTER / TWO_WEEKS_AFTER / FOUR_WEEKS_AFTER). Later schedules mean longer waits.
- **Event not marked complete** — payouts gated to event end. For schedules other than `ASAP`, transfers don't start until the event's `endsAt` passes.
- **Resale buyer-protection window** — if the settlement is from a resale sale, we hold funds through the full 3-day post-event window before transferring.
- **Refunds ate the balance** — refunds come off the balance the moment they happen. A large refund can take a payout below the minimum, or negative; the next sales rebuild it.
- **Below the payout minimum** — balances under the minimum (currently $10) wait rather than paying out, so a $10 transfer isn't eaten by fees.
- **An open dispute or resale claim** — money from a disputed order is held out of the payable balance until the dispute closes. The rest of your balance still pays normally.

## If nothing has paid out for a while

When we cannot pay you, we skip — we never mark your money lost. Common causes:

- **Stripe account restriction** — Stripe may have temporarily restricted your account (KYC review, suspected activity, bank issue). Check the banner in your [Stripe dashboard](https://dashboard.stripe.com/).
- **Deauthorised Stripe connection** — if you disconnected Ithas Fire from Stripe, or revoked API access, further transfers fail. Reconnecting from **/admin/{your-slug}/payments** is not enough on its own: a deauthorised payout account stays restricted on our side even after you reconnect, so email [support@ithasfire.com](mailto:support@ithasfire.com) and we'll clear it. You may see your Payments page look healthy while publishing a paid event still fails — that's this.
- **Transfers capability not active** — your Stripe account can be able to take payments and pay out to your own bank while still not being cleared to *receive* transfers from us (Stripe verifies these separately). Your Payments page shows **Payouts enabled: No** in that case even though Stripe's own dashboard looks fine. Finish any outstanding verification Stripe asks for; if there's nothing outstanding, contact support.
- **Insufficient platform balance** — rare; a platform-side issue we investigate automatically.

:::tip
We get an alert whenever a payout is skipped or fails, so support has usually seen it before you do. Whatever the cause, **your balance is untouched** — once the blocker clears, the next nightly run pays it in full, including everything that built up while you were blocked. If it has been more than a business day with no contact, email [support@ithasfire.com](mailto:support@ithasfire.com).
:::

## If a refund unexpectedly debited your bank

Refunds come out of your pending settlement balance first. If your pending balance is zero or too small, Stripe debits the bank account linked to your Stripe Connect profile for the difference.

This is normal and expected after an event — chargebacks and late refunds can land weeks later. Keep a small buffer in the account during the weeks after an event so a surprise debit doesn't bounce.

## If you disconnected Stripe by mistake

Once you're deauthorised in Stripe, we can no longer transfer to you. Your balance keeps accruing the whole time — nothing is lost. Reconnect at **/admin/{your-slug}/payments** and the next nightly run pays out everything that accumulated while you were disconnected.

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

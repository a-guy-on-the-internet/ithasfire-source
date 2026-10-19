---
title: "How to buy tickets"
description: "All payment methods, the 15-minute hold, and how fees work."
category: "buying-tickets"
order: 1
tags: ["purchase", "payment", "checkout", "holds", "promo-codes"]
related:
  [
    "buying-tickets/digital-tickets",
    "buying-tickets/manage-your-orders",
    "buying-tickets/where-is-this-event",
  ]
faqs:
  - q: "What payment methods does Ithas Fire accept?"
    a: "Ithas Fire uses Stripe and accepts Visa, Mastercard, American Express, Discover, Apple Pay, Google Pay, and US bank account (ACH) for eligible events."
  - q: "How long do I have to complete checkout?"
    a: "Opening checkout places a 15-minute hold on your tickets. A countdown is shown at the top of the page. If you don't pay in time, the hold releases and the tickets return to the pool."
  - q: "How are fees calculated?"
    a: "Fees are the platform fee and the payment processing fee, listed separately and added on top of the ticket price. The total at checkout is exactly what you'll be charged."
  - q: "Can I check out as a guest?"
    a: "Yes. Enter your email to check out as a guest, or sign in for a faster flow. Your tickets are emailed to the address you provide and they show at /my-tickets once you have an account with that email and have verified it."
  - q: "What is an adjustable-price ticket?"
    a: "Some events offer adjustable-price tiers where you choose what to pay, at or above a minimum. Checkout starts at the organiser's suggested amount. Drag the slider, tap a preset amount, or type an exact figure. The amount you choose is the ticket price, fees and tax are added to it, and the total updates as you change it."
---

Checkout is a single page optimised for speed. Most purchases complete in under 60 seconds.

## Payment methods

Ithas Fire uses Stripe for payments. Accepted methods:

- Visa, Mastercard, American Express, Discover
- Apple Pay (iOS / Safari on macOS)
- Google Pay (Android / Chrome)
- US bank account (ACH) for eligible events

## Step-by-step

1. On the event page, click **Get tickets**.
2. Pick ticket types and quantities. Assigned-seating events show a seat map instead of simple counters. On phones, tap a section to zoom in and then tap seats — pinch or drag to move around the map.
3. Review the order summary: subtotal, fees, tax and total are all shown before you pay.
4. Enter your email (or sign in for a faster flow).
5. Enter payment details or choose a saved wallet method.
6. Click **Pay**.

:::tip
On an adjustable-price ticket, where you pick what to pay, checkout starts at the suggested amount and shows the minimum. Drag the slider, tap a preset amount, or type an exact figure before continuing. Fees and tax are added to the amount you choose, and the total updates as you change it.
:::

## The 15-minute hold

Opening checkout places a **15-minute hold** on your tickets. A countdown appears at the top of the page. If you don't pay in time, the hold releases and the tickets return to the pool — you can start again, but they might sell to someone else first.

## Fees

The price on the event page already includes the ticket, fees and tax for one ticket. Under it, the page lists what that price is made of — for example "$50.00 ticket + $2.45 fees + $4.13 tax". The "fees" figure is the platform fee and the payment processing fee together. A part that comes to $0 isn't listed.

Fees are added on top of the ticket price on every event. A ticket that costs $0 has no fees: it adds no platform fee, processing fee or tax to your order, even when the other tickets in it are paid. Adjustable-price tickets work the same way as fixed-price ones: the "From" price is what one ticket costs at the minimum, with fees and tax included. A $5.00 minimum reads "From $6.09" where the place charges 8.88% tax. Choose a higher amount at checkout and the fees and tax are worked out on that amount instead.

Checkout itemises the platform fee, the processing fee and tax on separate lines, and your order in **My Tickets** lists any platform fee, processing fee and tax you paid. The total shown at checkout is exactly what you'll be charged. Some cities add their own tax on admission, such as Minneapolis's 3% entertainment tax; it is part of the tax figure, which then shows no percentage.

:::warning
The payment processing fee isn't refunded, even when the organiser cancels the event, because the card network keeps it. The ticket price, the platform fee and tax come back. See [refunds and cancellations](/help/buying-tickets/refunds-and-cancellations).
:::

## Promo codes

Type a code into **Promo code** in the order summary and click **Apply**. The discount appears as its own line, and the total already includes it — tax is worked out on the discounted price, so the total you see is what you'll pay.

A code that brings a ticket all the way down to $0 takes that ticket's platform fee off as well. The platform fee, the processing fee and any tax charged on them are then worked out on the tickets you still pay for. A ticket that is only partly discounted keeps the platform fee on its full price. A membership discount works the same way.

If a code doesn't apply to your cart yet — for example, your order is under the code's minimum, or the code doesn't cover the tickets you picked — **it stays applied**, with the reason shown next to it and a $0 discount. Change your cart (add tickets, raise a pay-what-you-want amount) and it applies on its own. While one code is flagged like this, your other codes don't apply either: fix the cart or remove that code. You can't pay with a flagged code still applied.

A code that can't be combined with the others, isn't recognised, or has been used up is **removed**, and a message says which code and why. If it was your only code, it stays in place with the reason shown instead, so you can see what went wrong.

If your discounts can't be checked at the moment (a connection problem, not a problem with the code), a note under **Promo code** says so. Your codes stay applied, and any that are valid come off when you pay. A code that came in a link and couldn't be checked isn't applied: type it into **Promo code** to try again.

## Fee waivers

Some buyers and events have a fee waiver, which covers the platform fee on a set number of tickets. The event page and the ticket step can't tell yet, so their estimate includes the full platform fee. Once your tickets are held, the platform fee in the order summary drops, and a **Fee waiver applied** line under it shows how much came off. A ticket that a promo code makes free has no platform fee to cover, so it doesn't use the waiver up: the waiver goes to a ticket that still has one.

If someone else uses the last of a shared waiver before you pay, the payment step shows the full platform fee and no waiver line. The total there is still exactly what you'll be charged.

## Coming back from a payment page

Now and then a payment asks you to approve it on another page, such as a card check from your bank, then brings you back to checkout. While we check the payment with Stripe, checkout shows **Confirming your payment…** instead of the order form. Wait on this screen: it moves on by itself. If you reload the page, checkout checks the payment again.

What you see next depends on what we can confirm:

- **Your order confirmation**: the payment went through and your order is confirmed.
- **Your payment was received; we're finishing your order.**: Stripe took the payment but your order isn't confirmed yet. It's completed automatically shortly afterwards and your tickets arrive by email. Open **View Tickets** to see the order.
- **Your payment was submitted…**: Stripe reported the payment as still clearing, and we couldn't confirm your order yet. We email you when your order is confirmed.
- **We couldn't confirm your payment. Check My tickets before trying again.**: we couldn't tell whether the payment went through, or it's still waiting for you to approve it. Open **View Tickets** first. If the order is there, you're done.
- **This payment was made from a different account.**: you came back signed in to another account. Sign in to the account that paid to see your tickets.

If Stripe confirms the payment was declined or cancelled, you're taken back to the ticket step with the reason, and you can try again. If we can't reach Stripe to confirm it, you see the "couldn't confirm" screen instead.

:::warning
On the "payment received", "submitted" or "couldn't confirm" screens, don't buy the same tickets again until you've checked **My Tickets**. A second checkout is a second charge.
:::

## Paying by bank account (ACH)

You approve a US bank account payment without leaving checkout. When you choose it, checkout tells you that bank payments take a few business days to clear.

After you pay, checkout shows **Payment processing** instead of the usual confirmation, with your order number, what you bought and the total. Your tickets are issued once the payment clears, and we email them to you. Until then, the order shows **Payment processing** in My Tickets.

If the bank payment doesn't go through, we cancel the order and email you. You aren't charged, and you can buy again from the event page.

## Payment failed?

See [payment issues](/help/troubleshooting/payment-issues) for common declines and fixes.

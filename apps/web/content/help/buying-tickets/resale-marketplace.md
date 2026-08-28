---
title: "Resale marketplace"
description: "Resale is not currently available — how the marketplace works when it returns."
category: "buying-tickets"
order: 6
tags: ["resale", "marketplace", "transfers", "selling"]
related: ["buying-tickets/manage-your-orders", "buying-tickets/digital-tickets"]
specs:
  [
    "2026-03-16/completed/resale-marketplace",
    "2026-08-10/time-based-ticket-pricing",
  ]
---

:::warning
**Resale is not currently available on Ithas Fire.** Listing a ticket, the **Resell** button, and the seller dashboard are all switched off for now. If you can't use a ticket, [transfer it](/help/buying-tickets/manage-your-orders) to someone else instead. The rest of this article describes how the marketplace works when it returns.
:::

When an organiser enables resale on an event, you can list your ticket for sale, or buy one from another attendee. Every transfer is tracked — no screenshots, no scams.

## Selling a ticket

Eligibility — the ticket must be:

- Status `VALID` (not refunded, transferred, or already listed)
- On an event that hasn't started
- From a ticket type where the organiser enabled resale

You also need a **Stripe Connect account with payouts enabled** to receive the money. Set it up from [Settings → Billing & contact](/account/settings/billing) if you haven't already.

### Steps

1. Open the order at [/my-tickets](/my-tickets) or the hub at **/sell/listings**.
2. Click **List for Sale** on an eligible ticket.
3. Set an **ask price**. If the organiser set a resale cap, you'll see the maximum.
4. Confirm. Your ticket status changes to `LISTED`.

Track listings as **Active**, **Held** (buyer in checkout), **Sold**, **Cancelled**, or **Expired** in the **/sell/listings** dashboard.

### When you get paid

You don't get the money immediately. Ithas Fire holds the funds through a **3-day buyer-protection window after the event ends**. If no claim is filed, the payout releases to your Stripe account.

:::warning
If the buyer files a claim that we approve (invalid ticket, entry denied, wrong seat), you get **zero** — the buyer is fully refunded. This is industry-standard for resale and is why we hold funds after the event.
:::

## Buying a resold ticket

On any event page, resold tickets appear below the primary tickets with their ask price plus estimated fees. Click a listing to see detail, then checkout.

Where the ask differs from what the seller originally paid, the listing also shows a **Face value** line. That figure is the ticket's price at the moment the seller bought it — not what the same ticket type costs today. If the organiser has raised the price since, a listing can sit *below* the current price and still show a lower face value; an early-bird ticket resold later is the usual case. Comped tickets show a face value of zero, because nothing was paid for them.

- A 15-minute hold starts when you enter checkout
- On successful payment, the **QR code is regenerated** — the seller's original code no longer works, only yours does
- Ownership transfers to your account; it shows up at [/my-tickets](/my-tickets) like any other order

:::tip
You can file a buyer-protection claim during the event and for 3 days after, if the ticket doesn't work. Reasons: invalid ticket, denied entry, wrong seat. Filing a claim from your order detail page freezes the seller's payout pending review.
:::

## What can go wrong

- **You can't buy your own listing** — the system blocks this
- **Price caps** — if the organiser set a resale cap, you can't list above it. The cap that applies is the one set *now*, not the one in force when you bought
- **Listings expire at event start time** — you can't list for events that have already started
- **Original ticket code stops working the moment a sale completes** — don't try to use both
- **"We couldn't confirm this ticket's original price"** — listing is blocked because we can't trace the ticket back to what was paid for it, so we can't work out the seller's and organiser's shares fairly. This shouldn't happen to a ticket bought through Ithas Fire; [contact support](/support) with your order number and we'll sort it out

:::tip
Raising or lowering a ticket type's price never changes the face value of tickets already sold. Each ticket keeps the price it was bought at, so an early-bird buyer's resale is measured against the early-bird price — and the organiser's share of any mark-up is worked out from that, not from today's price.
:::

## Fees and organiser royalties

Buyers pay the ask price + booking fee + tax. Sellers receive the ask price minus a platform fee. If the organiser opted in, they also earn a **creator royalty** — a small percentage of each resale, separate from the platform fee.

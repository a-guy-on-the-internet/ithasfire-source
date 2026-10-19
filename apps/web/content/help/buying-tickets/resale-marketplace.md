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
    "2026-08-10/completed/time-based-ticket-pricing",
    "2026-10-12/organiser-resale-share",
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

A ticket you bought on resale can be listed again, and so can the next buyer's. There's no limit on how many times a ticket changes hands. The one exception is a ticket whose purchase was refunded to you: it can't be listed.

You also need a **Stripe Connect account with payouts enabled** to receive the money. Set it up from [Settings → Billing & contact](/account/settings/billing) if you haven't already.

### Steps

1. Open the order at [/my-tickets](/my-tickets) or the hub at **/sell/listings**.
2. Click **Resell** on an eligible ticket.
3. Set an **ask price**. As you type, the form shows the split for that price: the share that goes **To the people who put on the night**, **You receive**, and what the buyer pays. If the organiser set a resale cap, the most you can ask is the cap, or the ticket's original price if that is higher. A ticket the organiser gave away free has an original price of $0, so the cap applies to it as set. If the buyer pays the share (see [the share](#the-share-for-the-people-who-put-on-the-night)), the ask plus the share has to fit under the cap. Over the limit, the form shows the most the ticket can sell for and a button, **Ask** followed by that amount and "instead", that fills in the highest price that fits.
4. Click the **List for** button, which names your asking price. Your ticket status changes to `LISTED`.

If what you would receive is less than you paid for the ticket, the form tells you by how much.

If you cancel a listing, or it expires, you can list the same ticket again.

Track listings as **Live**, **Checkout in progress**, **Sold**, **Cancelled**, or **Sale window closed** in the **/sell/listings** dashboard.

### When you get paid

You won't get the money immediately. Ithas Fire will hold the funds until a **release date after the event ends**: 7 days after the event, unless the organiser has set a different hold. The hold never ends before the 3-day claim window closes, and it moves with the event if the event is rescheduled. If no claim is filed, the payout will release to your Stripe account on the release date. If a claim is open, the money stays on hold until support decides it.

:::warning
If the buyer files a claim that we approve (the ticket didn't scan, entry was refused, wrong seat), you get **zero** and the buyer is fully refunded. This is standard for resale and is why we hold funds after the event. See [If a buyer files a claim on your ticket](#if-a-buyer-files-a-claim-on-your-ticket).
:::

## Buying a resold ticket

On any event page, resold tickets appear below the primary tickets with the price you would pay. Click a listing to see detail, then checkout.

Each listing shows the price you pay first, with processing included and tax still to come. Processing covers the whole charge, so tax adds a little processing too; checkout shows both. Under it you see the **Original price** and what goes to the people who put on the night: when the seller pays the share, an amount such as "$5.00 of the ticket price"; when the buyer pays it, the ticket price plus the share.

At checkout you see **Estimated taxes** and an **Estimated total**, and the **Pay** button shows that total. If the tax worked out for your order makes the total higher, checkout stops before charging you and shows the new total; check it, then press **Pay** again. When the tax can't be estimated ahead, checkout shows a **Subtotal** with "Tax is added at checkout.", and your first press of **Pay** shows the total before anything is charged.

**Original price** is what the organiser charged for the ticket at its first sale, never the price of the last resale. A ticket resold several times still shows its first price. A ticket the organiser gave away free shows the ticket type's price followed by "given free". On a pay-what-you-want ticket it reads "from" the minimum price, not what the first buyer chose.

- A 15-minute hold starts when you enter checkout
- If you pay by bank account, the payment takes a few business days to clear. Checkout shows **Payment processing**, and the ticket becomes yours once the payment clears; we email you then. If the payment doesn't go through, the order is cancelled and you aren't charged
- Once the payment goes through, the **QR code is regenerated** — the seller's original code no longer works, only yours does
- Ownership transfers to your account; it shows up at [/my-tickets](/my-tickets) like any other order

## If a resold ticket doesn't work

You can file a claim from the event's start until 3 days after it ends. Claims cover tickets that didn't scan, entry being refused, a wrong seat or section, or something else that went wrong with the ticket.

1. Open the order at [/my-tickets](/my-tickets).
2. Under **Problem with this ticket?**, click **File a claim**.
3. If the order has more than one ticket, pick the one that didn't work, then choose what went wrong.
4. Describe what happened and when. Claims are text only for now, so you can't attach photos or files.
5. Click **Send claim**.

Support reviews every claim, and nobody's claim is closed without a decision. We tell the seller, and they can reply. The order page shows where your claim stands, along with the seller's reply and any note from support.

- **Approved:** you get a full refund of what you paid. When the refund goes through, we tell you in the app and by email, and the order page shows it as confirmed. Your bank can take 5 to 10 business days to show the money. Until the refund goes through, the order page doesn't offer **Request Full Refund**.
- **Denied:** there's no refund. If you think that's wrong, contact support from the order page.

You can only file a claim on a ticket you still hold, not one you've transferred, given away or listed for resale. While a claim is open you can't transfer, send or resell the ticket, and if it's approved that stays true until your refund goes through.

## If a buyer files a claim on your ticket

We email you, and the claim appears at **/sell/claims**. Open it to read what the buyer wrote, then click **Send reply** to give your side. You can change your reply until support decides, so reply as soon as you can. Support can decide at any time, and doesn't have to wait for your reply.

We never show you the buyer's email or contact details.

While the claim is open, the money from that sale stays on hold, even after the usual release date. If support denies the claim, the hold lifts and the money is paid out as usual. If support approves it, the buyer is refunded in full and you aren't paid for that ticket.

## What can go wrong

- **You can't buy your own listing** — the system blocks this
- **Price caps** — if the organiser set a resale cap, you can't list above it, unless the ticket's original price was higher: then that price is your limit (a ticket the organiser gave away free has an original price of $0, so the cap applies as set). The cap that applies is the one set *now*, not the one in force when you bought. When the buyer pays the share, the ask plus the share has to fit under the cap
- **Listings expire at event start time** — you can't list for events that have already started
- **Original ticket code stops working the moment a sale completes** — don't try to use both
- **A refund on the ticket is being processed.** While it is, you can't transfer, send, or resell the ticket. Try again in a few minutes.
- **"We couldn't confirm this ticket's original price"** — listing is blocked because we can't trace the ticket back to what was paid for it, so we can't work out the split fairly. This shouldn't happen to a ticket bought through Ithas Fire; [contact support](/support) with your order number and we'll sort it out

:::tip
Raising or lowering a ticket type's price never changes the original price of tickets already sold. Each ticket keeps the price it was first sold at, so an early-bird ticket resold later still shows the early-bird price.
:::

## The share for the people who put on the night

Every resale pays the people who put on the night the share the organiser set, which can be 0%. The organiser sets it in the event's agreement, in the **Resale** block of **The deal**; resale can't be switched on for the event until a share is set. It is one of:

- a **percentage** of the asking price, up to 10%, or
- a **flat** amount per resale. On a cheap sale the flat amount is held to 10% of that sale's asking price.

The organiser also chooses **who pays it**. By default it is the **seller**: you receive the asking price minus the share, and the buyer pays the asking price. If the organiser chose the **buyer**, the share is added on top: you receive the full asking price and the buyer pays the asking price plus the share.

The share applies to every resale, including one at or below the original price, and to every later resale of the same ticket. A ticket keeps the share recorded at its first sale, even if the organiser changes it afterwards. A ticket sold before any share was set gets the share in force when it is first listed, and keeps that one. Ithas Fire takes nothing from the share.

Buyers also pay a **Processing fee** and any tax due. There's no platform fee on a resale purchase.

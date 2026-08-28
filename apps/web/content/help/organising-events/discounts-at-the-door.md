---
title: "Apply a discount at the door"
description: "Use your existing promo codes on in-person sales from the Sell tab of the scanner app."
category: "organising-events"
order: 5
tags: ["promo", "discount", "door", "pos", "scanner", "organiser"]
related:
  [
    "organising-events/selling-at-the-door",
    "organising-events/check-in-scanning",
    "organising-events/issue-comp-tickets",
    "organising-events/manage-ticket-types",
  ]
---

The same promo codes you use online work on in-person sales. Enter the code on the **Sell** tab before taking payment and the discount comes off the total the walk-up buyer pays — by card or cash.

This article covers the **operator app**. The browser box office at **Sell** takes card, cash and comp but has no promo-code field, so a walk-up discount has to go through the app — see [sell tickets at the door](/help/organising-events/selling-at-the-door).

## Before you start

You need the **Owner**, **Admin**, **Editor**, or **Scanner** role on the organisation running the event to sell at the door. Creating and editing the codes themselves is separate: that needs **Owner**, **Admin**, or **Finance**, and happens at **/admin/{your-slug}/promos**.

The **Sell** tab only appears once you've selected an event that has ticket types available for door sales. If you don't see it, check that the event has at least one on-sale ticket type.

## Apply a code to a sale

1. On the **Sell** tab, add the tickets the buyer wants using the **+** and **−** steppers.
2. Enter the code in the **Promo code** field and tap **Apply**.
3. The code appears below the cart with the amount it took off, and the total updates.
4. Take payment with **Tap to Pay** or **Cash**.

You can apply up to four codes to one sale, but only if every code is marked as stackable. If any of them isn't, the second code is rejected and the first stays applied.

:::tip
Change the cart after applying a code and the discount recalculates automatically. This matters for percentage codes and for codes with a minimum spend — adding or removing a ticket can change what the code is worth, or stop it applying at all.
:::

## Door prices and discounts

If a ticket type has a separate door price, the discount is calculated against that door price, not the online price. A 50% code on a ticket that's $20 online and $30 at the door takes off $15, not $10. The total shown on the Sell tab is always what the buyer actually pays.

## Cash, comps, and $0 totals

Cash sales let you type the amount you actually collected, so you can still negotiate or round down after a code is applied — the code's discount and the cash you took are recorded separately.

A code that brings the total to $0 has to go through **Cash**, not **Tap to Pay**. Card readers can't charge $0. Record it as a cash sale with $0 collected and it's logged as a comp, with the ticket admitted straight away.

## Refunds

Door sales can be refunded from the app for **15 minutes** after the sale, and that needs the **Owner**, **Admin**, or **Editor** role — deliberately more than the **Scanner** role needed to make the sale. After 15 minutes, refund from the organiser dashboard instead.

Refunding a comp works the same way as any other refund: it revokes the ticket and its admission, and records $0.00 returned, because no money changed hands.

:::warning
Refunding a sale does not give the promo code's use back. If a code is limited to 50 redemptions, a refunded sale still counts against that 50. Bump the limit if you need the code to keep working.
:::

## What can go wrong

**"Promo not found"** — the code is mistyped, archived, or outside its start/end dates. Codes aren't case-sensitive.

**"Promo not applicable"** — the code is real but doesn't cover anything in this cart. Most often it's scoped to a different event, or to a ticket type the buyer isn't purchasing.

**"Minimum order not met"** — the cart is below the code's minimum spend. Add the missing ticket or drop the code.

**"Promo not stackable"** — one of the codes has to be used on its own. Remove the other one.

**The code disappeared after I changed the cart** — that's deliberate. If the recalculation fails (the cart dropped below a minimum, the code hit its redemption limit, or the connection dropped), the code is removed rather than left showing a discount the sale wouldn't honour. Re-enter it once the cart is right.

**The code was accepted, then refused when I took payment** — the discount shown on the Sell tab is a quote. Codes are checked again the moment the sale goes through, so one that hits its redemption limit (or gets archived) in the seconds between can still be turned down. The sale isn't recorded, and the reason appears above the payment buttons. Nothing is charged, so just re-ring it.

:::warning
Per-person redemption limits don't restrict anything at the door. Walk-up buyers are anonymous — there's no account to count against — so a code limited to "one per person" can be used on every door sale. If that matters, put a **total** redemption limit on the code as well; total limits are enforced everywhere.
:::

## Next steps

Codes are created and archived under **Promos** in your organiser dashboard. If you're handing out free tickets in advance rather than at the door, [issue comp tickets](/help/organising-events/issue-comp-tickets) instead — those go to a named recipient by email. For getting people through the door once they've bought, see [check-in and scanning](/help/organising-events/check-in-scanning).

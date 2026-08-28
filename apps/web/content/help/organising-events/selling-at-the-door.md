---
title: "Sell tickets at the door"
description: "Run a box office from a browser — card on a reader, cash, or comp — and reconcile the cash at the end."
category: "organising-events"
order: 6
tags: ["door", "pos", "box-office", "cash", "comp", "reader", "organiser"]
related:
  [
    "organising-events/payouts-and-settlements",
    "organising-events/check-in-scanning",
    "organising-events/issue-comp-tickets",
    "organising-events/discounts-at-the-door",
  ]
---

**Sell**, under **Door & crew**, is a box office you run in a browser. It sells the same ticket types as your event page, takes card on a countertop reader, cash, or comps a guest, and admits whoever you sell to on the spot.

## Before you start

You need the **Owner**, **Admin**, **Editor**, or **Scanner** role on the group running the event.

Card payments need a reader paired first — see **Card readers**, also under **Door & crew**. Cash and comp work without one, so a venue with no hardware can still run a door.

The first time you open **Sell** you'll get a short list of seller terms and a **Got it** button. Nothing sells until you accept them. You accept once per account, not once per device: accept on your laptop and the operator app stops asking too.

:::tip
This is a different surface from the **Sell** tab in the operator app. Both take money and both admit the buyer, but the app adds Tap to Pay and promo-code entry, while the browser drives a countertop reader instead. If you need to apply a promo code to a walk-up, use the app — see [apply a discount at the door](/help/organising-events/discounts-at-the-door).
:::

## Ring up a sale

1. Pick the event at the top. It lands on the soonest one that's plausibly happening, so most nights you won't touch it.
2. Add tickets with the **+** and **−** steppers. Each row shows the price the door is charging and how many are left.
3. Check the running total under **This sale**.
4. Press the charge button. It states the amount — **Charge $70.00**, not "Continue" — so the last thing you read before taking money is the number.

**Clear sale** empties the cart if someone changes their mind.

### Rows that won't add

A ticket type can appear but refuse to go in the cart. The caption under its name says why: **Opens 8:00 PM** for a tier that isn't on sale yet, **Sales ended** for one that's closed. These stay visible on purpose — a tier that vanished would look like it was never set up.

### Door prices

A ticket type can carry a door price that differs from the online one. When it does, the row is labelled **DOOR PRICE**, so there's an answer ready when someone holds up a phone showing a different number.

### Pay what you can

On a pay-what-you-can tier, adding a ticket opens an amount control. Drag the slider, tap one of the preset amounts, or type a figure into the field.

The slider is helped: it pulls to round money, so a quick drag lands on $20 rather than $19.85. The typed field isn't, because typing is deliberate — $17.35 typed stays $17.35. It also accepts amounts above the slider's range; the handle just stops at the end and says so.

The amount is per ticket. Two tickets at $20 is $40, and the cart shows that working out.

Someone paying the floor has bought a full ticket. There is no "supporter" tier, no round-up, and nothing on the screen marks them out.

## Take payment

Three tenders, all on one screen.

**Card** sends the amount to a reader and waits. The screen names the reader and shows the amount large enough to read across a room. The buyer taps, inserts or swipes; the sale finishes on its own. If every paired reader is offline, the tile disables itself and cash stays available.

**Cash** records what you took. No reader involved.

**Comp** puts someone on the guest list at no charge. It asks once before it mints, because it can't be undone from this screen.

### If the reader doesn't answer

Venue wifi is the least reliable thing in most buildings. When a reader is offline or already busy, you get three ways out that all keep the cart: try that reader again, send it to a different one, or take the amount in cash. Nothing was charged, and the screen says so before it offers you any buttons.

**Cancel this charge** clears the reader without cancelling the sale, so you can send the same cart somewhere else.

## After the sale

The done screen shows the amount, the ticket count, and **Admitted · walk straight in**.

That last line is literal. Door sales admit the buyer as part of the sale, so there is no ticket to scan and no queue to rejoin.

**Next sale** clears the screen for the next person.

:::warning
Walk-ups have no email address on file, so they get no receipt, no reminders, and no way to find the event again. They also won't appear in your audience lists. Sell to a regular you want to reach later and you'll have no way to contact them.
:::

## Count the cash

Open **Cash taken tonight** at the bottom of the Sell screen. It gives you, for the selected event:

- what should be in the box
- how many sales and tickets that covers
- how many comps you gave out
- anything handed back

Cash never enters your Stripe balance and never appears in a payout, because you are already holding it. This panel is the only place it is counted — see [payouts and settlements](/help/organising-events/payouts-and-settlements).

## What can go wrong

**"Before you take your first payment" keeps appearing.** The terms were updated, so everyone accepts again. Read them and press **Got it** once.

**The card tile is greyed out.** Either no reader is paired for this group, or every paired one is offline. Check **Card readers**. Cash still works in the meantime.

**A sale fails and you retry.** A refused sale takes no money, and the till starts a clean one rather than jamming, so pressing again is safe.

**You need to reverse a card sale.** A card sale taken at the door refunds like any other card order. Find it under **Orders** and refund it there — that needs **Owner**, **Admin** or **Editor**, so a scanner-only operator will have to fetch someone.

**You need to reverse a cash sale or a comp.** There is no refund button for these yet, here or in the operator app. Hand the money back in person, then tell whoever reconciles the night: the sale still counts toward **Cash taken tonight**, so the drawer will read high by that amount until it's accounted for.

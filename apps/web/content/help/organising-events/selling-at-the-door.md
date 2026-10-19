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
specs: ["2026-10-07/door-sales-same-price-and-tax"]
---

**Sell**, under **Door & crew**, is a box office you run in a browser. It sells the same ticket types as your event page, takes card on a countertop reader, cash, or comps a guest, and admits whoever you sell to on the spot.

## Before you start

You need the **Owner**, **Admin**, **Editor**, or **Scanner** role on the group running the event.

The door only sells published events. A draft has nothing to sell until you publish it, and once an event is cancelled the door stops selling it, including comps.

Card payments need a reader paired first — see **Card readers**, also under **Door & crew**. Cash and comp work without one, so a place with no hardware can still run a door.

The first time you open **Sell** you'll get a short list of seller terms and a **Got it** button. Nothing sells until you accept them. You accept once per account, not once per device: accept on your laptop and the operator app stops asking too.

:::tip
This is a different surface from the **Sell** tab in the operator app. Both take money and both admit the buyer, but the app adds Tap to Pay and promo-code entry, while the browser drives a countertop reader instead. If you need to apply a promo code to a walk-up, use the app — see [apply a discount at the door](/help/organising-events/discounts-at-the-door).
:::

## Ring up a sale

1. Pick the event at the top. It lands on the soonest one that's plausibly happening, so most nights you won't touch it.
2. Add tickets with the **+** and **−** steppers. Each row shows the ticket price and how many are left.
3. Read out the total under **This sale**. There are two, card and cash, side by side (see below).
4. Press **Charge** and choose how they're paying.

**Clear sale** empties the cart if someone changes their mind.

### Both totals, before you charge

**This sale** lists the tickets, then breaks the price down in two columns, **Card** and **Cash**, the same way online checkout does:

- **Subtotal**: the tickets.
- **Platform fee** and **Processing fee**: card column only. The cash column shows a dash, because cash carries neither.
- One line per tax, with its rate, for example **Sales tax (9.25%)**.
- **Total** for each.

Read both out before the buyer says how they're paying; neither changes when they pick. Every change to the cart asks for fresh totals. Until they arrive the total reads **Total · updating** with dashes, and **Charge** stays off, so you never read out a number the till won't charge.

### Rows that won't add

A ticket type can appear but refuse to go in the cart. The caption under its name says why: **Opens 8:00 PM** for a tier that isn't on sale yet, **Sales ended** for one that's closed. These stay visible on purpose — a tier that vanished would look like it was never set up.

### Prices at the door

Tickets at the door cost what the event page shows. There is no separate door price. If a ticket type has a scheduled price change, the door switches to the new price at the same moment the event page does.

A card sale also adds what online checkout adds: the platform fee, the processing fee and tax (see [platform and processing fees](/help/organising-events/manage-ticket-types#platform-and-processing-fees)). That's the **Card** total, and it's the amount sent to the reader.

A cash sale is the ticket price plus tax, and nothing else: no platform fee, and no processing fee since no card is charged. So a buyer paying cash pays less than one paying by card. The system works out that total; you don't set it.

### Pay what you can

On a pay-what-you-can tier, adding a ticket opens an amount control. Drag the slider, tap one of the preset amounts, or type a figure into the field.

The slider is helped: it pulls to round money, so a quick drag lands on $20 rather than $19.85. The typed field isn't, because typing is deliberate — $17.35 typed stays $17.35. It also accepts amounts above the slider's range; the handle just stops at the end and says so.

The amount is per ticket. Two tickets at $20 is $40, and the cart shows that working out.

Someone paying the floor has bought a full ticket. There is no "supporter" tier, no round-up, and nothing on the screen marks them out.

## Take payment

Three tenders, all on one screen, each showing its own total.

Above them is **Buyer email (optional)**. Type the buyer's address and we send them their ticket and an itemised receipt. It doesn't create an account and doesn't sign them up for anything. If they sign up later with that address, the ticket is already there. Leave it blank and nothing is sent. The email works with all three tenders, comps included.

**Card** sends the card total, fees and tax included, to a reader and waits. The screen names the reader and shows the amount large enough to read across a room. The buyer taps, inserts or swipes; the sale finishes on its own. If every paired reader is offline, the tile disables itself and cash stays available.

**Cash** records the sale at the cash total on the tile: take that amount from the buyer. No reader involved.

**Comp** puts someone on the guest list at no charge: no fee and no tax. It asks once before it mints. Until you ring up the next sale, and for at most fifteen minutes, an **Owner**, **Admin** or **Editor** can reverse it from **Last sale**. After that, an **Owner**, **Admin** or **Editor** can void it from **Cash taken tonight** until seven days after the event ends: a comp's row there shows **Void** rather than **Refund** (see [what can go wrong](#what-can-go-wrong)). A comp with an email gets a $0 receipt.

### If the total moved

The total can change between reading it out and taking the money, for example when someone enters a tax rate by hand (see [when tax can't be worked out](#when-tax-cant-be-worked-out)).

- **Card**: while the reader waits, the screen says the total changed and shows what the reader is asking for, so you can tell the buyer before they tap.
- **Cash, higher**: the sale stops and nothing is recorded. The **Cash** tile shows the new total with a note. Tell the buyer, take the difference, and press **Cash** again.
- **Cash, lower**: the sale goes through at the lower total, and the done screen tells you how much to give back.

### If the reader doesn't answer

Wifi is the least reliable thing in most buildings. When a reader is offline or already busy, you get three ways out that all keep the cart: try that reader again, send it to a different one, or take payment in cash instead. Nothing was charged, and the screen says so before it offers you any buttons.

**Cancel this charge** clears the reader without cancelling the sale, so you can send the same cart somewhere else.

## After the sale

The done screen shows the amount (or **Comped**), the ticket count, and **Admitted · walk straight in**. If you took an email it also says where the receipt went, partly hidden, for example **Receipt sent to n•••@example.com**.

That last line is literal. Door sales admit the buyer as part of the sale, so there is no ticket to scan and no queue to rejoin.

**Next sale** clears the screen for the next person.

:::warning
A walk-up who leaves no email gets no receipt and no copy of their ticket, and has no way to find the event again. They won't appear in your audience lists either. If it's a regular you want to reach later, ask for their email before you take payment.
:::

## When tax can't be worked out

Tax is looked up from where the event happens, and the lookup sometimes doesn't answer. When that happens the sale stops at the cart rather than charge no tax: **Tax can't be worked out right now**, and nothing was charged. **Try again** asks once more.

An **Owner**, **Admin** or **Editor** also sees **Enter tax rate**. Type the total sales tax rate where the event happens, as a percentage (for example 9.25), then confirm it on the next screen, where it's shown large and in words. The rate you enter:

- applies to every sale of the event, at the door and online, until the lookup answers again
- is reported to us whenever the rate changes
- gives way to the looked-up rate once the lookup works again

If you have the **Scanner** role, you'll see that an Owner, Admin or Editor needs to enter the rate. Ask one of them, then press **Try again**.

Comps still work while tax is down, because a comp charges no tax. Press **Comp instead**.

## Count the cash

Open **Cash taken tonight** at the bottom of the Sell screen. It gives you, for the selected event:

- what should be in the box, tax included, and how many sales and tickets that covers
- the sales tax in it, which is owed
- **Yours to keep**: the cash minus that tax. Cash sales taken before 8 October 2026 also carried a platform fee; while any of those are in the count, a **Platform fee** line shows what they owe, and it comes off **Yours to keep** and out of your next payout along with the tax
- how many comps you gave out
- how many sales a code made free (counted as sales, not comps)
- anything handed back
- every cash sale for the event, newest first, with **Refund** on each one you can still refund. A $0 row (a comp, or a sale a code made free) shows **Void** instead: nothing changes hands, and its tickets stop working

The cash stays with you and never passes through Stripe. The tax inside it is collected by Ithas Fire and remitted to the state, though, so it comes off your next payout — see [payouts and settlements](/help/organising-events/payouts-and-settlements#cash-you-took-at-the-door).

## Selling from the operator app

The **Sell** tab in the operator app sells the same tickets at the same prices. The cart shows the same two totals, **Card** and **Cash**, line for line, with **Buyer email (optional)** and a **Promo code** field underneath (see [apply a discount at the door](/help/organising-events/discounts-at-the-door)). The roles are the same too.

**Tap to Pay** turns the phone into the card reader and asks for the card total. If the total moved after you read it out, the screen says so and shows what the reader is asking for, so you can tell the buyer before they tap.

**Cash** opens a cash sheet. **Cash due** is the cash total. Type what the buyer handed you under **Cash received**, or press **Exact**, and the sheet works out the **Change**. **Confirm cash** records the sale. The app won't record less than the cash due: if the total went up since you quoted it, the sheet shows the new amount, and you take the difference before confirming.

**Comp instead** sits on the cash sheet. It asks once (**Comp them** or **Don't comp**) and then admits them at no charge.

The done screen shows the amount, the change to hand back, and **Admitted · walk straight in**. **Next sale** starts over.

### Leaving a sale part-way

If you switch tab, switch event, or press back on Android while a sale is still going through, the app asks **Clear this sale?** first. **Keep it** takes you back. **Clear it anyway** drops the sale from the screen; for a card sale, the app also asks for the charge to be cancelled.

:::warning
A card sale can go through even after you clear it from the screen: the buyer may already have tapped. Until the app knows for sure, it shows **Don't take cash for the … card sale you cleared**, with the amount, and keeps it up while you ring up the next buyer. If the charge was cancelled in time, the notice changes to **Card sale cancelled**, and the card wasn't charged. Taking cash while the first notice is up can charge the buyer twice.
:::

### A card sale that won't close

If the buyer changes their mind after the reader opened, or the connection drops, the app can't always tell straight away whether the card was charged. The screen then says **Don't take cash for these tickets** and keeps checking. **Check again** asks once more. When the answer is final, it moves on by itself: to the done screen if the card was charged, back to the cart if it wasn't. If it can't be settled from the phone, **Start a new sale** leads to the same **Clear this sale?** question as above.

### When Tap to Pay stops

If the reader stops before the card is charged, the screen says so under the amount. **Back** returns you to the cart, where you can try again or press **Cash**. Some messages point at a fix:

- **Payment cancelled on the reader.** The reader was closed before the buyer tapped. The card wasn't charged.
- **NFC is turned off** or **Location is turned off.** Tap to Pay needs both. Turn the setting on in the phone's Settings, then try again.
- **Tap to Pay can't run on this phone right now.** Trying again won't help. Take cash, and ask an admin to check the phone and the Tap to Pay setup.

Most of these messages carry a line such as **Reader code: …** underneath. Quote that code if you contact support.

If the reader stops while it's confirming the payment, the screen says **The card may have been charged** instead. Press **Back**: the app checks with the server and shows **Don't take cash for these tickets** until it knows, as described above.

## What can go wrong

**"Before you take your first payment" keeps appearing.** The terms were updated, so everyone accepts again. Read them and press **Got it** once.

**The card tile is greyed out.** Either no reader is paired for this group, or every paired one is offline. Check **Card readers**. Cash still works in the meantime.

**A sale fails and you retry.** A refused sale takes no money, and the till starts a clean one rather than jamming, so pressing again is safe.

**No answer comes back.** If the connection drops mid-sale, the till can't know whether the sale went through. It locks the email, the cart and the other tenders and asks you to press the same one again: if the first went through, you get that sale back rather than a second.

**"Still being processed."** The first press is still going through. Wait a moment, then press the same tender again. If it keeps saying so, the till asks you to check instead.

**"This sale may already be recorded."** Press **See Cash taken tonight**: it opens the till's list of cash sales (for a card sale, check the event's orders). While you check, the **Last sale** row is hidden, because it shows the previous buyer's sale, not this one. If the sale isn't there, press **Clear sale**. The till asks first, since clearing and ringing the same tickets up again would sell them twice if the first sale did go through.

**You rang something up wrong.** After a sale, a **Last sale** row sits under the cart with a **Refund** button, for fifteen minutes or until the next sale, whichever comes first. It works for all three tenders and it pulls the admission back too, so the tickets stop working — useful when a comp went to the wrong person, since they were admitted the moment you comped them.

A cash refund gives back everything the buyer paid: the ticket price and the tax. The refund records that and the tax stops being owed, but handing the money over is still down to you. The till total updates to match either way.

A refunded or voided ticket goes back on sale. The number left beside that ticket goes up on the Sell screen and on your event page, so the next person at the door can buy it.

Reversing needs **Owner**, **Admin** or **Editor** — the same separation the rest of the product uses, where taking money and giving it back are different permissions. A scanner-only operator sees the last sale but no button, and will have to fetch someone.

**More than fifteen minutes have passed.** The row is gone by then. A card sale can still be refunded from **Orders** like any other card order. A cash sale or comp can be too, until seven days after the event ends: an **Owner**, **Admin** or **Editor** can refund it from **Sell** → **Cash taken tonight** (a comp, or a sale a code made free, shows **Void** there instead of **Refund**), and an **Owner**, **Admin** or **Finance** member can also refund it from **Orders** → the order → **Refund cash sale**. After that, contact support. Like the till's refund, it voids the tickets and the tax stops being owed, and handing the cash back is down to you.

**You cancel the event.** Every cash sale and comp rung up at the door for it is marked refunded and its tickets stop working. The tax on those sales is no longer owed; if a payout already took it, it's added back to your balance. We can't hand back cash, so returning it to buyers is up to you. A walk-up who left no email can't be reached by us. Card sales are refunded to the card, the same as online orders, and a card sale still waiting on the reader is cancelled, so tapping it afterwards charges nothing.

If a cash sale couldn't be marked refunded, we tell you when the cancellation finishes. An **Owner**, **Admin** or **Finance** member refunds it from **Orders** → the order → **Refund cash sale**. It isn't on the Sell screen, which lists only published events.

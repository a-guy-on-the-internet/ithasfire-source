---
title: "Manage ticket types"
description: "Configure tiers, pricing, capacity, and resale for your event."
category: "organising-events"
order: 2
tags: ["tickets", "pricing", "tiers", "resale"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/reuse-ticket-setups-with-templates",
    "organising-events/payouts-and-settlements",
    "organising-events/memberships",
  ]
specs:
  [
    "2026-04-18/completed/donation-ticket-type",
    "2026-08-10/completed/time-based-ticket-pricing",
  ]
---

Ticket types are the tiers buyers choose from on your event page. Most events run 1–3 tiers: General Admission, VIP, Early Bird.

Running the same setup across events? You can save an event's ticket types as a template and reuse them — see [Reuse ticket setups with templates](/help/organising-events/reuse-ticket-setups-with-templates).

On an event with a seating map, you can also give single seats their own price: see [Give single seats a custom price](/help/organising-events/price-individual-seats).

## Adding a ticket type

Open your event in the builder, jump to **Tickets** (the **Build** group in the side rail), and click **Add ticket type**. Each tier has:

- **Start from** — an optional preset at the top of the form (General Admission, Advance / Early Bird, Door, VIP, Student / Senior, Pay What You Want, Sliding Scale, Industry / Guest List). Picking one fills in the fields below with a starting name, pricing, and capacity; it does not create anything. Every field stays editable, and nothing is saved until you click **Add**. Leave it on **Custom (blank)** to start from an empty form.

  Two of them also fill in an on-sale window, so **Limit when this tier is on sale** arrives already ticked and expanded. **Advance / Early Bird** stops selling 24 hours before your event starts, and **Door** starts selling at that same moment — the clean handover described under [On-sale windows](#on-sale-windows) below, worked out against your event's own date and clock. Change either time, or untick the box, exactly as if you had set it yourself. The other presets leave that box alone, including anything you had already set on it.

  If your event starts within the next day there is no "24 hours before" left to aim at, so the window is left off and a line under the box says so. Set the times yourself if you still want a window — and if you use both presets on a same-day event, give Advance a closing time, or the advance and door tiers will sell alongside each other and buyers will simply choose the cheaper one.
- **Name** — shown to buyers (e.g. "General Admission")
- **Price** — in your default currency. Not shown for **Pay What You Want** tiers, where the buyer names the price. Type it either way: `12.50` and `12,50` both mean twelve fifty. Leave out thousands separators — enter `1500`, not `1,500`, which could be read as either 1500 or 1.50 and is rejected so it can't be guessed wrong.
- **Capacity** — number available (or unlimited)
- **Pricing** — **Fixed Price** (buyer pays what you set) or **Pay What You Want** (buyer picks an amount at or above your minimum)
- **Resale allowed** — toggle that lets buyers list the ticket on the in-app resale marketplace (resale is not currently available on Ithas Fire, so this toggle and the cap below are hidden for now)
- **Resale cap** — optional maximum ask price when resale is allowed. A ticket whose original price was higher than the cap can still be listed for up to that price

While resale is switched off, the **Resale** tab in **Revenue splits** is hidden too — there's nothing to share out until buyers can resell. Tickets that already have resale saved on them keep that setting; it just has no effect and isn't shown. See [resale marketplace](/help/buying-tickets/resale-marketplace).

## Pay-what-you-want tickets

Under **Pricing**, choose **Pay What You Want**. The **Price** field disappears, because the buyer names the price, and two fields take its place:

- **Minimum ($)** — the lowest a buyer can pay. Leave it blank or enter `0` to let buyers pay nothing.
- **Suggested ($)** — the amount checkout starts at. Buyers can change it by dragging a slider, typing an exact amount, or picking one of the preset amounts. The slider starts at your minimum and runs well past your suggested amount. A buyer who wants to pay more than the slider reaches can type the amount, up to $10,000.00.

Neither **Minimum** nor **Suggested** can be more than $10,000.00, the most a buyer can pay for one ticket. A higher amount shows a message under the field and the ticket type isn't saved until you lower it. A saved ticket setup (template) holding a higher amount can't be applied: nothing is added, and the message names the ticket type to fix.

Useful for sliding-scale community events, pay-what-you-can shows, and donation tiers.

### What the buyer pays

**The amount the buyer chooses is the ticket price, and all of it goes to your event.** Anything else is added on top, exactly as it would be for a fixed-price ticket at that amount:

- the platform fee;
- the processing fee;
- tax, where your place's location charges it.

A buyer who chooses $15 pays $15 plus those fees and tax, and your event is credited the $15, as with any ticket. Checkout shows the full total before the buyer holds their tickets. One buyer can pay at most $10,000.00 per ticket.

Pay-what-you-want tickets are non-refundable, and checkout tells buyers so.

### What buyers see on your event page

The tier is quoted from its minimum, with fees and tax included, the same way a fixed-price tier shows what a buyer pays. A $5.00 minimum reads **From $6.09** where the place's location charges 8.88% tax: that is what a buyer pays for one ticket if they choose the minimum. Your event page, your embeds and checkout all show this figure. If the minimum is $0, the tier reads **Pay what you want** instead, followed by your suggested amount (for example *suggested $15.00*) when you set one. Listings and search read **Pay what you want**, never **Free**, for an event with a $0-minimum tier, including when paid tiers sit beside it. The suggested amount is shown without fees and tax, because it is the amount the buyer chooses.

:::tip
Pay-what-you-want tickets are the simplest way to offer "pay more if you can" without creating multiple tiers. Buyers see your suggested amount prefilled — most take it.
:::

## Platform and processing fees

Fees are always added on top of your ticket price, on every event. At checkout the buyer sees the ticket price, the platform fee, the processing fee and tax on separate lines, so what they pay is exactly what they see. There is no setting for this. Under each paid ticket type, the **Tickets** section previews the fees and tax a buyer pays on top of its price.

The platform fee is taken once, from the buyer. Your event is credited the full ticket price. Take a $10.00 ticket with a 33¢ platform fee: the buyer pays $10.33 plus the processing fee and tax, and your event is credited $10.00. Tickets sold before 13 October 2026 were credited the price minus the platform fee, and those orders keep the amounts they were credited.

:::tip
If your event used to take the platform fee out of your share rather than charge it to buyers, it has moved to fees on top. Buyers now see the platform fee and the processing fee added to your price. Orders placed earlier keep the amounts they were charged.
:::

### The fee line under each ticket type

Under each fixed-price ticket type that costs more than $0, the **Tickets** section shows one line with the numbers for a single ticket. It isn't shown for pay-what-you-want tiers, because there the fees depend on the amount the buyer picks.

**Platform fee**, **Processing fee** and **Tax** are added on top of your price, and **Buyer pays** is the total of all four: the same figure your event page shows for one ticket. When tax can't be calculated, the line says so and leaves **Buyer pays** out. **Tax** is shown only where your place's location charges it.

**Your event is credited** shows your price. None of the lines added on top comes out of it, and **Revenue splits** share it out.

## Editing after sales open

Most fields stay editable, with two constraints:

- You **cannot reduce capacity** below the number already sold
- **Reducing a price triggers partial refunds** automatically for buyers who paid more

Price increases only apply to future buyers — existing ticket holders keep the price they paid.

## Refunded tickets go back on sale

A refunded ticket stops counting against its ticket type's capacity, so one more is offered on your event page, in your embed and at the door. The same goes for a voided comp.

:::warning
Refunding a ticket that was already scanned in marks that person as having left: the ticket stops working and goes back on sale. Refund it at the door, as they go.
:::

## Scheduling a price change

Early-bird pricing on one tier, without creating a second tier and splitting your capacity in two. The same tickets sell cheaper until a moment you pick, then switch to a new price on their own.

In the ticket type's form, tick **Price changes later**. Two fields appear:

- **New price ($)** — what the ticket costs from the changeover onwards. `0` is allowed, so a tier can become free.
- **Changes at** — the date and time the new price takes over.

Underneath, the form reads back what you have set: *Changes to $20.00 on Sat, Oct 3, 12:00 AM CDT*. Check that line before saving — it is the only place the change is spelled out in full.

Once saved, the schedule appears under the tier in your ticket list, so you can see it without opening the form again.

:::warning
**The time is on the event's clock, not yours.** If your event runs in Nashville and you are editing from London, `8:00 PM` means 8pm in Nashville. The read-back line always ends with the timezone — `CDT`, `PST`, `GMT` — so you can confirm which clock you are setting. If that abbreviation is not the one you expect, check your event's timezone before saving.
:::

A few details worth knowing:

- **The changeover is inclusive.** At exactly the moment you set, the new price is already live. One second earlier, the old price still applies.
- **A time in the past applies immediately.** The form warns you, but does not stop you — backdating is sometimes what you want. The tier simply sells at the new price from the moment you save.
- **This is not a price edit,** so it does not trigger the partial refunds described above. Buyers who already paid the earlier price keep it.
- **Editing the event's date or timezone afterwards does not move a schedule you have already set.** It stays pinned to the exact moment it resolved to. Re-open the tier and check the read-back line if you change either.

To remove a schedule, open the tier and untick **Price changes later**, then save. Both fields are cleared together — you cannot leave a tier with a new price but no changeover time, or the reverse.

:::tip
Three or more price steps — early, advance, day-of — are still better as separate tiers. A schedule handles one changeover on one shared pool of tickets.
:::

## On-sale windows

A schedule changes what a tier costs. A window changes *when* it can be bought at all — members-only tickets that unlock on Friday, an advance tier that shuts the night before, a door tier that only appears on the day.

In the ticket type's form, tick **Limit when this tier is on sale**. Two fields appear:

- **On sale from** — nothing sells before this moment.
- **Stops selling** — nothing sells from this moment onwards.

**Either one on its own is a complete setting.** Fill in only *On sale from* and the tier opens then and never closes. Fill in only *Stops selling* and it is on sale straight away until that moment. Each field reads back underneath it — *Opens Fri, Oct 9, 10:00 AM CDT* — and that read-back is worth checking before you save.

Windows work on every tier, including pay-what-you-want ones. A window says nothing about the amount, so unlike a scheduled price it is not removed when you switch a tier to **Pay What You Want**.

:::warning
**The times are on the event's clock, not yours,** exactly as they are for a scheduled price change. `6:00 PM` on an event in Nashville means 6pm in Nashville, whichever timezone you are editing from. Both read-back lines end with the timezone — `CDT`, `PST`, `GMT`. If that abbreviation is not the one you expect, check your event's timezone before saving.
:::

### The closing time is the moment sales stop

Set **Stops selling** to `6:00 PM` and the last sale happens at 5:59 PM. Six o'clock itself is already closed.

That is what makes an advance/door handover clean. Give your advance tier a closing time of `6:00 PM` and your door tier an opening time of `6:00 PM`, and the two meet exactly: no minute where nothing is on sale, and no minute where both are. You do not need to set the door tier to `6:01 PM` to avoid an overlap — there is no overlap to avoid.

If you set both fields, the opening time has to be earlier than the closing time. Setting them to the same moment is refused rather than saved, because a tier that opens and closes at the same instant could never sell a single ticket.

### What buyers see

A tier outside its window is **still listed on your event page** — dimmed, with a note reading either *On sale Fri, Oct 9, 10:00 AM CDT* or *Sales ended*. It is not hidden. Buyers can see the tier exists and, when it has not opened yet, exactly when to come back.

One thing does change on your event's browse card: **a tier that is not currently on sale stops counting towards the "from $12" price**. If your $5 early-bird has closed and only the $30 general tier is buyable, the card reads *from $30* rather than continuing to advertise a price nobody can buy. If none of your tiers are on sale right now, the card reads **See details** and the click lands on your event page, which says when each tier opens.

:::tip
A tier with a window is not hidden from your ticket list either — the window shows under the tier's name, so you can see what is held back without opening each one.
:::

To change a window, open the tier and edit either field; clearing one field on its own removes just that bound and leaves the other in place. To remove the window entirely, untick **Limit when this tier is on sale** and save.

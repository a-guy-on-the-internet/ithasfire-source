---
title: "Offer recurring memberships"
description: "Set up monthly or yearly membership tiers at 0% platform fee, with perks that apply automatically at checkout."
category: "organising-events"
order: 16
tags: ["memberships", "recurring", "billing", "benefits", "payouts", "organiser"]
related:
  [
    "organising-events/payouts-and-settlements",
    "organising-events/discounts-at-the-door",
    "organising-events/manage-ticket-types",
    "organising-events/embed-widgets",
  ]
specs: ["2026-08-05/recurring-memberships"]
---

Memberships let the people who love what you do support you with a recurring payment — billed monthly or yearly — in exchange for perks that apply automatically when they buy tickets. Ithas Fire takes **0%** of membership revenue. Everything lives under **Memberships**, in the **Sales** group of your admin sidebar.

## Before you start

- Memberships are open to every organiser and artist — there's no minimum ticket volume and nothing to unlock.
- You need an active Stripe Connect account before anyone can join a tier. If payouts aren't set up yet, would-be members see "This tier isn't open to new members right now." See [payouts and settlements](/help/organising-events/payouts-and-settlements).
- Member perks are self-contained: you write the discount on the tier itself, so there's nothing to set up first. Typed promo codes are a separate feature — see [apply a discount at the door](/help/organising-events/discounts-at-the-door).
- Joining is available to members with a **US billing address** only for now.

## Create a tier

1. Open **Memberships** and click **Create tier** (or **Create your first tier**).
2. Give the tier a **Name** and an optional **Description** — both appear on your public page.
3. Set the **Price** and the **Billing interval**: **Monthly** or **Yearly**.
4. Fill in **What do members get?** — your own plain-text summary of the perks. It's shown to members on your public page and in your memberships embed, in your words.
5. Save. The tier is created as a **Draft** — members can't see it or join yet.

:::warning
Some choices are permanent. The **billing interval** can't change after the tier is created, and the **price is locked** once the tier has ever had a member — existing members keep billing at the price they agreed to. To change a locked price, archive the tier and create a replacement at the new price. Benefits carry no such lock: you can edit those at any time, members or not.
:::

## Publish and share

Publish the tier from its row menu when it's ready. Publishing creates the billing product with Stripe and opens the tier to new members — you'll be shown a **join link** to share, pointing at the **Membership** tab of your public page. You can grab it again any time with **Copy join link** on the tier's row.

The Membership tab appears on your public page automatically once you have a published tier. The join link works anywhere — social bios, newsletters, or your own website next to your [embedded events](/help/organising-events/embed-widgets).

For your own site there's also a **memberships widget**: it lists your published tiers with a Join button, from the **Memberships** tab of your embeds page. Join opens your Membership tab in a new tab, so signing in and entering a card happens on Ithas Fire rather than inside the frame. See [embed your events on your own site](/help/organising-events/embed-widgets).

## Add benefits

A benefit is a discount that applies automatically at ticket checkout for anyone with an active membership in the tier. There's no code and nothing to hand out — members never type anything.

Open a tier's row menu and choose **Manage benefits**. A benefit carries its own terms rather than borrowing them from a promo:

- **Discount type** — **Amount off** (a dollar figure) or **Percent off** (a whole number from 1 to 100).
- **Never discount more than (optional)** — a ceiling on what any single order can take off. Most useful on a percentage: "20% off, never more than $10." On an amount-off benefit the ceiling can't sit below the amount itself, because the amount could then never apply in full.
- **Limit where it applies (optional)** — expand this to pick **Only events in this category**, **Only events at this place**, or both. A limited benefit fires only on events that match exactly; an event with no category, or no place, set never matches one.
- **Checkout label (optional)** — your own name for the benefit, recorded with the order. What the buyer reads on their order summary is **Member discount** followed by the tier's name.

Click **Add benefit**. A tier can carry several, and the **Benefits** column on the tier table shows how many.

A few rules worth knowing:

- **Edit any time, no lock.** **Edit** on a benefit row reopens its terms; **Remove** deletes it straight away. Nothing about a benefit freezes once the tier has members — unlike the price. Edits change what members get from their **next** order and touch no order already placed.
- **A benefit can't expire or run out.** It has no validity window, no redemption cap and no on/off status of its own. It lasts exactly as long as the membership does, so there's nothing to renew and nothing that can quietly stop working.
- **A lapsed membership grants nothing, immediately.** Only members whose subscription is active — including a trial period — earn benefits. A cancelled or past-due membership grants nothing from that member's very next checkout, with no grace period.
- **At most one benefit applies per order.** If a tier carries several, the single one worth most to that buyer applies and the rest are skipped. They never add up.
- **The member must be signed in** to the account that holds the membership when they buy.

### What this costs you

The bottom of the benefits dialog answers the question worth asking before you save: at how many discounted shows does a member cost you more than they pay in dues?

Enter a **Typical ticket price** and how many **shows a member uses this at** per period — per month or per year, following the tier's own billing interval — and it gives you the count at which that member stops being profitable, plus what you clear at the number you typed. It recomputes as you type, and it reads the terms currently in the form, so you can price a change before committing it. The maths is the real checkout's maths, which is why it can tell you two things most organisers don't expect.

:::warning
Platform fees on a discounted ticket are still computed on the **full face price**. A member paying $5 for a $20 ticket still carries the fee on $20, and you absorb both the discount and that fee. A **100% discount is different in kind**: it produces a $0 order with no fees at all, so what you give up is the ticket's face price *minus* the fee you'd otherwise have paid — less than the face value, not more.
:::

## What members see and pay

Your public page's **Membership** tab shows each published tier with its price and "Plus applicable sales tax". To join, a member enters their **billing ZIP code** — sales tax on memberships is based on the member's own billing address, not on your location or a venue's. If we can't determine tax for their region, the join is refused with "Memberships aren't available in your region yet." rather than billed at a guessed rate — which is also why joining is US-only for now.

After that, their card is charged automatically each month or year. Before every renewal we email the member the tier, the amount, the charge date, and who's charging them — plus a cancel link. Members manage everything themselves from **Account → Memberships**: **Manage billing** opens Stripe's secure billing portal, where they can cancel or update their card. Cancelling keeps the membership until the end of the period they've already paid for.

## What you receive

- **0% platform fee.** The full tier price, minus Stripe's card-processing costs, reaches your payout.
- **Sales tax never enters your payout.** The tax the member pays on top is collected by Ithas Fire and remitted to the state — it's our obligation, not income you receive.
- **Membership income settles monthly.** Everything your members pay in a calendar month is folded into a single settlement and paid at the start of the following month, alongside your regular payout run. See [payouts and settlements](/help/organising-events/payouts-and-settlements).

### Part of it is held back at first

While you're new to memberships, a percentage of your **membership** revenue is held for 90 days and released with a later payout: **10%** for your first 90 days of membership payouts, **5%** from 90 to 180 days, then nothing. If you'd already been selling tickets with us for at least 90 days when you turned memberships on, you start at 5%.

This is deferred payout, not a fee — the money is yours and arrives later. It exists because a membership charge can be disputed months after you've been paid. A lost membership dispute returns you to 10% for 180 days and pauses releases during that time. Ticket revenue is never held this way. See [payouts and settlements](/help/organising-events/payouts-and-settlements).

### The $2 payout fee

Stripe charges us $2 for any month in which we send you a payout. If ticket revenue is settling to you in the same month, memberships cost you nothing extra — your account was going to be paid anyway, and we absorb the $2 as part of ticketing. If memberships are the only thing paying out that month, we deduct that $2 from the payout. It's charged at most once per month, and if your balance is below the payout minimum, nothing pays out and nothing is charged.

## Chargebacks

:::warning
If a member disputes a membership charge and the dispute is lost, the disputed amount — capped at what you were actually paid, so the sales tax we collected is never clawed back from you — plus the card network's dispute fee is deducted from your future payouts.
:::

The renewal reminder emails and the easy self-serve cancel exist precisely to keep disputes rare: the most common chargeback on recurring billing is a member who couldn't work out how to stop paying.

## Changing or retiring a tier

You can edit a tier's name, description, **What do members get?** text and its benefits at any time, members or not. Only the **price** hits the lock described above once the tier has had a member, and the **billing interval** was fixed at creation — for either of those the path is always **archive and replace**: archive the old tier and create a new one with the terms you want.

Archiving closes a tier to new members. Existing members keep their subscription — and their price — until they cancel.

## What can go wrong

- **"This tier isn't open to new members right now."** — the tier was archived or unpublished, or your Stripe Connect account isn't ready to receive payouts yet.
- **A member says their discount didn't apply.** Check, in order: were they signed in at checkout? Is their membership **Active** (a **Past due** or cancelled membership grants nothing)? Does the event match the benefit's category or place limit? Did they also type a promo code that isn't stackable — a non-stackable code on the order skips member benefits entirely. And if the tier carries several benefits, only the best one applies, so the others are meant to be missing.
- **"Memberships aren't available in your region yet."** — the member's billing address is outside the US. There's no workaround at the moment.

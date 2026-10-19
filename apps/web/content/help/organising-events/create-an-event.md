---
title: "Create an event"
description: "Use the event builder to go from draft to published."
category: "organising-events"
order: 1
tags: ["events", "organiser", "builder", "publishing"]
related:
  [
    "organising-events/manage-ticket-types",
    "organising-events/payouts-and-settlements",
    "organising-events/hidden-places-and-address-reveal",
    "organising-events/add-audio-to-your-event",
  ]
specs: ["2026-07-27/event-builder-regroup"]
---

The event builder lives in your organiser dashboard at **/admin/{your-slug}/events**. New events start as `DRAFT` — you can edit safely until you publish.

## Before you start

- A connected Stripe account (see [payouts and settlements](/help/organising-events/payouts-and-settlements)) — required before you can publish a ticketed event
- Event details: title, date/time, place or location, description
- A hero image (1200 × 630 px or larger recommended)

## Create the draft

1. Go to your [organiser dashboard](/admin), open **Events**, and click **Create Event**.
2. Fill in **Event Title** and **Starts at**. **Place** is optional here: give a street address, pick one of your places via the **My Places** toggle, or leave it blank and choose the place in the builder — that is where you name a place you don't own (see [naming a place on your event](/help/organising-events/hidden-places-and-address-reveal#naming-a-place-on-your-event)).
3. Click **Create draft**. The event is saved as a `DRAFT` and the full builder opens.

## Finding your way around the builder

While you're in an event, the admin side rail switches to event context:

- **Build** — jumps to each section of the edit page: **Essentials**, **Details**, **Tickets**, **Lineup**, **Revenue splits**, and **Settings**.
- **Manage** — separate pages for running the event: **Attendees**, **Volunteers**, **Comp** (comp tickets), **Suggestions**, and **Feedback**. Comp tickets and suggestions unlock once the event is published.
- **All events** at the top of the rail returns you to your events list.

The **Edit | Preview** toggle in the builder header swaps the page to a live preview of what buyers will see — including changes you haven't saved yet.

Once your event is published, the top of the page shows its **Public link**: a short address like `ithasfire.com/e/wqsdk6pxzi` that leads to the event's page. **Copy link** puts it on your clipboard, and **View event** opens the live page in a new tab. The short link is made for places where length matters, like a text message, a poster or a QR code.

The **⋯** menu in the builder header holds the ways out to the real page. Which ones you see depends on where the event is:

- **Open in new tab** — while the event is still a draft, opens the saved version of the page in a new tab. It's the draft as it stands, not your unsaved edits.
- **View event** — once the event is published, opens the live public page in a new tab. This replaces **Open in new tab**; you never see both.
- **Copy link** — copies the event's short link, the same one shown under **Public link**, ready to paste into a group chat or a post. It appears once the event is published, and stays if a published event is later cancelled or completed. A draft has no public link yet, so you won't see it while you're still drafting.
- **Unpublish** — once the event is published, takes it back to a `DRAFT`: it leaves the public listings and search, and anyone who saved it or RSVP'd is told it has been unlisted. Nothing is cancelled or refunded, and you can publish again when you're ready. You can only unpublish an event that has no completed orders — free and comp tickets count. Once there are orders, the only way to take it down is to cancel it.
- **Cancel event** — cancels the event for good. It asks you to confirm first, because it can't be undone: everyone with a completed order is refunded automatically and the event is closed. See [refunds and cancellations](/help/buying-tickets/refunds-and-cancellations) for what buyers get back. Cash sales at the door are marked refunded too, but giving the cash back is up to you (see [selling at the door](/help/organising-events/selling-at-the-door)).

Only the event's owner and admins see **Unpublish** and **Cancel event**, and once the event is published only they see **Regenerate slug** under **Sharing** in Settings. That includes someone managing another person's events with admin access; editors can still edit and publish.

Regenerating the slug changes the event's full address, and the old one redirects to the new one. It doesn't change the short link, so short links you've already printed or texted keep working.

**View event** also sits in the side rail's event header and beside the **Public link**, so there are three routes to the live page once you've published.

:::warning
**Unpublish** and **Cancel event** sit next to each other in the same menu but do very different things. Unpublish hides a draft-quality event you'll fix and re-publish; cancel refunds every buyer and ends the event. If you're not sure, unpublish — it's the reversible one.
:::

## Build out the draft

1. **Essentials** — title, start and end date/time (with timezone), a **Category**, and the place. You can't publish without a category. Pick one from the list and it saves straight away, without waiting for you to save the event. A category you request instead doesn't count until it's approved. To hide the address from the public, use the **Hide the address?** link under the place field — it jumps to the address-reveal settings. See [obscured locations and address reveal](/help/organising-events/hidden-places-and-address-reveal).
2. **Details** — short description, hero image, and body content (rich text) — you can also [embed an audio clip](/help/organising-events/add-audio-to-your-event). If the description is empty, **Start from** offers suggested text for your kind of night: pick one and replace the parts in brackets.
3. **Tickets** — add ticket types (see [manage ticket types](/help/organising-events/manage-ticket-types)). If the place has a seat map, the **Seating map** button here opens a full-screen editor where you bind ticket types to sections. No layout means General Admission.
4. **Lineup** and **Revenue splits** — list who's performing and how ticket revenue is shared. When you add someone from their Ithas Fire profile (rather than typing a name), they're told they're on the lineup and can take themselves off it — see [lineups you're on](/help/account/lineups-youre-on). On a draft, they hear when you publish. New events start from your group's **Default agreement** (**Policies** in your group's settings). An event created from a booking uses the terms set on the booking instead.
5. **Settings** — four groups: **Scheduling** (recurrence), **Access & privacy** (event visibility, access gates, and address visibility/reveal), **Money & compliance** (tax, waiver, payout schedule), and **Sharing** (short link).

### Adding and moving blocks in the description

- **Add a block:** type **/** on an empty line and pick a heading, list, quote, divider, image, embed or audio clip. Keep typing to narrow the list: **/quo** finds **Quote**. On a phone, tap the **+** beside the empty line instead.
- **Move a block:** use the grip to the left of the block. On a computer, drag it to the new spot. On a phone, tap inside the block, tap the grip, then **Move up** or **Move down**. **Delete block** is in the same menu. An empty line shows the **+** instead of the grip.
- **From the keyboard:** **Alt+Shift+↑** and **Alt+Shift+↓** (**Option+Shift** on a Mac) move the block your cursor is in.

## Repeating events

If your event runs on a schedule, open **Settings → Scheduling** and change **Repeats** from **Doesn't repeat**.

The presets are built from the date you already set, so an event on a Wednesday offers **Every Wednesday**, **Every other Wednesday**, and a monthly option like **Monthly on the second Wednesday**. Pick **Custom…** for anything else — it opens **Repeat every** (a number plus days, weeks, or months) and, for weeks, a **Repeat on** row of weekday buttons.

Then set **Ends**: either **After** a total number of shows (2–100, counting the event you're editing) or **On date**. The summary underneath spells out the rule in plain English, lists the first few dates, and tells you how many extra shows saving will create.

:::tip
Repeat dates are created as separate `DRAFT` events, not published ones. You publish each show when it's ready, so you can keep the far end of a long run out of sight until you've confirmed it.
:::

### Why one weekday won't switch off

In the **Repeat on** row, your event's own weekday is pinned — it shows a padlock and can't be unselected. A series has to include the date of the event it grew from, so if your show is on a Wednesday, Wednesday stays ticked.

To repeat on different days entirely, change the event's start date in **Essentials** first; the pinned day follows it. You can still add and remove any other weekday freely.

### Changing the schedule later

Once a series exists, the Scheduling section links to **Manage dates**, where you can see every occurrence and skip or restore individual ones — useful when a single date in a run falls on a holiday.

:::warning
Editing the schedule of a running series can detach shows that no longer fall on the new pattern. Check the date list on **Manage dates** afterwards, especially if any of those shows have already sold tickets.
:::

## Publish

The **Ready to publish?** checklist — a rail on the right on desktop, a compact summary near Publish on mobile — tracks what's left before the event can go live: essentials complete, a category picked, details filled in, and at least one ticket type. Paid events also need Stripe payouts set up — you accept the chargeback and payout-hold terms on the **Payouts** page as part of that — and events with an obscured location need the host responsibilities attestation. Each unmet item links straight to its fix. The lineup item is informational and never blocks publishing.

When everything required is done, click **Publish**.

If the event sits on a place calendar with [holds](/help/organising-events/booking-requests#holds-and-your-calendar) on that date, publishing takes the date: the act the event came from is confirmed and everyone else in line is released — and while an act's reply clock is running you can't publish over them.

:::warning
The builder does **not** auto-save. Save manually as you go — especially after long blocks of body content on slow connections.

While you have unsaved changes, **Unsaved changes** shows next to **Save** (on a phone, a dot on **Save**). Leaving the builder asks before your edits are dropped: closing the tab, reloading, pressing Escape, the back arrow, the browser's Back button, or going to another page from the menu, the bottom bar or search. Moving between the builder's own sections doesn't ask, and neither does switching between editing and the preview. On a community listing, **Publish** asks you to save first.
:::

## Event statuses

| Status      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `DRAFT`     | Editable, not visible to buyers                  |
| `PUBLISHED` | Live and sellable                                |
| `CANCELLED` | Organiser cancelled — triggers automatic refunds |
| `ARCHIVED`  | Hidden from search; direct link still works      |
| `COMPLETED` | Past its end time                                |

## After publishing

Most fields stay editable. But once tickets have sold:

- Capacity can only go **up**, never below the number already sold
- Reducing a ticket price triggers partial refunds for buyers who paid more

When you save a new date or time on a published event, everyone who saved it or RSVP'd gets an email and an in-app notification with the new start. Ticket holders aren't sent that notice unless they also saved the event or RSVP'd, so tell them yourself. Moving the event to a different place doesn't notify the people who saved it or RSVP'd.

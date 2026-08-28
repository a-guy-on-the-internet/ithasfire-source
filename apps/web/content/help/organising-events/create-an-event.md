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
    "organising-events/hidden-venues-and-address-reveal",
    "organising-events/add-audio-to-your-event",
  ]
specs: ["2026-07-27/event-builder-regroup"]
---

The event builder lives in your organiser dashboard at **/admin/{your-slug}/events**. New events start as `DRAFT` — you can edit safely until you publish.

## Before you start

- A connected Stripe account (see [payouts and settlements](/help/organising-events/payouts-and-settlements)) — required before you can publish a ticketed event
- Event details: title, date/time, venue or location, description
- A hero image (1200 × 630 px or larger recommended)

## Create the draft

1. Go to your [organiser dashboard](/admin), open **Events**, and click **Create Event**.
2. Fill in the three basics: **Event Title**, **Starts at**, and **Venue** — a street address, or one of your places via the **My Places** toggle.
3. Click **Create draft**. The event is saved as a `DRAFT` and the full builder opens.

## Finding your way around the builder

While you're in an event, the admin side rail switches to event context:

- **Build** — jumps to each section of the edit page: **Essentials**, **Details**, **Tickets**, **Lineup**, **Revenue splits**, and **Settings**.
- **Manage** — separate pages for running the event: **Attendees**, **Volunteers**, **Comp** (comp tickets), **Suggestions**, and **Feedback**. Comp tickets and suggestions unlock once the event is published.
- **All events** at the top of the rail returns you to your events list.

The **Edit | Preview** toggle in the builder header swaps the page to a live preview of what buyers will see — including changes you haven't saved yet. The small external-link icon next to it opens the saved version of the page in a new tab.

## Build out the draft

1. **Essentials** — title, start and end date/time (with timezone), and the venue. To hide the address from the public, use the **Hide the address?** link under the venue field — it jumps to the address-reveal settings. See [obscured locations and address reveal](/help/organising-events/hidden-venues-and-address-reveal).
2. **Details** — short description, hero image, and body content (rich text) — you can also [embed an audio clip](/help/organising-events/add-audio-to-your-event).
3. **Tickets** — add ticket types (see [manage ticket types](/help/organising-events/manage-ticket-types)). If the venue has a seat map, the **Seating map** button here opens a full-screen editor where you bind ticket types to sections. No layout means General Admission.
4. **Lineup** and **Revenue splits** — list who's performing and how ticket revenue is shared.
5. **Settings** — four groups: **Scheduling** (recurrence), **Access & privacy** (event visibility, access gates, and address visibility/reveal), **Money & compliance** (tax, waiver, payout schedule), and **Sharing** (short link).

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

The **Ready to publish?** checklist — a rail on the right on desktop, a compact summary near Publish on mobile — tracks what's left before the event can go live: essentials complete, details filled in, and at least one ticket type. Paid events also need Stripe payouts set up and the chargeback and payout-hold terms accepted, and events with an obscured location need the host responsibilities attestation. Each unmet item links straight to its fix. The lineup item is informational and never blocks publishing.

When everything required is done, click **Publish**.

If the event sits on a venue calendar with [holds](/help/organising-events/booking-requests#holds-and-your-calendar) on that date, publishing takes the date: the act the event came from is confirmed and everyone else in line is released — and while an act's reply clock is running you can't publish over them.

:::warning
The builder does **not** auto-save. Save manually as you go — especially after long blocks of body content on slow connections.
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
- Changing date, venue, or price notifies buyers automatically
- Reducing a ticket price triggers partial refunds for buyers who paid more

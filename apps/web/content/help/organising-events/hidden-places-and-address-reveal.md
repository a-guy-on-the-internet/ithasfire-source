---
title: "Obscured locations and address reveal timing"
description: "Protect host privacy — show the public less, and reveal the exact address to ticket holders on your schedule."
category: "organising-events"
order: 6
tags: ["privacy", "house-shows", "place", "location", "address-reveal"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/restrict-event-access",
    "organising-events/spaces-and-calendars",
    "buying-tickets/where-is-this-event",
  ]
specs:
  [
    "2026-06-23/completed/location-visibility-reveal",
    "2026-08-27/venue-confirmation-and-booking-intents",
    "2026-09-24/completed/venue-track-record-and-review-switch",
  ]
---

For house shows and private-residence events, the exact address is usually sensitive. The builder's **Location Visibility** controls — under **Settings** → **Access & privacy**, or one click away via the **Hide the address?** link under the place field — decide how much location detail the public sees before buying, and when ticket holders get the full address.

## Exact address or Obscured

Every event picks one of two options:

- **Exact address** — the full address and map are shown to everyone, always.
- **Obscured** — the public sees a fuzzed area (or no map at all); ticket holders get the exact address at the reveal time you choose.

## Public precision

When the location is **Obscured**, the **Public precision** slider sets what non-ticket-holders see on the map:

- **Tight circle to wide circle** — a shaded circle in one of nine sizes, from a 100 m radius up to a 50 km radius. The circle is deliberately offset from your real location, so the centre of the circle is _not_ the place.
- **Hidden — no public map** — the far end of the slider. The public sees only an area label (no map, no coordinates at all).

A live preview under the slider shows exactly what the public gets. You can also set a **Public label** — a friendly area name like "Downtown Brooklyn" — shown in place of the address. Without one, the event falls back to its city/region.

## Address reveal timing

Every obscured event picks when ticket holders get the exact address. At the reveal time, ticket holders can see it; everyone else stays on the obscured view.

Choose one of:

- **Immediately after purchase** — ticket holders see the address as soon as they buy
- **1 hour before start**
- **24 hours before start** _(the default)_
- **7 days before start**
- **Custom time** — pick any date and time (**Reveal at**)
- **Never — nobody gets the address** — Ithas Fire never shows the address to anyone, ticket holders included, and sends no reveal email or notification. You have to send it to your guests yourself.

Times use the event timezone — the builder notes which one. Relative presets are recomputed from the event start time, so if you reschedule the event they shift with it. A **Custom time** is absolute and does not shift.

:::tip
The reveal is the same moment for every ticket holder, and it also applies to sales made later: anyone who buys after the reveal time gets the exact address straight away, including in their ticket confirmation email.
:::

## Host responsibilities attestation

Publishing any event with an obscured location — whether a fuzzed circle or fully hidden — requires you to confirm a host responsibilities checklist first, covering your legal right to host at the location, zoning/occupancy/noise compliance, alcohol compliance, tax responsibility, and that you've read the Organizer FAQ. Publish is blocked until every item is acknowledged.

## What attendees see

- **Before reveal** — the obscured map view (circle or area label) plus a notice on the event page: _"Exact address unlocks {date} for ticket holders."_ (on a free RSVP listing, _"…for people who RSVP."_). Ticket confirmation emails sent before the reveal show the same locked notice instead of the address.
- **At reveal time** — unless you chose **Never**, every ticket holder gets an in-app notification and an email ("The location for {event} is now live") with the full address, a map link, and directions. The exact address also appears on the event page for signed-in ticket holders, and for signed-in guests who said they're going to a free RSVP listing. At a place that hides its address, this only happens for events the place has confirmed (see **Hiding a place's address** below).
- **After reveal** — buyers who purchase later get the address directly in their ticket confirmation email.

**Only current ticket holders and guests with a current RSVP see the exact address**, and that stays true after the reveal time passes. A checkout that was never paid, a refunded order, tickets transferred to someone else, a withdrawn RSVP, or a cancelled or archived event don't show it. Volunteers get it on the same schedule once you approve them; applications still pending don't.

## Hiding a place's address

A place has its own **Address privacy** setting, separate from any one event. New places start with the address shown. When you add a place from **Places** with **New Place**, the dialog asks _"Is this someone's home? You can hide the address."_ and offers three choices. You can change the answer later under **Address privacy** on the place's **Settings** page, directly below its address.

- **Exact address** — the full address and a map pin are public.
- **Approximate area** — a circle on the map, and no street address anywhere. **Circle size** sets how wide it is. The circle is approximate: the place is somewhere inside it, not necessarily at the centre.
- **Address withheld** — no map and no address, only the area name.

Both hidden choices take an **Area name**, such as "East Nashville". It is public and appears wherever the address would; leave it empty and the city is used instead.

Events at the place can't show more than the place does. In the event builder, **Exact address** is marked **Not available here** and a note says the setting comes from the place. At a place with an approximate area, an event's circle can't be smaller than the place's. The limit covers events other people create at the place too, and events already published there when the setting changes.

Anyone can attach their event to a place, so a hidden address goes only to events the place stands behind. Who gets it depends on whose event it is:

- **The place's own events** — an event owned by the place itself (its organisation, or you if you own the place yourself) keeps its own reveal time: ticket holders get the address when **Address reveal timing** above says, or never if the event uses **Never — nobody gets the address**. An event you save under a different organisation at a place you manage — your band's show at a house you own yourself — counts as confirmed as soon as you save it, and its ticket holders get the address at its reveal time but no earlier than 24 hours before the start.
- **Someone else's event that the place has confirmed** — ticket holders get it at that event's reveal time, but never earlier than 24 hours before the start, whichever reveal time its organiser picked. Moving the event's date after the place confirms can't bring the reveal forward. **Never** still means never.
- **Someone else's event that the place hasn't confirmed**, or has withdrawn its confirmation from — ticket holders never get the address through Ithas Fire. Their order page and wallet pass tell them the place shares its address with events it has confirmed, and to ask the organiser where to go. The same goes for community listings at the place, even with **Accept community listings** turned on.

An event at the place that had no reveal time gets **24 hours before start** when the place hides its address.

If you manage a place that hides its address, you can't type that address into an event as a plain address; the save is refused. Pick the place under **My Places** instead (the error offers a button that does it for you).

In the event builder, if you pick a place that hides its address and you don't manage it, a note under **Address reveal** says ticket holders get the address only after the place confirms, and no earlier than a day before the start. On the place's side, the dialog for confirming someone else's event from the place calendar says that confirming lets that event's ticket holders see the address, no earlier than a day before the start and not at all if the event never reveals it.

When your place's address is hidden, its phone number is hidden from your public page too, since a phone number can lead someone back to an address. You can still see and edit it in your place settings.

:::warning
Hiding the address covers the address fields and the map, not text you write yourself. Don't name the street in the place's bio, the area name, a **House Rules** block or your event descriptions: those are shown exactly as written.
:::

A place created with **Approximate area** or **Address withheld** starts with performer reviews turned off. Changing the address setting later doesn't flip that switch; the place's owner turns performer reviews on or off in the **Reviews & feedback** section of the place's **Settings** page. See [Edit and preview your public page](/help/organising-events/edit-and-preview-your-page#a-places-page-settings).

## Changing a place's address

When you change the address or map pin of a place that shows its exact address, its upcoming events follow: drafts and published events that haven't ended, and recurring listings with a date still ahead. The event page, order page, wallet pass and ticket email then show the new address. Ticket holders aren't sent a notice.

Past events keep the address they happened at. An event set to a different timezone from the place keeps its old address too, and its times don't change. Places that hide their address follow the privacy rules above instead.

## Naming a place on your event

Choosing a place in the place field attaches your event to it. The place's name and link appear on your public page only once the place has confirmed the event. Until then, visitors see the address (subject to the visibility settings above) with no place name, the event stays off the place's public page, and it doesn't take up the place's calendar. You can publish and sell tickets in the meantime, with one catch: if the place hides its address, your ticket holders don't get it from Ithas Fire until the place confirms, and even then not until 24 hours before the start. Tell them where to go yourself, or get the place's confirmation before you sell. Events at a place you own or manage are confirmed from the start.

### Requesting a place from the builder

In the event builder's place field, choose **My Places** and search: results show **Your places** first, then **All places** on Ithas Fire, including ones nobody has claimed yet. Pick a place you don't own and, if any of its calendars takes requests, two more fields appear under it:

1. **Book this place for** — **Play here**, **Rent a space** or **Use a space**. Only what the place offers is available; the rest is disabled.
2. **Calendar** — the place's calendars that take that kind of request. Once you pick one, the field lists its rooms, and the place picks the room when it accepts.

Save the event and the request goes to the place's Bookings inbox on your behalf — you don't write a pitch, the event is the ask. A band above the place field tells you where it went ("The Blue Room has your request. Your event shows an address only until they confirm.") and links to the conversation, and it updates as the place answers: confirmed, or confirmation withdrawn with their reason. The start time can still be changed in the editor afterwards. A place nobody has claimed on Ithas Fire yet can't be asked: the request fields don't appear, and your event saves with the address only.

If the place you pick is one you own or manage, or one that's given you a booking grant, none of this appears: your event is confirmed from the start and there is no request. A place whose calendars don't take requests through Ithas Fire is still fine to name — it just shows as an address on your event.

If the place hasn't set its opening hours, isn't open on your date, or isn't taking requests right now, the event still saves and a note under the place field tells you the request wasn't sent. Ask the place directly, or change the date and save again. The same note appears if you chose **Play here** without performer mode on — turn it on in your settings, then save again.

:::tip
The first screen when you create an event lists only places you own, and the place there is optional. To name someone else's place, leave it blank, click **Create draft**, and pick the place in the full builder — the search box there covers all places.
:::

The place sees your event as unconfirmed on its own calendar and can confirm it there. If the place marks it as not theirs, or withdraws a confirmation later, you get a notification with their reason. At a place that hides its address, your ticket holders stop getting the address from Ithas Fire at that point. Nothing else changes: the event keeps its public location, stays published, and you can still edit it, including choosing a different place or a plain address instead.

:::tip
Moving a confirmed event to a different place drops the confirmation. The new place has to confirm it for itself.
:::

## Gotchas

- **The builder shows you the exact address** for a plain address you typed and for places you manage. Obscuring your own event only affects the public view. At someone else's place that hides its address, the builder shows you what the public sees, the place's area name, even though your event is there.
- **A Custom reveal needs a date** — saving with **Custom time** and an empty **Reveal at** field is rejected.
- **Switching to Exact address** clears the reveal settings — the address is simply public again.
- **Attendees must be signed in** with the account that holds the ticket or the RSVP for the event page to show them the exact address. The reveal email and in-app notification arrive regardless.

:::warning
Obscuring is privacy, not security. Ticket holders can screenshot and share the address the moment it reveals. For genuinely confidential places, pair this with a vetting flow (manual approval before ticket issue, or an application-gated event).
:::

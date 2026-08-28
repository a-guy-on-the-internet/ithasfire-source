---
title: "Obscured locations and address reveal timing"
description: "Protect host privacy — show the public less, and reveal the exact address to ticket holders on your schedule."
category: "organising-events"
order: 6
tags: ["privacy", "house-shows", "venue", "location", "address-reveal"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/restrict-event-access",
    "buying-tickets/where-is-this-event",
    "buying-tickets/digital-tickets",
  ]
specs: ["2026-06-23/location-visibility-reveal"]
---

For house shows and private-residence events, the exact address is usually sensitive. The builder's **Location Visibility** controls — under **Settings** → **Access & privacy**, or one click away via the **Hide the address?** link under the venue field — decide how much location detail the public sees before buying, and when ticket holders get the full address.

## Exact address or Obscured

Every event picks one of two options:

- **Exact address** — the full address and map are shown to everyone, always.
- **Obscured** — the public sees a fuzzed area (or no map at all); ticket holders get the exact address at the reveal time you choose.

## Public precision

When the location is **Obscured**, the **Public precision** slider sets what non-ticket-holders see on the map:

- **Tight circle to wide circle** — a shaded circle from roughly 100 m up to 50 km across. The circle is deliberately offset from your real location, so the centre of the circle is _not_ the venue.
- **Hidden — no public map** — the far end of the slider. The public sees only an area label (no map, no coordinates at all).

A live preview under the slider shows exactly what the public gets. You can also set a **Public label** — a friendly area name like "Downtown Brooklyn" — shown in place of the address. Without one, the event falls back to its city/region.

## Address reveal timing

Every obscured event **must** pick a reveal time — there is no "never reveal" option. At the reveal time, ticket holders can see the exact address; everyone else stays on the obscured view.

Choose one of:

- **Immediately after purchase** — ticket holders see the address as soon as they buy
- **1 hour before start**
- **24 hours before start** _(the default)_
- **7 days before start**
- **Custom time** — pick any date and time (**Reveal at**)

Times use the event timezone — the builder notes which one. Relative presets are recomputed from the event start time, so if you reschedule the event they shift with it. A **Custom time** is absolute and does not shift.

:::tip
The reveal is the same moment for every ticket holder, and it also applies to sales made later: anyone who buys after the reveal time gets the exact address straight away, including in their ticket confirmation email.
:::

## Host responsibilities attestation

Publishing any event with an obscured location — whether a fuzzed circle or fully hidden — requires you to confirm a host responsibilities checklist first, covering your legal right to host at the location, zoning/occupancy/noise compliance, alcohol compliance, tax responsibility, and that you've read the Organizer FAQ. Publish is blocked until every item is acknowledged.

## What attendees see

- **Before reveal** — the obscured map view (circle or area label) plus a notice on the event page: _"Exact address unlocks {date} for ticket holders."_ Ticket confirmation emails sent before the reveal show the same locked notice instead of the address.
- **At reveal time** — every ticket holder gets an in-app notification and an email ("The location for {event} is now live") with the full address, a map link, and directions. The exact address also appears on the event page for signed-in ticket holders.
- **After reveal** — buyers who purchase later get the address directly in their ticket confirmation email.

**Non-ticket-holders never see the exact address**, even after the reveal time passes.

## Gotchas

- **You always see the exact address** in the builder. Obscuring only affects the public view.
- **A Custom reveal needs a date** — saving with **Custom time** and an empty **Reveal at** field is rejected.
- **Switching to Exact address** clears the reveal settings — the address is simply public again.
- **Attendees must be signed in** with the account that holds the ticket for the event page to show them the exact address. The reveal email and in-app notification arrive regardless.

:::warning
Obscuring is privacy, not security. Ticket holders can screenshot and share the address the moment it reveals. For genuinely confidential venues, pair this with a vetting flow (manual approval before ticket issue, or an application-gated event).
:::

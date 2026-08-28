---
title: "Reuse ticket setups with templates"
description: "Save an event's ticket types as a template, apply one to your next event, or start from an Ithas Fire pack."
category: "organising-events"
order: 2
tags: ["tickets", "templates", "packs", "pricing"]
related:
  [
    "organising-events/manage-ticket-types",
    "organising-events/create-an-event",
  ]
specs: ["2026-08-04/ticket-type-packs", "2026-08-10/time-based-ticket-pricing"]
---

If you run more than one event, you don't have to rebuild the same ticket tiers every time. Save an event's ticket types as a template once, then apply it to any future event — or start from one of the ready-made setups Ithas Fire publishes.

## Saving your ticket types as a template

1. Open your event in the builder and jump to **Tickets**.
2. Once the event has at least one ticket type, click **Save as Template** in the section header.
3. Give the template a name (e.g. "Standard show") and click **Save template**.

The template captures each tier's name, price, pricing mode, capacity, and transfer setting.

Three things are deliberately **not** saved:

- **Seat sections** — they belong to a specific venue layout, so applied ticket types always arrive unseated.
- **On-sale windows** — the times a tier starts and stops selling.
- **Scheduled price changes** — the moment a tier's price steps up.

The last two are left behind because a saved time is just a date, and a date can't tell us what you meant by it. "Stops selling three days before the show" and "stops selling the day I announced it" both come out as the same Tuesday afternoon; carrying that Tuesday into next spring's event would be a guess, and the wrong guess would quietly stop a tier selling on a date you never chose. If any tier you're saving has timing on it, the save dialog says so before you confirm.

Set the timing on the new event after applying — see [On-sale windows](/help/organising-events/manage-ticket-types#on-sale-windows). If you want a tier that carries its own timing, the **Advance / Early Bird** and **Door** presets in the ticket form do exactly that, worked out against each event's own date.

Templates belong to whoever you're managing: save one while working in an organisation and everyone in that organisation can use it; save one on your personal events and it's yours alone.

## Applying a template

1. In the **Tickets** section of any event, click **Apply Template**.
2. Pick a template from the list and click **Apply**.

Every tier in the template is created on the event as an ordinary, fully editable ticket type. If the event already has a ticket type with the same name, that entry is skipped rather than duplicated — the confirmation tells you what was added and what was skipped.

:::tip
Applied ticket types are copies. Editing or removing the template later never changes any event it was already applied to.
:::

To retire a template you no longer use, click the remove icon on its row in the Apply dialog. Events it was applied to keep their ticket types.

## Starting from an Ithas Fire pack

The Apply dialog also shows a **From Ithas Fire** section — ready-made ticket setups curated by Ithas Fire, grouped into packs:

- **General admission** — one simple fixed-price tier.
- **Advance + door** — one tier, two prices: cheaper in advance, a little more at the door, sharing a single capacity pool.
- **Early-bird tiers** — three price steps that climb as each allocation sells out.
- **Pay what you can** — an adjustable-price tier with a suggested amount and no minimum.

Each entry shows its face price, capacity, and (where set) door price. The prices are starting points a small show could actually charge — not recommendations. You have two ways to use one:

- **Apply** it directly, then edit the created ticket types on the event like any others.
- **Customise** it first. This copies the template into your own list, where it replaces the catalogue version for you. If you already have a template with the same name, you'll be asked to pick a different name for your copy.

:::tip
Prices in packs (and in your own templates) are always the face price. Platform fees are worked out at checkout from your event's fee handling — see [Manage ticket types](/help/organising-events/manage-ticket-types).
:::

## What can go wrong

- **"No ticket types added"** after applying — every tier in the template already existed on the event by name. Rename or remove the existing tiers first if you wanted fresh copies.
- **A pack disappeared from the dialog** — Ithas Fire occasionally retires or reworks packs. Anything you already applied or customised is unaffected.
- **A seated event applied a template and the types have no seats** — expected: templates never carry seat sections. Assign sections in the Tickets section after applying.
- **"On-sale timing was cleared on…"** after applying — a pack's tier carried timing that doesn't fit this event's date: the moment it described had already gone by, or its start and end came out in the wrong order. The tier is still created and still sells; only the timing was dropped. Open that tier and set **Limit when this tier is on sale** yourself if you want one.

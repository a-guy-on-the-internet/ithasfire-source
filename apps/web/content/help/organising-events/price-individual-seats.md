---
title: "Give single seats a custom price"
description: "Set a different price on chosen seats, make a seat free, and see what happens to seats already sold."
category: "organising-events"
order: 18
tags: ["seating", "seats", "pricing", "tickets"]
related:
  [
    "organising-events/manage-ticket-types",
    "organising-events/create-an-event",
    "organising-events/payouts-and-settlements",
    "organising-events/issue-comp-tickets",
  ]
specs: ["2026-08-12/seat-price-overrides"]
---

On an event with a seating map, each section sells at the price of its ticket type. **Seat prices** lets you change that for single seats: charge more for the front row, or make one seat free.

## Before you start

- The event needs a seating map. The **Seat prices** page is for events that have one, and it reads "This event has no seats" if you open it on an event without.
- You need edit access to the event. Without it the page reads "You can't edit seat prices for this event".
- Each section you want to price needs at least one fixed-price [ticket type](/help/organising-events/manage-ticket-types).

## Set a custom price

1. Open the event, then **Manage** in the side rail, then **Seat prices**. You can also open the event builder, go to **Tickets**, and click **Seat prices** under the **Seating map** button.
2. Choose how to look at the seats with **View**: **Map** or **List**.
3. Select the seats. In the **Map** on a computer, drag across seats to select them and hold Shift to add to the selection. On a phone, tap seats; drag to move the map and pinch to zoom. In the **List**, tick single seats or a whole row.
4. Type the price in **Custom price**, for example `60` or `60.00`.
5. Add a **Note** if you want one, then click **Set price**.

The page then tells you how many seats were updated. Buyers see the custom price on the seat map and pay it. It replaces the section price for that seat whichever ticket type the buyer picks.

The Map and the List share one selection, so you can pick seats in one and switch to the other. The List also reaches seats the map can't draw, which it marks "not on the map".

:::tip
A price of $0.00 makes a free seat, and a free ticket carries no fee.
:::

## Go back to the section price

Select the seats and click **Use section price**. If the seats have notes, you're asked first, because the notes are deleted with the custom price and this can't be undone.

## The note

The note is for you and your team. Buyers never see it. Anyone who can edit the event does.

## Seats that can't change

- **Sold seats** keep the price they were charged.
- **Seats in someone's cart, or being bought right now,** are skipped. You can change them once that checkout ends, usually within minutes.

When you save, the result says how many seats changed and how many were skipped, with the reason. Skipped seats stay as they were.

## Sections that can't take a custom price

A section can't take a custom price if it is sold through a **Pay what you want** ticket type, because buyers name their own price there. The same goes for a section with no fixed-price ticket type. The page says "Custom prices are off" for that section. Add a fixed-price ticket type to the section to turn it on. Clearing back to the section price is always allowed.

## What can go wrong

**"A paid seat needs payouts."** If a section is free, charging for one of its seats needs [payouts set up](/help/organising-events/payouts-and-settlements) first, so the money has somewhere to go. Until then only $0.00 saves. If payouts are set up and you still can't charge, the page says paid seats aren't available yet and offers **Contact us**.

**Scheduled price changes.** If a ticket type has a scheduled price change, seats with a custom price don't follow it. The page tells you when this applies. Change those seats here if they should move too.

**The event has ended or was cancelled.** Seat prices are read-only. The page shows which seats had a custom price.

:::warning
Setting a price is not a refund or a reprice for anyone who already bought. Sold seats keep what the buyer paid.
:::

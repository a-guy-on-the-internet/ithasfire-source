---
title: "Issue comp tickets"
description: "Send free tickets to press, guests, and crew — no checkout required."
category: "organising-events"
order: 7
tags: ["comp", "complimentary", "free-tickets", "organiser"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/manage-ticket-types",
    "organising-events/discounts-at-the-door",
    "organising-events/volunteer-comp-rewards",
  ]
specs: ["2026-03-19/completed/comp-ticket-issuance"]
---

Comp tickets are free tickets you issue directly to a recipient's email. Ithas Fire creates a $0 order in their name and sends them a confirmation with QR codes — they don't need to check out or even have an account first.

The comp tickets page is a **ledger**: it lists every comp for the event — who received it, on which ticket type, why, who issued it, and when. Issuing happens through the **Issue comps** button on that page.

## Before you start

- **Viewing the ledger** needs the **Owner**, **Admin**, **Editor**, or **Finance** role on the organisation running the event.
- **Issuing comps** needs **Owner** or **Admin**. If you have a viewing role only, the **Issue comps** button doesn't appear.

The page unlocks once the event is published.

## How to issue

1. Go to your event at **/admin/{your-slug}/events/{event-id}**.
2. Open **Comp** under **Manage** in the event side rail. The rail item unlocks once the event is published.
3. Click **Issue comps** (top right — or **Issue the first comp** if the ledger is still empty).
4. Fill in the dialog:
   - **Recipient email** — required
   - **Recipient name** — optional; defaults to the email address if blank
   - **Ticket type** — pick a tier from the dropdown
   - **Quantity** — 1 to 100
   - **Reason** — optional internal note (e.g. "press", "comp swap", "crew")
5. Click **Issue tickets**.

You'll see a confirmation in the dialog, and the new comp appears in the ledger behind it straight away. The dialog stays open so you can issue the next one; close it when you're done. The recipient gets an email with the tickets attached.

## Reading the ledger

Each row shows the recipient, ticket type, quantity, origin, reason, who issued it, the order status, and the date. Two details worth knowing:

- **Origin** distinguishes **Hand-issued** comps (someone on your team issued them) from **Volunteer reward** comps (earned automatically by volunteering — see [volunteer comp rewards](/help/organising-events/volunteer-comp-rewards)). You can filter the ledger by origin.
- A blank reason isn't missing data. Volunteer rewards show **Earned by volunteering** — no one typed a reason because no one issued them by hand. A hand-issued comp with no note shows **No reason given**, and older comps from before reasons were recorded show **Issued before reasons were recorded**.

A revoked volunteer reward stays in the ledger with a **Cancelled** status, so the record of what was granted is never silently erased.

## What the recipient sees

- **New account** — they receive the email with a claim link. When they click it, a "shadow" account is created for them so the tickets land at [/my-tickets](/my-tickets).
- **Existing account** — the tickets just appear under [/my-tickets](/my-tickets) for the email you entered.

Either way, the order shows with `source: COMP` and `$0.00` total. Every ticket has a valid QR — comps scan at the door just like paid tickets.

## Capacity handling

The form warns if the quantity exceeds remaining inventory, but **doesn't block** — comp tickets are an admin override. If you issue more than your capacity allows, the tickets still mint; just be aware you're overbooking.

:::tip
For weighty comps (press, promoters, large crew), issue them early and watch the capacity count on the event page — it includes comps alongside paid sales.
:::

## Audit trail

Every comp issuance is logged — who issued what, when, and why. Each record includes:

- Recipient email and resolved human ID
- Issuing admin
- Quantity and ticket type
- The reason you typed (if any)

:::warning
Comp tickets are **not refundable through the normal flow** — there's nothing to refund ($0 paid). If you need to revoke a comp, cancel the tickets directly from the order detail. Revocation only works while the recipient hasn't used them.
:::

## Common uses

- **Press and VIPs** — guest list for media and featured attendees
- **Comp swaps** — reciprocal guest lists between organisers at shared venues
- **Crew** — band members, sound tech, door staff
- **Giveaways** — when a contest winner needs tickets issued outside the buyer flow

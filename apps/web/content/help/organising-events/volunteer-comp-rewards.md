---
title: "Comp rewards for volunteers"
description: "Thank event volunteers with a free ticket, granted automatically when they're approved or checked in, with a budget cap and an audit ledger."
category: "organising-events"
order: 12
tags: ["volunteering", "comp", "rewards", "finance", "tickets"]
related:
  [
    "organising-events/recruit-standing-volunteers",
    "organising-events/manage-volunteers",
    "organising-events/issue-comp-tickets",
  ]
specs: ["2026-06-29/completed/volunteer-comp-tickets"]
---

"Work the door, get into the show" is the oldest volunteer incentive in live events. A **comp reward** automates it: attach a free ticket to your event's volunteering, and the system issues it automatically when a volunteer reaches the trigger you choose — no hand-issuing, no spreadsheet, no way to over-spend.

A comp reward is always a **free ($0) ticket** of a type you pick. There are no percentage or fixed discounts — a full ticket is the reward.

## Before you start

Comp rewards attach to **event** volunteering only — they grant a real ticket, so they need one of that event's ticket types to point at. You can't add a reward to a standing [volunteer ask](/help/organising-events/recruit-standing-volunteers) that isn't tied to an event.

Because a comp spends the event's revenue (a given-away seat is a seat you didn't sell), configuring rewards requires a finance role. **Only owners, admins, and finance team members** see and edit the reward settings; editors managing volunteers won't see the tab.

## Set up a reward

Open your event in the admin dashboard, go to **Volunteers**, and open the **Comp rewards** tab. Choose:

- **Comp ticket type** — which ticket the volunteer receives. Its face value is recorded for reporting.
- **Grant the comp** — the trigger: **When approved** (rewards commitment) or **When checked in** (rewards actually showing up). Check-in is the default and the safer money posture — you only comp people who turned up.
- **Budget cap** (optional) — the most comps this reward will ever issue. Leave it blank for unlimited.

Save the reward. From then on, every volunteer who reaches the trigger is issued their comp automatically and receives it by email, exactly like any ticket they'd have bought — it scans, transfers, and refunds normally.

:::warning
A comp is a real ticket against your event's inventory and revenue. Set a **budget cap** if you're offering comps on a paid event — once the cap is reached, further volunteers simply get no comp (they're not turned away, and nothing errors), so you can never overshoot the number you budgeted for.
:::

## The reward ledger

The same tab shows a **Reward ledger**: how many comps have been **granted**, **used** (scanned at the door), and **voided**, the **remaining budget**, and the total face value comped. Each volunteer's row on the sign-ups list also carries a status chip — **Comp granted**, **Comp used**, or **Comp voided** — so you can see at a glance who's been rewarded. Coordinators can see these chips on their group's roster but can't configure or change rewards.

## When comps are voided

A comp is returned to your budget automatically if the volunteer **withdraws** before using it — the unused ticket is voided and the budget slot frees up for someone else.

You can also void a granted comp yourself from the reward ledger. Each granted, unused comp carries a **Void comp** action (finance roles only); confirming it invalidates the volunteer's free ticket, cancels the comp order, and returns the budget slot. Use it when you comped the wrong person or need the seat back.

A comp that's already been **used** (scanned at the door) can't be voided this way — the **Void comp** action disappears once a comp is used, and if the volunteer scans in during the moment between you opening the ledger and confirming, the void is refused and the row simply updates to **Comp used**. Reversing a genuinely used comp is a deliberate [refund](/help/buying-tickets/refunds-and-cancellations) decision.

## What can go wrong

- **The Comp rewards tab isn't there** — you're not on a finance role for this organisation, or you're looking at a standing ask rather than an event. Rewards are finance-gated and event-only.
- **No ticket types to choose** — the event has no ticket types yet. Create at least one first; the comp has to grant a specific type.
- **A volunteer didn't get their comp** — check the ledger. If the budget cap is exhausted, later volunteers get no comp by design; if the reward's trigger is **When checked in**, the comp only issues once you actually check them in.

---
title: "Require a waiver at checkout"
description: "Attach a liability or age-verification waiver buyers must accept before they can pay."
category: "organising-events"
order: 5
tags: ["waiver", "legal", "organiser", "checkout"]
related:
  [
    "organising-events/create-an-event",
    "buying-tickets/signing-a-waiver",
    "organising-events/manage-volunteers",
  ]
specs: ["2026-03-25/completed/waiver-system"]
---

A waiver is a block of text buyers must agree to before the **Pay** button unlocks. Typical uses: physical-activity liability, age verification, private-residence rules.

## Before you start

Decide which template fits — Ithas Fire provides three:

- **General event** — light attendance terms
- **Live music / physical activity** — adds physical-risk acknowledgement
- **Private residence** — for house shows and in-home events

You can also write your own from scratch or edit one of the templates.

## Attach a waiver to an event

1. In the event builder, open **Settings** and expand the **Money & compliance** group.
2. Find the **Waiver** section.
3. Pick a template or click **New waiver**.
4. Review the text — it's what buyers will see verbatim.
5. Save and publish the event.

Buyers now see your waiver text in checkout, between contact details and payment. They must check **I have read and agree** before they can pay.

## What gets recorded

Every buyer who completes a purchase has a `WaiverAcceptance` row created with:

- The exact version hash of the waiver text
- Timestamp of acceptance
- Buyer IP

This is the record you can cite if something goes wrong. Versioning means later edits don't invalidate old acceptances — each buyer is locked to the version they agreed to.

## Editing a waiver after sales open

You can edit the text. New purchases agree to the new version; existing tickets stay bound to the version that was live when they bought.

:::warning
Waivers are jurisdiction-specific. Our UI flags states where waivers are generally unenforceable (Louisiana, Virginia) and states with known restrictions (New York, Connecticut, Vermont, Oregon). We show the warning but don't block you from publishing — **Ithas Fire is not your legal counsel**. Check with a lawyer if a waiver is load-bearing for your event.
:::

## Checking acceptance at the door

Waiver acceptance is tied to the order, not the individual ticket. For age-gated events, use your door team's photo ID check as the primary gate — waiver acceptance confirms the **buyer** agreed but doesn't verify the actual attendee.

## Removing a waiver

Remove the waiver from the same **Money & compliance** settings group. Future buyers won't see a checkbox; existing acceptance records are kept.

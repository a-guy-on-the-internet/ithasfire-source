---
title: "Check-in and scanning"
description: "Scan tickets and volunteer passes at the door, and read what each result means."
category: "organising-events"
order: 4
tags: ["scanner", "check-in", "entry", "organiser", "door"]
related:
  [
    "organising-events/manage-volunteers",
    "buying-tickets/digital-tickets",
    "organising-events/find-an-order",
    "organising-events/issue-comp-tickets",
  ]
specs: ["2026-08-04/scan-ticket-redesign"]
---

Two ways to check people in: the scan page in your organiser dashboard, or the operator app on an Android phone. This article covers both, and what each scan result is telling you.

## Before you start

Pick the right event. The scan page selects your soonest upcoming event automatically, which is usually right and occasionally isn't — if you run two shows in a week, check the name under **Scanning for** before the doors open. A pass for another night reads as **WRONG SHOW**, so a wrong selection turns every valid ticket away.

## The scan page

Tap **Scan** in the middle of the action bar, or open **/admin/{your-slug}/scan** on any phone, tablet or laptop with a camera. Nothing to install, and it now works in Safari on iPhone as well as Chrome and Android.

Two modes, switched with the **Camera** and **Search** buttons:

- **Camera** points at a QR code and reads it
- **Search** finds someone by name, email or ticket code

The page needs a connection. It has no torch and no offline queue — if the venue's signal is patchy or the door is busy, use the operator app instead.

## Scanning someone in

1. Point the camera at the pass, or paste a code into **Or paste a code**
2. Read the result — the screen fills with one outcome, in colour, with a word
3. Tap **Admit** to let them in, or **Skip** to move on without admitting
4. Tap **Scan next** to clear the screen and read the next pass

Reading a pass does not admit anyone. The scanner tells you what it found and waits; admitting is always a deliberate tap. That matters at a busy door, where the fastest way to lose count is a screen that acts on its own.

:::warning
**Skip** dismisses without admitting. If you meant to let someone in, tap **Admit** — a skipped ticket stays valid and unscanned, and your admitted count won't include them.
:::

## What each result means

Green means let them in. Amber means this pass has already been used. Red means don't admit.

| What you see       | What it means                                                     |
| ------------------ | ----------------------------------------------------------------- |
| **ADMIT**          | Valid ticket. Tap **Admit** to let them in.                        |
| **ADMITTED**       | You just admitted this person. Confirmation, nothing to do.        |
| **ALREADY IN**     | This ticket was scanned before, with the time it happened.         |
| **VOLUNTEER**      | A volunteer pass. Tap **Check in** instead of Admit.               |
| **WRONG SHOW**     | A real pass for a different event. Switch events, or send them on. |
| **REFUNDED**       | Refunded. Do not admit.                                            |
| **VOIDED**         | Cancelled by an organiser. Do not admit.                           |
| **LISTED**         | Listed for resale. Do not admit.                                   |
| **NOT OPEN**       | The event window hasn't started, or closed too long ago.           |
| **NO MATCH**       | No ticket with that code for this event.                           |
| **UNREADABLE**     | The code couldn't be read. Try again, or use **Search**.           |
| **TAMPERED**       | A volunteer pass that failed its signature check.                  |

**ALREADY IN** is the one worth pausing on. It usually means a genuine duplicate — a screenshot passed to a friend, or a group sharing one phone. The screen shows when the ticket was first scanned, so you can tell a double-tap seconds ago from a pass someone used two hours earlier.

:::tip
Glare is the usual reason a code won't read. Ask the holder to turn their screen brightness up before you reach for anything else. The scan page has no torch — the operator app does.
:::

## When the QR won't scan

Switch to **Search** and look the person up by name, email or ticket code. You'll see who they are, which ticket type they hold, and its current status, with the same **Admit** action. This is the path for a dead phone, a cracked screen, or a printout that has been through a pocket.

## Volunteers

Volunteer passes resolve on the same screen and show **VOLUNTEER** with the role and shift. Check them in with **Check in** rather than Admit.

Volunteer check-in needs an Owner, Admin or Editor role. Operators with the Scanner role see the button locked, which is deliberate — ask an organiser to check volunteers in, or upgrade the role before the shift. See [managing volunteers](/help/organising-events/manage-volunteers).

## Counts at the door

The scan page keeps two running numbers for your session: **ADMITTED** and **ALREADY IN**. Both count people, not scans — reading the same pass twice won't inflate either.

## More than one door

Several people can scan at once. A ticket admitted at one door reads as **ALREADY IN** at every other, so duplicates surface wherever they turn up.

## The operator app

For a busy door, a dark room, or a venue whose wifi comes and goes, the operator app does things a browser can't: it keeps a torch, holds a local copy of the guest list so it can scan without signal, and queues admissions to sync when the connection returns.

:::action
Install links, onboarding emails for your door staff, and account recovery all live on **Scanner Setup** in your dashboard, at **/admin/{your-slug}/scanner-setup**.
:::

## What can go wrong

**Every ticket reads WRONG SHOW.** The wrong event is selected. Check the name under **Scanning for**.

**The camera never starts.** The browser is blocking camera access — allow it for the site in your browser settings, then reload. On a laptop, another app may be holding the camera.

**A scan fails with an error.** The scan page needs a connection, and it will say so. Retry once; if it keeps failing, use **Search**, or move to the operator app, which keeps working offline.

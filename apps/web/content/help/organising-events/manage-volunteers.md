---
title: "Recruit and manage volunteers"
description: "Add volunteer roles and shifts, review sign-ups, track hours, and export reports."
category: "organising-events"
order: 10
tags: ["volunteering", "shifts", "organiser", "hours"]
related:
  [
    "getting-started/volunteer-at-an-event",
    "organising-events/recruit-standing-volunteers",
    "organising-events/volunteer-comp-rewards",
  ]
specs:
  [
    "2026-03-23/completed/volunteering",
    "2026-06-10/completed/volunteer-system-gaps",
    "2026-07-27/volunteer-role-packs",
  ]
---

Events can recruit volunteers directly on the public event page. You define roles and shifts, volunteers apply (with or without an account), and you review, check in, and track hours from the admin dashboard. For what the volunteer sees, read [volunteer at an event](/help/getting-started/volunteer-at-an-event).

## Before you start

In the event builder, open the **Volunteering** section and switch on **Accept volunteers**. This shows a volunteer sign-up section on the public event page once the event is published and at least one role exists. Three more settings live here:

- **Auto-approve sign-ups** — approve new volunteers instantly instead of reviewing each application.
- **Intro text for the volunteer page** — meeting points, dress code, perks; volunteers see it at the top of the sign-up sheet.
- **Require waiver** — volunteers must accept the event's waiver when signing up. This only takes effect when the event [has a waiver assigned](/help/organising-events/require-a-waiver); until then the builder shows a hint and the setting does nothing.

## Set up roles and shifts

Open your event in the admin dashboard and go to **Volunteers** → **Roles & shifts** tab. Click **Add role**, then either:

- **From template** — the **Pick templates** dialog lists your organisation's reusable role templates (managed under **Volunteer Roles**, in the **Door & Crew** section of the admin sidebar) alongside ready-made roles from Ithas Fire's own catalogue, marked **From Ithas Fire**. Tick any mix of the two; each becomes a role on this event. You don't have to customise a catalogue role first — it can be applied as it is.
- **Custom** — define a one-off role: title, optional description, **Slots needed** (leave blank for unlimited), and a signup-approval choice for this role — **Event default** (inherits the event-level setting), **Always approve**, or **Always review**.

Catalogue roles show their shift times resolved against _this_ event under the role name, so you can see what you're about to create before you click **Create roles**.

Within a role, click **Add shift** to add time slots: optional label (e.g. "Morning setup"), start and end times, capacity (inherits from the role if blank), and private admin notes. The **Quick add shifts** composer creates several at once from presets (Setup, Doors, Main shift, Cleanup) — up to 25 per save.

Roles created from a template arrive with their shifts as _drafts_ in the composer, not saved. Adjust anything you want, then click **Create shifts** to commit them.

A role with no shifts takes sign-ups for the whole role instead.

## Use Ithas Fire's role catalogue

**Volunteer Roles** (under **Door & Crew**) lists your own templates and Ithas Fire's curated ones together. Catalogue rows carry a **From Ithas Fire** tag and are read-only: instead of the edit and archive actions you get **Customise**, which makes a copy owned by your organisation — same name, description, slot count, and shift presets — that you can then edit freely.

The copy then **replaces** the catalogue row in your list. You see one row per role, yours, and it's the one that gets applied to events. Nothing is lost: everything the catalogue role had was copied into it.

:::warning
Archiving a customised copy brings the original catalogue row back into the list — your organisation retired its version, so the Ithas Fire one becomes usable again. Turn on **Show archived** and the archived copy resumes replacing it, so the "show archived" view can list _fewer_ Ithas Fire roles than the default view.
:::

If your organisation already has a template with the same name that isn't a copy of that catalogue role, **Customise** stops and asks you to **Choose a different name** rather than overwrite your own work. It suggests "_name_ (copy)"; pick anything unused and both survive.

Only owners and admins see **Customise**, **Start from a pack**, and **New template**. Editors and viewers see the same list, read-only.

### Start from a pack

Catalogue roles are grouped into packs. If your organisation has no templates yet, the pack picker sits directly under the empty table; once you have templates it moves behind a **Start from a pack** button in the page header, so it never competes with your own roles.

The launch packs are **House show**, **DIY & all-ages space**, **Performing arts**, **Club night**, and **Standing crew**. Each card lists its roles with a shift count — or "No shifts yet — volunteers sign up for the whole role" for the ones that deliberately have none. Roles you've already customised show as **Customised** and can't be copied twice.

## Time shifts from the event, not the clock

A shift preset on a template no longer has to name a fixed clock time. The **Starts** control offers three modes:

- **At a set clock time** — the old behaviour; you also fill in **Start time** and **End time**.
- **Relative to the event start**
- **Relative to the event end**

Pick one of the relative modes and you get **By** (hours and minutes, **before** or **after**) and **Lasts** (how long the shift runs). "Load-in, 3 hours before the show, lasting 3 hours" then resolves correctly for a 7pm gig _and_ a 2pm matinee, where a fixed 4:00 PM preset would put load-in two hours after the matinee started.

Under each preset, **Resolves to** previews the result against two sample showtimes — an **8:00 PM show** and a **2:00 PM matinee** — so a wrong anchor is visible before you save.

:::tip
The same control exists on a single event's shifts. In the **Quick add shifts** composer, click **Time it from the event** on a draft, set the anchor, offset and duration, then **Use these times** — it fills the draft's start and end for you, and the fields stay editable afterwards.
:::

### Times use the event's timezone

Template shifts resolve in the **event's** timezone, not your browser's, so an organiser in another timezone still schedules against the venue's clock. Because the composer's date-and-time fields are native browser controls, they read in your local time — when the two differ, a caption under each field shows the same moment on the event's clock (e.g. "Jun 15, 6:00 PM CDT"). Trust the caption; don't "correct" the field back.

## How approval and capacity work

Capacity governs **acceptance, not application**:

- Pending applications never count against capacity — only approved and checked-in volunteers do.
- Full shifts stay open on the public page, labelled "Full — you'll be waitlisted". Applications to a full shift land as pending: a natural waitlist.
- With auto-approve on, sign-ups are confirmed instantly **while there's room**; once the shift or role is full, further sign-ups degrade to pending instead of overfilling.
- Role and shift cards count the same way: "4 of 4 filled · 1 pending" means four accepted volunteers against a capacity of four, with one application waiting for review.

Volunteers are emailed when you approve or reject them.

## Review sign-ups

The **Signups** tab lists every application with filters for status, role, and shift. Per row you can **Approve**, **Reject** (with an optional note to the volunteer), **Check in**, or **Withdraw** on the volunteer's behalf.

To work in bulk, tick pending rows and use **Approve selected** / **Reject selected**. If some rows fail — for example a shift filled up mid-batch — the rest still succeed, and failed rows are marked inline so you can fix the cause and retry.

Rows where the volunteer accepted the event waiver show a **Waiver ✓** chip; hover it for the acceptance date.

:::warning
Approving past capacity is blocked with "Shift is full — raise the shift capacity to approve more volunteers" (same for full roles). Raise the capacity on the shift or role first, then approve.
:::

When an approved volunteer withdraws from a shift that still has pending applicants, org admins get a "spot opened" notification linking back to the Signups tab. Promoting someone from the waitlist stays your decision — nobody is auto-approved into the freed spot.

## Track hours and export

Each approved or checked-in row shows an **Hours** column, defaulting to the shift's scheduled duration. Click **Edit** to record actual hours worked (leave empty to revert to the scheduled value).

**Export hours CSV** downloads the event's volunteer report, including waiver acceptance date, scheduled hours, and actual hours per volunteer.

For the cross-event view, open **Volunteers** (in the **Door & Crew** section of the admin sidebar): total hours, events, sign-ups, and last shift per volunteer across your whole organisation, with a date filter (**This year** / **All time** presets), name or email search, and its own **Export CSV**.

By default the cross-event totals include every sign-up regardless of status, so they reconcile with the per-event hours exports. Tick **Accepted only** to count just approved and checked-in volunteers — the view to use for recognition programmes or grant reporting, where withdrawn or rejected sign-ups shouldn't inflate the numbers.

## What can go wrong

- **Volunteer section missing from the event page** — the event must be published with **Accept volunteers** on and at least one role. Past events hide the section too.
- **An Ithas Fire role disappeared from Volunteer Roles** — somebody customised it. Your organisation's copy is in the list under the same name; edit that. The original comes back only if you archive the copy.
- **A role in Pick templates is greyed out** — one of its shifts is anchored to a time this event doesn't have: "This date has no end time, so a shift anchored to it can't be scheduled" (common on a recurring occurrence with no end time), or the event has no start time at all. Give the event or that date an end time, or add the role and set its shifts by hand. Greyed-out rows can't be ticked and are skipped even if they were ticked before the event changed.
- **"2 shifts weren't scheduled" after creating roles from templates** — the roles were created, but those shifts couldn't be placed against this event for the same reason, so they were left out rather than guessed at. The message names them; add them in the composer.
- **Require waiver does nothing** — no waiver is assigned to the event yet. Assign one in the event's waiver settings first.
- **Can't delete a role or shift** — roles and shifts with existing sign-ups can't be deleted while those sign-ups exist.
- **A volunteer says they got no texts** — SMS only goes out when the volunteer entered a phone number and ticked the SMS opt-in; volunteers who replied STOP to any Ithas Fire text are opted out globally. Email reminders (24 hours and 1 hour before the shift) go out regardless.

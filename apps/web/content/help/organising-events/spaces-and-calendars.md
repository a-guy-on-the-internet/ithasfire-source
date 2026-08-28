---
title: "Set up your venue's spaces and calendars"
description: "Split a venue into physical spaces and named programming streams, then set hours and blackout dates for each."
category: "organising-events"
order: 14
tags:
  ["venue", "spaces", "calendars", "availability", "hours", "blackout", "organiser"]
related:
  [
    "organising-events/claim-your-venue",
    "organising-events/booking-requests",
    "organising-events/embed-widgets",
    "organising-events/create-an-event",
  ]
specs: ["2026-08-18/venue-hierarchy-and-holds"]
---

A venue is rarely one undifferentiated diary. You might have a main stage and a back bar, or one floor that hosts a members' social club on Tuesdays and a live-music series at weekends. Spaces and calendars let you say so.

## Spaces and calendars: which is which

Two ideas, and it's worth getting them straight before you touch anything:

| | **Space** | **Calendar** |
| --- | --- | --- |
| What it is | A physical part of the venue — main stage, back bar, patio | A named stream of programming — "Social Club", "Live Music" |
| Who sees it | Only you and your staff | The public: it's what your listings and embeds are named after |
| What it's for | Working out whether two shows collide | Grouping and publishing what you programme |
| Carries | A capacity | Opening hours, blackout dates, a default start time |

A calendar schedules into one or more spaces, and a space can serve several calendars. That combination is the whole point: your Social Club and your live-music series can both run in the main stage, keep separate public listings, and still warn you when they try to book the same night.

## Before you start

Nothing to set up — the moment you add a venue, Ithas Fire creates one space called **Main Space** and one calendar called **Main Calendar** joined to it. A venue never has zero spaces or zero calendars, so if you only ever use those two, you can ignore this page entirely and everything works.

## Where to find it

Open the venue from **Places** in the admin sidebar, then choose **Spaces & availability** in the venue's **Venue** group. (The **Calendar** entry lower down, under **Operate**, is the day-to-day schedule view — a different screen.)

The page has three sections, top to bottom: **Calendars**, **Spaces**, **Availability**.

## Add a calendar

1. In the **Calendars** section, click **New calendar**.
2. Fill in:
   - **Name** — what the public sees. "Social Club", "Drkmttr Live Music".
   - **Default start time** — the clock a new event on this calendar starts at when you create one from a month cell. Doors-and-stage-time reality, not a rule; you can change it on any event.
   - **Public link name** — the short name used in public links and embeds.
   - **Description** — optional.
   - **Spaces** — tick every space this calendar schedules into.
3. Click **Create calendar**.

Existing calendars each get an **Edit** button that reopens the same fields, plus their assigned spaces and a **Default** badge on whichever one is the venue's default.

:::warning
**Public link name can't be changed after you create the calendar.** It's baked into public links and embed snippets, so renaming it would break anything already pasted on your site. The **Name** stays editable — pick the link name carefully and rename freely afterwards.
:::

## Add a space

In the **Spaces** section, give the space a **Space name**, optionally a **Capacity**, and click **Add space**.

Each existing space offers **Rename** and **Retire**. Retiring keeps the space and its history but takes it out of circulation — it stops being offered for new scheduling and shows a **Retired** badge. **Reactivate** puts it back.

One thing you can't do: retire your last active space. The page says so directly — *"A venue always keeps at least one active space, so its last active space can't be retired."*

## Hours and blackout dates

The **Availability** section is where you say when the venue can host a show, and when it definitely can't. Both live under one control at the top:

**Applies to** — pick **All calendars** or one calendar by name.

This is the part worth reading twice. **All calendars** is not a shortcut that copies your entry onto each calendar; it's a single venue-wide entry that every calendar obeys. Close the venue for the New Year with **All calendars** selected and you add *one* blackout — edit it once later and every calendar changes with it. There's no drift because there's only one row.

Use a specific calendar when the rule genuinely belongs to that stream: the social club runs Tuesday afternoons, the live series doesn't.

### Hours of operation

A weekly grid, one row per weekday, with an **Open** and **Close** time. Two details:

- **A day can have more than one window.** **Add window** gives a matinee and an evening as separate bookable slots rather than one long smear across the afternoon.
- **A closing time at or before the opening time means the night runs past midnight** — 20:00 to 02:00 is a normal Friday, not a mistake, and the editor marks it **+1 day**.

Close a day entirely and it disappears from the booking calendar — performers aren't offered it at all.

### Blackout dates

One-off closures: holidays, maintenance, a private hire. A blackout overrides your hours for the whole date.

Give it a **Date**, optionally a **Through** date for a run of days, and optionally a **Private note** ("Private hire"). A single entry covers up to 60 days; longer closures go in as a few entries.

:::warning
The private note is exactly that — private. Performers looking at your venue see only that the date is unavailable, never why. That's deliberate: "private hire" tells a competitor the venue is earning that night, and "floor refinishing" tells them it isn't.
:::

## What this changes elsewhere

Once you have more than one space or calendar, five things behave differently:

- **Clash warnings key off the space.** Two events overlapping in the *same space* are flagged **Double-booked** on your admin calendar — a warning triangle on the event, and a hover tooltip naming the other booking and how long they overlap. Two events in *different spaces* on the same night are not a clash, and are not flagged. The warning never blocks you — sometimes you really do mean it — and it never appears on any public page.
- **An event shows only on its own calendar.** Two calendars sharing a space don't bleed into each other's listings: an event belongs to the calendar it was created on. Clash detection still sees both.
- **Creating an event from a calendar cell carries the context.** Click an empty day on the venue's **Calendar** screen and quick-create opens with the date already filled in, at that calendar's default start time, on that calendar. When the calendar has exactly one active space, the space is filled in too. With two or more, you pick — a UI that guesses which space is a UI that double-books you.
- **Booking requests arrive on your default calendar.** Performers pitch the venue, not a particular stream, and the request routes to whichever calendar carries the **Default** badge.
- **The nights performers are offered key off that same default calendar** — its hours, and only the spaces it schedules into. See below.

### What performers are offered

When a performer opens your booking form, the date picker answers for your **default calendar**: the hours you set on it, plus any you set to **All calendars**, and it marks a night taken only when a space *that calendar* schedules into is already booked. A show in a space the default calendar doesn't use no longer closes off the night.

Three rules follow, and they're the ones most likely to surprise you:

- **An event with no space assigned blocks every calendar.** An event that names no space could be anywhere in the building, so it's treated as taking all of it. That's the safe direction — better to hide a night you could actually have sold than to take a booking for a room that's already gone — but it means one event without a space makes the *whole venue* look booked that night. Events created before you split the venue into spaces are the usual culprit. If a night looks unavailable and you can't see why, open the event on that date and assign it a space.
- **Two spaces on one calendar still block each other.** A calendar is busy when *any* of its spaces is busy. Put the main stage and the back bar on the same calendar and a back-bar gig closes that night for the main stage too.
- **So give each space its own calendar if you want them to book independently.** Make a calendar per space, assign one space to each, and leave the one you want performers to pitch as the **Default**. Shows in your other spaces then stop closing off nights on the booking form. Keeping several spaces on one calendar is perfectly fine when the venue really does run one room at a time — it's a choice, not a mistake.

:::tip
The quickest way to check any of this is to open your own venue page and look at the booking form the way a performer does. The nights offered there are exactly what the rules above produce.
:::

## Publish a calendar on your own site

A calendar is a public-facing thing, so you can embed one on its own — "here's just our Social Club programming" — separately from the rest of your diary. See **Embedding one named calendar** in [embed your events on your own site](/help/organising-events/embed-widgets).

## What can go wrong

- **A calendar shows "No spaces assigned".** It has nowhere to schedule into. Open **Edit** on the calendar and tick at least one space. Worth fixing promptly if it's your default calendar: with no spaces to narrow to, it falls back to treating the *entire* venue's diary as its own, so every show anywhere marks the night taken on the booking form. Assigning even one space fixes it.
- **A calendar shows "No active spaces".** Every space it's assigned to has been retired. Reactivate one, or assign a different space.
- **A blackout won't save** — *"That range is backwards or longer than 60 days."* The **Through** date is earlier than the **Date**, or the run is too long. Fix the order, or split the closure into a few entries.
- **Opening and closing times can't be the same.** A zero-length window isn't a window. For a night that runs past midnight, put the closing time *before* the opening time.

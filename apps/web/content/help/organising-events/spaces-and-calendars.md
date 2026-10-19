---
title: "Set up your place's spaces and calendars"
description: "Split a place into physical spaces and named programming streams, then set hours and blackout dates for each."
category: "organising-events"
order: 14
tags:
  ["place", "spaces", "calendars", "availability", "hours", "blackout", "organiser"]
related:
  [
    "organising-events/claim-your-place",
    "organising-events/booking-requests",
    "organising-events/embed-widgets",
    "organising-events/hidden-places-and-address-reveal",
  ]
specs: ["2026-08-18/completed/venue-hierarchy-and-holds",
    "2026-08-27/venue-confirmation-and-booking-intents", "2026-09-02/completed/event-calendar-redesign"]
---

A place is rarely one undifferentiated diary. You might have a main stage and a back bar, or one floor that hosts a members' social club on Tuesdays and a live-music series at weekends. Spaces and calendars let you say so.

## Spaces and calendars: which is which

Two ideas, and it's worth getting them straight before you touch anything:

| | **Space** | **Calendar** |
| --- | --- | --- |
| What it is | A physical part of the place — main stage, back bar, patio | A named stream of programming — "Social Club", "Live Music" |
| Who sees it | Only you and your staff | The public: it's what your listings and embeds are named after |
| What it's for | Working out whether two shows collide | Grouping and publishing what you programme |
| Carries | A capacity | Opening hours, blackout dates, a default start time |

A calendar schedules into one or more spaces, and a space can serve several calendars. That combination is the whole point: your Social Club and your live-music series can both run in the main stage, keep separate public listings, and still warn you when they try to book the same night.

## Before you start

Nothing to set up — the moment you add a place, Ithas Fire creates one space called **Main Space** and one calendar called **Main Calendar** joined to it. A place never has zero spaces or zero calendars, so if you only ever use those two, you can ignore this page entirely and everything works.

## Where to find it

Open the place from **Places** in the admin sidebar, then choose **Spaces & availability** in the sidebar's **Place** group. (The **Calendar** entry lower down, under **Operate**, is the day-to-day schedule view — a different screen.)

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

Existing calendars each get an **Edit** button that reopens the same fields, plus their assigned spaces and a **Default** badge on whichever one is the place's default.

:::warning
**Public link name can't be changed after you create the calendar.** It's baked into public links and embed snippets, so renaming it would break anything already pasted on your site. The **Name** stays editable — pick the link name carefully and rename freely afterwards.
:::

## Add a space

In the **Spaces** section, give the space a **Space name**, optionally a **Capacity**, and click **Add space**.

Each existing space offers **Rename** and **Retire**. Retiring keeps the space and its history but takes it out of circulation — it stops being offered for new scheduling and shows a **Retired** badge. **Reactivate** puts it back. Spaces are never deleted, so nothing that happened in one is ever lost.

### The rule that governs retiring

**Every calendar always has at least one active space, and so does the place.** A calendar with nowhere to put an event isn't a configuration, it's broken data — the booking form would offer nights it could never actually honour. Ithas Fire refuses to create one, either by the front door or the side door.

Two refusals follow:

- **Your last active space won't retire.** The **Retire** button is greyed out on it, with the reason under the row: *"A place always keeps at least one active space, so its last active space can't be retired."*
- **A space that's some calendar's last active one won't retire either** — even when the place has plenty of other spaces left. Here the button stays live, because this section can't see your calendar assignments; the refusal comes back as a message, and it **names the calendar**: *"Patio Sessions would be left with no active space. Give it another space, then retire this one."* If more than one calendar depends on the space, all of them are named.

  Do what the message says: open **Edit** on the calendar it named, tick another space, save, then retire.

The same rule applies when you assign spaces. Ticking only retired spaces on a calendar is refused with *"Pick at least one space that is still active."* Keeping a retired space ticked **alongside** a live one is fine — that's how you hold on to the history of a room you no longer use.

## Hours and blackout dates

The **Availability** section is where you say when the place can host a show, and when it definitely can't. Both live under one control at the top:

**Applies to** — pick **All calendars** or one calendar by name.

This is the part worth reading twice. **All calendars** is not a shortcut that copies your entry onto each calendar; it's a single place-wide entry that every calendar obeys. Close the place for the New Year with **All calendars** selected and you add *one* blackout — edit it once later and every calendar changes with it. There's no drift because there's only one row.

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
The private note is exactly that — private. Performers looking at your place see only that the date is unavailable, never why. That's deliberate: "private hire" tells a competitor the place is earning that night, and "floor refinishing" tells them it isn't.
:::

## What this changes elsewhere

Once you have more than one space or calendar, five things behave differently:

- **Clash warnings key off the space.** Two events overlapping in the *same space* are flagged **Double-booked** on your admin calendar: each event involved gets a warning triangle and a warning-coloured outline. The calendar doesn't name the other booking or say how long they overlap; the clashing event is the neighbour on that day, so open either one to compare times. Two events in *different spaces* on the same night are not a clash, and are not flagged. The warning never blocks you — sometimes you really do mean it — and it never appears on any public page.
- **An event shows only on its own calendar.** Two calendars sharing a space don't bleed into each other's listings: an event belongs to the calendar it was created on. Clash detection still sees both.
- **Creating an event from a calendar cell carries the context.** Click an empty day on the place's **Calendar** screen and quick-create opens with the date already filled in, at that calendar's default start time, on that calendar. When the calendar has exactly one active space, the space is filled in too. With two or more, you pick — a UI that guesses which space is a UI that double-books you.
- **Booking requests arrive on your default calendar.** Performers pitch the place, not a particular stream, and the request routes to whichever calendar carries the **Default** badge.
- **The nights performers are offered key off that same default calendar** — its hours, and only the spaces it schedules into. See below.

### What performers are offered

When a performer opens your booking form, the date picker answers for your **default calendar**: the hours you set on it, plus any you set to **All calendars**, and it marks a night taken only when a space *that calendar* schedules into is already booked. A show in a space the default calendar doesn't use no longer closes off the night.

Three rules follow, and they're the ones most likely to surprise you:

- **An event with no space assigned blocks every calendar.** An event that names no space could be anywhere in the building, so it's treated as taking all of it. That's the safe direction — better to hide a night you could actually have sold than to take a booking for a room that's already gone — but it means one event without a space makes the *whole place* look booked that night. Events created before you split the place into spaces are the usual culprit. If a night looks unavailable and you can't see why, open the event on that date and assign it a space.
- **Two spaces on one calendar still block each other.** A calendar is busy when *any* of its spaces is busy. Put the main stage and the back bar on the same calendar and a back-bar gig closes that night for the main stage too.
- **So give each space its own calendar if you want them to book independently.** Make a calendar per space, assign one space to each, and leave the one you want performers to pitch as the **Default**. Shows in your other spaces then stop closing off nights on the booking form. Keeping several spaces on one calendar is perfectly fine when the place really does run one room at a time — it's a choice, not a mistake.

:::tip
The quickest way to check any of this is to open your own place page and look at the booking form the way a performer does. The nights offered there are exactly what the rules above produce.
:::

## Confirming events at your place

Anyone can name your place as the place for their event. Naming it doesn't give them your calendar. Until you confirm, the event blocks nothing, sits outside clash detection, stays off your place's public page, and shows an address instead of your place's name on its own page. Your own events are confirmed from the start.

Events other people list at your place appear on the **Calendar** screen with a dashed outline and an **Unconfirmed** label in every view, so you can see who's claiming the room. Open one and you get two choices:

- **Confirm** — the event now counts. It blocks the space it names, shows up in clash warnings, appears on your place's public page, and its own page says **Confirmed by the place** next to your place's name and link. The organiser is notified.
- **Not mine** — give a reason, which the organiser receives. The event keeps its listing and its address, stays address-only, and never blocks your calendar. It stays listed as unconfirmed on your calendar, so you can still confirm it later if things change.

Confirmed a listing by mistake? Open it again from the calendar and choose **Withdraw confirmation**, with a reason. The organiser gets your reason, keeps the event, and can still edit it; the event goes back to address-only and stops blocking your calendar. Your own events can't be withdrawn, since there's nothing to confirm.

:::tip
Unconfirmed events are reachable with Tab: in the agenda the whole row is the button, and in the month and week grids it's the chip. Press Enter to open the same two choices without a mouse.
:::

Confirmation says one thing: the place stands behind this event at this place. It doesn't move the event onto your account, sell tickets for you, or change who gets paid. If the organiser later moves the event to a different place, the confirmation lapses and that place decides for itself.

Requests to rent or use one of your spaces don't start on the calendar — they arrive in your Bookings inbox, and you confirm them from the conversation, choosing who owns the resulting event. See [Requests to rent or use a space](/help/organising-events/booking-requests#requests-to-rent-or-use-a-space).

## Publish a calendar on your own site

A calendar is a public-facing thing, so you can embed one on its own — "here's just our Social Club programming" — separately from the rest of your diary. See **Embedding one named calendar** in [embed your events on your own site](/help/organising-events/embed-widgets).

## What can go wrong

- **A show you can see on your calendar isn't closing off the night on the booking form.** Check its label. An **Unconfirmed** event is someone else's listing at your place and blocks nothing until you open it and choose **Confirm**.
- **New calendar won't save without a space.** Every calendar schedules into at least one space, so the form keeps **Create calendar** disabled until you tick one. A place with no spaces at all says so and points you at the **Spaces** section below it: add a space first, then come back. Ticking only *retired* spaces is refused too, with *"Pick at least one space that is still active."*
- **Retiring a space was refused because a calendar depends on it.** The message names the calendar. Open **Edit** on that calendar, tick another space, save, then retire.
- **A calendar shows "No spaces assigned" or "No active spaces".** It has nowhere to put an event. Nothing you can do today produces this — the rule above blocks every route to it — so any calendar in this state predates the rule. Fix it the same way: open **Edit**, tick a live space, save. Worth doing promptly if it's your default calendar, because a calendar with no spaces to narrow to falls back to treating the *entire* place's diary as its own, so every show anywhere marks the night taken on the booking form. Until it's fixed, that calendar isn't offered for space-hire requests at all.
- **A blackout won't save** — *"That range is backwards or longer than 60 days."* The **Through** date is earlier than the **Date**, or the run is too long. Fix the order, or split the closure into a few entries.
- **Opening and closing times can't be the same.** A zero-length window isn't a window. For a night that runs past midnight, put the closing time *before* the opening time.

---
title: "Restrict who can see and attend your event"
description: "Gate an event behind a password or an application, and control who can find it."
category: "organising-events"
order: 6
tags: ["access", "password", "application", "private", "organiser"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/hidden-venues-and-address-reveal",
    "buying-tickets/how-to-buy",
  ]
---

Some events aren't meant for everyone with the link. The event builder gives you two independent controls for this: **Visibility** decides who can find the event, and the **Access gate** decides who can open its full page and buy tickets. They stack — a private event can also sit behind a password, for example.

## Before you start

Visibility and the access gate are different levers:

- **Visibility** — **Public** means anyone with the link can see the event; **Private** means only people with a direct link can reach it. Private keeps an event out of casual discovery, but the link itself is still all someone needs.
- **Access gate** — a password or an application that a visitor must clear before the full event page unlocks. This is what actually stops link-holders from getting in.

Use the access gate when the link alone shouldn't be enough.

## Password-protect an event

1. In the event builder, open **Settings**, expand the **Access & privacy** group, and find the **Access Gate** section.
2. Choose the password gate and click **Set password**.
3. Enter a password and save.

Visitors now see a locked page with only the event title and image, and a prompt to enter the password. A correct password unlocks the full page and keeps that device unlocked for about 24 hours, so they don't have to re-enter it if they come back the same day.

:::tip
Share the password through the same channel you trust to share the link — a group chat, a newsletter, a DM. Anyone who has both the link and the password can get in, so treat it like a shared key rather than a per-person invite.
:::

To change it later, open the **Access Gate** section again and set a new password; to remove the gate entirely, remove the password.

## Gate an event behind an application

An application gate collects answers from would-be attendees and lets you decide on each one before they can buy.

1. In the **Access Gate** section, choose the application gate.
2. Click **Edit application form** to write your questions — or **Start from a template** to begin with a ready-made set (see [Application form templates](#application-form-templates) below).
3. As applications come in, click **Review applications** to open the queue.
4. Approve, waitlist, or decline each application. Approved applicants are notified and can then open the event and buy tickets.

Anyone can apply — an account isn't required. Signed-out applicants give an email address, and their decision email carries a link that unlocks the event for them. If they later sign in with that same (verified) email, the application attaches to their account so it shows up in their status.

### Writing questions

Each question is short text, long text, a single choice, or multiple choices, and you mark each one required or optional. Choice questions get their own list of options.

### Application form templates

Templates save you from rebuilding the same form each time.

- **Start from a template** when you turn on the application gate. You'll see a platform starter set — performer application, vendor or market stall, house-show RSVP, workshop, press accreditation, guest list — alongside anything your organisation has saved.
- **Save as template** from the form builder header, to reuse this event's questions later.
- Manage your organisation's library from **Application form templates** in the admin sidebar, under Programming.

Applying a template **copies** its questions onto this event. Editing the template afterwards never changes events you already created, and editing an event's questions never changes the template. You can't apply a template once applications have started arriving — that would move the questions out from under answers people already gave.

### Set an application window, a cap, or instant approval

In the same **Access Gate** section:

- **Application window** — optional open and close dates. Before it opens, visitors see when applications open; after it closes, they see that applications are closed.
- **Maximum applications** — stop accepting once you've received that many. Withdrawn and expired applications don't count toward the limit.
- **Approve automatically** — approve and unlock every applicant the moment they apply. Use this when you want the questions but not the gatekeeping ("registration with questions"). The approval email sends immediately.

### Deciding on applications

From the queue you can **approve**, **waitlist**, or **decline** each application.

- **Approve** unlocks the event for that person and emails them.
- **Waitlist** puts them on the event's waitlist so they're notified if space opens up.
- **Decline** emails them. You can add an optional reason, which is included in that email — keep it brief and kind.

You can rescind an approval, waitlist, or decline from the queue, which moves that application back to pending. Access follows the application's current standing — an approval is what lifts the gate for that person.

### What applicants can do

Applicants see their status on the event page. While an application is still pending they can **withdraw** it, and if the application window is still open they can apply again afterwards. Applications left pending after the window closes are marked expired automatically about a week later.

## What can go wrong

- **Choosing the password gate but never setting a password** leaves the event effectively ungated — the builder won't apply a password gate until a password is saved. Finish the **Set password** step.
- **Expecting a private event to be secret.** Private only removes the event from discovery; the direct link still works for anyone who has it. If the link might spread, add an access gate as well.
- **Turning on "Approve automatically" and still waiting to review.** Auto-approval unlocks everyone instantly; the queue becomes a record, not a decision point.
- **Trying to apply a template to an event that already has applications.** Once answers exist, the questions are locked to protect them. Start from a template before you open applications.
- **Closing the window and expecting the queue to clear itself.** Closing stops new applications; the ones already pending still need a decision from you.

:::warning
The access gate controls who can open the page and buy — it is not a substitute for checking people in at the door. Use [check-in scanning](/help/organising-events/check-in-scanning) to verify who actually attends.
:::

## Related

Pair this with [obscured locations and address reveal](/help/organising-events/hidden-venues-and-address-reveal) when you also need to keep the venue address private until closer to the event. New to the builder? Start with [create an event](/help/organising-events/create-an-event).

---
title: "Performer mode and booking requests"
description: "Turn on performer mode, send booking requests to venues, and track or withdraw them."
category: "account"
order: 5
tags: ["performer", "booking-requests", "venues", "gigs"]
related:
  [
    "organising-events/booking-requests",
    "account/edit-your-profile",
    "getting-started/find-events",
  ]
specs:
  [
    "2026-06-05/completed/performer-mode",
    "2026-06-05/completed/booking-request-and-agreement-editor",
    "2026-07-13/booking-request-embed-button",
    "2026-07-14/booking-conversation-and-event-step",
    "2026-08-25/booking-holds",
  ]
---

Performer mode lets you pitch your act directly to venues on Ithas Fire. This article covers turning it on, sending a booking request from a venue's page, and tracking or withdrawing requests you've sent.

## Turn on performer mode

1. Open [Settings → Performer](/account/settings/performer).
2. Flip the **Performer mode** switch on.

That's it — you can now send booking requests as yourself. Turning the switch off later hides performer features but keeps your data, so nothing is lost if you change your mind.

Booking for a band or group? Performer mode is per-identity: a group admin can turn it on for the group in the group's own settings. Once it's on, the request form lets you pick who to **Send as**.

Want people to book **you**? Two options, and they stack:

- **Contact details** — add a booking section with your email, phone, or a booking link to your public page in the page editor. Visitors see a **Booking** button at the top of your profile that jumps straight to it.
- **Booking requests to your act** — in the same Performer section, switch on **Open to booking requests**. Organizers on Ithas Fire then see a **Request to book** button on your public page and can send you a proper request — dates, an optional offer, sometimes a specific event. You'll be notified, and everything lands under **Requests to you** in [Settings → Booking requests](/account/settings/booking-requests), where you accept (creating a draft agreement to negotiate terms) or decline. The switch is off until you turn it on, and turning it off stops new requests without touching existing ones.

Requests sent to a **group** you manage don't come here — they wait in that group's admin area under **Bookings**, on the **To you as an act** tab, alongside the group's other booking work. The group's own **Performer** and **Booking defaults** switches stay in its settings.

:::tip
You don't have to set this up in advance. If you hit **Request to book** on a venue page without performer mode on, you'll see a one-click **Turn on performer mode** button right there in the form.
:::

## Send a request to a venue

The **Request to book** button appears on the public pages of venues that are verified and currently accepting booking requests — near the top of the page and in the action bar that follows you as you scroll. If a venue hasn't opted in, you won't see it.

1. Open the venue's public page and click **Request to book** — at the top of the page or in the action bar. (Signed out? You'll be sent through sign-in and back.)
2. If you manage groups with performer mode on, choose who to **Send as**.
3. Write your **Message** — introduce yourself and your act (at least 10 characters).
4. Pick 1–3 **Preferred dates**. Dates must be today or later.
5. Optionally add your **Expected draw** (how many people you expect to bring), a **Genre**, and up to 3 **Links** — full URLs starting with `http(s)://`.
6. Click **Send request**.

You'll see a confirmation that the request was sent, and the venue will review it.

You can have **one open request per venue** at a time. Trying to send another while one is still open shows "You already have an open request with this venue."

## Request through a venue's own website

Some venues put a **Request to book** button on their own websites. It opens the same kind of booking form, and you don't need an Ithas Fire account to use it — just your name, email, act or band name, 1–3 preferred dates, and a pitch, with optional details like genre, expected draw, and links. A short verification check runs before **Send request**, and the venue replies to the email address you gave. As on the platform, you can have one open request per venue at a time.

If you've booked with Ithas Fire before, click **Log in** next to "Booked with Ithas Fire before?" — a popup signs you in (if you're already signed in on ithasfire.com, it completes without re-entering anything) and the form switches to your account: pick who to **Submit as** (yourself or a group you manage) and your saved booking defaults are prefilled. Requests sent this way behave exactly like requests sent from the venue's Ithas Fire page, including tracking below.

:::tip
If your browser blocks the sign-in popup, allow popups for the venue's site and click **Log in** again — or just use the guest form; you can attach your account later if the venue accepts.
:::

## Claim a booking you requested without an account

If you sent a request through a venue's website without logging in and the venue accepts it, you'll get an email inviting you to finalise the booking. The link takes you to a claim page on Ithas Fire:

1. **Sign in** — or create an account if you don't have one yet.
2. If performer mode isn't on, turn it on with the one-click **Enable performer mode** button.
3. Choose who you're **claiming as** — yourself, or a group you manage. The draft agreement is created under that name.
4. Click **Claim booking**.

That's the moment the **draft agreement** between you and the venue is created — **Open the agreement** to negotiate the terms (see **Accepted? Open the agreement** below), and the request appears among your sent booking requests.

The claim link is **single-use** and expires **30 days** after it's sent. If it has expired, or you see "This link is no longer active" (it was already used, or a newer invite email replaced it), ask the venue to resend the invite — they can do that from their booking inbox, and you'll get a fresh link by email.

## Track, withdraw, and statuses

Everything you've sent lives under [Settings → Booking requests](/account/settings/booking-requests), newest first. Requests sent on behalf of a group are labelled **Sent as {group name}**.

| Status        | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| **Pending**   | Sent, but the venue hasn't opened it yet                |
| **Viewed**    | The venue has opened your request                       |
| **Accepted**  | The venue accepted your request                         |
| **Declined**  | The venue passed on this request                        |
| **Withdrawn** | You withdrew the request                                |
| **Expired**   | The venue didn't respond within 14 days                 |

Open requests (Pending or Viewed) show a **Withdraw** button. Withdrawing closes the request — and since the one-open-request limit only counts open requests, you're then free to send a fresh one if your availability changes.

## Talk to the venue, and follow the booking

Every request you send is also a message thread. **Conversation** on the row opens it, and it stays open at every status — a declined or expired request is still somewhere to ask what happened with that Friday. Messages cap at 4,000 characters. The thread doesn't refresh on its own; **Refresh conversation** (the ⟳ button in the heading) pulls in anything new.

A **2 unread** badge sits on the row, just before that button, whenever the venue has written something you haven't read. Opening the request clears it.

Between the messages you'll find the booking's timeline — quiet lines Ithas Fire writes itself each time the booking moves. Your request being sent, opened by the venue, accepted or declined with their reason, or expiring. Then the agreement: drafted, sent for review, accepted, declined, cancelled by the venue with their reason, pulled back to edit, reopened, finalised. Then the event: created, with the date it's for, and every later change to its title, start or end time, location, calendar, space, or time zone — a change of date spelled out as a move.

Agreement lines carry a **View agreement** link. Event lines don't carry a link to the event: it lives in the venue's admin area, which you have no access to, so you see what changed and when without a link that would only bounce you.

:::tip
Timeline lines never count as unread. The badge means the venue has actually written to you, not that the booking's paperwork moved.
:::

:::warning
Requests expire automatically **14 days** after you send them if the venue doesn't respond. An expired request can't be reopened, but you can send a new one.
:::

## Being on hold

A venue that's interested but not ready to commit can put a **hold** on a date for you. You'll hear about it — in-app, by email and by push — with the venue, the date and your place in line: **First in line**, or **2nd in line**, **3rd**, and so on. The position is the whole of what you're told about the line. You never see who else is in it, and they never see you; if the venue moves you up, you hear the new position and nothing more.

A hold is not a booking. Nothing is agreed until the venue confirms it, and they can release it, in which case you're told and your request stays open. If the venue confirms a different date for you instead, any holds you had on other dates are released along with it.

Sometimes another act wants the night you're first in line for. The venue then asks you to **keep or release** the hold by a deadline — 24 hours is usual, and the venue can give you longer. Keep means you're taking the date; release means you're stepping aside and the next act moves up. While your reply clock runs, the venue can't give the date to another act. If you don't answer by the deadline, the hold lapses on its own and the line moves up without you; your request is still open either way. If you're second in line when the first hold is challenged, you're told when you'll hear, and then whether the first hold stood or the date moved to you.

When the venue confirms your hold, the date is booked: a draft event is created and the venue finishes the details with you through the agreement and the conversation. If the date goes to another act, you're told the hold was released — without being told to whom — and you can propose another date in the thread. The venue can also simply put a show on the date: if they publish an event there that didn't come from your request, your hold is released, you're told the venue scheduled an event on that date, and your request stays open.

## Accepted? Open the agreement

When a venue accepts, the request shows a **View agreement** button — acceptance creates a **draft agreement** between you and the venue. The venue or organizer sets the terms: title, proposed dates, an optional guarantee, notes, and **payout lines** (your share of the takings). When they use **Send for review**, you accept or decline with a reason — there's no counter on the agreement itself; if something needs to change, say so in the conversation and they pull it back to keep editing. The venue can also cancel the agreement outright, at any point before an event is finalised onto it; you'll see their reason in the conversation, and a cancelled agreement stays cancelled. Once the agreement is accepted its payout terms are finalised onto the event — that's what settlement pays out against.

If you're the payee on a line, you don't have to take it as written. Alongside **Confirm your line** you can **Counter** — enter a **Proposed share %** and a short **Note** (shared with the agreement parties), then **Send counter** — or **Decline** the line. A counter is an ask, not an edit: the parties see it on the line and can apply it from the draft editor. The agreement can't be finalised onto an event while any line is countered or declined, so an accepted agreement may go back to draft (**Reopen draft**) to renegotiate — editing your line's terms restarts your confirmation.

## What can go wrong

- **"This venue isn't accepting booking requests right now."** — the venue switched off requests after you opened the page. Try again later or contact them another way.
- **"You already have an open request with this venue."** — withdraw your existing request first if you want to send a different pitch.
- **"You don't have permission to send as this performer."** — only group admins can send requests on a group's behalf.
- **"This link has expired."** on the claim page — claim links last 30 days. Ask the venue to resend the invite from their booking inbox.
- **"This link is no longer active."** — the claim link was already used, or a newer invite email replaced it. Check your inbox for the latest link; if the claim already went through, the booking is under your sent requests.

To learn what venues see on their side, read [receive booking requests from performers](/help/organising-events/booking-requests).

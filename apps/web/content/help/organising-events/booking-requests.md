---
title: "Receive booking requests from performers"
description: "Open your verified venue to performer pitches and manage them from the Bookings inbox."
category: "organising-events"
order: 9
tags: ["bookings", "venue", "performers", "organiser"]
related:
  [
    "account/performer-mode-and-booking-requests",
    "organising-events/embed-widgets",
    "organising-events/spaces-and-calendars",
    "organising-events/create-an-event",
  ]
specs:
  [
    "2026-06-05/completed/booking-request-and-agreement-editor",
    "2026-07-13/booking-request-embed-button",
    "2026-07-14/booking-conversation-and-event-step",
    "2026-08-04/completed/booking-inbox-placement",
    "2026-08-18/venue-hierarchy-and-holds",
    "2026-08-25/booking-holds",
  ]
---

Verified venues can let performers pitch themselves directly from the venue's public page — or from a **Request to book** button on your own website. Requests land in a **Bookings** inbox in your venue's admin area, where you accept or decline them.

## Before you start

Your venue must be **verified**. Until it is, the booking toggle is disabled with "Verify your venue to accept booking requests."

The quickest way to ask is from the venue itself: open the venue's **Details** page and click **Request Verification** next to **Save changes**. A dialog opens where you attach your documents and submit. You can also start it from **Places** — open the **⋯** menu on the venue's row and choose **Request verification**. Both go to the same place, as does the venue's **Verification** page in the sidebar's **Venue** group, which is also where you track progress afterwards. Full walkthrough: [claim and verify your venue](/help/organising-events/claim-your-venue).

## Enable booking requests

1. In your dashboard, open the venue's page settings.
2. Switch on **Accept booking requests** — "Let performers send you booking requests from your venue page."

That's all it takes. While your venue is verified **and** accepting requests, a **Request to book** button appears on your public venue page automatically — near the top of the page and in the action bar that follows visitors as they scroll. You don't need to add anything to the page yourself. Switching **Accept booking requests** off removes the button immediately.

You can also collect requests from your own website: the **Booking button for your website** section, directly beneath the **Accept booking requests** switch, gives you a snippet to paste on your site. Setup is covered in [embed your events on your own site](/help/organising-events/embed-widgets).

## The Bookings inbox

Open your venue from **Places** in the admin sidebar, then choose **Bookings** (in the venue's **Operate** group) to see **Booking requests** — performers who want to play at your venue. Five views filter the list by where each booking is, each carrying its own count:

- **Open** — requests still waiting on you (Pending or Viewed)
- **Holds** — accepted requests you're holding a date for, and haven't confirmed yet (see **Holds** below)
- **Agreement** — the ones you said yes to, with an agreement in progress and no event yet
- **Event** — bookings that have become an event; the **Stage** column says whether it's a draft, published, cancelled or completed
- **Closed** — declined, withdrawn and expired requests, and agreements that ended before an event came of them, once no hold is live

Each row shows who it's **From** (solo performer or group), their **Preferred dates**, the booking's **Stage** (request → agreement → event), an **Agreement** shortcut once there is one, and when it was **Received**. Click a row to expand the full message, the genre and expected draw, and any links the performer attached.

The inbox opens on the first view that has something in it and stays there while you work — answering the last open request won't move you.

Opening a new request marks it **Viewed** — the performer sees that status change, so an untouched inbox is visible to them too.

You're notified whenever a new request arrives — in-app, by email, and by push notification, following your notification preferences. This covers every request, whether it was sent from your venue's Ithas Fire page or from the booking button on your own website.

Running more than one venue? You don't have to open each inbox in turn. **Bookings** in your group's own sidebar (not the venue's) carries every venue's requests in one list, answerable in place — see **Book an act yourself** below.

## Talk it through: the conversation

Every request is also a message thread. Expand a request and you'll find **Conversation** between the pitch and the Accept / Decline buttons — this is where the date actually gets agreed, before you commit to anything.

- **Both sides write.** You and the performer post into the same thread. Your messages are highlighted; theirs aren't, and each one is stamped with who wrote it and when.
- **Unread is visible without opening anything.** A request with messages you haven't read carries a **2 unread** badge on its inbox row, beside the status. Scan the list and you can see which conversations are waiting on you. The same count also appears next to **Conversation** once the request is expanded. Opening the request marks those messages read and both badges clear — so an untouched thread stays visibly untouched, the same way an unopened request stays **Pending**. Only messages a person wrote are counted; the timeline lines described below never are.
- **You're notified per message.** A new message reaches the other side in-app, by email, and by push, following their notification preferences. On the venue side, everyone with edit access to the venue is notified — not view-only members, who can still read the thread whenever they open the inbox.
- **Refresh, don't wait.** The thread doesn't poll in the background. **Refresh conversation** (the ⟳ button in the heading) pulls in anything new — useful if you've left the inbox open all afternoon.
- **Messages cap at 4,000 characters**, and you can send up to 30 an hour. Both are per person, not per thread.

The performer sees the same thread from their side. If they have an Ithas Fire account, it's in their account settings under **Booking requests** → **Requests you sent**, behind a **Conversation** button on the row. Their rows carry the same **unread** badge, sitting just before that button — so your reply shows up on their list without them opening anything either.

:::warning
An anonymous request sent through your website's booking button has no conversation — the sender has no Ithas Fire account for the other end of the thread to belong to. Reply to the **Contact email** on the request instead, or accept it so they're invited to claim an account. Once they claim, the thread works normally.
:::

A declined, withdrawn, or expired request keeps its conversation open. The status settles the booking, not the talking: you can still ask what happened with that Friday, or pick the date back up months later, and so can the performer. Nothing is deleted, and the whole exchange stays on the request as its history.

### The booking's timeline

The conversation is also the booking's record. Between the messages, Ithas Fire writes a quiet line of its own every time the booking moves — no border, no bubble, just an icon, a short sentence and the date. Read a thread top to bottom and you have the whole history: the pitch, the haggling, the agreement, the show.

What gets written:

- **The request** — sent (and whether it came through your website's booking button), viewed, accepted, declined with the reason you gave, withdrawn by the performer, or expired with the deadline it missed.
- **The agreement** — draft created, sent for review, accepted, declined with a reason, cancelled with a reason, pulled back to edit, reopened, and finalised.
- **The event** — created, with the date it was created for. After that, every save that moves something the other side cares about: **title**, **start time**, **end time**, **location**, **calendar**, **space**, or **time zone**. A change of date is spelled out as a move, from the old time to the new one. A save that touches nothing on that list writes nothing.

Where the platform knows which side acted, the line says so — **by the venue** or **by the performer**. It never names a person.

Agreement lines carry a **View agreement** link, and event lines carry a **View event** link straight into that event's editor.

:::tip
These lines never count as unread. Your inbox badge only ever means a person is waiting on you, so a busy negotiation won't light up your inbox with its own paperwork.
:::

They do count as activity, though. An event that came from a booking shows a **From a booking** note in its editor with a **Last activity** date, and that date follows the timeline as well as the messages — so it moves when the agreement is accepted or the event is edited, not only when somebody writes.

The same note summarises the deal for anyone editing the event: the agreed date, the guarantee, and how many payout lines are listed on the terms, with the agreement's status beside it. **View agreement** opens the agreement in your Bookings area; **Open booking thread** takes you back to the request, on whichever view it sits in now, with the conversation open. Nothing about the deal is edited from the event; change terms in the agreement itself.

The performer sees the same timeline, with one difference: no **View event** link. The event lives in your admin area, which they have no access to, so their side of the thread shows the line without the link rather than one that would bounce them.

### Attachments

If a request carries files — a rider, a stage plot, tech specs — they're listed under **Attachments** at the bottom of the conversation, with each file's name and size. A request with no files doesn't show the section at all.

Attachments are **read-only** today: you can see what's on a request, but neither side can upload from this screen yet. Keep sending files by email or as links in the pitch until uploading arrives.

## Accept or decline

Expanded open requests show two buttons:

- **Accept** — after a confirmation, this creates a **draft agreement** with the performer.
- **Decline** — you must give a **Reason** (at least 3 characters), which is shared with the performer.

Accepting moves the request to **Agreement** and opens its detail for you, so it doesn't disappear the moment you say yes.

There are three ways into the agreement that accepting just created, and they all land in the same editor. It opens inside your Bookings area, under the same admin menu, with a **Back to booking** link at the top that returns you to the request it came from:

- The success message that appears has an **Open agreement** action on it for a few seconds.
- The row itself carries a document icon in the **Agreement** column — reachable without expanding anything.
- The expanded request shows the full **Open agreement** button beside "Accepted — a draft agreement was created."

## Create the event from the conversation

Once both sides have accepted the agreement's terms, the conversation offers the next step itself: a **Next step** box sits directly under **Terms on file**, above the message box, with **Create event from this booking**. It creates a draft event at your venue, on the agreed date, with the act on the bill, and links the agreement to it — you stay in the conversation. A line confirms what happened (**Event created and agreement finalized**, or that the event exists but payouts still need confirming), with **Open event** taking you into the event editor. The booking moves to the **Event** view, the timeline gains an **Event created** line, and from then on the same spot in the conversation shows **Open event** instead.

You only see the box once the agreement is accepted and you're on the venue side of it; while terms are still being negotiated, **Change terms** on the strip above is the way forward.

:::warning
Requests expire **14 days** after they're sent — each open request shows its expiry date when expanded. Once a request is declined, withdrawn, or expired it can't be reopened, so respond to pitches you're interested in before the clock runs out. The conversation stays open either way.
:::

## Holds

A hold keeps an act's place in line for a date without committing either side to it. You place one on a request for a particular day at your venue; if another act is after the same night, they queue behind — **1st hold**, **2nd hold**, **3rd hold**. Nothing is booked until you **Confirm** a hold, and nothing about a hold reaches your public calendar or your embedded widgets: visitors see events only, so a pencilled night still looks free to them until a show goes on it.

### Place a hold and manage the line

Expand a request and the **Holds** strip sits directly under the stage rail. **Place hold** opens a short form: pick one of the act's preferred dates or **Another date…**, the **Calendar** (only shown when the venue has more than one), and a **Space** if you want to pin the hold to a room — **Any space** is the default. The hold joins the end of the line for that calendar and date, a toast tells you where it landed, and the act is told the same thing: "You're first in line", "You're 2nd in line".

Each live hold is a row — "13 Oct · 2nd hold" — with arrows to move it up or down the line. Moving one renumbers the whole line, and every act whose position changed is told their new place (an act promoted to first gets an email). A request can hold several dates at once, each in its own line; the same request can't be in one date's line twice, and a date whose line already has a confirmed hold refuses new ones.

The strip appears on requests from acts with an Ithas Fire account, whether Pending, Viewed or Accepted. An anonymous website inquiry has no strip: a hold notifies the act, and there's no account to notify.

:::tip
The same rows appear on the venue's **Calendar** page, as a dashed **2 holds** cluster on the day — expand it for the ordered line, **1st · act name** downwards, with a clock icon on a hold that's under challenge. The day view opens expanded. The cluster is read-only and never counts as a conflict; the request itself lives in the inbox.
:::

### Challenge, keep or release

When a second act wants a night the first is holding, **Challenge** the hold at the front of the line — only the first position can be challenged, and only one challenge per line at a time. **Start the clock** sends the act a keep-or-release deadline: 24 hours from now by default, at least an hour, and editable before you start it. The row then carries a countdown (**3 hours left**, then minutes) and the exact **Reply by** time; the act behind them is told they'll hear by then; and the request's assignee (or whoever placed the hold) gets an in-app note. While that clock is running you can't confirm anyone else for the date — you can still confirm the challenged act, release the hold, or wait for the clock.

While the clock runs, **Extend** moves the deadline later — never earlier. Then one of three things happens:

- **The act keeps the hold.** The clock clears and the row goes back to a plain hold. You're told by email and in-app, and the act behind is told the first hold stands. Confirm it or release it.
- **The act releases it.** The line moves up, everyone who moved is told, and you're told they stepped aside.
- **Nobody answers in time.** The hold lapses on its own: the row reads **Lapsed** until the list refreshes, then it's gone, and the act, you and the line all hear. There's no background sweep — a lapsed hold is settled the next time anyone reads or changes that line, so a page left open can show it a little longer than it lived.

**Release** on any row is your own version of the same thing. After a confirmation, the act loses their place for that date, everyone behind moves up, and the act is told their request is still open.

### Confirm

**Confirm** on a hold is the moment the night is booked. After a confirmation, in one go:

- a draft event is created at your venue on that date, on the hold's calendar and space, with the act on the bill (the start time follows the calendar's default);
- the request is accepted if it was still open, the same way **Accept** would have done it;
- this request's holds on **other** dates are released — the act is told their booking was confirmed elsewhere;
- every **other** act's hold on that date is released — they're told the date went to another act, without a name, and that their request stays open.

Confirm is refused while another act's reply clock is running on that date; the act under challenge can still be confirmed.

The strip then shows **Hold confirmed — draft event created**, how many other holds were released, and **Open event** into the editor. The booking moves to the **Event** view. This can't be undone from the strip: a confirmed hold can't be released — cancel the event instead.

:::warning
Confirming releases every competing hold on that date, and those acts are notified immediately. If two of you confirm different holds on the same line at once, exactly one wins; the other sees that the date was already confirmed.
:::

### Holds and your calendar

Publishing an event on a held date takes the date. If the event came from one of the requests in line — the draft that **Confirm** created, or one you built from that request — that act's hold is confirmed, and the rest of the line is told the date went to an event. If it came from nowhere in the line, every hold on it is released and each act is told the venue scheduled an event on that date; their requests stay open. The same happens when you move an already-published event onto a held date.

Drafts don't touch holds, so you can build the event at leisure and the line stands until you publish. Holds follow a calendar, not the venue: an event with no calendar leaves every line alone, and an event on one calendar leaves the other calendars' lines alone. If an act's reply clock is running on that date, you can't publish over them — the builder tells you to wait for their answer or release the hold first. A released hold is gone for good: moving the event off the date afterwards doesn't put the line back.

### The Holds view

A request with a live hold that you've already accepted lands on **Holds**, so the dates you're actively juggling sit in one place. An unanswered request keeps to **Open** even with a hold on it — the **Open** count only ever means requests waiting on you — and when a request's last hold is released or confirmed, it goes back to **Agreement** or on to **Event**. A hold outlives a cancelled agreement: the request stays on **Holds** until you release it, and only then moves to **Closed**. The list row shows each live hold under the stage, "13 Oct · 2nd hold", with the countdown chip when a challenge is running.

### Assignee

On a venue owned by a group, the expanded request carries an **Assigned to** picker: any member who can edit the venue (owner, admin or editor), or **Assign to me**. The assignee is who hold notifications go to first, and their name shows in the inbox row. Someone who has since left the group shows as **Former member** until you reassign. Above the views, an **Assignee** filter (**Everyone**, **Unassigned**, or a member) narrows the same list the counts describe.

### Tags

Beside the assignee, **Tags** are your group's private labels for filing requests — acts never see them. Type into the box to pick an existing tag, or create one on the spot with **Create "name"** (Enter on plain text does the same). A **Tags** filter above the views narrows the list; that one only picks from tags that already exist.

Rename, recolour, reorder and delete tags from the group's **Settings**, under **Getting booked → Booking tags**. Deleting a tag removes it from every request it's on; the requests themselves are untouched.

## Requests from your own website

Requests sent through your website's booking button work a little differently, because the sender may not have an Ithas Fire account:

- The row shows the sender's name with a **Via your website** label instead of a performer profile — there are no performer badges or verified stats to show.
- The expanded request includes a **Contact email** you can click to reply directly — these senders aren't on Ithas Fire yet, so email is your reply channel.
- Accepting works through an invite instead of an immediate agreement. The confirmation button reads **Accept & send invite**: the sender gets an email link to set up their account and finalize the booking. Until they do, the request shows **Invite sent** — the draft agreement is created once they claim.
- Each invite link is single-use and expires after 30 days. If the sender loses it or it expires, use **Resend invite** on the accepted request — resends issue a fresh link and are rate-limited, so you may occasionally see "Try again later — invite resends are limited."

Performers who log in from the booking button before submitting appear in your inbox as normal performer requests — accepting those creates the draft agreement straight away, as described above.

## Negotiate the agreement

Accepting a request starts a negotiation, not a finished deal:

1. **Draft** — you set the terms: title, proposed dates, an optional **Guarantee**, notes, and **payout lines** (who gets what share when the event settles). The act can read the draft but doesn't edit it; if they want something changed, they say so in the conversation.
2. **Send for review** — when the terms look right, send the agreement to the act. Under review, the act can **Accept** or **Decline** (with a reason shared with you). You can **Pull back to edit** at any point to return it to draft. There's no counter-offer step: if the act declines, adjust the terms and send again. If the booking is off altogether, **Cancel agreement** ends it for good: you give a reason, the act reads it in the conversation, and the agreement can't be reopened. It's available on a draft, under review, or accepted, right up until an event is finalised onto it.
3. **Confirm payout lines** — any third-party payees on the deal (a sound engineer with a cut, say) respond to their own line individually: **Confirm your line**, **Counter** (propose a different share with a note explaining the ask), or **Decline**. A counter doesn't change the line by itself — it's an ask, visible to everyone on the agreement. While the agreement is a draft you can adopt it with **Apply counter** in the line editor, or edit the line's terms, which restarts that payee's confirmation.
4. **Finalize onto event** — once accepted, the finalize dialog offers two paths: **Create event from this booking** creates a draft event prefilled with your venue, the agreed date, and the performer on the bill, ready to finish in the event editor; or pick one of your existing events to link instead. Either way, the agreement's payout terms are stamped onto the event, so settlement pays out per the agreed lines. If payout lines still need confirmation, creating the event shows **"Event created — finalize when payouts are confirmed"** — the draft exists and can be edited, and once every line is confirmed, either path finalizes the agreement onto it. A countered or declined line **blocks finalizing** until it's resolved — use **Reopen draft** on the accepted agreement to adjust the terms (it then has to be sent for review and accepted again).

## Statuses

| Status        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| **Pending**   | Received, not opened yet                                  |
| **Viewed**    | You've opened the request                                 |
| **Accepted**  | You accepted — a draft agreement was created (the booking then sits under **Agreement**, or **Event** once one exists) |
| **Declined**  | You declined, with a reason shared with the performer     |
| **Withdrawn** | The performer withdrew the request                        |
| **Expired**   | No response within 14 days                                |

## What can go wrong

- **"This request was already handled or expired."** — the request changed state while you had it open (the performer withdrew it, a colleague responded, or it expired). The inbox refreshes to the current state.
- **Empty inbox?** Performers can only send requests once your venue is verified and **Accept booking requests** is on.
- **An accepted website inquiry never turns into an agreement.** The sender hasn't claimed their invite yet. **Resend invite** for a fresh link, or reply via the visible contact email to coordinate directly.
- **"That hold changed under you. The list has been refreshed."** — a colleague or the act moved the line while you had it open (a release, a keep, a lapse). Look at the refreshed row and act again.
- **"There's an open challenge on this date."** — Confirm is refused while another act's reply clock is running on that date. Confirm the challenged act, release the hold, or wait for the clock to end.
- **"There's an open challenge on this date in that calendar."** — the same rule, met from the event builder: you tried to publish an event (or move a published one) onto a date where an act's reply clock is running. The event stays a draft; wait for the answer or release the hold, then publish.
- **The Challenge button isn't there.** Only the hold in first position can be challenged, and only while no other challenge is open on that line. Move the hold up first, or wait for the running clock to end.
- **"The deadline must be at least an hour from now."** — the reply-by time on a challenge or extension can't be sooner than that, and an extension can't be earlier than the current deadline.

## Book an act yourself

Booking flows the other way too. When a performer has switched on **Open to booking requests**, their public page shows a **Request to book** button — use it to send your group's pitch: a message, one to three preferred dates, an optional offer (guarantee, door split, or negotiable), and optionally one of your group's events the booking is for. The act accepts or declines; an accepted request creates a draft agreement between your group and the act, negotiated in the same agreement editor as venue bookings.

Everything booking-related for your group lives under **Bookings** (in the **Programming** section of the admin sidebar), on three tabs:

- **To your venues** — performers asking to play at a venue your group owns, across every venue at once.
- **To you as an act** — organizers asking your group to play, as an act. Open a request to see the pitch and the offer; accept to create a draft agreement, or decline. A reason is optional here, and it's shared with the organizer if you add one.
- **Sent to acts** — the acts you've contacted. Withdraw an open request, or jump to the agreement once one accepts.

The page opens on whichever tab has something waiting, and stays there while you work — answering the last open request won't move you. A group that owns no venues doesn't get the first tab at all. When anything is waiting on you, **Bookings** carries a count in the sidebar, and so do the tabs.

Underneath the tabs sits **Performer settings**, a shortcut to the switches that decide whether your group can be booked as an act at all.

### Every venue's requests in one list

**To your venues** is one list covering every venue your group owns, and you can read the pitch, reply in the conversation, accept and decline from it without opening a venue first. Every row names the venue it was sent to, so you always know which door a request is knocking on.

Two controls narrow it:

- **Venue** — a dropdown starting on **All venues**, with each venue's open count beside its name. Picking one narrows the same list in place. Beside it, **Open inbox** jumps to that venue's own Bookings page, which is still where invite resends and venue-specific settings live. A group with a single venue sees that venue's name and the shortcut, with no dropdown to choose from.
- **Open**, **Holds**, **Agreement**, **Event**, **Closed** — the same five views as a venue's own inbox, each carrying the count of what it holds. The counts follow the venue you've picked, so **Open (3)** always means three rows in the list below it.

Accepting switches you to **Agreement** with the request open, so it doesn't vanish the moment you say yes. Everything else works the same as a venue's own inbox, including creating the event from the conversation.

:::warning
If your group owns more venues than one list can cover, a line under the venue picker says so. Those venues' requests aren't here at all — reach them from **Places** instead. The warning stays put even when the venue picker itself fails to load, which is exactly when a short list would otherwise read as "nothing more to answer".
:::

### Venues you own yourself

A venue you hold in your own name, rather than through a group, shows up the same way on your personal admin's **Bookings** page: one list of requests to every venue you own, with the same **Venue** picker and the same five views (**Open**, **Holds**, **Agreement**, **Event**, **Closed**), answerable in place. Holds work here too; the assignee and tag controls don't, since a venue held in your own name has no team to assign to. Only the venue side lives here — requests to you as a performer, and the ones you've sent, stay in your account settings under **Booking requests**, and a link beneath the list takes you there. If you own no venues, that page simply points you to account settings. When a venue request is waiting on you, **Bookings** carries a count in your personal sidebar too.

> Requests sent to your group as an act used to live in **Settings → Getting booked → Booking requests**. They're on the **To you as an act** tab now — the old link still works and brings you here. Settings keeps the switches (**Performer** and **Booking defaults**); the day-to-day queue lives with the rest of your bookings.

Curious what the performer's side looks like? See [performer mode and booking requests](/help/account/performer-mode-and-booking-requests).

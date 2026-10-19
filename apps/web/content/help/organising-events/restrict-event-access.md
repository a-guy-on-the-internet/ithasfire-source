---
title: "Restrict who can see and attend your event"
description: "Gate an event behind a password or an application, invite people past the gate with a link, and control who can find it."
category: "organising-events"
order: 6
tags: ["access", "password", "application", "invite", "private", "organiser"]
specs: ["2026-10-02/completed/gated-event-invite-links"]
related:
  [
    "organising-events/create-an-event",
    "organising-events/hidden-places-and-address-reveal",
    "buying-tickets/how-to-buy",
    "organising-events/when-invites-are-paused",
  ]
---

Some events aren't meant for everyone with the link. The event builder gives you two independent controls for this: **Visibility** decides who can find the event, and the **Access Gate** decides who can open its full page and buy tickets. They stack — a private event can also sit behind a password, for example.

## Before you start

Visibility and the access gate are different levers:

- **Visibility** — **Public** means anyone with the link can see the event; **Private** means only people with a direct link can reach it. Private keeps an event out of casual discovery, but the link itself is still all someone needs.
- **Access Gate** — a password or an application that a visitor must clear before the full event page unlocks. This is what actually stops link-holders from getting in.

Use the access gate when the link alone shouldn't be enough.

## Password-protect an event

1. In the event builder, open **Settings**, expand the **Access & privacy** group, and find the **Access Gate** section.
2. Choose the password gate and click **Set Password**.
3. Enter a password and save.

Visitors now see a locked page with only the event's title, image and date, and a prompt to enter the password. The location stays hidden until the page is unlocked. A correct password unlocks the full page and keeps that device unlocked for about 24 hours, so they don't have to re-enter it if they come back the same day.

After three wrong passwords from the same connection within 15 minutes, a visitor has to complete a quick security check before they can try again. If the event as a whole attracts a lot of wrong guesses, everyone gets the check for a while, including visitors who haven't mistyped anything.

:::tip
Share the password through the same channel you trust to share the link — a group chat, a newsletter, a DM. Anyone who has both the link and the password can get in, so treat it like a shared key. To let specific people in without sharing the password, send them [an invite](#invite-people-with-a-link) instead.
:::

To change it later, open the **Access Gate** section again and set a new password; to remove the gate entirely, remove the password.

## Gate an event behind an application

An application gate collects answers from would-be attendees and lets you decide on each one before they can buy.

1. In the **Access Gate** section, choose the application gate.
2. Click **Edit application form** to write your questions — or **Start from a template** to begin with a ready-made set (see [Application form templates](#application-form-templates) below).
3. As applications come in, click **Review applications** to open the queue.
4. Approve, waitlist, or decline each application. Approved applicants get an email with a link that opens the event.

Anyone can apply — an account isn't required. Signed-out applicants give an email address. Their approval email carries a link that opens the event page on the device they click it from for 24 hours, and clicking it again renews that for 7 days after the approval. To buy tickets they sign in with the same (verified) email they applied with; the application then attaches to their account, shows up in their status, and keeps the event open for them on any device.

### Writing questions

Each question is short text, long text, a single choice, or multiple choices, and you mark each one required or optional. Choice questions get their own list of options.

### Application form templates

Templates save you from rebuilding the same form each time.

- **Start from a template** when you turn on the application gate. You'll see a platform starter set — performer application, vendor or market stall, house-show RSVP, workshop, press accreditation, guest list — alongside anything the event's owner has saved: the organisation's library on an organisation's event, or the owner's own on a personal event (delegates working on it see the owner's library, not their own).
- **Save as template** from the form builder header, to reuse this event's questions later.
- Manage your organisation's library from **Application form templates** in the admin sidebar, under Programming.

Applying a template **copies** its questions onto this event. Editing the template afterwards never changes events you already created, and editing an event's questions never changes the template. You can't apply a template once applications have started arriving — that would move the questions out from under answers people already gave.

### Set an application window, a cap, or instant approval

In the same **Access Gate** section:

- **Application window** — optional open and close dates. Before it opens, visitors see when applications open; after it closes, they see that applications are closed.
- **Application limit** — stop accepting once you've received that many. Withdrawn and expired applications don't count toward the limit.
- **Approve automatically** — approve and unlock every applicant the moment they apply. Use this when you want the questions but not the gatekeeping ("registration with questions"). The approval email sends immediately.

### Deciding on applications

From the queue you can **approve**, **waitlist**, or **decline** each application.

- **Approve** unlocks the event for that person and emails them.
- **Waitlist** puts them on the event's waitlist so they're notified if space opens up.
- **Decline** emails them. You can add an optional reason; it's included in that email and shown to the applicant on the event page. Leave it blank for a plain decline.

You can rescind an approval, waitlist, or decline from the queue, which moves that application back to pending. Access follows the application's current standing — an approval is what lifts the gate for that person.

Rescinding an approval closes the event to that person straight away, on every device that opened it, and emails them that their application is back in review. Approving them again sends a fresh link; the old one stops working. Rescinding a waitlist or decline doesn't send an email.

### What applicants can do

Applicants answer your questions one at a time, and can jump back to any question from the **All questions** list before they send. Their contact details come last. After sending, they see their status on the event page as a short timeline: applied, in review, then your decision. While an application is still pending they can **withdraw** it, and if the application window is still open they can apply again afterwards. Applications left pending after the window closes are marked expired automatically about a week later.

## Invite people with a link

Once an event has a saved password or an application gate, the **Access Gate** section shows an **Invite link** panel and an **Invited guests** list. An invite lets someone past the gate without the password and without applying. Invites work only on a published event, and only while the event is still on.

### The shared link

Each gated event has one shared link that you can post or forward.

1. In the **Access Gate** section, click **Turn on invite link**.
2. Click **Copy link** and share it.

Anyone who opens the link skips the password. On an application event, they skip the application: opening the link counts as approval, so they bypass the questions and the queue. Access from the shared link lasts until the event ends, and the panel shows how many times the link has been used.

- **Reset link** makes a new link and stops the old one. It asks you to confirm first.
- **Turn off** stops the link without making a new one. Everyone who already got in keeps access.

When you click **Reset link**, you choose what happens to the people who already got in with the old link:

- **Keep people who already got in** is selected by default. They can still open the event; only the old link stops working.
- **Remove them too** takes access away from everyone who got in with an old link. The button changes to **Reset and remove**. Guests you invited by name keep their access, and anyone who already has a ticket keeps it.

Use **Remove them too** when the link has spread further than you meant it to. To take away one person's access, send them a personal invite and revoke it.

### Personal invites

Personal invites go to named guests, and we email each guest their own link.

1. In **Invited guests**, enter the guest's **Name** and **Email**, then click **Send invite**.
2. To invite many people at once, open **Invite a contact list**, choose a list under **Contact list**, and click **Send invites**. Unsubscribed contacts are skipped, and so are contacts with no email address and people who've asked not to get invites from you. After the send, a summary shows how many were sent, already invited, skipped or failed.

You need a verified email address to send invites. If the email for one guest doesn't send, the invite is still saved; use **Resend** on that guest to try again. After an invite is sent, **Resend** waits about 10 minutes before it will send the same invite again. You can also copy a guest's link from their row and send it yourself.

### How many invites you can send

Each organiser has a daily invite limit, shared by everyone who sends invites for it. The limit counts the people you've invited in the last 24 hours:

- A new organiser can send 50 invites a day.
- Once at least 10 people with paid tickets have been scanned in at your events, or you've received a payout, the limit goes up to 1,000 a day.
- If your own account is less than a week old, you can send 10 invites a day, whichever organiser you send for.

Everyone you try to invite counts, including people who have stopped your invites or unsubscribed from your announcements: they don't get an email, but they still use up one invite. Someone who already has an invite to the event costs nothing, unless you send it again with **Resend**.

If a contact list needs more invites than you have left, the panel tells you how many people on the list count toward your limit and how many more invites you can send, and nothing is sent. People who already have an invite, contacts who unsubscribed from that list and contacts without an email address don't count, and an address that appears twice counts once. Send to a smaller list, or try again later.

If people mark your invites as spam, we pause your invite emails until our team has looked. See [when your invite emails are paused](/help/organising-events/when-invites-are-paused).

### Guests who don't want invites

Every invite email ends with a **Stop invites from** link naming you. A guest who follows it confirms on a short page, and after that you can't send them invites from any of your events. Usually that only affects you: other organisers can still invite them, and invites they already have keep working. From the same page a guest can also stop invites from every organiser, which blocks you too.

If you try to invite someone who has stopped your invites, the panel says "This person has asked not to get invites from you, so the invite wasn’t sent." If they already have an invite to this event, the panel says they already have one instead. There's no way to override this from your side; the guest can contact us to turn your invites back on.

Each guest shows a status: **Sent**, **Used**, **Revoked** or **Unsent**. To remove a guest's access, click **Revoke**, then **Revoke invite** to confirm. Their link stops working and they lose access to the event. To let a revoked guest back in, click **Invite again**.

On an application event, a personal invite counts as approval in the same way as the shared link. Guests who come in through an invite don't count toward your **Application limit**, so invites never use up places meant for applicants.

:::warning
A personal link is not tied to the guest's email address. Anyone the guest forwards it to can open the event with it until you revoke it. If a link has spread, revoke it and invite the guest again to send them a fresh one.
:::

### What your guests see

A guest who opens an invite link lands on a page with the event's title and date and a single button, **Open the event**. They tap it and they're in; no password is needed. A personal link works on any device until the event is over.

If the link no longer works, the guest sees a notice above the normal gate: "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or enter the password." On an application event, the last words read "or apply." A link stops working when you revoke it, reset it or turn it off, when the event has ended or been cancelled, and when you remove the gate.

If you reset the shared link with **Remove them too**, people who got in with the old link see the normal gate again the next time they open the event, with this line above it: "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or enter the password." On an application event, the last words read "or apply." Entering the password, or being approved, lets them back in as usual.

## Where a gated event shows up

A password or application gate covers the event's location along with the rest of its page. Until someone unlocks the page:

- Public event lists, embeds and search results show only the event's area (its city, or the area name you gave an obscured location). There's no street address and no map pin.
- The event doesn't appear on the map, and **Surprise me** never picks it.
- There's no public calendar download for the event on its own, so its time and place can't be pulled into a calendar app from outside the page.

Once a visitor unlocks the page, they see the location as they would on any ungated event, including an [obscured area and its reveal time](/help/organising-events/hidden-places-and-address-reveal) if you set one.

## What can go wrong

- **Choosing the password gate but never setting a password** leaves the event effectively ungated — the builder won't apply a password gate until a password is saved. Finish the **Set Password** step.
- **Expecting a private event to be secret.** Private only removes the event from discovery; the direct link still works for anyone who has it. If the link might spread, add an access gate as well.
- **Turning on "Approve automatically" and still waiting to review.** Auto-approval unlocks everyone instantly; the queue becomes a record, not a decision point.
- **Trying to apply a template to an event that already has applications.** Once answers exist, the questions are locked to protect them. Start from a template before you open applications.
- **Closing the window and expecting the queue to clear itself.** Closing stops new applications; the ones already pending still need a decision from you.
- **Sending invites before the event is published.** The panel shows "Publish the event before sending invites." Publish the event first, then invite.
- **Sending invites after the event has ended.** The panel shows "This event has ended." Invites can't be sent for an event that has finished or been cancelled.
- **Resetting the shared link and expecting everyone to lose access.** **Reset link** keeps people who already got in unless you choose **Remove them too** in the confirmation. **Turn off** never removes anyone.
- **Hitting the daily invite limit.** The panel shows "This organiser has used all 50 invites for today." (or 1,000), followed by the rule for raising it. Teammates sending invites for the same organiser draw from the same limit.
- **Inviting a contact list of more than 500 people.** The panel shows "This list has more than 500 people. Lists that size can’t be invited from here yet."
- **An approval link gets forwarded.** Anyone holding the link can open the event page while the approval stands, but only the applicant can buy tickets. If a link has spread, rescind the approval — that closes the page on every device — and approve again to send the applicant a fresh link.

:::warning
The access gate controls who can open the page and buy — it is not a substitute for checking people in at the door. Use [check-in scanning](/help/organising-events/check-in-scanning) to verify who actually attends.
:::

## Related

Pair this with [obscured locations and address reveal](/help/organising-events/hidden-places-and-address-reveal) when you also need to keep the place address private until closer to the event. New to the builder? Start with [create an event](/help/organising-events/create-an-event).

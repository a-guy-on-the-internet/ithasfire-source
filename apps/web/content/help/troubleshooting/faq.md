---
title: "Frequently asked questions"
description: "Quick answers to the questions support hears most often."
category: "troubleshooting"
order: 2
tags: ["faq", "support", "questions"]
related: ["troubleshooting/payment-issues", "buying-tickets/manage-your-orders"]
---

If your question isn't answered here, email [support@ithasfire.com](mailto:support@ithasfire.com). We reply within one business day.

## Buyers

### I didn't receive my confirmation email

1. Check your spam / promotions folder.
2. Sign in and open [/my-tickets](/my-tickets) — your tickets are always there, even if email delivery failed.
3. From the order detail page, click **Resend confirmation**.
4. Still nothing? The email on file might be wrong — contact support with your order ID.

### Can I change the name on a ticket?

Most events don't check names at the door — the QR code is what matters. If the organiser does check names (common for 18+ events), contact them via the event page's **Contact organiser** link.

If you want the ticket to belong to someone else entirely, use [**Transfer**](/help/buying-tickets/manage-your-orders) instead.

### How do I save an event for later?

Tap the **heart** on any event card, or the **Save** button on the event page. Everything you save lives at [/saved](/saved), split into Upcoming and Past, and it's completely private — no one can see your list. Full details in [Saving events](/help/account/saving-events).

### The event I want is sold out

Options:

- **Follow the event** — you'll be notified if more tickets are released
- **Waiting list** — if the organiser has enabled one, you can join
- **Resale marketplace** — not currently available on Ithas Fire

:::warning
Never buy tickets from third-party resellers outside Ithas Fire. QR codes only scan once, and scammers regularly sell screenshots of already-used tickets. If someone you trust can't use their ticket, ask them to use the in-app **Transfer** action — it's the only verified way to hand a ticket over.
:::

### Can I add more tickets to an existing order?

No — each purchase is its own order. Just buy a second order for the extra tickets.

### I paid twice by accident

Open [/my-tickets](/my-tickets). If both purchases show up as successful orders, email support with both order IDs and we'll refund the duplicate.

### Why is there a security check before payment?

When you buy through a ticket widget embedded on an organiser's own website, checkout can include an automatic Cloudflare security check above the payment button. It usually verifies you in the background without any interaction; occasionally it asks you to complete a short challenge. If the form says **Complete the verification to continue**, finish the check first — the order won't submit without it.

### The ticket widget says it isn't available on this domain

Ticket widgets only work on the website their organiser registered. If you see _"This widget isn't available on this domain"_, the page embedding the widget isn't the organiser's registered site — buy from the event's page on Ithas Fire or from the organiser's official website instead. If you **are** the organiser, check your [embed settings](/help/organising-events/embed-widgets).

### How do I follow a venue or organiser?

Open any venue, artist, or organiser page and click **Follow**. You'll get notifications when they publish new events. Tune channels and the distance filter under [Settings → Notifications](/account/settings/notifications). See [following organisers and venues](/help/account/following-organisers-and-venues).

### What is the resale marketplace?

Resale is not currently available on Ithas Fire. When it returns, organisers can allow attendees to list their tickets for sale and others to buy them — fully tracked through Ithas Fire so there are no invalid screenshots at the door. In the meantime, use [**Transfer**](/help/buying-tickets/manage-your-orders) to pass a ticket on. See [resale marketplace](/help/buying-tickets/resale-marketplace).

### Why does an event hide its address?

For house shows and private events, organisers can obscure the location — you see a fuzzed circle on the map (or just an area name) plus a notice saying when the exact address unlocks. Ticket holders get the full address at the reveal time (typically 24 hours before start) by in-app notification and email; buy later than that and it's in your confirmation email directly. See [where is this event?](/help/buying-tickets/where-is-this-event).

### I have a ticket — when do I get the address?

If the event obscures its location, the exact address unlocks at the reveal time shown on the event page. You'll get an in-app notification and an email with the address and directions; buying after the reveal puts the address straight in your confirmation email. See [where is this event?](/help/buying-tickets/where-is-this-event).

### How do I volunteer at an event?

If an event is recruiting, a **Volunteer** button appears on its page. Pick a role or shift, apply as a guest or signed in, and you're either confirmed instantly, queued for review, or waitlisted if the shift is full. See [volunteer at an event](/help/getting-started/volunteer-at-an-event).

### Someone asked me to coordinate a volunteer group — what can I do?

An organiser can hand you one group to run without giving you admin access. From the console link in your invite email you review, check in, and pull helpers into **your** group, and broadcast to it — but nothing outside it. See [coordinate a volunteer group](/help/getting-started/coordinate-a-volunteer-group).

### My QR code is rejected at the door

It usually means one of: (a) someone scanned it before you, (b) you transferred the ticket (the original code is invalidated), or (c) you're at the wrong event. Contact the organiser via the event page's **Contact organiser** link.

---

## Account

### How do I change my password?

Open [Settings → Security](/account/settings/security) and click **Change password**. If you signed up with Google or Apple and never set a password, use [forgot password](/forgot-password) to set one.

### Can I sign in with multiple providers?

Setting a password on a Google or Apple account lets you sign in either way. Linking a second OAuth provider (Google + Apple on the same account) isn't supported yet.

### Can I be both a buyer and an organiser?

Yes — one account does both. You become an organiser once you connect [Stripe Connect](/help/organising-events/payouts-and-settlements) and publish an event.

### How do I delete my account?

Open [Settings → Delete account](/account/settings/danger), click **Delete account**, then confirm with your password.

:::warning
Deleting your account does not automatically cancel upcoming tickets or pending organiser payouts. Resolve those first, or contact support.
:::

### How do I get booked to play at a venue?

Turn on **Performer mode** under [Settings → Performer](/account/settings/performer), then click **Request to book** — at the top of the page or in the action bar — on any verified venue that accepts booking requests. Track or withdraw sent requests under [Settings → Booking requests](/account/settings/booking-requests). See [performer mode and booking requests](/help/account/performer-mode-and-booking-requests).

### A venue accepted my booking and emailed me a claim link — what is it?

You requested the booking through the venue's own website without logging in. The link signs you in (or creates your account), lets you choose who you're performing as, and creates the draft agreement with the venue. It's single-use and lasts 30 days — the venue can resend it if it expires. See [performer mode and booking requests](/help/account/performer-mode-and-booking-requests).

### I applied to an event — can I change or withdraw my application?

While your application is still pending you can withdraw it from the event page. If the organiser's application window is still open, you're free to apply again afterwards. Once the organiser has decided, withdrawing is no longer available — contact them directly if something has changed. You don't need an account to apply: signed-out applicants get their decision by email, and the approval email carries the link that unlocks the event.

### How do I control which notifications I get — and can I get texts?

Open [Settings → Notifications](/account/settings/notifications). Each category (order confirmations, event announcements, promotions, organiser updates) has per-channel switches for in-app, email, push, and SMS. SMS is off by default and unlocks after you verify a phone number under [Settings → Security](/account/settings/security). See [notification settings](/help/account/notification-settings).

### Can I download a list of all my past orders?

Not yet — on the roadmap. For now, open each order from [/my-tickets](/my-tickets) and download its receipt individually.

### Can I move the floating action bar, or use it from the keyboard?

Yes to both, on a desktop browser. Drag it by the flame square at its left end and it snaps to one of seven resting places — five along the bottom, plus the two top corners — and stays there next time. Each button in the bar also answers to a number key, running left to right from **1**; hover a button to see its number. See [the action bar](/help/getting-started/the-action-bar).

---

## Organisers

### Can I edit an event after publishing?

Most fields, yes. Constraints:

- Capacity can only go **up**, never below the number already sold
- Reducing a ticket price triggers partial refunds for buyers who paid more
- Changing date or venue notifies all buyers automatically

### Can people download the audio I add to my event?

Only if you let them. Audio clips in your event description are stream-only by default. Turn on **Allow download** on the clip in the builder's **Details** section to add a **Download audio** button on the event page. It's a per-clip setting — see [add audio to your event description](/help/organising-events/add-audio-to-your-event).

### How do I issue a refund to a specific buyer?

Refunds are buyer-initiated through [/my-tickets](/my-tickets). If a buyer needs a refund but the eligibility check blocks them (event already started, payout complete, etc.), email support — we can often intervene.

### When will I get paid?

Depends on the payout schedule you picked. See the table in [payouts and settlements](/help/organising-events/payouts-and-settlements). The earliest option, `ASAP`, transfers funds about 2 days after each sale.

### Why isn't the cash I took at the door in my payout?

It never will be — you already have that money. Payouts only move funds Stripe collected, and cash handed over at your own door was never Stripe's to move. The same applies to comps, which are recorded at $0.

To see what the door took in cash, open **Sell** under **Door & crew** and expand **Cash taken tonight**. See [sell tickets at the door](/help/organising-events/selling-at-the-door).

### My event isn't showing up in search

Three common reasons:

- Event is still in `DRAFT` status — publish it
- Start time has passed — `COMPLETED` events are filtered out of search by default
- You set location visibility to **Obscured** — map and location searches use the fuzzed public point inside your circle, not the real address; with the map fully hidden the event has no map point at all, so it only surfaces through text search and direct links

### How do I take ownership of my venue's page?

If your venue already has a page but you don't control it, open that page and use **Claim this venue**. Prove you operate it with an account email at the venue's domain, an emailed code, or an uploaded document; most claims are then reviewed by our team before the venue verifies. Track the status in your account settings under **Venue claims**. If the venue already has a verified owner, you'll see an **Owned by … · Request transfer** row naming that owner instead. See [claim your venue](/help/organising-events/claim-your-venue).

### How do performers send my venue booking requests?

Verify your venue (open its **Verification** page from the admin sidebar — it sits in the **Venue** group) and switch on **Accept booking requests** in the venue's page settings — a **Request to book** button then appears on your venue page automatically. Requests arrive in the venue's **Bookings** inbox and expire after 14 days if you don't respond. See [receive booking requests from performers](/help/organising-events/booking-requests).

### Can bands request to book through my own website?

Yes — the **Booking button for your website** section in your venue's page settings (beneath the **Accept booking requests** switch) gives you a paste-in snippet for a **Request to book** button. Bands don't need an Ithas Fire account to send a request, and you're notified of every new one. See [embed your events on your own site](/help/organising-events/embed-widgets).

### How do I recruit volunteers for my event?

Open your event's **Volunteers** page (under **Manage** in the event side rail), switch on **Accept volunteers**, then add roles and shifts. Review applications, check volunteers in, and export hours from the same page. See [recruit and manage volunteers](/help/organising-events/manage-volunteers).

### Where did the Ithas Fire volunteer role go?

Somebody clicked **Customise** on it. That makes a copy owned by your organisation, and the copy replaces the original in your **Volunteer Roles** list so you only ever see one row per role — edit that copy. Archiving the copy brings the Ithas Fire original back. See [recruit and manage volunteers](/help/organising-events/manage-volunteers).

### Can I recruit volunteers that aren't tied to one event?

Yes. Post a **volunteer ask** for your organisation, a place you manage, or yourself — it gets a public sign-up link, and you can organise responders into groups and hand each group to a coordinator. See [recruit standing volunteers](/help/organising-events/recruit-standing-volunteers).

### Can I give volunteers a free ticket?

Attach a **comp reward** to an event's volunteering: a free ticket issued automatically when a volunteer is approved or checked in, with an optional budget cap and an audit ledger. Configuring rewards needs a finance role. See [comp rewards for volunteers](/help/organising-events/volunteer-comp-rewards).

### Can I run a private / invite-only event?

Yes. Set the event's **Visibility** to **Private** so only people with the direct link can reach it, and add an **Access gate** — a password or an application to approve — when the link alone shouldn't be enough to get in. See [restrict who can see and attend your event](/help/organising-events/restrict-event-access). To also keep the venue secret, set location visibility to **Obscured** with the map fully hidden, which keeps it off public maps and location-based search (it can still be found by title) and reveals the exact address only to ticket holders — see [obscured locations](/help/organising-events/hidden-venues-and-address-reveal).

### Can I take a discount code at the door?

Yes — the same promo codes you use online work on in-person sales. Enter the code on the **Sell** tab of the scanner app before taking payment, and the discount comes off the total whether the buyer pays by card or cash. Note that "one per person" limits don't restrict anything at the door, because walk-up buyers are anonymous; use a total redemption limit instead. See [apply a discount at the door](/help/organising-events/discounts-at-the-door).

---
title: "Embed your events on your own site"
description: "Drop-in iframe widgets for event lists, one place calendar, event detail pages, checkout, and a booking button."
category: "organising-events"
order: 8
tags:
  [
    "embed",
    "widgets",
    "iframe",
    "integration",
    "website",
    "booking",
    "scope",
    "calendar",
  ]
related:
  [
    "organising-events/create-an-event",
    "organising-events/spaces-and-calendars",
    "organising-events/booking-requests",
    "troubleshooting/faq",
  ]
specs: ["2026-03-06/completed/embeddable-event-widgets",
    "2026-07-13/completed/booking-request-embed-button",
    "2026-08-04/embed-unified-views",
    "2026-08-18/completed/venue-hierarchy-and-holds", "2026-09-02/completed/event-calendar-redesign"]
---

Ithas Fire widgets let you sell tickets directly from your own website. Buyers never have to leave your page — the entire flow, from browsing to payment confirmation, lives in an embedded iframe.

## Widgets available

| Widget             | What it shows                                                       |
| ------------------ | ------------------------------------------------------------------- |
| **Event list**     | Upcoming events for your org or place, as cards                     |
| **Event calendar** | The same events as a month or week calendar                         |
| **Place calendar** | One named calendar's published events — "just the Social Club programming" |
| **Event detail**   | One event with ticket picker, quantities, and prices                |
| **Checkout**       | Two-step guest checkout (details → payment) + confirmation          |
| **Booking button** | A **Request to book** button that opens a booking form (places) |
| **Memberships**    | Your published membership tiers, with a **Join** button          |

The list and calendar are two **views of one embed**, not two embeds: you set up your events widget once, choose which view it opens on, and optionally let visitors switch between them. The list and detail views transition into checkout automatically — one iframe, full flow — and so does the calendar, from any event that's still on sale.

On a narrow phone the calendar drops the grid and shows the month as a row of dates with a dot under each day that has something on, then lists that day's events when a visitor taps it. Nothing is lost, and the widget never pushes your page sideways.

**Place calendar** is a different thing from **Event calendar**, and the word "calendar" doing two jobs is worth ten seconds of your attention. **Event calendar** is a calendar *view* of whichever events you already chose, opening on the month grid with a week grid a click away. **Place calendar** is a *subject* — you point the widget at one of your place's named calendars, and it shows that stream and nothing else. See **Embedding one named calendar** below.

The booking button is a different widget with its own tab. It can be set up from either the embeds page or the place's own **Bookings** page — both manage the same thing, so use whichever you're already in front of.

The memberships widget also has its own tab, and needs no picker — it always shows the published tiers belonging to whoever's admin area you're in. See **Memberships widget** below.

## Getting your embed code

Go to **/admin/{your-slug}/embeds**. The page has three tabs, **Events**, **Booking button** and **Memberships**, and each one walks you through the same four numbered steps from top to bottom. A step you can't do yet is greyed out and says what it's waiting for.

1. **What it shows.** On the **Events** tab, choose what you're embedding:
   - **Your own name, or your organisation**: your upcoming events, as a list or a calendar.
   - **Calendar**: one place calendar's published events. Pick the place, then the calendar. See **Embedding one named calendar** below.
   - **Event**: tickets for one event. Pick it from the dropdown. Only **published** events are listed, because a draft can't be embedded.

   Unless you picked a single **Event**, also choose a **Default view** (**List** or **Calendar**) and whether to tick **Let visitors switch views** (see **List or calendar** below). For your own or your organisation's events, choose which events the widget shows (see **Choosing which events appear** below). For a **Request to book** button, use the **Booking button** tab instead (see **Booking button for places** below).
2. **Your website.** Enter the address of the site that will show the widget (for example `example.com`) and press **Add**. The page confirms that the site can show the widget. Then answer **Is it light or dark?** so the widget is readable on your page (see **Light, Dark or Custom** below).
3. **How it looks on your site.** The preview shows the widget on a page like yours, in the colours you chose. Pick **Inline** to put the widget in the page, or **Button** for a button that opens it, and try the widths your page uses.
4. **Copy it onto your site.** Press **Copy code** and paste the code where the widget should appear. **Setup Guides** below the code has step-by-step instructions for WordPress, Squarespace, Wix and Shopify. Here you can also choose whether checkout opens inside the widget or in a new tab on Ithas Fire.

Steps 3 and 4 open once you've added your site's address, because the preview and the code both belong to that address. Choosing **Inline** or **Button** in step 3 also picks the matching code format in step 4 (**HTML** or **Modal**), so what you copy is what the preview showed.

## List or calendar

**Default view** decides what visitors see when the widget loads:

| Default view | What loads                                                       |
| ------------ | ----------------------------------------------------------------- |
| **List**     | Upcoming events as cards — the original events widget.           |
| **Calendar** | A month calendar of the same events.                             |

Both views use the same embed, the same domains, and the same in-iframe checkout. Changing the setting saves straight away (you'll see **Embed updated**) and applies to every domain you've added for that subject.

Tick **Let visitors switch views** to add a **List / Calendar** switcher to the widget itself. Visitors flip between the two without the page reloading, and the switcher disappears once they open an event or start checking out. It's off by default.

The **Default view** control and the switcher appear for your own or your organisation's events, and for a **Calendar** subject. A single-event embed has one event, so it has nothing to lay out on a calendar.

:::tip
**Default view** is stored on the embed, not baked into your snippet — as long as the snippet you pasted doesn't name a view, switching from List to Calendar in admin changes what your site shows on the next page load, with no re-paste. The snippet only pins a view when you copy it while **Calendar** is selected (it then carries `?view=calendar`).
:::

## Embedding one named calendar

If your place runs more than one programming stream — a Social Club night and a live-music series sharing the same floor — you can embed **just one of them**. Set your streams up first in [spaces and calendars](/help/organising-events/spaces-and-calendars); every place has at least one calendar, so there's always something to pick.

1. Go to **/admin/{your-slug}/embeds**, stay on the **Events** tab, and set the subject control to **Calendar**.
2. Pick the place from **Select a place**. Its calendars appear underneath, under a **{Place} · Calendars** heading, each showing how many spaces it schedules into and which one is the **Default**.
3. Click the calendar you want.
4. Choose a **Default view** (List or Calendar) as you would for any events widget, add your domain, and copy the snippet.

The widget then shows that calendar's **published** events and nothing else — not the place's other calendars, and not events in a space the two calendars share. That last part is the point of the feature: two streams can book the same space without their public listings bleeding into each other.

The place picker lists places your org controls, and you need edit access on the place itself to set up or revoke one of its calendar embeds.

### What a calendar embed does differently

**Clicks always open the event on Ithas Fire, in a new tab.** There is no in-iframe ticket picker or checkout on a calendar embed, in either view, whatever your link-mode setting says. The events on a place's calendar can belong to any promoter who booked in — they aren't necessarily yours to sell — so the widget sends every visitor to the event's own page rather than opening a checkout it may not be entitled to run.

Two more differences worth knowing:

- **No scope control.** **My events / At my places / Everything** is for your own or your organisation's events. A calendar embed is already scoped: it's that calendar.
- **Nothing internal ships to the page.** Conflict warnings, opening hours, blackout dates, and private closure notes are admin-only and never appear in a calendar embed's payload. The same goes for draft, private, and unlisted events.

:::tip
Running a room and want the full what's-on including other promoters' shows? That's the **At my places** scope on an ordinary events widget, not a calendar embed. Use a calendar embed when you want one *stream*; use **At my places** when you want one *room's* whole diary.
:::

## Choosing which events appear

When you embed your own or your organisation's events, you also choose the scope:

| Scope                     | What the widget shows                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **My events** _(default)_ | Only events you created.                                                                 |
| **At my places**          | Published events at places you own — including events other organisers booked into your room. |
| **Everything**            | Both of the above, with duplicates removed.                                              |

**At my places** is the one to reach for if you run a room. Your website's "what's on" list then keeps itself current as promoters book in, without you re-entering anything.

:::tip
Scope is part of the snippet, not a setting saved on the domain — so one site can run two differently-scoped widgets on two different pages. Copy a snippet per scope.
:::

Scope applies to your own or your organisation's events in both views. A single-event or booking-button embed ignores it.

Every scope shows **published** events only, and **At my places** shows only **public** ones — a private or unlisted event booked into your room never appears in your widget.

### Events behind a password or an application

A password-protected or application-only event still appears in your widget. Nobody can buy it inside the widget.

- **In list view**, its card is marked **Password** or **By application** and keeps its starting price, as on Ithas Fire. Opening it shows the title, the date and the image, with one button: **Enter the password on Ithas Fire** or **Apply on Ithas Fire**. The button opens the event on Ithas Fire in a new tab, where the visitor enters the password or applies. The opened event shows no description, ticket list or place.
- **In calendar view**, and in any widget set to open checkout on Ithas Fire, clicking the event opens its page on Ithas Fire in a new tab straight away.

Someone you've already approved still buys on Ithas Fire, not in the widget. The widget can't tell who is visiting, so it never treats a typed email address as proof that its owner was approved.

## Embed snippet

Standard paste:

```html
<iframe
  src="https://ithasfire.com/embed/{embedId}"
  width="100%"
  height="600"
  style="border:none; overflow:hidden;"
  loading="lazy"
  referrerpolicy="strict-origin"
  allow="payment"
  title="Events"
></iframe>
<script src="https://ithasfire.com/embed/hf-resize.js" async></script>
```

The resize script is optional but recommended — it listens for the iframe's `postMessage` events and resizes the frame to fit its content so you don't see scroll bars or empty space. It covers every embed URL, including calendar ones.

That snippet names no view, so it follows the embed's **Default view**. Copy it with **Calendar** selected and the URL gains `?view=calendar`, pinning the calendar no matter what the default later becomes; the copied `height` also starts at the taller month-grid value.

Already embedded with an older copy of this snippet? Add `referrerpolicy="strict-origin"` to your existing `<iframe>` — the widget uses it to verify your site against the domain you registered, and without it some browsers (notably Firefox on sites with a restrictive site-wide `Referrer-Policy`) can't identify your domain and the widget won't load.

## Theming with query params

Out of the box the widget uses the Ithas Fire theme and has **no background of its own**: it's transparent, so your page shows through behind it. Whenever we update the Ithas Fire colours, an embed that doesn't override them updates too, with nothing for you to change. The widget always uses the light version of the theme, even for a visitor who switched Ithas Fire to dark mode.

To match your site instead, append six-digit hex codes (no `#`). A three-digit shorthand such as `FFF` is ignored, and that part of the widget keeps the Ithas Fire colour:

```
?brandColor=1D4ED8&fontColor=FFFFFF
```

Scope rides on the same query string — `?scope=venues` or `?scope=all`. Leaving it off means **My events**. The view does too — `?view=calendar` or `?view=list` — and leaving it off means "use the embed's **Default view**". The admin **Copy** button already includes both when you've picked something other than the default, so you rarely need to add them by hand. An unrecognised value (say `?view=map`) is ignored rather than breaking the widget.

| Param         | What it styles                                                                                        | If you leave it off                  |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `brandColor`  | Primary buttons (Continue, Pay), the price tags on event cards, the **Join** buttons on membership tiers | The Ithas Fire button colour         |
| `bg`          | The widget's background, plus its form fields, panels and sticky bars                                 | Transparent: your page shows through |
| `fontColor`   | Text, the form fields and panels it sits on, and link colours                                          | The Ithas Fire text colour           |
| `accentColor` | Section labels, back arrows, secondary buttons, and the highlight on a selected ticket or date        | Your **Text** colour if you set one; otherwise the Ithas Fire theme's structural colour (dark, like the text) |

### Light, Dark or Custom

You rarely need to pick colours yourself. In step 2, **Your website**, answer **Is it light or dark?** and the admin writes the colours into your code:

| Answer     | What it writes                  | What the widget does                                                                                                               | Preview page          |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Light**  | Nothing                         | Uses the Ithas Fire theme with no background, so your page shows through.                                                          | White                 |
| **Dark**   | `fontColor=FDFAF3` (light text) | Light text, dark form fields and panels, and links lightened until they're readable on a dark page. Your page still shows through. | Near-black            |
| **Custom** | Whatever you set                | Uses your own **Brand**, **Background**, **Text** and **Accent** colours.                                                        | The colour you choose |

**Light** and **Dark** set as little as they can, so the rest of the widget keeps following the Ithas Fire theme when we update it.

The four swatches, **Brand**, **Background**, **Text** and **Accent**, sit under the answer and always show the colours the widget is using. Change any of them and the answer switches to **Custom** by itself; choose **Light** or **Dark** again and your changes are replaced with that answer's colours. **Background** starts as **Transparent**: click **Set colour** to give the widget a background, and **Clear** to make it transparent again. A colour you leave at its default isn't written into the snippet, so that part of the widget keeps following the Ithas Fire theme.

Under **Custom** you also get **Preview background**, for checking the widget against your own page colour: a checkerboard, white, light grey, navy, or **Your page colour**. It only changes the preview and is never added to the snippet.

The admin doesn't save your answer or your colours: they live in the snippet you copy. Each time you open the page it starts at **Light**, so pick again before you copy a fresh snippet.

You don't have to pick label colours. Text on a `brandColor` or `accentColor` fill is set to dark or white automatically, whichever is readable, and a button's label stays readable on hover too.

:::tip
**Dark website?** Choose **Dark**. The widget gets light text, and its form fields and panels switch to a dark fill so the text stays readable, while the rest of the widget sits directly on your page. If you want a particular light colour, choose **Custom** and set **Text** yourself (for example `fontColor=FFFFFF`); fields, panels and links adjust to it in the same way. Without a light **Text**, the widget's default dark text disappears against a dark page. The same goes for a dark **Background**: on its own it leaves the default dark text on it, which can't be read, so set a light **Text** with it.
:::

## Advanced: the JavaScript SDK

If you need runtime control (opening in a modal, passing a promo code, subscribing to events), use the SDK instead of a raw iframe:

```html
<script>
  window.HF = window.HF || {
    _q: [],
    createWidget: function (o) {
      this._q.push(["createWidget", o]);
    },
  };
</script>
<script src="https://ithasfire.com/embed/hf-embed.js" async></script>
<div id="events"></div>
<script>
  HF.createWidget({
    embedId: "your-embed-id",
    container: "#events",
    scope: "venues", // omit for "own"; see Choosing which events appear
    view: "calendar", // omit to follow the embed's Default view
    mode: "inline", // or "modal"
    height: "auto", // or a number in pixels
    theme: { brandColor: "1D4ED8" }, // same keys as the query params
    promoCode: "EARLY10", // auto-applies at checkout
    onReady: () => console.log("widget loaded"),
    onNavigate: (route) => console.log("moved to", route),
    onOrderComplete: (order) => console.log("ticket sold", order.id),
  });
</script>
```

| Option        | Values                          | Notes                                                              |
| ------------- | ------------------------------- | ------------------------------------------------------------------ |
| `embedId`     | your embed ID                   | Required.                                                          |
| `container`   | CSS selector or element         | Required. Where the widget mounts.                                 |
| `widget`      | `tickets` (default), `booking`  | `booking` renders the **Request to book** form.                    |
| `scope`       | `own` (default), `venues`, `all`| Which events an own/organisation events widget shows. Ignored by every other subject, including a calendar. |
| `view`        | `list`, `calendar`              | Which view the widget opens on. Works for own/organisation and calendar subjects; omit to follow the embed's **Default view**. Ignored by the booking form. |
| `mode`        | `inline` (default), `modal`     | `modal` renders a trigger button instead.                          |
| `triggerText` | any string                      | Relabels the modal trigger.                                        |
| `height`      | `auto` (default) or a number    | `inline` only.                                                     |
| `promoCode`   | a promo code                    | Auto-applies at checkout.                                          |

:::warning
Keep that first `window.HF = ...` block. It queues your `createWidget` call until the async script finishes loading. Without it, a small page can run your call before the SDK exists and you'll get **"HF is not defined"** with no widget. (An older version of this article used a `DOMContentLoaded` listener here — that's the exact race the queue replaced, so update any snippet still doing that.)
:::

`view` works in both `inline` and `modal` mode, so a **View calendar** button that opens the month calendar in an overlay is one option away (set `triggerText` to relabel the button — the admin **Modal** snippet already does this for you when Calendar is selected). Snippets you pasted before this option existed don't set `view`, and behave exactly as they always have.

`onOrderComplete` is the hook most sites want — fire a thank-you modal, bump an analytics counter, or redirect to a custom success page. It fires once per order, and only after Ithas Fire has answered for that order: straight away for a free order, and for a paid one when the order is confirmed or its payment is still clearing with the buyer's bank. It does not fire while the widget is still asking, or if it could not get an answer.

## Booking button for places

Verified places that accept booking requests can put a **Request to book** button on their own website. Visitors click it, a booking form opens in a modal, and the request lands in your place's Bookings inbox — the visitor doesn't need an Ithas Fire account.

There are two doors onto the same thing — use whichever you're already in front of:

- **From the embeds page** — open the **Booking button** tab and pick the place from the dropdown.
- **From the place** — open the place's **Bookings** page and find **Booking button for your website**, directly beneath the **Accept booking requests** switch.

Either way:

1. Enter your website's domain (e.g. `example.com`) and add it.
2. Copy the snippet and paste it into your site where the button should appear.
3. The live preview shows the **Request to book** button your visitors see — click it to open the booking form, or use **Open form** to open it in a new tab.

The snippet uses the SDK in modal mode:

```html
<script>
  window.HF = window.HF || {
    _q: [],
    createWidget: function (o) {
      this._q.push(["createWidget", o]);
    },
  };
</script>
<script src="https://ithasfire.com/embed/hf-embed.js" async></script>
<div id="hf-book-your-embed-id"></div>
<script>
  HF.createWidget({
    embedId: "your-embed-id",
    container: "#hf-book-your-embed-id",
    widget: "booking",
    mode: "modal",
    triggerText: "Request to book",
  });
</script>
```

Change `triggerText` to relabel the button; the `theme` option and the theming query params work here the same as for the other widgets. A booking button ignores `scope` — it's tied to the one place.

The same domain enforcement applies as for ticket widgets: the form only works on domains you've added, submissions from anywhere else are refused outright, and **Revoke** disables the button on that domain. Add each domain that will host the button.

### What visitors see

The form asks for their name, email, act or band name, 1–3 preferred dates, and a pitch, with optional extras (expected draw, genre, lineup size, set length, tech needs, fee ask, links) under **More details**. A short Cloudflare verification runs before **Send request**. Each email address can have one open request per place at a time.

Performers who already use Ithas Fire can click **Log in** next to "Booked with Ithas Fire before?" — a popup signs them in (without re-entering credentials if they're already signed in on ithasfire.com), and the form switches to their account: they pick who to submit as and their saved booking defaults are prefilled.

If your place isn't verified yet, or **Accept booking requests** is switched off, the button still renders but shows a calm "Not taking booking requests right now" message instead of the form — the section on the place's Bookings page reminds you of this while the toggle is off.

For what happens after a request arrives — replying by email, accepting, and the invite the submitter receives — see [receive booking requests from performers](/help/organising-events/booking-requests).

## Memberships widget

If you offer [memberships](/help/organising-events/memberships), you can put your tiers on your own site. The widget shows every **published** tier — name, description, price, and billing interval — each with a **Join** button.

1. Go to **/admin/{your-slug}/embeds** and open the **Memberships** tab.
2. Enter the domain that will host the widget (e.g. `example.com`) and add it.
3. Copy the snippet and paste it into your site.

There's no picker: the widget always shows your own published tiers. Draft and archived tiers never appear, so a tier goes live on your site the moment you publish it and disappears when you archive it.

**Join opens your Ithas Fire page in a new tab**, on the Membership tab, where the visitor signs in and enters their card. Joining doesn't happen inside the iframe — a membership needs a signed-in account and a saved card, and both belong on your page rather than in a frame on someone else's site. Members manage and cancel from their own account afterwards.

The same domain enforcement applies as everywhere else: the widget only loads on domains you've added, and **Revoke** disables it on that domain.

## Setup requirements

- **Domain added in admin** — widgets only load on domains you've registered under **/admin/{your-slug}/embeds** (a booking button's domains can be added there or on the place's Bookings page; it's the same list either way)
- **Content-Security-Policy** — if your site uses a strict CSP, allow `frame-src https://ithasfire.com`
- **`allow="payment"` on the iframe** — required for Apple Pay / Google Pay via the Payment Request API; the default snippet includes this

:::warning
Remove domains you no longer use — each added domain is a live embed surface. Revoking a domain via the admin UI invalidates every iframe that uses that embed ID.
:::

## What buyers see: reserved tickets

When a buyer clicks **Continue to payment**, the widget creates their order and reserves its tickets. They have 15 minutes to pay, counted down beside **Reserved for** in the order summary. The lines in italics below are the widget's own wording, so you can recognise one if a buyer quotes it to you.

- **Stepping back to the event** keeps the order open, so the tickets stay the buyer's while they look again. The widget shows _Your tickets are reserved for the next 9:30. If you change them, you start a new order and these go back on sale._ Continuing with the same tickets returns to the same order and its payment form. Under that line is **Let these tickets go**, which cancels the order and puts its tickets back on sale at once: _Your tickets are back on sale. You have not been charged._ If the widget could not do it, the order stays open and can still be paid, and the buyer sees _We couldn't let these tickets go just now. They are still reserved for you._ The button is not offered on an order whose payment may have gone through.
- **Changing the tickets** starts a new order: _You changed your tickets, so we'll start a new order. You have not been charged._ The widget cancels the first order then, and its tickets go back on sale at once: _The tickets from your earlier order are back on sale._ Opening another event, or another date of a series, releases the order the buyer left in the same way. If they continue to payment while that is still under way, the new order waits for it, for 10 seconds at most.
- **If the first order could not be released** (the buyer lost their connection, or a payment on that order was in progress or could not be confirmed) it stays open until Ithas Fire clears it, and its tickets stay reserved until then, so the buyer's own first choice can show as unavailable. The widget says so: _Tickets from your earlier order usually go back on sale by 8:20 PM and can stay reserved until 8:50 PM, so they may show as unavailable until then._ The two times are clock times on the buyer's own device: 50 and 80 minutes after the order was started (an order started at 7:30 PM gives 8:20 PM and 8:50 PM).
- **If creating the order takes too long** the widget stops waiting after 45 seconds and shows _This is taking longer than expected. Try again._ Trying again picks up the order the first attempt made, if it made one, as long as the tickets, the email and the promo codes were left alone in between. If the first attempt's answer arrives by itself, the widget moves on without another click: to the payment step, or to the confirmation for a free order. After a change to the tickets, the email or the promo codes, even one that is put back, the next attempt starts a new order, and an order the first attempt made is released when its answer arrives.
- **While a payment is processing** the back arrow is locked, with _Your payment is processing. You can go back when it finishes._ The arrow unlocks when the payment is declined, or after about a minute with no answer. The exception is a buyer whose bank is asking them to verify the payment: the arrow stays locked for as long as that verification is open.
- **When the payment goes through** the widget asks Ithas Fire to confirm the order before it shows a confirmation. Meanwhile the pay button reads _Confirming your order…_ and the back arrow stays locked, with _We are confirming your order. You can go back when it finishes._ The buyer sees **Order confirmed** only once the order is confirmed. That screen shows the order code and, under **Your tickets**, each ticket's QR code with its code as text, so a buyer can be scanned in at the door straight from your page. The email carries the same tickets, and it is the copy that lasts: the codes leave the screen when the buyer closes the confirmation, and they are not shown if Ithas Fire did not send them with its answer. Ithas Fire sends a ticket's code only for an order made through your widget, only to the browser tab that started the payment, only while the ticket is still the buyer's and unused, and for up to two hours after it was issued; after that the buyer uses the email. The address a payment page sends the buyer back to can end up in browser history or a log, and it can't be used to fetch the codes. If the payment is still clearing with their bank they see **Your bank is clearing this payment** instead: _We will email your tickets when it clears. You do not need to do anything else._
- **If the payment went through but the order could not be confirmed** (no answer within 20 seconds, twice, or the request failed) the widget shows _Your payment went through, but we could not confirm your order yet._ with _Check your email for your tickets. Do not pay again: a second checkout could charge you twice._, the line _If your tickets do not arrive, write to_ followed by the support address, and a **Check again** button. The button rests for five seconds after each check, and the widget says _Checking…_ while one is out and _We still could not confirm your order._ when it changes nothing. Nothing else can be bought in the widget from that screen. If the answer arrives late, the buyer is moved on to their confirmation without pressing anything. The order is usually confirmed a moment later and the tickets are usually emailed, so a buyer who quotes this line has paid: look for their order, and do not tell them to pay again. If your page is reloaded in the same tab within half an hour, the widget asks Ithas Fire again: the buyer sees **Payment received** with their ticket codes, or this screen again with **Check again**. After half an hour it comes back with a reminder above the tickets to check their email before buying again.
- **The same screen without Check again** means checking again cannot change the answer: the order can no longer be completed as it stands, or the page is not one this widget is allowed on. The support address comes first on that screen. The buyer has still paid, and their tickets can still arrive: look for their order, and do not tell them to pay again.
- **If Ithas Fire and Stripe disagree** (Stripe told the widget the payment went through and Ithas Fire answers that it was not paid) the widget does not tell the buyer they were not charged. They get the same _Your payment went through, but we could not confirm your order yet._ screen, with **Check again**.
- **When the payment is still clearing with the buyer's bank** and the order could not be confirmed, that screen reads _Your payment is with your bank, and we could not confirm your order yet._ with _We will email your tickets when your bank clears the payment. Do not pay again: a second checkout could charge you twice._ and _If your tickets have not arrived in a few days, write to_ the support address. No tickets have been sent yet; they follow once the bank clears the payment.
- **If the widget cannot tell whether a payment went through** (the connection dropped, or no answer came back) it shows _We could not confirm whether your payment went through. Check your email before trying again._ A buyer who quotes this line may have been charged: look for their order before you tell them to pay again.
- **When the 15 minutes run out** the payment form closes and the buyer sees _Your reservation ran out. Continue to reserve your tickets again; they may no longer be available._ Their name, email and billing details are kept. If the widget is still open, it releases the order then, so its tickets go back on sale, unless a payment on it could not be confirmed. If a payment could not be confirmed, on that order or on an earlier one in the same visit, the same notice adds the line about checking their email.
- **An earlier order in the same visit** whose payment was never settled is checked again when a later order completes (up to three earlier orders, one at a time). If that payment did go through, the widget says so above the confirmation: _Your payment for an earlier order went through. Check your email for its tickets._ A buyer who sees this has paid for two orders. If it was not charged the reminder goes away, and if nobody can say yet it stays: _We could not confirm whether your payment for an earlier order went through. Check your email before buying again._

:::tip
Seats that look taken and come back later with no sale are usually an order a buyer started and left. The widget releases such an order when the buyer changes their tickets, opens another event, runs out of time to pay, or presses **Let these tickets go**, and its seats return to sale at once. It cannot when the buyer closes the page or loses their connection, or while a payment on the order is in progress. That order is usually cleared between 20 and 50 minutes after it was started. If a clean-up run is late, it can keep its tickets, and count against the remaining capacity, for up to 80 minutes. Nothing needs releasing by hand.
:::

## What buyers see: security checks

Two protections run on the live widget. Neither needs any setup from you, but it helps to know what your buyers might encounter:

- **Automatic security check before payment.** When bot protection is switched on for the platform, guest checkout in your widget includes a Cloudflare security check just above the **Continue to payment** button. It usually verifies the buyer in the background with no interaction; occasionally it shows a short interactive challenge instead. Until it passes, the form shows _Complete the verification to continue_ and the order won't submit.
- **Domain enforcement.** The widget only works on the domain you registered for the embed (plus ithasfire.com itself, so the admin **Preview** keeps working). `www.` doesn't matter — registering `example.com` also covers `www.example.com`, and vice versa. On any other domain the widget refuses to load or take payment, and buyers see: _"This widget isn't available on this domain. If you're the organizer, check your embed settings."_

Together these are why your embed can't be lifted onto someone else's site: the domain allowlist blocks unauthorised pages outright, and the security check stops automated checkout on the pages that remain.

If a legitimate page of yours is being blocked, check that the domain saved on the embed (under **/admin/{your-slug}/embeds**) matches the site hosting the iframe, and that your `<iframe>` carries the `referrerpolicy="strict-origin"` attribute from the snippet above — without it some browsers can't prove your domain to the widget.

## Gotchas

- **The widget grows to fit its whole list** when the resize script is on your page, so a long list on a phone makes a tall frame rather than a short one with its own scroll bar. If your page cached the script before 12 October 2026, the frame may stop at 2000 px for up to a day.
- **Coming back from a payment page.** Now and then a payment needs approving on another page (a card check from the buyer's bank, for example). When a buyer comes back to the widget from such a page, it shows **Confirming your payment…** while it checks with Stripe and then asks Ithas Fire to confirm the order. Once the order is confirmed the buyer sees **Payment received**, the order code and _Your tickets are on their way to the email you used at checkout._ If they came back to the tab that started the payment, the screen also shows the **Your tickets** codes. If they came back anywhere else (a new tab the payment page opened, another browser or device, or the return address opened fresh), it shows no ticket codes, and the buyer uses the email. The admin **Preview** runs on Ithas Fire itself, so there a tab the payment page opens can still show the codes; on your own site it won't. While the payment is still clearing they see **Your bank is clearing this payment**. If Stripe says the payment went through but the order could not be confirmed, the buyer gets the same _Your payment went through, but we could not confirm your order yet._ screen as above, with **Check again**. If Stripe confirms it was declined or cancelled, the buyer can try again. If it can't confirm the payment either way, the widget asks the buyer to check their email before trying again. If your page is reloaded in the same tab within half an hour, the widget asks Ithas Fire again about a payment Stripe says went through, and the buyer sees **Payment received** or the same screen with **Check again**; for a payment nobody could check, it shows a reminder above the tickets instead. `onOrderComplete` doesn't fire on this path: coming back from the payment page the widget knows what was charged in total, not the ticket subtotal that `totalCents` carries.
- **Single-event embeds** skip the list entirely and drop buyers straight into the detail view with a ticket picker.
- **Calendar embeds never check out in the frame** — every click opens the event on Ithas Fire in a new tab, in list view and calendar view alike. See **Embedding one named calendar** above for why.
- **Past events on the calendar** stay visible for context but can't be bought — clicking one opens the event's page on Ithas Fire instead of checkout.
- **Older calendar snippets keep working.** The calendar used to have its own address, `/embed/calendar/{embedId}`, and anything you already pasted still renders the calendar exactly as before — that URL isn't going away. New snippets use the same address as the list with `?view=calendar` instead. Both forms take the same `?scope=` param, so `/embed/{embedId}?view=calendar&scope=venues` gives you a what's-on calendar for your room.

## Testing before you launch

Use the preview pane in the admin UI to iterate on theming and sizing without touching your site. When you're happy, copy the snippet.

Because the embedId is stable, settings stored **on the embed** — the link mode above, your **Default view**, and **Let visitors switch views** — take effect on the next page load without you touching your site's code. Settings that live **in the snippet** — `scope`, the theme colours, and a view you pinned with `?view=` — are baked into what you pasted, so changing those in the admin means copying the snippet again.

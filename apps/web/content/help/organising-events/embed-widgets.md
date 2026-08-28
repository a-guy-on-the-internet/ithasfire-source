---
title: "Embed your events on your own site"
description: "Drop-in iframe widgets for event lists, one venue calendar, event detail pages, checkout, and a booking button."
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
specs:
  [
    "2026-03-06/completed/embeddable-event-widgets",
    "2026-07-13/booking-request-embed-button",
    "2026-08-04/embed-unified-views",
    "2026-08-18/venue-hierarchy-and-holds",
  ]
---

Ithas Fire widgets let you sell tickets directly from your own website. Buyers never have to leave your page — the entire flow, from browsing to payment confirmation, lives in an embedded iframe.

## Widgets available

| Widget             | What it shows                                                       |
| ------------------ | ------------------------------------------------------------------- |
| **Event list**     | Upcoming events for your org or venue, as cards                     |
| **Event calendar** | The same events as a month calendar                                 |
| **Venue calendar** | One named calendar's published events — "just the Social Club programming" |
| **Event detail**   | One event with ticket picker, quantities, and prices                |
| **Checkout**       | Two-step guest checkout (details → payment) + confirmation          |
| **Booking button** | A **Request to book** button that opens a booking form (venues) |
| **Memberships**    | Your published membership tiers, with a **Join** button          |

The list and calendar are two **views of one embed**, not two embeds: you set up your events widget once, choose which view it opens on, and optionally let visitors switch between them. The list and detail views transition into checkout automatically — one iframe, full flow — and so does the calendar, from any event that's still on sale.

**Venue calendar** is a different thing from **Event calendar**, and the word "calendar" doing two jobs is worth ten seconds of your attention. **Event calendar** is a month-grid *view* of whichever events you already chose. **Venue calendar** is a *subject* — you point the widget at one of your venue's named calendars, and it shows that stream and nothing else. See **Embedding one named calendar** below.

The booking button is a different widget with its own tab. It can be set up from either the embeds page or the venue's own page settings — both manage the same thing, so use whichever you're already in front of.

The memberships widget also has its own tab, and needs no picker — it always shows the published tiers belonging to whoever's admin area you're in. See **Memberships widget** below.

## Getting your embed code

1. Go to **/admin/{your-slug}/embeds**. The page has two tabs: **Events** and **Booking button**.
2. On the **Events** tab, choose what you're embedding:
   - **Your own name, or your organisation** — your upcoming events, as a list or a calendar.
   - **Calendar** — one venue calendar's published events. Pick the venue, then the calendar. See **Embedding one named calendar** below.
   - **Event** — tickets for one event. Pick it from the dropdown; only **published** events are listed, because a draft can't be embedded.

   (For a **Request to book** button, switch to the **Booking button** tab — see **Booking button for venues** below.)
3. Unless you picked a single **Event**, choose a **Default view** — **List** or **Calendar** — and decide whether to tick **Let visitors switch views**. See **List or calendar** below.
4. Still for your own or your organisation's events, choose which events the widget shows — see **Choosing which events appear** below.
5. Enter the domain that will host the widget (e.g. `example.com`) and add it.
6. Copy the snippet and paste it into your site where the widget should appear.

The live preview below your domains shows the widget against a background, width, and colour scheme of your choosing, so you can check the fit before you publish. It follows your **Default view**, so a calendar previews at the month grid's height rather than the list height.

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

If your venue runs more than one programming stream — a Social Club night and a live-music series sharing the same floor — you can embed **just one of them**. Set your streams up first in [spaces and calendars](/help/organising-events/spaces-and-calendars); every venue has at least one calendar, so there's always something to pick.

1. Go to **/admin/{your-slug}/embeds**, stay on the **Events** tab, and set the subject control to **Calendar**.
2. Pick the venue from **Select a venue**. Its calendars appear underneath, under a **{Venue} · Calendars** heading, each showing how many spaces it schedules into and which one is the **Default**.
3. Click the calendar you want.
4. Choose a **Default view** (List or Calendar) as you would for any events widget, add your domain, and copy the snippet.

The widget then shows that calendar's **published** events and nothing else — not the venue's other calendars, and not events in a space the two calendars share. That last part is the point of the feature: two streams can book the same space without their public listings bleeding into each other.

The venue picker lists venues your org controls, and you need edit access on the venue itself to set up or revoke one of its calendar embeds.

### What a calendar embed does differently

**Clicks always open the event on Ithas Fire, in a new tab.** There is no in-iframe ticket picker or checkout on a calendar embed, in either view, whatever your link-mode setting says. The events on a venue's calendar can belong to any promoter who booked in — they aren't necessarily yours to sell — so the widget sends every visitor to the event's own page rather than opening a checkout it may not be entitled to run.

Two more differences worth knowing:

- **No scope control.** **My events / At my venues / Everything** is for your own or your organisation's events. A calendar embed is already scoped: it's that calendar.
- **Nothing internal ships to the page.** Conflict warnings, opening hours, blackout dates, and private closure notes are admin-only and never appear in a calendar embed's payload. The same goes for draft, private, and unlisted events.

:::tip
Running a room and want the full what's-on including other promoters' shows? That's the **At my venues** scope on an ordinary events widget, not a calendar embed. Use a calendar embed when you want one *stream*; use **At my venues** when you want one *room's* whole diary.
:::

## Choosing which events appear

When you embed your own or your organisation's events, you also choose the scope:

| Scope                     | What the widget shows                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **My events** _(default)_ | Only events you created.                                                                 |
| **At my venues**          | Published events at venues you own — including events other organisers booked into your room. |
| **Everything**            | Both of the above, with duplicates removed.                                              |

**At my venues** is the one to reach for if you run a room. Your website's "what's on" list then keeps itself current as promoters book in, without you re-entering anything.

:::tip
Scope is part of the snippet, not a setting saved on the domain — so one site can run two differently-scoped widgets on two different pages. Copy a snippet per scope.
:::

Scope applies to your own or your organisation's events in both views. A single-event or booking-button embed ignores it.

Every scope shows **published** events only, and **At my venues** shows only **public** ones — a private or unlisted event booked into your room never appears in your widget.

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

Override the default colours by appending hex codes (no `#`):

```
?brandColor=FF5721&bg=F0F3F9&fontColor=181818&accentColor=35589A
```

Scope rides on the same query string — `?scope=venues` or `?scope=all`. Leaving it off means **My events**. The view does too — `?view=calendar` or `?view=list` — and leaving it off means "use the embed's **Default view**". The admin **Copy** button already includes both when you've picked something other than the default, so you rarely need to add them by hand. An unrecognised value (say `?view=map`) is ignored rather than breaking the widget.

| Param         | What it styles                         | Default  |
| ------------- | -------------------------------------- | -------- |
| `brandColor`  | Primary buttons (Pay, Add to cart)     | `FF5721` |
| `bg`          | Widget background                      | `F0F3F9` |
| `fontColor`   | Primary text                           | `181818` |
| `accentColor` | Headings, dividers, structural accents | `35589A` |

:::tip
If the widget looks off against your site's colours, start by matching `brandColor` and `bg` to your brand — buyers subconsciously trust the widget more when it looks like part of your site. Pick a **bright** `brandColor`: button labels render in dark ink for readability, so a very dark brand colour makes primary buttons hard to read.
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
    theme: { brandColor: "FF5721", bg: "F0F3F9" },
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

`onOrderComplete` is the hook most sites want — fire a thank-you modal, bump an analytics counter, or redirect to a custom success page.

## Booking button for venues

Verified venues that accept booking requests can put a **Request to book** button on their own website. Visitors click it, a booking form opens in a modal, and the request lands in your venue's Bookings inbox — the visitor doesn't need an Ithas Fire account.

There are two doors onto the same thing — use whichever you're already in front of:

- **From the embeds page** — open the **Booking button** tab and pick the venue from the dropdown.
- **From the venue** — open the venue's page settings and find **Booking button for your website**, directly beneath the **Accept booking requests** switch.

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

Change `triggerText` to relabel the button; the `theme` option and the theming query params work here the same as for the other widgets. A booking button ignores `scope` — it's tied to the one venue.

The same domain enforcement applies as for ticket widgets: the form only works on domains you've added, submissions from anywhere else are refused outright, and **Revoke** disables the button on that domain. Add each domain that will host the button.

### What visitors see

The form asks for their name, email, act or band name, 1–3 preferred dates, and a pitch, with optional extras (expected draw, genre, lineup size, set length, tech needs, fee ask, links) under **More details**. A short Cloudflare verification runs before **Send request**. Each email address can have one open request per venue at a time.

Performers who already use Ithas Fire can click **Log in** next to "Booked with Ithas Fire before?" — a popup signs them in (without re-entering credentials if they're already signed in on ithasfire.com), and the form switches to their account: they pick who to submit as and their saved booking defaults are prefilled.

If your venue isn't verified yet, or **Accept booking requests** is switched off, the button still renders but shows a calm "Not taking booking requests right now" message instead of the form — the section in your page settings reminds you of this while the toggle is off.

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

- **Domain added in admin** — widgets only load on domains you've registered under **/admin/{your-slug}/embeds** (a booking button's domains can be added there or in the venue's page settings; it's the same list either way)
- **Content-Security-Policy** — if your site uses a strict CSP, allow `frame-src https://ithasfire.com`
- **`allow="payment"` on the iframe** — required for Apple Pay / Google Pay via the Payment Request API; the default snippet includes this

:::warning
Remove domains you no longer use — each added domain is a live embed surface. Revoking a domain via the admin UI invalidates every iframe that uses that embed ID.
:::

## What buyers see: security checks

Two protections run on the live widget. Neither needs any setup from you, but it helps to know what your buyers might encounter:

- **Automatic security check before payment.** When bot protection is switched on for the platform, guest checkout in your widget includes a Cloudflare security check just above the **Continue to payment** button. It usually verifies the buyer in the background with no interaction; occasionally it shows a short interactive challenge instead. Until it passes, the form shows _Complete the verification to continue_ and the order won't submit.
- **Domain enforcement.** The widget only works on the domain you registered for the embed (plus ithasfire.com itself, so the admin **Preview** keeps working). `www.` doesn't matter — registering `example.com` also covers `www.example.com`, and vice versa. On any other domain the widget refuses to load or take payment, and buyers see: _"This widget isn't available on this domain. If you're the organizer, check your embed settings."_

Together these are why your embed can't be lifted onto someone else's site: the domain allowlist blocks unauthorised pages outright, and the security check stops automated checkout on the pages that remain.

If a legitimate page of yours is being blocked, check that the domain saved on the embed (under **/admin/{your-slug}/embeds**) matches the site hosting the iframe, and that your `<iframe>` carries the `referrerpolicy="strict-origin"` attribute from the snippet above — without it some browsers can't prove your domain to the widget.

## Gotchas

- **Height is clamped at 2000 px** by the resize script — very long event lists become scrollable inside the iframe rather than growing indefinitely.
- **Stripe 3-D Secure and Amazon Pay** may redirect the top window during payment; the widget handles the return automatically and cleans up query params.
- **Single-event embeds** skip the list entirely and drop buyers straight into the detail view with a ticket picker.
- **Calendar embeds never check out in the frame** — every click opens the event on Ithas Fire in a new tab, in list view and calendar view alike. See **Embedding one named calendar** above for why.
- **Past events on the calendar** stay visible for context but can't be bought — clicking one opens the event's page on Ithas Fire instead of checkout.
- **Older calendar snippets keep working.** The calendar used to have its own address, `/embed/calendar/{embedId}`, and anything you already pasted still renders the calendar exactly as before — that URL isn't going away. New snippets use the same address as the list with `?view=calendar` instead. Both forms take the same `?scope=` param, so `/embed/{embedId}?view=calendar&scope=venues` gives you a what's-on calendar for your room.

## Testing before you launch

Use the preview pane in the admin UI to iterate on theming and sizing without touching your site. When you're happy, copy the snippet.

Because the embedId is stable, settings stored **on the embed** — the link mode above, your **Default view**, and **Let visitors switch views** — take effect on the next page load without you touching your site's code. Settings that live **in the snippet** — `scope`, the theme colours, and a view you pinned with `?view=` — are baked into what you pasted, so changing those in the admin means copying the snippet again.

---
title: "Edit and preview your public page"
description: "Change what your public page shows, check it on desktop and mobile, and undo a change you did not mean to make."
category: "organising-events"
order: 17
tags: ["page", "profile", "preview", "blocks", "theme"]
related:
  [
    "account/edit-your-profile",
    "organising-events/claim-your-place",
    "organising-events/embed-widgets",
  ]
specs: ["2026-09-24/completed/venue-track-record-and-review-switch"]
---

Your organisation, your place and you each get a public page — the one people land on at `/p/your-slug` when they follow a link from an event. The page editor is where you change what it shows.

## Before you start

The editor lives in a different place depending on whose page you are editing:

- **Your own page** — [/account/page](/account/page)
- **Your organisation's page** — **Page** in the admin sidebar
- **A place's page** — open the place, then **Page**. You need to have claimed the place first; see [Claim your place](/help/organising-events/claim-your-place).

## Edit and Preview

At the top of the editor there is an **Edit** / **Preview** switch.

**Edit** is where you work. You see your blocks with their controls attached, plus **Page settings** (on your own and your organisation's page) and the undo controls.

**Preview** drops the editing controls and shows the page as a visitor sees it. It renders what you have in front of you right now, so a change you just saved shows up immediately without you having to open the live page in another tab.

Switching to Preview does not save or publish anything. It is a view, and your work is exactly where you left it when you switch back.

### Desktop and Mobile

Preview has its own **Desktop** / **Mobile** switch. Desktop shows the page at full width. Mobile puts it in a phone-sized frame so you can check how it stacks on a small screen — worth doing if you have written long headings or added a wide image.

:::warning
The **Mobile** frame loads your **published** page, so it does not include edits you have not saved yet. The frame says so, and there is a reload button next to the label. Save first, then reload the frame.
:::

## Page settings

**Page settings** is the collapsed panel above your blocks on your own page and your organisation's page. It holds two sections:

- **Profile** — your display name, bio, avatar and banner
- **Theme** — colours, font and layout

One **Save changes** button in the toolbar at the top of the editor saves both sections. Avatar and banner images save as soon as you pick them.

### A place's page settings

A place's page has no **Page settings** panel. Its profile and theme — web address, bio, images, visibility, colours, font and layout — are in the **Public page** section of the place's **Settings** page (the first item in the sidebar's **Place** group). The text fields and theme save with that page's **Save changes**; images save as soon as you pick them. The place's **Page** item is the block editor only, with a link back to Settings.

Review settings live on that Settings page too, in **Reviews & feedback**. These switches take effect the moment you flip them — they are not part of **Save changes**. The one to know: **Performer reviews** — switch it off and performers can no longer submit new reviews, and the performer survey disappears from your public page, though anything already written stays visible to you. You need the **Owner** or **Admin** role on the organisation that owns the place, or to be its direct owner, to change it.

## Content blocks

Below the settings panel is **Content blocks** — the sections your page is built from, such as your bio, upcoming events, links and photos.

For each block you can:

- **Edit its content** — open the block's settings and change what it says
- **Hide it** — click **Hide** to take it off your public page without deleting anything. Hidden blocks stay in the editor so you can put them back.

One block on a place's page works differently: **Track record** sums up the shows that have happened there — how many, the first and last, who's played. It fills itself in from your published shows and door scans, so there's nothing to edit inside it, and you can't hide or delete it, only move it to a different spot in your layout.

The Standard template arranges blocks for you, so you do not need to position anything.

:::tip
Hiding is the fast way to deal with a section you have not filled in yet. An empty block reads as neglect to a visitor; a hidden one is invisible.
:::

## Undo and Redo

**Undo** and **Redo** sit next to the Edit/Preview switch.

They are worth understanding before you rely on them, because your page has no draft state. Once you save a change, it is live. So **Undo does not take back unsaved typing — it publishes a reversal of a change that already went out.**

The buttons tell you which change they mean. After hiding a section called "Our mission", the Undo button reads **Undo: hide 'Our mission'**, and clicking it puts the section back. Redo then offers **Redo: hide 'Our mission'**.

When there is nothing to reverse, the buttons read **Nothing to undo yet** and **Nothing to redo**.

### Keyboard shortcuts

- **Ctrl/Cmd + Z** — undo · **Ctrl/Cmd + Shift + Z** — redo
- **Ctrl/Cmd + Shift + P** — switch between Edit and Preview
- **Escape** — leave Preview

While your cursor is in a text field, Ctrl/Cmd + Z undoes your typing in that field, which is almost certainly what you want. The Undo button says so when it happens, and clicking it still undoes the page change.

## What can go wrong

**Your change is not on the public page.** Check you pressed **Save changes** after editing Profile or Theme — typing alone does not publish anything. For a place, that button is on the place's **Settings** page.

**The Mobile preview looks out of date.** It is showing your published page. Save your change, then use the reload button in the frame's header.

**The page is not reachable at all.** A page set to Private is not published, so visitors get a "not found" page and the Mobile preview has nothing to load. Change the visibility in **Page settings → Profile** (for a place: **Settings → Public page**).

**Nobody is finding your page.** Unlisted does what it says: the page opens normally for anyone you send the link to, but it stays out of search and browse. For a place that means a few specific things — it will not appear in the site's search results, it is left out of the sitemap search engines read, and events at your place show your name as plain text instead of a link to your page. Everything else about the event listing is unchanged. Switch to Public in **Page settings → Profile** (for a place: **Settings → Public page**) when you want to be found.

## Next steps

Your public page is also where people follow you and find your upcoming events, so it is worth keeping current alongside your listings. If you want your events on your own website too, see [Embed your events on your own site](/help/organising-events/embed-widgets). To change the name and photo attached to your account rather than your page, see [Edit your profile](/help/account/edit-your-profile).

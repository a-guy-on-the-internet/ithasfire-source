---
title: "Edit and preview your public page"
description: "Change what your public page shows, check it on desktop and mobile, and undo a change you did not mean to make."
category: "organising-events"
order: 17
tags: ["page", "profile", "preview", "blocks", "theme"]
related:
  [
    "account/edit-your-profile",
    "organising-events/claim-your-venue",
    "organising-events/embed-widgets",
  ]
---

Your organisation, your venue and you each get a public page — the one people land on at `/p/your-slug` when they follow a link from an event. The page editor is where you change what it shows.

## Before you start

The editor lives in a different place depending on whose page you are editing:

- **Your own page** — [/account/page](/account/page)
- **Your organisation's page** — **Page** in the admin sidebar
- **A venue's page** — open the venue, then **Page**. You need to have claimed the venue first; see [Claim your venue](/help/organising-events/claim-your-venue).

## Edit and Preview

At the top of the editor there is an **Edit** / **Preview** switch.

**Edit** is where you work. You see your blocks with their controls attached, plus **Page settings** and the undo controls.

**Preview** drops the editing controls and shows the page as a visitor sees it. It renders what you have in front of you right now, so a change you just saved shows up immediately without you having to open the live page in another tab.

Switching to Preview does not save or publish anything. It is a view, and your work is exactly where you left it when you switch back.

### Desktop and Mobile

Preview has its own **Desktop** / **Mobile** switch. Desktop shows the page at full width. Mobile puts it in a phone-sized frame so you can check how it stacks on a small screen — worth doing if you have written long headings or added a wide image.

:::warning
The **Mobile** frame loads your **published** page, so it does not include edits you have not saved yet. The frame says so, and there is a reload button next to the label. Save first, then reload the frame.
:::

## Page settings

**Page settings** is the collapsed panel above your blocks. It holds two sections:

- **Profile** — your display name, bio, avatar and banner
- **Theme** — colours, font and layout

Each section has its own **Save**. There is no single Save for the whole page, so save the section you are working in before you move on.

## Content blocks

Below the settings panel is **Content blocks** — the sections your page is built from, such as your bio, upcoming events, links and photos.

For each block you can:

- **Edit its content** — open the block's settings and change what it says
- **Hide it** — click **Hide** to take it off your public page without deleting anything. Hidden blocks stay in the editor so you can put them back.

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

**Your change is not on the public page.** Check you pressed **Save** in the section you edited. Page settings saves per section, so saving Profile does not save Theme.

**The Mobile preview looks out of date.** It is showing your published page. Save your change, then use the reload button in the frame's header.

**The page is not reachable at all.** A page set to Private is not published, so visitors get a "not found" page and the Mobile preview has nothing to load. Change the visibility in **Page settings → Profile**.

## Next steps

Your public page is also where people follow you and find your upcoming events, so it is worth keeping current alongside your listings. If you want your events on your own website too, see [Embed your events on your own site](/help/organising-events/embed-widgets). To change the name and photo attached to your account rather than your page, see [Edit your profile](/help/account/edit-your-profile).

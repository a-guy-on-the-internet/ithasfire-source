# CAB eradication — inventory and kill list

**Date:** 2026-08-30
**Goal:** the contextual action bar / page action bar stops existing. Every page
owns its own actions inline. No shell-rendered action surface, no route→action
config, no `cab-*` module.

Prior art: `docs/specs/2026-08-27/completed/cab-removal.md` (partial removal — the dock died,
the strip survived as `PageActionBar`), `docs/specs/2026-08-27/completed/cab-page-action-bar.md`.

---

## 0. Current state (measured 2026-08-30)

- `ContextualActionBar.tsx` (1,789 lines) — **already dead**: mounted nowhere.
- `PageActionBar` — **live**, mounted twice: `AppShell` (every consumer page) and
  `AdminShell` (every admin page).
- **No page registers an action into the store any more** except the four listed
  in §3. `peSave` / `peViewLive` / `ebSave` / `ebPublish` / `ebUnpublish` /
  `ebPreview` / `ebShare` / `ebViewLive` are declared in `bar-configs.ts` and
  gated on data keys nothing publishes → they render as nothing. Two files still
  carry the empty leftover `import {} from ".../contextual-action-bar"`.
- So what the bar actually paints today is: a brand mark, a few static nav
  chips, and one static-href CTA — on the routes in §4.

---

## 1. Core modules to delete

`apps/web/src/components/navigation/`

| File | LOC | Note |
| --- | --- | --- |
| `ContextualActionBar.tsx` | 1789 | floating dock, already unmounted |
| `page-action-bar/PageActionBar.tsx` | 606 | the live strip |
| `contextual-action-bar/bar-configs.ts` | 1607 | route→segment table |
| `contextual-action-bar/ActionBarCTA.tsx` | 336 | |
| `contextual-action-bar/ActionBarOverflowMenu.tsx` | 403 | |
| `contextual-action-bar/ActionBarSegment.tsx` | 319 | |
| `contextual-action-bar/measure-overflow.ts` | 412 | |
| `contextual-action-bar/cab-store.ts` | 276 | **see §3 — decision** |
| `contextual-action-bar/SegmentRenderer.tsx` | 192 | |
| `contextual-action-bar/cab-anchor.ts` | 158 | dock anchoring |
| `contextual-action-bar/cab-shortcuts.ts` | 165 | digit shortcuts |
| `contextual-action-bar/CabShortcutHint.tsx` | 136 | |
| `contextual-action-bar/measure-natural-width.ts` | 67 | |
| `contextual-action-bar/lone-primary-flex.ts` | 39 | |
| `contextual-action-bar/useActiveBarConfig.ts` | 33 | |
| `contextual-action-bar/use-prefers-reduced-motion.ts` | 33 | check for other consumers first |
| `contextual-action-bar/cab-icons.tsx` | 100 | |
| `contextual-action-bar/auth-required-routes.ts` | 10 | |
| `contextual-action-bar/index.ts` | 20 | barrel |
| `mobile-primary-action.ts` | 76 | **see §3 — decision** |

**Tests to delete with them:** `contextual-action-bar/cab-anchor.test.ts` (414),
`contextual-action-bar/cab-shortcuts.test.ts` (309),
`contextual-action-bar/__tests__/{cab-store,lone-primary-flex,measure-overflow,useActiveBarConfig}.test.ts`,
`page-action-bar/__tests__/PageActionBar.test.tsx`,
`navigation/__tests__/bar-configs.test.ts` (39 KB),
`components/search/__tests__/spotlight-cab-integration.test.ts` (rewrite: the
spotlight-store half is still worth keeping, the CAB-mirroring half is not).

Total: ~7,500 lines of source + ~2,600 lines of test.

---

## 2. Mount points to cut

| File | Line | Action |
| --- | --- | --- |
| `components/layout/AppShell.tsx` | 9, 180 | drop import + `<PageActionBar />` |
| `app/admin/[slug]/_components/AdminShell.tsx` | 52, 809 | drop import + `<PageActionBar />` |
| `components/layout/__tests__/AppShell.test.tsx` | 45–46 | drop the mock + its assertions |
| `app/admin/[slug]/_components/__tests__/AdminShell.test.tsx` | 273–274 | same |

---

## 3. Store consumers — the one live dependency

`cab-store` is the registration channel. Four things still ride it:

| Consumer | Key(s) | What breaks if the store dies |
| --- | --- | --- |
| `components/support/SupportWidget.tsx:324` | `support` | the bottom nav's **Support** tab loses its opener |
| `components/navigation/ConsumerBottomNav.tsx:182,185` | reads `mobilePrimary`, `support` | the raised **centre action** and Support tab |
| `app/events/[...slug]/_components/EventDetail.tsx:388` | publishes `mobilePrimary` (Get tickets) | centre action on the event page |
| `app/p/[slug]/_components/headers/HeroBookingRequestButton.tsx:67` | publishes `mobilePrimary` (Request to book) | centre action on the venue page |
| `components/layout/GlobalOverlays.tsx:56–58` | `query`, `openSpotlight`, `goToMyTickets` | nothing — only the deleted bar read these |

The consumer mobile bottom nav (shipped 2026-08-28) is a **separate** surface
and is not being removed. Its centre action and Support tab need a channel.

**Plan:** keep the ~60 useful lines of `cab-store` as a new, CAB-free
`components/navigation/page-primary-action.ts` (publish/read one label +
one callback, plus the support opener) and delete the rest. `GlobalOverlays`'s
three registrations go away entirely.

---

## 4. Page-by-page kill list

Every route below currently gets a bar. For each: confirm the action has an
inline twin on the page, add one where it does not, then the route rule dies
with `bar-configs.ts`.

### Consumer

| Route | Bar contents | Inline twin? |
| --- | --- | --- |
| `/events/category/:slug` | `category` readout · All events link · **Search** CTA | page has its own search entry — verify |
| `/events/resale/:listingId` | `price` readout · **Get tickets** CTA | listing page has its own buy button — verify |
| `/account` | Settings · Notifications links · **My tickets** CTA | account page links — verify |
| `/account/notifications` | Profile · Settings links · **My tickets** CTA | verify |
| `/account/settings` (+ `/:rest*`) | `ACCOUNT_SETTINGS_CONFIG` | verify |
| `/about` | Contact link · **Find events** CTA | filler — delete, no replacement |
| `/contact` | About link · **Find events** CTA | filler — delete |
| `/lucky` | **Find events** CTA | filler — delete |
| `/unsubscribe` | **Find events** CTA | filler — delete |
| `/places/new` | **Find events** CTA | filler — delete |
| unknown routes (`__fallback`) | brand · Explore CTA | delete |

Already `config: null` (nothing to do): `/`, `/events`, `/events/:slug*`,
`/events/search`, `/search`, `/my-tickets*`, `/orgs/:slug`, `/humans/:slug`,
`/p/:slug`, `/places/:slug`, `/sell*`, `/events/checkout/*`, `/platform*`,
`/sign-in`, `/sign-up`, `/login`, `/terms`, `/privacy`, `/cookie-policy`,
`/acceptable-use`, `/verify-email`, `/claim-transfer`, `/invite/accept`.

### Admin

| Route | Bar contents | Inline twin? |
| --- | --- | --- |
| `/admin` , `/admin/new` | **Find events** CTA | filler — delete |
| `/admin/:slug` , `/admin/:slug/dashboard` | **Create event** CTA · Places · Orders · Scan links | dashboard cards + rail — verify |
| `/admin/:slug/:section` , `/admin/:slug/:section/:rest*` | Dashboard · Events · Orders links · **Create event** CTA | rail covers nav; Create event lives on the events page |
| `/admin/:slug/events` | Dashboard · Orders links · **Create event** CTA | events table has its own Create — verify |
| `/admin/:slug/orders` | Events · Dashboard links · **Create event** CTA | delete |
| `/admin/:slug/team` | Events · Settings links · **Invite member** CTA | team page has Invite — verify |
| `/admin/:slug/scan` | Events · Attendees links · **Scan tickets** CTA | scan screen owns this |
| `/admin/:slug/payments` | Dashboard · Orders links · **View payouts** CTA | verify |
| `/admin/:slug/settings` (+ sub) | `ADMIN_SETTINGS_CONFIG` | verify |
| `/admin/:slug/events/:id/attendees` | Edit event · Comp tickets links · **View event** CTA | verify |
| `/admin/:slug/events/:id/applications` | Attendees · Edit event links · **View event** CTA | verify |
| `/admin/:slug/events/:id/{dates,comp-tickets,volunteers,suggestions,feedback}` | `ADMIN_EVENT_OPS_CONFIG` — Attendees · Edit links · **View event** CTA | verify |
| `/admin/:slug/events/:id` , `…/edit` | `ADMIN_EVENT_BUILDER_CONFIG`, `hostedByPage` | **renders nothing today** — builder header owns Save/Publish |
| `/admin/:slug/page` | View page · **Save** CTAs | **not registered → renders nothing**; editor owns Save |
| `/admin/:slug/places/:placeId/page` | View page CTA | same |
| `/admin/:slug/places/:placeId/edit` | **Save** CTA | same |

---

## 5. Incidental references to clean

- `app/admin/[slug]/events/new/_components/EventBuilder.tsx:48` — empty import.
- `components/entity-pages/PageEditorView.tsx:64` — empty import.
- `components/actions/DirectionsDropdown.tsx:39` — imports
  `PAGE_ACTION_BAR_MIN_HEIGHT` for portal clearance maths; needs its own constant
  or the maths dropped.
- `components/navigation/navbar-offset-store.ts` — publishes
  `--page-action-bar-top`; rename or drop with its only consumer.
- `components/layout/AppShell.tsx:89` — sets `--page-action-bar-top`.
- Comment-only references: `MarqueeBand.tsx:88`, `SavedStrip.tsx:31`,
  `UnifiedScanView.tsx:289`, `CategoryTagsSection.tsx:822`,
  `BuilderHeaderBar.tsx:19–44`, `PlaceOwnerRow.tsx:43,54`, `AppChrome.tsx:146`,
  and the header comments in `VolunteerSection.trigger.test.tsx`,
  `EntityHeroActions.test.tsx`, `PlaceHeroActions.test.tsx`.
- Test mocks: `EventBuilderPreviewToggle.test.tsx:187`,
  `EventBuilderRenderIsolation.test.tsx`, `BuilderHeaderBar.test.tsx`,
  `TeamView.test.tsx`, `PageEditorViewPreviewToggle.test.tsx`.
- e2e: `e2e/entity-page-editor.spec.ts:192` clicks `cab-peViewLive` — that
  testid comes from the bar and nothing registers the action, so the step must
  be repointed at the editor's own control. (`checkout-steps.spec.ts` hits are
  false positives — "cab-buyer" fixture names.)
- i18n: the `cab: { … }` namespace in `apps/web/src/i18n/messages/{en,es}.ts`
  (~110 keys) becomes dead. `packages/locale/messages/*.json` is **off limits** —
  leave those alone.
- CSS/token references to `CAB_HEIGHT` / `CAB_CLEARANCE` — grep before deleting.

---

## 6. Order of work (as executed)

1. Cut the two mount points (`AppShell`, `AdminShell`) — the bar disappears from
   every page at once. Fix the two shell tests.
2. Sweep §4 page by page: for each route that had a non-filler action, confirm or
   add the inline twin.
3. Extract the surviving primary-action channel (§3) into
   `page-primary-action.ts`; repoint `ConsumerBottomNav`, `SupportWidget`,
   `EventDetail`, `HeroBookingRequestButton`.
4. Delete §1 wholesale, then §5's incidentals.
5. `pnpm typecheck` + `pnpm -F web exec tsc -p tsconfig.json --noEmit`, web vitest
   from `apps/web`, then drive the app: consumer home / event / account, admin
   dashboard / events / builder, at 320 px and desktop, zero new console errors.


---

## 7. Outcome — done 2026-08-30

**Deleted** (`apps/web/src/components/navigation/`): `ContextualActionBar.tsx`,
the whole `contextual-action-bar/` directory (20 files), the whole
`page-action-bar/` directory, `mobile-primary-action.ts`, plus
`__tests__/bar-configs.test.ts` and `components/icons/HearthFlame.tsx` (the
brand square's flame — its only consumer was the bar). ~7,500 lines of source,
~2,600 lines of test.

**Kept, renamed, CAB-free**: `components/navigation/page-primary-action.ts` —
the two channels the consumer bottom nav reads, with the ownership-token
cleanup discipline carried over verbatim (it is the fix for the
route-transition clobber that used to empty the bar). API:
`usePagePrimaryAction` / `usePagePrimaryActionValue` and `useSupportOpener` /
`useSupportOpenerValue`. Repointed: `ConsumerBottomNav`, `SupportWidget`,
`EventDetail`, `HeroBookingRequestButton`.

**Mounts cut**: `AppShell` and `AdminShell` render nothing between their
content area and the page. `--page-action-bar-top` and its plumbing are gone;
`navbar-offset-store` survives for `DirectionsDropdown`, which now pins its
mobile sheet at `navbarVisibleHeight + 8` instead of adding a bar height.

**`GlobalOverlays`** is down to two children (`SpotlightSearch`,
`SupportWidget`) — its `query` / `openSpotlight` / `goToMyTickets`
registrations had no reader left.

**Pages checked for the inline twin** (§4). Every non-filler CTA already had
one, page-owned:

| Action the bar carried | Where it lives now |
| --- | --- |
| Save / Publish / Unpublish / Preview / View / Share (builder) | `BuilderHeaderBar`'s `actions` strip, pre-rendered by `EventBuilder` |
| Save (place edit) | inline Save on the edit page |
| Save / View live (entity page editor) | editor toolbar (`entity-page-view-live`) |
| Create event | dashboard card + the events table's Create button |
| Invite member | the team page's own add-member form |
| Get tickets (resale) | the resale checkout's own pay button |
| Scan tickets | the scan screen itself |
| Nav chips (Dashboard / Events / Orders / Settings / Attendees …) | the admin rail and the event rail |
| Find events / Explore / All events filler | dropped — pure chrome |

Not carried over: a "View event" affordance on the event **ops** routes
(attendees, applications, comp-tickets, volunteers, suggestions, feedback).
The bar's version pointed at `/events/:id` with the ADMIN event id, not the
public slug, so it was likely broken anyway. If it turns out to be wanted, the
place for it is `EventRailContextHeader`, beside the title and status badge.

**Deliberately left alone**: the `cab.*` i18n namespace. ~40 live call sites
still read those keys for labels the pages now own (Save, Publish, Share,
Attendees, More actions, Copy link …). The namespace exists in BOTH
`apps/web/src/i18n/messages/{en,es}.ts` and `packages/locale/messages/*.json` —
and the latter is off limits (rolling user WIP). Renaming would have to touch
it or every label falls back to a raw key string. The keys are internal; the
bar they were named for is gone.

**Verification**: `pnpm -F web exec tsc -p tsconfig.json --noEmit` clean
(baseline is zero). Web vitest run from `apps/web`. Driven in the browser at
desktop and 320px across consumer + admin.

---

## 8. Page-by-page review — decisions and follow-through (2026-08-30)

Walked every route from §4 with the user and settled what, if anything, replaces
the bar's contents. Recorded here because "we deleted it" is only half the
story — the other half is where each action went.

### Nothing replaces it

| Route(s) | Bar carried | Why nothing |
| --- | --- | --- |
| `/events/category/:slug` | Category readout · All events · Search | All three duplicated something already on the page (h1, nav, navbar search). The page keeps its own `← Home` and view toggle. |
| `/account`, `/account/notifications`, `/account/settings` | Profile · Settings · Notifications · My tickets | Every one is a row on the `/account` menu, and the bottom nav has a Tickets destination. |
| `/about`, `/contact`, `/lucky`, `/unsubscribe`, `/places/new`, 404 fallback | Find events / Explore | Chrome, not page content — the same button on six unrelated pages. |
| `/admin/:slug/settings` and every `/:section` catch-all | Dashboard · Team · Events · Orders · Create event | A second, worse copy of the navigation rail. Section pages own their actions through `AdminPageHeader`'s `trailing` slot (12 already do). |

### Actions that moved into the page

| What | Where it went |
| --- | --- |
| **Create event** | A primary in the dashboard's own header row (`dashboard-create-event`), beside the org title. The look-alike quick-action card below was removed, so the dashboard offers it once. The events table's CREATE EVENT is unchanged — one per page. |
| **Export (orders)** | Out of the table toolbar (next to Density/Columns) and into `AdminPageHeader`'s `trailing`, matching Payments and Team. Both shapes — the queued background export and the inline CSV — moved together; the toolbar keeps Refresh/Density/Columns. |
| **View event** | Into `EventRailContextHeader`, beside the event title and status chip, so it covers the builder AND all five ops surfaces from one place. The builder header's own copy was **removed** — it would have been a second path to the same destination three inches away. |
| **Save (entity page editor)** | Out of the collapsed settings disclosure and into the editor toolbar next to View page. See below. |
| **Focus scanner** (new) | `/admin/:slug/scan` header. Not the bar's old "Scan tickets" CTA — a real control that puts the caret back in the live code field (camera view → paste input, search view → search input) and scrolls it into frame. The door case is a USB/Bluetooth wedge scanner: it types into whatever has focus, so one stray tap sends every scan nowhere with no error to show for it. |

### `getEventTitle` gained a slug

The rail's View event needs the PUBLIC slug, and the bar's version pointed at
`/events/:id` with the **admin** event id — it was almost certainly broken.
`getEventTitleOutputSchema` now returns `slug: string | null`, and the rail
applies the builder's old gate: PUBLISHED **and** a slug assigned. The gate reads
the query's status rather than the role-gated `eventStatus`, because a published
event's page is public to anyone — withholding the link from a VIEWER or SCANNER
would protect nothing.

### One Save for the page editor's settings

The settings disclosure holds two independent forms (Profile → `updatePage`,
Theme → `updatePageTheme`), each of which used to carry its own Save *inside the
collapsed panel*. Saving therefore meant: notice the panel, open it, find the
right subsection, press the right button.

`components/entity-pages/page-settings-save.tsx` is a small registry — each form
publishes `{isDirty, isPending, blocked, save}`, the toolbar renders ONE Save
that commits every dirty one. Forms keep their own validation: a taken slug
registers `blocked` and the toolbar refuses. Owner-token cleanup is carried over
from `page-primary-action.ts` for the same reason (out-of-order unmounts).

Edit mode only — preview hides the forms, and a Save whose targets are off screen
is a Save that looks broken. Blocks are unaffected: the canvas persists
immediately through `managePageBlocks`.

### Resale is a checkout

`/events/resale` joins `/events/checkout` in `ConsumerBottomNav`'s
`HIDDEN_PREFIXES`. Same rule, same reasons, different path: its primary is
literally `Pay $47.50` (a raised 64px square cannot carry an amount), and four
global destinations under a payment form are four ways to abandon a cart. The
page already had the single `← Back to event` exit the rule prescribes.

**Not built:** a docked `Pay $X` bar for resale. Checkout's `MobileCTABar` is
tightly coupled to its order shape, and driving payment from a detached bar means
giving `StripePaymentCard` an external submit trigger — payment-path surgery
worth doing deliberately, not as a side effect of this sweep.

### Verification

`pnpm exec tsc -p tsconfig.json --noEmit` in `apps/web` reports exactly one
error, in `packages/ui/.../forms/GroupedMultiSelect.tsx` — an untracked,
in-progress file (`</Trigger>` closing a `<PlainButton>`), unrelated to this
work. Unit tests: 142 passing across the touched suites, plus 11 in core for
`getEventTitle`. Browser-verified: the dashboard's Create event, the orders
Export in its header, Focus scanner (focus lands in the right field per view),
and the resale bottom-nav suppression (0 there, 1 on `/` at the same width).
Still wanting a browser pass once the dev server compiles again: the rail's View
event and the page editor's toolbar Save.

---

## 9. Builder header — Option A, shipped 2026-08-30

The header was the last surface still carrying the action bar's habits. On a
DRAFT it rendered **seven controls in one undifferentiated row**, and two of
them did the identical thing: the labelled `Preview` button called
`handleViewModeChange(viewMode === "preview" ? "edit" : "preview")` — the same
handler behind the `Edit | Preview` toggle three controls to its right. Two
activation paths, one action, inches apart. It survived the teardown because the
bar used to own the labelled copy.

Proposal + the two options not taken:
https://claude.ai/code/artifact/1c8b5d10-eaca-4e54-bc6d-461c29bdad93

**Shape now** — three groups, hairline-separated:

```
←  Event title  DRAFT          [Edit|Preview] │ ⋯ │ Save [Publish] ✕
```

| Change | Where |
| --- | --- |
| Labelled `Preview` deleted — the toggle is the only way to preview | `EventBuilder.tsx` |
| "Open live draft" moved into `⋯` with a real label, keeping its `event-preview-link` test id | `BuilderHeaderBar.tsx` |
| Publish carries the primary fill; Save drops to secondary *while Publish is present* | `EventBuilder.tsx` |
| Close became a quiet trailing `✕` on **every** width — the mobile branch that folded it into `⋯` is gone | `BuilderHeaderBar.tsx` |
| Actions split into `secondaryActions` (Share, Unpublish) and `actions` (the commit pair) so the header can rank them | both |

**One deviation from the drawing.** On a PUBLISHED event there is no Publish to
carry the fill, so Save takes the primary back:
`variant={showPublish ? "secondary" : "primary"}`. Otherwise the row would have
no weighted control at all.

### Two test mocks were lying

Both surfaced while pinning this, and both would have hidden a real defect:

- `BuilderHeaderBar.test.tsx`'s `@th/ui` mock forwarded **only** `data-testid`,
  swallowing every `aria-*`. Close is now icon-only, so its `aria-label` is the
  only thing naming it — the mock made that unassertable. Widened to forward
  `aria-*`.
- `PageEditorViewPreviewToggle.test.tsx`'s mock mapped `disabled` to the native
  attribute only. The real `Button` forwards **both** native `disabled` and
  `aria-disabled` (`packages/ui/.../forms/Button.tsx`, `lockedProps`), so every
  `aria-disabled` assertion against a disabled button read as null. Mock now
  mirrors the real component.

A third trap, in the same suite: the settings forms only mount while the
disclosure is **open**, so a toolbar-Save test that skips opening it passes
because the registry is EMPTY — the opposite of what it claims to check. The
suite now opens the panel explicitly, and pins the never-opened case separately.

### Verification

Browser-driven, signed in as the dev admin: the builder header renders
`toggle → Save → Publish → ✕` with no inline preview control, the `⋯` carries
"Open preview in a new tab" + "Cancel Event", Close is icon-only with the
accessible name "Close", and nothing overflows at 1440. Also driven earlier:
the dashboard's Create event, orders' Export in its header, Focus scanner
(focus lands in the right field per view), and the resale bottom-nav
suppression.

Not browser-driven: the rail's View event in its **positive** state — every
event reachable on the dev stack during the pass was a DRAFT, where the gate
correctly withholds it (verified). The published case is covered by three unit
tests. The page editor's Save is covered by eight.

Tests: 1470 of 1471 pass across every touched area. The single failure is
`ADMIN_SECTIONS` expecting an `overview` nav group that an uncommitted edit
removed — unrelated to this work.

---

## 10. Where the bar's actions actually went

Every migration below left a dated comment at its landing site, so this is
traced from the code rather than remembered. Unless noted, all landed
**2026-08-27**, when the bar was deleted.

### Consumer event page — `/events/[...slug]`

The densest destination: seven actions, each re-homed independently.

| Action | Landed in |
| --- | --- |
| Get tickets | `components/events/EventContent.tsx:1157` — sticky to the viewport bottom on mobile |
| Volunteer | `app/events/[...slug]/_components/VolunteerSection.tsx:495` |
| See dates (series) | `EventDetail.tsx:359` owns the picker's open state; `components/community/CommunityDateList.tsx` holds the scroll anchor |
| RSVP | `components/community/use-rsvp-toggle.ts` — one controller driving both the in-body button and the bottom nav |
| Suggest an edit | `components/community/CommunityListingNotice.tsx:37` |
| Directions · Add to calendar | `components/actions/DirectionsDropdown.tsx`, `CalendarDropdown.tsx` — both still expose the controlled `open` prop their bar trigger used |

### Venue and entity pages — `/p/[slug]`

`VenueCabActions` and `EntityCabActions` were renamed into the hero `⋯`
overflow: `PlaceHeroActions.tsx` and `EntityHeroActions.tsx` (Share, Copy link,
Report, Claim venue, Request transfer). Request transfer also gained an inline
home in `components/places/claim/PlaceOwnerRow.tsx`; Request to book sits on the
hero button, which additionally publishes the bottom nav's centre action.

### Admin

- **Builder header** — Save / Publish / Unpublish / Share / View event / Preview
  (08-27), regrouped into three ranked groups on 08-30 (§9).
- **Entity page editor** — View page (08-27); Save lifted out of the collapsed
  settings disclosure into the toolbar (08-30).
- **Place edit** — inline Save.
- **Dashboard** — Create event, into the page header (08-30).

### Checkout

Kept its own `MobileCTABar` and suppressed the bottom nav entirely — which is
why extending the same treatment to `/events/resale` (08-30) is consistency,
not a special case.

### The failure mode this list exists to surface

Two of these were **not** twins. The bar was the only path, and deleting it took
the feature with it — both caught after the fact:

> *"Until 2026-08-27 the sheet could ONLY be opened from the floating action
> bar, so removing that bar would have made volunteering unreachable."*
> — `VolunteerSection.tsx`

> *"It used to live in the floating action bar; when that was removed the page
> had no way to buy at all (`ctaLabel`/`ctaHref` were passed in and silently
> dropped)."* — `EventContent.tsx`

Everything moved on 08-30 had a verified twin or a same-commit replacement
first. The 08-27 batch is the one to re-check, because it is the batch that
already produced two of these.

### And the opposite failure mode

The event page now has **two** Get-tickets affordances on a phone: the sticky
one in `EventContent` (`position: sticky; bottom: 0`) and the raised centre
square in `ConsumerBottomNav`, which `EventDetail` publishes through
`page-primary-action`. Both were added to solve the same problem at different
times. Measured live: the bottom nav on an event page reads
`Home · Search · Get tickets · Tickets · Support`, and its centre action routes
to checkout. The sticky button's `bottom: 0` does not account for the fixed
nav's height, so how much of it the nav covers still needs measuring.

---

## 11. Consumer event page — shipped 2026-09-02

Proposal + the measurements behind it:
https://claude.ai/code/artifact/a09cd8d3-1c7b-461a-8461-3468ac130999

### What was measured first

On a live seeded event at 1440×900: the hero stated **From $62.35** and offered
nothing to press, while the only Get-tickets button sat at **y=1452 on a
2,254px page** — 64% down, 552px below the fold.

Two things turned out to be worse than the artifact assumed:

- **The sticky CTA was never sticky.** `EventContent` wrapped it in
  `position: sticky; bottom: 0` under a comment promising it "survives a long
  scroll". Measured at 390px scrolled to mid-page, its rect was
  `top: −229, bottom: −185` — scrolled off the top. Sticky holds only while its
  containing block is in view, and that block ends long before the page does.
- **The heading ladder was already "fixed", and the fix never worked.**
  `SectionTitle` was `styled(Text, { tag: "h2" })` carrying a comment reading
  "Real section heading under the page h1 (was a bare span — invisible to the
  heading ladder)". It rendered `<span class="is_Paragraph">`. `@th/ui`'s `Text`
  is a plain `forwardRef` that reads `tag` off its own props; a `tag` written
  into a `styled()` config is consumed by Tamagui's styled layer and never
  arrives. The page had two headings — the h1 and an unrelated "Welcome".

### What shipped

| Change | Where |
| --- | --- |
| `SectionTitle` became a component that passes `tag="h2"` to `Text` directly; `event-content-styled` re-exports it so no import site moved | `components/events/SectionTitle.tsx` |
| One `renderBuyButton` helper, rendered twice — hero and body — instead of one buried button | `EventContent.tsx` |
| Buy button into the hero, beside the price the hero already quotes | `EventContent.tsx` |
| The broken sticky wrapper deleted | `EventContent.tsx` |
| Low-availability line from `remainingCapacity` (the basis checkout refuses on), shown only at ≤10 and worded as the plain count the ticket rows already use | `EventContent.tsx` |
| The bottom nav's centre action is published **only once the hero button has scrolled out of view** | `EventDetail.tsx`, `use-scrolled-past.ts` |

**Deviation from the artifact.** It proposed a new fixed price-bearing purchase
bar on mobile. Shipped instead: gate the EXISTING nav centre action on the hero
button's visibility. Same outcome — exactly one buy affordance on screen at any
moment — without a second fixed bar, its clearance maths, or ~140px of an 844px
screen spent on two stacked bars. The trade is that the 64px square still cannot
carry a price; the hero and the ticket rows both do.

### A third mock that could not see the bug

`EventContent.test.tsx`'s `@th/ui` mock rendered `Text` as a bare `<span>`,
ignoring `tag` — so no test could ever have caught the heading regression. Now
honours `tag`. That is three suites this week whose Button/Text mocks were
unfaithful in exactly the dimension that broke (see §9).

### Found while testing, not fixed

The **body** CTA sits inside the `hasLogistics` block, so an event with tickets
but no schedule, location, lineup, RSVP or attribution renders no body button.
Harmless now that the hero always carries one — and pinned by a test — but the
gating is arbitrary and worth undoing next time that region is touched.

### Verification

Measured after the change, both viewports, zero console errors: hero button
above the fold on desktop (visible on first paint) and at y=674 on a 390px
screen; body button at ~1516; full heading ladder (h1 + five section h2s); no
sticky wrapper left; no horizontal overflow. Bottom nav driven through a scroll
cycle at 390px — `Home · Search · Tickets · Support` at the top, the centre
`Get tickets` square appearing once the hero button leaves, and going away again
on scroll back up. 458 tests pass across events, checkout, community, places and
navigation.

---

## 12. Corrections (2026-09-04)

Two defects in the work above, both found after it landed.

**Wrong i18n namespace on the hero's availability line.** §11 shipped
`t("common.lowAvailability", …)`. The key lives under **`eventDetail`**, not
`common` — `apps/web/src/i18n/messages/en.ts:286`. Under the dual-catalog
resolver a missing key renders the RAW key string, so the hero would have
displayed the literal text `common.lowAvailability` instead of "Only 3 left".
Caught and corrected to `eventDetail.lowAvailability` in review. The lesson is
the one already written down in `reference_web_i18n_dual_catalog`: a missing key
fails visibly but silently in tests — confirm the namespace by reading the file,
not by matching on the key's leaf name.

**Publishing removed the builder menu's only route to the live page.** §9 moved
"View event" into the admin rail and deliberately kept it off the builder
header. That holds. But the `⋯` item that replaced the inline preview,
`onOpenLiveDraft`, is gated `eventStatus !== "PUBLISHED"` — so the moment an
event went live, the builder's menu lost every path to its public page, and a
host standing in the builder had to go find the rail. The gap is a consequence
of moving one activation without re-checking the *other* item's gate against the
same lifecycle. Being fixed separately with a distinct `onViewEvent` item, so
the pre-publish draft link and the published-page link are never offered at once.

Both are the same shape of mistake: a change verified in the state it was
designed for (a DRAFT event, a key that exists somewhere) and not re-checked in
the neighbouring state.

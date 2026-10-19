# Action bar removal — case-by-case integration plan

**Date:** 2026-08-27 · **Decision (user):** remove the action-bar concept entirely; every page owns its actions inline. Deletion map of the old system: `cab-page-action-bar.md` §1. Audited read-only; line numbers are as of the audit — re-grep before editing.

## 0. Findings that shape the plan
- `components/navigation/ContextualActionBar.tsx` (2274 ln) is already orphaned — nothing imports it.
- CTA test-ids are `cab-{actionKey}` not `cab-{segmentKey}`, so `e2e/checkout-cab-steps.spec.ts` asserts ids that never existed (`cab-backToEvent`, `cab-ctaHold`).
- `event-preview-link` no longer exists; `event-builder.spec.ts:151`, `event-builder-preview.spec.ts:75,85`, `event-location-preview.spec.ts:164` are already broken.
- **The bar is the ONLY "Get tickets" on the public event page**: `EventDetail.tsx:592-596` passes `ctaLabel`/`ctaHref`, `EventContent.tsx:88-89` destructures and never renders them. Also the only trigger for the volunteer sheet (`VolunteerSection.tsx:316-505`), the only Suggest-edit for community listings, the only View-order on checkout confirmed, the only claim/dispute/share/report on venue pages, the only Report on human/org pages, the only mobile support entry point, the only View-live in the page editor.
- 38 `useCABAction` + 41 `useCABData` calls across 16 files. 80 `cab.*` i18n keys per catalog; six are reused by page copy (`cab.moreActions`, `cab.scanTicket`, `cab.attendees`, `cab.volunteers`, `cab.compTickets`, `cab.editEvent`).

## 1. Inventory (twin = inline equivalent already exists at all widths)

| Surface | Action | Twin | Work |
|---|---|---|---|
| Event detail `EventDetailCABBridge.tsx` | `addToCalendar` | ✅ `EventContent.tsx:880-885` `CalendarDropdown` | delete bridge copy |
| | `openDirections` | ✅ `event-location-directions` (mobile) / `-desktop` | delete `cab-sheet` placement |
| | `rsvp*` | ✅ `RsvpButton` `event-rsvp-section` | — |
| | `suggestEdit` | ❌ | secondary `Button` in `communityAttribution` slot (`EventContent.tsx:1116`), testid `event-suggest-edit-btn` |
| | `getTickets` (`SeriesTicketDatePicker.tsx:91`) | ❌ | **primary Get-tickets `Button` from `ctaLabel`/`ctaHref`**, `data-testid="event-get-tickets-btn"` (the picker's focus-return and `public-series-date-overlay.spec.ts:99,128` expect that id); when `seriesDates.length >= 2` open the series picker (lift `openOverlay` to a prop) |
| `VolunteerSection.tsx` | `openVolunteerSheet` | ❌ | primary `Button` at top of the section, testid `volunteer-open-sheet-btn` |
| Checkout `CheckoutCABBridge.tsx` | `ctaHold` | ✅ `CheckoutTicketsStep.tsx:103-141`, `CheckoutSidebar.tsx:90-132` | testids |
| | `ctaContinue` | ◐ `CheckoutDetailsStep.tsx:312-352` desktop; `MobileCTABar` ≤900 | testids |
| | `ctaViewOrder` | ❌ | primary "View order" in `CheckoutConfirmedStep.tsx` → `/my-tickets/{orderId}`, testid `checkout-view-order-btn` |
| | `backTo*` | ✅ `CheckoutInfoBar.tsx:69`, `CheckoutStepper.tsx:117-134` | testids `checkout-back-to-event`, `checkout-step-{id}` |
| Search `UniversalSearchPage.tsx` | `openFilters`/`openSort` | ✅ chips `search-filters-toggle`/`search-sort-toggle` | — |
| | `clearSearch` | ◐ | outline `Chip` + `X` in the chip row (`:2382`), testid `search-clear-all`; **fix the outside-click carve-out `:2178-2189`** that ignores clicks inside `[data-testid=contextual-action-bar]` |
| Venue `VenueCabActions.tsx` | follow / directions / request-to-book | ✅ `PlaceHero.tsx:187-209` | — |
| | claim / dispute / share / copy link / report | ❌ | `RowActionMenu` `⋯` in `PlaceHero` `.heroActions`; move dialogs + `showSignInOverlay({redirect})` handlers with them |
| Human/Org `EntityCabActions.tsx` | follow / share / copy | ✅ `FollowButton`, `ProfileShareButton` | — |
| | report | ❌ | `⋯` (Report) in `HumanHero`/`OrgHero`, or fold into `ProfileShareButton` menu |
| Admin `AdminShell.tsx:96` | `createEvent` | ◐ Events/Dashboard have it; Orders/Settings don't (and never did ≤959) | drop |
| `TeamView`, `PaymentsView`, place editor `placeSave`, `PageEditorView` `peSave` | | ✅ | drop registrations |
| `PageEditorView` `peViewLive` | | ❌ | ghost `ExternalLink` button in `EditorToolbarRow` (`:1850-1942`), testid `entity-page-view-live` |
| `GlobalOverlays` `openSpotlight`/`goToMyTickets`/`query` | | ✅ navbar (`navbar-search-trigger`, `navbar-my-tickets`) | delete |
| `SupportWidget` `support` | | ◐ desktop bubble only | show the bubble on all viewports; `OrderDetail.tsx:786` reads `useCABActionSnapshot().get("support")` → replace with `useSupportChatAvailable()` |
| Builder `EventBuilder.tsx:2592-2664` | `ebSave/ebPublish/ebUnpublish/ebPreview/ebViewLive/ebShare` | ❌ (rendered from the store) | page-owned `Button`s in `BuilderHeaderBar` — see §2 |

## 2. Builder header
Handlers: `ebSave`→`requestSave()`; `ebPublish`→`handlePublish()`; `ebUnpublish`→`handleUnpublish()`; `ebPreview`→`handleViewModeChange(toggle)` (in place); `ebViewLive`→`window.open('/events/'+slug,'_blank','noopener,noreferrer')`; `ebShare`→`setShareOpen(true)`.
Matrix: DRAFT+editor → `[Preview] [Publish] [Save]`; PUBLISHED+editor → `[View event] [Share (if shareableCount>0)] [Unpublish] [Save]`; viewer → none (`canEditEvent` false). Gates: `ebShowPublish = canEditEvent && DRAFT && !blockedByStripeConnect`; `ebShowPreview = canEditEvent && data && !PUBLISHED`; `ebShowUnpublish = canEditEvent && PUBLISHED`; loading `isSaving` / `publishMutation.isPending` (labels `cab.saving`/`cab.publishing`); Publish `aria-describedby={readinessBlockerListId}`.
Test-id aliases to keep: `event-save-btn`, `event-publish-btn`, `event-preview-btn`, `event-unpublish-btn`; new `event-view-live-btn`, `event-share-btn`. Pass the six as ONE pre-rendered `actions` node (memo boundary; `EventBuilderRenderIsolation.test.tsx`). `@th/ui Button onPress` ONLY — never also `onClick`. Sticky root keeps inline `position:sticky; top:0; zIndex:100` and `stickyTopBarRef`.

## 3. Deletion list (Phase 3)
`components/navigation/contextual-action-bar/**` (20 files), `page-action-bar/**`, `ContextualActionBar.tsx`, `EventDetailCABBridge.tsx`, `event-detail-cab-keys.ts` (+test), `CheckoutCABBridge.tsx`, `VenueCabActions.tsx`/`EntityCabActions.tsx` (folded into heroes; rename their tests), `bar-configs.test.ts`, `spotlight-cab-integration.test.ts`, `PageActionBar.test.tsx`; `AppShell.tsx` bar + `--page-action-bar-top`; `AdminShell.tsx` bar + `createEvent`; `DirectionsDropdown` `cab-sheet` branch; `navbar-offset-store.ts` + `ScrollAwareNavbar` publishing (zero readers after); `e2e/cab-draggable.spec.ts`; `spotlight-cab-cta.spec.ts` → navbar-search + ⌘K spec; `eslint-hex-allowlist.mjs:117-122`; un-mock in `AdminShell.test.tsx`, `TeamView.test.tsx`, `PageEditorViewPreviewToggle.test.tsx`, `EventBuilderPreviewToggle.test.tsx`, `EventBuilderRenderIsolation.test.tsx`, `places/[placeId]/edit/__tests__/edit-page.test.tsx`. Stale comments: `MarqueeBand.tsx:88`, `SavedStrip.tsx:31`, `CategoryTagsSection.tsx:822`, `UnifiedScanView.tsx:289`, `PlacePageHeader.tsx:82-84`, `CheckoutMobileCTA.tsx:34-36`, `MobileCTABar.tsx:73-79`.

## 4. Phase 4 — i18n + help
Rehome the 6 reused keys; rename live labels `cab.*` → `pageActions.*`; delete orphans — LAST, compiler-driven. Help: delete `getting-started/the-action-bar.md`; edit `community-listings.md:17,70,82`, `volunteer-at-an-event.md:12,21`, `faq.md:113,131-133` (delete the drag/keyboard Q&A), `booking-requests.md:38`, `claim-your-venue.md:63`, `performer-mode-and-booking-requests.md:47,49`, `check-in-scanning.md:25`; drift-sweep via `help-center-authoring`.

## 5. Order
Phase 0 free deletions → Phase 1 inline controls per page (bar stays mounted; duplicates tolerated) → Phase 2 test-ids + e2e retargets (gate: e2e green with the bar still mounted) → Phase 3 delete (gate: tsc + unit + e2e) → Phase 4 i18n/help/docs.

## 6. Progress (2026-08-27, this session)

**Done — Phase 1 (event detail + checkout), verified `apps/web` tsc 0, 292 tests green:**
- `EventContent.tsx` now renders the **Get-tickets CTA** from `ctaLabel`/`ctaHref` (they were passed in and silently dropped): `Link`+`Button tag="span"` idiom, `data-testid="event-get-tickets-btn"`, sticky bottom band on mobile (inline `position: sticky`; RNW strips it from styled stacks). New `onCtaPress` prop on `EventContentProps`.
- `SeriesTicketDatePicker` is now **controlled** (`open`/`onOpenChange`/`initialSlug`); `useCABAction("getTickets")` removed. `EventDetail` owns `seriesPickerOpen` and passes `onCtaPress` when `seriesDates.length >= 2`.
- `VolunteerSection` rendered ONLY a `BottomSheet` — no trigger existed. It now renders a heading + subtitle + **`volunteer-open-sheet-btn`**; `useCABAction`/`useCABData` removed.
- Checkout testids added: `checkout-hold-btn`, `checkout-sidebar-hold-btn`, `checkout-continue-btn`, `checkout-back-to-event`, `checkout-step-{id}`, `checkout-view-order-btn`.
- **Audit correction:** the confirmed step already HAS a view-order button — it lives in `OrderConfirmation.tsx:1004-1013` (`/my-tickets/{orderId}`), not in the thin `CheckoutConfirmedStep` wrapper the audit grepped. No new button was added, only the testid.
- `CheckoutCABBridge.tsx` deleted + unmounted from `Checkout.tsx`.
- e2e: `checkout-cab-steps.spec.ts` → **`checkout-steps.spec.ts`**, retargeted AND its assertions rewritten — the mechanical rename left false assertions, because `checkout-back-to-event` and the stepper are always mounted (unlike the old bar segments); step state is now asserted via the stepper. `checkout-journey.spec.ts` / `checkout-to-settlement.spec.ts` now click `event-get-tickets-btn`. `.last()` dropped in `public-series-date-overlay.spec.ts`.

**Not started (the rest of Phase 1 → 4):** entity hero `⋯` menus (`VenueCabActions`/`EntityCabActions` — claim/dispute/share/copy/report have no inline home), suggest-edit button, search `search-clear-all` chip + the outside-click carve-out, page-editor View-live, support bubble on mobile + `OrderDetail`'s `useCABActionSnapshot` read, **the builder header re-hosting its six actions** (still rendered by `PageActionBar` from the store), the admin registration deletions, then Phases 2–4 (e2e retargets, deleting `contextual-action-bar/**` + `page-action-bar/**`, i18n `cab.*` rename, help-article rewrite).

**Trap found by driving it:** `ActionBarCTA.tsx:15-22` aliases action keys to page test-ids (`getTickets` → `event-get-tickets-btn`, `ebSave` → `event-save-btn`, …). So the moment a page grows its own control with the "expected" testid, TWO elements carry it and strict-mode locators break. Fixed by deleting the event config's `cta` segment. **Check this alias map before adding any page-owned control during Phases 1–2**, since the bar stays mounted until Phase 3 — the same collision is waiting for `event-save-btn`/`event-publish-btn`/`event-preview-btn`/`event-unpublish-btn` when the builder header re-hosts its six actions.

**Verified after the event/checkout work:** `apps/web` tsc 0 · vitest 410/411 suites (the one failure, `src/config/__tests__/next-config.test.ts`, is a pre-existing esbuild/jsdom environment invariant unrelated to this work — it fails to load, 0 tests run) · exactly one `event-get-tickets-btn` in the rendered event page · click reaches `/events/checkout/...`.

### Progress 2026-08-28 — builder + admin registrations

- **Builder header owns its six actions.** `BuilderHeaderBar` is now its own sticky bar (plain `<div>`, INLINE `position: sticky; top: 0; zIndex: 100` — RNW strips sticky from styled stacks); `PageActionBar` is gone from it. `EventBuilder` renders Preview / View event / Share / Publish / Unpublish / Save as `@th/ui` `Button`s (`onPress` only) inside ONE memoised `headerActions` node, so `BuilderHeaderBar`'s memo bail-out survives title keystrokes. Gates unchanged from §2. Publish takes `aria-describedby` directly, so `ebPublishBlockersId` is now a plain local (`publishBlockersId`). Test-ids preserved: `event-save-btn`, `event-publish-btn`, `event-preview-btn`, `event-unpublish-btn`, plus new `event-view-live-btn` / `event-share-btn`. `draftPreviewHref` is KEPT — a keyboard handler still uses it.
- **All remaining admin registrations deleted** (`AdminShell` `createEvent`, `TeamView` `inviteMember`, `PaymentsView` `viewPayouts`, place editor `placeSave`) — every one had a real inline twin.
- **Place-editor tests de-coupled from the store.** They drove the save through a `CabProbe` reading `cab-store` and `matchRoute`; they now click the page's own Save button (found by label — the real Tamagui `Button` does not forward `data-testid` through this suite's mocks) and assert `disabled` for the pristine/loading states. The double-submit latch coverage is intact.
- Verified: `apps/web` tsc clean for every file touched (one unrelated error in `packages/ui/.../TicketWalletCard.tsx`, mtime 12:39, another workstream) · `src/app/admin` + `src/components/navigation` **2659 tests / 139 files green**.

Remaining Phase 1: entity hero `⋯` menus (venue claim/dispute/share/copy/report; human/org report), event-detail suggest-edit, search `search-clear-all`, page-editor View-live, support bubble on mobile + `OrderDetail`'s snapshot read. Then Phases 2–4.

### Progress 2026-08-28 (cont.) — the remaining page moves

- **Event detail suggest-edit** → `CommunityListingNotice` gained a `suggestEditHref` prop and renders the link beside the community byline (the only place on the page that frames the listing as community-run). `data-testid="event-suggest-edit-btn"`.
- **Search** → new `search-clear-all` outline chip (shown when there is a query, a geo location, or selected categories), calling the existing `handleClearSearch`. All four registrations deleted. **The outside-click handler's carve-out for `[data-testid=contextual-action-bar]` was re-pointed at the chips** (`search-filters-toggle`, `search-sort-toggle`, `search-clear-all`) — without that the Filters panel closes in the same tick its own chip opens it.
- **Page editor** → `entity-page-view-live` ghost button in `EditorToolbarRow`, gated on `page.slug`. The `peSave` proxy (which clicked `[data-entity-page-save]`) is deleted — the per-section save buttons were always the real controls.
- **Support** → the launcher bubble now renders at EVERY width (it was desktop-only purely because it overlapped the old full-width dock), lifted to `calc(89px + safe-area)` on phones to clear the bottom nav. New exported `useSupportChatAvailable()` replaces `OrderDetail`'s `useCABActionSnapshot().get("support")` read; the viewport-branched copy collapses to one string since `orderDetail.helpChatMobile` described the deleted "… menu in the bottom bar".

Verified: `apps/web` tsc clean for every touched file · full suite **410/411** (the one failure, `src/config/__tests__/next-config.test.ts`, is the pre-existing esbuild/jsdom invariant; `ImageCropDialog` flaked once under parallel load and passes in isolation).

Still open: entity hero `⋯` menus (in progress), then Phases 2–4.

### Progress 2026-08-28 — Phase 1 COMPLETE, Phase 2 started

**Entity heroes (last Phase 1 item).** `VenueCabActions` → `PlaceHeroActions`, `EntityCabActions` → `EntityHeroActions`; both unmounted from the page bottom in `EntityPageShell` and remounted as the last child of the hero action row (`PlaceHero`, `HumanHero`, `OrgHero`). Each renders a `RowActionMenu` "⋯": venue = Share / Copy link / Claim (claimable) / Request transfer (already claimed) / Report; human+org = Copy link / Report (Share stays as the visible `ProfileShareButton`). Sign-in overlay handlers and all dialogs carried over verbatim. New ids are `place-hero-*` / `entity-hero-*`, checked against the alias maps for collisions. The component's duplicate `DirectionsDropdown` (the last `placement="cab-sheet"` caller on this surface) and a second, unopenable `BookingRequestDialog` were dropped. `.heroOverflow` in `place-entity.module.css` forces the 44px target over `RowActionMenu`'s inline 32×32 — the one `!important` in that file; the durable fix is a `size` prop on `RowActionMenu`.

**Regression caught and fixed:** the morning's merge deleted the builder header's new-tab draft preview, and the bar's `ebPreview` is an IN-PLACE toggle while `ebViewLive` only appears once PUBLISHED — so "open the draft in a new tab" survived only as a keyboard shortcut. Restored as an icon-only button (`event-preview-link`, `aria-label` = `admin.ebPreviewNewTab`) shown alongside Preview on non-published events. `event-builder.spec.ts:151`, `event-builder-preview.spec.ts:75,85` and `event-location-preview.spec.ts:164` therefore need NO retarget.

**Phase 2 so far:** `e2e/cab-draggable.spec.ts` deleted (drag, anchors, `th:cab-anchor` — the premise is gone). `spotlight-cab-cta.spec.ts` → `spotlight-search.spec.ts`, retargeted from the bar's last-role-button locator to `navbar-search-trigger`; the ⌘K half was already bar-independent.

Verified: `src/app/p` + `src/components/navigation` **578 tests green**, builder **908 green**, `apps/web` tsc clean for every touched file.

### Review fixes 2026-08-28 (entity heroes)

- **[BLOCKING, fixed] Freeform layouts lost Report / Claim / Share.** The old islands mounted from `EntityPageShell`, which runs for EVERY layout; the heroes only render when `effectiveLayout === "standard"` (`EntityPageContent.tsx:87,97,107`). So a venue whose owner picked `stack`/`grid` could no longer be reported or claimed from its public page. Fixed by mounting `PlaceHeroActions` / `EntityHeroActions` in the freeform branch too, beside `PlaceOwnerRow`. **Lesson for the rest of this migration: check every layout/variant a surface has before assuming one mount point covers it.**
- **[WARNING, fixed] The new focus ring was inert** — `RowActionMenu`'s trigger sets `outline: "none"` INLINE, which an author rule cannot beat, so the 44px trigger had no visible focus indicator while its row siblings did. Now `!important`, with the reason in the CSS. The dead `color:` rule beside it (same cause) was removed.
- **Still open from that review, worth doing before Phase 3:** `ProfileShareButton` swallows every `navigator.share` rejection with no clipboard fallback, whereas the moved `share()` distinguishes `AbortError` from real failures — lift the AbortError-aware fallback into a shared `shareOrCopy(url, title)`. Human/org heroes show both Share and Copy link, which collapse to the same action on browsers without `navigator.share`. Test gaps: `share` branches, signed-out dispute, and that the heroes pass `entity.id` (not `page.id`) as `subjectId`. Stale prose in `PlaceOwnerRow.tsx:40-43,54`. Dead `shareUrl` prop on both components.

**Browser (1280):** menu button 44×44 at the end of the hero row after Request-to-book / Follow / Get-directions; menu opens with Share · Copy link · Request transfer · Report, fully on-screen; **no action bar renders on `/p/` any more** (every entity-page segment is dark now that no island publishes `venueActionsReady`/`entityActionsReady`). Zero JS console errors. **The 320px pass is NOT yet valid** — the run reported `scrollWidth: 500`, i.e. Chrome floored the window and the layout was never actually 320 wide; re-running with proof-of-viewport first.

### 320px verification — partial, and a dev-server caveat

Measured on a **proven** 320 layout (`innerWidth` 320, `clientWidth` 320, `visualViewport` 320 — the earlier run reporting `scrollWidth: 500` was Chrome flooring the window, so those numbers described a ~500px page and were discarded):

- Venue hero action row wraps to three rows: `REQUEST TO BOOK` (38→274) · `Follow` (38→162) · `GET DIRECTIONS` (38→222) + `More actions` (234→278). **The ⋯ is not orphaned** — it sits beside Get directions, 44×44, right edge 278 < 320.
- `documentElement.scrollWidth` 326 vs 320 — a **6px overflow, entirely in the FOOTER** (the Platform / Company link columns, left 214→699 etc.). Nothing in the hero exceeds 320. Pre-existing; this work did not touch the footer. Worth a separate fix.
- **Menu open/close could NOT be verified**: the page was not hydrated (no React fiber on ANY element — navbar search, Follow, Directions and the ⋯ trigger all cold), and the dev server then stopped responding entirely (`/` timed out at 60s; two `next dev` processes running, ~20 Chrome tabs holding HMR sockets). That is an environment failure, not a defect signal — the earlier healthy-server run at 1280 opened the menu and listed Share · Copy link · Request transfer · Report, on-screen. **Re-verify menu open at 320 after a dev-server restart.**

Geometry above is trustworthy (it comes from SSR'd layout, which needs no hydration); interaction is not.

**Menu-interaction check still outstanding — blocked on dev DATA, not code.** After restarting the API (it had died on a transient Neon connection timeout; `tsx watch` never retries, so it stayed dead), the API is healthy (`/health` 200) and Neon is reachable — but every entity page and event now 404s with `PAGE_NOT_FOUND` / `getPublicPage failed`, including URLs that rendered fine earlier in the same session. The dev database appears to have been emptied mid-session. Per CLAUDE.md the likely cause is an e2e run without `E2E_USE_LIVE_STACK=1` (that harness `deleteMany`s every order, event, org and auth user). **Not reseeded — CLAUDE.md says to stop and ask rather than run a reset.** Once the DB has data again, the one remaining check is: open the venue hero ⋯ at 320 and confirm the menu renders on-screen with Share · Copy link · Claim/Request transfer · Report.

---

## 7. DIRECTION CHANGE 2026-08-28 — the bar comes back, as a MOBILE BOTTOM NAV

**User decision:** "We should have a mobile bottom nav bar like we do on our admin page. That is where those buttons/actions should live on mobile. We should just repurpose the CAB bar to be that mobile interface."

This **partially reverses §3's deletion list.** Do NOT delete `contextual-action-bar/**` wholesale — its route→action resolution becomes the data source for one slot in the new bar.

**Shape (settled):**
- Consumer shell (`AppShell`) gains a fixed bottom bar **below ~960px only**. Desktop is unchanged — every action stays inline on its page, which is the whole point of Phase 1 and why the old floating bar felt wrong.
- Contents mirror admin's `NavigationBottomBar`: fixed destinations (Home · Search · My tickets · Account) **plus ONE raised centre slot that is page-contextual** — Get tickets on an event, Request to book on a venue, the step primary in checkout.
- Secondary actions (Share, Copy link, Report, Directions, Suggest edit…) stay where Phase 1 put them: inline on the page / in the hero `⋯`. The bar carries navigation and ONE primary action, nothing more.

**What survives from the old system:** `cab-store` (`useCABAction`) as the registration channel for that single centre action, and `bar-configs` route matching to pick it. **What still dies:** the floating/draggable dock, `cab-anchor`, the overflow `…` machinery, `PageActionBar`, and every desktop rendering.

**Why the consumer shell had no bottom bar to begin with:** `AppShell` never rendered one (grep: zero `NavigationBottomBar` references) — which is also why the newly-universal support bubble had nowhere to sit and ended up covering the venue hero's `⋯` (measured: `elementFromPoint` at the trigger centre returned `support-launcher`). Fixed by measuring `[data-testid="navigation-bottom-bar"]` and only lifting the bubble when a bottom bar actually exists — that measurement now becomes correct on consumer mobile too, once this bar ships.

### 2026-08-28 — Support becomes a bar destination

**User decision:** Support is a bottom-bar destination, not a floating bubble.

Tabs are now **Home · Search · Tickets · Support** plus the contextual centre action. **Account was dropped from the bar** — it already lives in the top navbar's avatar menu, and a fifth tab does not fit beside the 64px centre square at 320px (measured: four tabs + square + gaps = 291 of 320). Flip that in one line if you'd rather trade Tickets or Search for Account.

The Support tab's `route` is a sentinel (`"#support"`); `onSelect` intercepts it and calls the open-panel action the widget publishes through `cab-store` (`useCABAction("support", openPanel)` — the same channel, restored). The bubble is desktop-only again and gated on `useIsCompactViewport()` (960), exactly complementary to the bar, so the two can never co-exist. The `bottomNavHeight` measurement added earlier is deleted — with no mobile bubble there is nothing to lift.

**Driven at 320:** tabs read `Home · Search · [Request to book] · Tickets · Support`; `support-launcher` absent; `elementFromPoint` at the venue hero's ⋯ now returns `place-hero-actions-menu` (it was `support-launcher` — the collision is gone); tapping Support opens `support-widget-panel` in place with no navigation and no hash change; `scrollWidth` 320. Tests: navigation + support + i18n **1462 green**, `apps/web` tsc 0.

### Freeform entity layouts — accepted gap, future work
`stack`/`grid` venue pages get **no centre action** (`HeroBookingRequestButton` only mounts on the standard template). User: freeform setup is a later idea. Their inline `request_to_play` block is unchanged, and Report/Claim reach them via the hero `⋯` mounted in the freeform branch. Revisit when freeform is designed properly.

### Still to do — page by page
The CAB's remaining route configs have not all been reconciled against what each page now owns. Continue surface by surface: what action does this page have, does it belong inline, in the centre slot, or nowhere. Then delete `bar-configs` entries that no page publishes, `PageActionBar`, `cab-anchor`, and the dock rendering — keeping `cab-store` (it now carries `mobilePrimary` and `support`).

### Mobile top bar — approved design (2026-08-28)

Artifact: https://claude.ai/code/artifact/d5d0677b-a228-4b9e-9586-f2de4320e7ba (frames are live HTML at true 320px).

Once the bottom bar took navigation, the mobile top bar was left with a 38px wordmark and two preference toggles, one of which spends ~100px spelling "English". Approved shape — **two jobs only: identity, then account.**

- Height **68 → 56px** (the value the design system already specifies for the top register).
- Wordmark gets its full lockup (~120px).
- **Sign in stays top-right**, same ghost atom as desktop; signed in it becomes the avatar **in the same slot**, so the bar never changes shape between states.
- Theme + language move into a **hamburger menu**, grouped **Browse** (Features · Help Centre · About · Contact) / **Preferences** (Theme and Language, each showing its current value) / **Organisers** (Dashboard). Three groups is the ceiling. Nothing in it duplicates the bottom bar.

Build scope when picked up: `AppNavbar`'s mobile `ActionGroup` drops the theme + language controls and gains the hamburger; add the drawer. The Browse links already exist in `AppFooter` — that group is rewiring, not new content.

---

### Progress 2026-08-28 (cont.) — the last four route configs reconciled

`/search`, `/my-tickets`, `/events/checkout/*` and the Seller Hub are done. All
four resolve to `config: null` now. What moved where:

| Route | Verdict | Why |
|---|---|---|
| `/search` | nowhere | `search-filters-toggle` / `search-sort-toggle` / `search-clear-all` are page-owned at every width. **The bar's copies were rendering but inert** — `UniversalSearchPage` stopped publishing `openFilters` / `openSort` / `clearSearch` when they moved inline, so the strip served a dead "Filters" chip beside the page's live one. Its `query` chip was worse than dead: the only remaining `useCABData("query")` publisher is `GlobalOverlays`, so it displayed the **spotlight's** last query, not this page's. |
| `/events` · `/events/search` | nowhere | Both are bare `redirect()`s to `/search` and duplicated the search config verbatim. |
| `/events/checkout/:rest*` | centre slot (already) | Every segment was gated on a `co*` data key and `CheckoutCABBridge` was deleted in the first Phase-1 pass — zero publishers since. The step primary already rides `useMobilePrimaryAction`; back/step/hold/continue/view-order are all inline. |
| `/my-tickets` · `/my-tickets/:rest*` | nowhere | `count` duplicates the page's "N orders"; `upcoming`/`past` were never published (the wallet renders both as sections, there is no filter); `showQr` was never published (every card renders its QR inline); `backToTickets` duplicates the page's back link **and** the bottom bar's Tickets tab; `findEvents` → `/events` → `/search` is the Search tab. |
| `/sell` · `/sell/:rest*` | nowhere | `SellerShell` is a `NavigationShell`: its own rail/drawer already carries Listings · Payouts · Claims. "New listing" is page-owned on `/sell/listings` (`ActionBar`), which is the page it acts on. `/sell/listings/new`'s `cta` had **neither `href` nor `actionKey`** — inert markup. |

**Widened `/my-tickets/:orderId` to `/my-tickets/:rest*`.** `…/refund`,
`…/resell` and `…/transfer` matched no rule at all, so they fell through to
`matchRoute`'s `__fallback` — brand + a "Find events" CTA pointing away from a
refund the user is mid-way through. Verified the fallback is real, not
theoretical: `/help` (also unmatched) renders a strip reading `FIND EVENTS`.

**This is why every one of these is `config: null` and not a deleted rule.**
Deleting the entry hands the route to `__fallback`, which is *more* chrome, not
less. Same trap as an empty `segments: []`.

#### Found only because the bar was carrying it
- **`/sell` gets two bottom bars on a phone.** `AppChrome`'s
  `shouldBypassAppShell` only bypasses `/admin` and `/platform`, so the Seller
  Hub renders `SellerShell`'s `NavigationShell` **inside** `AppShell` — and
  `ConsumerBottomNav`'s `HIDDEN_PREFIXES` did not list `/sell`. Measured at 320
  on `/sell/listings`: consumer navbar + consumer bottom bar both present.
  `NavigationShell` renders its own `NavigationBottomBar` at that width, so a
  gate-ON Seller Hub stacks two, and `AppShell` reserves 96px of clearance for a
  bar the page is already reserving for. **Fixed** by adding `/sell` to
  `HIDDEN_PREFIXES` (+ a test). The deeper question — whether `/sell` should be
  in `CUSTOM_SHELL_PREFIXES` alongside `/admin` — is untouched.
- **`PageActionBar`'s `SIGN_IN_BUTTON_STYLE` is dead.** The signed-out mobile
  sign-in CTA it styles has no render site left; only the const survives. Dies
  with the file in Phase 3.
- **`GlobalOverlays`' `goToMyTickets` registration has zero readers** — no
  config referenced it even before this pass. `openSpotlight` now survives in
  exactly one config (`/events/category/:slug`); `query` in none.
- `hideAtOrBelowWidth` is now **admin-only** (checkout was its one consumer
  user). `requiredFeatureGate` is down to one config, `/events/resale/:listingId`.

#### Newly orphaned `cab.*` i18n keys (Phase 4, not deleted here)
`cab.filters` · `cab.sort` · `cab.past` · `cab.showQr` · `cab.listings` ·
`cab.payouts` · `cab.claims` · `cab.newListing` · `cab.createListing` ·
`cab.backToEvent` · `cab.backToTickets` · `cab.backToDetails` ·
`cab.holdTickets` · `cab.continueToPayment` · `cab.viewOrder`.

#### Tests re-pointed
`bar-configs.test.ts` used `/search`, `/events`, `/my-tickets` and `/sell/*` as
its "route with a config" fixtures; `PageActionBar.test.tsx` defaulted its
pathname to `/search`; `useActiveBarConfig.test.ts` used `/sell*` for both
`resale`-gate directions. All re-pointed at routes whose bars are still real
(`/events/category/music`, `/events/resale/:listingId`), with the null-config
routes asserted as a table. Added: the Seller Hub stays bar-free **even with the
gate on**, and `ConsumerBottomNav` renders nothing on `/sell`.

**Verified.** `apps/web` `pnpm exec tsc --noEmit` → 0. Full suite **411/412
files, 6998 tests green** (the one failure is the standing
`src/config/__tests__/next-config.test.ts` esbuild/jsdom invariant — the file
fails to load, 0 tests run). Driven in Chrome at a **proven** 320 (`innerWidth`,
`clientWidth` and `visualViewport` all 320 via device-metrics emulation —
`resize_page` floors the window at ~500 and silently lies) and at 1280:

- `/search` — no strip at either width; filters/sort/clear present and the
  Filters panel opens and *stays* open at 320 (the outside-click carve-out is
  correctly pointed at the chips); `scrollWidth` 320; zero console errors.
- `/my-tickets` — no strip; wallet renders; bottom bar `HOME · SEARCH · TICKETS
  · SUPPORT` with Tickets lit and **no centre square**; `scrollWidth` 320.
- `/my-tickets/:orderId` — no strip; QR inline; "BACK TO MY TICKETS" present.
- `/my-tickets/:orderId/refund` — no strip (was `__fallback`).
- `/events/checkout/...` — no strip at either width; stepper + back-to-event
  inline; on selecting a ticket at 320 the centre slot lights up as a raised
  `HOLD TICKETS` square (`consumer-bottom-nav-primary`, 64×64, on-screen) and
  the bar reads `HOME · SEARCH · [HOLD TICKETS] · TICKETS · SUPPORT`.
  `scrollWidth` 320, zero console errors.
- **`/sell*` NOT driven** — `resale` is off in dev, so the tree `notFound()`s
  (measured: `/sell/listings` renders PAGE NOT FOUND). Flipping it needs
  `ENABLE_RESALE=true` and an API restart, which was judged not worth
  destabilising a live dev stack for a dark surface. Its `config: null` is
  covered by unit test; the *rendering* consequence is the same code path
  proven on the four routes above.

Pre-existing, untouched, worth a separate look: `/help/**` still falls through
to the `__fallback` bar, and `MY TICKETS` breaks mid-word ("MY TICK ETS") in the
h1 at 320.

Remaining: the rest of the route configs (`/events/category/:slug`,
`/events/resale/:listingId`, `/account*`, `/admin/**`, `/about`, `/contact`,
`/lucky`, `/unsubscribe`, `/places/new`), then Phase 3's deletions
(`PageActionBar`, `cab-anchor`, the dock rendering — keeping `cab-store`) and
Phase 4's i18n/help sweep.

### Mobile top bar — BUILT 2026-08-28

`src/components/navigation/MobileNavMenu.tsx` (new) + `AppNavbar.tsx`. The mobile `ActionGroup` drops `ThemeToggleButton` and `LanguageSwitcher` and gains a hamburger (`navbar-menu`); the menu is a portaled full-screen sheet with `role="dialog" aria-modal`, Escape-to-close, body-scroll lock, and focus captured on open / restored to the trigger on close.

Groups exactly as designed: **Browse** (Features · Help Centre · About · Contact) / **Preferences** (Theme and Language, each row showing its current value) / **Organisers** (Dashboard). Home, Search, Tickets and Support are deliberately absent — the bottom bar has them.

**Measured before → after at 320px:** wordmark **38px → 150px** (it only ever needed the space back); top-bar controls **4 → 3** (brand · Sign in · Menu); `scrollWidth` 320, no overflow. Focus cycle verified in the browser: hamburger → dialog → hamburger.

Height is still 64px, not the DS's 56 — that lives on the shared `@th/ui` `Navbar` (`paddingVertical: $3`, `minHeight: 64`) and would move desktop too, so it was left alone. Worth a `compact` variant on that component later.

New i18n keys (en + es): `common.menu`, `menuBrowse`, `menuPreferences`, `menuOrganisers`, `theme`, `themeLight`, `themeDark`, `language`, `footerHelpCentre`.

Verified: web vitest **6998 pass** (the 1 failing file is the pre-existing esbuild/jsdom one), `apps/web` tsc 0, eslint clean, colour gate 0 errors — it caught a real fallback drift (`--borderColor` fallback must be the Stub `#211C16`, since that is what SSR paints before the theme injector hydrates).

### Menu polish + owner block removed (2026-08-28)

**Standardized on `@th/ui` atoms.** `MobileNavMenu` was hand-rolled inline styles; the rows are now `ListItem` inside `ListItemGroup bordered`, group labels are `Text variant="overline"`, spacing is `YStack` gap tokens. Two things learned doing it:
- `ListItem`'s `trailingAccessory` renders inside `ListItemTrailingContainer`, which extends the **28×28 bordered icon box** — text put there is clipped. The standard slot for a value is `subtitle`, so Theme/Language read as title + value stacked.
- `tag="a"` rows inherit the global anchor treatment (underline + link colour). They need an explicit `textDecoration: none; color: inherit` reset, same trap as the ledger section tabs.

**Motion.** Sheet enters/exits on one `MOTION_MS = 220` constant (transform + opacity, `cubic-bezier(0.22, 1, 0.36, 1)`), staying mounted through the exit so it slides out rather than vanishing; groups stagger in 55ms apart in reading order. `usePrefersReducedMotion()` collapses every duration to 0 — no transition, no stagger, and the unmount timer follows the same value so they cannot drift.

**`PlaceOwnerRow` removed** from `PlaceEntityLayout` (standard) and `EntityPageContent` (freeform). "Request transfer" now lives in the hero `⋯`, so the block was a second, bulkier copy of an action the page already had. Still rendered on `/places/id/:placeId` via `ClaimVenueCta` — that route has no hero `⋯`, so it keeps the claim/transfer entry point.

Verified: web vitest **6998 pass**, tsc 0, eslint clean, colour gate 0 errors, driven at 320 (links un-decorated `rgb(33,28,22)`, values stacked, no overflow).

### Checkout — design audit (2026-08-28)

Artifact: https://claude.ai/code/artifact/06a55ab7-e58a-4b4d-844c-ebb3be0c18cb — measured live at 320px, not a mock.

Findings, worst first: **global nav destinations render under the payment form** (4 tabs — checkout is the one surface where a stray tap is an abandoned cart); **the order summary opens empty** ("Select tickets to see your order total") above the fold, pushing the picker down; a **decorative event hero** (~130px) on a transactional page; **five type sizes** (10/12/13/14/15px) with the stepper labels at 10px, below the system's smallest rung; the **stepper reads as decoration** (4 steps in 279 of 320px, current step distinguished mainly by weight); and the shell **reserves a flat 96px for an 85px bar**.

Not findings: checkout already has zero stray border radii and one typeface throughout.

### Drawer conformance vs the DS folder (2026-08-28)

Artifact: https://claude.ai/code/artifact/f50ffc46-5729-4571-be3c-108b5aeb8f3e

The DS folder ALREADY specifies this component — `components/navigation/MobileNavSheet.{prompt.md,d.ts}` + `navigation.css:36-45`. What shipped diverges on eleven points, the big ones being: it **drops from the top** where the spec rises from the bottom (`translateY(100%)`, "the one sanctioned slide" — the thumb is at the bottom of the phone); **no scrim** where the spec has `rgba(33,28,22,.72)` and dismisses on scrim click; **full height** vs `max-height: 86vh`; **sans rows** vs mono/uppercase/tracked at the `fs-mono-sm` rung; **no current-item treatment** vs `--color-accent-wash` + `inset 3px 0 0 accent`; no `--shadow-4` (`10px 10px 0 rgba(33,28,22,.90)`); focus lands on the panel, not the first control; `z-index: 1400` instead of `--z-drawer: 300`; and my per-group stagger is not in the system at all (the folder sanctions ONE slide).

**Three places the spec cannot just be ported**, because our architecture moved after the folder was written: search is now a permanent bottom-bar tab (the spec puts it in the sheet head); sign-in moved to the top bar (the spec pins two actions in the foot); and four destinations are tabs, so the drawer is overflow (Browse / Preferences / Organisers), not the nav itself. Decide these rather than copying.

**Lesson worth generalising:** check the DS folder for an existing component spec BEFORE designing one. It had this drawer specified down to the easing curve.

### Drawer rebuilt to spec (2026-08-28)

`MobileNavMenu` now conforms to the folder's `MobileNavSheet`. Driven at 320 and measured:

| Spec | Verified |
| --- | --- |
| Rises from the bottom, `translateY(100%)` | panel pinned to viewport bottom |
| Scrim `rgba(33,28,22,.72)`, dismisses on click | `rgba(33, 28, 22, 0.72)`, scrim click closes |
| `max-height: 86vh` | height ≤ 86% of viewport, page visible behind |
| `--shadow-4` hard offset | `rgba(33,28,22,0.9) 10px 10px 0px` |
| Mono / uppercase / tracked rows | `plexMono`, `text-transform: uppercase` |
| Focus the FIRST CONTROL on open | `mobile-nav-menu-close`; restored to `navbar-menu` on close |
| One slide, `240ms cubic-bezier(.2,.8,.3,1)` | stagger removed; `MOTION_MS = 240`, `EASE_OUT` |
| `--z-drawer` | 1350 (`zIndexTokens.drawer`; inlined — that module is not re-exported from `@th/ui`) |

Current route carries `$accentSoft` + `inset 3px 0 0 accent`. `ListItem` was dropped here: its row is sans by design, and the sheet's rows are specified mono — the standard atom was the wrong atom for this surface.

Departures from the folder, deliberate and recorded: **no search in the head** (permanent bottom-bar tab now), **no pinned foot actions** (sign-in is in the top bar), **link list is overflow** (Browse / Preferences / Organisers) rather than the primary nav.

Verified: web vitest **6999 pass** (1 pre-existing esbuild/jsdom file), tsc clean for touched files, eslint 0, colour gate 0 errors. Test mocks needed `usePathname` (`next/navigation`) and `useLocale` (`@th/ui`) added.

### Drawer — OUTSTANDING (handoff 2026-08-28)

Conformant already: bottom origin, scrim + click-dismiss, 86vh, `--shadow-4`, mono rows, focus-first-control + restore, one 240ms slide, z-drawer, accent-wash current route. Still to do:

1. **Row separators are the wrong weight.** Spec is `--bw-hair` × `--color-border-soft` (repo `borderColorSoft` = `rgba(33,28,22,0.3)`); the code uses `var(--borderColor, #211C16)` — full ink, ~3× too heavy. The head's 2px ink border IS correct (`--bw-structure`).
2. **Spacing tokens.** Rows should be `--sp-4` padding + `--sp-3` gap; currently hardcoded `0 16px`, no gap. Head is `--sp-4`; code uses `$3`.
3. **`MobileNavSheet.jsx` was never read** — this was built from `prompt.md` + CSS only. Diff the reference implementation for anything the CSS doesn't express.
4. **No focus trap.** `role="dialog" aria-modal="true"` but Tab escapes the sheet.
5. **No test file.** Scrim dismiss, Escape, focus in/restore, current-route marking and reduced motion are browser-verified only. Mocks this component forces: `usePathname` (`next/navigation`), `useLocale` (`@th/ui`).
6. Dead `tone={current ? "default" : "default"}` no-op in `MenuRow`.
7. Breakpoint 960 vs the spec's 900 — decide and record.
8. `zIndexTokens` inlined as `1350` (not re-exported from `@th/ui`) — export it or keep the comment.

**Do NOT "fix" the three deliberate departures** (no search in head, no foot actions, list is overflow not primary nav) — reasons are recorded above.

### Drawer conformance closed out (2026-08-28)

All eight items above are done. Measured live in Chrome at 320×720, `t_stub`, `/help` loaded so a row is current:

| Item | Was | Now |
| --- | --- | --- |
| 1 · row separators | `1px var(--borderColor, #211C16)` — full ink | `1px rgba(33, 28, 22, 0.3)` on all seven rows; head still `2px rgb(33, 28, 22)` |
| 2 · spacing | `padding: 0 16px`, no gap; head `$3` | rows `padding: 16px` + `gap: 12px` over a 44px floor (measured 47px); head `padding: 16px`, `gap: $3` |
| 3 · `MobileNavSheet.jsx` | never read | diffed; findings in the component's header comment |
| 4 · focus trap | Tab escaped | Tab wraps last→first, Shift+Tab first→last, and pulls focus back if it has escaped |
| 5 · tests | none | `__tests__/MobileNavMenu.test.tsx`, 25 cases |
| 6 · dead ternary | `tone={current ? "default" : "default"}` | dropped — the folder marks the current row with background + inset bar, never with ink |
| 7 · breakpoint | undecided | recorded, not aligned — see below |
| 8 · z-index | bare `1350` | `tokens.zIndex.drawer`, read through the `tokens` bag |

Also fixed, unlisted: the current row's wash fell back to `transparent`. The fallback is what SSR paints, so the marking was invisible until hydration; it is now the Stub `rgba(226, 72, 29, 0.10)`. Verified live: current row paints `rgba(226, 72, 29, 0.1)` + `inset 3px 0 0 rgb(226, 72, 29)`, other rows nothing. Switching to `t_ember` re-resolves the separator to that theme's `rgba(90, 120, 166, 0.4)`, so the token reference tracks the theme rather than pinning to the Stub fallback.

**Reading `MobileNavSheet.jsx` changed nothing but confirmed four places we do MORE than the reference**, none of them a design departure: it puts `role="dialog"` on the outer wrapper (which contains the scrim) where ours is on the panel; it labels with `aria-label="Menu"` where ours uses `aria-labelledby` on a visually-hidden heading; it has no focus trap, no focus restore and no scroll lock; and it returns `null` the moment `open` goes false, discarding the exit half of the slide its own CSS animates. Its "focus the first control" is `querySelector('a,button,input')` — with search gone from our head, that resolves to the close button, which is what `firstControlRef` already points at. The scrim is now `aria-hidden` + `tabIndex={-1}`: it sits outside the dialog so the trap cannot reach it, and it was a second element in the a11y tree whose accessible name was "Close".

**Breakpoint — recorded, not aligned, and the premise was wrong.** The folder does not agree with itself: `prompt.md` says "the public nav below 900px", its own CSS switches the burger in at `max-width:1100px` (navigation.css:33). Ours is a third number, and it is not the 960 this list assumed: the sheet has no media query of its own, and the only thing that opens it is `AppNavbar`'s burger, which renders under `useIsMobile()` — **below 600px**. Deliberate, and staying: between 600 and 960 the top bar still fits the full action group (theme, language, notifications, create), so the sheet would have nothing to hold. Moving it to `useIsCompactViewport`'s 960 is a design change, not a conformance fix.

**Open, not fixed: the focus ring.** `tokens/focus.css` in the folder is emphatic — "ONE treatment, loud, everywhere. Non-negotiable", a 3px accent outline at 2px offset. It has never been ported: `globals.css` has exactly one `:focus-visible` rule (`.th-place-edit-link`), so every control in this sheet — and everywhere else — takes Chrome's default `rgb(0, 95, 204)` ring. Left alone deliberately: giving this one component the flame ring would make it the only surface in the app that has it. It is an app-wide port, and its own piece of work.

Verified: 25/25 new tests, 310/310 across `src/components/navigation`; each of five deliberately-planted regressions (full-ink separator, `0 16px` padding, `transparent` wash fallback, disabled trap, head back to `$3`) fails at least one test. `apps/web` tsc clean for every touched file, eslint 0 errors, colour gate 0 errors, zero console errors at 320px.

### The two items that were left open, closed (2026-08-28)

**1 · Breakpoint is now 900**, the number `MobileNavSheet.prompt.md` states. The bar collapses in TWO stages, and conflating them was the trap:

| Width | Bar |
| --- | --- |
| >= 900 | everything: theme, language, bell, saved, My Tickets, profile, search |
| 600-899 | burger appears; theme + language move into the sheet; bell, saved, My Tickets, profile, search stay |
| < 600 | `useIsMobile` - identity + account + burger only |

`useIsPublicNavCompact` (`PUBLIC_NAV_BREAKPOINT = 900`) is a new hook, deliberately not a change to `useIsMobile`: that one has ~70 consumers and its 600 is a *space budget*, not a navigation decision. Nor is it `useIsCompactViewport`'s 960, which governs the bottom nav and admin drawer.

Why two stages rather than one swap to 900: the bell, the saved-heart and My Tickets exist ONLY in the wide branch — neither the bottom bar nor the profile menu carries the first two — so a wholesale 900 would have stranded notifications across 300px of viewport. And theme/language had to leave at 900 or the bar would show a theme toggle sitting directly above a THEME row in the sheet. Six `viewport tiers` cases in `AppNavbar.test.tsx` pin this; collapsing `isCompactNav` back to `useIsMobile` fails three of them. Verified live at 760px: burger present, theme + language gone, search and the signed-in controls still there, no horizontal overflow.

**2 · `tokens/focus.css` is ported.** `globals.css` now carries `--focus-width: 3px` / `--focus-offset: 2px` and a `:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible` rule. `:where()` is deliberate — zero specificity makes it a FLOOR, so anything that already styles its own focus keeps winning and this can never fight a component for its ring. The nine hand-rolled `outline: 2px solid var(--accent)` rules scattered across five stylesheets now read the same tokens, so there is one treatment rather than ten.

Three things the port turned up that the CSS alone would not have:

- **The colours must resolve on `body`, not `:root`.** A custom property containing `var()` is substituted where it is DECLARED. `--focus-color: var(--accent)` on `:root` baked in the Stub `#E2481D`, and measurement confirmed the ring stayed `rgb(226, 72, 29)` under `t_ember`. The theme class lands on `body`, which is where `--accent` actually gets its per-theme value; declared there the ring follows the theme (`rgb(255, 87, 33)` in ember, verified).
- **A full-bleed row in a scroll container clips the ring.** The sheet panel's `overflow-y: auto` makes `overflow-x` resolve to `auto`, and a row is exactly as wide as the panel — so at +2px offset the ring is drawn at -2 and width+2 and both vertical strokes are cut, leaving two loose horizontal rules. Measured at 760px: row 0-760 inside panel 0-760. Rows now carry `data-th-navsheet-row` and a scoped rule insetting the offset to `calc(-1 * var(--focus-width))`; only the OFFSET is overridden, so width and colour still come from the system. Verified: ring 3-757 inside 0-760, unclipped. **This is a general hazard, not a sheet quirk** — any full-bleed row inside a scrolling container has it.
- **~46 controls opt out inline and the floor cannot reach them.** 47 occurrences of `outline: "none"` in inline `style` objects across `apps/web` and `packages/ui`; exactly one is a `tabIndex={-1}` focus container, so the rest are real controls deleting their focus indicator with nothing put back — a WCAG 2.4.7 failure, and the folder's "never remove the ring without replacing it with this one" in the breach. Inline style beats every stylesheet rule, so the port raises the floor for everything that has not explicitly opted out and leaves these untouched. Demonstrated on `/contact`: the text inputs carry inline `outline:none` and still show no ring. **NOT fixed — a separate sweep**, and not something to do with a blanket `!important`, which would also override components that legitimately draw their own ring and would light one up on every `tabIndex={-1}` container.

Verified: 316/316 across `src/components/navigation`; full `apps/web` suite 7023 pass / 5 fail, every failure in another workstream's in-flight files (`AdminShell`, `moderate-layout`, `next-config`, and a CAB test file deleted mid-run — none import anything changed here). Both colour gates 0 errors, eslint 0 errors, `apps/web` tsc clean for every touched file. Driven at 760 and 320 in both themes.

### The three gaps that were left open, closed (2026-09-06)

**1 · The inline `outline: "none"` sweep.** 48 sites across `apps/web` and
`packages/ui`. Each was classified before touching it, not regex-deleted:

| | | |
| --- | --- | --- |
| removed | 36 | real controls — inputs, textareas, selects, anchors, menu triggers, a Switch, a DataTable filter, a WorkspaceSwitcher link. They now inherit the system ring. |
| kept | 11 | `tabIndex={-1}` focus containers (modal, dispute panes, calendar peek, search page, claim wizard, the sheet panel, the support panel), the ProseMirror editor body, and `SuggestionInbox`'s bulk bar — whose own comment already said "the wrapper is only a focus target". |
| kept | 1 | `EventBuilder`'s `anchorStyle`: every consumer is a `tabIndex={-1}` scroll anchor that takes focus after a jump, so a ring would fire on a target nobody tabbed to. |

Two of the removals were the interesting ones: `FeaturedHeroCarousel` and the
seat-map `PlaceLayoutDesigner` canvas are both `tabIndex={0}` — genuinely
keyboard-operable, arrow keys and all — with `outline: none` and no replacement,
so a keyboard user had no way to tell they had landed on them. Both are
full-bleed, so both take the inset treatment below.

**2 · Notifications and Saved below 600.** They took different routes, because
they are different affordances:

- **The bell stays in the bar at every width.** Its unread BADGE is the whole
  point — a count buried in a menu tells you nothing you did not have to open
  the menu to learn. Nothing else surfaces it: the bottom bar does not carry
  notifications, and `AlertsSidebar` is uncontrolled (`defaultOpen` only, no
  `open`/`onOpenChange`), so a sheet row could not have opened it without a
  `@th/ui` API change. It is hoisted to one `alertsEl` both branches render.
- **Saved moves into the account popover's ATTEND section**, next to My Tickets
  and My RSVPs. That popover renders at EVERY width, so this costs the 320px bar
  nothing — which the bell could not afford to do twice.

**3 · The clipped-ring hazard, generalised.** The sheet's bespoke `<style>`
block is gone. `--focus-offset` INHERITS, so one global rule now serves every
case:

```css
[data-focus-inset] { --focus-offset: calc(-1 * var(--focus-width)); }
```

Put it on a scrolling container to flip every ring beneath it, or on the rows
themselves when only some of a container's controls are full-bleed. Only the
offset changes — width and colour still come from the system, so it stays one
treatment. Applied to the sheet rows, the hero carousel and the designer canvas.

Five new AppNavbar cases pin the reachability work (bell at 375 signed-in, no
bell signed-out, Saved at 1280/760/375); reverting the hoist and the popover
prop fails four of them.

### Review round 2026-08-28 — reconciling with the concurrent checkout-CTA work

Driving the reconciled surfaces turned up three defects the bar had been masking,
none of them in `bar-configs`:

1. **`/search`'s clear chip rendered in every state and lied about its scope.**
   Guard was `canSearch || geoLocation || selectedCategories.length`, and
   `canSearch = hasTextQuery || trimmedQuery.length === 0` is true either way —
   so a pristine `/search` showed a Clear chip with nothing to clear. Replaced
   with `hasClearableState`, a term-for-term mirror of `handleClearSearch`.
   Label moved `search.clearFilters` → new `search.clearSearch` (en+es): it
   clears the QUERY too (measured: `?search=warehouse` → empty input, URL back
   to `/search`). The panel's own filters-only "Clear filters (N active)" chip
   keeps the old string.
   - `radiusKm` is deliberately NOT a term. The imperial auto-detect resolves
     after mount and `normalizeRadiusForUnit(50, true)` snaps 50 km onto the
     mile grid (30 mi ≈ **48** km), so `radiusKm !== DEFAULT_RADIUS_KM` would be
     permanently true on every imperial browser — the original bug by another
     route. Radius is only URL-visible inside a geo block, which `geoLocation`
     already covers.
   - **Review catch:** `handleClearSearch` cleared every draft filter EXCEPT
     price (applied copies only). So Clear removed the chip while the Filters
     panel still showed a populated price with Apply lit — one press resurrected
     the filter just cleared. The handler now clears the drafts too and the
     predicate includes them. Verified: apply `priceMin=10` → Clear → draft `""`,
     chip gone, Apply bar gone.
2. **Checkout had no visible primary and two of them.** `checkout-hold-btn`
   (inline) and `checkout-sidebar-hold-btn` both painted `rgba(33,28,22,0.06)`
   — the *disabled* wash — while enabled, with duplicate accessible names. The
   orange primary had left with the bar and nothing replaced it. Per user
   decision the inline one is deleted and the sidebar one promoted to
   `ACCENT_FILL` / `ON_ACCENT_FILL` (#B93312 on white, 5.92:1 — NOT `$accent`,
   which has no AA foreground in either polarity); `checkout-continue-btn` got
   the same treatment so steps 1 and 2 agree on what a primary looks like.
   Focus moved from a JS `onFocus` background swap (which also fires on mouse
   press) to a real `.checkout-primary-action:focus-visible` ring.
3. **`/my-tickets` rendered a lone "02 PAST".** Section ordinals were hardcoded
   `01`/`02` under independent non-empty guards. Derived now.

**Concurrent workstream — the checkout mobile CTA changed underneath this.**
Mid-review, another session put `/events/checkout` into `ConsumerBottomNav`'s
`HIDDEN_PREFIXES` (four global destinations under a payment form are four ways
to abandon a cart; the step primary wants the amount on it, which a 64px raised
square cannot carry) and brought `MobileCTABar` back as the full-width mobile
primary. That REVERSES the earlier "checkout publishes a centre action" note in
§7 — `Checkout.tsx`'s `useMobilePrimaryAction` call is now a publication with no
consumer on that route. **The centre slot survives for other surfaces (event
detail, venue pages); checkout opted out.**

That change also resolved a `[BLOCKING]` review finding (that deleting the
inline button stranded mobile with no primary) — but left step 1 with TWO accent
"Hold tickets" ~48px apart, the fixed bar clipping the sidebar one's lower edge,
both under the identical accessible name. The details step avoids this by naming
its two differently ("Continue to payment" inline vs "Continue" in the bar) and
because the inline one sits in the form's tab order; step 1 has no form, so the
sidebar copy was a pure duplicate. **Fixed:** `.checkout-sidebar-hold` is hidden
below 960px. Measured handoff — 320/390/959 → `mobile-cta-bar` only; 960/1280 →
`checkout-sidebar-hold-btn` only. Exactly one primary at every width, no gap.

Also fixed from review: `primaryActionHoverProps`' `onMouseLeave` early-returned
while busy, and React's style diff skips an unchanged `background` key, so a
hover→click→leave sequence stranded the button on the hover rung until unmount.
The guard is gone (enter keeps its guard). `MobileCTABar` adopted the same
helper, so it was fixed there too.

**Verified:** `apps/web` tsc **0**; full suite **412/413 files, 7024 tests**
(the one failure is the standing `next-config.test.ts` esbuild/jsdom invariant —
the file fails to load, 0 tests run); zero console errors on `/search`,
`/my-tickets` and checkout at 320/390/959/960/1280.

**Still open (all logged, none blocking):** no test guards `hasClearableState`
(11 hand-maintained terms tracking a 16-line handler — lift it to a pure
exported helper and unit-test it); no test covers the sidebar CTA or either
button's busy state; `e2e/checkout-steps.spec.ts` was retargeted to
`checkout-sidebar-hold-btn` but NOT run, and its `guest` project is Desktop
Chrome only, so nothing in CI exercises the mobile CTA path at all.

### 2026-08-28 — event detail reconciled; `/events/:slug*` is `config: null`

The last big consumer-facing bar is gone. Driven before the change, it rendered
exactly three segments — `DATE · Sep 2` | `CALENDAR` | `DIRECTIONS` — every one
of them a duplicate of a control already on the page.

`EventDetailCABBridge.tsx` (252 ln) is deleted, and it was NOT just a data
bridge: it also rendered its own `CalendarDropdown` and a `placement="cab-sheet"`
`DirectionsDropdown`, so the page was shipping two of each. `event-detail-cab-keys.ts`
(+ test) went with it — grep confirmed the bridge was their only consumer. In
`EventDetail.tsx` the bridge's ~17-prop mount and the now-stranded `exactCoords`
local are gone; `useMobilePrimaryAction`, `suggestEditHref` (also feeding
`CommunityListingNotice`), `seriesPickerOpen` / `SeriesTicketDatePicker` /
`onCtaPress` all stay.

**Two segments turned out to be already dead**, which is the recurring shape of
this whole migration: `volunteer` was gated on a `volunteeringEnabled` data key
with ZERO publishers (`VolunteerSection` dropped its `useCABData` when the inline
button shipped), and `ticketsAvailable` was published by the bridge but
referenced by no segment once the `cta` was removed on 08-27.

Tests were re-pointed rather than dropped: the two "returns event-detail config"
tests now assert `config === null` AND that `params.slug` still resolves (a
DELETED rule would return `{}` from `__fallback`, so this is the guard); the
checkout-vs-event ordering test discriminates on params (`rest` vs `slug`) now
that both configs are null; the `overflowOnMobile` / `overflowMenuSegments`
describes were rewritten against literal `BarSegment` fixtures and their
blast-radius guard widened from 10 paths to 37, asserting no shipped config
anywhere opts back into `overflowOnMobile`.

**Verified** (orchestrator re-ran, not taken on report): `apps/web` tsc **0**;
`src/app/events` + `src/components/navigation` + `src/components/events`
**37 files / 607 tests green**. Driven at a proven 320 (`innerWidth`,
`clientWidth`, `visualViewport` all 320 via device-metrics emulation) and 1280:
zero `contextual-action-bar` / `page-action-bar-strip` / `[data-cab-segment]` at
either width, exactly one `event-get-tickets-btn`, `event-location-directions-desktop`
present at 1280, the Add-to-calendar menu still opens (Google / Outlook, right
edge 235 of 320), `scrollWidth` 320, centre slot live reading
`HOME · SEARCH · GET TICKETS · TICKETS · SUPPORT`, zero console errors.

**Not verified — no fixture.** The seed has no community/RSVP listing I could
reach, so the `rsvp*` and `suggestEditProminent` inline twins were confirmed by
grep only, never driven. That is exactly the gate that failed once already on
this migration (entity heroes mounted only on the `standard` layout, so
`stack`/`grid` venue pages silently lost Report/Claim). **Before trusting this,
seed a COMMUNITY-stewardship RSVP event and confirm `event-rsvp-section`,
`event-suggest-edit-btn` and the recurring "see dates" path all render where the
bar's segments used to.**

**Newly orphaned by this change** — `src/components/actions/CalendarDropdown.tsx`
has zero consumers (reachable only via its barrel), and `DirectionsDropdown`'s
`placement="cab-sheet"` branch has zero callers app-wide (the entity heroes
dropped the last one on 08-28). Both are already on §3's Phase-3 list. Orphaned
`cab.*` keys for Phase 4: `cab.date`, `cab.addToCalendar`, `cab.directions`,
`cab.suggestEdit`, `cab.volunteer` (the `rsvp.*` ones are still used by
`RsvpButton` — check before deleting).

**§7's "still to do" list is now**: `/events/category/:slug`,
`/events/resale/:listingId`, `/account*`, `/admin/**`, `/about`, `/contact`,
`/lucky`, `/unsubscribe`, `/places/new`. All secondary surfaces.

### Unrelated finding worth its own look
Measured on checkout while chasing a re-render report: **one click on a quantity
stepper costs 16 React commits over 1.44s — 1,411 component renders across 129
components, including `FooterLink` 65 times.** Cause is not the bar. Every
quantity change rewrites the URL (`?step=selecting&t=<uuid>:<qty>`), which is a
Next router push, so every commit roots at `HeadManagerContext` and the whole
route re-renders shell-and-footer; nothing memoises between page state and
`AppShell`; and a cascade of dependent effects keeps committing for ~1.4s
(33/55/253/528/684/848/1224/1441ms). Idle is fine — 2 commits per 5s, zero
network, no app timers. Cheapest fix is not rewriting the URL on every tick.

### Post-review hardening — the twins are machine-checked now

Review of the event-detail consolidation came back **APPROVED**, with the
sharpest point being that the deleted configs were the last machine-checked
statement that the page-owned controls exist, and they had been retired into a
prose comment. Grep-level confidence is exactly what failed on the entity heroes.
Closed:

- **New: `__tests__/VolunteerSection.trigger.test.tsx`** (9 tests on
  `volunteer-open-sheet-btn` — the only way into the sheet), **new:
  `community/__tests__/CommunityListingNotice.test.tsx`** (3 on
  `event-suggest-edit-btn`), **extended `EventContent.test.tsx`** (+6 on
  `event-get-tickets-btn`, both the `Link` branch and the `onCtaPress`
  series-picker branch, plus an "exactly one" assertion against the
  alias-map collision that bit on 08-27).
- Every test was **proven red by mutating the component**, then restored. The
  orchestrator independently re-ran one: stripping the `event-get-tickets-btn`
  testid → 4 failed; restore → byte-identical SHA → 29 passed.

**A fake gate was found and fixed in the process.** `EventContent.test.tsx`'s
`@th/ui` mock was `Button: ({children}) => <button>{children}</button>` — it
dropped EVERY prop, `data-testid` and `onPress` included. Any testid assertion
written against it **could not have failed**. Fixed by making the mock faithful
(forwards `data-*`/`aria-*`/`role`; `onPress` → `onClick`, never both;
`tag="span"` renders a span so the anchor stays the only interactive node) rather
than weakening the assertion. All 23 pre-existing tests still pass. Add this to
CLAUDE.md's "Gates That Look Real And Are Not" table: **a design-system mock that
swallows props makes every attribute assertion in its suite vacuous.**

**Two findings recorded, deliberately NOT "fixed":**
- `EventContent`'s Get-tickets CTA renders inside the `hasLogistics` block, and
  `ctaHref`/`ctaLabel` are NOT terms in `hasLogistics`
  (`startsAt || location || showableLocationCoords || visibleLineup.length ||
  rsvpAction || communityAttribution`). So a title + CTA and nothing else renders
  **no buy button**. Unreachable today (every event has a `startsAt`), but it is
  a load-bearing coupling with no reason to exist and the same shape as the bug
  this migration already shipped. Pinning it as intended would cement a probable
  defect; the tests pass `startsAt` and a comment records the coupling. **Decide
  whether the CTA should hoist out of the logistics block.**
- `SeriesTicketDatePicker.tsx:51` holds a second copy of the literal
  `"event-get-tickets-btn"` (`CTA_TEST_ID`) — never rendered, only
  `document.querySelector`'d for focus return on overlay close. Not a collision
  (EventContent is the sole emitter), but renaming the testid in one place would
  silently break focus return.
- `if (rolesQuery.isLoading) return null` in `VolunteerSection` **cannot be
  uniquely pinned** — `isLoading` is only true on a first fetch with no data, so
  the `!data` gate below always covers the same state; deleting the line leaves
  the suite green. Flagged rather than faked.

**Correction to the record:** the volunteer roles query is NOT `retry: false` —
it is `retry: shouldRetryVolunteerRolesQuery` (≤3 attempts, never on
`NOT_FOUND`). `retry: false` is what CAUSED Gap 8; the retry policy is the fix.
The render gate that hides the trigger on a settled error is still there, and the
state that actually exercises it is a **failed refetch with cached data present**
(react-query retains `data` across a failed background refetch) — which is the
literal Gap 8 scenario: trigger on screen, then gone. That is what the new test
pins.

Also cleaned up in this pass: `VolunteerSection.tsx` carried
`import {} from ".../cab-store"` — an empty side-effect import left by the
removed hooks — plus five comments stating the opposite of the truth
(`EventDetail`'s `suggestEditHref` docblock, `CommunityListingNotice`'s header
contradicting its own prop doc, `RsvpButton`'s "a CAB-initiated toggle blocks
this button", `VolunteerSection`'s Gap-8 note, and `SegmentRenderer`'s
`rsvpGo`/`rsvpGoing` branch, which no config feeds any more).

**Verified after all of it:** `apps/web` tsc **0**; `src/app/events` +
`src/components/events` + `src/components/community` **36 files / 392 tests**.

**Help-center drift is now the largest open item** and is genuinely user-facing:
`getting-started/volunteer-at-an-event.md:21` tells people to click Volunteer
"in the action bar"; `community-listings.md:70` says Suggest an edit is "in the
action bar at the bottom"; `getting-started/the-action-bar.md` documents a
feature that no longer exists on the event page (`:15`, `:52`), and
`find-events.md:11` + `volunteer-at-an-event.md:9-10` link INTO it, so deleting
it needs a redirect/related-links sweep. §4 owns this.

### Phase 4 COMPLETE — `cab.*` → `pageActions.*`, orphans deleted

The last piece. The namespace was named after a component deleted weeks earlier;
the labels themselves outlived it because the ACTIONS survived — they just moved
inline, into hero "…" menus, and into the mobile bottom bar's centre slot.

- **`cab:` → `pageActions:`** in both catalogs, with a docblock recording why the
  rename happened so nobody re-derives it.
- **59 of 80 keys deleted** as orphans — everything the dock itself needed and
  nothing else did: `addToCalendar`, `backToEvent` / `backToTickets` /
  `backToDetails`, `holdTickets`, `continueToPayment`, `viewOrder`, `getTickets`,
  `clearSearch`, `filters`, `sort`, `searchQuery`, `results`, `showQr`,
  `dragHandleHint`, the whole Seller-Hub set (`listings`, `payouts`, `claims`,
  `newListing`, `createListing`), and the nav duplicates (`upcoming`, `past`,
  `myTickets`, `findEvents`, `nearYou`, `map`, …).
- **21 keys kept and renamed**, across 18 files — the labels for actions that are
  still on screen: `save` / `saving`, `publishEvent` / `publishing` /
  `unpublishEvent`, `preview`, `viewEvent` / `viewPage`, `shareEvent` / `share` /
  `copyLink`, `scanTicket`, `attendees`, `compTickets`, `volunteers`,
  `volunteer`, `editEvent`, `suggestEdit`, `report`, `claimVenue`,
  `requestTransfer`, `moreActions`.

**Closure is provable, not eyeballed:** 21 keys defined, 21 referenced, **zero
missing and zero unused, in BOTH catalogs**. A missing key would have rendered
the raw string on screen — the exact failure this repo's dual-catalog note warns
about — so the check is a set comparison, not a spot check. Confirmed no
`pageActions.*` literal renders anywhere on the driven pages.

Verified: `apps/web` tsc clean (see caveat); i18n suites **5 files / 1161 tests**;
the suites that actually exercise the renamed keys — `PlaceHeroActions`,
`EntityHeroActions`, `VolunteerSection.trigger`, `CommunityListingNotice`, the
place-editor page — **5 files / 66 tests green**.

**The CAB is now fully gone.** `contextual-action-bar/`, `page-action-bar/` and
`ContextualActionBar.tsx` are deleted; neither shell renders a bar; no live code
references remain (only three historical comments, in `spotlight-store.ts` and
two test docblocks). What survives by design is `page-primary-action.ts` — the
single-slot registration channel feeding the mobile bottom bar's centre action,
used by `EventDetail`, `HeroBookingRequestButton`, `page-settings-save`,
`SupportWidget` and `ConsumerBottomNav`.

#### Two failures in the tree that are NOT this work
Both confirmed by ownership checks (file not in the rename set, zero
`pageActions.` references, mtimes predating or concurrent with these edits):
- `AdminShell.test.tsx` → "exposes exactly the 20 known route ids across 7
  groups" fails: another session removed the **`overview`** section from
  `ADMIN_SECTIONS` (file mtime 33 min BEFORE this work) without updating the
  test or its name. Left alone deliberately — whether `overview` should be gone
  is that workstream's call, and fixing their test would paper over it.
- `UniversalSearchPage.tsx` → 21 type errors (duplicate `CATEGORY_ICONS`, missing
  lucide imports). File has ZERO `cab.`/`pageActions.` references and was never
  in the rename set; its mtime was 8 seconds old when observed — an active
  in-flight refactor by another session.
Also standing: `next-config.test.ts` fails to LOAD on the esbuild/jsdom
invariant (0 tests run), and two `packages/` type errors
(`event-summary-mapper.ts`, `GroupedMultiSelect.tsx`) from other workstreams.

**Flake caveat (cost me two false alarms).** A full `vitest run` on a loaded
machine reported failures in `EventBuilderPreviewToggle.test.tsx` (1) and
`UnifiedScanView.test.tsx` (2). Both pass clean in isolation — 9/9 and 15/15 —
and the timings are the tell: **29.3s → 2.2s** and **110.1s → 10.1s**. They are
timeout flakes under parallel load, not defects, and both LOOK like real
failures in the summary. Re-run a suspect file alone before believing a
full-suite failure here; the only reproducible non-flake failures in this tree
are `AdminShell.test.tsx` (another session's `ADMIN_SECTIONS` change) and the
standing `next-config.test.ts` load error.

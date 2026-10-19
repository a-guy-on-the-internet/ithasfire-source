# Action bar → pinned page-action bar — SUPERSEDED same day

> Superseded by docs/specs/2026-08-27/completed/cab-removal.md (2026-10-08 docs consolidation)

> **2026-08-27, later: the action bar concept is REMOVED entirely** (user: "remove the concept of the CAB bar and integrate it into the pages on a case by case basis"). The pinned bar built under §3 Steps 1–3 was seen on the home page and rejected. §1 stays as the deletion map; §3 is void. The removal plan lives in `docs/specs/2026-08-27/completed/cab-removal.md` once the audit lands.


**Date:** 2026-08-27 · **Decision (user):** the floating, draggable action bar dock is replaced by ONE known spot on every page: a **sticky page-action bar at the top of the content area**. On the event builder the existing sticky header and the action bar **merge into one bar**. "The action bar" is the user-facing term (help: `content/help/getting-started/the-action-bar.md`); never "CAB"/"dock" in copy.
**Also decided today:** the admin ledger shell renders Register 1 only (topbar); the side rail is admin's navigation.

## 1. Today (scouted, file:line)

- Mount: `components/layout/GlobalOverlays.tsx:58` `<ContextualActionBar/>`; `AppChrome.tsx:191,213,232` (not on the bypass branch: embeds, auth callbacks, `/login`, print).
- Component: `components/navigation/ContextualActionBar.tsx` (2274 ln). Constants `:206-232` (`BAR_HEIGHT 48`, `DOCK_INSET 16`, `MAX_DOCK_WIDTH 580`, growth to 880). Two render paths `:1871-1963`: desktop `motion.div` drag (`dragEnabled = hasMounted && !isMobile`, `:560`) inside a **full-viewport** `boundsWrapperStyle` (`:265-271`, `position:fixed; inset:0; z 1100`); mobile/SSR **static bottom bar** `staticOuterStyle` `:283-299`.
- Anchors: `contextual-action-bar/cab-anchor.ts` (7 anchors, `th:cab-anchor` localStorage, the ONLY persisted key; `isCabAnchor` validates on read so stale values are harmless). `useCabAnchorValue` consumers: `layout/AppShell.tsx:96` (`cabIsTopDocked`), `contextual-action-bar/index.ts`.
- Store: `cab-store.ts` — `useCABAction(key, fn, enabled)` `:253-276` (owner-token guarded), `useCABData`. 39 registration sites; page-owned twins exist on the builder, place editor, search, event detail (directions), venue/org pages, checkout.
- Config by pathname: `bar-configs.ts` (`matchRoute`; `hidden`, `hideAtOrBelowWidth` — `ADMIN_CAB_MOBILE_HIDE_WIDTH = 959` at 12 sites, checkout 900; `liftAboveBottomNavOnMobile` → +89px `!important` `:1823-1841`, 4 event-builder-family sites). `/platform*` = null config.
- Clearance: `CAB_CLEARANCE = calc(80px + env(safe-area-inset-bottom))` `:1985`; consumers `AppShell.tsx:10,98,198` (bottom pad) and `actions/DirectionsDropdown.tsx:36,317-318`. **`AdminLedgerShell` reserves nothing** (`:323`) — desktop admin dock already overlaps content.
- Empty auto-hide `:1501-1526` + `inert` `:1871`.
- Builder header: `events/new/_components/BuilderHeaderBar.tsx` — plain `<div>` with INLINE `position:sticky; top:0; zIndex:100` (`:46-56`; RNW strips sticky from styled stacks). Contents: back, live title, status badge, Edit|Preview toggle, new-tab preview (pre-publish), "View event" (published), Close, `⋯` (Cancel event). `memo`'d (`:410`). **Duplicated with the action bar:** View event, Preview. Action-bar-only: Share, Publish, Unpublish, Save. `EventBuilder.tsx:2955-2977` measures the header with a `ResizeObserver` → `stickyTopOffset` feeds `:730, :749, :2982, :2986-2992` (a taller header self-corrects).
- Consumer shell: `AppShell.tsx:168-185` `ScrollAwareNavbar` slides on scroll; `MainContent` `position:relative; z 1`. A sticky bar at `top:0` collides with it — read the navbar for its offset variable.
- Mobile: static bottom bar; `NavigationBottomBar` fixed, z 100, ≈73px + safe-area; the action bar's z 1100 is above it (hence the padding lift hack).
- Tests: `cab-anchor.test.ts` (dies), `cab-store.test.ts`, `cab-shortcuts.test.ts` (28), `VenueCabActions`/`EntityCabActions` tests, `event-detail-cab-keys`, `spotlight-cab-integration`. E2E: `cab-draggable.spec.ts` (dies), `checkout-cab-steps.spec.ts:120` (`cab-<segmentKey>` testids), `spotlight-cab-cta.spec.ts:20-28` (`.last()` — fragile), `checkout-to-settlement.spec.ts:147` + `checkout-journey.spec.ts:199` scope via **`getByTestId("contextual-action-bar")` — keep that testid on the new bar.**

## 2. Traps (from memory + scout)

1. `ActionBarCTA` has exactly ONE activation path — DOM `onClick` + `onKeyDown`, **never Tamagui `onPress`** (double-fired every CTA for months). Re-hosting CTAs inside a Tamagui container is the #1 regression risk.
2. Never `prettier --write` `ContextualActionBar.tsx` wholesale (unformatted regions at HEAD).
3. Empty auto-hide: transition only on the hidden state; no first-mount latch (the builder registers `eb*` ~2s after mount); `inert` required.
4. Keydown guards must keep: editable context, `[role=dialog][aria-modal]`, `[inert]`, `getClientRects().length === 0`.
5. `measuredOverflowKeys` resets on config change; promoted segments need an explicit `variant`.
6. `DirectionsDropdown` bug root cause: measuring `[data-testid=contextual-action-bar]` (was the full-viewport wrapper). Once the bar is a real-sized element, pin with a constant, never by measuring. The EVENT action-bar directions bug is still open.
7. R1: content areas stay `overflow: visible` or sticky dies silently. R2: the registers stay non-sticky; the page-action bar lives INSIDE the content area.

## 3. Plan (each step leaves the app working)

**Step 1 — `PageActionBar` (apps/web).** New `components/navigation/page-action-bar/PageActionBar.tsx`: a plain `<div data-testid="contextual-action-bar">` with inline `position:sticky; top:var(--page-action-bar-top,0); zIndex:100`, full content width, 2px structural bottom rule, `$surface`. Slots: `leading?: ReactNode` (builder: back/title/status), `actions` = the resolved action-bar segments for the active config (reuse segment resolution, `ActionBarCTA`, overflow measurement, shortcuts, `dockIsEmpty` → renders nothing when empty AND no `leading`). Keep the `cab-<segmentKey>` testids. Mobile: same bar, actions wrap/overflow into the `⋯` menu; the bottom nav is untouched; drop `liftAboveBottomNavOnMobile` (no longer meaningful); keep `hideAtOrBelowWidth` semantics for now (page-owned twins cover those widths) — revisit after this ships.
**Step 2 — shells host it.** `AdminShell` renders `<PageActionBar/>` as the first child inside the ledger shell's content (NOT in the registers). `AppShell` renders it as the first child of `MainContent`, `--page-action-bar-top` = the scroll-aware navbar's visible height (0 when hidden). Drop the bottom `CAB_CLEARANCE` padding in `AppShell`; `DirectionsDropdown` pins relative to the bar's top instead. A config flag `hostedByPage: true` (set on `admin-event-builder`) makes the shell bar render null.
**Step 3 — builder merge.** `BuilderHeaderBar` becomes a `PageActionBar` with `leading` = back/title/status and `actions` = Edit|Preview toggle + the action-bar segments (Save/Publish/Unpublish/Share/View/Preview) + Close + `⋯`. Remove the header's own View/Preview (the action bar owns them). Pass `actions` as one pre-rendered node to preserve the `memo` boundary. `stickyTopBarRef` points at the merged bar — the `ResizeObserver` self-corrects the four offsets.
**Step 4 — delete the dock.** Remove drag/anchor/park/motion code from `ContextualActionBar.tsx` (it becomes the store→segments adapter `PageActionBar` uses, or is deleted), `cab-anchor.ts` + its test, `e2e/cab-draggable.spec.ts`; stub `useCabAnchorValue` → default and remove `cabIsTopDocked`; delete the 4 `liftAboveBottomNavOnMobile` sites; remove the `th:cab-anchor` read/write. Help article + `cab.dragHandleHint` i18n: update copy (no drag).
**Step 5 — run it.** Builder (1280/1000/320): one sticky layer, readiness rail/scroll-spy offsets correct, no double-fire (click "View event" opens ONE tab). Dashboard, place editor, event detail (directions sheet), checkout journey e2e (`E2E_USE_LIVE_STACK` where safe), search. Zero console errors.

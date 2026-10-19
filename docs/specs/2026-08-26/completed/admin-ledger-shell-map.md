# Admin workspace shell → ledger topbar: implementer's map

**Date:** 2026-08-26 · **Decision:** handoff §7 Q6 — ledger topbar goes into `/admin/[slug]` only. Consumer, `/platform`, `/sell` untouched.
Scouted read-only; every path was read. Verify line numbers before editing — the tree is shared WIP.

## 1. DS spec (`~/Downloads/Ithas Fire Design System/components/navigation/`)

| Component | Props (`.d.ts`) |
|---|---|
| `AppShell` | `topbar`, `sections`, `context`, `sidebar` ("SANCTIONED EXCEPTIONS ONLY: admin, event builder step rail"), `banner`, `width: content\|wide\|narrow` (default wide), `children` |
| `Topbar` | `brand` (default "Ithas Fire"), `role` ("Organizer" / "Admin" chip), `left`, `right` (EventSwitcher, notifications, account MenuButton) |
| `SectionTabs` | `items: {href,label,count?}[]`, `current` (href), `overflow` (MenuButton — "Admin needs this") |
| `ContextStrip` | `items: ReactNode[]` (facts joined by mono middots), `right` (live figure) |
| `SidebarNav` | `groups: {label?, items:{href,label,icon?,badge?}[]}[]`, `current`, `label` (landmark) |
| `EventSwitcher` | `events`, `currentId` (omit ⇒ "All events"), `onSelect`, `allHref` |
| `SkipLink` | `href` default `#main`; `AppShell` renders the one `<main id="main">` — do not add another |

Heights (`navigation.css:8-14`): topbar 56 · sections 40 · context 34 (min) · sidebar 232 · tabbar 60.

- **Topbar**: 2px structural bottom rule, `--color-bg`. Brand (900, uppercase, 15px) → role chip (mono 2xs, hairline left border) → `left` → `right` (`margin-left:auto`). "Constant across every page of a surface. Anything that changes per page belongs in register 2 or 3."
- **SectionTabs**: 2px bottom rule; `overflow-x:auto`, scrollbar hidden; each `<a>` mono sm semibold uppercase tracked, hairline right border, nowrap. **Active = filled ink block** (`background: ink; color: on-inverse`) — D-055 keeps shell tabs (ink fill) distinct from in-page `Tabs` (3px accent underline). ≤640px: scroll-snap rail, explicitly not a hamburger. "Six items is the comfortable ceiling."
- **ContextStrip**: **hairline** bottom border (not the 2px rule), `--color-surface`, mono xs uppercase muted, `flex-wrap`. **Facts only — no controls, no links.** Optional.
- **Registers are NOT sticky.** `.if-shell{display:flex;flex-direction:column;min-height:100dvh}`; sticky is an opt-in `Sticky` wrapper. Today's admin top bar is also non-sticky → keep them non-sticky.
- Sidebar exception: `SidebarNav` 232px, 2px right border, `--color-surface`, rows ≥44px, active ink-filled. <900px: becomes a horizontal scroll row, group headings hidden ("admin on a phone is a rescue mission").
- Gate-3 record: `DECISIONS.md` A-019 (option B), A-020 (admin gets sidebar), A-021 (account-scoped at home, event-scoped inside an event), A-022 (builder rail = second exception), D-054. Exploration: `phase2/navigation-exploration.html:145-165`. Reference wiring: `templates/organizer-overview/index.html:56-64`.

## 2. Current admin shell

```
admin/[slug]/layout.tsx → EventNavProvider → AdminShellFrame (print bypass) → AdminShell (804 ln)
  → AdminEmailVerificationGate mode="banner" → @th/ui NavigationShell (:706-793) → AdminPageTransition → children
```

Sharing (grep of every import site):

| Component | Admin | Platform | Seller | Consumer | Verdict |
|---|:-:|:-:|:-:|:-:|---|
| `NavigationShell` (`packages/ui/src/ui/shell/`) | ✅ | ✅ `PlatformShell:230` | ✅ `SellerShell:218` | — | **SHARED → fork, never edit in place** |
| `NavigationRail` (1493 ln) | via shell | via shell | via shell | — | SHARED — reuse unchanged as admin sidebar |
| `NavigationShellDrawer` | via shell | ✅ | ✅ | — | SHARED — reuse |
| `NavigationBottomBar` | ✅ + `bottomBarCenterAction` (only `centerAction` in the app: SCAN square) | ✅ | ✅ | — | SHARED |
| `NavigationNavbar` | via shell | via shell | via shell | — | SHARED — today's register-1 equivalent |
| `WorkspaceSwitcher` (1193 ln) | via navbar | ✅ | ✅ | — | reuse as-is in Topbar `right` |
| `NavbarShell` | ❌ | ❌ | ❌ | ✅ `AppNavbar` | not admin's, do not touch |
| `SettingsNav` (`apps/web/src/components/settings/`) | ✅ settings | ❌ | ❌ | ✅ | in-page nav, out of scope |

`AppChrome.tsx:53` `CUSTOM_SHELL_PREFIXES = ["/admin","/platform"]` keeps consumer chrome off admin; `/sell` is not in it.

**26 props `AdminShell` passes `NavigationShell`** (`AdminShell.tsx:706-791`): `navSections currentRoute accountContext availableContexts enabledFeatureFlags collapsibleSections sectionCollapsePersistKey showRailIdentity railIdentityHref onRailIdentityPress railIdentityLabel railBack railContextHeader bottomBarCenterAction onContextSwitch onCreateOrganization onRouteSelect onReturnToConsumer returnToConsumerLabel returnToConsumerDescription brand navbarContentMaxWidth={1400} navbarSearchSlot navbarTrailingSlot(fn of layout) quickActionFooter contextHrefBuilder`. Type: `NavigationShell.types.ts:65-180`.

**Non-nav logic `AdminShell` owns — survives verbatim:** client RBAC gate → `/unauthorized` (:83,106-178); 15s load timeout + Retry focus (:65,198-218); inline-styled blocking branches with Stub-hex fallbacks (:602-702, deliberate); CAB `createEvent` registration (:93-95); `setLastAdminSlug` (:181-185); bookings badge `countOpen` silent (:255-277); i18n + `team→navDelegates` for human workspaces (:281-307); nested rail-context swap `useAdminRailContext` (:314-345); route prefetch (:334-343); document title (:413-428); unread poll @30s (:571-576); workspace switch preserves current section, RBAC per target (:452-533).

## 3. The rail (retained)

`NavigationShell.hooks.ts:22` `DESKTOP_BREAKPOINT=1200`; `NavigationShell.tsx:48` drawer 960 (admin does not override). ≥1200 expanded rail · 960–1199 collapsed 72px icon rail · <960 drawer + bottom bar. `railVisible = layout !== "mobile"` (:242). State in `localStorage["th:navShell:railState"]`.

**Drift:** `RailFrame` declares NO width (intrinsic); only the loading skeleton is 256 (`NavigationShell.styles.ts:107`). `globals.css` has three `@container` blocks (`.th-suggestion-inbox` 840, `.th-attendee-feedback` 820, `.th-place-edit` 800; ~:1624-1870) whose *comments* assume "rail = 256px, appears ≥960". The rules self-correct (container queries); the measured-consequence prose goes stale once the register stack changes — re-measure in headless Chromium, do not edit by arithmetic.

## 4. Tests

- `AdminShell.test.tsx` (1455 ln, ~45 tests) — **prop-contract harness**: mocks `@th/ui`, replaces `NavigationShell` with a flat div-per-prop harness (`:49-166`). Survives if the new shell keeps prop names. `ADMIN_SECTIONS` block (:1371-1520, "21 known route ids across 7 groups") is shell-independent.
- `admin-nav-sections.test.tsx` — bottom-bar order `dashboard, events, orders`; `hideInBottomBar` on search/places/bookings/scan.
- `AdminShellFrame.test.tsx` — print bypass.
- `packages/ui/src/ui/shell/__tests__/NavigationShell*.test.tsx` — shared shell, must stay untouched and green.
- **E2E:** only `announcements.spec.ts:325-346` asserts admin nav structure, via `getByRole("navigation",{name:"Main navigation"})` (`NavigationRail.tsx:1225`) — passes unchanged if the rail stays. `admin-interactions.spec.ts` has six anti-collision comments about sidebar labels (:69,82,93,248,257,286): **duplicating a rail label into a second register breaks strict-mode locators.**

## 5. i18n (`en.ts`, `admin.*`)

Groups `:2329-2335` `navGroupOverview|Programming|Sales|Audience|DoorCrew|Presence|Workspace`. Items `:2308-2328` plus `:2966 navPromos`, `:2968 navMemberships`, `:2376 scanTicket` (+ `cab.scanTicket` short). Chrome `:5812-5820` `asLoading asLoadErrorTitle asLoadErrorBody asRetry asRetrying asExitToAttendee asBrowseEvents asGoToWorkspaceDashboard`. Cross-namespace: `common.goToHome`, `common.openNotifications`, `common.preferences`. New keys needed: Topbar `role` ("Admin"), any ContextStrip fact labels. Add to `en` AND `es`.

## 6. Risks

- **R1 scrollport:** `NavigationShell.styles.ts:44-52` `ContentArea overflow:"visible"` MUST be reproduced — any other value captures `position:sticky` for every descendant (builder header, settings navs, table headers). Silent failure.
- **R2 sticky collisions:** `BuilderHeaderBar.tsx:47` sticky top:0 z-100 as inline CSS (RNW strips sticky); `EventBuilder.tsx:2955-2990` measures its own bar height into rail `top`/`maxHeight`/`scrollMarginTop`/IO `rootMargin`. Sticky registers would mis-offset all four. **Keep registers non-sticky.**
- **R3 builder rail:** `EventBuilder.tsx:180-190` grid `minmax(0,1fr) 296px` inside page content — do not fold into this rewrite.
- **R4 CAB:** global dock (`GlobalOverlays.tsx:58`), 7 anchors incl. top-left/top-right; verify it does not land on Register 3.
- **R5 keyboard:** Cmd/Ctrl+K listener in `NavigationShell.hooks.ts:437-451` (inert for admin); rail ArrowUp/Down roving focus (`NavigationRail.tsx:795-822`) stays with the rail. `SectionTabs` needs its own arrow-key handling — the DS ships none.
- **R6 theme:** `NavigationShell.tsx:464-480` web deliberately does NOT wrap in `<Theme>` so the navbar light/dark toggle flows through. A fork that adds `<Theme>` kills the admin toggle.
- **R7 density:** no shell sets `data-density`; only `DataTable` consumes it. Adopting `density="compact"` for admin is a separate opt-in.
- **R8 print:** keep the `AdminShellFrame`/`AdminShell` split (rules-of-hooks reason at `AdminShellFrame.tsx:24-32`); new register DOM needs the bypass or `[data-print-hide]`.
- **R9 nested contexts:** `admin-context-registry.ts` returns rail-shaped `{sections, railBack, railContextHeader, persistKey, prefetchRoutes, interceptRouteSelect}`. `railContextHeader` is the natural ContextStrip content, `railBack` the natural Topbar `left`. Adapt at the shell boundary; do not change the descriptor contract.
- **R10 two landmarks:** SectionTabs (`<nav aria-label>`) + rail = two navigation landmarks; name them distinctly; re-check R4's e2e anti-collision comments.
- **R11 — DECIDED 2026-08-26: option (3) context-scoped.** Was: 19 items / 7 groups vs "six is the ceiling" — this is why A-020 grants the sidebar. What is Register 2 for admin? (1) group row — 7 `navGroup*` labels as tabs, rail stays item-level; (2) subset + overflow menu — duplicates rail labels, breaks R10; (3) context-scoped — nested context's sections (event Build/Manage, place Venue/Operate), absent at workspace root; matches A-021 and the registry's shape.
- **R12:** `admin-nav-sections.tsx` `activeMatch:"prefix"` on `settings` (:277) and the absence of `children` are pinned by tests. Don't tidy.

## 7. Plan (each step leaves the app working)

1. **Registers in `@th/ui`** — `packages/ui/src/ui/shell/ledger/{LedgerTopbar,LedgerSectionTabs,LedgerContextStrip}.tsx` + `index.ts`, exported from `shell/index.ts` with the import-then-export idiom (header at `:1-4` explains the Vite ESM reason). Tokens `--nav-topbar-h/sections-h/context-h` in `globals.css`. Stories + tests. Nothing imports them yet.
2. **`AdminLedgerShell`** sibling of `NavigationShell` (`packages/ui/src/ui/shell/AdminLedgerShell.{tsx,types.ts,styles.ts}`) — **same 26 prop names** + `role`, `contextItems`, `contextRight`, `sectionTabs`. Reuse hooks (`useShellLayout useRailState useDrawerState useAppearance useContextSwitch useFilteredNavigation useRouteSelection useShellViewTracking`), `NavigationRail`, `NavigationShellDrawer`, `NavigationBottomBar`, `WorkspaceSwitcher`, `NavigationShellProvider`. Copy verbatim: `ContentArea overflow:visible` + comment, `ShellFrame minHeight:100dvh`, `SkipLink` (:77-103), the web no-`<Theme>` branch. One `<main id>`. Non-sticky.
3. **Register 2/3 not used in admin (2026-08-27 user decision): the rail is admin's nav; tabs/strip fought it and duplicated the builder header. Only register 1 (topbar) is wired; R10/R11 below are moot for admin.** **Point `AdminShell` at it** — swap import + JSX tag; add `role={t("admin.navRoleAdmin")}`; derive `contextItems`/`contextRight` from `railContextHeader`; derive `sectionTabs` per R11 decision. Rename the mocked export in `AdminShell.test.tsx:49-166`. Lines 54-702 untouched. First user-visible step — stop and look.
4. (optional, separate commit) Rail width: `RailFrame` has no width vs DS 232px — add a `width` variant, opt admin in; never pin the shared default.
5. Re-measure and rewrite the three `@container` comment blocks in `globals.css`.
6. E2E: new `admin-ledger-nav.spec.ts`; re-run `announcements`, `admin-interactions`, `admin-tables`, `event-builder`, `place-layout-designer`.

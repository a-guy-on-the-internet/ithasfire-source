# Design System v2 — Token Gap Map & Rollout Plan (Phase 0)

Source of truth for the v2 rollout: `docs/design/ithasfire-design-system-v2.html` (design doc, Ember/Stub themes,
tokens → atoms → molecules → organisms → S1–S7 section slots). This doc maps v2 onto the existing
Tamagui system and records the Phase 1 decisions.

## TL;DR

- The existing **dark theme IS Ember** (bg `#0F1B33`, surface `#162240`, raised `#1A2847`, muted
  `#A0B0CC`, border `#5A78A6`, accent `#FF5721` — all match). We keep the runtime name `dark` and
  document the alias; we do NOT add an `ember` theme entry (see hazards).
- **Stub is a genuinely new theme** (warm paper palette). It lands additively as `stub`; the existing
  `light` theme stays untouched (embeds depend on the literal name `"light"`).
- Radius (already locked 0), spacing scale, Montserrat/IBM Plex Mono, and breakpoints
  (480/640/900/1200) are **already v2-compliant**.

## Token diff (v2 → existing)

| v2 token | Existing | Action |
|---|---|---|
| `--color-bg/surface/surface-raised/ink/ink-muted/border` (Ember) | `darkTheme.*` exact match | none |
| `--color-accent` `#FF5721` / hover `#E84B19` | `accent` / `brandSecondaryHover` | none (Button primary already hovers `#E84B19`; `dark.accentHover` `#FF7E52` stays — used for border-hover states) |
| `--color-on-accent: #FFFFFF` | `onBrandSecondary: #181818` | **KEEP INK.** White on `#FF5721` is 3.16:1 (fails AA); documented in colors.ts. v2 doc diverges; code wins. |
| `--color-structure` / `-press` | hexes exist (`brandPrimary`/`accentHard`) but no semantic theme key | ADD `structure`, `structurePress` to all themes |
| `--color-support: #F59E0B` (+ on-support) | none (`warning` is `#FACC15`, distinct) | ADD `support`, `onSupport` to all themes + palette |
| `--color-border-soft` (40%/30% alpha) | none | ADD `borderColorSoft` to all themes |
| `--shadow-card` / `--shadow-pop` (per theme) | none | ADD `elevationTokens` (plain export keyed by theme name, like `motionTokens` — not Tamagui theme keys) |
| `--bw-structure: 2px` / `--bw-hair: 1px` | not tokenized | ADD `borderTokens` (plain export, joins the `tokens` bag) |
| `--sp-8: 72px` | space scale is `$0–$7` (matches v2 otherwise) | ADD `$8: 72` + `"4xl"` alias. Integer-only footgun still applies. |
| `--radius: 0` locked | `radiusTokens` already all-zero | none |
| `--container` 1200 / 1440 | not tokenized | defer (Phase 3 layout concern) |
| motion `--t-base 160ms` | motion tokens 120/180/240; globals.css mirrors | defer — not worth churning both mirrors for 20ms |
| Stub theme (full palette) | current `light` is white/steel-blue, unrelated | ADD new `stub` theme |

## Stub theme values (from v2 doc)

bg `#F6F0E4` · surface `#FDFAF3` · raised `#EFE7D6` · ink `#211C16` · ink-muted `#5C544A` ·
border `#211C16` (ink!) · border-soft `rgba(33,28,22,.3)` · accent `#E2481D` / hover `#B93312` ·
structure `#211C16` / press `#000000` · support `#F59E0B` (on-support `#211C16`) ·
shadow-card `4px 4px 0 rgba(33,28,22,.85)` · shadow-pop `6px 6px 0 rgba(33,28,22,.9)`.

Contrast note: white on `#E2481D` is ~4.1:1 (AA-large only). Small-text-on-accent in Stub should use
the `#B93312` fill (white = ~6:1) or ink-on-support. Flagged for the component pass (Phase 2).

## Name-locked hazards (why additive-only)

1. `ActiveThemeInjector` mutates via `updateTheme({ name: "dark" })` + `getDarkThemeSnapshot()` —
   renaming/aliasing `dark` silently kills runtime platform presets.
2. `AppThemeProvider` hard-codes `BASE_THEME = "dark"`.
3. Embeds render `<Theme name="light">` (`EmbedEventDetail.tsx`) + independent hex fallbacks in
   `embed-theme.ts` (candidate to re-derive from Stub in Phase 3, wave 2).
4. `apps/mobile/App.tsx` and `apps/scanner/App.tsx` pass `theme="dark"`; both keep hand-mirrored
   palettes in `src/ui/colors.ts` (drift risk if dark values ever change — none change in Phase 1).
5. Key-set parity: `getThemeTokenKeys()`/snapshots derive from `lightTheme`'s keys; theme-editor
   groups come from `THEME_TOKEN_GROUPS`. Every theme must carry identical keys; new keys must be
   added to all themes + the groups list.
6. `packages/ui/src/ui/tamagui/components/shared.ts` types `ThemeName = "light" | "dark"` and indexes
   `colorTokens.roles[theme]` — widen + add `roles.stub` when adding the theme.

## Migration backlog (Phase 3 fan-out input — from the sweep)

Raw hex outside token files: **1,102** (apps/web 995 · @th/ui components 107).
By route group: `_components`-shared 318 · admin 261 · events 110 · platform 86 · search 56 ·
embed 39 · places/p 37. Worst files: UniversalSearchPage (56), ThemeEditor (49, **exempt** — color
editor), event-content.css (40), SpotlightSearch (35), SeatMapPicker (32), OrderStatusBadge (28),
embed-theme.ts (25, **exempt** — embed contract), draw.ts (25, canvas — case-by-case).
Border-radius violations: **85** (plus 673 corner-radius/circular variants, many `999px` circles —
needs a deliberate "circles allowed?" ruling; avatars/spinners likely keep them).
@th/ui internal offenders to fix in Phase 2: DataTable (24), SonnerBridge (22), RangeSlider (11),
shared.ts (8).

## Phase plan

- **Phase 1 (this change):** tokens + `stub` theme + new semantic keys + globals.css var mirrors.
  Additive only; no visual change to any existing surface.
- **Phase 2:** @th/ui atoms/molecules to v2 grammar (Button/Chip/Badge/claimed-bar + new dateblock,
  priceblock, metalist, searchbar, ticket-stub, lineup-row). Storybook = review surface.
- **Phase 3:** page migration in 4 waves by route group (public → transactional → admin/platform →
  static), parallel agents, worktree isolation, `ui` → `reviewer` loop + visual-critique per page.
- **Enforcement (with Phase 2):** lint/CI grep gates — no new raw hex outside token files, no
  non-zero radius literals, spacing from scale only.

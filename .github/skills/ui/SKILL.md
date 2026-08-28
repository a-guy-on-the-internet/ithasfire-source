---
name: ui
description: 'Use when: building, modifying, or reviewing Ithas Fire UI pages, components, layouts, styling, design tokens, accessibility, responsive states, frontend UX, web/mobile screens, Tamagui components, and Swiss International design-system alignment. Invoke for UI implementation and design-review tasks.'
argument-hint: "Describe the UI task, surface, and user workflow"
---

# Ithas Fire UI

Use this skill for Ithas Fire UI implementation and design review. It packages the project design-system rules that were previously referenced as UI-agent behavior so any agent can load the same standards on demand.

## Source References

- **`docs/design/design-system-v2.md`: THE SOURCE OF TRUTH. Read it first for any visible UI
  work.** Token architecture, the v2-name→code-token mapping, theme keys, non-negotiables,
  flex-vs-grid, icon grammar, sanctioned organisms, S1–S7 section slots, budgets.
  Its browsable companion is `docs/design/ithasfire-design-system-v2.html` (Ember/Stub toggle).
- `AGENTS.md`: strict Swiss content rules, soft chrome exception, token discipline.
- `docs/design/style-guide.md`: typography, spacing, motion, voice. **Its palette and
  "Dark Mode" sections are SUPERSEDED by design-system-v2.md — do not take colors from it.**
- `docs/prompts/ui.md`: UI architecture, tRPC/data rules, component workflow, QA expectations.
- `packages/ui/src/ui/tamagui`: canonical components, tokens, themes, and shared primitives.
- `packages/ui-email/src/theme`: email-safe UI tokens and typography.

## When To Use

Load this skill when the task touches:

- Web pages, route surfaces, dashboards, admin tools, event builder sections, checkout, auth, maps, or public event pages.
- React Native or Expo screens in `apps/mobile`, `apps/scanner`, or another mobile surface.
- Shared UI primitives, Tamagui tokens/themes, Storybook stories, email templates, layout systems, or visual QA.
- Accessibility, keyboard/focus behavior, responsive design, loading/empty/error states, copy, or visual polish.
- Design review after implementation, especially for mobile UI after engineering review.

Do not use this skill for pure core/business logic, adapters, database migrations, or infrastructure unless a visible UI surface is part of the task.

## UI Build Workflow

1. **Classify the surface.** Identify whether this is web, mobile/scanner, shared UI, email, or documentation. Read adjacent files before editing.
2. **Map the data contract.** UI consumes typed tRPC/server helpers. Never call Prisma, adapters, Stripe, Redis, or core repos directly from UI components.
3. **Pick existing patterns first.** Reuse `@th/ui`, local form primitives, route shells, existing hooks, and nearby styling conventions before adding a new abstraction.
4. **Design the states.** Include normal, loading, empty, error, disabled, permission-denied, and success states where the workflow can enter them.
5. **Implement with tokens.** Use Tamagui/theme tokens and shared primitives. Add tokens only when existing ones cannot express the need.
6. **Verify ergonomics.** Check keyboard/focus, responsive layout, text fit, reduced motion, and mobile tap targets. Verify colors resolve on the **Stub** (default light) theme — including the SSR/first-paint fallback, not just the hydrated value.
7. **Validate narrowly.** Run the smallest test/build/typecheck command that covers the changed surface; use Playwright for high-risk browser workflows.

## Ithas Fire Design Rules

### Content Uses Strict Swiss

Content is the primary thing the user came for: page bodies, forms, data tables, event cards, hero sections, CTAs, dashboards, editor panels, and repeated items.

- Use `borderRadius: 0` unless an existing component contract requires otherwise.
- Prefer thick visible borders and clear separators over shadows.
- Use uppercase bold labels for field labels, tool labels, and compact structural headings.
- Hover/active states should be decisive: color inversion, stronger borders, or clear position/opacity changes.
- Keep cards restrained; do not nest cards inside cards.
- Page sections should be full-width bands or unframed layouts with constrained inner content, not decorative floating cards.

### Chrome Uses Soft Chrome

Chrome is the frame around the work: navbar controls, profile/avatar buttons, notification bells, popover triggers, language pickers, floating action bars, and tiny tool affordances.

- Pill shapes (`borderRadius: 999`) are allowed for chrome.
- Hairline low-alpha borders and frosted/glass effects are allowed when they recede behind the content.
- Use snappy 150-200ms transitions.
- The test: if it is the frame around the user's task, soft chrome is fine; if it is the task content, use strict Swiss.

### Typography

- **Two brand fonts.** Montserrat carries everything readable — display, heading, body.
  IBM Plex Mono carries the **label idiom**: labels, kickers, meta lines, prices, index
  numbers, table heads, and genuine code. Both are self-hosted; keep new UI on these two.
- **Size and tracking travel together.** The mono ladder is five size/tracking pairs
  (`monoScale` in `packages/ui/.../tokens/typography.ts`, or `--fs-mono-*` / `--tr-mono-*`).
  Reach for `<Text variant="overline">` (11/2px, the workhorse) or `variant="kicker"`
  (11/3px, the eyebrow above a headline) before hand-rolling uppercase and letter-spacing —
  a mono size without its tracking is small monospace text, not the idiom.
- Native has no `var()`, so `$mono` falls back to the platform monospace on React Native.
  Column-aligned digits on the sans face still use `font-variant-numeric: tabular-nums`.
- Keep body letter spacing at `0`. Do not scale font size with viewport width.
- Match text scale to the container: compact panels and dashboards need compact type, not hero-scale headings.

### Color And Tokens

**Full contract: `docs/design/design-system-v2.md`. The essentials:**

- Canonical token VALUES: `packages/ui/src/ui/tamagui/tokens/colors.ts`.
- **Stub (warm paper, light) is the shipped default theme.** Ember (navy, dark) exists but is
  currently inert — the theme injector pins stub. Don't assume dark mode works.
- **Theme keys are `stub` / `swiss` / `ember` — NOT `light` / `dark`.** Detect dark with
  `useThemeName() === "ember"` (`@/hooks/useIsDarkTheme`). `startsWith("dark")` never matches
  and has already shipped as dead code once.
- Prefer semantic/theme tokens such as `$surface`, `$surfaceMuted`, `$color`, `$colorMuted`, `$borderColor`, `$accent`, and intent tokens.
- **`$accent` (#E2481D) CANNOT carry small text — in either polarity** (white 4.06:1, ink 4.38:1).
  It is the one brand value with no AA foreground; keep it for borders, rules, dots, large graphics
  and tints (≥3:1 is all those need). The moment a label sits on the fill, climb the ladder:
  `$brandSecondaryHover` (#B93312) + `$onBrandSecondary` (white) = 5.92:1 → hover
  `$brandSecondaryStrong` (8.10) → press `$brandSecondaryPress` (10.38). For accent-coloured TEXT on
  a light surface use `$accentText` (#B93312, 5.22:1). In `apps/web` these are `ACCENT_FILL` /
  `ON_ACCENT_FILL` / `ACCENT_FILL_HOVER` in `@/lib/design-tokens`. Note `$accentHover` is NOT the
  hover rung — on Stub it equals the rest rung, so it renders as a no-op.
- **Migrate a fill and its foreground AS A UNIT.** A themed fill with a fixed foreground (or the
  reverse) drifts apart. If a surface is fixed in every theme (an LED band, a photo scrim, a camera
  feed), keep BOTH sides fixed literals; if it's themed, theme both. Never half of each.
- **No raw hex in components.** If you're typing `#`, check for an existing semantic token
  first. New tokens need a clear name, a stated reason, and entries in ALL three themes.
- In raw CSS / inline styles / lucide `color=`, use `var(--token, <stub-hex>)`. The injector
  sets `--<key>` at runtime; **the fallback is what SSR/first paint renders** — a dark fallback
  causes a flash. Canvas/MapLibre/data palettes can't take `var()` — use `palette.*` hex there.
- **`.css` files are gated too** (`apps/web/scripts/lint-css-colors.mjs`, runs in `pnpm lint`).
  Same three rules as the eslint gate: bare hex · `rgba(255,255,255,…)` · the bare `white`
  keyword. Hex inside a `var()` fallback is fine; `white` inside one is NOT (a fallback must be
  the Stub value, and Stub has no bare white). Exempt a genuinely-correct literal at the site:
  `/* ds-color-ok: <reason> */` (or `ds-color-ok-start`/`ds-color-ok-end` for a block) — a reason
  is required. Use `/* ds-color-debt: <reason> */` only for known-wrong-but-not-yet-fixed; that
  count must only ever shrink. The `:root` block of `globals.css` is the primitive tier and is
  exempt by design.
- `STRUCTURAL` (`@/lib/design-tokens`) is theme-tracking (ink on Stub). Never concat an alpha
  suffix onto it (`${STRUCTURAL}CC` is invalid CSS) — use `color-mix`.
- Budget: **accent ≤5% of any viewport, support ≤2%**. `radius: 0` is locked for content.
- Avoid one-note palettes. Ithas Fire should not drift into all-purple, beige, dark-slate-only, or brown/orange-only screens.

### Layout And Controls

- Use stable dimensions for fixed-format controls, boards, toolbars, counters, maps, and tiles so hover/focus/dynamic text does not shift layout.
- Text must fit its parent on mobile and desktop. Wrap or resize intentionally; never let labels overlap neighboring UI.
- Use familiar controls: icons for tool buttons, segmented controls for modes, toggles/checkboxes for binary settings, sliders/inputs for numbers, tabs for views, menus/selects for option sets.
- Use Lucide icons where available, and provide labels/tooltips for icon-only controls.
- Minimum practical tap target is 44px on mobile/touch surfaces.
- Do not add decorative orbs, bokeh blobs, or gradient-only backgrounds.

### Accessibility

- Use semantic elements and ARIA where needed, especially for custom select, autocomplete, tabs, dialogs, maps, and comboboxes.
- Preserve keyboard navigation and visible focus states.
- Manage focus when opening/closing dialogs, popovers, drawers, and multi-step forms.
- Honor reduced-motion preferences.
- Maintain at least 4.5:1 contrast for body text and important controls.

## Engineering Rules For UI

- Web defaults to Next.js Server Components; use `'use client'` only for interactive islands.
- Use typed tRPC hooks from the app's `trpc` module or server-only helpers. Do not hand-roll response types.
- Keep business rules in core use cases. UI may format, orchestrate, and validate ergonomically, but authorization, money, idempotency, and durable validation stay server-side.
- Put human-facing copy in the existing i18n/message system when the surface already uses it.
- Prefer `react-hook-form` plus Zod resolver where local patterns already use it; otherwise mirror adjacent form primitives.
- Avoid adding global state unless React Query, props, or route state are insufficient.
- For maps, media, 3D, and animations, verify the rendered output, not just TypeScript.

## Design Review Checklist

When reviewing UI changes, lead with findings and use the same levels as engineering review:

- `[BLOCKING]`: Broken workflow, inaccessible interaction, unreadable/overlapping content, wrong data contract, severe responsive failure, or clear violation of strict Swiss/content rules.
- `[WARNING]`: Visual inconsistency, missing state, weak accessibility semantics, avoidable token drift, insufficient tests for a risky surface.
- `[NIT]`: Small polish issue that does not block shipping.

Check:

- Content vs chrome classification is correct.
- Both brand fonts land where they belong: Montserrat for reading, Plex Mono for the label idiom.
- Layout aligns with nearby sections and does not introduce unexplained padding offsets.
- Loading, empty, error, disabled, and success states are present where relevant.
- Keyboard, focus, screen-reader labels, and mobile tap targets are handled.
- Colors come from semantic tokens and resolve correctly on the Stub default theme (no raw hex, no white-on-cream, no dark first-paint fallback).
- Responsive behavior is coherent.
- Visual assets render, maps/canvases are nonblank, and text does not overlap.

## Validation Guide

Choose the narrowest useful validation:

- Web unit/component: `pnpm -F web exec vitest --run <test files>`.
- Web build smoke: `pnpm -F web build` for broad Next.js routing or server/client boundary changes.
- Shared UI: package-specific tests or Storybook checks when available.
- Mobile/scanner: `pnpm -F scanner exec vitest --run` or `pnpm -F mobile exec vitest --run` for touched logic; Expo smoke when native config changes.
- E2E: `pnpm -F web exec playwright test e2e/<spec>.spec.ts --project=chromium` for high-risk browser workflows. Report generated videos when Playwright runs.

## Output Format

For implementation, report:

```text
Implementation Summary
- Files changed and why
- UI states covered
- Validation run and result
- Remaining risks or follow-ups
```

For design review, report:

```text
Verdict: APPROVED | CHANGES_REQUESTED
Findings
- [BLOCKING|WARNING|NIT] file: issue and suggested fix
Validation Notes
- What was or was not run
```
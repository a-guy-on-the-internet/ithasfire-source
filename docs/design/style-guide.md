# Visual Style Guide

```yaml
title: Visual Style Guide
owner: brand-design
last_reviewed: 2026-04-30
next_review: TBD
```

This guide captures the foundational visuals that inform marketing and product touchpoints.

> ## ⚠️ PARTIALLY SUPERSEDED — do not take colors from this file
>
> The **Palette** and **Dark Mode** sections below predate Design System v2. The **light**
> steel-blue palette they describe is **retired**. The navy **Dark** column is still live: it is
> the Ember theme behind the light/dark toggle (values in `colors.ts` `darkTheme`, contract in
> `design-system-v2.md` §1). As of **2026-07-16** the shipped default theme is **Stub**
> (warm paper, light): page `#F6F0E4`, ink `#211C16`, accent `#E2481D`. `structure` resolves to
> **ink**, not steel blue, on the default theme — steel blue is no longer the structural chrome
> color. Theme keys are `stub` / `swiss` / `ember` (not `light`/`dark`).
>
> - **For color/tokens → [`design-system-v2.md`](./design-system-v2.md)** (source of truth).
> - Token VALUES → `packages/ui/src/ui/tamagui/tokens/colors.ts`.
> - **Still valid here:** spacing, motion, and voice. Typography is **Montserrat +
>   IBM Plex Mono** (the 2026-07-28 "Montserrat only" rule was reversed 2026-08-26; see
>   `design-system-v2.md` §2: mono carries labels, kickers, meta lines, prices and code).

Canonical source of truth for tokens: `docs/design/design-system-v2.md` (values in
`packages/ui/src/ui/tamagui/tokens/colors.ts`).

## Palette (HISTORICAL — superseded by design-system-v2.md)

Ithas Fire uses a two-color brand system. Steel blue structures and orients; warm orange drives action.

### Brand & Accent

| Token | Hex | Usage |
| --- | --- | --- |
| `brand.primary` | #35589A | Steel blue — structural accent, borders, links, focus rings, navigation |
| `brand.secondary` | #FF5721 | Warm orange — primary action buttons, CTAs, section highlights |
| `brand.secondary.hover` | #E04A18 | Orange hover state for primary buttons |
| `accent` | #35589A | Steel blue — alias of brand primary for theme consumers |
| `accent.subtle` | #E8EDF5 | Steel-blue tinted background wash |
| `accent.hard` | #2A4578 | Darker steel blue for hover/press states |

### Neutrals

| Token | Hex | Usage |
| --- | --- | --- |
| `brand.neutral.100` | #F5F5F5 | Backgrounds, card bases, muted surfaces |
| `brand.neutral.300` | #D4D4D4 | Borders, dividers |
| `brand.neutral.700` | #707070 | Secondary/muted text |
| `brand.neutral.900` | #181818 | Main text on light backgrounds |

### Semantic States

| State | Token | Usage hints |
| --- | --- | --- |
| Success | `intent.success = #22C55E` | Confirmation banners, payout success |
| Warning | `intent.warning = #FACC15` | Soft alerts ("coupon near expiry") |
| Danger | `intent.danger = #EF4444` | Critical actions (delete, refund) |
| Info | `intent.info = #35589A` | Informational notices, system hints |

### Dark Mode

Dark theme derives its palette from the steel blue family with navy backgrounds. The **Dark** column matches the live Ember theme; the **Light** column is the retired light palette (Stub replaced it).

| Token | Light | Dark | Notes |
| --- | --- | --- | --- |
| `background` | #FFFFFF | #0F1B33 | Deep navy, derived from steel blue |
| `surface` | #FFFFFF | #162240 | Slightly raised navy panels |
| `surfaceMuted` | #F5F5F5 | #1E2E52 | Secondary surfaces |
| `color` (text) | #181818 | #FFFFFF | Primary text |
| `colorMuted` | #707070 | #A0B0CC | Muted text |
| `accent` | #35589A | #FF5721 | Orange for structural highlights in dark mode |
| `borderColor` | #8C8C8C | #5A78A6 | Structural borders (≥3:1 vs surfaces for WCAG 1.4.11) |
| `borderColorHover` | #35589A | #FF5721 | Interactive border feedback |

Orange takes over the accent role in dark mode to maintain contrast and warmth against navy surfaces.

## Typography

| Token | Typeface | Weight | Usage |
| --- | --- | --- | --- |
| `type.display` | Montserrat | ExtraBold | Marketing hero headlines, homepage |
| `type.heading` | Montserrat | SemiBold/Bold | Product section titles, dialogs |
| `type.body` | Montserrat | Regular/Medium | Product UI, forms, onboarding copy |
| `type.mono` | IBM Plex Mono (`--font-mono`) | 400–700 | Labels, kickers, meta lines, prices, table heads, code. Use the `monoScale` size/tracking pairs. Aligned digits on the sans face use `tabular-nums`. |

- Line-height: `display 120%`, `heading 130%`, `body 150%`
- Letter spacing: headings `-0.01em`, body `0em`
- Fallbacks: the app's `--font-mono` chain ends in the system mono stack; sans ends in the system sans stack
- Email templates also use Montserrat with web-safe fallbacks. See the Email section below.

Typography should feel honest and technical — functional over decorative, never shouting.

## Email

Design rules for transactional and marketing email templates. Reference: `packages/ui-email/src/theme/tokens.ts`, whose header explains why email carries literal Stub values and no `var()` theming.

### Typography

Font: Montserrat with a web-safe fallback stack (`Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`). Printed-frame emails may set labels in IBM Plex Mono with a system mono fallback (`typography.monoFamily`).

### Buttons

| Variant | Background | Text | Radius | Padding | Weight |
| --- | --- | --- | --- | --- | --- |
| Primary CTA | #B93312 (`brandAccent`, the AA-safe accent rung) | #FFFFFF | 0px | 16px 28px | 700 |
| Secondary | #FFFFFF with a 1px #211C16 (`brand`, ink) border | #211C16 | 0px | 16px 28px | 700 |

### Layout

- Email background: #FFFFFF (`surface`). Printed-frame emails sit on a cream page, `canvas` #FDFAF3.
- Container border: 1px solid #DED7CC (`border`)
- Base font size: 14px, line-height 1.5

### Compliance

- Every email must include an unsubscribe link and physical mailing address (CAN-SPAM).
- All new email templates must accept a translator context for i18n. `TicketIssued` is the reference implementation pattern.

## Iconography & Illustration

- Primary style: outlined, 2px stroke, 2px corner radius.
- Principle: “Form follows function.” No gradients or skeuomorphism.
- Event category illustrations: minimalist black/white vector with a single accent (success green or info blue).
- Functional icons: Lucide (`lucide-react`), stroke 2, `currentColor` (see `design-system-v2.md` §6).
- Asset source: Figma → Icons & Components.

Use illustration sparingly — it should clarify, not decorate.

## Layout & Spacing

| Scale step | Pixels | Used for |
| --- | --- | --- |
| `space.xs` | `4px` | Label + input gaps |
| `space.sm` | `8px` | Inside cards, list items |
| `space.md` | `12px` | Default vertical rhythm |
| `space.lg` | `16px` | Section spacing |
| `space.xl` | `24px` | Page padding (mobile) |
| `space.2xl` | `32px` | Page padding (desktop) |

- Grid defaults:
  - Marketing: 12-column grid, 80px gutters desktop, 24px mobile
  - Product: 8-column grid, 24px gutters desktop, 16px mobile
- Breakpoints (Tamagui media, `packages/ui/src/ui/tamagui/index.ts`): `xs` ≤480px, `sm` ≤640px, `md` ≤900px, `lg` ≤1200px, `xl` ≤1440px, plus min-width `gtXs`, `gtSm`, `gtMd` forms

Rhythm and whitespace communicate calmness; minimalism signals confidence.

## Motion & Interaction

| Token | Duration | Easing | Usage |
| --- | --- | --- | --- |
| `motion.fast` | `120ms` | `ease-out` | Button hover, simple fades |
| `motion.base` | `180ms` | `ease-in-out` | Modals, drawers |
| `motion.slow` | `240ms` | `ease-in` | Complex sequences |

- Springs: card reveal or list sort → duration `220ms`, stiffness `260`, damping `20`.
- Reduced motion: honor user preference; swap animations for fades or instant states.
- Feedback principle: animation confirms the action; never adds decoration.

“Motion is honesty in time.” Show intent, not flourish.

## Voice & Tone Snapshots

| Scenario | Voice traits | Language do / don't | Component hooks |
| --- | --- | --- | --- |
| Purchase confirmation | `Relieved, trustworthy` | Do: "Your tickets are locked in — here’s your QR." • Don’t: "You did it!" | `ConfirmationBlock`, `ReceiptCard` |
| Event cancellation | `Empathetic, clear` | Do: "This event was canceled. Refund is on the way." • Don’t: "Sorry for the inconvenience." | `AlertBanner`, `RefundNotice` |
| Organizer onboarding | `Encouraging, confident` | Do: "You can host your first event in 5 minutes." • Don’t: "Getting started is easy!" | `OnboardingChecklist` |
| Error state | `Grounded, transparent` | Do: "Something failed on our end — retrying now." • Don’t: "Oops!" | `ToastError`, `InlineNotice` |
| Account payout | `Professional, friendly` | Do: "We sent $312.47 to your account." • Don’t: "Cha-ching!" | `PayoutSummary`, `SuccessToast` |

## Summary Design Principles

1. Honesty over artifice — every color, word, and motion has a reason.
2. Calm, monochrome core — accent only when meaning demands it.
3. Accessible by default — 4.5:1 minimum contrast, motion respect, screen-reader tested.
4. Built to scale ethically — clean, modular, minimal brand sprawl.

## Governance

- `last_reviewed: 2026-04-30`
- Update this guide whenever palette, type, or token changes ship.

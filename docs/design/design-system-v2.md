# Design System v2 — Canonical Reference

**This is the source of truth for all Ithas Fire UI work.** Load it before building or
reviewing any visible surface. The browsable/themeable companion is
[`ithasfire-design-system-v2.html`](./ithasfire-design-system-v2.html) (open it in a browser and
flip the Ember/Stub toggle). This markdown is the agent-readable contract; where the two
disagree, **this file and the code win** — see [Divergences](#3-divergences-code-wins).

> Supersedes the palette/dark-mode sections of [`style-guide.md`](./style-guide.md), which
> predates v2 and still describes the retired steel-blue/navy scheme.

---

## 1. The shipped reality (read this first)

- **Stub (warm paper, light) is the shipped default theme** as of 2026-07-16.
  `DEFAULT_THEME_MODE = "light"` (`apps/web/src/lib/theme-mode.ts`) maps to `stub`.
- **Ember (navy, dark) is live behind the light/dark toggle** (shipped 2026-07-20). The `th-theme`
  cookie carries the mode, `AppThemeProvider` renders `stub` or `ember`, and `ActiveThemeInjector`
  mirrors the snapshot for the active mode (`getStubThemeSnapshot()` / `getDarkThemeSnapshot()`)
  onto `<body>` as inline `--<key>` vars. Embeds are locked to light. Check dark for any UI change.
- **Theme KEYS are `stub` / `swiss` / `ember`** — _not_ `light` / `dark`.
  (`packages/ui/src/ui/tamagui/index.ts`.) The keys deliberately avoid `light`/`dark` prefixes
  because Tamagui emits prefix-matched themes into a `@media (prefers-color-scheme)` `:root`
  rule, which caused a first-paint flash.
  - **Detect dark with `useThemeName() === "ember"`** (helper: `@/hooks/useIsDarkTheme`).
    `startsWith("dark")` silently never matches — this shipped as dead code once already.
  - `swiss` = the older pure-white light theme, a legacy key: embeds now render Stub (`apps/web/src/lib/route-context.ts`) and no live web code uses `swiss`. Don't repurpose it; ask the owner before deleting it.

## 2. Token architecture — three tiers

1. **Primitive** — raw values (hex, px). Live _only_ in
   `packages/ui/src/ui/tamagui/tokens/colors.ts` (`palette`) and the `:root` block of
   `apps/web/src/app/globals.css`.
2. **Semantic** — primitives mapped to meaning (`accent`, `colorMuted`, `borderColorSoft`).
   Themes redefine this layer; components never change.
3. **Component** — consumes semantic tokens **exclusively**.

**The rule: no raw hex in component code.** If you're typing `#`, you're doing it wrong —
check for an existing semantic token first. New tokens need a clear name and a stated reason,
and must be added to **all three** themes.

### v2 doc name → actual code token

The HTML doc uses `--color-*` names. **The code does not.** Use this mapping:

| v2 doc (`--color-…`)      | Code token (Tamagui key / CSS var)    | Stub (default)      | Ember (dark)          |
| ------------------------- | ------------------------------------- | ------------------- | --------------------- |
| `--color-bg`              | `background` / `var(--background)`    | `#F6F0E4`           | `#0F1B33`             |
| `--color-surface`         | `surface`                             | `#FDFAF3`           | `#162240`             |
| `--color-surface-raised`  | `surfaceRaised`                       | `#EFE7D6`           | `#1A2847`             |
| `--color-ink`             | `color`                               | `#211C16`           | `#FFFFFF`             |
| `--color-ink-muted`       | `colorMuted`                          | `#5C544A`           | `#A0B0CC`             |
| `--color-border`          | `borderColor`                         | `#211C16`           | `#5A78A6`             |
| `--color-border-soft`     | `borderColorSoft`                     | `rgba(33,28,22,.3)` | `rgba(90,120,166,.4)` |
| `--color-accent`          | `accent` / `brandSecondary`           | `#E2481D`           | `#FF5721`             |
| `--color-accent-hover`    | `accentHover`                         | `#B93312`           | `#FF7E52`             |
| (no v2 doc name)          | `brandSecondaryHover`                 | `#B93312`           | `#E84B19`             |
| `--color-on-accent`       | `onBrandSecondary`                    | `#FFFFFF`           | `#181818` ⚠️          |
| `--color-structure`       | `structure`                           | `#211C16`           | `#35589A`             |
| `--color-structure-press` | `structurePress`                      | `#000000`           | `#2A4578`             |
| `--color-support`         | `support`                             | `#F59E0B`           | `#F59E0B`             |
| `--color-on-support`      | `onSupport`                           | `#211C16`           | `#0F1B33`             |

Spacing (`--sp-1..8` = 4/8/12/16/24/32/48/72), breakpoints (480/640/900/1200), and `radius: 0`
are already v2-compliant in code.

### Two brand fonts (changed 2026-08-26)

**Montserrat + IBM Plex Mono.** This reverses the 2026-07-28 "Montserrat is the only brand font"
decision and the sweep that moved every decorative mono site onto Montserrat + `tabular-nums`.

- **Montserrat** — everything readable. Display 900 with negative tracking; body 400/500.
- **IBM Plex Mono** — every label, kicker, meta line, price, index number, table head, and genuine
  code. Self-hosted (`apps/web/public/fonts/IBMPlexMono-{400,500,600,700}.woff2`, latin subset,
  ~40KB total), declared in `apps/web/src/app/layout.tsx` as `--th-font-mono`, consumed as
  `--font-mono`. Static instances — IBM does not ship Plex Mono as a variable font.

The tracked uppercase mono label is the single most identifying mark of the brand. **Size and
tracking travel together**: use the pairs in `monoScale` (`packages/ui/src/ui/tamagui/tokens/typography.ts`)
or the `--fs-mono-*` / `--tr-mono-*` custom properties. A mono size applied without its tracking is
not the idiom — it is just small monospace text.

| Step  | Size   | Tracking | For                          |
| ----- | ------ | -------- | ---------------------------- |
| `lg`  | 13px   | 0.4px    | prices, large meta, kbd      |
| `md`  | 11.5px | 1.4px    | meta lines, table cells      |
| `sm`  | 11px   | 2px      | labels, kickers              |
| `xs`  | 10px   | 2.5px    | field labels, table heads    |
| `2xs` | 9.5px  | 2.5px    | tags, badges, stamps         |

Two ready-made idioms live beside the scale: `labelIdioms.label` (11px/2px/600) and
`labelIdioms.kicker` (11px/3px/600). Both carry their own `textTransform: uppercase` so a caller
cannot apply half the idiom.

Native has no `var()`, so `$mono` falls back to the platform monospace on React Native until the
mobile pass lands. Aligned digits on the sans face still use `font-variant-numeric: tabular-nums`.

Enforcement: `packages/ui/src/ui/tamagui/__tests__/design-system-v2.test.ts` → _"Montserrat + IBM
Plex Mono are both wired"_. The guard checks the woff2 files exist, the font variable reaches
`<html>`, and `--font-mono` chains through the self-hosted face before the system stack — because
the failure mode is silent: lose any one of those and every label falls back to the platform
monospace without anything going red.

### How to consume tokens by context

- **Tamagui components** → `$accent`, `$colorMuted`, … or `useTheme().accent?.val`.
- **Raw CSS / inline styles / lucide `color=` / CSS-in-JS** → `var(--accent, #E2481D)`.
  `ActiveThemeInjector` mirrors the full theme snapshot onto `<body>` as inline `--<key>` vars,
  so `var(--x)` resolves at runtime. **Always supply the Stub hex as the fallback** — the
  fallback is what SSR/first paint renders before hydration. A navy fallback = a dark flash.
- **Canvas / MapLibre paint / data palettes** → these cannot take `var()`. Use a real hex
  (in `apps/web`, `import { palette } from "@/lib/design-tokens"`; elsewhere `colorTokens.palette`
  from `@th/ui/colors`). Avatar/confetti color arrays are _data_, not chrome — leave them.

## 3. Divergences (code wins)

| Topic                    | HTML doc says            | Code does                        | Why                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--color-on-accent`      | `#FFFFFF` in both themes | Ember uses ink `#181818`         | White on `#FF5721` is **3.16:1 — fails AA**. Ink is 5.61:1. (Ink on the `#E84B19` rung is 4.61:1.)                                                                                                                                                                 |
| Small text on accent     | n/a                      | Use the `#B93312` fill           | White on `#E2481D` is only 4.06:1 (AA-large) — and ink on it is just 4.38:1, so **neither polarity clears AA**. On `#B93312` white reaches 5.92:1. The Button `primary` atom and the CAB primary CTA both rest there.                                              |
| Accent **as** small text | n/a                      | `accentText` / `accentTextPress` | The same failing pair inverted: `accent` #E2481D **as a label** is 3.57:1 on Stub's canvas / 3.89:1 on `surface`. `accentText` is that hue at label legibility (Stub `#A8300F`, 5.98:1 on the canvas and 6.51:1 on `surface`; Swiss/Ember unchanged — their accents already clear AA as text). See below. |
| Theme names              | `ember` / `stub`         | keys `ember`/`stub`/`swiss`      | `swiss` is the legacy white theme; no live web consumer.                                                                                                                                                                                                                  |

## 4. Non-negotiables

- **`radius: 0`.** Locked. No pills for content. (Chrome exception below.)
- **No raw hex in components.** Semantic tokens only.
- **Gap, never margins, between siblings.** Margins only for `margin: auto` pinning.
- **Budget: accent ≤ 5% of any viewport, support ≤ 2%.** If a mock feels loud, it's over budget.
- **One primary button per viewport.** If two actions compete, one is secondary — decide.
- **`STRUCTURAL` (`@/lib/design-tokens`) is theme-tracking** — it resolves to
  `var(--structure, #211C16)` (ink on Stub). **Never concatenate an alpha suffix**
  (`${STRUCTURAL}CC` produces invalid CSS) — use `color-mix(in srgb, … X%, transparent)`.
  For the raw steel-blue brand hex, use `palette.brandPrimary` from `@/lib/design-tokens` explicitly.

### Content = strict Swiss · Chrome = soft chrome

- **Content** (hero, headlines, CTAs, cards, forms, tables — what the user came for) → strict
  Swiss: `radius: 0`, thick visible borders, no shadows, decisive color-inversion hovers,
  UPPERCASE bold labels.
- **Chrome** (navbar controls, avatars, bells, popover triggers, floating bars — the _frame_) →
  soft chrome: pills (`radius: 999`), hairline low-alpha borders, frosted glass, 150–200ms
  transitions.
- Test: _is this the content, or the frame around it?_ Frame → soft. Content → strict.

## 5. Flex vs Grid — strict rules

One question decides it: **do columns need to align across rows?** Yes → Grid. No → Flex.

| Context                        | Use  | Pattern                                                                   |
| ------------------------------ | ---- | ------------------------------------------------------------------------- |
| Card collections               | GRID | `repeat(auto-fill, minmax(272px, 1fr))` — never media-query column counts |
| Multi-column page regions      | GRID | Explicit asymmetric fr: `7fr 5fr`. Never 50/50 unless truly equal         |
| Table-like rows (lineup, stub) | GRID | Fixed first/last, fluid middle: `110px 1fr auto auto`                     |
| Nav bars, button rows, chips   | FLEX | `display:flex; gap:$2` — content-sized, wraps                             |
| Card internals                 | FLEX | `column` + `margin-top:auto` to pin footers; equal-height siblings        |
| Meta lists, icon+label         | FLEX | row, `align-items:center`, gap only                                       |

Grid for the skeleton, flex for the flesh. Never a grid inside a grid to fake a row; never
flex-basis percentages to fake columns. Grids collapse by re-declaring
`grid-template-columns` — **never by hiding content**.

Containers: content 1200px; full-bleed chrome 1440px; side padding `$6` desktop / `$4` mobile.

## 6. Button & icon grammar

- **Trailing icon** = direction/progression only (arrow, chevron, external-link). "Takes you somewhere."
- **Leading icon** = object/context (ticket, calendar, user, search). "About a thing."
- **Never both.** One icon max per button.
- Sizes: sm 36px/13px icon · md 44px/15px · lg 54px/16px. Lucide only, stroke-width 2 (2.5 arrows).
- Icons use `currentColor` — they never carry their own color.
- Icon-only: square, `aria-label` required, ≥44×44 touch target.
- Labels: UPPERCASE, +1.5px tracking, weight 700, 1–3 words, verb first ("Get Tickets").

## 6a. Forms — validation timing and the optional marker

Forms stay **boxed** (label above, control in a 2px box) — the design-system folder's ledger-row
default is not adopted. Two sub-decisions from that folder are (2026-08-26):

### Validation timing: blur → clear on input → re-validate on submit → focus the summary

- **Validate on blur.** A field is checked when the reader leaves it, never while they type.
- **Clear on input.** The moment the reader edits an errored field, its error goes away. Typing
  is never blocked and never nagged.
- **Re-validate everything on submit.** Failed submit → render every error → move keyboard focus
  to the `ValidationSummary` (`@th/ui`, a labelled `role="group"` with `tabIndex={-1}` — not a live
  region, since the focus move already announces it and `role="alert"` would read it twice; the
  `useValidationSummaryFocus()` helper does the deferred focus for you).
- **Inline field errors stay.** The summary is for orientation, the inline error is for the fix.
  Both, always — the summary never replaces per-field messages.
- The summary is required on any form over roughly six fields and on every step of the event
  builder. Every entry links to its field (`fieldId`); an entry you cannot activate is a worse
  version of the errors already on screen. It renders nothing when empty, so leave it mounted.

### Mark OPTIONAL fields; leave required fields unmarked

- `FieldLabel optional` renders a muted "(optional)" suffix. There is **no required marker** — no
  asterisk, no dot, no "\* = required" legend. `required` still travels on the **control**
  (`required` / `aria-required`) so assistive tech announces it; it draws nothing on the label.
- **Why:** checkout and KYC are ~90% mandatory. Asterisking required fields marks nearly
  everything and communicates nothing; marking the exceptions is the signal.
- Hand-rolled markers (`*` inside a label, `<sup>*</sup>`, `aria-hidden">*`, `label="Email *"`)
  are violations — remove them and mark the optional siblings instead.
- **Decision (2026-08-26): required is unmarked, full stop.** The event builder's accent
  left-bar (`RequiredFrame`, a `role="group" aria-required` wrapper — invalid ARIA) was removed
  for the same reason. Required-ness lives on the control itself (`required` /
  `aria-required` on the input, the date field, the select, the combobox), never on a wrapper
  or a label.

## 7. Sanctioned event organisms

Three ways to render an event. All share the same molecules (date block, meta list, price
block, claimed bar). **Pick by density need, not taste. Never mix renderers in one collection.**

| Organism        | Use when                                | Never                                   |
| --------------- | --------------------------------------- | --------------------------------------- |
| **Event card**  | Discovery grids, 6+ events with imagery | Sidebars / anything narrower than 272px |
| **Ticket stub** | Curated lists (4–10), editorial feel    | In auto-fill grids — max 2 columns      |
| **Lineup row**  | Full catalogs, 10+ events, text-first   | Fewer than 5 rows — needs mass to read  |

### The wallet row (attendee-owned tickets)

`TicketWalletCard` is the fourth renderer, and the only one for tickets the viewer already owns —
`/my-tickets`. It carries the **same `DateBlock`** as the ticket stub and the browse card, which is
what makes the wallet read as a stack of tickets rather than a list of links.

- **The wallet's only job is getting to the code fast.** A live ticket shows the QR glyph as its
  affordance. The third column holds **one** thing: anything not scannable (refunded, cancelled,
  past) shows its status badge in that slot *instead*, never both — a QR beside a "Refunded" badge
  invites someone to present a dead ticket.
- **Spent tickets stay in the wallet, at full contrast.** People come back looking for proof they
  attended. The title mutes; the row is never dimmed. `opacity: 0.7` reads as broken rather than as
  spent — the same reasoning that keeps sold-out event cards at full contrast.
- **The title is the link, not the card.** A card-wide anchor makes every action inside it a control
  nested in a link, which is invalid and forces `stopPropagation` on each one. The row keeps its
  full hit area through a stretched-link overlay (`.th-wallet-link::after` in `globals.css`).
- Sort upcoming soonest-first; past most-recent-first.

## 8. Section slots — S1…S7

Every page is assembled from these **in slot order**. A page may skip slots but **never reorder
them**. Index numbers (Montserrat 700, tabular-nums) are assigned top-to-bottom after assembly.

`S1 Open → S2 Signal → S3 Discover → S4 Browse → S5 Proof → S6 Convert → S7 Close`

- **S1 Open** — exactly one. Split Hero + data rail, or Statement Hero + search object.
- **S2 Signal** — optional, max 1. Marquee strip, ≤44px, real signal not decoration.
- **S3 Discover** — required on home. Section header + filter chips + one organism. Empty state required.
- **S4 Browse** — optional; only if S3 exists above. Inherits S3's organism.
- **S5 Proof** — optional. 3–4 **true** numbers, Montserrat 700 + tabular-nums,
  hairline-divided. No number, no band.
- **S6 Convert** — always second-to-last. The one place a large accent fill is allowed.
- **S7 Close** — always last, always numbered. Footer.

Composition: only **one accent-dominant band per page** (S2 _or_ S6's panel — not both at full
strength). Login is chrome, not a slot.

## 9. Accessibility floor

- ≥4.5:1 for body text and important controls (AA). Verify against the **actual** background —
  ink-on-accent and white-on-accent both fail on some fills; see [Divergences](#3-divergences-code-wins).
- **`accent` is a large-surface / graphic value, not a text colour.** It is legal for fills, 2px
  borders and rules (the 3:1 non-text floor), and for **decorative** type — the kicker
  (`labelIdioms.kicker`: IBM Plex Mono 600 uppercase, 11px, 3px tracking),
  tags, index numerals, prices — which is aria-hidden ornament and deliberately stays on
  `accent`. When accent type is an **interactive control's accessible label**, use `accentText`
  (`accentTextPress` for the press rung). That line — ornament vs. control label — is the whole
  rule; do **not** globally deepen `accent`, which would shift the product's entire visual tone.
- Semantic elements + ARIA for custom selects, tabs, dialogs, comboboxes, maps.
- Preserve keyboard nav and visible focus; manage focus on dialog/popover open/close.
- Honour reduced motion. ≥44px touch targets.

## 9a. Mandatory primitives

Two things in this product must be formatted by exactly one piece of code, because the alternative
is a price on a card, in a table and on a printed ticket that quietly disagree.

**`<Money>`** (`@th/ui`) — every amount. Integers in cents, never floats; the prop is `cents` and a
float is a type error. `showCents` defaults to `"always"`, because a bare `$45` sitting in a column
of `$8.74`s reads as a data bug; discovery surfaces pass `"auto"`. `Money.format()` returns the same
string for CSV, email and print.

Zero is the one place this **deliberately diverges** from the design system folder, whose `Money`
renders the amber FREE chip at zero unconditionally. Here `zero` defaults to `"amount"` (`$0.00`)
and FREE is opt-in via `zero="free"`. A zero tax row, a zero fee row and a zero refund are all
legitimately `$0.00`, and the component cannot tell them from a free ticket by looking at the number.

**`<DateTime>`** (`@th/ui`) — every date and time. `timeZone` is **required** and there is no
viewer-local mode: an event happens where it happens, and converting a Central showtime to the
reader's zone produces something correct and useless. The required prop makes a call site without
the venue's zone fail to compile instead of rendering a plausible wrong answer. On web it emits
`<time datetime="…">` carrying the instant, so the unambiguous value survives copy-paste and
calendar detection while the visible text stays venue-local.

The string halves live in `@th/types` (`money.ts`, `datetime.ts`) so non-React callers share the
rule. `parseDateTime` also fixes the date-only trap: `new Date("2026-08-19")` is UTC midnight per
spec, which is Aug 18 everywhere west of Greenwich.

## 9b. Voice: transparency

How copy stays honest about money and mistakes; the examples come from the full-transparency
column of the retired brand-pillars template, which defined no pillars. Per-scenario voice
snapshots live in [`style-guide.md`](./style-guide.md#voice--tone-snapshots).

- **Fees:** show them early and say what they pay for ("We take a $7 fee to keep ticketing fast and
  pay organizers on time"), not a bare "Service fee: $7.00".
- **Third-party charges:** name who added the charge, and take the buyer's side in the wording.
- **Incidents:** own the fault and say what broke and what is being done ("We messed up and your
  tickets didn't load. Here's what broke and what we're doing to fix it"). No "Oops!".

## 10. Related

- Token values: `packages/ui/src/ui/tamagui/tokens/colors.ts` (**canonical for values**)
- Components: `packages/ui/src/ui/tamagui`
- Email tokens: `packages/ui-email/src/theme`
- v2 rollout history: `docs/records/2026-07-14-design-system-v2-token-gap-map.md`,
  `docs/records/2026-07-14-design-system-v2-page-pass.md`
- Enforcement test: `packages/ui/src/ui/tamagui/__tests__/design-system-v2.test.ts`

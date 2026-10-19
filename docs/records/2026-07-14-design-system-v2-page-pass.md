# Design System v2 — Per-Page Pass Checklist (buttons · text · alignment)

Distilled from the home-page pilot (2026-07-14). This is the template prompt for the remaining
route-group passes. Scope per pass: BUTTONS, TEXT, ALIGNMENT usage only — no behavioral changes,
no @th/ui edits, no i18n message edits, no new raw hex, minimal diffs. See
`design-system-v2-token-gap-map.md` for tokens/waves.

## Buttons
- [ ] One `variant="primary"` per viewport-ish region; competing primaries → `secondary`/`ghost`.
- [ ] Migrate `variant="outlined"` → `secondary` (content) / `ghost` (chrome); flag `subtle`.
- [ ] **Kill label overrides inside Button** — inner `<Text color="#FFF">`/XStack wrappers defeat the
      atom's ink-on-orange AA fix and hover inversion. Children = plain string (+ max one icon,
      `aria-hidden`, no `color=` — currentColor inherits). Pattern: `{label}<ArrowRight/>`.
- [ ] Icons: trailing = direction only, leading = object; never both; icon-only needs aria-label.
- [ ] **Fake buttons** (styled Paragraph/div as CTA): if inside a Link keep the element (no
      `<button>` in `<a>`) but adopt atom grammar via tokens — `$brandSecondary` /
      `$onBrandSecondary` / `$brandSecondaryHover`, tracking 1.5. Never white-on-orange.

## Text
- [ ] Eyebrows/index numerals → `Text variant="kicker"` (+ `tone="accent"`); delete bespoke mono
      styled-components. A fontSize override next to large headings is OK — note it.
- [ ] Heading ladder: exactly one `h1` (hero); section titles `h2`. Cheap fixes: `tag="h2"` on a
      visual-h3 `Text`; raw `<span>` headings → real `<h2>` + `margin:0`. Watch conditional heroes
      that can drop the page's h1 (open item: carousel-only home hero has no h1).
- [ ] `color="$colorMuted"` → `tone="muted"`; no opacity hacks for secondary copy.
- [ ] Grep `'Inter'`/`Roboto` in inline `fontFamily` strings → `'Montserrat'`; wrong mono stacks
      (JetBrains/Fira) → `var(--font-mono, 'IBM Plex Mono', monospace)`.
- [ ] Mono only for kickers/data/meta (dates, counts, prices, IDs) — body copy stays Montserrat.

## Alignment
- [ ] Sibling `marginTop/Bottom` chains → parent `gap` **only when the rhythm is uniform**; skip
      asymmetric/breakpoint-dependent chains (note them). `margin:auto` pinning stays.
- [ ] Space tokens are integer-only ($2.5 → 0 silently). Off-scale literals (20/28/40): fix if
      trivial, note if deliberate/commented.
- [ ] Columns must align across rows? → grid; else flex+gap. Don't churn `@th/ui` grid internals
      from app code.

## Mechanics of a pass
- [ ] Raw hex: no new; existing duplicates → `@/lib/design-tokens` consts (inline CSS strings) or
      `$tokens` (styled components). Gradient strings / canvas code = case-by-case, usually skip.
- [ ] Hover-only affordances get `onFocus`/`onBlur` parity. (NextLinkAnchor now forwards DOM-safe
      props — handlers/style/aria reach the rendered `<a>`; Tamagui-only props do not.)
- [ ] Note (don't fix): hardcoded English aria-labels/fallbacks → i18n list; contrast consequences
      of variant demotions → taste list for the orchestrator.
- [ ] Validate: targeted vitest + tsc filtered to touched files (apps/web has ~61 pre-existing
      test-type errors — filter, don't panic) + eslint on touched files. Skip `web build` unless
      server/client boundaries changed. Prove a failing test is stale by grepping its asserted
      string in source before blaming the diff.

## Standing taste watch-items (from the atom + pilot reviews)
- Secondary (structure) outline is ~2.5:1 on the dark page — label carries the affordance per
  v2; eyeball per page, escalate if it reads ghostly (candidate: dark-only lighter structure).
- Ghost hover is invisible on the light theme (surfaceRaised == background there).
- Button labels are now 11–13px/700/+1.5 tracking with ink-on-orange primaries — expect visual
  diffs on every page; that's the update working, not a bug.

## Wave order (route groups)
1. ✅ DONE 2026-07-14 (all reviewed/APPROVED): home (pilot) · events · places/p · search ·
   orgs/humans (clean — shells; surface lives in the shared p/[slug] skin) · navbar/global
   chrome (pills retired incl. LanguageSwitcher + globals.css reskin blocks)
2. ✅ DONE 2026-07-14 (all reviewed/APPROVED): checkout+resale · my-tickets/my-rsvps/saved ·
   embeds · shared EventContent (components/events) · broken-CSS-var mechanical sweep
   (47 renames; :root fallbacks added for --accent/--colorMuted/--success/--warning/
   --danger/--info so no-fallback consumers survive first paint/query failure)
3. ✅ DONE 2026-07-14 (all reviewed/APPROVED, findings applied): account (settings/**
   deferred — concurrent session WIP) · admin/[slug] events-builder + dashboard (86+22
   outlined, phantom $colorSubtle ×50, lucide sweep, orange10→support cluster, SignupsTab
   per-row primaries demoted per review ruling) · platform/moderate (~60 outlined incl. 4
   conditionals, quotas white-on-orange, h1 ladders on every staff page) · PagePrimitives
   ButtonPrimary central ink fix (all StatusScreens) · PageEditorView shared fix.
   Phase 2B organisms SHIPPED in @th/ui: DateBlock/PriceBlock/MetaList/ClaimedBar/
   TicketStub/LineupRow + EventCard section-06 alignment (296 pkg tests).
   STILL PENDING from wave 3: account/settings/** compliance pass (run after the
   concurrent booking session lands: ~10 outlined, ~30 lucide $token strokes — list in
   the account agent report).
4. ✅ DONE 2026-07-15 (reviewed/APPROVED): about · help · legal(terms/privacy/cookie-policy/
   acceptable-use) · sell · support. Real defects fixed: cookie-policy tables had Tailwind
   light literals (#f9fafb thead + white text = unreadable) → white-alpha consts;
   SellerShell loading text was rgba(0,0,0,.7) on navy (~1.2:1, invisible) → var(--foreground)
   +opacity; sell back-link consolidated onto NextLinkAnchor with hover+focus parity.
   Residual greps: $colorSubtle 0 hits repo-wide · var(--color-*) kebab 0 hits ·
   lucide color="$token" 14 left = 13 in account/settings (deferred, booking session owns)
   + 1 EmailDeliveryBanner.tsx:62 color="$warning" (fix with the account pass).
   Wave-4 follow-ups (found, not fixed): **admin.sell* base-catalog keys are key-derived
   placeholder English** ("Sell new listing back to listings" is LIVE user-facing copy on
   /sell/listings/new — add real strings when catalogs unlock; es.json already has real
   copy) · help/_lib/server-i18n.ts built but zero importers (help chrome hardcodes
   English) · HelpNav.tsx dead (zero importers) · help landing "Popular articles" uses
   raw <a> not next/link · ACCENT_BG/STRUCTURAL_BG + STATUS_FONT_FAMILY consts now
   duplicated 2× each (About/Support, Seller/AdminShell) — hoist to design-tokens on next
   touch · AdminShell status button still literal #111/#fff (SellerShell now more
   compliant) · help category rows/ActionCards have no hover state (RSC — wants a class).

## EventCard → Section 06A fidelity (2026-07-15, reviewed APPROVED)
Aligned the shared vertical grid card to the v2 doc's `.democard` spec (global — every
event card app-wide): (1) frame border `$borderColor` → `$borderColorSoft` (doc cards use
the soft 40% hairline, not the structural border); (2) body padding `$4`→`$5` (24px) + gap
`$2.5`→`$3` (12px) — `$2.5` was NOT a real space token (integer-only scale) so it collapsed
to ~0; same fractional-collapse fixed in the dense variant (`$1.5`→`$2`), `MetaRow`
(`$1.5`→`$2`), and dense `rowGap` (`$0.5`→`$1`); (3) meta rows swapped from lucide
Calendar/MapPin icons to the doc-faithful `MetaList` molecule (accent dot=time, structure/
support dot=place, mono 12px) — gate/recurring kept as icon caption rows below; (4) art→body
2px `$borderColorSoft` divider; (5) title `letterSpacing` 0.3 (doc h4). KEPT deliberately:
price badge ink-on-orange (AA), aspect-ratio art vs fixed 150px, the View-Details CTA,
dense/horizontal list-row icons. 300 @th/ui tests. NOTE: verified in the Stub/light theme
(a concurrent session switched the app default theme + edited colors.ts/globals.css — not
part of this pass); the card tokens resolve per-theme so it maps in Ember too.

## Wave-1 follow-up backlog (found, not fixed — out of scope/behavioral)
- **Dead Follow button**: HumanPageHeader.tsx freeform `<button>` has no onClick (real
  FollowButton exists; wiring is behavioral). Worst wave-1 finding.
- **Broken CSS-var sweep**: ~45 remaining `var(--color-success|-danger|-info|-warning|…)`
  hits outside events (platform, admin, checkout, _components) — kebab names that were never
  theme keys; no-fallback ones render broken. Mechanical fix: `--success`/`--danger`/etc.
- **EventContent.tsx** (components/events) — carries the event page's real h1 + "Get tickets"
  primary; shared, unaudited. Give it its own pass slot in wave 2.
- **@th/ui ladder gap**: EventApplicationGate authed branch renders the title as h3 — page has
  no h1 in that state; add a titleTag prop in the next @th/ui pass.
- **Nav "Create Event" primary**: v2 nav grammar wants it; today creation lives inside the
  account popover — adding it is structural/behavioral, needs a product call.
- **CAB secondary language**: dock uses filled steel-blue CTAs, not the v2 structure outline —
  deliberate chrome dialect, pending a taste ruling.
- Selected-state chips render as primary fills (resale section filter, CreatePlaceForm
  owner-kind toggle, SavedEvents ScopeTabs) — Chip/segmented-control molecule, Phase 2B.
- AlertsSidebar trigger is $3 (36px) but renders on touch navbars — consider $4.
- entity-page-shell `#3b82f6` fallback (now 5×) → token candidate for the hex sweep.

## Sections 06–08 — organism & slot audit (input for the assembly phase)

Section 06 (organisms): three sanctioned event renderers — card (discovery grids, 6+ with
imagery), ticket stub (curated lists 4–10, editorial, max 2 cols), lineup row (catalogs,
10+, text-first, needs ≥5 rows). One organism per collection, never mixed. Built from the
same molecules: dateblock, priceblock, metalist, claimed bar.
Section 07 (slots): S1 Open → S2 Signal → S3 Discover → S4 Browse → S5 Proof → S6 Convert →
S7 Close. Pages may skip slots, never reorder. Mono index numbers assigned top-to-bottom
after assembly. One accent-dominant band per page (S2 OR S6, not both at full strength).
Section 08 (home assembly): exactly one S1; S6 mandatory on marketing pages; login is
chrome, not a slot.

Current-state audit (2026-07-14):
| Page | Today | Gaps vs 06–08 |
|---|---|---|
| Home | NAV ✓ · S1 map-hero (≈Split Hero+Rail, rail is the map not a data rail) · EventTicker ≈ S2 marquee · S3 event sections (cards) ✓ · S4 category browse ✓ · S7 footer | No S5 Proof (stats band — needs real numbers) · **no S6 Convert** (Create Event lives only in hero/nav — v2 makes S6 mandatory on marketing pages) · index numbering restarts per section rather than page-global · carousel hero variant drops the h1 |
| /events browse + category pages | Filter + card grid (S3 only) | Single-slot pages; candidates for lineup-row organism (10+ text-first) instead of cards; no S6 |
| /search | S1-ish search object + S3 list rows | List rows ≈ proto-lineup-rows — adopt the real organism once built |
| Event detail | Content page, not a marketing page | S-slots don't apply (own grammar); already compliant |
| Entity pages (p/places/orgs) | Own themable skin | Deliberate exception — do NOT force S-slots onto per-venue themable pages |
| my-tickets etc. | App surfaces | S-slots don't apply |

Assembly plan (after Phase 2B organisms land): (1) home — add S6 Convert band (7fr/5fr
split, mono-numbered steps, the ONE allowed large accent fill; demote or keep EventTicker
per one-accent-band rule), add S5 stats band IF real numbers exist (no number, no band),
fix page-global index numbering, give the carousel hero an h1; (2) category/browse pages —
adopt lineup-row organism + optional S6; (3) search — adopt lineup-row for event results.
Each is a structural change: own dev-loop with screenshots, not a compliance pass.

Assembly status (2026-07-14 / -15):
- ✅ (2)+(3) LINEUPROW ADOPTION DONE 2026-07-15 (built, reviewed APPROVED, findings
  applied, screenshots verified desktop+mobile). Organism extended (@th/ui, 299 tests):
  `dateLabel` now OPTIONAL (when-column drops out for date-less surfaces), added
  `subtitle` (muted prose line, shares the name's fluid track) + `compact` (72px
  when-col, 18px name, chip hidden) — old callers render byte-identical.
  CategoryPage: ViewToggle (list default = LineupRow rows / grid = existing EventGrid);
  when-column from a local `toLineupWhen(event, locale)` (Intl month/day + weekday·time
  from startsAt, graceful fallback to the pre-formatted `date` string with no time when
  startsAt absent — category events have none, so they show a clean "JUL 15"); href-only
  nav (cmd-clickable), SaveHeart sibling overlay. SEARCH event rows: LineupRow with the
  when-column OMITTED (search's EventSearchSuggestion has no reliable structured start
  time — the DATA-SHAPE finding: `helper` is a server-formatted full human date string,
  folded with venue into `subtitle`); dead gate-badge Badges (mapping hardcodes
  badges:[]) removed → remapped to the mono category chip as a forward-hook. Adjacent
  hairlines collapsed (borderTopWidth 0 after row 0). Note: LineupRow renders a raw
  `<a>` (full reload), not a Next Link — client-side nav for the organism is a possible
  future @th/ui enhancement.
- ✅ (1) HOME DONE (built, reviewed APPROVED, findings applied, screenshots verified):
  `HostConvertBand` S6 band (accent fill, ink foregrounds via raw FOREGROUND consts —
  theme-independent on purpose; ink CTA hovers $structure with pinned-white label+icon);
  page-global ordinals computed in HomeLayout and passed as props (hero/popular/category/
  convert; category gated on the same has-categories signal the section self-nulls on);
  sr-only h1 in carousel-only hero mode. RULINGS: EventTicker stays (accent TEXT on
  near-black chrome ≠ accent band; S6 owns the one large fill); S5 skipped — no public
  stats worth showing yet — `platform.getPublicStats` EXISTS (AboutContent uses it and
  self-hides zero stats); add home S5 on it once the counts are brag-worthy, not before
  (adoption posture); AppFooter's hardcoded "04." kicker → "—"
  (global chrome must not carry a fake page ordinal — it collided on home and OrderDetail).
  Known accepted: settings-load renumber flicker (pre-existing client-fetch class); band
  copy hardcoded English pending home.convert* keys (i18n catalogs owned by the booking
  session — add keys when they land).

## Wave-2 additions to the backlog (2026-07-14)
- **Token gaps**: `dangerSoft`/`warningSoft` theme keys (dark-legible status text — the
  `#f87171` red-400 sites in checkout/OrderSummary/PromoCodeInput deliberately kept for AA);
  `--hf-on-brand` embed contract var (dark host brandColor now gets ink-on-dark; doc caveat
  shipped in embed-widgets.md; luminance-derived var is the real fix).
- **Stale e2e specs** (pre-existing, proven not ours): my-tickets-refund.spec.ts +
  item-refund-scenarios.spec.ts locators don't match current markup/copy.
- **Button-in-anchor**: MyTickets card "View Event" `<button>` nested in the card Link
  (pre-existing, documented stopPropagation hack) — SaveHeart-style sibling overlay fix.
- **Dead code**: ResellPlaceholder.tsx orphaned (zero importers); EventContent's
  ctaLabel/ctaHref/ticketAvailability props are dead end-to-end (EventDetail still passes).
- **Cookie consent dialog** shows two competing primary-filled buttons (taste ruling).
- **@th/ui EventCard** internal buttons off-grammar (14-16px, no tracking) — Phase 2B.
- **Checkout step-CTA dialect**: frosted ghost-white "Hold tickets"/"Continue" CTAs vs
  v2 accent primary — one ruling should settle this together with the CAB dock dialect.
- **Checkout/resale h1 gaps**: no h1 until confirmation step; resale headings lack tag=.
- **Embed calendar** consumes app palette consts, not the --hf-* contract (re-derive with
  the Stub work); EmbedTicketTypeList `#d97706` → support-family token.

## Atom backlog status (2026-07-15)
- ✅ DONE (reviewed APPROVED, contrast independently re-verified): `dangerSoft`/
  `warningSoft` theme TEXT tokens (opaque, AA-legible status reds/ambers where the bright
  $danger/$warning FILLS fail as small text) added to all 3 themes + THEME_TOKEN_GROUPS +
  globals.css :root mirror; `destructiveGhost` Button variant riding $dangerSoft (transparent
  frame → soft-red fill on hover, inverted AA label). Values: dark danger #F87171 / warn
  #FBBF24; light danger #B91C1C / warn #B45309 (red-700 not red-600 — clears AA on
  surfaceMuted #F5F5F5, not just white); stub danger #B91C1C / warn #92400E. 300 @th/ui tests.
  REVIEW NITs (accepted/deferred, not fixed): (1) the "Soft" suffix is overloaded — every
  other *Soft token is a low-alpha FILL, these are opaque TEXT; kept the backlog's name,
  comments disambiguate (rename candidate: dangerText/warningText). (2) destructiveGhost
  borderWidth 1 is a deliberate third weight (0 ghost < 1 destructiveGhost < 2 outline).
  (3) shared.ts `warningTextAccent` #B8860B pre-dates and overlaps `warningSoft` — one
  future consolidation to a single "legible warning text" source.
- ✅ SegmentedControl molecule DONE 2026-07-15 (reviewed APPROVED, findings applied). New
  `@th/ui` `SegmentedControl` (v2 `.chip.on` selected grammar: `$accentSoft` wash +
  `$accent` border + ink label — NOT a primary-orange fill; generalizes ViewToggle to N
  text options; radiogroup + roving-tabindex + arrow/Enter/Space keyboard + `disabled`).
  Rewired the two Button-`primary`-fill segmented hacks: SavedEvents ScopeTabs
  (Upcoming/Past) + CreatePlaceForm owner-kind (Human/Org). 308 @th/ui tests (8 new).
  FOLLOW-UP: ViewToggle has the same keyboard gap (focusable, not operable) — fix when
  next touched. NOTE: couldn't screenshot the live consumers — `/saved` currently crashes
  on `FOREGROUND is not defined` in ActionBarCTA.tsx:175 (concurrent session's global-chrome
  WIP, breaks every route) and `/places/new` 404s; component verified via tests + ViewToggle
  parity + review.
- ✅ Switch molecule ruling DONE 2026-07-15. RULING: the Switch stays **square**
  (radius 0) — the v2 doc locks radius at 0 "no exceptions", and a rounded switch would
  be the single rounded element in the whole system; the square track + sliding knob +
  orange-when-on already reads clearly as a toggle. The existing `@th/ui` `Switch`
  (forms/Switch.tsx — role=switch, Space key, focus ring, reduced-motion, sizes, label,
  disabled/saving) is the sanctioned affordance, already used on 10+ surfaces. Fixed the
  one ad-hoc violation: ApplicationFormBuilder hand-rolled a ROUNDED (borderRadius 9999)
  toggle inline → replaced with `<Switch size="small">`. (Reversible taste call — if
  rounded switches are wanted, change the component once, not per-site.)
- ✅ isFree flag FULLY DONE 2026-07-15 — free events render the amber support badge,
  fully structured (no string-matching). `isFree` on the @th/types `EventSummaryDto` schema
  + the @th/ui `EventSummary` type; EventCard price badge `free` variant (amber `$support`
  fill + ink `$onSupport`, per the doc `.priceblock.free`); EventCard reads
  `event.isFree === true` (transitional "Free"-label bridge REMOVED); the transport
  `event-summary-mapper` now sets `isFree` in `discoveredEventToDto` (paidTierCount===0 &&
  hasFreeTier) and `localEventToDto` (RSVP or free-only pricing) via an `isPricingFree`
  helper. NOTE: the mapper edit landed on top of the concurrent session's in-flight
  `formatPriceLabel`/buyer-total working set (their WIP was folded into this commit, not
  lost). Verified: paid badges unchanged (#B93312, not amber); eslint clean.
- ⬜ TODO — remaining atom backlog (each its own build→review→commit cycle):
  - **Chip/segmented-control molecule** (selected-state chips render as primary fills today:
    resale section filter, CreatePlaceForm owner-kind toggle, SavedEvents ScopeTabs,
    CategoryBrowseSection uses Chip tone=info filled) + **Switch molecule** ruling (toggle
    pills survive the pill retirement only as a standard control affordance — don't square
    ad hoc).
  - ✅ **--hf-on-brand embed contract var** DONE 2026-07-15. `useEmbedThemeOverrides` now
    derives `--hf-on-brand` from the host `brandColor`'s WCAG luminance (ink vs white,
    whichever has more contrast) and sets it alongside `--hf-brand`; `embed-theme.ts`
    `TEXT_ON_BRAND` reads `var(--hf-on-brand, #181818)` (default orange still ink). A dark
    host brandColor now renders a WHITE label instead of the invisible fixed ink. tsc +
    eslint clean (raw hex avoided via `toHex`).

## Wave-3 additions to the backlog (2026-07-14)
- **Atom gaps**: ✅ `destructiveGhost` DONE (see Atom backlog status above);
  Switch molecule ruling (toggle-switch pill tracks survive the pill retirement only as a
  standard control affordance — don't square ad hoc) — still TODO.
- **Editor/rendered drift**: prose-editor ImageBlock serializer still emits
  `border-radius: 8px` in renderHTML while the editor node view is square (serializer
  change touches render-html-hardening tests + public pages — deliberate hold).
- **webhook-dlq**: clickable `<Text onPress>` Stripe links aren't keyboard-focusable.
- **Account**: MenuItem rows are pointer-only interactive divs (focus parity/link
  semantics); /account/credits missing from AccountShell tabs (h1 reads "Overview").
- **EventCard**: dense variant silently ignores claimedPercent (doc it or support it);
  badge-theme.ts getBadgeStyle now dead code; structured isFree flag on EventSummary so
  the price badge can use the support variant without string-matching.
- **PlatformFeesView**: `$colorMuted` used as a band fill (wants a surface token).
- **Chart palette tokens**: FeeProjectionChart D3 indigo/amber off-palette.

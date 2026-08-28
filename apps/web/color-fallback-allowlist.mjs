/**
 * COLOUR-FALLBACK RATCHET — the shrink-only allowlist for `scripts/lint-color-fallbacks.mjs`.
 *
 * ## What the gate does
 *
 * `docs/design/design-system-v2.md` says colours come from semantic tokens, and the fallback in a
 * `var(--token, #hex)` MUST be the **Stub** value (it is what SSR paints before the injector
 * hydrates). Two whole classes of pre-v2 drift slip every *other* gate — they are not a bare hex
 * (eslint) and not `rgba(255,255,255,…)` (the white gate):
 *
 *   A. `var(--token, wrongFallback)` where the fallback drifted from the Stub value.
 *   B. Pre-v2 brand values written as `rgba()` channels or JS `??`/inline literals
 *      (`rgba(255,87,33,.1)`, `theme.accent?.val ?? "#FF5721"`).
 *
 * `lint-color-fallbacks.mjs` closes both. This file is the escape hatch for the fallbacks that are
 * *deliberately* not the Stub value — inverted surfaces, fixed-dark chrome, dropdowns whose
 * fallback never SSR-paints, forced-light scopes.
 *
 * ## The contract — identical to `eslint-hex-allowlist.mjs`
 *
 * - **Only ever REMOVE entries.** Never add one to dodge a real fix. When you correct a fallback,
 *   delete its entry. The gate prints the count on every run and it must only shrink.
 * - **Every entry needs a written `reason`.** "It was already like that" is not a reason.
 * - Entries are matched by **(file, token, value)**, NOT by line number — so they survive edits
 *   above them and can't silently drift onto a different declaration. `token` is the CSS-var name
 *   without `--` for a fallback-drift (Check A) exemption, or the literal string `"denylist"` for a
 *   pre-v2-value (Check B) exemption. `value` is matched colour-equal (hex/rgba normalised), so you
 *   may write it in whatever form reads clearly.
 * - `file` is the path relative to `apps/web/` (e.g. `src/components/…`). Exact string match — no
 *   globs, so the `[slug]` glob-metacharacter trap that once no-op'd the eslint allowlist cannot
 *   bite here.
 *
 * ## Why these are correct (the classes, per the handoff §5)
 *
 * - **Inverted tooltips / dropdowns** — `background: var(--foreground, #…)` + `color:
 *   var(--background, #…)`. The pair is an *inversion*, so the fallbacks are each other's opposite,
 *   not simple drift. Most are `display:none` until hover/open (post-hydration), so the fallback is
 *   never SSR-painted anyway.
 * - **Fixed-dark surfaces** — a photo scrim / LED band / camera feed that is dark in EVERY theme;
 *   a light-ink fallback on it is correct (`ON_STRUCTURE`-shaped).
 * - **Forced-light / scoped vars** — embeds and entity `--th-*` set these vars to their own scope's
 *   values; those are already excluded by scope, but a stray one lands here with a reason.
 */
export const colorFallbackAllowlist = [
  // ── PERMANENT — correct as-is; these will not leave the list ──────────────────
  //
  // MapLibre GL paint / loading-skeleton chrome — canvas-adjacent, no CSS cascade, and tinted to
  // the (dark) basemap by design. `token: "denylist"` because the pre-v2 steel-blue/orange is the
  // literal, canonicalised to its hex.
  {
    file: "src/app/_components/home/HeroEventMap.tsx",
    token: "denylist",
    value: "#35589A",
    reason: "PERMANENT: map loading-skeleton shimmer gradient (rgba(53,88,154,.12)), tinted to the dark basemap; not app chrome.",
  },
  {
    file: "src/app/_components/home/HeroEventMap.tsx",
    token: "denylist",
    value: "#FF5721",
    reason: "DEBT: MapLibre paint/chrome literal — should track $accent (#E2481D). Deferred: HeroEventMap is under concurrent edit (handoff §6); revisit with its owner.",
  },
  {
    file: "src/app/search/_components/EventResultsMap.tsx",
    token: "denylist",
    value: "#35589A",
    reason: "PERMANENT: map loading-skeleton shimmer, dark-basemap-tinted. (File is the untracked sibling of the entangled UniversalSearchPage — handoff item 6.)",
  },
  // Decorative data palettes — colour arrays, not chrome (parity with eslint-hex-allowlist.mjs).
  {
    file: "src/app/_components/place-review/_primitives/SuccessScreen.tsx",
    token: "denylist",
    value: "#35589A",
    reason: "PERMANENT: decorative confetti data palette [ACCENT, steel-blue, FG, …] — aria-hidden ornament, not a themed surface.",
  },
  {
    file: "src/app/search/_components/UniversalSearchPage.tsx",
    token: "denylist",
    value: "#35589A",
    reason: "PERMANENT: deterministic avatar-initials data palette (already a PERMANENT in eslint-hex-allowlist.mjs).",
  },
  // Embed forced-light block that lives in globals.css (so it's outside the src/app/embed/** scope
  // exclusion). The embed renders in a third-party iframe with its own light palette.
  {
    file: "src/app/globals.css",
    token: "denylist",
    value: "#181818",
    reason: "PERMANENT: forced-light embed `option` text (body.th-embed-body) — matches the embed palette, not Stub.",
  },
  {
    file: "src/app/globals.css",
    token: "denylist",
    value: "#707070",
    reason: "PERMANENT: forced-light embed input placeholder (body.th-embed-body) — matches embed TEXT_MUTED, not Stub.",
  },
  // MapLibre hero-map popup / overlay — deliberately navy in BOTH themes (fixed map chrome). The
  // "does a navy popup belong on a light basemap" question is open (handoff §10) but the value is
  // intentional today, not drift.
  {
    file: "src/app/globals.css",
    token: "denylist",
    value: "#35589A",
    reason: "PERMANENT: .hero-map-popup / .hero-map-location-overlay fixed-navy MapLibre chrome (navy in both themes — handoff §10).",
  },

  // ── DEBT — known-wrong, deferred; only ever shrink ───────────────────────────
  //
  // Admin loading skeleton, an Ember-navy leftover. Low-visibility (a skeleton) and it lives in
  // globals.css, which is under concurrent edit (handoff §6) — defer the edit to avoid a collision.
  {
    file: "src/app/globals.css",
    token: "surfaceMuted",
    value: "#1E2E52",
    reason: "DEBT: .th-skeleton-bar admin Ember-navy leftover; low-visibility. Deferred — globals.css under concurrent edit (handoff §6).",
  },
  {
    file: "src/app/globals.css",
    token: "borderColorSoft",
    value: "#2A3E66",
    reason: "DEBT: .th-skeleton-bar admin Ember-navy leftover (paired with the surfaceMuted above). Deferred — globals.css concurrent edit.",
  },
  // Approved AA edits are staged in this file already but it is entangled with the untracked
  // EventResultsMap.tsx from another session — land both together (handoff item 6).
  {
    file: "src/app/search/_components/UniversalSearchPage.tsx",
    token: "background",
    value: "#FDFAF3",
    reason: "DEBT: `var(--background, #FDFAF3)` should be #F6F0E4. Deferred — this file is entangled with the untracked EventResultsMap.tsx; land via handoff item 6.",
  },
];

/**
 * RAW-WHITE RULE — the SHORT list of files allowed to keep a literal
 * `rgba(255,255,255,α)`.
 *
 * ## This is NOT a debt allowlist
 *
 * Unlike `eslint-hex-allowlist.mjs` (a shrinking ratchet of grandfathered debt), this list was
 * NOT grandfathered. Every `rgba(255,255,255,…)` in `apps/web` was migrated off the retired dark
 * theme first (53 files → this handful), and only then was the rule switched on. These entries
 * are the ones where a literal white is *correct*, not owed.
 *
 * ## Why each one is legitimate
 *
 * A white literal is correct ONLY when it paints onto a surface that is dark in EVERY theme, or
 * onto a surface the app's theme cannot reach at all:
 *
 *   - `home/HeroEventMap.tsx`, `search/_components/SearchResultsMap.tsx` — MapLibre GL **paint
 *     expressions** cannot take a CSS `var()`; they need a literal color. All whites are inside the
 *     `isDark` (Ember) branch; the Stub branch is ink/accent/paper. (HeroEventMap also has a
 *     dev-only debug banner on its own opaque black box.)
 *   - `maps/CoordinatesSelectorMap.tsx` — badges sit on a fixed `rgba(15,23,42,0.75)` overlay in
 *     both themes; ink would vanish.
 *   - `entity-pages/EditableBlock.tsx` — its edit toolbar is a fixed `rgba(15,27,51,0.85)` navy in
 *     every theme. NOTE: unlike the CAB dock (which tracks a themed `backgroundStrong` and so can
 *     derive its foreground from `onStructure`), this bar is a hardcoded navy — a themed
 *     foreground could drift off it. Do not "fix" these.
 *   - `prose-editor/extensions/ImageBlockNodeView.tsx` — same shape: its `ControlsOverlay` is a
 *     fixed `rgba(0,0,0,0.6)` black bar floating over arbitrary user imagery in every theme, so
 *     the button hover/active fills and the divider are correct as light-on-black.
 *   - `embeds/EmbedCodeBlock.tsx` — a deliberate always-dark code-editor surface.
 *   - `admin/[slug]/scan/page.tsx` — the scan frame overlays a live camera feed (arbitrary
 *     content); white is the visibility affordance.
 *   - `places/[placeId]/layout/.../PlaceLayoutCanvas.tsx`, `designer/draw.ts` — `<canvas>` 2D
 *     context (`fillStyle`/`strokeStyle`) cannot take a CSS variable.
 *   - `platform/theme-editor/ThemeEditor.tsx` — a theme editor must show/edit literal colors.
 *   - `global-error.tsx` — renders when the app has crashed (no Tamagui, no injector, possibly no
 *     stylesheet), so it is intentionally self-contained. Its white sits on the `#B93312` CTA fill
 *     (~5.9:1), which is correct.
 *   - **QR quiet zones** — `my-tickets/[orderId]/OrderDetail.tsx`, `qr-test/page.tsx`,
 *     `scanner-setup/scanner-setup-shared.ts`, `account/settings/TwoFactorSection.tsx`,
 *     `auth/Setup2faCard.tsx`, `embed/[embedId]/EmbedTickets.tsx`: a QR code needs a true-white quiet zone to be scannable. Theming
 *     these to cream would degrade scan reliability on real hardware. Never tokenize them.
 *
 * ## The contract
 *
 * Adding an entry here requires a stated reason above — "it's easier" is not one. If the surface
 * is light, or is themed at all, the answer is a token (`$color`, `$colorMuted`), or
 * `var(--token, #stubHex)`, or `hexToRgba(onStructure, α)` for light-on-dark chrome.
 */
export const whitePermanents = [
  "src/app/_components/home/HeroEventMap.tsx",
  "src/app/search/_components/SearchResultsMap.tsx",
  "src/components/maps/CoordinatesSelectorMap.tsx",
  "src/components/entity-pages/EditableBlock.tsx",
  "src/app/admin/[slug]/events/new/_components/prose-editor/extensions/ImageBlockNodeView.tsx",
  "src/components/embeds/EmbedCodeBlock.tsx",
  "src/app/admin/[slug]/scan/page.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/PlaceLayoutCanvas.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/draw.ts",
  "src/app/platform/theme-editor/_components/ThemeEditor.tsx",
  "src/app/global-error.tsx",
  // QR quiet zones — must be true white to scan (see rationale above).
  "src/app/my-tickets/[orderId]/_components/OrderDetail.tsx",
  "src/app/qr-test/page.tsx",
  "src/app/admin/[slug]/scanner-setup/_components/scanner-setup-shared.ts",
  "src/app/account/settings/_components/TwoFactorSection.tsx",
  "src/components/auth/Setup2faCard.tsx",
  // The embed confirmation's ticket QR: scanned at the door from a partner's
  // page, so its quiet zone must not follow the host theme either.
  "src/app/embed/[embedId]/_components/EmbedTickets.tsx",
];

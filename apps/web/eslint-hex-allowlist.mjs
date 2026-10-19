/**
 * RAW-HEX RATCHET — allowlist of files exempt from the `no bare hex color` lint rule.
 *
 * ## The rule
 *
 * Design System v2 (`docs/design/design-system-v2.md`) states: **no raw hex in components.**
 * Colors come from semantic tokens. The lint rule in `eslint.config.mjs` bans a BARE hex
 * string literal (`"#FF5721"`, `'#fff'`).
 *
 * It deliberately does NOT ban hex inside a `var()` fallback — `var(--accent, #E2481D)` is the
 * SANCTIONED pattern for raw-CSS/inline-style contexts, because the fallback is what SSR paints
 * before the theme injector hydrates. Keep writing those.
 *
 * ## Why a ratchet
 *
 * This list is the debt that existed when the rule was introduced (2026-07-16), after the
 * Ember→Stub light-theme migration. It exists so the rule can be an ERROR — meaning **new code
 * can never add a bare hex** — without red-CI'ing on pre-existing debt.
 *
 * ## The contract
 *
 * - **Only ever REMOVE entries from this list.** Never add one. If you need a color, use a
 *   semantic token (or `var(--token, #stubHex)` in a raw-CSS context).
 * - When you migrate a file off raw hex, delete its line here. The list should only shrink.
 * - If you genuinely need a real hex (see PERMANENT below), say why in the PR.
 *
 * ## PERMANENT (cannot use `var()` — a CSS variable is invalid in these contexts)
 *
 * These will never leave the list; they are not debt:
 *   - `designer/draw.ts`, `PlaceLayoutCanvas.tsx` — `<canvas>` 2D context (fillStyle/strokeStyle)
 *   - `_components/home/HeroEventMap.tsx`, `search/_components/SearchResultsMap.tsx` —
 *     MapLibre GL paint expressions
 *   - `auth/oauth-logos.tsx` — the Google mark's four brand colors are fixed by that
 *     vendor's brand guidelines. Note this covers the MARKS only: the provider buttons
 *     no longer paint vendor fills (they are `variant="secondary"` ink outlines), so
 *     `OAuthProviderButtons.tsx` left this list in the 2026-09 auth redesign
 *   - `SuccessScreen.tsx` (confetti), `UniversalSearchPage.tsx` (avatar palette),
 *     `FeeProjectionChart.tsx`, `SplitsEditor.tsx` (per-payee identity palette —
 *     links a payee's slider fill to its bar segment + legend dot) —
 *     deterministic DATA color palettes, not chrome
 *   - `tickets/qr/[code]/route.ts`, `tickets/qr/[code]/render-png.ts` — QR generation
 *     needs literal colors. These are raster encoders (SVG string / PNG buffer), not
 *     components: there is no stylesheet in scope for a `var()` to resolve against.
 *     The modules must also stay true #000/#fff — QR decode depends on maximum
 *     module contrast, so they are not a theming decision to begin with.
 *   - `layout.tsx` — `<meta theme-color>` cannot take a CSS var
 *   - `lib/design-tokens.ts` — the palette re-export layer itself
 *
 * Everything else is DEBT. Highest-value to pay down next: the admin surfaces
 * (`theme-editor`, `SeatingLayoutEditor`, the place-layout `designer/`) — see the
 * deferred backlog in `docs/design/design-system-v2.md`.
 */
export const hexAllowlist = [
  "src/app/_components/attendee-review/_primitives/RatingScale.tsx",
  "src/app/_components/home/FeaturedHeroCarousel.tsx",
  "src/app/_components/home/HeroEventMap.tsx",
  "src/app/_components/home/HomeHero.tsx",
  "src/app/_components/NavigationProgressProvider.tsx",
  "src/app/_components/place-review/_primitives/CountryCombobox.tsx",
  "src/app/_components/place-review/_primitives/PlaceAutocomplete.tsx",
  "src/app/_components/place-review/_primitives/SuccessScreen.tsx",
  "src/app/_components/place-review/_screens/connect.tsx",
  "src/app/_components/place-review/_screens/core.tsx",
  "src/app/account/settings/_components/PasskeysSection.tsx",
  "src/app/admin/[slug]/embeds/_components/EmbedsView.tsx",
  "src/app/admin/[slug]/events/new/_components/prose-editor/extensions/ImageBlockNodeView.tsx",
  "src/app/admin/[slug]/events/new/_components/SeatingLayoutEditor.tsx",
  "src/app/admin/[slug]/events/new/_components/SplitsEditor.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/csv-bridge.ts",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/DesignerToolbar.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/draw.ts",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/PlaceLayoutDesigner.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/designer/reducer.ts",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/PlaceLayoutCanvas.tsx",
  "src/app/admin/[slug]/places/[placeId]/layout/_components/PlaceLayoutEditor.tsx",
  "src/app/contact/_components/ContactContent.tsx",
  "src/app/events/[...slug]/_components/SeriesTicketDatePicker.tsx",
  "src/app/events/checkout/[...slug]/_components/CheckoutHoldWarningDialog.tsx",
  "src/app/events/checkout/[...slug]/_components/SeatMapPicker.tsx",
  "src/app/global-error.tsx",
  "src/app/layout.tsx",
  "src/app/moderate/images/_components/ImageModerationQueueView.tsx",
  "src/app/platform/fees/_components/FeeProjectionChart.tsx",
  "src/app/platform/theme-editor/_components/ThemeEditor.tsx",
  "src/app/reset-password/page.tsx",
  // MapLibre GL paint expressions need literal colors (see PERMANENT above).
  "src/app/search/_components/SearchResultsMap.tsx",
  "src/app/search/_components/UniversalSearchPage.tsx",
  "src/app/tickets/qr/[code]/render-png.ts",
  "src/app/tickets/qr/[code]/route.ts",
  "src/app/unsubscribe/_components/UnsubscribeClient.tsx",
  "src/components/audio/useHydrateAudioBlocks.tsx",
  "src/components/auth/oauth-logos.tsx",
  "src/components/community/RsvpButton.tsx",
  "src/components/embeds/EmbedCodeBlock.tsx",
  "src/components/entity-pages/EditableBlock.tsx",
  "src/components/entity-pages/PageEditorView.tsx",
  "src/components/entity-pages/PageThemeEditor.tsx",
  "src/components/errors/QueryStatusView.tsx",
  "src/components/events/EventContent.tsx",
  "src/components/events/TravelTimeWidget.tsx",
  "src/components/events/WaitlistJoinForm.tsx",
  "src/components/icons/BrandIcons.tsx",
  "src/components/layout/PagePrimitives/forms.tsx",
  "src/components/maps/CoordinatesSelectorMap.tsx",
  "src/components/maps/LocationMapPreview.tsx",
  "src/components/search/SpotlightSearch.tsx",
  "src/components/support/SupportThreadView.tsx",
  "src/components/support/SupportWidget.tsx",
  "src/lib/design-tokens.ts",
  // Stripe Elements `appearance.variables`/`rules` is a plain JS object handed
  // to a third-party iframe — cannot take `var()`, same as canvas/MapLibre
  // above. Shared by StripePaymentCard.tsx (ticket checkout) and
  // MembershipPaymentStep.tsx (membership checkout), which is why this single
  // module entry replaces what used to be a StripePaymentCard.tsx-only entry.
  "src/lib/stripe-appearance-theme.ts",
];

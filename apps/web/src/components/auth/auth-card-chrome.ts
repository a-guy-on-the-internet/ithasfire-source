/**
 * Chrome shared by every auth panel.
 *
 * One module rather than a constant per card, because the cards drifting apart
 * is the failure this exists to stop: the receding-disabled treatment below was
 * written for `LoginCard` and nowhere else, so /sign-in's disabled CTA receded
 * while /forgot-password's, /sign-up's and the 2FA cards' all rendered the
 * flame fill at 45% — a pale salmon slab with the same visual weight as a live
 * button (verified in Chrome at 1440 on /forgot-password).
 */

/**
 * How a disabled primary CTA recedes.
 *
 * The Button atom's own disabled treatment is `opacity: .45`, which paints the
 * CTA's fill at 45% over the card. A disabled control should step BACK, so it
 * takes the muted surface and a soft border, at full opacity: the recession
 * comes from the colour, not from a veil over the whole button. On the ink
 * panel that lands as an 8%-paper slab with a muted-paper label (6.56:1 —
 * legible, and unmistakably not the cream CTA it replaces). It also keeps the
 * card inside the v2 §4 accent budget, which a washed-out flame slab was still
 * spending.
 *
 * DISABLED only. A CTA that is *submitting* must never take `disabled` — that
 * would dim the very spinner that is the feedback (v2: loading is a live
 * state). Those buttons take `aria-busy` + `aria-disabled` and guard their own
 * press instead.
 */
export const RECEDING_DISABLED = {
  backgroundColor: "$surfaceMuted",
  borderColor: "$borderColorSoft",
  color: "$colorMuted",
  opacity: 1,
  cursor: "not-allowed",
} as const;

/**
 * Swiss focus ring, matching the Button atom's — in the ink panel's colour.
 *
 * `$support`, not `$accent`. Every auth card is the theme's inverted surface,
 * and amber is the ring the design system prescribes there
 * (`--focus-color-on-inverse`, globals.css) precisely because it is the one
 * hue that holds against BOTH the ink and the flame. Flame would technically
 * pass on ink (4.17:1 against the 3:1 non-text floor) and then read as the
 * step band's colour wrapped around a control.
 *
 * This is a Tamagui `focusStyle`, so it compiles to `var(--accent)`-style
 * atomic classes and does NOT pick up the `[data-auth-card]` rebind — the
 * token has to name the right value here.
 */
export const AUTH_FOCUS_RING = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$support",
  outlineOffset: 2,
} as const;

/**
 * The rule above a card's footer.
 *
 * A HAIRLINE at 40% of the panel's own foreground — paper on the ink card,
 * raised from 20%, which measured 1.87:1 there and was invisible. On cream
 * 20% was fine; ink at low alpha simply does not travel as far, which is the
 * general lesson for every rule on this surface.
 * not the 2px `$borderColor` structural line it replaces. A footer rule is a
 * whisper: it separates the card's action from the navigation under it. At 2px
 * full strength it drew as hard as the card's own outline and read as a second
 * card edge inside the card.
 *
 * `color-mix` rather than an alpha suffix on the var: concatenating one
 * produces invalid CSS (v2 §4). `--color` is the panel's foreground (the ink
 * card rebinds it to paper); the fallback is Stub's unrebound value.
 */
export const AUTH_FOOTER_RULE = {
  height: 1,
  width: "100%",
  backgroundColor: "color-mix(in srgb, var(--color, #211C16) 40%, transparent)",
} as const;

/**
 * A card footer's secondary action — "Create account", "Sign in", "Back to
 * sign in".
 *
 * A MONO TEXT LINK, not a bordered button. This is navigation away from the
 * panel, not the panel's action, and as an outlined `secondary` Button it
 * carried the same 2px frame and the same uppercase 700 label as the primary
 * CTA six pixels above it — two controls of equal weight, one of which is a
 * way OUT of the flow the reader just started.
 *
 * `tag: "button"`, not `role="button"` on a div: Tamagui's `onPress` maps to a
 * click handler, and a div fires click only from a pointer — so role+tabIndex
 * announces as a button, takes focus, and then does nothing on Enter or Space.
 *
 * `minHeight: 44` with vertical padding, never a smaller box: the label
 * shrinks, the target does not.
 */
export const AUTH_FOOTER_LINK = {
  tag: "button",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  paddingVertical: "$2",
  paddingHorizontal: "$2",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: { opacity: 0.75 },
  focusStyle: AUTH_FOCUS_RING,
  // The `secondary` Button this replaces dimmed itself while the card was
  // busy. A bare `<button disabled>` does not, so without this the link would
  // look live and silently ignore the click.
  disabledStyle: { opacity: 0.45, cursor: "not-allowed" },
} as const;

/**
 * The label inside `AUTH_FOOTER_LINK`. Mono, accent-as-text, underlined.
 *
 * `$accentText` stays — the token names the ROLE ("the accent, at label
 * legibility on whatever this is printed on") and the surface binds the value.
 * On the ink panel `[data-auth-card]` points it at amber (7.87:1); flame-800
 * #A8300F, which is right on cream, measures 2.49:1 there.
 */
export const AUTH_FOOTER_LINK_TEXT = {
  variant: "overline",
  color: "$accentText",
  textDecorationLine: "underline",
  style: { textUnderlineOffset: 3 },
} as const;

/**
 * The same touch target as `AUTH_FOOTER_LINK`, as raw CSS.
 *
 * For `NextLinkAnchor`, which forwards only `style` and a DOM-safe allowlist
 * to the `next/link` `<a>` — every Tamagui style prop on it is silently
 * dropped, so a 44px target set as props would not exist.
 */
export const AUTH_FOOTER_LINK_BOX = {
  minHeight: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "8px",
} as const;

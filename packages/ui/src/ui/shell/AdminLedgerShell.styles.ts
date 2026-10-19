import { Stack, XStack, YStack, styled } from "tamagui";

import { zIndexTokens } from "../tamagui/tokens/z-index";

/**
 * Styled components for AdminLedgerShell.
 *
 * `ShellFrame`, `ContentArea` and `SkipLink` are copied VERBATIM from
 * NavigationShell.styles.ts (R1/R6 in the shell map): the content area's
 * `overflow: visible` and the frame's `minHeight: 100dvh` are load-bearing
 * for every sticky descendant in admin, and the skip link's reveal mechanism
 * has a documented reason for every line. Do not "tidy" them here without
 * changing the originals too.
 */

export const ShellFrame = styled(YStack, {
  name: "AdminLedgerShellFrame",
  minHeight: "100dvh",
  backgroundColor: "$surfaceMuted",
  position: "relative",
});

export const EdgeSwipeZone = styled(Stack, {
  name: "AdminLedgerShellEdgeSwipeZone",
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 28,
  // NavigationShell.styles.ts uses the literal 60 here; no token equals it.
  // `raised` is enough — the zone only has to sit above the flow content,
  // which has no stacking context of its own.
  zIndex: zIndexTokens.raised,
});

export const ShellLayoutRow = styled(XStack, {
  name: "AdminLedgerShellRow",
  flex: 1,
  minHeight: 0,
  paddingHorizontal: "$4",
  paddingBottom: "$5",
  gap: 0,
  width: "100%",
  maxWidth: 1440,
});

export const ContentArea = styled(YStack, {
  name: "AdminLedgerShellContent",
  flex: 1,
  backgroundColor: "$surface",
  paddingVertical: "$5",
  paddingHorizontal: "$5",
  gap: "$4",
  minHeight: 0,
  // MUST stay `visible`. Any non-visible overflow value makes this the
  // nearest scroll container for every descendant, which captures
  // `position: sticky` (per spec, even when it never actually scrolls).
  // ShellFrame is `minHeight: 100dvh`, so this box grows with its content
  // and the DOCUMENT is the real scrollport — sticky descendants (builder
  // header/readiness rail, settings navs, table headers) depend on that.
  // The former `overflow: "auto"` never scrolled anything (scrollHeight
  // always equalled clientHeight) but silently broke all of them.
  overflow: "visible",
  borderRadius: 0,
  marginTop: "$3",
  // Swiss structural rule: top-edge line separating content from nav
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  // Swiss structural rule: left-edge line separating content from rail
  borderLeftWidth: 2,
  borderLeftColor: "$borderColor",
});

/**
 * The three registers stack here. NOT sticky (R2): `BuilderHeaderBar` is
 * sticky at top:0 and `EventBuilder` measures its own bar height into the
 * rail's offsets — a sticky register stack would mis-offset all of them.
 */
export const RegisterStack = styled(YStack, {
  name: "AdminLedgerShellRegisters",
  width: "100%",
  // No zIndex: a non-sticky flow stack needs no stacking context, and one
  // here would trap the switcher/notification popovers under later content.
});

export const SkipLink = styled(Stack, {
  name: "AdminLedgerShellSkipLink",
  position: "absolute",
  left: "$4",
  // Hidden state parks the link above the viewport. Hiding must remove it
  // from the hit area (not just opacity) — it otherwise sits over the
  // mobile hamburger and swallows its taps, including the synthesized
  // taps touch screen readers activate with. `top` (not a translate):
  // Tamagui emits transforms as inline style, which a :focus-visible
  // class rule can never override, so a transform-based reveal never runs.
  top: -100,
  // NavigationShell.styles.ts uses the literal 200; no token equals it. The
  // revealed link must clear the sticky page chrome (builder header, table
  // heads) — `banner` is the layer for page-level announcements above them.
  zIndex: zIndexTokens.banner,
  paddingHorizontal: "$4",
  paddingVertical: "$2",
  backgroundColor: "$surfaceStrong",
  borderRadius: 0,
  shadowColor: "rgba(0,0,0,0.2)",
  shadowOpacity: 0.3,
  shadowRadius: 12,
  opacity: 0,
  pointerEvents: "none",
  focusVisibleStyle: {
    opacity: 1,
    pointerEvents: "auto",
    top: "$2",
  },
});

export const RailSkeletonFrame = styled(YStack, {
  name: "AdminLedgerShellRailSkeleton",
  width: 256,
  backgroundColor: "$surfaceRaised",
  flexShrink: 0,
  borderRadius: 0,
  marginTop: "$3",
  padding: "$3",
  gap: "$2",
});

export const SkeletonBlock = styled(Stack, {
  name: "AdminLedgerShellSkeletonBlock",
  height: 32,
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

export const CompactRailSkeletonFrame = styled(RailSkeletonFrame, {
  name: "AdminLedgerShellCompactRailSkeleton",
  width: 72,
  paddingHorizontal: "$2",
});

/**
 * Bounds the WorkspaceSwitcher inside the topbar's right cluster. The
 * switcher's mobile mode declares `width: 100%` on its anchor; without a
 * shrinkable box around it the topbar row (and the fixed bottom bar, which
 * sizes to the document) overflows a 320px viewport by 44px.
 *
 * MUST NOT clip. This box carried `overflow: hidden` and ate the switcher's
 * popover alive: the menu is `position: absolute` inside the anchor, and an
 * absolutely-positioned descendant is still clipped by an ancestor's
 * `overflow: hidden`, so the 48px-tall clamp cropped the whole dropdown to a
 * 48px band. Worse, an `overflow: hidden` box is still a SCROLL container, so
 * the open-focus `scrollIntoView({block: "nearest"})` scrolled the clamp to
 * the focused row — shipping the exact defect reported on production: a
 * sliver of one row, focus ring and check icon included, hanging inside the
 * top bar. Measured in Chrome at 1440 and 320: clamp box 48px tall,
 * `scrollHeight` 504, `scrollTop` 190.
 *
 * The horizontal bound does NOT depend on the clip: it is `minWidth: 0` +
 * `flexShrink: 1` here, matched by the same pair on `WorkspaceSwitcherAnchor`
 * so the anchor shrinks WITH this box instead of pinning itself to its
 * content. Measured after removing the clip: anchor 238px at a 320 viewport,
 * document `scrollWidth` unchanged.
 */
export const SwitcherClamp = styled(XStack, {
  name: "AdminLedgerShellSwitcherClamp",
  alignItems: "center",
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 1,
  overflow: "visible",
});

/** Back affordance in the topbar's `left` slot — mirrors the rail's BackRow. */
export const TopbarBack = styled(XStack, {
  name: "AdminLedgerShellTopbarBack",
  alignItems: "center",
  gap: "$2",
  minHeight: 44,
  paddingHorizontal: "$2",
  borderRadius: 0,
  cursor: "pointer",
  backgroundColor: "transparent",
  hoverStyle: {
    backgroundColor: "$surfaceRaised",
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$outlineColor",
    outlineOffset: -2,
  },
});

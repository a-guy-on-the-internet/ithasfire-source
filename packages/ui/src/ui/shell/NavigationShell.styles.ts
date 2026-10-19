import { Stack, XStack, YStack, styled } from "tamagui";

/**
 * Styled components for NavigationShell.
 * Extracted for maintainability and to keep the main component focused on logic.
 */

export const ShellFrame = styled(YStack, {
  name: "NavigationShellFrame",
  minHeight: "100dvh",
  backgroundColor: "$surfaceMuted",
  position: "relative",
});

export const EdgeSwipeZone = styled(Stack, {
  name: "NavigationShellEdgeSwipeZone",
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 28,
  zIndex: 60,
});

export const ShellLayoutRow = styled(XStack, {
  name: "NavigationShellRow",
  flex: 1,
  minHeight: 0,
  paddingHorizontal: "$4",
  paddingBottom: "$5",
  gap: 0,
  width: "100%",
  maxWidth: 1440,
});

export const ContentArea = styled(YStack, {
  name: "NavigationShellContent",
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

export const TopBarContainer = styled(YStack, {
  name: "NavigationShellTopBarContainer",
  width: "100%",
  zIndex: 30,
  // Swiss structural rule: bottom-edge line anchoring the top bar
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
});

export const TopBarInner = styled(YStack, {
  name: "NavigationShellTopBarInner",
  width: "100%",
});

export const SkipLink = styled(Stack, {
  name: "NavigationShellSkipLink",
  position: "absolute",
  left: "$4",
  // Hidden state parks the link above the viewport. Hiding must remove it
  // from the hit area (not just opacity) — it otherwise sits over the
  // mobile hamburger and swallows its taps, including the synthesized
  // taps touch screen readers activate with. `top` (not a translate):
  // Tamagui emits transforms as inline style, which a :focus-visible
  // class rule can never override, so a transform-based reveal never runs.
  top: -100,
  zIndex: 200,
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
  name: "NavigationShellRailSkeleton",
  width: 256,
  backgroundColor: "$surfaceRaised",
  flexShrink: 0,
  borderRadius: 0,
  marginTop: "$3",
  padding: "$3",
  gap: "$2",
  variants: {
    showDivider: {
      true: {
        borderRightWidth: 0,
      },
      false: {
        borderRightWidth: 0,
      },
    },
  },
  defaultVariants: {
    showDivider: true,
  },
});

export const SkeletonBlock = styled(Stack, {
  name: "NavigationShellSkeletonBlock",
  height: 32,
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

export const CompactRailSkeletonFrame = styled(RailSkeletonFrame, {
  name: "NavigationShellCompactRailSkeleton",
  width: 72,
  paddingHorizontal: "$2",
});

"use client";

import { styled, XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

/* ─── Page container ────────────────────────────────────────────────────── */

export const PlatformContainer = styled(YStack, {
  padding: 24,
  gap: 20,
  width: "100%",
  marginHorizontal: "auto",
  maxWidth: 1400,
  // On a phone the navigation shell's own padding is the only side gutter;
  // this 24px on top of it left a 190px column at 320. Longhands, because
  // the `size` variants set `padding`, which expands to paddingLeft/Right.
  $sm: { paddingLeft: 0, paddingRight: 0 },

  variants: {
    size: {
      sm: { maxWidth: 960, padding: 32, gap: 32 },
      md: { maxWidth: 1400 },
      lg: { maxWidth: 1600 },
    },
  } as const,
});

/* ─── Filter bar ────────────────────────────────────────────────────────── */

export const PlatformFilterBar = styled(XStack, {
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  // Tamagui's web Stack default is `flex-shrink: 0` (@tamagui/web
  // webViewFlexCompatStyles). Every call site nests this bar inside a ROW,
  // so without this its main-axis size is its content width and it can never
  // be compressed — which also strands any shrinkable child (FilterChips):
  // the child gets a containing block as wide as the content, so its own
  // `flex-wrap: wrap` never has a narrower line box to break into and the
  // chips run off-screen on narrow viewports.
  flexShrink: 1,
});

/* ─── Tab bar ───────────────────────────────────────────────────────────── */

// Tabs keep one row. Give the bar `style={{ overflowX: "auto" }}` at the call
// site (Tamagui's `overflow` type has no "auto") so tabs that outrun it scroll
// inside the bar instead of pushing the page sideways (orders at 320).
export const PlatformTabBar = styled(XStack, {
  gap: 0,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  maxWidth: "100%",
});

export const PlatformTab = styled(XStack, {
  tag: "button",
  // 2px more than before on the sides and top: the <button> border those
  // edges used to carry, so the tab keeps its size and place.
  paddingHorizontal: 18,
  paddingTop: 12,
  paddingBottom: 10,
  cursor: "pointer",
  // A flat tab on the page surface: zero the <button> defaults (a 2px outset
  // border on every side and a grey #efefef fill), keep only the underline.
  backgroundColor: "transparent",
  borderTopWidth: 0,
  borderLeftWidth: 0,
  borderRightWidth: 0,
  borderBottomWidth: 2,
  borderBottomColor: "transparent",
  // Keyboard focus only: a mouse click leaves no ring.
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },

  variants: {
    active: {
      true: {
        borderBottomColor: "$accent",
      },
      false: {
        hoverStyle: {
          backgroundColor: "$surfaceMuted",
        },
      },
    },
  } as const,
});

// `onFocus` for each tab: scrolls the bar (never the page) to show the tab.
export { scrollTabIntoView } from "./scroll-tab-into-view";

/* ─── Typography ────────────────────────────────────────────────────────── */

export const PlatformPageTitle = styled(Text, {
  tag: "h1",
  fontSize: 24,
  fontWeight: "700",
  color: "$color",
});

export const PlatformSubtitle = styled(Text, {
  fontSize: 14,
  color: "$colorMuted",
});

export const PlatformSectionTitle = styled(Text, {
  tag: "h2",
  fontSize: 18,
  fontWeight: "600",
  color: "$color",
});

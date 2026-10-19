"use client";

import { memo, useCallback } from "react";
import { XStack, styled, useTheme } from "tamagui";
import { LayoutGrid, List } from "lucide-react";

import { stubTheme } from "../../tokens/colors";
import { hexToRgba } from "../shared";

// ── Types ────────────────────────────────────────────────────────────────────

export type ViewToggleMode = "grid" | "list";

export interface ViewToggleProps {
  /** Currently active view mode. */
  value: ViewToggleMode;
  /** Called when the user selects a different mode. */
  onChange: (mode: ViewToggleMode) => void;
  /** Icon stroke width. @default 2.5 */
  strokeWidth?: number;
  /** Icon size in px. @default 15 */
  iconSize?: number;
}

// ── Styled primitives ────────────────────────────────────────────────────────

const ToggleContainer = styled(XStack, {
  name: "ViewToggle",
  alignItems: "center",
  gap: 0,
});

const ToggleButton = styled(XStack, {
  name: "ViewToggleButton",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  borderWidth: 2,
  borderRadius: 0,
  cursor: "pointer",
  transition: "all 150ms ease-out",
  pressStyle: {
    scale: 0.96,
  },
  // 34px is a mouse-sized target. On phones — where this toggle wraps onto its
  // own header line and is the only control there — it needs a thumb-sized one.
  // Media STYLE props (compiled to CSS) rather than `useMedia()`: a JS-resolved
  // breakpoint renders 34 on the server and 44 on the client, which is a
  // hydration mismatch on every home page load.
  $sm: {
    width: 44,
    height: 44,
  },
});

// The lucide glyph's `size` is a JS prop, so it can't take a media query without
// the same SSR/client split. Scale the wrapper instead — pure transform, no
// hydration risk — so a 15px icon reads at ~18px inside the 44px target.
const ToggleIconWrapper = styled(XStack, {
  name: "ViewToggleIconWrapper",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  $sm: {
    scale: 1.2,
  },
});

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Grid / list toggle button pair.
 *
 * Swiss-style: rectangular, no rounded corners, immediate color-snap on press.
 * Active state uses brand orange accent; inactive is a low-opacity border.
 *
 * Lives in `@th/ui` so it can be reused across any surface that shows an
 * `EventGrid` — home sections, category browse, search results, etc.
 */
export const ViewToggle = memo(function ViewToggle({
  value,
  onChange,
  strokeWidth = 2.5,
  iconSize = 15,
}: ViewToggleProps) {
  const theme = useTheme();

  const handleGrid = useCallback(() => onChange("grid"), [onChange]);
  const handleList = useCallback(() => onChange("list"), [onChange]);

  const gridActive = value === "grid";
  const listActive = value === "list";

  // Resolve theme-aware colors (Stub values as the fallback — Stub ships).
  // `accent` must stay a real hex: hexToRgba parses it for the active wash.
  const accent = theme.brandSecondary?.val ?? stubTheme.brandSecondary;
  const inactiveBorder = theme.borderColor?.val ?? stubTheme.borderColor;
  const inactiveIcon = theme.colorMuted?.val ?? stubTheme.colorMuted;

  return (
    <ToggleContainer>
      <ToggleButton
        role="radio"
        aria-label="Grid view"
        aria-checked={gridActive}
        onPress={handleGrid}
        backgroundColor={gridActive ? hexToRgba(accent, 0.12) : "transparent"}
        borderColor={gridActive ? accent : inactiveBorder}
        borderRightWidth={0}
      >
        <ToggleIconWrapper>
          <LayoutGrid
            size={iconSize}
            color={gridActive ? accent : inactiveIcon}
            strokeWidth={strokeWidth}
          />
        </ToggleIconWrapper>
      </ToggleButton>

      <ToggleButton
        role="radio"
        aria-label="List view"
        aria-checked={listActive}
        onPress={handleList}
        backgroundColor={listActive ? hexToRgba(accent, 0.12) : "transparent"}
        borderColor={listActive ? accent : inactiveBorder}
      >
        <ToggleIconWrapper>
          <List
            size={iconSize}
            color={listActive ? accent : inactiveIcon}
            strokeWidth={strokeWidth}
          />
        </ToggleIconWrapper>
      </ToggleButton>
    </ToggleContainer>
  );
});

ViewToggle.displayName = "ViewToggle";

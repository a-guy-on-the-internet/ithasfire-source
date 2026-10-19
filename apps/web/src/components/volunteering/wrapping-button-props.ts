import type { CSSProperties } from "react";

/**
 * Lets a DS Button with an icon + label grow taller and wrap its label
 * instead of running past its card at 320px (long labels, Spanish). Spread
 * on the Button (it overrides the size variant's fixed height), the inner
 * row, the label Text and the icon.
 * Props, not `styled(Button)`: styling the DS Button breaks string children.
 */
export const WRAPPING_BUTTON_PROPS = {
  height: "auto",
  minHeight: 44,
  paddingVertical: "$2",
  flexShrink: 1,
  minWidth: 0,
} as const;

export const WRAPPING_BUTTON_ROW_PROPS = {
  flexShrink: 1,
  minWidth: 0,
} as const;

/** Left-aligned: a wrapped line centred in the Button drifts off its icon. */
export const WRAPPING_BUTTON_LABEL_PROPS = {
  flexShrink: 1,
  textAlign: "left",
} as const;

/** Keeps the lucide icon at its size while the label wraps beside it. */
export const WRAPPING_BUTTON_ICON_STYLE: CSSProperties = { flexShrink: 0 };

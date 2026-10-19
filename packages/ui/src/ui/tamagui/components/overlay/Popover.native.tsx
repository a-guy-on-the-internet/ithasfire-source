/**
 * Native stub for overlay/Popover.
 *
 * The web Popover uses @floating-ui/react which depends on react-dom,
 * making it incompatible with React Native. On native surfaces we don't
 * render popovers inline; instead, native navigation patterns (modals,
 * action sheets, bottom sheets) should be used.
 *
 * This stub renders nothing - the overlay system should use native patterns.
 */
import type { ReactNode } from "react";
import type { StackProps } from "tamagui";
import type { Placement } from "@floating-ui/core";

export type PopoverTone = "surface";

export type PopoverProps = {
  children?: ReactNode;
  anchor?: ReactNode;
  /** Web-only: position against an already-mounted node instead of `anchor`. */
  anchorElement?: Element | null;
  open?: boolean;
  placement?: Placement;
  tone?: PopoverTone;
  offset?: number;
  matchAnchorWidth?: boolean;
  contentProps?: Partial<StackProps>;
};

/**
 * No-op Popover for native – renders nothing.
 * Use native navigation patterns (modals, sheets) instead.
 */
export const Popover = (_props: PopoverProps): null => {
  return null;
};

Popover.displayName = "Popover";

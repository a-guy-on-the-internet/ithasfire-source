/**
 * Native stub for Popover.
 *
 * The web Popover uses @floating-ui/react which depends on react-dom,
 * making it incompatible with React Native. On native surfaces we don't
 * render popovers inline; instead, native navigation patterns (modals,
 * action sheets, bottom sheets) should be used.
 *
 * This stub renders children directly without any positioning wrapper
 * so that the component tree remains valid.
 */
import type { ReactNode } from "react";

export interface PopoverProps {
  children?: ReactNode;
  anchor?: ReactNode;
  open?: boolean;
  placement?: string;
  tone?: string;
  offset?: number;
  onOpenChange?: (open: boolean) => void;
}

/**
 * No-op Popover for native – renders nothing.
 * Use native navigation patterns (modals, sheets) instead.
 */
export const Popover = ({ children: _children }: PopoverProps): null => {
  // On native we don't render the popover content at all.
  // The parent component should use Platform.OS checks to show
  // a native modal or action sheet instead.
  return null;
};

Popover.displayName = "Popover";

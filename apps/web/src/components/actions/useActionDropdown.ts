"use client";

/**
 * useActionDropdown — shared behaviour for portal-based action dropdowns.
 *
 * Handles:
 *   - Controlled / uncontrolled open state
 *   - Anchor positioning (recalculates on scroll & resize)
 *   - Outside-click and Escape-key dismissal
 *   - Portal vs inline rendering decision
 *
 * Used by CalendarDropdown, DirectionsDropdown, and any future action menus.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type RefObject,
} from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionDropdownOptions {
  /** Controlled open state. */
  open?: boolean;
  /** Callback when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Anchor element for portal positioning. Omit for inline mode. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Fixed width for the dropdown menu (px). Default 220. */
  menuWidth?: number;
}

export interface AnchorPosition {
  bottom: number;
  left: number;
  width: number;
}

export interface ActionDropdownReturn {
  isOpen: boolean;
  close: () => void;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Non-null only in portal mode while open. */
  anchorPos: AnchorPosition | null;
  /** True when an external anchorRef was provided (portal mode). */
  isPortal: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useActionDropdown({
  open: controlledOpen,
  onOpenChange,
  anchorRef,
  menuWidth = 220,
}: ActionDropdownOptions): ActionDropdownReturn {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const isPortal = anchorRef !== undefined;

  const menuRef = useRef<HTMLDivElement>(null);

  // ── Anchor positioning (updates on scroll / resize) ────────────────────

  const [anchorPos, setAnchorPos] = useState<AnchorPosition | null>(null);

  const recalcPosition = useCallback(() => {
    if (!anchorRef?.current) {
      setAnchorPos(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const idealLeft = rect.left + rect.width / 2 - menuWidth / 2;
    const clampedLeft = Math.max(
      8,
      Math.min(idealLeft, window.innerWidth - menuWidth - 8),
    );
    setAnchorPos({
      bottom: window.innerHeight - rect.top + 8,
      left: clampedLeft,
      width: menuWidth,
    });
  }, [anchorRef, menuWidth]);

  useEffect(() => {
    if (!isOpen || !anchorRef?.current) {
      setAnchorPos(null);
      return;
    }

    // Initial calculation.
    recalcPosition();

    // Re-position on scroll (any scrollable ancestor) and resize.
    window.addEventListener("scroll", recalcPosition, true);
    window.addEventListener("resize", recalcPosition);
    return () => {
      window.removeEventListener("scroll", recalcPosition, true);
      window.removeEventListener("resize", recalcPosition);
    };
  }, [isOpen, anchorRef, recalcPosition]);

  // ── Close helper ───────────────────────────────────────────────────────

  const close = useCallback(() => {
    if (isControlled) {
      onOpenChange?.(false);
    } else {
      setInternalOpen(false);
    }
  }, [isControlled, onOpenChange]);

  // ── Outside click / Escape ─────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, close]);

  return { isOpen, close, menuRef, anchorPos, isPortal };
}

"use client";

/**
 * Shared "Directions" dropdown.
 *
 * Renders a list of maps/directions options (Google Maps, Apple Maps,
 * copy address) inside a portal-based popover. Can be triggered:
 *   1. Inline — renders its own anchor button.
 *   2. Externally — controlled via `open` / `onOpenChange` with a custom
 *      `anchorRef` for positioning.
 *
 * Used both on the event detail page (inline) and from the Contextual Action
 * Bar (portal-anchored to the toggle chip).
 *
 * A third, opt-in `placement="cab-sheet"` mode renders an anchor-INDEPENDENT
 * sheet pinned just below the sticky page-action bar. It exists because
 * anchoring a popover to an action-bar overflow chip is unreliable — the
 * overflow popover closes on tap, so the anchor detaches and the menu renders
 * off-screen / behind the bar. `cab-sheet` sidesteps anchoring entirely: it
 * pins itself a fixed distance under the bar from CONSTANTS (the navbar's
 * published visible height + the bar's own height) — never by measuring the
 * bar element (the last measuring attempt pinned the sheet a full viewport
 * off-screen).
 */

import {
  useState,
  useRef,
  useEffect,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Navigation } from "lucide-react";
import { GoogleIcon, AppleIcon, WazeIcon } from "@/components/icons/BrandIcons";
import { googleMapsUrl, appleMapsUrl, wazeUrl } from "@/lib/maps/directions";

import { useActionDropdown } from "./useActionDropdown";
import { useNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";
import "./action-dropdown.css";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DirectionsTarget {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface DirectionsDropdownProps {
  /** Coordinates for generating directions links. */
  coords?: DirectionsTarget | null;
  /** Fallback address string (used when coords are not available). */
  address?: string;
  /** Controlled open state (for external triggers). */
  open?: boolean;
  /** Callback when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * When provided, the dropdown is positioned relative to this element
   * (portal mode). Otherwise it positions itself relative to its own anchor.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Positioning mode.
   *   - `"auto"` (default): today's behaviour — anchored portal when an
   *     `anchorRef` is given, otherwise inline. Existing consumers rely on this.
   *   - `"cab-sheet"`: anchor-INDEPENDENT sheet pinned just below the sticky
   *     page-action bar. Requires controlled `open` / `onOpenChange`.
   */
  placement?: "auto" | "cab-sheet";
  /** Labels — pass translated strings. */
  labels?: {
    trigger?: string;
    /**
     * Optional accessible name for the trigger, when the visible `trigger`
     * text alone would collide with another control on the same page (a venue
     * page carries this dropdown twice — hero and Location sidebar — and a
     * screen reader listing the page heard "Get directions" twice).
     *
     * WCAG 2.5.3 Label in Name: whatever is passed MUST still contain the
     * visible `trigger` string, verbatim and in order. "Get directions to The
     * Paramount" is fine; "Venue directions" is a violation.
     */
    triggerAriaLabel?: string;
    google?: string;
    apple?: string;
    waze?: string;
    copyAddress?: string;
    copied?: string;
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function DirectionsDropdown({
  coords,
  address,
  open: controlledOpen,
  onOpenChange,
  anchorRef,
  placement = "auto",
  labels,
}: DirectionsDropdownProps) {
  const inlineAnchorRef = useRef<HTMLButtonElement>(null);
  // cab-sheet uses its OWN ref, NOT the hook's `menuRef`. `useActionDropdown`
  // imperatively writes positioning styles (top/bottom/left) onto `menuRef.current`;
  // if the sheet shared that ref the hook would clobber the fixed-bottom style
  // with anchor math (rendering the sheet off-screen at top:-168). A separate ref
  // keeps the hook's `menuRef` unattached in cab-sheet mode (harmless) while the
  // sheet keeps its own `sheetStyle`.
  const sheetRef = useRef<HTMLDivElement>(null);
  const isCabSheet = placement === "cab-sheet";
  // The page-action bar sits under the consumer navbar (0 while the navbar is
  // slid away on mobile scroll, and always 0 in the admin shell); the sheet
  // pins itself under both.
  const navbarVisibleHeight = useNavbarVisibleHeight();
  // In cab-sheet mode we never anchor and never use the inline-toggle trigger:
  // the caller owns the open state via `open` / `onOpenChange`.
  const isInlineToggle =
    !isCabSheet && controlledOpen === undefined && !anchorRef;
  const [inlineOpen, setInlineOpen] = useState(false);

  const { isOpen, close, menuRef, anchorPos, isPortal } = useActionDropdown({
    open: isInlineToggle ? inlineOpen : controlledOpen,
    onOpenChange: isInlineToggle ? setInlineOpen : onOpenChange,
    // cab-sheet is anchor-independent: withhold the anchorRef so the hook stays
    // in controlled-inline mode (giving us close + Escape + outside-click on the
    // sheet element) without computing an anchor position.
    anchorRef: isInlineToggle || isCabSheet ? undefined : anchorRef,
  });

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the "Copied!" timeout on unmount or when dropdown closes.
  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    }
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, [isOpen]);

  // ── cab-sheet: focus management ────────────────────────────────────────────
  // Focus the first menu item on open; return focus to the previously-focused
  // element (the caller's trigger) on close.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isCabSheet) return;
    if (isOpen) {
      previouslyFocusedRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
      const raf = requestAnimationFrame(() => {
        sheetRef.current
          ?.querySelector<HTMLElement>('[role="menuitem"]')
          ?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    previouslyFocusedRef.current?.focus?.();
    previouslyFocusedRef.current = null;
  }, [isCabSheet, isOpen]);

  // cab-sheet: Escape closes (the hook's Escape handler is bound to `menuRef`,
  // which is intentionally unattached here, so wire our own).
  useEffect(() => {
    if (!isCabSheet || !isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isCabSheet, isOpen, close]);

  // Build URLs.
  const googleHref = coords
    ? googleMapsUrl(coords)
    : address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : null;

  const appleHref = coords
    ? appleMapsUrl(coords)
    : address
      ? `https://maps.apple.com/?q=${encodeURIComponent(address)}`
      : null;

  const wazeHref = coords ? wazeUrl(coords) : null;

  const copyableAddress = address ?? coords?.label;

  const handleCopy = async () => {
    if (!copyableAddress) return;
    try {
      await navigator.clipboard.writeText(copyableAddress);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch {
      // Fallback: noop.
    }
  };

  const menuItems = (
    <>
      {googleHref && (
        <a
          className="action-dropdown-item"
          role="menuitem"
          href={googleHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
        >
          <GoogleIcon size={16} aria-hidden="true" />
          {labels?.google ?? "Google Maps"}
        </a>
      )}
      {appleHref && (
        <a
          className="action-dropdown-item"
          role="menuitem"
          href={appleHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
        >
          <AppleIcon size={16} aria-hidden="true" />
          {labels?.apple ?? "Apple Maps"}
        </a>
      )}
      {wazeHref && (
        <a
          className="action-dropdown-item"
          role="menuitem"
          href={wazeHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={close}
        >
          <WazeIcon size={16} aria-hidden="true" />
          {labels?.waze ?? "Waze"}
        </a>
      )}
      {copyableAddress && (
        <button
          className="action-dropdown-item"
          role="menuitem"
          onClick={handleCopy}
        >
          {copied ? (
            <Check
              size={16}
              color="var(--success, #166534)"
              aria-hidden="true"
            />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          <span aria-live="polite">
            {copied
              ? (labels?.copied ?? "Copied!")
              : (labels?.copyAddress ?? "Copy address")}
          </span>
        </button>
      )}
    </>
  );

  const menuContent = (
    <div
      ref={menuRef}
      className="action-dropdown-menu"
      role="menu"
      data-open={isOpen}
      style={
        isPortal && anchorPos
          ? {
              position: "fixed",
              bottom: anchorPos.bottom,
              left: anchorPos.left,
              width: anchorPos.width,
            }
          : isInlineToggle
            ? // Inline toggle: overlay the menu below the trigger instead of
              // rendering it in document flow. In flow it grows/wraps its
              // container (e.g. pushing a sibling Follow button onto a second
              // row in a flex action row); absolute positioning inside the
              // relative wrapper keeps it a pure overlay.
              { position: "absolute", top: "calc(100% + 6px)", left: 0 }
            : undefined
      }
    >
      {menuItems}
    </div>
  );

  // ── cab-sheet mode — anchor-independent sheet under the page-action bar ──
  if (isCabSheet) {
    if (!isOpen) return null;

    const sheetStyle: CSSProperties = {
      position: "fixed",
      left: 8,
      right: 8,
      // Pin just under the navbar from its PUBLISHED height plus an 8px gap.
      // Do NOT pin by measuring the trigger's surroundings — measurement is
      // exactly what put the sheet off-screen before.
      top: navbarVisibleHeight + 8,
      // Centre on wider viewports; full-width (minus inset) on phones.
      maxWidth: 420,
      marginInline: "auto",
      // Above the sticky bar and its overflow menu.
      zIndex: 9999,
    };

    return createPortal(
      <>
        {/* Tap-outside scrim: closes the sheet. Faint so the page stays legible. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9998,
            background: "rgba(0, 0, 0, 0.08)",
            border: "none",
            padding: 0,
            cursor: "default",
          }}
        />
        <div
          ref={sheetRef}
          className="action-dropdown-menu"
          role="menu"
          data-open={isOpen}
          style={sheetStyle}
        >
          {menuItems}
        </div>
      </>,
      document.body,
    );
  }

  // Portal mode — render into document body.
  if (isPortal) {
    return isOpen ? createPortal(menuContent, document.body) : null;
  }

  // Inline toggle mode — render a trigger button + dropdown.
  if (isInlineToggle) {
    return (
      <div style={{ position: "relative" }}>
        <button
          ref={inlineAnchorRef}
          className="action-dropdown-trigger"
          onClick={() => setInlineOpen((v) => !v)}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          {...(labels?.triggerAriaLabel
            ? { "aria-label": labels.triggerAriaLabel }
            : {})}
        >
          <Navigation size={16} aria-hidden="true" />
          {labels?.trigger ?? "Get directions"}
        </button>
        {isOpen && menuContent}
      </div>
    );
  }

  // Controlled (always-open) inline — render menu directly.
  return isOpen ? menuContent : null;
}

DirectionsDropdown.displayName = "DirectionsDropdown";

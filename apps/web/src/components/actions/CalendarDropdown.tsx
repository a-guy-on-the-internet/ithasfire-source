"use client";

/**
 * Shared "Add to calendar" dropdown.
 *
 * Renders a list of calendar options (Google Calendar, Outlook, iCal download)
 * inside a portal-based popover. Can be triggered:
 *   1. Inline — renders its own anchor button.
 *   2. Externally — controlled via `open` / `onOpenChange` with a custom
 *      `anchorRef` for positioning.
 *
 * Used both on the event detail page (inline) and from the Contextual Action
 * Bar (portal-anchored to the toggle chip).
 */

import { type RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarPlus } from "lucide-react";

import { downloadICalFile } from "@/lib/calendar/ical";
import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "@/lib/calendar/web-calendar";
import { readableIso } from "@/lib/readable-date";

import { useActionDropdown } from "./useActionDropdown";
import "./action-dropdown.css";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  /**
   * The event's id. Becomes the .ics `UID`, so adding the event twice updates
   * one calendar entry instead of making a second. Optional for the same reason
   * it is on `CalendarEventData` — see `lib/calendar/ical.ts`.
   */
  id?: string;
  title: string;
  /** ISO 8601 */
  startsAt: string;
  /** ISO 8601 (optional; defaults to +2h) */
  endsAt?: string;
  location?: string;
}

export interface CalendarDropdownProps {
  event: CalendarEvent;
  /** Controlled open state (for external triggers). */
  open?: boolean;
  /** Callback when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * When provided, the dropdown is positioned relative to this element
   * (portal mode). Otherwise it positions itself relative to its own anchor.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Labels — pass translated strings. */
  labels?: {
    google?: string;
    outlook?: string;
    ical?: string;
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function CalendarDropdown({
  event,
  open: controlledOpen,
  onOpenChange,
  anchorRef,
  labels,
}: CalendarDropdownProps) {
  const { isOpen, close, menuRef, anchorPos, isPortal } = useActionDropdown({
    open: controlledOpen,
    onOpenChange,
    anchorRef,
  });

  // The builders throw on an unreadable start; without one there is nothing
  // to add to a calendar.
  if (!readableIso(event.startsAt)) return null;

  const googleUrl = buildGoogleCalendarUrl(event);
  const outlookUrl = buildOutlookCalendarUrl(event);

  const handleICalDownload = () => {
    downloadICalFile(event);
    close();
  };

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
          : undefined
      }
    >
      <a
        className="action-dropdown-item"
        role="menuitem"
        href={googleUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={close}
      >
        <CalendarPlus size={16} aria-hidden="true" />
        {labels?.google ?? "Google Calendar"}
      </a>
      <a
        className="action-dropdown-item"
        role="menuitem"
        href={outlookUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={close}
      >
        <CalendarPlus size={16} aria-hidden="true" />
        {labels?.outlook ?? "Outlook Calendar"}
      </a>
      <button
        className="action-dropdown-item"
        role="menuitem"
        onClick={handleICalDownload}
      >
        <CalendarPlus size={16} aria-hidden="true" />
        {labels?.ical ?? "Add to calendar"}
      </button>
    </div>
  );

  if (!isOpen) return null;

  // Portal mode — render into document body, positioned over the anchor.
  if (isPortal) {
    return createPortal(menuContent, document.body);
  }

  // Inline mode — render in-place.
  return menuContent;
}

CalendarDropdown.displayName = "CalendarDropdown";

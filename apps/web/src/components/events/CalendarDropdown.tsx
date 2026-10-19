"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslations } from "@th/ui";
import { Button } from "@th/ui";
import { CalendarPlus } from "lucide-react";
import { downloadICalFile } from "@/lib/calendar/ical";
import type { CalendarRecurrence } from "@/lib/calendar/recurrence";
import { readableIso } from "@/lib/readable-date";
import {
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "@/lib/calendar/web-calendar";

export type CalendarDropdownProps = {
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  /**
   * The event's id. Becomes the .ics `UID`, which is a calendar's identity key
   * for an entry — with one, adding the event twice UPDATES the entry the user
   * already has instead of duplicating it. Optional: surfaces that render the
   * page without an id (the admin preview) fall back to a derived-but-stable
   * UID, see `lib/calendar/ical.ts`.
   */
  eventId?: string;
  /** IANA timezone. Required for `recurrence` to be exported at all. */
  timezone?: string;
  /**
   * The listing's cadence, when it has one. Makes the .ics and the Google
   * Calendar link carry an `RRULE` so a weekly open mic lands as a repeating
   * entry rather than one appointment on the next date. `null` / absent is the
   * single-event export, unchanged.
   */
  recurrence?: CalendarRecurrence | null;
  /**
   * `poster` renders the trigger as the third of the poster-first page's rail
   * actions (`.event-poster-action`, beside Save and Share, under the poster),
   * and opens the menu BELOW it — the default opens upward because its home
   * is the bottom of the schedule section. Hidden on a phone by the same
   * stylesheet; the schedule section still carries the default one there.
   */
  variant?: "default" | "poster";
};

export function CalendarDropdown({
  title,
  startsAt,
  endsAt,
  location,
  eventId,
  timezone,
  recurrence,
  variant = "default",
}: CalendarDropdownProps) {
  const t = useTranslations();
  const poster = variant === "poster";

  // One shape for all three builders, so the .ics download and the two web
  // links can never disagree about what is being added.
  const calendarEvent = useMemo(
    () => ({
      id: eventId,
      title,
      startsAt,
      endsAt,
      location: location ?? undefined,
      timezone,
      recurrence: recurrence ?? null,
    }),
    [eventId, title, startsAt, endsAt, location, timezone, recurrence],
  );

  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  // Close calendar dropdown when clicking outside
  useEffect(() => {
    if (!calendarOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        calendarRef.current &&
        !calendarRef.current.contains(e.target as Node)
      ) {
        setCalendarOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCalendarOpen(false);
        const trigger =
          calendarRef.current?.querySelector<HTMLElement>("button");
        trigger?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [calendarOpen]);

  // The builders below run during render and throw on an unreadable start, so
  // with no real start there is nothing to add to a calendar. After the hooks.
  if (!readableIso(startsAt)) return null;

  return (
    <div
      className={
        poster
          ? "calendar-dropdown-anchor event-poster-action-anchor event-poster-action-anchor--calendar"
          : "calendar-dropdown-anchor"
      }
      data-open={calendarOpen}
      ref={calendarRef}
    >
      {poster ? (
        <button
          type="button"
          className="event-poster-action"
          onClick={() => setCalendarOpen((prev) => !prev)}
          aria-label={String(t("eventDetail.addToCalendar"))}
          aria-expanded={calendarOpen}
          aria-haspopup="menu"
        >
          <CalendarPlus size={16} aria-hidden="true" />
          <span className="event-poster-action__label">
            {String(t("eventDetail.calendar"))}
          </span>
        </button>
      ) : (
        /* $4 = 44px — the mobile tap-target floor ($3 rested at 36px).
           The label wraps rather than overflow: the Button's label never
           wraps by default, and "Añadir al calendario" on one line is 284px
           against a 236px column at 320. Two 16px lines, 4px padding and the
           2px borders make 44, so a wrapped label keeps the height; a third
           line would grow the button. No textAlign in textProps: it reaches
           the DOM unconverted (AvailabilitySetupBanner, measured live). */
        <Button
          variant="secondary"
          size="$4"
          maxWidth="100%"
          height="auto"
          minHeight={44}
          paddingVertical="$1"
          textProps={{ whiteSpace: "normal", lineHeight: 16 }}
          onPress={() => setCalendarOpen((prev) => !prev)}
          aria-expanded={calendarOpen}
          aria-haspopup="menu"
        >
          <CalendarPlus size={16} aria-hidden="true" />
          {String(t("eventDetail.addToCalendar"))}
        </Button>
      )}
      <div
        className={
          poster
            ? "calendar-dropdown-menu calendar-dropdown-menu--below"
            : "calendar-dropdown-menu"
        }
        role="menu"
      >
        <a
          className="calendar-dropdown-item"
          role="menuitem"
          href={buildGoogleCalendarUrl(calendarEvent)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setCalendarOpen(false)}
        >
          <CalendarPlus size={16} aria-hidden="true" />
          {String(t("eventDetail.addToGoogleCalendar"))}
        </a>
        <a
          className="calendar-dropdown-item"
          role="menuitem"
          href={buildOutlookCalendarUrl(calendarEvent)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setCalendarOpen(false)}
        >
          <CalendarPlus size={16} aria-hidden="true" />
          {String(t("eventDetail.addToOutlookCalendar"))}
        </a>
        <button
          className="calendar-dropdown-item"
          role="menuitem"
          onClick={() => {
            downloadICalFile(calendarEvent);
            setCalendarOpen(false);
          }}
        >
          <CalendarPlus size={16} aria-hidden="true" />
          {String(t("eventDetail.addToCalendar"))}
        </button>
      </div>
    </div>
  );
}

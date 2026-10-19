"use client";

/**
 * Series ticket date-picker.
 *
 * Bridges the event detail page to the Contextual Action Bar's primary
 * "Get tickets" CTA for events that belong to a series. It registers a
 * `getTickets` action that opens a small modal prompting the buyer to
 * pick a date; "Continue" then routes to that date's checkout (the seat
 * picker).
 *
 * IMPORTANT — single-date fallback:
 *   This component is only mounted by `EventDetail` when the event has two or
 *   more published sibling dates. For single-date (non-series) events it is
 *   never rendered, so no `getTickets` action is registered and the CTA
 *   falls back to its `href` ("/events/checkout/:slug") — navigating straight
 *   to checkout exactly as before.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { ArrowRight, X } from "lucide-react";
import { useTheme } from "tamagui";
import { useFormatters, useTranslations } from "@th/ui";

import {
  ACCENT,
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ON_ACCENT_FILL,
} from "@/lib/design-tokens";
import type { EventContentSeriesDate } from "@/components/events/event-content-types";
import { readableIso } from "@/lib/readable-date";

import "./series-date-picker.css";

export interface SeriesTicketDatePickerProps {
  /** Published sibling dates for this series (>= 2 when mounted). */
  seriesDates: EventContentSeriesDate[];
  /**
   * Controlled open state, owned by the page so the "Get tickets" button can
   * open this overlay. (It used to open via a floating-action-bar registration;
   * that bar was removed 2026-08-27 and every page now owns its own actions.)
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slug to highlight when the overlay opens; the page picks the default. */
  initialSlug?: string | null;
}

/** Test id of the "Get tickets" CTA — focus returns here on close. */
const CTA_TEST_ID = "event-get-tickets-btn";

/**
 * Pick the date that should be highlighted when the overlay opens:
 *   1. the date the buyer is currently viewing (`isCurrent`), else
 *   2. the soonest upcoming date (`startsAt >= now`), else
 *   3. the first date in the list.
 * `undefined` only for an empty list.
 */
function pickDefaultDate(
  dates: EventContentSeriesDate[],
): EventContentSeriesDate | undefined {
  const current = dates.find((d) => d.isCurrent);
  if (current) return current;

  const now = Date.now();
  const upcoming = dates
    .filter((d) => new Date(d.startsAt).getTime() >= now)
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  if (upcoming.length > 0) return upcoming[0];

  return dates[0];
}

export function SeriesTicketDatePicker({
  seriesDates,
  open,
  onOpenChange,
  initialSlug = null,
}: SeriesTicketDatePickerProps) {
  const router = useRouter();
  const theme = useTheme();
  const t = useTranslations();
  const fmt = useFormatters();

  // A date whose start is unreadable is left out here, once: formatting it
  // throws a RangeError, and a date the buyer cannot read is not one they can
  // pick or buy. Everything below works from this list only.
  const dates = useMemo(
    () => seriesDates.filter((d) => readableIso(d.startsAt)),
    [seriesDates],
  );

  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialSlug);

  const setOpen = onOpenChange;

  // The page opens the overlay; seed the highlighted date when it does. A
  // seeded slug that is not in the readable list (an unreadable date) is
  // replaced, so Continue can never route to a date the list does not show.
  useEffect(() => {
    if (open) {
      setSelectedSlug((current) =>
        current && dates.some((d) => d.slug === current)
          ? current
          : (pickDefaultDate(dates)?.slug ?? null),
      );
    }
  }, [open, dates]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // ── Close + return focus to the CTA ───────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the Get-tickets CTA for keyboard / screen-reader users.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="${CTA_TEST_ID}"]`)
        ?.focus();
    });
  }, []);

  const handleContinue = useCallback(() => {
    if (!selectedSlug) return;
    router.push(`/events/checkout/${selectedSlug}`);
  }, [router, selectedSlug]);

  // ── Focus management: move focus into the dialog + trap Tab ────────────────
  useEffect(() => {
    if (!open) return;

    // Focus the selected option once the dialog has mounted.
    const focusTimer = requestAnimationFrame(() => {
      if (selectedSlug) {
        optionRefs.current.get(selectedSlug)?.focus();
      } else {
        dialogRef.current?.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;

      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, selectedSlug, close]);

  const formatDate = useCallback(
    (date: EventContentSeriesDate) =>
      fmt.dateTime(new Date(date.startsAt), {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(date.timezone ? { timeZone: date.timezone } : {}),
      }),
    [fmt],
  );

  // ── Resolved theme colors (strict-Swiss content surfaces) ──────────────────
  // Fallbacks mirror the Stub (warm-paper) theme — the shipped default — so a
  // failed token resolve degrades to the light scheme, not the retired navy.
  const surface = theme.surface?.val ?? theme.background?.val ?? "#FDFAF3";
  const foreground = theme.color?.val ?? "#211C16";
  const muted = theme.colorMuted?.val ?? "#5C544A";
  const border = theme.borderColor?.val ?? "#211C16";

  const titleId = "series-date-picker-title";
  const descId = "series-date-picker-desc";

  // No readable date left: render nothing, as the page does when a series has
  // fewer than two dates (it never mounts this picker).
  if (!open || dates.length === 0) return null;

  return (
    <div className="series-picker-backdrop" onClick={close} role="presentation">
      <div
        ref={dialogRef}
        className="series-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        data-testid="series-date-picker"
        onClick={(e) => e.stopPropagation()}
        style={{ background: surface, borderColor: border, color: foreground }}
      >
        <div className="series-picker-header">
          <h2 id={titleId} className="series-picker-title">
            {String(t("eventDetail.selectDate"))}
          </h2>
          <button
            type="button"
            className="series-picker-close"
            onClick={close}
            aria-label={String(t("eventDetail.selectDateClose"))}
            data-testid="series-date-close"
          >
            <X size={18} color={foreground} aria-hidden="true" />
          </button>
        </div>

        <p
          id={descId}
          className="series-picker-subtitle"
          style={{ color: muted }}
        >
          {String(t("eventDetail.selectDateSubtitle"))}
        </p>

        <div
          className="series-picker-list"
          role="radiogroup"
          aria-labelledby={titleId}
        >
          {dates.map((date) => {
            const checked = date.slug === selectedSlug;
            return (
              <button
                key={date.occurrenceId}
                ref={(el) => {
                  if (el) optionRefs.current.set(date.slug, el);
                  else optionRefs.current.delete(date.slug);
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                className="series-picker-option"
                data-testid="series-date-option"
                data-slug={date.slug}
                data-selected={checked || undefined}
                onClick={() => setSelectedSlug(date.slug)}
                style={{
                  borderColor: checked ? ACCENT : border,
                  background: checked
                    ? "color-mix(in srgb, " + ACCENT + " 10%, transparent)"
                    : "transparent",
                  color: foreground,
                }}
              >
                <span
                  className="series-picker-radio"
                  aria-hidden="true"
                  style={{ borderColor: checked ? ACCENT : muted }}
                >
                  {checked && (
                    <span
                      className="series-picker-radio-dot"
                      style={{ background: ACCENT }}
                    />
                  )}
                </span>
                <span>{formatDate(date)}</span>
              </button>
            );
          })}
        </div>

        <div className="series-picker-footer">
          <button
            type="button"
            className="series-picker-continue"
            onClick={handleContinue}
            disabled={!selectedSlug}
            data-testid="series-date-continue"
            // Button-atom grammar via tokens: this 14px/700 label rides the #B93312 RUNG
            // (`ACCENT_FILL`) with a white label — 5.92:1. Not `ACCENT` (#E2481D): that fill has no
            // AA foreground in either polarity (white 4.06:1, ink 4.38:1), which is exactly why the
            // @th/ui Button atom rests on $brandSecondaryHover too. Hover climbs the next rung
            // (#98240B, 8.10:1) — `ACCENT_HOVER` would be a no-op here, since `accentHover` is the
            // same #B93312 as the rest rung on Stub.
            style={
              {
                "--sp-accent": ACCENT_FILL,
                "--sp-accent-hover": ACCENT_FILL_HOVER,
                color: ON_ACCENT_FILL,
              } as React.CSSProperties
            }
          >
            {String(t("eventDetail.selectDateContinue"))}
            <ArrowRight size={16} strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

SeriesTicketDatePicker.displayName = "SeriesTicketDatePicker";

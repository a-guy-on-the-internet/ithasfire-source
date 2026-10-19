"use client";

/**
 * In-iframe series date switcher.
 *
 * When the active event belongs to a series with two or more published
 * sibling dates, this renders a compact group of date pills above the
 * "Select tickets" section. Picking a different date calls `onSelectDate`
 * with that date's `eventId` — the parent SPA (`page.tsx`) then swaps the
 * active event and resets the cart WITHOUT any router navigation, keeping
 * everything inside the embed iframe.
 *
 * Renders nothing while loading, on error, or when the series has fewer than
 * two published dates (preserving single-event behavior).
 */

import { useMemo } from "react";

import { trpc } from "@/trpc";

import {
  STEEL_BLUE,
  TEXT,
  TEXT_INVERTED,
  BORDER,
  SURFACE,
  sectionLabelStyle,
} from "./embed-theme";

const MIN_DATES_FOR_SWITCHER = 2;

function formatSeriesDate(startsAt: string, timezone: string): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return startsAt;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: timezone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(d);
  }
}

export function EmbedSeriesDateSwitcher({
  eventId,
  onSelectDate,
}: {
  /** The currently active event id. The series resolves from this member. */
  eventId: string;
  /** Switch the active event to the chosen date's event (no navigation). */
  onSelectDate: (eventId: string) => void;
}) {
  const { data, isLoading, isError } = trpc.series.publicSeriesDates.useQuery(
    { eventId },
    {
      staleTime: 60_000,
      retry: 1,
      // Keep prior pills rendered while the new date's query is in flight.
      // Sibling dates return an identical list, so without this the whole
      // group unmounts on every switch (isLoading → null) causing a flicker.
      placeholderData: (prev) => prev,
    },
  );

  const dates = useMemo(() => data?.dates ?? [], [data?.dates]);

  // Render nothing while loading, on error, or for single-date events.
  if (isLoading || isError || dates.length < MIN_DATES_FOR_SWITCHER) {
    return null;
  }

  return (
    <div style={{ padding: "8px 16px 0" }}>
      <div
        style={{
          padding: "4px 4px 8px",
        }}
      >
        <h3 id="embed-series-date-label" style={sectionLabelStyle}>
          Select date
        </h3>
      </div>
      <div
        role="group"
        aria-labelledby="embed-series-date-label"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          paddingBottom: 4,
        }}
      >
        {dates.map((date) => {
          const isActive = date.eventId === eventId || date.isCurrent;
          return (
            <button
              key={date.occurrenceId}
              type="button"
              aria-pressed={isActive}
              aria-current={isActive ? "date" : undefined}
              onClick={() => {
                if (!isActive) onSelectDate(date.eventId);
              }}
              style={{
                minHeight: 44,
                display: "inline-flex",
                alignItems: "center",
                borderRadius: 0,
                border: `2px solid ${isActive ? STEEL_BLUE : BORDER}`,
                background: isActive ? STEEL_BLUE : SURFACE,
                color: isActive ? TEXT_INVERTED : TEXT,
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.02em",
                textTransform: "uppercase",
                cursor: isActive ? "default" : "pointer",
                transition: "border-color 0.15s, background 0.15s, color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {formatSeriesDate(date.startsAt, date.timezone)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

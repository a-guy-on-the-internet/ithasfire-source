"use client";

import { useCallback, useMemo, useState } from "react";
import { Text, useListingPriceWords } from "@th/ui";

import {
  CalendarEngine,
  useCalendarText,
  useResolvedCalendarLabels,
  zoneParts,
  type CalendarItem,
  type CalendarView,
} from "@/app/admin/[slug]/_components/calendar";
import {
  DEFAULT_VIEWER_TIMEZONE,
  useViewerTimezone,
} from "@/hooks/useViewerTimezone";

import {
  buildEmbedCalendarItems,
  calendarThemeBridgeStyle,
  resolveCalendarEventClick,
  resolveEmbedPaintZone,
  type EmbedCalendarEvent,
  type EmbedCalendarThemeOverrides,
} from "./embed-calendar-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Embed calendar browse — the calendar counterpart of EmbedEventGrid.
//
// One engine, public mode (event-calendar-redesign FR-020): the SAME
// CalendarEngine the dashboard and place calendars mount, asked for month and
// week only. Public mode draws no filter chips, no overflow menu, no holds and
// no create affordance, and never opens a peek — a chip press calls
// `onPublicItemPress`, which routes exactly as it always has: in-iframe
// detail → checkout for a checkout-eligible event, a new tab on
// ithasfire.com for everything else (`resolveCalendarEventClick`).
//
// Below 600px the engine's own dot-grid month + tapped-day list takes over
// (FR-010, one mobile shape across admin and embed) — that replaced the
// bespoke EmbedCalendarAgenda this file used to swap in.
// ─────────────────────────────────────────────────────────────────────────────

/** Month and week only — no agenda on the embed (FR-008). Module-level so the
 *  array identity is stable across renders (the engine reconciles on it). */
const EMBED_VIEWS: CalendarView[] = ["month", "week"];

type Props = {
  /** Display name for the calendar owner (org name, host name, event title). */
  ownerName: string;
  /** Events from `embeds.getCalendarEvents` (may include recent PAST dates). */
  events: EmbedCalendarEvent[];
  /** When true, ALL clicks open the event on Ithas Fire in a new tab. */
  linkOut: boolean;
  buildEventUrl: (slugOrId: string) => string;
  /** Enter the in-iframe detail/checkout flow for a checkout-eligible event. */
  onSelectEvent: (eventId: string) => void;
  /** Resolved URL theme overrides, bridged onto the engine's semantic vars. */
  themeOverrides: EmbedCalendarThemeOverrides;
};

export function EmbedCalendarBrowse({
  ownerName,
  events,
  linkOut,
  buildEventUrl,
  onSelectEvent,
  themeOverrides,
}: Props) {
  const ct = useCalendarText();
  // The engine's own catalog-resolved label set — reused here so the month
  // name in the empty caption is translated by the same table the toolbar's
  // range label uses, not by a hardcoded `Intl` locale.
  const labels = useResolvedCalendarLabels();

  const [view, setView] = useState<CalendarView>("month");
  // One stable "now" for the opening anchor — a fresh Date per render would
  // rebuild the grid every paint.
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  // FR-018: the embed paints in the venue/subject zone, never the viewer's.
  const timezone = useMemo(
    () => resolveEmbedPaintZone(events, DEFAULT_VIEWER_TIMEZONE),
    [events],
  );
  // Falls back to the paint zone until the browser answers, so the first paint
  // (and SSR) flags no mismatch and hydration cannot drift.
  const viewerTimezone = useViewerTimezone(timezone);

  // The engine's own key — a title-less row reads the same here as on the
  // dashboard. In both catalogs (NFR-002); the literal is `ct`'s per-key
  // fallback, so a future catalog gap degrades to English, not to the key.
  const untitledLabel = ct("admin.calUntitledEvent", "Untitled event");
  // The week row's price line in the viewer's language ("Desde $15").
  const priceWords = useListingPriceWords();
  const { items, sources } = useMemo(
    () => buildEmbedCalendarItems(events, { untitledLabel, priceWords }),
    [events, untitledLabel, priceWords],
  );

  const handlePublicItemPress = useCallback(
    (item: CalendarItem) => {
      // Public mode never paints a hold; narrow the union for the mapper.
      if (item.kind !== "event") return;
      const source = sources.get(item.id);
      const action = resolveCalendarEventClick({ linkOut, event: source });
      if (action === "linkOut") {
        // NEW TAB via the canonical event URL — never navigate the iframe
        // itself (mirrors EmbedEventGrid's linkOut path).
        window.open(
          buildEventUrl(source?.slug ?? item.eventId),
          "_blank",
          "noopener,noreferrer",
        );
        return;
      }
      // The PARENT event id: an expanded occurrence's composite id means
      // nothing to `embeds.getEventDetail`.
      onSelectEvent(item.eventId);
    },
    [sources, linkOut, buildEventUrl, onSelectEvent],
  );

  // The endpoint only serves upcoming-or-ongoing events, so a month with zero
  // visible events may still have HAD events — "no events scheduled" would be
  // wrong. Both keys are in the `embed` group of both catalogs (NFR-002): the
  // widget runs on a partner's page, where a Spanish viewer reading English is
  // the partner's problem, not ours.
  //
  // The ENGINE decides whether the window is actually empty and paints this
  // inside its own frame (month, week and agenda alike); this mount only
  // supplies the copy, which is why it is computed unconditionally. Below
  // 600px the engine paints its dot grid + day list and shows none of it —
  // the day list already answers with "Nothing on this day".
  const emptyLabel = useMemo(() => {
    if (view === "week") {
      return ct("embed.calendarEmptyWeek", "No upcoming events this week");
    }
    const { year, month } = zoneParts(anchor, timezone);
    return ct(
      "embed.calendarEmptyMonth",
      "No upcoming events in {month} {year}",
      { month: labels.monthsLong[month - 1] ?? "", year },
    );
  }, [view, anchor, timezone, ct, labels]);

  // Bridge the URL theme overrides onto the semantic vars the engine paints
  // with. Applied to a wrapper the engine inherits from — custom properties
  // cascade to the whole subtree.
  const themeBridge = calendarThemeBridgeStyle(themeOverrides);

  return (
    <div data-testid="embed-calendar-theme-bridge" style={themeBridge}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 8,
          minHeight: 400,
          minWidth: 0,
        }}
      >
        {/* Owner label — org name, venue name, event title. Rides `tone="muted"`
            (→ --colorMuted), which the bridge points at --hf-text-muted so a
            host's `fontColor` reaches it too. */}
        {ownerName && (
          <div style={{ padding: "4px 8px 0", minWidth: 0 }}>
            <Text variant="overline" tone="muted" truncate>
              {ownerName}
            </Text>
          </div>
        )}

        <CalendarEngine
          mode="public"
          items={items}
          view={view}
          onViewChange={setView}
          views={EMBED_VIEWS}
          anchor={anchor}
          onAnchorChange={setAnchor}
          timezone={timezone}
          viewerTimezone={viewerTimezone}
          onPublicItemPress={handlePublicItemPress}
          emptyLabel={emptyLabel}
        />
      </div>
    </div>
  );
}

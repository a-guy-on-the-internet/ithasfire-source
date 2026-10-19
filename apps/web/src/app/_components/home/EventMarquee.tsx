"use client";

import { useEffect, useMemo, useState } from "react";

import { useTranslations, type EventSummary } from "@th/ui";

import { MarqueeBand, type MarqueeItem } from "./MarqueeBand";

// ─────────────────────────────────────────────────────────────────────────────
// "S2 Signal" — upcoming-events marquee content (v2 grammar).
//
// The S2 band's LAUNCH content: we ship single-region (Nashville only), so the
// city list is too thin to render (<3 cities self-hides CityMarquee). Events
// ARE the signal at launch volume — a scrolling strip of the next shows, each
// a real link to its event page. CityMarquee stays available for a future
// multi-region swap-back.
//
// Composition rule unchanged (do not "fix"): this is an INK band — accent
// appears ONLY as the ◆ separator glyph and the focus ring, never as the band
// fill (S6 HostConvertBand owns the page's one accent-dominant band). All the
// band machinery (seamless loop, a11y invariants, self-hide) lives in the
// shared MarqueeBand shell.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ITEMS = 12;

/** Days from `now`'s local calendar day to `date`'s local calendar day. */
const calendarDayDiff = (date: Date, now: Date): number => {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
};

/**
 * Ticker date label for one event, in the viewer's local timezone:
 * today → "TONIGHT", next day → "TOMORROW", within the following 6 calendar
 * days → 3-letter weekday ("FRI"), anything else (incl. past, missing or
 * invalid `startsAt`) → the pre-formatted `fallbackDate`, uppercased.
 * Pure — exported for tests.
 */
export function eventTickerDateLabel(
  startsAt: string | undefined,
  fallbackDate: string,
  now: Date,
): string {
  if (!startsAt) return fallbackDate.toUpperCase();
  const starts = new Date(startsAt);
  if (Number.isNaN(starts.getTime())) return fallbackDate.toUpperCase();
  const diff = calendarDayDiff(starts, now);
  if (diff === 0) return "TONIGHT";
  if (diff === 1) return "TOMORROW";
  if (diff > 1 && diff <= 6) {
    return starts
      .toLocaleDateString("en-US", { weekday: "short" })
      .toUpperCase();
  }
  return fallbackDate.toUpperCase();
}

// ── Component ──────────────────────────────────────────────────────────────────

export function EventMarquee({ events }: { events: EventSummary[] }) {
  const t = useTranslations();
  // Relative labels ("TONIGHT"/"TOMORROW"/weekday) are derived CLIENT-ONLY.
  // This band does NOT SSR as null: page.tsx prefetches `events.countryEvents`
  // into the hydrated query cache, so with 3+ events the server renders the
  // full band — and the server clock is UTC (Cloud Run), not the viewer's
  // timezone. Deriving labels during SSR would emit e.g. "TOMORROW" for a
  // Nashville 9pm show (02:00Z next day) and then hydrate to "TONIGHT" — a
  // text hydration mismatch on most home loads, plus wrong labels in the
  // edge-cached pre-hydration HTML. So: `now` is null until the mount effect
  // runs, and while null every label falls back to the pre-formatted
  // `event.date` (uppercased). The mapper formats that string in the EVENT's
  // zone (`Event.timezone`), not the server's or the viewer's, so it is
  // identical on server and first client render, no layout shift (the band
  // still renders). One `now` per mount — labels must NOT re-derive on an
  // interval (a marquee that flips "TONIGHT" mid-scroll is churn, not signal).
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const items: MarqueeItem[] = useMemo(() => {
    const startsAtMs = (e: EventSummary): number | null => {
      if (!e.startsAt) return null;
      // Not `t` — that name is the translator in this component's scope now.
      const ms = new Date(e.startsAt).getTime();
      return Number.isNaN(ms) ? null : ms;
    };

    return events
      .filter((e) => Boolean(e.slug))
      .map((event, index) => ({ event, index }))
      .sort((a, b) => {
        // Ascending by start time; events without a (valid) startsAt sort
        // last, preserving input order within each group.
        const ta = startsAtMs(a.event);
        const tb = startsAtMs(b.event);
        if (ta != null && tb != null && ta !== tb) return ta - tb;
        if (ta != null && tb == null) return -1;
        if (ta == null && tb != null) return 1;
        return a.index - b.index;
      })
      .slice(0, MAX_ITEMS)
      .map(({ event }) => {
        // Pre-mount (now == null): SSR-safe fallback label, matching the
        // server HTML byte-for-byte. Post-mount: the relative label.
        const dateLabel = now
          ? eventTickerDateLabel(event.startsAt, event.date, now)
          : event.date.toUpperCase();
        const hasVenue = event.venue.trim().length > 0;
        return {
          key: event.id,
          href: `/events/${event.slug}`,
          ariaLabel: hasVenue
            ? `${event.title} at ${event.venue}, ${dateLabel}`
            : `${event.title}, ${dateLabel}`,
          segments: [
            { text: dateLabel, tone: "muted" as const },
            { text: event.title.toUpperCase(), tone: "primary" as const },
            ...(hasVenue
              ? [
                  {
                    text: `— ${event.venue.toUpperCase()}`,
                    tone: "muted" as const,
                  },
                ]
              : []),
          ],
        };
      });
  }, [events, now]);

  // Catalog-sourced like every other string on this page — the label is
  // identical on server and client, so it is not part of the hydration
  // contract, it was just the last hardcoded English string here.
  return (
    <MarqueeBand
      items={items}
      sectionAriaLabel={String(t("home.upcomingEvents"))}
    />
  );
}

EventMarquee.displayName = "EventMarquee";

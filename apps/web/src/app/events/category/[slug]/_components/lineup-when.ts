import type { EventSummary } from "@th/ui";
import { resolveTimeZone } from "@th/core/lib/venue-local-time";

/**
 * Compact when-column labels from a structured ISO start time. LineupRow
 * uppercases, so we hand it title-case ("Jul 24" / "Sat · 10 PM"). Falls back
 * to the pre-formatted `date` string as the date line (no time) when the event
 * carries no `startsAt`: the server already localised that string.
 *
 * Every part is read in the EVENT's own zone (`timezone`, or
 * `DEFAULT_VENUE_TIMEZONE` when absent or unusable), never the viewer's: the
 * grid card of the same event prints its time that way (`deriveCardStamp`),
 * and everyone going to one show reads the same door time. That also makes the
 * labels the same on the server (UTC) and in every browser, so the server
 * renders them and nothing swaps in after hydration.
 */
export function toLineupWhen(
  event: EventSummary,
  locale: string,
  compact: boolean,
): { dateLabel?: string; timeLabel?: string } {
  if (!event.startsAt) {
    return event.date ? { dateLabel: event.date } : {};
  }
  try {
    const d = new Date(event.startsAt);
    if (Number.isNaN(d.getTime())) {
      return event.date ? { dateLabel: event.date } : {};
    }
    const timeZone = resolveTimeZone(event.timezone);
    // 2-digit, not numeric: a column of dates has to align optically, so the
    // day is zero-padded ("SEP 02", never "SEP 2") — the same rule DateBlock
    // guarantees. Deriving a second rendering of a field is how two truths get
    // into one column (D-100).
    const dateLabel = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "2-digit",
      timeZone,
    }).format(d);
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone,
    }).format(d);
    // On-the-hour starts read "8 PM", not "8:00 PM" — the design system's own
    // time rendering. Half-hour starts keep their minutes ("8:30 PM"), which is
    // the string the when-column is sized against. The minute is read in the
    // event's zone too: a +5:30 renderer would otherwise see 8 PM as :30.
    const minute = Number(
      new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone }).format(
        d,
      ),
    );
    const time = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      ...(minute === 0 ? {} : { minute: "2-digit" }),
      timeZone,
    })
      .format(d)
      // ICU builds differ on the space before AM/PM (U+202F in newer ones);
      // a plain space reads the same and cannot differ server to browser.
      .replace(/\s/g, " ");
    // The weekday is dropped in compact. The when-column is a fixed track and
    // its time line may not wrap (D-101), so the track has to fit the longest
    // string it can ever hold; carrying "WED · " on a 320px screen costs ~40px
    // of the title column and says nothing the date line above it doesn't.
    return { dateLabel, timeLabel: compact ? time : `${weekday} · ${time}` };
  } catch {
    return event.date ? { dateLabel: event.date } : {};
  }
}

import { DEFAULT_VENUE_TIMEZONE } from "@th/types/datetime";

import type { DateStubParts } from "../events/DateStub";

export interface CardStamp {
  /** `Oct` — the poster stamp's month. */
  month: string;
  /** `09` — the poster stamp's zero-padded day. */
  day: string;
  /** The Date Stub's DOW / DD / MO (`THU / 9 / OCT`). */
  stubParts: DateStubParts;
  /** `7:00 PM` — the poster meta line's start time. */
  time: string;
}

/**
 * The zone a card renders its date in: the event's own when it is a usable
 * IANA name, otherwise `DEFAULT_VENUE_TIMEZONE`, the same fallback the server
 * mappers format `event.date` with (`resolveTimeZone` in `@th/core`).
 *
 * Never the renderer's zone. The server renders in UTC (Cloud Run) and the
 * browser in the viewer's zone, so a renderer-local stamp printed "12:00 AM"
 * on the server and "7:00 PM" in Nashville for the same show: React error
 * #418 on every home load outside UTC, and a client re-render of the root.
 */
export const resolveCardTimeZone = (timezone?: string | null): string => {
  // Same rule as core's `resolveTimeZone`: absent is the default, no trim.
  if (!timezone) return DEFAULT_VENUE_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    // An unusable IANA string makes Intl throw. Same fallback as an absent
    // zone, so server and browser still agree.
    return DEFAULT_VENUE_TIMEZONE;
  }
};

/**
 * The card's ONE date derivation: the poster's corner stamp, the Date Stub's
 * DOW / DD / MO and the poster meta line's time all read it.
 *
 * Derived from `startsAt`, the same instant `event.date` was formatted from,
 * rather than by parsing the display string back apart. Two renderings of one
 * field is how a card ends up stamped SEP 2 above a line that reads SEP 3 (the
 * D-100 trap), and a localized date string is not a parseable format anyway.
 *
 * Every part is read in ONE zone (`resolveCardTimeZone`), so the parts agree
 * with each other and print the same text on the server and in every browser.
 * They agree with `date` whenever the producer sends the zone `date` was
 * formatted in: the DB-backed mappers do, and so do search hits (the index
 * stores `timezone`; a document indexed before it falls back to the default).
 *
 * No usable `startsAt`, no stamp: a guessed date on a ticket-shaped object is
 * worse than none.
 */
export const deriveCardStamp = (
  startsAt: string | null | undefined,
  timezone?: string | null,
): CardStamp | null => {
  if (!startsAt) return null;
  const when = new Date(startsAt);
  if (Number.isNaN(when.getTime())) return null;
  const timeZone = resolveCardTimeZone(timezone);
  const monthShort = when.toLocaleDateString("en-US", {
    month: "short",
    timeZone,
  });
  const dayPlain = when.toLocaleDateString("en-US", {
    day: "numeric",
    timeZone,
  });
  return {
    month: monthShort,
    day: dayPlain.padStart(2, "0"),
    // The Date Stub's own ramp: uppercase caps, and an UNPADDED day (the
    // artifact reads `THU / 10 / SEP`, never `THU / 010 / SEP`).
    stubParts: {
      weekday: when
        .toLocaleDateString("en-US", { weekday: "short", timeZone })
        .toUpperCase(),
      day: dayPlain,
      month: monthShort.toUpperCase(),
    },
    time: when
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      })
      .replace(/\s/g, " "),
  };
};

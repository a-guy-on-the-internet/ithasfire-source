/**
 * TIME ZONE PRIMITIVES FOR THE PRINT LAYER.
 *
 * Shared, not duplicated, because paper is the one surface where getting a
 * zone wrong is unrecoverable: a screen re-renders when the reader moves, a
 * printed sheet does not. Both volunteer documents — the organizer's badge
 * sheet and the volunteer's own check-in code — state a shift window in the
 * VENUE's zone and name that zone out loud, and they have to agree about what
 * that means down to the day boundary. Two copies of this logic would drift,
 * and the drift would surface as two pieces of paper about the same shift
 * disagreeing about which day it is.
 *
 * (The ticket stub cannot join them: `getMyOrder` does not carry
 * `Event.timezone`, so it renders in the viewer's zone and says so. When that
 * contract grows a zone, it should come here too.)
 */

/**
 * Return `timeZone` if `Intl` will accept it, otherwise `undefined`.
 *
 * Not defensive noise. `Intl.DateTimeFormat` THROWS a RangeError on an unknown
 * zone identifier rather than degrading, and these values are free-form data we
 * did not mint (`Event.timezone`, `VolunteerCommitmentRecord.eventTimezone`).
 * One bad row would otherwise take a whole badge run — or a volunteer's only
 * copy of their check-in code — down at 6pm on a show night.
 *
 * `undefined` means "let Intl use the runtime's zone", i.e. the viewer's. That
 * loses precision, so every caller NAMES the zone it ended up using; a
 * wrong-looking hour then stays checkable on paper instead of being silently
 * authoritative.
 */
export const resolveDisplayTimeZone = (
  timeZone: string | null | undefined,
): string | undefined => {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
};

/**
 * Do two instants fall on the same calendar day in `timeZone`?
 *
 * Decides whether a shift window prints as "Fri 15 Aug · 5:00 – 10:00 PM" or
 * has to repeat the date on the far side. Overnight load-out shifts are
 * ordinary in this domain, and a document that reads "5:00 PM – 2:00 AM" under
 * a single date is wrong about which day the volunteer is expected.
 *
 * `en-CA` because it yields a zero-padded, lexicographically comparable
 * YYYY-MM-DD; the locale is an implementation detail of the comparison and
 * never reaches the page.
 */
export const isSameZonedDay = (
  a: Date,
  b: Date,
  timeZone: string | undefined,
): boolean => {
  const format = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  return format(a) === format(b);
};

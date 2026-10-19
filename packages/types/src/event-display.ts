/**
 * Shared event display data contract.
 *
 * This is the common data shape used by both the web `EventContent` component
 * and the email `EventDetails` template.  Each surface extends it with
 * renderer-specific props (ticket types, CTA labels, ProseMirror doc, etc.).
 *
 * By sharing this base type, adding a new common field (e.g. `isOnline`)
 * surfaces a compile-time change in both components simultaneously —
 * preventing the two from drifting apart.
 */

export interface EventDisplayData {
  /** Event title / headline. */
  title: string;

  /**
   * Event start date-time as an ISO-8601 string.
   *
   * ISO strings are the universal interchange format; each consumer can
   * parse to `Date` or pass directly to `formatEventDate`.
   */
  startsAtISO: string;

  /** Event end date-time as an ISO-8601 string (optional for open-ended events). */
  endsAtISO?: string;

  /** IANA timezone, e.g. `"America/Los_Angeles"`. */
  timezone?: string;

  /** Venue or location display name. */
  venueName?: string;

  /** Full address text (street + city + region). */
  addressText?: string;

  /** Hero / cover image URL. */
  heroImageUrl?: string;

  /** Canonical URL for the event page. */
  eventUrl?: string;

  /** Primary organizer display name. */
  organizerName?: string;
}

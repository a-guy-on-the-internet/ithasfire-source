// ─────────────────────────────────────────────────────────────────────────────
// Calendar row types shared by the dashboard briefing and the booking-hold pickers
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarEvent = {
  /** Unique event identifier. */
  id: string;
  title: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  status: string;
  /** Optional secondary label shown in the tooltip (e.g. "by Org Name"). */
  subtitle?: string | null;
  /** Event slug for building public URLs. */
  slug?: string | null;
  /** Venue / location text for iCal export. */
  location?: string | null;
  /** City name. */
  city?: string | null;
  /** Region / state. */
  region?: string | null;
  /** Series ID — events sharing a seriesId are displayed as a recurring group. */
  seriesId?: string | null;
  /** Series name (e.g. "Friday Night Jazz") — shown as the group label. */
  seriesName?: string | null;
  /**
   * Venue-confirmation spec (docs/specs/2026-08-27): `false` when a THIRD
   * PARTY listed this event at the venue and the venue has not confirmed it
   * (or withdrew). Renders with the unconfirmed treatment and never blocks —
   * the server already keeps it out of `conflicts`. Omitted/`true` = a
   * confirmed or venue-owned event, rendered as before. Only the admin venue
   * reads set this; every other consumer omits it.
   */
  venueConfirmed?: boolean;
  /**
   * `false` when someone OTHER than the venue owns this event (a third-party
   * listing, confirmed or not). Together with `venueConfirmed` it decides
   * whether the venue has an action on the chip: unconfirmed → Confirm /
   * Not mine; confirmed third-party → Withdraw confirmation. Omitted (or
   * `true`) = venue-owned, inert, rendered exactly as before.
   */
  venueOwned?: boolean;
};

/**
 * A LIVE booking hold on a calendar day (booking-holds spec 2026-08-25,
 * FR-014) — the admin overlay only. Date-level, never a time; never an event.
 * Supplied by `places.getVenueCalendar` (admin) and `calendars.getEvents`
 * (admin); every other consumer omits the prop and nothing renders.
 */
export type CalendarHold = {
  id: string;
  /**
   * Null for a hold with no request (holds-without-a-request FR-001): an
   * outside booker's or the place's own. It never matches a request's id.
   */
  bookingRequestId: string | null;
  calendarId: string;
  spaceId: string | null;
  /** Place-local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** 1-based place in the line for calendarId+date. */
  position: number;
  status: "ACTIVE" | "CHALLENGED" | "CONFIRMED" | "RELEASED";
  respondBy: Date | null;
  /** Server-side lazy-expiry projection — render as released. */
  lapsed: boolean;
  /** The request's pitched act name; null when the pitch carried none. */
  actName: string | null;
  /**
   * The sender's platform display name (human or org), resolved server-side;
   * the fallback when `actName` is blank. Null for anonymous senders or when
   * the lookup degraded.
   */
  performerDisplayName: string | null;
};

import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Normalized engine types (event-calendar-redesign, docs/specs/2026-09-02).
//
// The engine never calls tRPC. Each mount (dashboard, place, embed) maps its
// own payload onto these shapes, so the engine renders one contract and the
// mounts own the wire formats. Instants are `Date`s; the engine paints them
// in `timezone` (venue zone on place/embed, browser-local on dashboards) and
// flags the per-item mismatch against `viewerTimezone` (FR-013 / FR-018).
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarMode = "internal" | "public";

export type CalendarView = "month" | "week" | "agenda";

export type CalendarEventStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "COMPLETED"
  | "CANCELLED";

export type CalendarHoldStatus = "ACTIVE" | "CHALLENGED" | "CONFIRMED";

export type CalendarItemHrefs = {
  /** Event editor (single event). */
  edit?: string;
  /** Public event page. */
  public?: string;
  /** Series editor — Edit on a series occurrence goes here (FR-014). */
  series?: string;
  /** The booking thread behind a venue-side event (place peek's "Open booking"). */
  booking?: string;
};

export type CalendarEventItem = {
  kind: "event";
  /** Unique per rendered chip — an expanded EventDate occurrence has its own id. */
  id: string;
  /** The parent Event id (shared by every occurrence of a multi-date listing). */
  eventId: string;
  title: string;
  status: CalendarEventStatus;
  startsAt: Date;
  endsAt: Date | null;
  /** The event's stored IANA zone (`Event.timezone`). */
  timezone: string;
  venueName?: string;
  ownerName?: string;
  /** Owner filter key (org id / human id) — matches `CalendarFilters.owners`. */
  ownerKey?: string;
  seriesId?: string;
  seriesName?: string;
  /** "Date N of M" for EventDate-expanded community listings (FR-003). */
  occurrence?: { index: number; total: number } | null;
  ticketsSold?: number | null;
  totalCapacity?: number | null;
  /**
   * Venue-confirmation spec (docs/specs/2026-08-27): `false` only when a
   * third-party listing at the venue is unconfirmed. Omitted/`true` renders
   * as a confirmed chip.
   */
  venueConfirmed?: boolean;
  /** Double-booked with another event in the same space (place mount). */
  conflict?: boolean;
  /** Public-mode dimming (FR-022). Derived from sold/capacity when omitted. */
  soldOut?: boolean;
  /**
   * Ready-to-paint price copy ("$25", "From $15", "Free") — FR-023. The
   * WEEK view alone renders it, and only when the block is tall and wide
   * enough to carry a third line; month chips, the agenda, the dot grid and
   * the day list never show price on any surface. Null / omitted renders
   * nothing at all (no empty line). Formatting is the MOUNT's job — the
   * engine never sees cents or a currency code.
   */
  priceLabel?: string | null;
  href?: CalendarItemHrefs;
};

export type CalendarHoldLineMate = {
  position: number;
  title: string;
  status: CalendarHoldStatus;
  respondBy?: Date | null;
  /** When the hold was placed — the muted sub-line when not challenged. */
  placedAt?: Date | null;
};

export type CalendarHoldItem = {
  kind: "hold";
  id: string;
  /** The act / org name on the hold. */
  title: string;
  /** 1-based place in the line for that calendar + date. */
  position: number;
  status: CalendarHoldStatus;
  respondBy?: Date | null;
  placedAt?: Date | null;
  /** Holds are date-level: local midnight of the held day, `endsAt` null. */
  startsAt: Date;
  endsAt: Date | null;
  venueName?: string;
  spaceName?: string;
  /** The booking thread — the ONLY action a hold peek offers (FR-014). */
  bookingHref?: string;
  /** The whole line for that date, this hold included, in position order. */
  lineMates?: CalendarHoldLineMate[];
};

export type CalendarItem = CalendarEventItem | CalendarHoldItem;

export type CalendarFilters = {
  statuses: Set<CalendarEventStatus>;
  /** Absent = every owner. */
  owners?: Set<string>;
  /** Absent or `"all"` = every series (and non-series events). */
  seriesId?: string | "all";
  /** Absent = holds shown. */
  showHolds?: boolean;
};

export type CalendarFilterOptions = {
  /** Owner chips render only when more than one owner is listed. */
  owners?: Array<{ key: string; label: string }>;
  series?: Array<{ id: string; name: string }>;
  /** Render the Holds chip (internal dashboards and the place calendar). */
  holds?: boolean;
  /**
   * The mount's neutral filter state. Only the collapsed "Filters · {n}"
   * badge reads it — without it the neutral is "everything on", which would
   * count a mount that hides CANCELLED by default as permanently narrowed.
   */
  defaults?: Pick<CalendarFilters, "statuses" | "showHolds">;
};

/**
 * One window per visible weekday, positional with `getWeekDays` — the shape
 * `computeHoursWindow` (core) returns. `endMinutes` may exceed 1440 when the
 * night crosses midnight. `null` = no hours that day.
 */
export type HoursWindow = Array<{
  startMinutes: number;
  endMinutes: number;
} | null>;

export type CalendarOverflowAction = {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
};

/**
 * A painted calendar day in the engine's paint zone. `start` is the instant
 * of local midnight; `end` the next local midnight (exclusive).
 */
export type CalendarDay = {
  /** `YYYY-MM-DD` in the paint zone. */
  key: string;
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  start: Date;
  end: Date;
};

/** The one-of-two peek variants (FR-014): the place variant adds owner + booking. */
export type CalendarPeekVariant = "dashboard" | "place";

import type { SpaceRow } from "./spaces";

/**
 * Calendar — a named, public-facing programming stream of a Place ("Social
 * Club", "Drkmttr Live Music") that owns availability windows and scheduling
 * defaults, joined M:N to Spaces via CalendarSpace (venue-hierarchy FR-003;
 * docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml). Calendar
 * rendering filters on `Event.calendarId` — NEVER via the space join (FR-005:
 * a shared space must not bleed one stream's events onto another's calendar).
 */
export interface CalendarRow {
  id: string;
  /**
   * Always surfaced so every caller can assert `calendar.placeId === expected`
   * inside its transaction — the schema does not stop joining org A's
   * calendar to org B's space; cross-place isolation is enforced in core (same
   * rationale as {@link SpaceRow.placeId}).
   */
  placeId: string;
  name: string;
  /** Unique per (placeId, slug) — see `CalendarsRepo.create` for the P2002 note. */
  slug: string;
  description: string | null;
  /** At most one default calendar per place (SQL-only partial unique index). */
  isDefault: boolean;
  /**
   * The ACTIVE Space this calendar is GUARANTEED to have — the
   * ≥1-active-space-per-calendar invariant, as a database constraint (owner
   * ruling 2026-09-24; migration 20260924120000_calendar_primary_space).
   *
   * NOT NULL, and a composite FK `(primarySpaceId, primarySpaceStatus) →
   * Space(id, status)` plus a CHECK pinning the status mirror to `ACTIVE` mean
   * a Calendar cannot exist without an ACTIVE space, and a Space that is some
   * calendar's primary cannot be retired. That is the engine's promise, not the
   * application's — see packages/db/prisma/venue.prisma.
   *
   * NOT guaranteed declaratively: that this space is among the calendar's own
   * `CalendarSpace` joins. That stays a use-case obligation (a second composite
   * FK would be circular with CalendarSpace's own FK) — see
   * packages/core/src/use-cases/places/_shared/calendar-active-space.ts.
   */
  primarySpaceId: string;
  /**
   * Wall-clock default start time ("HH:mm") for events created on this
   * calendar. Resolved through `Place.timezone` (FR-004) — never a timestamp.
   */
  defaultStartTime: string | null;
  defaultCategoryId: string | null;
  /**
   * Prefill defaults for events minted from this calendar (quick-create /
   * FR-009 title template). Free-form Json blob — no rich template editor in
   * v1.
   *
   * The column is Prisma `Json?`, which also admits arrays and scalars — the
   * Step-5 row mapper MUST guard non-object JSON to `null` (typeof check +
   * Array.isArray), never `as`-cast the Prisma value into this shape.
   */
  eventTemplate: Record<string, unknown> | null;
  // ── Booking config layer (venue-confirmation-and-booking-intents spec,
  // docs/specs/2026-08-27). The Calendar is the CONFIG layer: which intents
  // it accepts, a flat rental rate per booking, whether that rate is public.
  // The SPACE is what a booking blocks — never the calendar.
  /** Accepts PERFORM (pitch a show) requests. Default true preserves today. */
  acceptsPerform: boolean;
  /** Accepts RENT requests (hire a space for a window). */
  acceptsRent: boolean;
  /** Accepts USE requests (non-transactional use of a space). */
  acceptsUse: boolean;
  /** Flat rental rate per booking, integer minor units. Null = no stated rate. */
  rentalRateCents: number | null;
  /** ISO 4217 for `rentalRateCents`. */
  rentalRateCurrency: string | null;
  /** Whether the rate is shown on the public request form. */
  rentalRateVisible: boolean;
  /** REQUEST for this spec; INSTANT is RESERVED (own spec, never UI-selectable). */
  rentalMode: RentalMode;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors the Prisma `RentalMode` enum as a string union. */
export type RentalMode = "REQUEST" | "INSTANT";

/** The intent toggles + rental rate a calendar can be created/patched with. */
export interface CalendarBookingConfigInput {
  acceptsPerform?: boolean;
  acceptsRent?: boolean;
  acceptsUse?: boolean;
  rentalRateCents?: number | null;
  rentalRateCurrency?: string | null;
  rentalRateVisible?: boolean;
  rentalMode?: RentalMode;
}

export interface CalendarWithSpacesRow extends CalendarRow {
  /**
   * Spaces joined via CalendarSpace, sortOrder asc. Physical data stays on the
   * space. Posture (deliberate — Step 5 implements it as stated): the adapter
   * returns ALL joined spaces INCLUDING `RETIRED` ones; callers filter by
   * `space.status` when rendering pickers. Admin/edit surfaces need to see the
   * retired joins to explain history and to un-join them.
   */
  spaces: SpaceRow[];
}

/**
 * Availability window / blackout for a place's calendars (FR-007): weekly
 * windows (dayOfWeek) + specific-date exceptions, with an isOpen flag. The only
 * availability shape there is — the Place-level predecessor was dropped on
 * 2026-08-21.
 */
export interface CalendarAvailabilityRow {
  id: string;
  placeId: string;
  /**
   * NULL = PLACE-WIDE row: applies to EVERY calendar of the place (venue
   * closed = one blackout row, not N copies). `placeId` is always required so
   * place-wide and per-calendar rows share one query path.
   */
  calendarId: string | null;
  /** 0=Sun..6=Sat; null = specific date only. */
  dayOfWeek: number | null;
  /** Specific date; null = recurring weekday. */
  date: Date | null;
  /** "19:00" wall-clock in `Place.timezone`. */
  startTime: string | null;
  /** "23:00" wall-clock in `Place.timezone`. */
  endTime: string | null;
  /** false = explicitly blocked (blackout). */
  isOpen: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCalendarInput extends CalendarBookingConfigInput {
  placeId: string;
  name: string;
  slug: string;
  description?: string | null;
  isDefault?: boolean;
  defaultStartTime?: string | null;
  defaultCategoryId?: string | null;
  eventTemplate?: Record<string, unknown> | null;
  /**
   * Spaces joined at create, in the SAME transaction as the calendar row.
   * REQUIRED, min 1 — every calendar has ≥1 space (venue-confirmation spec);
   * the adapter throws `{ code: "calendar_requires_space" }` on an empty set.
   * Same-place isolation of every id is the CALLER's (core) obligation.
   */
  spaceIds: string[];
  /**
   * The calendar's PRIMARY space — see {@link CalendarRow.primarySpaceId}.
   * REQUIRED and explicit rather than derived from `spaceIds[0]`: the column is
   * FK-constrained to an ACTIVE Space, so which member of the set this is is a
   * decision with a failure mode, and a silent `[0]` would make an all-retired
   * head of the array fail at the FK instead of at the caller's own guard.
   * MUST be a member of `spaceIds` and MUST be ACTIVE — both are the caller's
   * obligation; the DB enforces the ACTIVE half and nothing enforces the
   * membership half (see {@link CalendarRow.primarySpaceId}).
   */
  primarySpaceId: string;
}

/** Partial patch — omitted fields are left untouched. */
export interface UpdateCalendarInput extends CalendarBookingConfigInput {
  id: string;
  name?: string;
  slug?: string;
  description?: string | null;
  isDefault?: boolean;
  defaultStartTime?: string | null;
  defaultCategoryId?: string | null;
  eventTemplate?: Record<string, unknown> | null;
}

/**
 * FULL replacement of a calendar's CalendarSpace join set, plus the primary
 * that set implies. The primary travels WITH the set because the two must
 * change atomically: a replacement that dropped the current primary and left
 * the column pointing at an un-joined space is exactly the drift the
 * ≥1-active-space invariant is about (see `CalendarsRepo.setSpaces`).
 */
export interface SetCalendarSpacesInput {
  calendarId: string;
  /** Min 1 — an empty set throws `{ code: "calendar_requires_space" }`. */
  spaceIds: string[];
  /**
   * MUST be a member of `spaceIds` and MUST be ACTIVE (caller's obligation;
   * the DB enforces the ACTIVE half). Written UNCONDITIONALLY, even when
   * unchanged — see `CalendarsRepo.setSpaces` for why that write is
   * load-bearing under concurrency.
   */
  primarySpaceId: string;
}

/**
 * Repoint one calendar's primary space — the auto-promotion `setSpaceStatus`
 * performs when the room being retired is some calendar's primary but that
 * calendar has another ACTIVE room to fall back to.
 */
export interface SetCalendarPrimarySpaceInput {
  calendarId: string;
  /** The new primary. MUST be ACTIVE (the FK refuses anything else). */
  spaceId: string;
}

/**
 * Create-or-update for one availability row. `id` present = update that row
 * (its placeId/calendarId scoping must not change); absent = create.
 */
export interface UpsertCalendarAvailabilityInput {
  id?: string;
  placeId: string;
  /** Omitted/null = place-wide row (see {@link CalendarAvailabilityRow.calendarId}). */
  calendarId?: string | null;
  dayOfWeek?: number | null;
  date?: Date | null;
  startTime?: string | null;
  endTime?: string | null;
  isOpen?: boolean;
  note?: string | null;
}

/**
 * Delete one availability row. `placeId` is REQUIRED and goes in the
 * adapter's WHERE clause — the delete only lands when the row belongs to that
 * place, so a forged/leaked row id from another place matches zero rows (IDOR
 * backstop; see `CalendarsRepo.deleteAvailability`).
 */
export interface DeleteCalendarAvailabilityInput {
  id: string;
  placeId: string;
}

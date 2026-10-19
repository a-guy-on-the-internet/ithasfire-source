import type {
  CalendarAvailabilityRow,
  CalendarBookingConfigInput,
  CalendarRow,
  CalendarWithSpacesRow,
  CreateCalendarInput,
  DeleteCalendarAvailabilityInput,
  RentalMode,
  SetCalendarPrimarySpaceInput,
  SetCalendarSpacesInput,
  UpdateCalendarInput,
  UpsertCalendarAvailabilityInput,
} from "@th/types/repos/calendars";

/**
 * Calendars — a Place's named programming streams plus their availability
 * windows (venue-hierarchy FR-003/FR-007). Calendars join M:N onto Spaces via
 * CalendarSpace; event rendering filters on `Event.calendarId`, never the space
 * join (FR-005).
 */
export interface CalendarsRepo {
  /**
   * A place's calendars with their joined spaces. Default first, then name asc.
   *
   * Each row's `spaces` carries ALL joined spaces INCLUDING RETIRED ones, each
   * with its `status` — see {@link CalendarWithSpacesRow.spaces}, where that
   * posture and its rationale live. Callers filter. `setSpaceStatus`'s
   * ≥1-active-space-per-calendar guard depends on the retired ones being
   * present: an ACTIVE-only read would make every already-stranded calendar
   * look like a fresh blocker.
   */
  listByPlace(placeId: string): Promise<CalendarWithSpacesRow[]>;
  /**
   * The SAME read across many places in ONE query — for owner-level surfaces
   * that span a whole venue portfolio.
   *
   * `listByPlace` in a loop is the alternative, and the owned-place ceiling is
   * 100, so that loop is a 100-query fan-out on a page load. Ordering is
   * (placeId asc, default first, name asc) so a caller can group by place
   * without re-sorting. An empty `placeIds` returns `[]` without querying.
   */
  listByPlaceIds(placeIds: string[]): Promise<CalendarWithSpacesRow[]>;
  /**
   * The returned row carries `placeId` — every caller MUST be able to assert
   * `calendar.placeId === expectedPlaceId` inside its transaction (cross-place
   * isolation is a core-layer invariant; the schema does not stop joining one
   * org's calendar to another org's space).
   */
  findById(id: string): Promise<CalendarRow | null>;
  /** The place's `isDefault` calendar, if any (at most one — see `create`). */
  findDefaultForPlace(placeId: string): Promise<CalendarRow | null>;
  /**
   * Two SQL-only partial/composite uniques surface here as P2002, and the
   * adapter (Step 5) must map BOTH by index name:
   * - "Calendar_placeId_default_key" on (placeId) WHERE "isDefault" — the
   *   one-default-calendar-per-place rule (migration
   *   20260818120000_venue_hierarchy_rooms_calendars; Prisma can't express
   *   partial indexes). A racing second default loses here.
   * - the `@@unique([placeId, slug])` slug collision.
   *
   * EVERY CALENDAR HAS ≥1 SPACE (venue-confirmation spec): `spaceIds` is
   * required and the CalendarSpace joins are written in the SAME transaction
   * as the calendar row. An empty `spaceIds` throws the typed error
   * `{ code: "calendar_requires_space" }` BEFORE any row is written. Same-
   * place isolation of every space id is the use case's obligation.
   * Also persists the booking config fields ({@link CalendarBookingConfigInput});
   * omitted ones take the column defaults (PERFORM only, no rate, REQUEST).
   *
   * `primarySpaceId` is REQUIRED and FK-constrained to an ACTIVE Space (owner
   * ruling 2026-09-24). A value that names a RETIRED space — or one retired by
   * a transaction that commits while this one is open — violates
   * "Calendar_primarySpaceId_primarySpaceStatus_fkey"; the adapter maps that to
   * the typed `CALENDAR_REQUIRES_ACTIVE_SPACE` so the raw Postgres wording
   * never reaches a venue admin.
   */
  create(input: CreateCalendarInput): Promise<CalendarRow>;
  /**
   * Partial patch — omitted fields untouched. Same P2002 mappings as `create`.
   * Accepts the booking config fields; `rentalMode: "INSTANT"` is storable
   * but the use case must never offer it (RESERVED — own spec).
   */
  update(input: UpdateCalendarInput): Promise<CalendarRow>;
  /**
   * FULL replacement of the calendar's CalendarSpace joins: rows for ids not
   * in `spaceIds` are removed, missing ones are created. Space/place isolation
   * (every space belongs to the calendar's place) is asserted by the use case
   * BEFORE calling this — the join table has no cross-place guard.
   *
   * REFUSES an empty `spaceIds` with `{ code: "calendar_requires_space" }`
   * (every calendar has ≥1 space). NOTE the availability code still
   * tolerates a calendar whose join set is empty on READ (stale rows written
   * before the invariant, or a space deleted out from under a calendar) —
   * that read-side tolerance is deliberate and stays; only the WRITE refuses.
   *
   * ATOMICITY: the full replacement (delete + create) is atomic — no reader
   * may observe the join set half-replaced. When invoked inside `repos.tx()`
   * (the standard mutation path) the surrounding transaction provides this;
   * an adapter opens its OWN transaction only when constructed on a root
   * (non-transactional) client.
   *
   * ALSO WRITES `Calendar.primarySpaceId`, unconditionally, in the same
   * transaction. Two reasons, both load-bearing:
   *
   *   1. CORRECTNESS. The primary is FK-pinned to an ACTIVE Space but NOT to
   *      the calendar's own join set (see {@link CalendarRow.primarySpaceId}).
   *      A replacement that dropped the old primary without repointing would
   *      leave the column naming a room the calendar no longer serves — the
   *      invariant's remaining hole, and the caller's job to avoid.
   *   2. SERIALIZATION. Writing the Calendar row takes its row lock, which is
   *      what a concurrent `setSpaceStatus` collides with when it tries to
   *      auto-promote that same calendar. Skipping the write when the primary
   *      is unchanged would silently reopen the 2026-09-23 race: the retire
   *      would promote to a space this call is in the middle of un-joining,
   *      see no conflict, and commit a calendar whose join set is entirely
   *      retired. Measured, not argued — see
   *      test/integration/calendar-primary-space-race.test.ts.
   *
   * The FK violation (a primary retired by a racing transaction) is mapped to
   * the typed `CALENDAR_REQUIRES_ACTIVE_SPACE`, same as `create`.
   */
  setSpaces(input: SetCalendarSpacesInput): Promise<void>;
  /**
   * Repoint ONE calendar's primary space, leaving the join set alone — the
   * auto-promotion in `setSpaceStatus`: the room being retired is this
   * calendar's primary, and the calendar has another ACTIVE room, so the
   * primary moves instead of the retire being refused.
   *
   * Takes the Calendar row's lock, so it serializes against a concurrent
   * `setSpaces` on the same calendar. Does NOT validate joined-ness or
   * ACTIVE-ness itself: the FK refuses a retired target, and the caller is
   * responsible for choosing a joined one (and for re-reading afterwards — see
   * `setSpaceStatus`).
   */
  setPrimarySpace(input: SetCalendarPrimarySpaceInput): Promise<void>;
  /**
   * Calendar count — backs the ≥1-calendar-per-place invariant for future
   * calendar archival. No destructive use case consumes it yet.
   */
  countForPlace(placeId: string): Promise<number>;
  /**
   * COUNT of the place's CalendarAvailability rows — place-wide
   * (`calendarId` null) AND calendar-scoped together, exactly the rows
   * `listAvailabilityForPlace` returns. Zero = the place is UNCONFIGURED
   * (availability-onboarding spec, 2026-08-31): every day computes `closed`,
   * so public booking surfaces treat the venue as not taking requests. A
   * count (not a list-and-measure) because the detector also runs on public
   * mutation paths (createBookingRequest / createBookingInquiry).
   */
  countAvailabilityForPlace(placeId: string): Promise<number>;
  /**
   * ALL availability rows for the place — both calendar-scoped rows AND
   * place-wide rows (`calendarId` null applies to every calendar; see
   * {@link CalendarAvailabilityRow.calendarId}). One query path on purpose:
   * consumers always need the merged view.
   */
  listAvailabilityForPlace(placeId: string): Promise<CalendarAvailabilityRow[]>;
  /** Create (`id` absent) or update (`id` present) one availability row. */
  upsertAvailability(
    input: UpsertCalendarAvailabilityInput,
  ): Promise<CalendarAvailabilityRow>;
  /**
   * Delete one availability row. The adapter (Step 5) MUST implement this as
   * a `deleteMany` with BOTH `id` AND `placeId` in the WHERE clause — the
   * placeId scope in the WHERE (not a separate read-then-check) is the IDOR
   * backstop: a forged/leaked row id from another place matches zero rows.
   * Zero rows matched = silent no-op (deletes are idempotent).
   */
  deleteAvailability(input: DeleteCalendarAvailabilityInput): Promise<void>;
}

export type {
  CalendarAvailabilityRow,
  CalendarBookingConfigInput,
  CalendarRow,
  CalendarWithSpacesRow,
  CreateCalendarInput,
  DeleteCalendarAvailabilityInput,
  RentalMode,
  SetCalendarPrimarySpaceInput,
  SetCalendarSpacesInput,
  UpdateCalendarInput,
  UpsertCalendarAvailabilityInput,
} from "@th/types/repos/calendars";

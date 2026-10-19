/**
 * Space — the concrete physical resource conflicts resolve to (venue-hierarchy
 * FR-001; docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml). Always a
 * child of Place, NEVER of Calendar; physical attributes (capacity, tech
 * specs) live here and only here. Calendars join M:N onto spaces via
 * CalendarSpace (see repos/calendars).
 */

/**
 * Lifecycle of a Space. RETIRED spaces are hidden from scheduling but kept for
 * history — a Place can never reach zero ACTIVE spaces (use-case invariant,
 * supported by `SpacesRepo.countActiveForPlace`).
 */
export type SpaceStatus = "ACTIVE" | "RETIRED";

export interface SpaceRow {
  id: string;
  /**
   * Always surfaced so every caller can assert `space.placeId === expected`
   * inside its transaction. The SCHEMA does not stop joining org A's calendar
   * to org B's space — cross-place isolation is enforced in core, and it can
   * only be enforced if the row carries its owning place.
   */
  placeId: string;
  name: string;
  capacity: number | null;
  /** Manual ordering for space pickers / editor lists. Ascending. */
  sortOrder: number;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSpaceInput {
  placeId: string;
  name: string;
  capacity?: number | null;
  sortOrder?: number;
}

/** Partial patch — omitted fields are left untouched. */
export interface UpdateSpaceInput {
  id: string;
  name?: string;
  capacity?: number | null;
  sortOrder?: number;
}

export interface ListSpacesByPlaceInput {
  placeId: string;
  /**
   * Include RETIRED spaces (history / admin views). Defaults to false —
   * scheduling surfaces only ever see ACTIVE spaces.
   */
  includeRetired?: boolean;
}

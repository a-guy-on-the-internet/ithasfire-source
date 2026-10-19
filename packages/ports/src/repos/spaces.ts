import type {
  CreateSpaceInput,
  ListSpacesByPlaceInput,
  SpaceRow,
  SpaceStatus,
  UpdateSpaceInput,
} from "@th/types/repos/spaces";

/**
 * Spaces of a Place (venue-hierarchy FR-001). Spaces are the physical resources
 * calendars schedule into; they are retired, never hard-deleted — a Space
 * delete would cascade CalendarSpace rows and silently leave calendars
 * spaceless, so this port deliberately exposes NO delete method.
 */
export interface SpacesRepo {
  /**
   * A place's spaces, sortOrder asc (then createdAt asc as tiebreak). ACTIVE
   * only unless `includeRetired` is set.
   */
  listByPlace(input: ListSpacesByPlaceInput): Promise<SpaceRow[]>;
  /**
   * The returned row carries `placeId` — every caller MUST be able to assert
   * `space.placeId === expectedPlaceId` inside its transaction (cross-place
   * isolation is a core-layer invariant; the schema does not stop joining one
   * org's calendar to another org's space).
   */
  findById(id: string): Promise<SpaceRow | null>;
  /**
   * Batch twin of {@link findById}: rows for every id that exists, in no
   * guaranteed order (callers index by id). Unknown ids are simply absent —
   * never an error — so a caller asserting cross-place isolation treats a
   * missing id exactly like a foreign one. An empty `ids` array resolves to
   * `[]` without touching the DB.
   */
  findByIds(ids: readonly string[]): Promise<SpaceRow[]>;
  create(input: CreateSpaceInput): Promise<SpaceRow>;
  /** Partial patch — omitted fields untouched. */
  update(input: UpdateSpaceInput): Promise<SpaceRow>;
  /**
   * Retire / reactivate — the ONLY way a space leaves scheduling. Never a hard
   * delete (see the interface doc). The ≥1-active-space-per-place invariant is
   * enforced by the use case via {@link countActiveForPlace}, not here.
   */
  setStatus(input: { id: string; status: SpaceStatus }): Promise<SpaceRow>;
  /**
   * Count of ACTIVE spaces — supports the ≥1-active-space-per-place invariant
   * check inside the retire use case's transaction.
   *
   * NOTE the sibling ≥1-active-space-per-CALENDAR invariant is NOT checked with
   * a counter and no longer needs a lock. It is a DATABASE CONSTRAINT as of
   * 2026-09-24 (`Calendar.primarySpaceId`, a composite FK onto
   * `Space(id, status)` plus a CHECK pinning the status to ACTIVE — see
   * packages/db/prisma/venue.prisma). Retiring a space that is some calendar's
   * primary fails the FK, and the FK's row locks serialize a retire against a
   * concurrent space reassignment, which is why the place-scoped
   * `pg_advisory_xact_lock` this port used to expose
   * (`lockCalendarSpaceGuard`) was DELETED rather than kept alongside: two
   * mechanisms for one invariant, one of them bypassable by any writer that
   * forgets it.
   */
  countActiveForPlace(placeId: string): Promise<number>;
}

export type {
  CreateSpaceInput,
  ListSpacesByPlaceInput,
  SpaceRow,
  SpaceStatus,
  UpdateSpaceInput,
} from "@th/types/repos/spaces";

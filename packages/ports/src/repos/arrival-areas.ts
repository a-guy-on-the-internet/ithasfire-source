import type {
  ArrivalAreaHidePair,
  ArrivalAreaParent,
  ArrivalAreaRow,
  CreateArrivalAreaInput,
  DeleteArrivalAreaResult,
  ReorderArrivalAreasResult,
  UpdateArrivalAreaPatch,
  UpdateArrivalAreaResult,
} from "@th/types/repos/arrival-areas";

/**
 * Arrival areas of a place or an event, and an event's hides of its place's
 * areas (arrival-areas spec, 2026-10-16). Row mechanics only: authorization,
 * the 10-per-parent limit, geometry validation (FR-005) and audit rows
 * (FR-013) are core's. Areas are hard-deleted (the audit row keeps the
 * before payload) and CASCADE with their parent.
 */
export interface ArrivalAreasRepo {
  /** A place's areas, sortOrder asc then createdAt asc. Disabled included. */
  listForPlace(placeId: string): Promise<ArrivalAreaRow[]>;
  /**
   * Batch twin of {@link listForPlace} (place-merge preview, FR-012): every
   * area of every given place, ordered by placeId then sortOrder then
   * createdAt. An empty `placeIds` resolves to `[]` without touching the DB.
   */
  listForPlaces(placeIds: readonly string[]): Promise<ArrivalAreaRow[]>;
  /**
   * An event's event-only areas, sortOrder asc then createdAt asc. Disabled
   * included (the editor shows them as switched off, FR-014); the public read
   * filters `disabledAt`. Place areas shown on the event are NOT here: read
   * them with {@link listForPlace} minus {@link listHidesForEvent}.
   */
  listForEvent(eventId: string): Promise<ArrivalAreaRow[]>;
  /**
   * Place-merge preview (FR-012 / FR-014): the event-only areas of every
   * event whose `placeId` is `placeId`, ordered by eventId then sortOrder
   * then createdAt. Disabled included. The events are the ones a merge of
   * this place would repoint.
   */
  listEventAreasAtPlace(placeId: string): Promise<ArrivalAreaRow[]>;
  /**
   * The event-only areas of exactly the given events, ordered by eventId then
   * sortOrder then createdAt. Disabled included. Chunked like
   * {@link deleteHidesForEventsNotInPlace}, so the number of events is not
   * bounded by the bind-parameter limit. Duplicate ids are read once; an
   * empty `eventIds` resolves to `[]` without touching the DB.
   */
  listForEvents(eventIds: readonly string[]): Promise<ArrivalAreaRow[]>;
  /**
   * The returned row carries its parent ids; every caller MUST assert the
   * parent is the one it authorized before acting on it.
   */
  getById(id: string): Promise<ArrivalAreaRow | null>;
  /**
   * Batch twin of {@link getById}: one query, missing ids omitted, no order
   * promised (callers key by id). Same parent-assertion duty as getById. An
   * empty `ids` resolves to `[]` without touching the DB.
   */
  getByIds(ids: readonly string[]): Promise<ArrivalAreaRow[]>;
  /** Every area of the place, disabled included (the FR-005 limit counts rows). */
  countForPlace(placeId: string): Promise<number>;
  /** Every event-only area of the event, disabled included. */
  countForEvent(eventId: string): Promise<number>;
  /**
   * `SELECT … FOR NO KEY UPDATE` on the parent Place / Event row, so a create
   * can count then insert without a second create racing past the 10-area
   * limit (FR-005). NO KEY UPDATE, not UPDATE: it serialises lockParent
   * callers against each other but does not block the FOR KEY SHARE that
   * every FK child insert (an order or ticket on the event, an event at the
   * place) takes. Only means something INSIDE `repos.tx(...)`: outside one the
   * lock is released as the statement ends. Resolves `false` when the parent
   * row does not exist (nothing locked).
   */
  lockParent(parent: ArrivalAreaParent): Promise<boolean>;
  create(input: CreateArrivalAreaInput): Promise<ArrivalAreaRow>;
  /**
   * Compare-and-set on `id AND updatedAt = expectedUpdatedAt` (NFR-004). A
   * stale token writes nothing and returns `conflict` with the current row;
   * a missing id returns `not_found`. On success `updatedAt` moves to now,
   * and always strictly past `expectedUpdatedAt` (a same-millisecond write or
   * a lagging clock cannot leave the token unchanged).
   */
  update(
    id: string,
    patch: UpdateArrivalAreaPatch,
    options: { expectedUpdatedAt: Date },
  ): Promise<UpdateArrivalAreaResult>;
  /**
   * Hard delete under the same compare-and-set as {@link update}. On success
   * returns the row as deleted, for the audit row's before payload. The hides
   * pointing at it go with it (FK CASCADE). Call inside `repos.tx(...)` after
   * {@link lockParent}: {@link reorder} does not move `updatedAt`, so without
   * the lock a concurrent reorder could leave the before payload's
   * `sortOrder` stale.
   */
  delete(
    id: string,
    options: { expectedUpdatedAt: Date },
  ): Promise<DeleteArrivalAreaResult>;
  /**
   * Set `sortOrder` to 0..n-1 in the order given. `orderedIds` must be EXACTLY
   * the parent's areas, each once; otherwise nothing is written and the result
   * is `mismatch` (a foreign id is never touched: every write is scoped by the
   * parent too). Does NOT move `updatedAt`: the order is not part of what an
   * open edit form saves, so a reorder in one tab must not turn a save in
   * another into a conflict. Call inside `repos.tx(...)` after
   * {@link lockParent} so the set compared is the set written.
   */
  reorder(
    parent: ArrivalAreaParent,
    orderedIds: readonly string[],
  ): Promise<ReorderArrivalAreasResult>;
  /**
   * Switch an event's event-only areas off (a Date) or back on (`null`)
   * (FR-014). Switching off touches only areas not already off, so the first
   * switch-off time is kept; switching on clears every one. Moves `updatedAt`
   * on the rows it changes, each strictly past its previous value. Resolves
   * the number of rows changed.
   */
  setDisabledForEvent(eventId: string, disabledAt: Date | null): Promise<number>;
  /** Ids of the place areas this event hides, oldest hide first (FR-004). */
  listHidesForEvent(eventId: string): Promise<string[]>;
  /**
   * Hide one place area on one event. Idempotent: resolves `true` when a hide
   * was written, `false` when it already existed. Does not check the area is
   * a place area of the event's place; core does.
   */
  hide(eventId: string, arrivalAreaId: string): Promise<boolean>;
  /** Idempotent: `true` when a hide was removed, `false` when there was none. */
  unhide(eventId: string, arrivalAreaId: string): Promise<boolean>;
  /**
   * Delete the event's hides whose area is not an area of `placeId` (every
   * hide when `placeId` is null): the event moved off the place those areas
   * belong to (FR-014). Returns the pairs deleted, for the audit rows.
   */
  deleteHidesForEventNotInPlace(
    eventId: string,
    placeId: string | null,
  ): Promise<ArrivalAreaHidePair[]>;
  /**
   * Batch twin of {@link deleteHidesForEventNotInPlace} for a place merge
   * (FR-012): every hide of the given events whose area is not an area of
   * `placeId`, in a bounded number of queries whatever the event count.
   * Returns the pairs deleted (eventId, then hide creation order), for the
   * audit rows. An empty `eventIds` resolves to `[]` without touching the DB.
   */
  deleteHidesForEventsNotInPlace(
    eventIds: readonly string[],
    placeId: string,
  ): Promise<ArrivalAreaHidePair[]>;
  /**
   * Place merge (FR-012): repoint every area of `fromPlaceId` at
   * `toPlaceId`, ids kept so event hides keep pointing at them, appended after
   * the target's areas in their existing order, each `updatedAt` moved
   * strictly past its previous value. Never delete-and-reinsert.
   * The 10-area limit is core's (the merge preview blocks first). Returns the
   * moved ids in their new order.
   */
  movePlaceAreas(fromPlaceId: string, toPlaceId: string): Promise<string[]>;
}

export type {
  ArrivalAreaCost,
  ArrivalAreaGeometry,
  ArrivalAreaHidePair,
  ArrivalAreaKind,
  ArrivalAreaParent,
  ArrivalAreaPosition,
  ArrivalAreaRow,
  CreateArrivalAreaInput,
  DeleteArrivalAreaResult,
  ReorderArrivalAreasResult,
  UpdateArrivalAreaPatch,
  UpdateArrivalAreaResult,
} from "@th/types/repos/arrival-areas";

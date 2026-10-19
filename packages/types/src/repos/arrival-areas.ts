/**
 * Arrival areas: parking, accessible drop-off and load-in shapes drawn on a
 * place's or an event's map (docs/specs/2026-10-16/arrival-areas.spec.yaml).
 * A row belongs to exactly one parent, a place or an event (DB CHECK
 * "ArrivalArea_parent_xor"). A place area shows on every event at the place
 * unless the event hides it (FR-004); an event area belongs to that event only.
 */

/** Mirrors the Prisma `ArrivalAreaKind` enum (FR-001). */
export type ArrivalAreaKind = "PARKING" | "ACCESSIBLE_DROP_OFF" | "LOAD_IN";

/**
 * Mirrors the Prisma `ArrivalAreaCost` enum (FR-001). UNKNOWN is the default:
 * a manager who has not said is never shown as FREE.
 */
export type ArrivalAreaCost = "FREE" | "PAID" | "UNKNOWN";

/** A GeoJSON position, `[lng, lat]` (RFC 7946 order). */
export type ArrivalAreaPosition = [number, number];

/**
 * The stored shape: a GeoJSON Polygon (a lot) or LineString (street parking).
 * Stored as Json; core validates it (FR-005) before it reaches the repo, so the
 * adapter only casts at the boundary.
 */
export type ArrivalAreaGeometry =
  | { type: "Polygon"; coordinates: ArrivalAreaPosition[][] }
  | { type: "LineString"; coordinates: ArrivalAreaPosition[] };

/**
 * The parent an area hangs off: a place (shown on every event there) or an
 * event (event-only). Exactly one key is set.
 */
export type ArrivalAreaParent =
  | { placeId: string; eventId?: never }
  | { eventId: string; placeId?: never };

export interface ArrivalAreaRow {
  id: string;
  /** Exactly one of `placeId` / `eventId` is non-null. */
  placeId: string | null;
  eventId: string | null;
  kind: ArrivalAreaKind;
  geometry: ArrivalAreaGeometry;
  label: string;
  cost: ArrivalAreaCost;
  priceText: string | null;
  note: string | null;
  accessibleSpots: boolean;
  /** Manager-set order within the parent, ascending. */
  sortOrder: number;
  /**
   * Set when the event changed place or address and this event area has not
   * been repositioned yet (FR-014). A disabled area is not shown.
   */
  disabledAt: Date | null;
  /** Null once the creator's account is deleted (FK SetNull). */
  createdByHumanId: string | null;
  createdAt: Date;
  /** The concurrency token update and delete carry (NFR-004). */
  updatedAt: Date;
}

export type CreateArrivalAreaInput = ArrivalAreaParent & {
  kind: ArrivalAreaKind;
  geometry: ArrivalAreaGeometry;
  label: string;
  cost?: ArrivalAreaCost;
  priceText?: string | null;
  note?: string | null;
  accessibleSpots?: boolean;
  sortOrder?: number;
  createdByHumanId?: string | null;
};

/**
 * Partial patch: omitted keys are untouched, an explicit `null` clears a
 * nullable column. The parent and the sort order are not patchable here
 * (reorder and the place merge own them). `disabledAt: null` is how a
 * reposition switches an event area back on (FR-014).
 */
export interface UpdateArrivalAreaPatch {
  kind?: ArrivalAreaKind;
  geometry?: ArrivalAreaGeometry;
  label?: string;
  cost?: ArrivalAreaCost;
  priceText?: string | null;
  note?: string | null;
  accessibleSpots?: boolean;
  disabledAt?: Date | null;
}

/**
 * Optimistic-concurrency result (NFR-004), shaped like the shared-note
 * `SetNoteResult`: a stale `expectedUpdatedAt` writes nothing and hands back
 * the row as it now is, so the editor can show it instead of overwriting.
 */
export type UpdateArrivalAreaResult =
  | { status: "updated"; row: ArrivalAreaRow }
  | { status: "conflict"; current: ArrivalAreaRow }
  | { status: "not_found" };

/** As {@link UpdateArrivalAreaResult}; `row` is the row as it was deleted. */
export type DeleteArrivalAreaResult =
  | { status: "deleted"; row: ArrivalAreaRow }
  | { status: "conflict"; current: ArrivalAreaRow }
  | { status: "not_found" };

/**
 * `mismatch`: the ids given are not exactly the parent's areas (one missing,
 * one extra or foreign, or a duplicate). Nothing is written; `currentIds` is
 * the parent's set in its stored order.
 */
export type ReorderArrivalAreasResult =
  | { status: "reordered"; rows: ArrivalAreaRow[] }
  | { status: "mismatch"; currentIds: string[] };

/** One event's hide of one place area (FR-004). */
export interface ArrivalAreaHidePair {
  eventId: string;
  arrivalAreaId: string;
}

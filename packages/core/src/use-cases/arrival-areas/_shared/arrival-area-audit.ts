import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

// ─────────────────────────────────────────────────────────────────────────────
// Audit rows for arrival areas (arrival-areas FR-013). One row per mutation,
// written in the mutation's transaction, with the actor and the before/after
// payload. The geometry IS in the payload: the AuditLog table is read only by
// platform staff (/platform/audit-log, `listAuditLogs`), which is where a
// moderator looks for what an area looked like before an edit or a delete.
// It is never in a logger line (NFR-002).
//
//   entity "arrival_area", entityId the area id:
//     arrival_area.created   data { before: null, after: row }
//     arrival_area.updated   data { before: row, after: row }
//     arrival_area.removed   data { before: row, after: null }  (kept after the hard delete)
//     arrival_area.moved_for_place_merge  data { before: row, after: row, mergedId, survivorId }
//   entity "place" | "event", entityId the parent id:
//     arrival_areas.reordered                      data { before: ids, after: ids }
//   entity "event", entityId the event id:
//     arrival_area.hidden / arrival_area.unhidden  data { arrivalAreaId, placeId }
//     arrival_areas.disabled_for_location_change   data { arrivalAreaIds, from, to }
//     arrival_area_hides.removed_for_location_change data { arrivalAreaIds, from, to }
// Every row's data carries `actorHumanId` (null for a system change). A row
// written by something other than the editor carries `via`: "place_merge"
// (FR-012) or "series_sync" (FR-015).
//
// Not audited on their own: the event hides that point at a PLACE area which
// is removed. They go by FK CASCADE with the area; the area's own
// `arrival_area.removed` row (before payload, id) is the record.
// ─────────────────────────────────────────────────────────────────────────────

export const ARRIVAL_AREA_AUDIT_ENTITY = "arrival_area";

export const ARRIVAL_AREA_AUDIT_ACTIONS = {
  created: "arrival_area.created",
  updated: "arrival_area.updated",
  removed: "arrival_area.removed",
  movedForPlaceMerge: "arrival_area.moved_for_place_merge",
  reordered: "arrival_areas.reordered",
  hidden: "arrival_area.hidden",
  unhidden: "arrival_area.unhidden",
  disabledForLocationChange: "arrival_areas.disabled_for_location_change",
  hidesRemovedForLocationChange:
    "arrival_area_hides.removed_for_location_change",
} as const;

/** The row as an audit payload: every field, dates as ISO strings. */
export function arrivalAreaAuditPayload(row: ArrivalAreaRow): Record<string, unknown> {
  return {
    id: row.id,
    placeId: row.placeId,
    eventId: row.eventId,
    kind: row.kind,
    label: row.label,
    cost: row.cost,
    priceText: row.priceText,
    note: row.note,
    accessibleSpots: row.accessibleSpots,
    sortOrder: row.sortOrder,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    geometry: row.geometry,
    updatedAt: row.updatedAt.toISOString(),
  };
}

import type { TxRepos } from "@th/ports/repos";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import {
  areaOutsideEnvelope,
  type ArrivalAreaPin,
} from "../../lib/arrival-areas/geometry";
import {
  ARRIVAL_AREA_AUDIT_ACTIONS,
  ARRIVAL_AREA_AUDIT_ENTITY,
  arrivalAreaAuditPayload,
} from "./_shared/arrival-area-audit";

// ─────────────────────────────────────────────────────────────────────────────
// Place merge and arrival areas (arrival-areas FR-012, FR-013, FR-014). Both
// run inside `mergePlaces`' transaction, under its Place row locks, and
// regardless of the `arrivalAreas` feature gate: the merged place's row is
// deleted at the end and its areas would otherwise CASCADE away.
//
// 1. `moveArrivalAreasForPlaceMerge`: the merged place's areas move to the
//    survivor by UPDATE (ids kept), BEFORE the merged row is deleted. Event
//    hides point at area ids, so a hide of a moved area keeps pointing at it.
//    One `arrival_area.moved_for_place_merge` audit row per area.
//
// 2. `onEventsMovedByPlaceMerge`: the events the merge moved from the merged
//    place to the survivor. A merge says the two rows were ONE real place,
//    so this is not FR-014's "the event changed place": the event is where it
//    always was. What can change is the pin the event's areas are measured
//    from (the survivor's, not the duplicate's). So, for the moved events
//    (one read and one batched hide delete, never a query per event):
//      · its event-only areas outside 3 km of the survivor's pin are
//        switched off (`disabledAt`), the FR-014 envelope rule for a moved
//        pin; the ones inside stay on (a shape is never moved, and an area
//        that still fits is not switched off for nothing);
//      · its hides are cleaned against the survivor (the batched twin of
//        `removeHidesNotInPlace`, one query for every moved event).
//        Run after the move, every hide of a moved area is now a hide of a
//        survivor area and stays (FR-012); only a hide no area of the
//        survivor backs would go.
//    Never logs (NFR-002); audit rows carry ids, and the geometry where the
//    area audit rows always carry it.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_MERGE_VIA = "place_merge";

/**
 * The event-only areas a place merge switches off: switched on, and outside
 * 3 km of the survivor's pin (all of them when it has none; FR-014 flags a
 * shape it cannot show to be inside). The ONE rule, shared by the merge
 * preview's warning (`readPlaceMergePlan`) and the merge itself
 * (`onEventsMovedByPlaceMerge`), so the two cannot disagree.
 */
export function eventAreasOutsideSurvivorPin(
  rows: readonly ArrivalAreaRow[],
  survivorPin: ArrivalAreaPin | null,
): ArrivalAreaRow[] {
  return rows.filter(
    (row) =>
      row.eventId !== null &&
      row.disabledAt === null &&
      areaOutsideEnvelope(row, survivorPin),
  );
}

type MergeTx = Pick<TxRepos, "arrivalAreas" | "audit">;

export type MoveArrivalAreasForPlaceMergeResult = {
  /** The moved ids, in their new order on the survivor. */
  movedIds: string[];
};

export async function moveArrivalAreasForPlaceMerge(
  tx: MergeTx,
  input: {
    survivorId: string;
    mergedId: string;
    /** The merged place's areas as read under the merge lock (audit before). */
    mergedRows: readonly ArrivalAreaRow[];
    actorHumanId: string;
    now: Date;
  },
): Promise<MoveArrivalAreasForPlaceMergeResult> {
  const { survivorId, mergedId, mergedRows, actorHumanId, now } = input;

  // Always run, even when the read under the lock found none: one UPDATE
  // that matches nothing is cheaper than a CASCADE that loses a row.
  const movedIds = await tx.arrivalAreas.movePlaceAreas(mergedId, survivorId);
  if (movedIds.length === 0) return { movedIds };
  const beforeById = new Map(mergedRows.map((row) => [row.id, row]));
  const moved = new Set(movedIds);
  const afterById = new Map(
    (await tx.arrivalAreas.listForPlace(survivorId))
      .filter((row) => moved.has(row.id))
      .map((row) => [row.id, row]),
  );
  for (const id of movedIds) {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    await tx.audit.log({
      entity: ARRIVAL_AREA_AUDIT_ENTITY,
      entityId: id,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.movedForPlaceMerge,
      data: {
        actorHumanId,
        via: PLACE_MERGE_VIA,
        mergedId,
        survivorId,
        before: before ? arrivalAreaAuditPayload(before) : null,
        after: after ? arrivalAreaAuditPayload(after) : null,
      },
      at: now,
    });
  }
  return { movedIds };
}

export type OnEventsMovedByPlaceMergeResult = {
  /** Event-only areas switched off: outside 3 km of the survivor's pin. */
  disabledIds: string[];
  /** Hides deleted: their area is not an area of the survivor. */
  removedHideIds: string[];
  /**
   * Areas whose switch-off lost its compare-and-set (the row changed between
   * the read and the write). The merge holds the event rows it repointed, so
   * this means a concurrent writer; the caller rolls back and retries.
   */
  conflictIds: string[];
};

export async function onEventsMovedByPlaceMerge(
  tx: MergeTx,
  input: {
    eventIds: readonly string[];
    survivorId: string;
    mergedId: string;
    /** The survivor's pin after the merge's fill; null when it has none. */
    survivorPin: ArrivalAreaPin | null;
    actorHumanId: string;
    now: Date;
  },
): Promise<OnEventsMovedByPlaceMergeResult> {
  const { survivorId, mergedId, survivorPin, actorHumanId, now } = input;
  const from = { placeId: mergedId };
  const to = { placeId: survivorId };
  const result: OnEventsMovedByPlaceMergeResult = {
    disabledIds: [],
    removedHideIds: [],
    conflictIds: [],
  };
  const moved = new Set(input.eventIds);
  if (moved.size === 0) return result;

  // ONE batched read of exactly the moved events' own areas, whatever the
  // event count (the adapter chunks the ids): the merge holds the Place,
  // Calendar and advisory locks, so per-event queries would scale with a
  // place's whole history, and the survivor's own events are never read.
  // Read AFTER the repoint, so the moved event rows are held by the merge's
  // UPDATE: an area create on them (`lockParent`) waits, and nothing is
  // missed. Only events that have areas get any further write.
  const outsideByEvent = new Map<string, ArrivalAreaRow[]>();
  for (const row of eventAreasOutsideSurvivorPin(
    (await tx.arrivalAreas.listForEvents([...moved])).filter(
      (row) => row.eventId !== null && moved.has(row.eventId),
    ),
    survivorPin,
  )) {
    const eventId = row.eventId as string;
    outsideByEvent.set(eventId, [...(outsideByEvent.get(eventId) ?? []), row]);
  }

  for (const [eventId, outside] of outsideByEvent) {
    const switchedOff: string[] = [];
    for (const row of outside) {
      // Compare-and-set: a row changed since the read is a concurrent
      // writer, and the caller rolls the merge back as PLACE_MERGE_RETRY.
      const written = await tx.arrivalAreas.update(
        row.id,
        { disabledAt: now },
        { expectedUpdatedAt: row.updatedAt },
      );
      if (written.status === "updated") switchedOff.push(row.id);
      else result.conflictIds.push(row.id);
    }
    if (switchedOff.length > 0) {
      await tx.audit.log({
        entity: "event",
        entityId: eventId,
        action: ARRIVAL_AREA_AUDIT_ACTIONS.disabledForLocationChange,
        data: {
          actorHumanId,
          eventId,
          arrivalAreaIds: switchedOff,
          before: { disabledAt: null },
          after: { disabledAt: now.toISOString() },
          from,
          to,
          via: PLACE_MERGE_VIA,
          reason: "outside_survivor_envelope",
        },
        at: now,
      });
      result.disabledIds.push(...switchedOff);
    }
  }

  // Hides: ONE batched delete scoped to the moved events, cleaned against
  // the survivor after the move (a hide of a moved area stays). The audit
  // row is the same one `removeHidesNotInPlace` writes, one per event that
  // lost a hide.
  const removed = await tx.arrivalAreas.deleteHidesForEventsNotInPlace(
    [...moved],
    survivorId,
  );
  const removedByEvent = new Map<string, string[]>();
  for (const pair of removed) {
    removedByEvent.set(pair.eventId, [
      ...(removedByEvent.get(pair.eventId) ?? []),
      pair.arrivalAreaId,
    ]);
  }
  for (const [eventId, arrivalAreaIds] of removedByEvent) {
    await tx.audit.log({
      entity: "event",
      entityId: eventId,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.hidesRemovedForLocationChange,
      data: {
        actorHumanId,
        eventId,
        arrivalAreaIds,
        before: { hidden: true },
        after: { hidden: false },
        from,
        to,
        via: PLACE_MERGE_VIA,
      },
      at: now,
    });
    result.removedHideIds.push(...arrivalAreaIds);
  }
  return result;
}

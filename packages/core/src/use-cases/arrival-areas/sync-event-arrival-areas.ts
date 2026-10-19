import type { TxRepos } from "@th/ports/repos";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import { fail } from "@th/errors";

import { areaOutsideEnvelope, type ArrivalAreaPin } from "../../lib/arrival-areas/geometry";

import {
  ARRIVAL_AREA_AUDIT_ACTIONS,
  ARRIVAL_AREA_AUDIT_ENTITY,
  arrivalAreaAuditPayload,
} from "./_shared/arrival-area-audit";

// ─────────────────────────────────────────────────────────────────────────────
// arrival-areas FR-015: in an EventSeries each occurrence has its own
// event-only areas and hides, and an edit "syncs to draft siblings the way
// location already does". `syncSeriesDrafts` OVERWRITES each sibling DRAFT's
// location with the source's; when the organiser ticks "Also replace parking
// and drop-off areas on these shows" (owner Q13, 2026-10-17, off by default)
// this makes the sibling's arrival areas match the source's in the same
// transaction:
//   · event-only areas: when the sibling's set differs from the source's
//     (kind, shape, label, cost, price, note, accessible spots, switched off
//     or not, order), the sibling's are removed and the source's copied on
//     (new ids, same order; a switched-off source area is copied switched
//     off). An identical set is left alone, so a re-sync writes nothing;
//   · hides: when both are at the same place, the sibling hides exactly the
//     place areas the source hides.
// The caller only passes DRAFT targets; published and detached occurrences
// are never rewritten (syncSeriesDrafts never targets them). Every change is
// audited (FR-013) with `via: "series_sync"` and the source event id. Logs
// nothing (NFR-002).
//
// Run AFTER `onEventLocationChanged` for the same save: that hook switches
// the sibling's old areas off for its move; this then replaces them with
// copies drawn for the source's location, which the sibling now shares.
//
// `copyEventArrivalAreasToNewDraft` (owner Q12, 2026-10-17) is the same copy
// for a draft `generateEventsFromSeries` has just created: the new draft
// starts with the copy source's event-only areas and, at the same place, its
// hides. The draft's location comes from the series defaults, not from the
// source, so FR-014 applies to each copy: a shape not within 3 km of the new
// draft's pin is copied switched off, the way `onEventLocationChanged`
// treats a moved event.
// ─────────────────────────────────────────────────────────────────────────────

export const SERIES_SYNC_VIA = "series_sync";
export const SERIES_GENERATE_VIA = "series_generate";

export type SyncEventArrivalAreasResult = {
  removedIds: string[];
  createdIds: string[];
  hiddenIds: string[];
  unhiddenIds: string[];
};

type SyncTx = Pick<TxRepos, "arrivalAreas" | "audit">;

/** What makes two areas "the same" for a sync: everything a person sees. */
function contentKey(row: ArrivalAreaRow): string {
  return JSON.stringify([
    row.kind,
    row.geometry,
    row.label,
    row.cost,
    row.priceText ?? null,
    row.note ?? null,
    row.accessibleSpots === true,
    row.disabledAt !== null && row.disabledAt !== undefined,
  ]);
}

const sameSet = (a: readonly ArrivalAreaRow[], b: readonly ArrivalAreaRow[]) =>
  a.length === b.length && a.every((row, i) => contentKey(row) === contentKey(b[i]!));

export async function syncEventArrivalAreasToDraft(
  tx: SyncTx,
  input: {
    source: { id: string; placeId?: string | null };
    /** The sibling DRAFT as written by this sync (its new location). */
    target: { id: string; placeId?: string | null };
    actorHumanId: string;
    now: Date;
  },
): Promise<SyncEventArrivalAreasResult> {
  const { source, target, actorHumanId, now } = input;
  const result: SyncEventArrivalAreasResult = {
    removedIds: [],
    createdIds: [],
    hiddenIds: [],
    unhiddenIds: [],
  };
  if (source.id === target.id) return result;

  const placeId = target.placeId ?? null;
  const syncHides = placeId !== null && placeId === (source.placeId ?? null);
  const read = async () => {
    const [sourceRows, targetRows, sourceHides, targetHides] = await Promise.all([
      tx.arrivalAreas.listForEvent(source.id),
      tx.arrivalAreas.listForEvent(target.id),
      syncHides ? tx.arrivalAreas.listHidesForEvent(source.id) : Promise.resolve([]),
      syncHides ? tx.arrivalAreas.listHidesForEvent(target.id) : Promise.resolve([]),
    ]);
    const fromSource = sourceRows.filter((row) => row.eventId === source.id);
    const onTarget = targetRows.filter((row) => row.eventId === target.id);
    const want = new Set(sourceHides);
    const have = new Set(targetHides);
    return {
      fromSource,
      onTarget,
      sourceHides,
      targetHides,
      want,
      have,
      areasMatch: sameSet(fromSource, onTarget),
      hidesMatch:
        want.size === have.size && [...want].every((id) => have.has(id)),
    };
  };

  // Most syncs have nothing to do (no areas on either side): read first and
  // write nothing, without taking a lock. Otherwise lock the sibling's row
  // and read again, so the set compared is the set written (FR-005 limit,
  // NFR-004 tokens).
  let state = await read();
  if (state.areasMatch && state.hidesMatch) return result;
  if (!(await tx.arrivalAreas.lockParent({ eventId: target.id }))) return result;
  state = await read();

  const common = {
    actorHumanId,
    via: SERIES_SYNC_VIA,
    sourceEventId: source.id,
    eventId: target.id,
  };

  // ── Event-only areas ──
  const { fromSource, onTarget } = state;
  if (!state.areasMatch) {
    for (const row of onTarget) {
      const removed = await tx.arrivalAreas.delete(row.id, {
        expectedUpdatedAt: row.updatedAt,
      });
      if (removed.status !== "deleted") {
        // The sibling's row is locked above; a lost compare-and-set here is
        // a writer outside the lock. Roll the whole sync back.
        throw fail("ARRIVAL_AREA_CONFLICT", { meta: { arrivalAreaId: row.id } });
      }
      await tx.audit.log({
        entity: ARRIVAL_AREA_AUDIT_ENTITY,
        entityId: row.id,
        action: ARRIVAL_AREA_AUDIT_ACTIONS.removed,
        data: { ...common, before: arrivalAreaAuditPayload(removed.row), after: null },
        at: now,
      });
      result.removedIds.push(row.id);
    }

    for (const [i, row] of fromSource.entries()) {
      const copy = await copyAreaOnto(tx, {
        row,
        eventId: target.id,
        sortOrder: i,
        disabledAt: row.disabledAt ?? null,
        actorHumanId,
        now,
        auditData: common,
      });
      result.createdIds.push(copy.id);
    }
  }

  // ── Hides of the place's areas ──
  if (syncHides && !state.hidesMatch) {
    const { sourceHides, targetHides, want, have } = state;
    for (const arrivalAreaId of sourceHides) {
      if (have.has(arrivalAreaId)) continue;
      if (await tx.arrivalAreas.hide(target.id, arrivalAreaId)) {
        result.hiddenIds.push(arrivalAreaId);
      }
    }
    for (const arrivalAreaId of targetHides) {
      if (want.has(arrivalAreaId)) continue;
      if (await tx.arrivalAreas.unhide(target.id, arrivalAreaId)) {
        result.unhiddenIds.push(arrivalAreaId);
      }
    }
    await auditHides(tx, {
      eventId: target.id,
      placeId,
      hiddenIds: result.hiddenIds,
      unhiddenIds: result.unhiddenIds,
      auditData: common,
      now,
    });
  }

  return result;
}

/**
 * Create one copy of `row` on `eventId` (new id, given order), switched off
 * at `disabledAt` when set, with its `arrival_area.created` audit row.
 */
async function copyAreaOnto(
  tx: SyncTx,
  input: {
    row: ArrivalAreaRow;
    eventId: string;
    sortOrder: number;
    disabledAt: Date | null;
    actorHumanId: string;
    now: Date;
    auditData: Record<string, unknown>;
  },
): Promise<ArrivalAreaRow> {
  const { row, eventId, sortOrder, disabledAt, actorHumanId, now, auditData } = input;
  let copy = await tx.arrivalAreas.create({
    eventId,
    kind: row.kind,
    geometry: row.geometry,
    label: row.label,
    cost: row.cost,
    priceText: row.priceText ?? null,
    note: row.note ?? null,
    accessibleSpots: row.accessibleSpots === true,
    sortOrder,
    createdByHumanId: actorHumanId,
  });
  if (disabledAt) {
    const off = await tx.arrivalAreas.update(
      copy.id,
      { disabledAt },
      { expectedUpdatedAt: copy.updatedAt },
    );
    if (off.status !== "updated") {
      throw fail("ARRIVAL_AREA_CONFLICT", { meta: { arrivalAreaId: copy.id } });
    }
    copy = off.row;
  }
  await tx.audit.log({
    entity: ARRIVAL_AREA_AUDIT_ENTITY,
    entityId: copy.id,
    action: ARRIVAL_AREA_AUDIT_ACTIONS.created,
    data: {
      ...auditData,
      sourceArrivalAreaId: row.id,
      before: null,
      after: arrivalAreaAuditPayload(copy),
    },
    at: now,
  });
  return copy;
}

async function auditHides(
  tx: SyncTx,
  input: {
    eventId: string;
    placeId: string | null;
    hiddenIds: readonly string[];
    unhiddenIds: readonly string[];
    auditData: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const { eventId, placeId, auditData, now } = input;
  for (const [ids, hidden] of [
    [input.hiddenIds, true],
    [input.unhiddenIds, false],
  ] as const) {
    for (const arrivalAreaId of ids) {
      await tx.audit.log({
        entity: "event",
        entityId: eventId,
        action: hidden
          ? ARRIVAL_AREA_AUDIT_ACTIONS.hidden
          : ARRIVAL_AREA_AUDIT_ACTIONS.unhidden,
        data: {
          ...auditData,
          arrivalAreaId,
          placeId,
          before: { hidden: !hidden },
          after: { hidden },
        },
        at: now,
      });
    }
  }
}

/** What a series generation copies from its source, read once per run. */
export type GenerationAreaSource = {
  event: { id: string; placeId?: string | null };
  /** The source's own event-only areas, in order. */
  areas: readonly ArrivalAreaRow[];
  /** The place areas the source hides (meaningful at its place only). */
  hides: readonly string[];
};

/**
 * Read a generation's copy source once. Null when there is nothing to copy,
 * so a series without areas costs two reads per run and writes nothing; the
 * source event row (for its place) is read only when there is.
 */
export async function readGenerationAreaSource(
  tx: Pick<TxRepos, "arrivalAreas" | "events">,
  sourceEventId: string,
): Promise<GenerationAreaSource | null> {
  const [rows, hides] = await Promise.all([
    tx.arrivalAreas.listForEvent(sourceEventId),
    tx.arrivalAreas.listHidesForEvent(sourceEventId),
  ]);
  const areas = rows
    .filter((row) => row.eventId === sourceEventId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (areas.length === 0 && hides.length === 0) return null;
  const event = await tx.events.getById(sourceEventId);
  return {
    event: { id: sourceEventId, placeId: event?.placeId ?? null },
    areas,
    hides,
  };
}

export type CopyToNewDraftResult = {
  createdIds: string[];
  /** Copies switched off because their shape is not within 3 km of the draft's pin (FR-014). */
  switchedOffIds: string[];
  hiddenIds: string[];
};

/**
 * Owner Q12 (2026-10-17): a draft `generateEventsFromSeries` has just
 * created, in the generation's transaction, starts with its source's
 * event-only areas and hides, ONLY when the draft is at the same place as
 * the source (both place ids set and equal). A draft at another place, or a
 * freeform / saved location on either side, copies nothing: shapes drawn
 * around one address must never outline another (review round 1).
 *
 *  - Every copy keeps the source's order and fields. A source area that is
 *    switched off stays off; a copy whose shape is not within 3 km of
 *    `targetPin` (the draft's true pin; null = no pin) is copied switched
 *    off at `now` (FR-014), so it shows nowhere until the organiser moves or
 *    removes it.
 *  - The draft row was created in this transaction, so nobody else can
 *    write its areas: no parent lock is taken, and the source's set (at
 *    most the per-event limit) fits by construction.
 *  - One `arrival_area.created` audit row per copy and one
 *    `arrival_area.hidden` row per hide (FR-013), `via: "series_generate"`;
 *    a copy switched off for its distance carries `switchedOffOutsideEnvelope`.
 */
export async function copyEventArrivalAreasToNewDraft(
  tx: SyncTx,
  input: {
    source: GenerationAreaSource;
    target: { id: string; placeId?: string | null };
    targetPin: ArrivalAreaPin | null;
    actorHumanId: string;
    now: Date;
  },
): Promise<CopyToNewDraftResult> {
  const { source, target, targetPin, actorHumanId, now } = input;
  const result: CopyToNewDraftResult = { createdIds: [], switchedOffIds: [], hiddenIds: [] };
  if (source.event.id === target.id) return result;
  const placeId = target.placeId ?? null;
  if (placeId === null || placeId !== (source.event.placeId ?? null)) return result;

  const common = {
    actorHumanId,
    via: SERIES_GENERATE_VIA,
    sourceEventId: source.event.id,
    eventId: target.id,
  };

  for (const [i, row] of source.areas.entries()) {
    const outside = row.disabledAt ? false : areaOutsideEnvelope(row, targetPin);
    const copy = await copyAreaOnto(tx, {
      row,
      eventId: target.id,
      sortOrder: i,
      disabledAt: row.disabledAt ?? (outside ? now : null),
      actorHumanId,
      now,
      auditData: outside ? { ...common, switchedOffOutsideEnvelope: true } : common,
    });
    result.createdIds.push(copy.id);
    if (outside) result.switchedOffIds.push(copy.id);
  }

  for (const arrivalAreaId of source.hides) {
    if (await tx.arrivalAreas.hide(target.id, arrivalAreaId)) {
      result.hiddenIds.push(arrivalAreaId);
    }
  }
  await auditHides(tx, {
    eventId: target.id,
    placeId,
    hiddenIds: result.hiddenIds,
    unhiddenIds: [],
    auditData: common,
    now,
  });

  return result;
}

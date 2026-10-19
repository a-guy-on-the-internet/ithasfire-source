import type { TxRepos } from "@th/ports/repos";

import { ARRIVAL_AREA_AUDIT_ACTIONS } from "./_shared/arrival-area-audit";

// ─────────────────────────────────────────────────────────────────────────────
// FR-014: location changes never move shapes silently. When an event changes
// place or address, in the SAME transaction as the save:
//   · its event-only areas are switched off (`disabledAt`), shown nowhere
//     until the organiser repositions (updateArrivalArea with a new shape)
//     or removes them;
//   · its hides of areas that no longer belong to its place are deleted, so
//     moving back to the old place does not silently re-hide them.
// One audit row for each, only when something changed.
//
// "Changed place or address":
//   · the place link changed (another place, onto a place, off a place); or
//   · with no place on either side, the address text or the point changed.
// With the same place on both sides the event's address IS the place's: a
// moved place pin is the place editor's flag (FR-014, `outsideEnvelope`),
// and the event row's re-projected circle centre is not the event moving.
//
// Called by the event save path (save-event-shared `runSaveEventTxBody`)
// with the row under the save's lock and the row as saved. NFR-002: logs
// nothing; the audit rows carry ids only.
// ─────────────────────────────────────────────────────────────────────────────

/** The event location fields this decision reads. */
export type EventLocationSnapshot = {
  id: string;
  placeId?: string | null;
  addressText?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type OnEventLocationChangedInput = {
  before: EventLocationSnapshot;
  after: EventLocationSnapshot;
  /** Who saved (audit); null for a system change. */
  actorHumanId: string | null;
  now: Date;
};

export type OnEventLocationChangedResult = {
  /** Event-only areas switched off by this save. */
  disabledIds: string[];
  /** Hides deleted because their area is not an area of the new place. */
  removedHideIds: string[];
};

const NOTHING: OnEventLocationChangedResult = {
  disabledIds: [],
  removedHideIds: [],
};

const norm = <T>(value: T | null | undefined): T | null => value ?? null;

/** Pure: did this save change the event's place or address (see header)? */
export function eventLocationChanged(
  before: EventLocationSnapshot,
  after: EventLocationSnapshot,
): boolean {
  if (norm(before.placeId) !== norm(after.placeId)) return true;
  if (norm(after.placeId) !== null) return false;
  return (
    norm(before.addressText) !== norm(after.addressText) ||
    coordMoved(before.lat, after.lat) ||
    coordMoved(before.lng, after.lng)
  );
}

/**
 * About 1 cm: float drift through a geocoder / JSON round trip is not the
 * event moving, so it never switches areas off.
 */
export const LOCATION_CHANGE_EPSILON_DEGREES = 1e-7;

function coordMoved(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return x !== y;
  return Math.abs(x - y) > LOCATION_CHANGE_EPSILON_DEGREES;
}

export async function onEventLocationChanged(
  tx: Pick<TxRepos, "arrivalAreas" | "audit">,
  input: OnEventLocationChangedInput,
): Promise<OnEventLocationChangedResult> {
  const { before, after, actorHumanId, now } = input;
  if (before.id !== after.id || !eventLocationChanged(before, after)) {
    return NOTHING;
  }
  const eventId = after.id;
  const from = { placeId: norm(before.placeId) };
  const to = { placeId: norm(after.placeId) };

  // The ids about to be switched off (those still on), for the audit row.
  const enabled = (await tx.arrivalAreas.listForEvent(eventId))
    .filter((row) => row.eventId === eventId && row.disabledAt === null)
    .map((row) => row.id);
  let disabledIds: string[] = [];
  if (enabled.length > 0) {
    const changed = await tx.arrivalAreas.setDisabledForEvent(eventId, now);
    if (changed > 0) {
      disabledIds = enabled;
      await tx.audit.log({
        entity: "event",
        entityId: eventId,
        action: ARRIVAL_AREA_AUDIT_ACTIONS.disabledForLocationChange,
        data: {
          actorHumanId,
          eventId,
          arrivalAreaIds: disabledIds,
          before: { disabledAt: null },
          after: { disabledAt: now.toISOString() },
          from,
          to,
        },
        at: now,
      });
    }
  }

  const removedHideIds =
    from.placeId !== to.placeId
      ? await removeHidesNotInPlace(tx, { eventId, from, to, actorHumanId, now })
      : [];

  return { disabledIds, removedHideIds };
}

/**
 * Delete the event's hides whose area is not an area of `to.placeId`, with
 * one audit row when any went. Shared by {@link onEventLocationChanged} and
 * the place merge (`place-merge-arrival-areas.ts`), which runs it AFTER the
 * merged place's areas moved to the survivor, so a hide of a moved area is
 * an area of the new place and stays (FR-012).
 */
export async function removeHidesNotInPlace(
  tx: Pick<TxRepos, "arrivalAreas" | "audit">,
  input: {
    eventId: string;
    from: { placeId: string | null };
    to: { placeId: string | null };
    actorHumanId: string | null;
    now: Date;
    /** Audit only: what made the change when it was not an event save. */
    via?: string;
  },
): Promise<string[]> {
  const { eventId, from, to, actorHumanId, now, via } = input;
  const removed = await tx.arrivalAreas.deleteHidesForEventNotInPlace(
    eventId,
    to.placeId,
  );
  const removedHideIds = removed.map((pair) => pair.arrivalAreaId);
  if (removedHideIds.length > 0) {
    await tx.audit.log({
      entity: "event",
      entityId: eventId,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.hidesRemovedForLocationChange,
      data: {
        actorHumanId,
        eventId,
        arrivalAreaIds: removedHideIds,
        before: { hidden: true },
        after: { hidden: false },
        from,
        to,
        ...(via ? { via } : {}),
      },
      at: now,
    });
  }
  return removedHideIds;
}

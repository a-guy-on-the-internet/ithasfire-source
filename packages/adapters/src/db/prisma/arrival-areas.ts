import type { ArrivalArea, Prisma } from "@prisma/client";
import type {
  ArrivalAreaCost,
  ArrivalAreaGeometry,
  ArrivalAreaKind,
  ArrivalAreaParent,
  ArrivalAreaRow,
  ArrivalAreasRepo,
} from "@th/ports/repos/arrival-areas";

import type { PrismaClientOrTx } from "./types";

const ORDER = [{ sortOrder: "asc" }, { createdAt: "asc" }] as const;

/**
 * Event ids per query in `deleteHidesForEventsNotInPlace` and
 * `listForEvents`: well under Postgres's bind-parameter limit.
 */
const EVENT_ID_BATCH_CHUNK = 1000;

export type ArrivalAreasRepoOptions = {
  /**
   * Tests only: a smaller chunk so the chunk loop runs without seeding
   * thousands of events. Defaults to {@link EVENT_ID_BATCH_CHUNK}.
   */
  eventIdBatchChunk?: number;
};

/**
 * The next `updatedAt` for a row whose current token is `previous`: now, but
 * always strictly later than `previous`. Two writes in the same millisecond, or
 * an instance whose clock lags the last writer's, would otherwise leave the
 * token unchanged and let a stale save through (NFR-004).
 */
function nextToken(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

/** The Prisma `where` that scopes a row to its parent. */
function parentWhere(parent: ArrivalAreaParent) {
  return parent.placeId !== undefined
    ? { placeId: parent.placeId }
    : { eventId: parent.eventId };
}

/**
 * Arrival areas (arrival-areas spec, 2026-10-16). Row mechanics only; the
 * limits, geometry rules, authorization and audit rows are core's.
 */
export function makeArrivalAreasRepo(
  p: PrismaClientOrTx,
  options: ArrivalAreasRepoOptions = {},
): ArrivalAreasRepo {
  const chunkSize = Math.max(1, options.eventIdBatchChunk ?? EVENT_ID_BATCH_CHUNK);
  return {
    async listForPlace(placeId) {
      const rows = await p.arrivalArea.findMany({
        where: { placeId },
        orderBy: [...ORDER],
      });
      return rows.map(toArrivalAreaRow);
    },

    async listForPlaces(placeIds) {
      if (placeIds.length === 0) return [];
      const rows = await p.arrivalArea.findMany({
        where: { placeId: { in: [...placeIds] } },
        orderBy: [{ placeId: "asc" }, ...ORDER],
      });
      return rows.map(toArrivalAreaRow);
    },

    async listForEvent(eventId) {
      const rows = await p.arrivalArea.findMany({
        where: { eventId },
        orderBy: [...ORDER],
      });
      return rows.map(toArrivalAreaRow);
    },

    async listEventAreasAtPlace(placeId) {
      const rows = await p.arrivalArea.findMany({
        where: { event: { placeId } },
        orderBy: [{ eventId: "asc" }, ...ORDER],
      });
      return rows.map(toArrivalAreaRow);
    },

    async listForEvents(eventIds) {
      const ids = [...new Set(eventIds)].sort();
      if (ids.length === 0) return [];
      const out: ArrivalAreaRow[] = [];
      // Chunks are taken over the sorted ids and each is ordered by eventId,
      // so the concatenation keeps the eventId, sortOrder, createdAt order.
      // That relies on lowercase-hex UUIDs sorting the same in JS and Postgres.
      for (let i = 0; i < ids.length; i += chunkSize) {
        const rows = await p.arrivalArea.findMany({
          where: { eventId: { in: ids.slice(i, i + chunkSize) } },
          orderBy: [{ eventId: "asc" }, ...ORDER],
        });
        out.push(...rows.map(toArrivalAreaRow));
      }
      return out;
    },

    async getById(id) {
      const row = await p.arrivalArea.findUnique({ where: { id } });
      return row ? toArrivalAreaRow(row) : null;
    },

    async getByIds(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const rows = await p.arrivalArea.findMany({
        where: { id: { in: unique } },
      });
      return rows.map(toArrivalAreaRow);
    },

    async countForPlace(placeId) {
      return p.arrivalArea.count({ where: { placeId } });
    },

    async countForEvent(eventId) {
      return p.arrivalArea.count({ where: { eventId } });
    },

    async lockParent(parent) {
      // NO KEY UPDATE, not UPDATE: every FK child insert (orders, tickets and
      // holds on Event, events on Place) takes FOR KEY SHARE on the parent,
      // which FOR UPDATE would block. NO KEY UPDATE still conflicts with
      // itself, so two lockParent callers serialise. Tagged templates only:
      // the id is a bound parameter, never spliced.
      const rows =
        parent.placeId !== undefined
          ? await p.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM "Place" WHERE id = ${parent.placeId} FOR NO KEY UPDATE`
          : await p.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM "Event" WHERE id = ${parent.eventId} FOR NO KEY UPDATE`;
      return rows.length > 0;
    },

    async create(input) {
      const row = await p.arrivalArea.create({
        data: {
          placeId: input.placeId ?? null,
          eventId: input.eventId ?? null,
          kind: input.kind,
          geometry: input.geometry as unknown as Prisma.InputJsonValue,
          label: input.label,
          cost: input.cost ?? "UNKNOWN",
          priceText: input.priceText ?? null,
          note: input.note ?? null,
          accessibleSpots: input.accessibleSpots ?? false,
          sortOrder: input.sortOrder ?? 0,
          createdByHumanId: input.createdByHumanId ?? null,
        },
      });
      return toArrivalAreaRow(row);
    },

    async update(id, patch, { expectedUpdatedAt }) {
      // The version check rides the UPDATE's WHERE, so of two saves that read
      // the same row only the first lands: the second re-evaluates its WHERE
      // after the first commits and matches nothing. Zero rows is then a
      // conflict or a missing row, told apart by one read.
      const count = await p.arrivalArea.updateMany({
        where: { id, updatedAt: expectedUpdatedAt },
        data: {
          updatedAt: nextToken(expectedUpdatedAt),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.geometry !== undefined
            ? { geometry: patch.geometry as unknown as Prisma.InputJsonValue }
            : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
          ...(patch.priceText !== undefined
            ? { priceText: patch.priceText }
            : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.accessibleSpots !== undefined
            ? { accessibleSpots: patch.accessibleSpots }
            : {}),
          ...(patch.disabledAt !== undefined
            ? { disabledAt: patch.disabledAt }
            : {}),
        },
      });
      const current = await p.arrivalArea.findUnique({ where: { id } });
      if (!current) return { status: "not_found" };
      const row = toArrivalAreaRow(current);
      return count.count > 0
        ? { status: "updated", row }
        : { status: "conflict", current: row };
    },

    async delete(id, { expectedUpdatedAt }) {
      const before = await p.arrivalArea.findUnique({ where: { id } });
      if (!before) return { status: "not_found" };
      if (before.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        return { status: "conflict", current: toArrivalAreaRow(before) };
      }
      // Same version in the WHERE: the row deleted is the row read above, or
      // nothing is (a write landed in between).
      const { count } = await p.arrivalArea.deleteMany({
        where: { id, updatedAt: expectedUpdatedAt },
      });
      if (count > 0) return { status: "deleted", row: toArrivalAreaRow(before) };
      const now = await p.arrivalArea.findUnique({ where: { id } });
      return now
        ? { status: "conflict", current: toArrivalAreaRow(now) }
        : { status: "not_found" };
    },

    async reorder(parent, orderedIds) {
      const scope = parentWhere(parent);
      const current = await p.arrivalArea.findMany({
        where: scope,
        orderBy: [...ORDER],
        select: { id: true },
      });
      const currentIds = current.map((r) => r.id);
      const given = new Set(orderedIds);
      const matches =
        given.size === orderedIds.length &&
        given.size === currentIds.length &&
        currentIds.every((id) => given.has(id));
      if (!matches) return { status: "mismatch", currentIds };
      if (orderedIds.length > 0) {
        // One statement, scoped by the parent as well as the id. Raw so that
        // `updatedAt` stays put (see the port doc); every value is bound.
        const ids = [...orderedIds];
        if (parent.placeId !== undefined) {
          await p.$executeRaw`
            UPDATE "ArrivalArea" AS a
               SET "sortOrder" = (v.ord - 1)::int
              FROM unnest(${ids}::text[]) WITH ORDINALITY AS v(id, ord)
             WHERE a.id = v.id AND a."placeId" = ${parent.placeId}`;
        } else {
          await p.$executeRaw`
            UPDATE "ArrivalArea" AS a
               SET "sortOrder" = (v.ord - 1)::int
              FROM unnest(${ids}::text[]) WITH ORDINALITY AS v(id, ord)
             WHERE a.id = v.id AND a."eventId" = ${parent.eventId}`;
        }
      }
      const rows = await p.arrivalArea.findMany({
        where: scope,
        orderBy: [...ORDER],
      });
      return { status: "reordered", rows: rows.map(toArrivalAreaRow) };
    },

    async setDisabledForEvent(eventId, disabledAt) {
      // Per row (at most the 10-area limit) so each token strictly increases
      // from its own previous value (see nextToken).
      const rows = await p.arrivalArea.findMany({
        where: {
          eventId,
          disabledAt: disabledAt === null ? { not: null } : null,
        },
        select: { id: true, updatedAt: true },
      });
      let changed = 0;
      for (const row of rows) {
        const { count } = await p.arrivalArea.updateMany({
          where: {
            id: row.id,
            eventId,
            disabledAt: disabledAt === null ? { not: null } : null,
          },
          data: { disabledAt, updatedAt: nextToken(row.updatedAt) },
        });
        changed += count;
      }
      return changed;
    },

    async listHidesForEvent(eventId) {
      const rows = await p.eventArrivalAreaHide.findMany({
        where: { eventId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { arrivalAreaId: true },
      });
      return rows.map((r) => r.arrivalAreaId);
    },

    async hide(eventId, arrivalAreaId) {
      // skipDuplicates rides ON CONFLICT DO NOTHING on (eventId, arrivalAreaId),
      // so two concurrent hides cannot both write or either fail.
      const { count } = await p.eventArrivalAreaHide.createMany({
        data: [{ eventId, arrivalAreaId }],
        skipDuplicates: true,
      });
      return count > 0;
    },

    async unhide(eventId, arrivalAreaId) {
      const { count } = await p.eventArrivalAreaHide.deleteMany({
        where: { eventId, arrivalAreaId },
      });
      return count > 0;
    },

    async deleteHidesForEventNotInPlace(eventId, placeId) {
      const stale = await p.eventArrivalAreaHide.findMany({
        where: {
          eventId,
          ...(placeId === null
            ? {}
            : {
                // `placeId` NULL (an event area hidden by mistake) also goes:
                // `NOT (placeId = x)` alone would keep it, SQL NULL rules.
                OR: [
                  { arrivalArea: { placeId: { not: placeId } } },
                  { arrivalArea: { placeId: null } },
                ],
              }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, eventId: true, arrivalAreaId: true },
      });
      if (stale.length === 0) return [];
      await p.eventArrivalAreaHide.deleteMany({
        where: { id: { in: stale.map((h) => h.id) } },
      });
      return stale.map((h) => ({
        eventId: h.eventId,
        arrivalAreaId: h.arrivalAreaId,
      }));
    },

    async deleteHidesForEventsNotInPlace(eventIds, placeId) {
      const ids = [...new Set(eventIds)].sort();
      if (ids.length === 0) return [];
      const removed: Array<{ eventId: string; arrivalAreaId: string }> = [];
      // Chunked so a place with thousands of events stays well under the
      // bind-parameter limit: one find + one delete per chunk.
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const stale = await p.eventArrivalAreaHide.findMany({
          where: {
            eventId: { in: chunk },
            // `placeId` NULL (an event area hidden by mistake) also goes, as
            // in deleteHidesForEventNotInPlace.
            OR: [
              { arrivalArea: { placeId: { not: placeId } } },
              { arrivalArea: { placeId: null } },
            ],
          },
          orderBy: [{ eventId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, eventId: true, arrivalAreaId: true },
        });
        if (stale.length === 0) continue;
        await p.eventArrivalAreaHide.deleteMany({
          where: { id: { in: stale.map((h) => h.id) } },
        });
        removed.push(
          ...stale.map((h) => ({ eventId: h.eventId, arrivalAreaId: h.arrivalAreaId })),
        );
      }
      return removed;
    },

    async movePlaceAreas(fromPlaceId, toPlaceId) {
      if (fromPlaceId === toPlaceId) return [];
      const top = await p.arrivalArea.aggregate({
        where: { placeId: toPlaceId },
        _max: { sortOrder: true },
      });
      const base = top._max.sortOrder === null ? 0 : top._max.sortOrder + 1;
      const moving = await p.arrivalArea.findMany({
        where: { placeId: fromPlaceId },
        orderBy: [...ORDER],
        select: { id: true, updatedAt: true },
      });
      // An UPDATE per row (at most the 10-area limit): the id stays, so every
      // EventArrivalAreaHide pointing at the area still points at it.
      const moved: string[] = [];
      for (const [i, { id, updatedAt }] of moving.entries()) {
        const { count } = await p.arrivalArea.updateMany({
          where: { id, placeId: fromPlaceId },
          data: {
            placeId: toPlaceId,
            sortOrder: base + i,
            updatedAt: nextToken(updatedAt),
          },
        });
        if (count > 0) moved.push(id);
      }
      return moved;
    },
  };
}

/** Prisma row → DTO (adapters never leak Prisma models). */
function toArrivalAreaRow(row: ArrivalArea): ArrivalAreaRow {
  return {
    id: row.id,
    placeId: row.placeId,
    eventId: row.eventId,
    kind: row.kind as ArrivalAreaKind,
    // Json column; core validated the shape before it was written (FR-005).
    geometry: row.geometry as unknown as ArrivalAreaGeometry,
    label: row.label,
    cost: row.cost as ArrivalAreaCost,
    priceText: row.priceText,
    note: row.note,
    accessibleSpots: row.accessibleSpots,
    sortOrder: row.sortOrder,
    disabledAt: row.disabledAt,
    createdByHumanId: row.createdByHumanId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

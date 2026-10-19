import { Prisma } from "@prisma/client";
import type {
  RsvpNoticeKind,
  RsvpNoticeRecord,
  RsvpNoticesRepo,
} from "@th/ports/repos/rsvp-notices";

import type { PrismaClientOrTx } from "./types";

const NOTICE_SELECT = {
  id: true,
  eventId: true,
  eventDateId: true,
  humanId: true,
  kind: true,
  createdAt: true,
  dispatchedAt: true,
  attempts: true,
} as const;

const mapRecord = (row: {
  id: string;
  eventId: string;
  eventDateId: string | null;
  humanId: string;
  kind: RsvpNoticeKind;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
}): RsvpNoticeRecord => ({
  id: row.id,
  eventId: row.eventId,
  eventDateId: row.eventDateId,
  humanId: row.humanId,
  kind: row.kind,
  createdAt: row.createdAt,
  dispatchedAt: row.dispatchedAt,
  attempts: row.attempts,
});

/** Shape returned by the raw claim SELECT (columns aliased to the record). */
type RawNoticeRow = {
  id: string;
  eventId: string;
  eventDateId: string | null;
  humanId: string;
  kind: RsvpNoticeKind;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
};

export function makeRsvpNoticesRepo(p: PrismaClientOrTx): RsvpNoticesRepo {
  return {
    // `eventDateId ?? null` so an omitted field (event-level RSVP) and an
    // explicit null both store NULL — per-date notices carry the date id.
    create: async ({ eventId, eventDateId, humanId }) => {
      const row = await p.rsvpNotice.create({
        data: {
          eventId,
          eventDateId: eventDateId ?? null,
          humanId,
          kind: "CONFIRMATION",
        },
        select: NOTICE_SELECT,
      });
      return mapRecord(row);
    },

    // The call-off fan-out. `createMany` (one INSERT, N rows) because a
    // popular weekly night can carry hundreds of RSVPs and this runs INSIDE
    // the transaction that flips the occurrence — a per-row round trip would
    // hold that write lock open for the length of the fan-out.
    //
    // No `skipDuplicates` and no unique index to lean on: the guarded
    // compare-and-set upstream means exactly one transaction ever reaches
    // here for a given SCHEDULED -> CANCELLED transition, so there is nothing
    // to collide with. `skipDuplicates` would only hide a lost-update bug.
    createDateCancelled: async ({ eventId, eventDateId, humanIds }) => {
      if (humanIds.length === 0) {
        return 0;
      }
      const result = await p.rsvpNotice.createMany({
        data: humanIds.map((humanId) => ({
          eventId,
          eventDateId,
          humanId,
          kind: "DATE_CANCELLED" as const,
        })),
      });
      return result.count;
    },

    // Undo the pending half of a call-off. Scoped to `dispatchedAt IS NULL`:
    // an already-sent "that night is off" is history and the retention purge
    // owns it, but one still sitting in the outbox must not go out for a night
    // that is back on.
    deletePendingDateCancelledForDate: async (eventDateId) => {
      const result = await p.rsvpNotice.deleteMany({
        where: {
          eventDateId,
          kind: "DATE_CANCELLED",
          dispatchedAt: null,
        },
      });
      return result.count;
    },

    // dispatchedAt IS NULL, oldest first (createdAt asc, id asc for a stable
    // tie-break). The [dispatchedAt, createdAt] index covers this scan.
    //
    // CONCURRENCY: `FOR UPDATE SKIP LOCKED` claim, mirroring the
    // event-change-notices repo — two overlapping drain runs never process
    // the SAME notice. Defense in depth on top of the notify idempotency key
    // (`rsvp-confirmed:{noticeId}`); the claim does NOT persist past the
    // statement, so the notice re-appears next tick until dispatched.
    listUndispatched: async ({ limit, freshOnly }) => {
      const rows = await p.$queryRaw<RawNoticeRow[]>(Prisma.sql`
        SELECT
          "id",
          "eventId",
          "eventDateId",
          "humanId",
          "kind",
          "createdAt",
          "dispatchedAt",
          "attempts"
        FROM "RsvpNotice"
        WHERE "dispatchedAt" IS NULL
          ${freshOnly ? Prisma.sql`AND "attempts" = 0` : Prisma.empty}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      return rows.map(mapRecord);
    },

    markDispatched: async (ids, at) => {
      if (ids.length === 0) {
        return;
      }
      await p.rsvpNotice.updateMany({
        where: { id: { in: ids } },
        data: { dispatchedAt: at },
      });
    },

    incrementAttempts: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      await p.rsvpNotice.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 } },
      });
    },

    // Retention purge: only DISPATCHED notices older than the cutoff.
    // `dispatchedAt: { not: null, lt: cutoff }` guarantees in-flight rows
    // (dispatchedAt IS NULL) are never removed — still owed to recipients.
    deleteDispatchedBefore: async (cutoff) => {
      const result = await p.rsvpNotice.deleteMany({
        where: { dispatchedAt: { not: null, lt: cutoff } },
      });
      return result.count;
    },
  } satisfies RsvpNoticesRepo;
}

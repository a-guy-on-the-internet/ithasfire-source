import { Prisma } from "@prisma/client";
import type {
  EventChangeNoticeRecord,
  EventChangeNoticesRepo,
} from "@th/ports/repos/event-change-notices";

import type { PrismaClientOrTx } from "./types";

const NOTICE_SELECT = {
  id: true,
  eventId: true,
  changeType: true,
  payload: true,
  createdAt: true,
  dispatchedAt: true,
  attempts: true,
  notifiedHumanIds: true,
} as const;

// Prisma emits `JsonValue` for the payload column; the port surfaces it as
// `unknown` so neither core nor jobs are coupled to Prisma's Json typing.
const mapRecord = (row: {
  id: string;
  eventId: string;
  changeType: EventChangeNoticeRecord["changeType"];
  payload: Prisma.JsonValue;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
  notifiedHumanIds: string[] | null;
}): EventChangeNoticeRecord => ({
  id: row.id,
  eventId: row.eventId,
  changeType: row.changeType,
  payload: row.payload,
  createdAt: row.createdAt,
  dispatchedAt: row.dispatchedAt,
  attempts: row.attempts,
  notifiedHumanIds: row.notifiedHumanIds ?? [],
});

/** Shape returned by the raw claim SELECT (columns aliased to the record). */
type RawNoticeRow = {
  id: string;
  eventId: string;
  changeType: EventChangeNoticeRecord["changeType"];
  payload: Prisma.JsonValue;
  createdAt: Date;
  dispatchedAt: Date | null;
  attempts: number;
  notifiedHumanIds: string[] | null;
};

export function makeEventChangeNoticesRepo(
  p: PrismaClientOrTx,
): EventChangeNoticesRepo {
  return {
    // Accepts the caller's prisma client/tx handle (`p`), so writing inside
    // `repos.tx(...)` enrolls the notice in the same transaction as the event
    // mutation — the transactional-outbox guarantee (NFR-002).
    create: async ({ eventId, changeType, payload }) => {
      const row = await p.eventChangeNotice.create({
        data: {
          eventId,
          changeType,
          // `?? Prisma.JsonNull` so a null payload maps to a JSON null column
          // value rather than tripping the required-column constraint.
          payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
        select: NOTICE_SELECT,
      });
      return mapRecord(row);
    },

    // dispatchedAt IS NULL, oldest first (createdAt asc, id asc for a stable
    // tie-break). The [dispatchedAt, createdAt] index covers this scan.
    //
    // CONCURRENCY: the scan is a `FOR UPDATE SKIP LOCKED` claim so two drain
    // runs that overlap never fan out the SAME notice — a row a peer run is
    // scanning is skipped rather than double-processed. This is defense in
    // depth: durable per-recipient dedup (`notifiedHumanIds`) plus the notify
    // idempotency key are the primary double-send guards; SKIP LOCKED narrows
    // the concurrent-overlap window on top. The claim does NOT persist across
    // fan-out (the row isn't stamped), so `listUndispatched` stays a repeatable
    // read of the outbox — the notice re-appears next tick until dispatched.
    listUndispatched: async ({ limit, freshOnly }) => {
      const rows = await p.$queryRaw<RawNoticeRow[]>(Prisma.sql`
        SELECT
          "id",
          "eventId",
          "changeType"::text AS "changeType",
          "payload",
          "createdAt",
          "dispatchedAt",
          "attempts",
          "notifiedHumanIds"
        FROM "EventChangeNotice"
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
      await p.eventChangeNotice.updateMany({
        where: { id: { in: ids } },
        data: { dispatchedAt: at },
      });
    },

    incrementAttempts: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      await p.eventChangeNotice.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 } },
      });
    },

    // Append the given humanIds to `notifiedHumanIds`, deduped in-SQL
    // (array_cat then DISTINCT unnest) so the write is idempotent — re-running
    // a drain with an overlapping success set never grows the array with dups.
    markNotified: async (id, humanIds) => {
      if (humanIds.length === 0) {
        return;
      }
      await p.$executeRaw(Prisma.sql`
        UPDATE "EventChangeNotice"
        SET "notifiedHumanIds" = ARRAY(
          SELECT DISTINCT e
          FROM unnest("notifiedHumanIds" || ${humanIds}::text[]) AS e
        )
        WHERE "id" = ${id}
      `);
    },

    // Retention purge: delete only DISPATCHED notices older than the cutoff.
    // `dispatchedAt: { not: null, lt: cutoff }` guarantees in-flight/undispatched
    // rows (dispatchedAt IS NULL) are never removed — they're still owed to
    // recipients. Returns the deleted count.
    deleteDispatchedBefore: async (cutoff) => {
      const result = await p.eventChangeNotice.deleteMany({
        where: { dispatchedAt: { not: null, lt: cutoff } },
      });
      return result.count;
    },
  } satisfies EventChangeNoticesRepo;
}

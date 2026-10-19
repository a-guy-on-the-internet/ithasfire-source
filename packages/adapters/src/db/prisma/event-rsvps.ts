import { Prisma } from "@prisma/client";
import type { EventRsvpsRepo } from "@th/ports/repos/event-rsvps";
import type { EventRsvpRecord } from "@th/types";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Bounded reconciliation attempts for the benign insert-vs-delete race (see
// `upsert`). Two create↔delete interleavings can at most trade the row a
// handful of times before one side settles; a small cap avoids an unbounded
// spin while comfortably covering real concurrency.
const UPSERT_MAX_ATTEMPTS = 5;

const RSVP_SELECT = {
  id: true,
  eventId: true,
  humanId: true,
  createdAt: true,
} as const;

const mapRecord = (row: any): EventRsvpRecord => ({
  id: row.id,
  eventId: row.eventId,
  humanId: row.humanId,
  createdAt: row.createdAt,
});

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeEventRsvpsRepo(p: PrismaClientOrTx): EventRsvpsRepo {
  return {
    // Idempotent AND race-safe. Contract: after this call a row exists for
    // (eventId, humanId), and the returned record is always a real row —
    // never `undefined`, never a thrown Zod/Prisma internal. `created` is
    // true ONLY when OUR insert won (the successful `create` branch); a
    // re-RSVP that reads a concurrent/pre-existing row back reports
    // `created: false`, so the RSVP-confirmation enqueue never duplicates.
    //
    // Prisma's `upsert` is NOT safe against a concurrent `delete` (which uses
    // `deleteMany`): under interleaving it can resolve to `undefined` or throw
    // P2002/P2025, which used to surface as a 500 with a raw Zod issue array.
    // Instead we do INSERT → on the unique conflict read the existing row back
    // (the winning concurrent RSVP), and if a concurrent cancel has meanwhile
    // deleted that row, re-attempt the insert. Bounded retries keep this
    // correct under Postgres concurrency without spinning.
    //
    // IMPORTANT: this MUST run on the base Prisma client, NOT inside
    // `repos.tx()`. The create-then-reconcile recovery relies on catching the
    // P2002 and issuing further queries — but a P2002 raised inside an
    // interactive transaction ABORTS that transaction ("current transaction is
    // aborted, commands ignored until end of transaction block"), so the
    // follow-up findUnique/retry would themselves fail. RSVP is a single
    // idempotent row write with no other mutation to atomically bind it to, so
    // it deliberately needs no transaction.
    async upsert({ eventId, humanId }) {
      for (let attempt = 1; attempt <= UPSERT_MAX_ATTEMPTS; attempt += 1) {
        try {
          const row = await p.eventRsvp.create({
            data: { eventId, humanId },
            select: RSVP_SELECT,
          });
          return { record: mapRecord(row), created: true };
        } catch (error) {
          if (
            !(
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === "P2002"
            )
          ) {
            throw error;
          }

          // A concurrent RSVP won the insert — read the existing row back.
          const existing = await p.eventRsvp.findUnique({
            where: { eventId_humanId: { eventId, humanId } },
            select: RSVP_SELECT,
          });
          if (existing) {
            return { record: mapRecord(existing), created: false };
          }

          // The row was deleted by a concurrent cancel between our failed
          // insert and this read — loop and try to insert it again.
        }
      }

      // Only reachable if create↔delete kept racing for every attempt. This
      // is a plain Error (normalized to INTERNAL upstream), never a raw Zod
      // issue array leaked to the client.
      throw new Error(
        "eventRsvp.upsert could not settle a row under concurrent RSVP/cancel",
      );
    },

    // deleteMany so a missing row is a no-op (the port promises idempotence).
    async delete({ eventId, humanId }) {
      await p.eventRsvp.deleteMany({
        where: { eventId, humanId },
      });
    },

    async existsForUser({ eventId, humanId }) {
      const row = await p.eventRsvp.findUnique({
        where: { eventId_humanId: { eventId, humanId } },
        select: { id: true },
      });
      return row !== null;
    },

    // Same ownership predicate as `listForUser` (`humanId` — every row is a
    // live RSVP; cancelling deletes it), narrowed to not-ended events in the
    // given statuses and ordered by the event's start, soonest first. The
    // eventId tiebreak makes the order total. Backs the navbar next-night read.
    async listUpcomingEventsForUser({ humanId, now, eventStatuses, limit }) {
      const rows = await p.eventRsvp.findMany({
        where: {
          humanId,
          event: {
            endsAt: { gt: now },
            status: { in: [...eventStatuses] },
          },
        },
        orderBy: [{ event: { startsAt: "asc" } }, { eventId: "asc" }],
        take: Math.max(1, Math.min(limit, MAX_LIMIT)),
        select: { eventId: true, event: { select: { startsAt: true } } },
      });
      return rows.map((row) => ({
        eventId: row.eventId,
        startsAt: row.event.startsAt,
      }));
    },

    // Newest RSVP first (createdAt desc, id desc); keyset cursor = rsvp id,
    // same scheme as eventSaves.listForHuman. Records carry eventId so core
    // can hydrate the events afterwards.
    async listForUser({ humanId, cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.eventRsvp.findMany({
        where: { humanId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: RSVP_SELECT,
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(mapRecord);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    // Keyset on the compound unique's (eventId, humanId) leading column —
    // index-only scan, no standalone eventId index needed. Mirrors
    // eventSaves.listHumanIdsForEvent; the dispatch unions both audiences.
    async listHumanIdsForEvent({ eventId, cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.eventRsvp.findMany({
        where: {
          eventId,
          ...(cursor ? { humanId: { gt: cursor } } : {}),
        },
        orderBy: { humanId: "asc" },
        take: safeLimit + 1,
        select: { humanId: true },
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(
        (row) => row.humanId,
      );

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1] ?? null) : null,
      };
    },
  } satisfies EventRsvpsRepo;
}

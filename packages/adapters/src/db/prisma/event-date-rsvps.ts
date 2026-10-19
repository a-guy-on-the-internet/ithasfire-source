import { Prisma } from "@prisma/client";
import type { EventDateRsvpRepo } from "@th/ports/repos/event-dates";
import type { EventDateRsvpRecord } from "@th/types";

import type { PrismaClientOrTx } from "./types";

// Bounded reconciliation attempts for the benign insert-vs-delete race (see
// `upsert`). Two create↔delete interleavings can at most trade the row a
// handful of times before one side settles; a small cap avoids an unbounded
// spin while comfortably covering real concurrency. Mirrors event-rsvps.ts.
const UPSERT_MAX_ATTEMPTS = 5;

const RSVP_SELECT = {
  id: true,
  eventDateId: true,
  humanId: true,
  createdAt: true,
} as const;

function mapRecord(row: {
  id: string;
  eventDateId: string;
  humanId: string;
  createdAt: Date;
}): EventDateRsvpRecord {
  return {
    id: row.id,
    eventDateId: row.eventDateId,
    humanId: row.humanId,
    createdAt: row.createdAt,
  };
}

export function makeEventDateRsvpsRepo(
  p: PrismaClientOrTx,
): EventDateRsvpRepo {
  return {
    // Idempotent AND race-safe. Contract: after this call a row exists for
    // (eventDateId, humanId), and the returned record is always a real row —
    // never `undefined`, never a thrown Zod/Prisma internal. `created` is
    // true ONLY when OUR insert won (the successful `create` branch); a
    // re-RSVP that reads a concurrent/pre-existing row back reports
    // `created: false`, so the per-date RSVP-confirmation enqueue never
    // duplicates. Mirrors makeEventRsvpsRepo.upsert.
    //
    // Prisma's `upsert` is NOT safe against a concurrent `delete` (which uses
    // `deleteMany`): under interleaving it can resolve to `undefined` or throw
    // P2002/P2025, which would surface as a 500 with a raw Zod issue array.
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
    // follow-up findUnique/retry would themselves fail. A per-date RSVP is a
    // single idempotent row write with no other mutation to atomically bind it
    // to, so it deliberately needs no transaction.
    async upsert({ eventDateId, humanId }) {
      for (let attempt = 1; attempt <= UPSERT_MAX_ATTEMPTS; attempt += 1) {
        try {
          const row = await p.eventDateRsvp.create({
            data: { eventDateId, humanId },
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
          const existing = await p.eventDateRsvp.findUnique({
            where: { eventDateId_humanId: { eventDateId, humanId } },
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
        "eventDateRsvp.upsert could not settle a row under concurrent RSVP/cancel",
      );
    },

    // deleteMany so a missing row is a no-op (the port promises idempotence).
    async delete({ eventDateId, humanId }) {
      await p.eventDateRsvp.deleteMany({
        where: { eventDateId, humanId },
      });
    },

    async existsForUser({ eventDateId, humanId }) {
      const row = await p.eventDateRsvp.findUnique({
        where: { eventDateId_humanId: { eventDateId, humanId } },
        select: { id: true },
      });
      return row !== null;
    },

    // One night of the listing is enough; `findFirst` stops at it. Walks the
    // (humanId) index, then the date relation for the event, status and start.
    async existsForUserOnEvent({ eventId, humanId, dateStatus, startsAtFrom }) {
      const row = await p.eventDateRsvp.findFirst({
        where: {
          humanId,
          eventDate: {
            eventId,
            ...(dateStatus ? { status: dateStatus } : {}),
            ...(startsAtFrom ? { startsAt: { gte: startsAtFrom } } : {}),
          },
        },
        select: { id: true },
      });
      return row !== null;
    },

    // Batch seed for the list-dates view: the subset of `eventDateIds` the
    // viewer has RSVP'd. One indexed query on (eventDateId, humanId).
    async listDateIdsForHuman({ humanId, eventDateIds }) {
      if (eventDateIds.length === 0) return [];
      const rows = await p.eventDateRsvp.findMany({
        where: { humanId, eventDateId: { in: eventDateIds } },
        select: { eventDateId: true },
      });
      return rows.map((row) => row.eventDateId);
    },

    // The call-off fan-out's recipient set — ids only, never a count, and
    // never on the wire (see the port doc; FR-004 forbids a public
    // going-count). One indexed query on (eventDateId, humanId). Unbounded on
    // purpose: everyone who said they were coming has to be told, so a page
    // here would be a silently-truncated notification list.
    async listHumanIdsForDate(eventDateId) {
      const rows = await p.eventDateRsvp.findMany({
        where: { eventDateId },
        select: { humanId: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => row.humanId);
    },

    // Presence, not a count: `distinct` on eventDateId means one row per
    // date whether one person or forty said they were coming, and nothing
    // here can be summed into the going-count FR-004 forbids. Moderator-only
    // at the use case (see the port doc). One indexed query on
    // (eventDateId, humanId).
    async listDateIdsWithAnyRsvp(eventDateIds) {
      if (eventDateIds.length === 0) return [];
      const rows = await p.eventDateRsvp.findMany({
        where: { eventDateId: { in: eventDateIds } },
        select: { eventDateId: true },
        distinct: ["eventDateId"],
      });
      return rows.map((row) => row.eventDateId);
    },
  } satisfies EventDateRsvpRepo;
}

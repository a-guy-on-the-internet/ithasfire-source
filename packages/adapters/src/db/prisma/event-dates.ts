import type { EventDatesRepo } from "@th/ports/repos/event-dates";
import type { EventDateRecord } from "@th/types";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const EVENT_DATE_SELECT = {
  id: true,
  eventId: true,
  ordinal: true,
  startsAt: true,
  endsAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

function mapRecord(row: {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: "SCHEDULED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
}): EventDateRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    ordinal: row.ordinal,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeEventDatesRepo(p: PrismaClientOrTx): EventDatesRepo {
  return {
    // Reconcile the stored occurrence set to the desired FUTURE set. This runs
    // inside the caller's repos.tx (p is the tx client). See the port doc for
    // the exact preservation semantics. Ordinals are assigned here (not by the
    // caller) so re-expansion can never collide with a preserved past/cancelled
    // row's ordinal — the @@unique([eventId, ordinal]) invariant holds.
    async bulkReplaceForEvent({ eventId, now, dates }) {
      const desired = [...dates].sort(
        (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
      );
      const desiredByMs = new Map<number, { endsAt: Date | null }>();
      for (const d of desired) {
        desiredByMs.set(d.startsAt.getTime(), { endsAt: d.endsAt ?? null });
      }

      const existing = await p.eventDate.findMany({
        where: { eventId },
        select: {
          id: true,
          ordinal: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
        orderBy: { ordinal: "asc" },
      });

      const existingByMs = new Map<
        number,
        { id: string; endsAt: Date | null; status: "SCHEDULED" | "CANCELLED" }
      >();
      let maxOrdinal = 0;
      for (const row of existing) {
        existingByMs.set(row.startsAt.getTime(), {
          id: row.id,
          endsAt: row.endsAt,
          status: row.status,
        });
        if (row.ordinal > maxOrdinal) {
          maxOrdinal = row.ordinal;
        }
      }

      const nowMs = now.getTime();

      // 1. Reconcile FUTURE SCHEDULED rows the new expansion dropped. Past
      //    rows and CANCELLED rows are excluded from the filter (history +
      //    prior cancellations always survive). A dropped future date is then
      //    either:
      //      - CANCELLED (row + its EventDateRsvps preserved) when it has ≥1
      //        RSVP — a moderator schedule edit must NOT silently destroy
      //        attendees' intent (the cascade would delete their RSVPs). The
      //        cancelled ids are RETURNED so the use case can tell those
      //        people; this adapter never writes a notice itself; or
      //      - hard-deleted when it has NO RSVPs (nothing to preserve).
      //    Idempotent: a re-run finds the same rows already CANCELLED (now
      //    excluded by the SCHEDULED filter) or already gone.
      const droppedIds = existing
        .filter(
          (row) =>
            row.status === "SCHEDULED" &&
            row.startsAt.getTime() >= nowMs &&
            !desiredByMs.has(row.startsAt.getTime()),
        )
        .map((row) => row.id);
      const cancelledDateIds: string[] = [];
      if (droppedIds.length > 0) {
        const withRsvp = new Set(
          (
            await p.eventDateRsvp.findMany({
              where: { eventDateId: { in: droppedIds } },
              select: { eventDateId: true },
              distinct: ["eventDateId"],
            })
          ).map((row) => row.eventDateId),
        );
        const toCancelIds = droppedIds.filter((id) => withRsvp.has(id));
        const toDeleteIds = droppedIds.filter((id) => !withRsvp.has(id));
        if (toCancelIds.length > 0) {
          // GUARDED, and it RETURNS what it changed. `status: "SCHEDULED"` in
          // the WHERE makes this a compare-and-set: the rows come back only to
          // the transaction that actually observed SCHEDULED -> CANCELLED, so a
          // concurrent moderator (or a `cancelEventDate` racing this rule
          // change) cannot make two transactions both fan out for the same
          // night. Read committed would otherwise let the loser re-match on id
          // alone after the winner commits and re-send every email.
          const cancelled = await p.eventDate.updateManyAndReturn({
            where: { id: { in: toCancelIds }, status: "SCHEDULED" },
            data: { status: "CANCELLED" },
            select: { id: true },
          });
          for (const row of cancelled) cancelledDateIds.push(row.id);
        }
        if (toDeleteIds.length > 0) {
          await p.eventDate.deleteMany({ where: { id: { in: toDeleteIds } } });
        }
      }

      // 2. Insert / refresh desired dates.
      let nextOrdinal = maxOrdinal + 1;
      for (const d of desired) {
        const ms = d.startsAt.getTime();
        const match = existingByMs.get(ms);
        if (match) {
          // A CANCELLED occurrence at this instant stays off; only refresh the
          // window on a still-live SCHEDULED row — and only when `endsAt`
          // actually differs. The rolling daily refresh job re-runs this for
          // every recurring listing, so an unconditional update would bump
          // every EventDate.updatedAt and issue O(occurrences) pointless
          // UPDATEs per listing per day. Compare instants (both nullable).
          const desiredEndsAt = d.endsAt ?? null;
          const endsAtChanged =
            (match.endsAt?.getTime() ?? null) !==
            (desiredEndsAt?.getTime() ?? null);
          if (match.status === "SCHEDULED" && endsAtChanged) {
            await p.eventDate.update({
              where: { id: match.id },
              data: { endsAt: desiredEndsAt },
            });
          }
          continue;
        }
        await p.eventDate.create({
          data: {
            eventId,
            ordinal: nextOrdinal,
            startsAt: d.startsAt,
            endsAt: d.endsAt ?? null,
            status: "SCHEDULED",
          },
        });
        nextOrdinal += 1;
      }

      const result = await p.eventDate.findMany({
        where: { eventId, status: "SCHEDULED" },
        select: EVENT_DATE_SELECT,
        orderBy: { startsAt: "asc" },
      });
      return { scheduled: result.map(mapRecord), cancelledDateIds };
    },

    async listByEvent({ eventId, from, statuses, limit }) {
      const rows = await p.eventDate.findMany({
        where: {
          eventId,
          ...(from ? { startsAt: { gte: from } } : {}),
          ...(statuses && statuses.length > 0
            ? { status: { in: statuses } }
            : {}),
        },
        select: EVENT_DATE_SELECT,
        orderBy: { startsAt: "asc" },
        take: safeLimit(limit),
      });
      return rows.map(mapRecord);
    },

    async listByEventIds({ eventIds, statuses }) {
      if (eventIds.length === 0) return [];
      // No `take` on purpose (port doc): the caller bounded the event set,
      // and "Date N of M" needs every scheduled row of each event.
      const rows = await p.eventDate.findMany({
        where: {
          eventId: { in: [...eventIds] },
          ...(statuses && statuses.length > 0
            ? { status: { in: statuses } }
            : {}),
        },
        select: EVENT_DATE_SELECT,
        orderBy: [{ eventId: "asc" }, { startsAt: "asc" }],
      });
      return rows.map(mapRecord);
    },

    // EVERY status, CANCELLED included — see the port doc. The SCHEDULED
    // filter that used to live here is what made a called-off night vanish
    // from the public schedule instead of showing as called off; the row now
    // comes back carrying its `status` and the reader decides.
    async listUpcoming({ eventId, now, limit }) {
      const rows = await p.eventDate.findMany({
        where: {
          eventId,
          startsAt: { gte: now },
        },
        select: EVENT_DATE_SELECT,
        orderBy: { startsAt: "asc" },
        take: safeLimit(limit),
      });
      return rows.map(mapRecord);
    },

    async markStatus({ id, status }) {
      const row = await p.eventDate.update({
        where: { id },
        data: { status },
        select: EVENT_DATE_SELECT,
      });
      return mapRecord(row);
    },

    // Guarded compare-and-set: the expectation rides in the WHERE clause, so a
    // row a concurrent moderator already transitioned simply doesn't match and
    // the update is a no-op (`updated: false`) rather than a second observed
    // transition. `cancelEventDate` hangs its notification fan-out off the
    // winning call, which is what makes "told once" true without a unique
    // index.
    async markStatusIf({ id, expectStatus, status }) {
      const result = await p.eventDate.updateMany({
        where: { id, status: expectStatus },
        data: { status },
      });
      return { updated: result.count === 1 };
    },

    async getById(id) {
      const row = await p.eventDate.findUnique({
        where: { id },
        select: EVENT_DATE_SELECT,
      });
      return row ? mapRecord(row) : null;
    },
  } satisfies EventDatesRepo;
}

import { Prisma } from "@prisma/client";
import type {
  AttendeeEventCandidate,
  PerformerGigCandidate,
  PostEventPromptAudience,
  PostEventPromptRecord,
  PostEventPromptStatus,
  PostEventPromptsRepo,
} from "@th/ports/repos/post-event-prompts";

import type { PrismaClientOrTx } from "./types";

const PROMPT_SELECT = {
  id: true,
  eventId: true,
  humanId: true,
  placeId: true,
  audience: true,
  status: true,
  attempts: true,
  sentAt: true,
  createdAt: true,
} as const;

type PromptRow = {
  id: string;
  eventId: string;
  humanId: string;
  placeId: string | null;
  audience: string;
  status: string;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
};

const mapRecord = (row: PromptRow): PostEventPromptRecord => ({
  id: row.id,
  eventId: row.eventId,
  humanId: row.humanId,
  placeId: row.placeId,
  audience: row.audience as PostEventPromptAudience,
  status: row.status as PostEventPromptStatus,
  attempts: row.attempts,
  sentAt: row.sentAt,
  createdAt: row.createdAt,
});

/**
 * Event statuses eligible for post-event prompts: CANCELLED gigs must never
 * prompt (weave WS3 risk mitigation), DRAFT/ARCHIVED never had real
 * attendance to solicit.
 */
const PROMPTABLE_EVENT_STATUSES = ["PUBLISHED", "COMPLETED"] as const;

export function makePostEventPromptsRepo(
  p: PrismaClientOrTx,
): PostEventPromptsRepo {
  return {
    // `skipDuplicates` rides the (eventId, humanId, audience) unique index —
    // the enqueue idempotency anchor (weave FR-010 / attendee FR-006).
    createManySkipExisting: async (inputs) => {
      if (inputs.length === 0) {
        return 0;
      }
      const result = await p.postEventPrompt.createMany({
        data: inputs.map((input) => ({
          eventId: input.eventId,
          humanId: input.humanId,
          placeId: input.placeId ?? null,
          audience: input.audience,
        })),
        skipDuplicates: true,
      });
      return result.count;
    },

    // PENDING rows for the requested audiences only (gated audiences must
    // not fill — and thereby starve — the batch), oldest first with a stable
    // id tie-break. `FOR UPDATE SKIP LOCKED` claim mirrors the rsvp-notices
    // repo: overlapping drain runs never process the SAME prompt; the claim
    // doesn't persist past the statement, so unprocessed rows re-appear next
    // tick.
    listPending: async ({ limit, audiences }) => {
      if (audiences.length === 0) {
        return [];
      }
      const rows = await p.$queryRaw<PromptRow[]>(Prisma.sql`
        SELECT
          "id",
          "eventId",
          "humanId",
          "placeId",
          "audience"::text AS "audience",
          "status"::text AS "status",
          "attempts",
          "sentAt",
          "createdAt"
        FROM "PostEventPrompt"
        WHERE "status" = 'PENDING'
          AND "audience"::text IN (${Prisma.join(audiences)})
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      return rows.map(mapRecord);
    },

    markSent: async (ids, at) => {
      if (ids.length === 0) {
        return;
      }
      await p.postEventPrompt.updateMany({
        where: { id: { in: ids } },
        data: { status: "SENT", sentAt: at },
      });
    },

    markFailed: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      await p.postEventPrompt.updateMany({
        where: { id: { in: ids } },
        data: { status: "FAILED" },
      });
    },

    incrementAttempts: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      await p.postEventPrompt.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 } },
      });
    },

    // ACCEPTED pitch → its Agreement → a finished, non-cancelled event.
    // `placeId` comes from the BookingRequest (the venue that was pitched) —
    // that is the review target regardless of where the event row ended up.
    listPerformerGigCandidates: async ({ endedAfter, endedBefore }) => {
      const rows = await p.bookingRequest.findMany({
        where: {
          status: "ACCEPTED",
          agreement: {
            is: {
              eventId: { not: null },
              event: {
                is: {
                  endsAt: { gt: endedAfter, lte: endedBefore },
                  status: { in: [...PROMPTABLE_EVENT_STATUSES] },
                },
              },
            },
          },
        },
        select: {
          id: true,
          placeId: true,
          performerOwnerType: true,
          performerOwnerId: true,
          agreement: {
            select: {
              event: {
                select: {
                  id: true,
                  status: true,
                  endsAt: true,
                  eventHumans: {
                    where: { role: "PERFORMER", humanId: { not: null } },
                    select: { humanId: true },
                  },
                },
              },
            },
          },
        },
      });

      const candidates: PerformerGigCandidate[] = [];
      for (const row of rows) {
        const event = row.agreement?.event;
        if (!event) {
          // Guarded by the where clause; TypeScript can't see that.
          continue;
        }
        candidates.push({
          bookingRequestId: row.id,
          eventId: event.id,
          eventStatus: event.status,
          eventEndsAt: event.endsAt,
          placeId: row.placeId,
          performerOwnerType: row.performerOwnerType,
          performerOwnerId: row.performerOwnerId,
          lineupHumanIds: event.eventHumans
            .map((eh) => eh.humanId)
            .filter((id): id is string => id !== null),
        });
      }
      return candidates;
    },

    listAttendeeEventCandidates: async ({ endedAfter, endedBefore }) => {
      const rows = await p.event.findMany({
        where: {
          endsAt: { gt: endedAfter, lte: endedBefore },
          status: { in: [...PROMPTABLE_EVENT_STATUSES] },
          tickets: { some: { status: "SCANNED" } },
        },
        select: { id: true, status: true, placeId: true },
      });
      return rows.map(
        (row): AttendeeEventCandidate => ({
          eventId: row.id,
          eventStatus: row.status,
          placeId: row.placeId,
        }),
      );
    },

    scannedTicketHolderHumanIds: async (eventId) => {
      const rows = await p.ticket.findMany({
        where: { eventId, status: "SCANNED" },
        select: { ownerHumanId: true },
        distinct: ["ownerHumanId"],
      });
      return rows.map((row) => row.ownerHumanId);
    },

    humanIdsWithPrompt: async ({ eventId, audience }) => {
      const rows = await p.postEventPrompt.findMany({
        where: { eventId, audience },
        select: { humanId: true },
      });
      return rows.map((row) => row.humanId);
    },

    existsForAudience: async ({ eventId, humanId, audience }) => {
      // Rides the (eventId, humanId, audience) unique index — a point lookup,
      // not a scan.
      const row = await p.postEventPrompt.findFirst({
        where: { eventId, humanId, audience },
        select: { id: true },
      });
      return row !== null;
    },
  } satisfies PostEventPromptsRepo;
}

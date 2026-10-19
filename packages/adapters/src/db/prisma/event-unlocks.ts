import type { Prisma } from "@prisma/client";

import type {
  EventUnlocksRepo,
  EventUnlockRecord,
  CreateEventUnlockInput,
  EventUnlockSource,
} from "@th/ports/repos/event-unlocks";

import type { PrismaClientOrTx } from "./types";

type EventUnlockRow = {
  id: string;
  eventId: string;
  humanId: string;
  source: string;
  applicationSubmissionId: string | null;
  inviteId: string | null;
  metadata: unknown;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: EventUnlockRow): EventUnlockRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    humanId: row.humanId,
    source: row.source as EventUnlockSource,
    applicationSubmissionId: row.applicationSubmissionId,
    inviteId: row.inviteId,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeEventUnlocksRepo(p: PrismaClientOrTx): EventUnlocksRepo {
  return {
    async upsert(input: CreateEventUnlockInput): Promise<EventUnlockRecord> {
      const metadata = (input.metadata ?? {}) as Prisma.InputJsonValue;
      const row = await p.eventUnlock.upsert({
        where: {
          eventId_humanId: {
            eventId: input.eventId,
            humanId: input.humanId,
          },
        },
        create: {
          eventId: input.eventId,
          humanId: input.humanId,
          source: input.source,
          applicationSubmissionId: input.applicationSubmissionId ?? null,
          inviteId: input.inviteId ?? null,
          metadata,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null, // Explicitly not revoked on create
        },
        update: {
          // Re-unlock: clear revoked, update source/metadata
          source: input.source,
          applicationSubmissionId: input.applicationSubmissionId ?? null,
          inviteId: input.inviteId ?? null,
          metadata,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
        },
      });
      return toRecord(row);
    },

    async isUnlocked(eventId: string, humanId: string): Promise<boolean> {
      const now = new Date();
      const record = await p.eventUnlock.findUnique({
        where: {
          eventId_humanId: { eventId, humanId },
        },
        select: {
          revokedAt: true,
          expiresAt: true,
        },
      });

      if (!record) return false;
      if (record.revokedAt !== null) return false;
      if (record.expiresAt !== null && record.expiresAt < now) return false;

      return true;
    },

    async get(
      eventId: string,
      humanId: string,
    ): Promise<EventUnlockRecord | null> {
      const row = await p.eventUnlock.findUnique({
        where: {
          eventId_humanId: { eventId, humanId },
        },
      });
      return row ? toRecord(row) : null;
    },

    async revoke(
      eventId: string,
      humanId: string,
    ): Promise<EventUnlockRecord | null> {
      try {
        const row = await p.eventUnlock.update({
          where: {
            eventId_humanId: { eventId, humanId },
          },
          data: {
            revokedAt: new Date(),
          },
        });
        return toRecord(row);
      } catch {
        // Record doesn't exist - that's fine
        return null;
      }
    },

    async revokeBySubmission(
      applicationSubmissionId: string,
    ): Promise<number> {
      const res = await p.eventUnlock.updateMany({
        where: { applicationSubmissionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return res.count;
    },

    async revokeByInvite(inviteId: string, at: Date): Promise<number> {
      const res = await p.eventUnlock.updateMany({
        where: { inviteId, revokedAt: null },
        data: { revokedAt: at },
      });
      return res.count;
    },

    async repointInvite(input): Promise<boolean> {
      if (input.fromInviteIds.length === 0) return false;
      const res = await p.eventUnlock.updateMany({
        where: {
          eventId: input.eventId,
          humanId: input.humanId,
          inviteId: { in: [...input.fromInviteIds] },
          revokedAt: null,
        },
        data: { inviteId: input.toInviteId },
      });
      return res.count > 0;
    },

    async listByEventId(eventId: string): Promise<EventUnlockRecord[]> {
      const rows = await p.eventUnlock.findMany({
        where: { eventId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toRecord);
    },

    async listByHumanId(humanId: string): Promise<EventUnlockRecord[]> {
      const rows = await p.eventUnlock.findMany({
        where: { humanId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toRecord);
    },
  };
}

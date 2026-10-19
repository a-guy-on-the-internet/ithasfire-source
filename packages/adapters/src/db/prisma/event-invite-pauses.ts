import { Prisma } from "@prisma/client";

import type {
  EventInvitePauseOwner,
  EventInvitePauseRecord,
  EventInvitePausesRepo,
} from "@th/ports/repos/event-invite-pauses";

import type { PrismaClientOrTx } from "./types";

/**
 * Invite complaints + the per-organiser auto-pause (W4). Tables from
 * migration 20261007160000_event_invite_complaint_pause. Core owns the trip
 * rule and runs these pieces in one `repos.tx` after `lockOwner`.
 */

function ownerColumns(owner: EventInvitePauseOwner): {
  orgId: string | null;
  humanOwnerId: string | null;
} {
  return owner.kind === "ORG"
    ? { orgId: owner.orgId, humanOwnerId: null }
    : { orgId: null, humanOwnerId: owner.humanId };
}

/** Where-clause for one owner's rows (the indexed owner column only). */
function ownerWhere(owner: EventInvitePauseOwner) {
  return owner.kind === "ORG"
    ? { orgId: owner.orgId }
    : { humanOwnerId: owner.humanId };
}

/** Namespaced so it cannot collide with another feature hashing the same id. */
function ownerLockKey(owner: EventInvitePauseOwner): string {
  return owner.kind === "ORG"
    ? `invite_pause:org:${owner.orgId}`
    : `invite_pause:human:${owner.humanId}`;
}

type PauseRow = {
  id: string;
  orgId: string | null;
  humanOwnerId: string | null;
  reason: EventInvitePauseRecord["reason"];
  complaintCount: number;
  recipientCount: number;
  pausedAt: Date;
  reviewRequestedAt: Date | null;
  reviewRequestNote: string | null;
  decision: EventInvitePauseRecord["decision"];
  decidedAt: Date | null;
  decidedByHumanId: string | null;
  decisionNote: string | null;
  liftedAt: Date | null;
};

function toRecord(row: PauseRow): EventInvitePauseRecord {
  const owner: EventInvitePauseOwner = row.orgId
    ? { kind: "ORG", orgId: row.orgId }
    : { kind: "HUMAN", humanId: row.humanOwnerId ?? "" };
  return {
    id: row.id,
    owner,
    reason: row.reason,
    complaintCount: row.complaintCount,
    recipientCount: row.recipientCount,
    pausedAt: row.pausedAt,
    reviewRequestedAt: row.reviewRequestedAt,
    reviewRequestNote: row.reviewRequestNote,
    decision: row.decision,
    decidedAt: row.decidedAt,
    decidedByHumanId: row.decidedByHumanId,
    decisionNote: row.decisionNote,
    liftedAt: row.liftedAt,
  };
}

export function makeEventInvitePausesRepo(
  prisma: PrismaClientOrTx,
): EventInvitePausesRepo {
  return {
    async lockOwner(owner) {
      // `$executeRaw`, not `$queryRaw`: pg_advisory_xact_lock returns `void`,
      // which the driver-adapter decoder cannot deserialize (see promos.ts).
      await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerLockKey(owner)}))`;
    },

    async recordComplaint(input) {
      // ON CONFLICT DO NOTHING on the providerEventId unique: a replay is a
      // no-op, and inside a transaction it does not abort it (no P2002).
      const { count } = await prisma.eventInviteComplaint.createMany({
        data: [
          {
            providerEventId: input.providerEventId,
            ...ownerColumns(input.owner),
            eventId: input.eventId,
            emailHash: input.emailHash,
            sentAt: input.sentAt,
            occurredAt: input.occurredAt,
          },
        ],
        skipDuplicates: true,
      });
      return { created: count > 0 };
    },

    async countDistinctComplainants({ owner, since }) {
      // By the send the complaint is about; untagged ones by their own time.
      // COUNT(DISTINCT) in SQL: Prisma's `distinct` (no nativeDistinct) would
      // pull every row into memory under the owner lock. Dates are cast to
      // `timestamp` (the columns are tz-naive UTC), as elsewhere in this repo.
      const ownerSql =
        owner.kind === "ORG"
          ? Prisma.sql`c."orgId" = ${owner.orgId}`
          : Prisma.sql`c."humanOwnerId" = ${owner.humanId}`;
      const rows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT c."emailHash")::bigint AS n
        FROM "EventInviteComplaint" c
        WHERE ${ownerSql}
          AND (
            c."sentAt" >= ${since}::timestamp
            OR (c."sentAt" IS NULL AND c."occurredAt" >= ${since}::timestamp)
          )
      `);
      return Number(rows[0]?.n ?? 0);
    },

    async countInviteRecipients({ owner, since }) {
      // The invite's owner is its event's owner: an org-owned event's
      // organiser is the org, even when it also carries a humanId.
      const ownerSql =
        owner.kind === "ORG"
          ? Prisma.sql`e."orgId" = ${owner.orgId}`
          : Prisma.sql`e."orgId" IS NULL AND e."humanId" = ${owner.humanId}`;
      // DISTINCT recipients, counted in SQL (no rows pulled into memory).
      // PERSONAL emails are stored lowercase (CHECK
      // "EventInvite_kind_invitee_check"), so distinct on the column is
      // distinct on lower(email).
      const rows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT ei."inviteeEmail")::bigint AS n
        FROM "EventInvite" ei
        JOIN "Event" e ON e."id" = ei."eventId"
        WHERE ${ownerSql}
          AND ei."kind" = 'PERSONAL'
          AND ei."sentAt" >= ${since}::timestamp
      `);
      return Number(rows[0]?.n ?? 0);
    },

    async getOpenPause(owner) {
      const row = await prisma.eventInvitePause.findFirst({
        where: { ...ownerWhere(owner), liftedAt: null },
      });
      return row ? toRecord(row) : null;
    },

    async getLatestPause(owner) {
      const row = await prisma.eventInvitePause.findFirst({
        where: ownerWhere(owner),
        orderBy: [{ pausedAt: "desc" }, { id: "desc" }],
      });
      return row ? toRecord(row) : null;
    },

    async getLastLiftedAt(owner) {
      const row = await prisma.eventInvitePause.findFirst({
        where: { ...ownerWhere(owner), liftedAt: { not: null } },
        orderBy: { liftedAt: "desc" },
        select: { liftedAt: true },
      });
      return row?.liftedAt ?? null;
    },

    async getLatestComplaintEventId(owner) {
      // Served by the (orgId|humanOwnerId, occurredAt) indexes.
      const row = await prisma.eventInviteComplaint.findFirst({
        where: { ...ownerWhere(owner), eventId: { not: null } },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        select: { eventId: true },
      });
      return row?.eventId ?? null;
    },

    async openPause(input) {
      try {
        const row = await prisma.eventInvitePause.create({
          data: {
            ...ownerColumns(input.owner),
            reason: input.reason,
            complaintCount: input.complaintCount,
            recipientCount: input.recipientCount,
            pausedAt: input.pausedAt,
          },
        });
        return toRecord(row);
      } catch (error) {
        // The only uniques on this table besides the uuid pkey are the
        // one-open-pause-per-owner partial indexes.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw Object.assign(new Error("invite_pause_already_open"), {
            code: "invite_pause_already_open",
          });
        }
        throw error;
      }
    },

    async getById(id) {
      const row = await prisma.eventInvitePause.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async requestReview({ id, note, at }) {
      const { count } = await prisma.eventInvitePause.updateMany({
        where: { id, liftedAt: null, reviewRequestedAt: null },
        data: { reviewRequestedAt: at, reviewRequestNote: note },
      });
      if (count === 0) return null;
      const row = await prisma.eventInvitePause.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async decide({ id, decision, note, decidedByHumanId, at }) {
      const decided = {
        decision,
        decidedAt: at,
        decidedByHumanId,
        decisionNote: note,
      };
      const { count } = await prisma.eventInvitePause.updateMany({
        where: { id, liftedAt: null },
        data:
          decision === "LIFTED"
            ? { ...decided, liftedAt: at }
            : { ...decided, reviewRequestedAt: null, reviewRequestNote: null },
      });
      if (count === 0) return null;
      const row = await prisma.eventInvitePause.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async list({ status, limit, offset }) {
      const where =
        status === "AWAITING_REVIEW"
          ? { liftedAt: null, reviewRequestedAt: { not: null } }
          : status === "OPEN"
            ? { liftedAt: null }
            : { liftedAt: { not: null } };
      const orderBy =
        status === "AWAITING_REVIEW"
          ? [{ reviewRequestedAt: "asc" as const }, { id: "asc" as const }]
          : status === "OPEN"
            ? // Oldest first, so a page cut drops the NEWEST pauses and
              // offset paging ("Load more") walks forward in time.
              [{ pausedAt: "asc" as const }, { id: "asc" as const }]
            : [{ liftedAt: "desc" as const }, { id: "desc" as const }];
      const rows = await prisma.eventInvitePause.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        include: {
          org: { select: { name: true } },
          humanOwner: { select: { name: true } },
        },
      });
      return rows.map((row) => ({
        ...toRecord(row),
        ownerName: row.org?.name ?? row.humanOwner?.name ?? null,
      }));
    },
  };
}

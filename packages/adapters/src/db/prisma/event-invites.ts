import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  EventInvite as PrismaEventInvite,
} from "@prisma/client";
import type {
  CreateEventInviteInput,
  CreateSharedEventInviteInput,
  EventInviteRecord,
  EventInviteRepoErrorCode,
  EventInvitesRepo,
} from "@th/ports/repos/events";
import type { PrismaClientOrTx } from "./types";

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

function mapToRecord(row: PrismaEventInvite): EventInviteRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    kind: row.kind,
    inviteeName: row.inviteeName,
    inviteeEmail: row.inviteeEmail,
    tokenHash: row.tokenHash,
    createdByHumanId: row.createdByHumanId,
    inviteListEntryId: row.inviteListEntryId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    revokedAt: row.revokedAt,
    firstRedeemedAt: row.firstRedeemedAt,
    redemptionCount: row.redemptionCount,
    sentAt: row.sentAt,
    grantsRevokedAt: row.grantsRevokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The SQL-only partial unique indexes from migration
 * 20261003120000_event_invites (noted on the EventInvite model in
 * event.prisma), and the domain error each one's P2002 maps to.
 */
const UNIQUE_INDEX_ERRORS: Record<string, EventInviteRepoErrorCode> = {
  EventInvite_live_shared_key: "shared_invite_already_live",
  EventInvite_personal_email_key: "personal_invite_already_live",
};

/**
 * Index names a P2002 names, collected verbatim across engine shapes (same
 * probe as `rethrowCalendarUniqueViolation` in calendars.ts): the classic
 * engine puts a field array or raw index name on `meta.target`; driver-adapter
 * mode (Prisma 7, the only mode this repo runs) nests the cause under
 * `meta.driverAdapterError.cause`, where the index NAME appears verbatim only
 * inside Postgres's `violates unique constraint "<name>"` message. Exact
 * captures only, never a substring guess.
 */
function uniqueViolationIndexNames(
  error: Prisma.PrismaClientKnownRequestError,
): string[] {
  const m = (error.meta ?? {}) as {
    target?: unknown;
    constraint?: unknown;
    driverAdapterError?: {
      cause?: { constraint?: unknown; originalMessage?: unknown };
    };
  };
  const names: string[] = [];
  const collect = (slot: unknown): void => {
    if (typeof slot === "string") {
      names.push(slot);
      const quoted = /unique constraint "([^"]+)"/.exec(slot);
      if (quoted?.[1]) names.push(quoted[1]);
    } else if (
      slot !== null &&
      typeof slot === "object" &&
      "index" in slot &&
      typeof (slot as { index: unknown }).index === "string"
    ) {
      names.push((slot as { index: string }).index);
    }
  };
  collect(m.target);
  collect(m.constraint);
  collect(m.driverAdapterError?.cause?.constraint);
  collect(m.driverAdapterError?.cause?.originalMessage);
  return names;
}

/**
 * Map a P2002 on one of the live-invite partial uniques to its domain error.
 * Everything else, including a CHECK violation (Postgres 23514, e.g. a SHARED
 * row carrying an invitee, or a mixed-case email) and a `tokenHash` collision,
 * is rethrown untouched: those are bugs, not duplicates.
 */
function rethrowInviteUniqueViolation(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    for (const name of uniqueViolationIndexNames(error)) {
      const code = UNIQUE_INDEX_ERRORS[name];
      if (code) {
        throw { code, message: code, cause: error } as const;
      }
    }
  }
  throw error;
}

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}

function createData(
  input: CreateEventInviteInput,
): Prisma.EventInviteUncheckedCreateInput {
  const base = {
    ...(input.id ? { id: input.id } : {}),
    eventId: input.eventId,
    kind: input.kind,
    tokenHash: input.tokenHash,
    createdByHumanId: input.createdByHumanId,
    metadata: toJsonValue(input.metadata ?? {}),
  };
  if (input.kind === "SHARED") return base;
  return {
    ...base,
    inviteeName: input.inviteeName,
    // Stored lowercase (the CHECK requires it; the email unique index and
    // findLivePersonalByEmail rely on it). Normalizing here means a
    // differently-cased duplicate reaches the unique index, not the CHECK.
    inviteeEmail:
      input.inviteeEmail == null
        ? input.inviteeEmail
        : input.inviteeEmail.trim().toLowerCase(),
    inviteListEntryId: input.inviteListEntryId ?? null,
    sentAt: input.sentAt ?? null,
  };
}

export function makeEventInvitesRepo(
  prisma: PrismaClientOrTx,
): EventInvitesRepo {
  /**
   * Run `fn` atomically. A root client opens its own transaction; a
   * transaction client (the repos.tx() path) is already inside one. Note a
   * failed statement inside a caller's transaction aborts that transaction,
   * as with every other repo.
   */
  const atomically = <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    "$transaction" in prisma
      ? (prisma as PrismaClient).$transaction((tx) => fn(tx))
      : fn(prisma);

  return {
    async create(input: CreateEventInviteInput): Promise<EventInviteRecord> {
      try {
        const row = await prisma.eventInvite.create({
          data: createData(input),
        });
        return mapToRecord(row);
      } catch (error) {
        rethrowInviteUniqueViolation(error);
      }
    },

    async getById(id: string): Promise<EventInviteRecord | null> {
      const row = await prisma.eventInvite.findUnique({ where: { id } });
      return row ? mapToRecord(row) : null;
    },

    async getByTokenHash(tokenHash: string): Promise<EventInviteRecord | null> {
      const row = await prisma.eventInvite.findUnique({ where: { tokenHash } });
      return row ? mapToRecord(row) : null;
    },

    async getLiveShared(eventId: string): Promise<EventInviteRecord | null> {
      const row = await prisma.eventInvite.findFirst({
        where: { eventId, kind: "SHARED", revokedAt: null },
      });
      return row ? mapToRecord(row) : null;
    },

    async listByEvent(eventId: string): Promise<EventInviteRecord[]> {
      const rows = await prisma.eventInvite.findMany({
        where: { eventId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(mapToRecord);
    },

    async findLivePersonalByEmail(
      eventId: string,
      email: string,
    ): Promise<EventInviteRecord | null> {
      // Stored emails are lowercase (CHECK "EventInvite_kind_invitee_check"),
      // so equality against the lowercased input is exact.
      const row = await prisma.eventInvite.findFirst({
        where: {
          eventId,
          kind: "PERSONAL",
          revokedAt: null,
          inviteeEmail: email.trim().toLowerCase(),
        },
      });
      return row ? mapToRecord(row) : null;
    },

    async revoke(id: string, at: Date): Promise<EventInviteRecord | null> {
      // Conditional write: an already-revoked row keeps its first revokedAt.
      await prisma.eventInvite.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at },
      });
      const row = await prisma.eventInvite.findUnique({ where: { id } });
      return row ? mapToRecord(row) : null;
    },

    async recordRedemption(
      id: string,
      at: Date,
    ): Promise<EventInviteRecord | null> {
      try {
        return await atomically(async (tx) => {
          // Two conditional writes, no read: the first stamps firstRedeemedAt
          // only while it is null (a concurrent redeemer re-evaluates the
          // WHERE after the row lock and matches nothing); the second is a
          // SQL-side increment.
          await tx.eventInvite.updateMany({
            where: { id, firstRedeemedAt: null },
            data: { firstRedeemedAt: at },
          });
          const row = await tx.eventInvite.update({
            where: { id },
            data: { redemptionCount: { increment: 1 } },
          });
          return mapToRecord(row);
        });
      } catch (error) {
        if (isRecordNotFound(error)) return null;
        throw error;
      }
    },

    async lockIfLive(id: string): Promise<boolean> {
      // Guarded no-op UPDATE rather than `SELECT … FOR SHARE` (Prisma has no
      // locking read; same reasoning as lockApprovedSubmission): the WHERE
      // re-checks `revokedAt IS NULL` inside the write, and the write holds
      // the row lock until the caller's transaction ends. It rewrites
      // `revokedAt` with the null it already has; `updatedAt` is @updatedAt,
      // so Prisma also bumps it. That is the only visible change, and
      // harmless (nothing orders or caches on an invite's updatedAt).
      const result = await prisma.eventInvite.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: null },
      });
      return result.count > 0;
    },

    async lockIfGrantsHold(id: string): Promise<boolean> {
      // Same guarded no-op UPDATE as lockIfLive, on grantsRevokedAt: the
      // WHERE re-checks it inside the write and the write holds the row lock
      // until the caller's transaction ends.
      const result = await prisma.eventInvite.updateMany({
        where: { id, grantsRevokedAt: null },
        data: { grantsRevokedAt: null },
      });
      return result.count > 0;
    },

    async revokeSharedGrants(
      eventId: string,
      at: Date,
      opts?: { exceptInviteId?: string },
    ): Promise<string[]> {
      const except = opts?.exceptInviteId
        ? { id: { not: opts.exceptInviteId } }
        : {};
      // Conditional write: a row stamped earlier keeps its first stamp.
      await prisma.eventInvite.updateMany({
        where: { eventId, kind: "SHARED", grantsRevokedAt: null, ...except },
        data: { grantsRevokedAt: at },
      });
      const rows = await prisma.eventInvite.findMany({
        where: { eventId, kind: "SHARED", ...except },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map((r) => r.id);
    },

    async rotateShared(
      eventId: string,
      next: Omit<CreateSharedEventInviteInput, "eventId" | "kind">,
      at: Date,
    ): Promise<{
      revoked: EventInviteRecord | null;
      created: EventInviteRecord;
    }> {
      try {
        return await atomically(async (tx) => {
          const live = await tx.eventInvite.findFirst({
            where: { eventId, kind: "SHARED", revokedAt: null },
          });
          let revoked: EventInviteRecord | null = null;
          if (live) {
            // Guarded on revokedAt: a concurrent rotate that committed first
            // makes this match nothing, and our insert below then loses on
            // "EventInvite_live_shared_key" → shared_invite_already_live.
            await tx.eventInvite.updateMany({
              where: { id: live.id, revokedAt: null },
              data: { revokedAt: at },
            });
            const after = await tx.eventInvite.findUnique({
              where: { id: live.id },
            });
            revoked = after ? mapToRecord(after) : null;
          }
          const created = await tx.eventInvite.create({
            data: createData({ ...next, eventId, kind: "SHARED" }),
          });
          return { revoked, created: mapToRecord(created) };
        });
      } catch (error) {
        rethrowInviteUniqueViolation(error);
      }
    },

    async markSent(id: string, at: Date): Promise<EventInviteRecord | null> {
      try {
        const row = await prisma.eventInvite.update({
          where: { id },
          data: { sentAt: at },
        });
        return mapToRecord(row);
      } catch (error) {
        if (isRecordNotFound(error)) return null;
        throw error;
      }
    },
  };
}

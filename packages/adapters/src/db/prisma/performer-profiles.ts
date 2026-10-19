import type { PerformerProfile } from "@prisma/client";
import type {
  PerformerProfilesRepo,
  PerformerProfileRecord,
  PerformerOwnerType,
} from "@th/ports/repos/performer-profiles";

import type { PrismaClientOrTx } from "./types";

export function makePerformerProfilesRepo(
  p: PrismaClientOrTx,
): PerformerProfilesRepo {
  return {
    async getByOwner({ ownerType, ownerId }) {
      const row = await p.performerProfile.findUnique({
        where: { ownerType_ownerId: { ownerType, ownerId } },
      });
      return row ? toRecord(row) : null;
    },

    async upsertEnabled({ ownerType, ownerId, enabled, now }) {
      const existing = await p.performerProfile.findUnique({
        where: { ownerType_ownerId: { ownerType, ownerId } },
      });

      const isEnabled =
        existing != null &&
        existing.enabledAt !== null &&
        existing.disabledAt === null;

      // Idempotent no-ops: already in the requested state.
      if (existing && isEnabled === enabled) {
        return toRecord(existing);
      }

      // Native upsert on the ownerType_ownerId unique (Prisma compiles this
      // to INSERT … ON CONFLICT), so two concurrent first-enables can't race
      // a read-then-create into a P2002 — the loser just lands in the
      // update branch.
      const row = await p.performerProfile.upsert({
        where: { ownerType_ownerId: { ownerType, ownerId } },
        create: {
          ownerType,
          ownerId,
          enabledAt: enabled ? now : null,
          disabledAt: enabled ? null : now,
        },
        update: enabled
          ? { enabledAt: now, disabledAt: null }
          : { disabledAt: now },
      });
      return toRecord(row);
    },

    async setAcceptsBookingRequests({ ownerType, ownerId, accepts }) {
      // UPDATE only — never creates a profile: the acceptance flag is a
      // sub-gate of performer mode (organizer-booking-requests FR-002), so a
      // missing row means the mode gate was skipped (or raced) upstream.
      const result = await p.performerProfile.updateMany({
        where: { ownerType, ownerId },
        data: { acceptsBookingRequests: accepts },
      });
      if (result.count === 0) {
        throw {
          code: "not_found",
          message: "performer_profile_not_found",
        } as const;
      }
      const row = await p.performerProfile.findUniqueOrThrow({
        where: { ownerType_ownerId: { ownerType, ownerId } },
      });
      return toRecord(row);
    },
  };
}

function toRecord(row: PerformerProfile): PerformerProfileRecord {
  return {
    id: row.id,
    ownerType: row.ownerType as PerformerOwnerType,
    ownerId: row.ownerId,
    enabledAt: row.enabledAt,
    disabledAt: row.disabledAt,
    acceptsBookingRequests: row.acceptsBookingRequests,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

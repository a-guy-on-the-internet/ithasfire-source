import type { PerformerBookingDefaults } from "@prisma/client";
import type {
  PerformerBookingDefaultsRepo,
  PerformerBookingDefaultsRecord,
} from "@th/ports/repos/performer-booking-defaults";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import type { BookingFeeType } from "@th/types/repos/booking-requests";

import type { PrismaClientOrTx } from "./types";

export function makePerformerBookingDefaultsRepo(
  p: PrismaClientOrTx,
): PerformerBookingDefaultsRepo {
  return {
    async getByOwner({ ownerType, ownerId }) {
      const row = await p.performerBookingDefaults.findUnique({
        where: { ownerType_ownerId: { ownerType, ownerId } },
      });
      return row ? toRecord(row) : null;
    },

    async upsert(input) {
      // Full-state upsert on the ownerType_ownerId unique (Prisma compiles to
      // INSERT … ON CONFLICT). Every value column is written on both create and
      // update, so a null in the input clears the stored field.
      const data = {
        actName: input.actName,
        lineupSize: input.lineupSize,
        setLengthMinutes: input.setLengthMinutes,
        techNeeds: input.techNeeds,
        contactPhone: input.contactPhone,
        feeType: input.feeType,
        feeAmountCents: input.feeAmountCents,
        feeCurrency: input.feeCurrency,
        messageTemplate: input.messageTemplate,
        includeVerifiedStats: input.includeVerifiedStats,
        linkMusic: input.linkMusic,
        linkVideo: input.linkVideo,
        linkSocial: input.linkSocial,
        linkEpk: input.linkEpk,
      };

      const row = await p.performerBookingDefaults.upsert({
        where: {
          ownerType_ownerId: {
            ownerType: input.ownerType,
            ownerId: input.ownerId,
          },
        },
        create: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          ...data,
        },
        update: data,
      });
      return toRecord(row);
    },
  };
}

function toRecord(
  row: PerformerBookingDefaults,
): PerformerBookingDefaultsRecord {
  return {
    id: row.id,
    ownerType: row.ownerType as PerformerOwnerType,
    ownerId: row.ownerId,
    actName: row.actName ?? null,
    lineupSize: row.lineupSize ?? null,
    setLengthMinutes: row.setLengthMinutes ?? null,
    techNeeds: row.techNeeds ?? null,
    contactPhone: row.contactPhone ?? null,
    feeType: (row.feeType as BookingFeeType | null) ?? null,
    feeAmountCents: row.feeAmountCents ?? null,
    feeCurrency: row.feeCurrency ?? null,
    messageTemplate: row.messageTemplate ?? null,
    includeVerifiedStats: row.includeVerifiedStats ?? null,
    linkMusic: row.linkMusic ?? null,
    linkVideo: row.linkVideo ?? null,
    linkSocial: row.linkSocial ?? null,
    linkEpk: row.linkEpk ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

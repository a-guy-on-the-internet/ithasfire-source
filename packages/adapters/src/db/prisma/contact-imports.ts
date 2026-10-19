import type {
  ContactImportRecord,
  ContactImportsRepo,
  CreateContactImportInput,
  IncrementContactImportCountsInput,
  ListContactImportsByOwnerInput,
} from "@th/ports/repos/events";
import type { ContactImport as PrismaContactImport } from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

const mapImport = (record: PrismaContactImport): ContactImportRecord => ({
  id: record.id,
  ownerType: record.ownerType,
  ownerId: record.ownerId,
  inviteListId: record.inviteListId,
  fileName: record.fileName,
  fileFormat: record.fileFormat,
  totalRows: record.totalRows,
  importedCount: record.importedCount,
  skippedCount: record.skippedCount,
  rejectedCount: record.rejectedCount,
  chunksReceived: record.chunksReceived,
  totalChunks: record.totalChunks,
  completedAt: record.completedAt,
  createdByHumanId: record.createdByHumanId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const sanitizePagination = ({
  limit,
  offset,
}: {
  limit?: number;
  offset?: number;
}) => {
  const take = Math.min(Math.max(limit ?? 50, 1), 200);
  const skip = Math.max(offset ?? 0, 0);
  return { take, skip };
};

export function makeContactImportsRepo(
  p: PrismaClientOrTx,
): ContactImportsRepo {
  return {
    create: async (input: CreateContactImportInput) => {
      const record = await p.contactImport.create({
        data: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          inviteListId: input.inviteListId,
          fileName: input.fileName,
          fileFormat: input.fileFormat,
          totalRows: input.totalRows,
          rejectedCount: input.rejectedCount,
          totalChunks: input.totalChunks ?? null,
          createdByHumanId: input.createdByHumanId,
        },
      });

      return mapImport(record);
    },

    getById: async (importId: string) => {
      const record = await p.contactImport.findUnique({
        where: { id: importId },
      });
      return record ? mapImport(record) : null;
    },

    incrementCounts: async (input: IncrementContactImportCountsInput) => {
      const record = await p.contactImport.update({
        where: { id: input.importId },
        data: {
          importedCount: { increment: input.importedDelta },
          skippedCount: { increment: input.skippedDelta },
          chunksReceived: { increment: 1 },
        },
      });

      return mapImport(record);
    },

    complete: async (importId: string, completedAt: Date) => {
      const record = await p.contactImport.update({
        where: { id: importId },
        data: { completedAt },
      });

      return mapImport(record);
    },

    listByOwner: async (input: ListContactImportsByOwnerInput) => {
      const { take, skip } = sanitizePagination(input);
      const records = await p.contactImport.findMany({
        where: { ownerType: input.ownerType, ownerId: input.ownerId },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      });

      return records.map(mapImport);
    },
  } satisfies ContactImportsRepo;
}

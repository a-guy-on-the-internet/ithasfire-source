import type { PlaceVerificationDocumentsRepo } from "@th/ports/repos/place-verification-documents";
import type {
  CreateVerificationDocumentsInput,
  ListStaleVerificationDocsInput,
  MarkVerificationDocsDeletedInput,
  PlaceVerificationDocumentRecord,
} from "@th/types/repos/place-verification";

import type { PrismaClientOrTx } from "./types";

function mapRow(row: {
  id: string;
  requestId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  deletedAt: Date | null;
  createdAt: Date;
}): PlaceVerificationDocumentRecord {
  return {
    id: row.id,
    requestId: row.requestId,
    storageKey: row.storageKey,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

export function makePlaceVerificationDocumentsRepo(
  p: PrismaClientOrTx,
): PlaceVerificationDocumentsRepo {
  return {
    createMany: async (input: CreateVerificationDocumentsInput) => {
      // Prisma's createMany doesn't return records, so use a transaction of creates
      const created = await Promise.all(
        input.documents.map((doc) =>
          p.placeVerificationDocument.create({
            data: {
              requestId: input.requestId,
              storageKey: doc.storageKey,
              fileName: doc.fileName,
              contentType: doc.contentType,
              sizeBytes: doc.sizeBytes,
            },
          }),
        ),
      );
      return created.map(mapRow);
    },

    getById: async (documentId: string) => {
      const row = await p.placeVerificationDocument.findUnique({
        where: { id: documentId },
      });
      return row ? mapRow(row) : null;
    },

    listByRequestId: async (requestId: string) => {
      const rows = await p.placeVerificationDocument.findMany({
        where: { requestId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapRow);
    },

    listByRequestIds: async (requestIds: string[]) => {
      if (requestIds.length === 0) return [];
      const rows = await p.placeVerificationDocument.findMany({
        where: { requestId: { in: requestIds } },
        orderBy: [{ requestId: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapRow);
    },

    markDeleted: async (input: MarkVerificationDocsDeletedInput) => {
      const result = await p.placeVerificationDocument.updateMany({
        where: {
          requestId: input.requestId,
          deletedAt: null,
        },
        data: {
          deletedAt: input.deletedAt,
        },
      });
      return result.count;
    },

    listStale: async (input: ListStaleVerificationDocsInput) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - input.maxAgeDays);

      const conditions: any[] = [
        // Docs where the parent request is older than maxAgeDays
        {
          deletedAt: null,
          request: { createdAt: { lt: cutoff } },
        },
      ];

      if (input.includeDecided) {
        // Also include docs on non-PENDING requests (decision was made but cleanup failed)
        conditions.push({
          deletedAt: null,
          request: { status: { not: "PENDING" } },
        });
      }

      const rows = await p.placeVerificationDocument.findMany({
        where: { OR: conditions },
        orderBy: { createdAt: "asc" },
      });

      return rows.map(mapRow);
    },
  };
}

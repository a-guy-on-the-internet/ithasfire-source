import type {
  PlaceWaiversRepo,
  PlaceWaiverRecord,
  CreatePlaceWaiverInput,
  UpdatePlaceWaiverInput,
  ListPlaceWaiversInput,
} from "@th/ports/repos/place-waivers";

import type { PrismaClientOrTx } from "./types";

type PlaceWaiverRow = {
  id: string;
  placeId: string;
  title: string;
  content: string;
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: PlaceWaiverRow): PlaceWaiverRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    title: row.title,
    content: row.content,
    version: row.version,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makePlaceWaiversRepo(p: PrismaClientOrTx): PlaceWaiversRepo {
  return {
    async getById(id) {
      const row = await p.placeWaiver.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async create(input: CreatePlaceWaiverInput) {
      // Auto-increment version: find the max version for this place then +1.
      const maxRow = await p.placeWaiver.findFirst({
        where: { placeId: input.placeId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (maxRow?.version ?? 0) + 1;

      const row = await p.placeWaiver.create({
        data: {
          placeId: input.placeId,
          title: input.title,
          content: input.content,
          version: nextVersion,
          isActive: true,
        },
      });
      return toRecord(row);
    },

    async update(input: UpdatePlaceWaiverInput) {
      const row = await p.placeWaiver.update({
        where: { id: input.id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.content !== undefined && { content: input.content }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
      });
      return toRecord(row);
    },

    async delete(id) {
      await p.placeWaiver.delete({ where: { id } });
    },

    async listByPlace(input: ListPlaceWaiversInput) {
      const rows = await p.placeWaiver.findMany({
        where: {
          placeId: input.placeId,
          ...(input.activeOnly && { isActive: true }),
        },
        orderBy: { version: "desc" },
      });
      return rows.map(toRecord);
    },

    async getActiveForPlace(placeId) {
      const row = await p.placeWaiver.findFirst({
        where: { placeId, isActive: true },
        orderBy: { version: "desc" },
      });
      return row ? toRecord(row) : null;
    },
  };
}

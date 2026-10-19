import type {
  ImagesRepo,
  ImageRecord,
  CreateImageInput,
  MarkImageUploadedInput,
  AttachImagesInput,
  DetachImagesInput,
  SoftDeleteImagesInput,
  ImageOwnerType,
  PrimaryImageRef,
} from "@th/ports/repos/images";

import type { PrismaClientOrTx } from "./types";

type ImageRow = {
  id: string;
  ownerType: string;
  ownerId: string;
  eventId: string | null;
  key: string;
  publicUrl: string;
  contentType: string | null;
  sizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  uploadedAt: Date | null;
  attached: boolean;
  attachedAt: Date | null;
  detachedAt: Date | null;
  deletedAt: Date | null;
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: ImageRow): ImageRecord {
  return {
    id: row.id,
    ownerType: row.ownerType as ImageOwnerType,
    ownerId: row.ownerId,
    eventId: row.eventId,
    key: row.key,
    publicUrl: row.publicUrl,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    uploadedAt: row.uploadedAt,
    attached: row.attached,
    attachedAt: row.attachedAt,
    detachedAt: row.detachedAt,
    deletedAt: row.deletedAt,
    createdByHumanId: row.createdByHumanId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeImagesRepo(p: PrismaClientOrTx): ImagesRepo {
  return {
    async create(input: CreateImageInput): Promise<ImageRecord> {
      const row = await p.image.create({
        data: {
          id: input.id,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          eventId: input.eventId ?? null,
          key: input.key,
          publicUrl: input.publicUrl,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          createdByHumanId: input.createdByHumanId,
        },
      });
      return toRecord(row);
    },

    async getById(id: string): Promise<ImageRecord | null> {
      const row = await p.image.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async resolveByIds(ids: string[]): Promise<ImageRecord[]> {
      if (ids.length === 0) return [];
      const rows = await p.image.findMany({
        where: { id: { in: ids } },
      });
      return rows.map(toRecord);
    },

    async markUploaded(
      input: MarkImageUploadedInput,
    ): Promise<ImageRecord | null> {
      // Conditional on `uploadedAt IS NULL AND deletedAt IS NULL`: of two
      // concurrent finalizes exactly one wins, and a retired (refused or
      // swept) row is never revived; the others get null (port contract).
      const { count } = await p.image.updateMany({
        where: { id: input.id, uploadedAt: null, deletedAt: null },
        data: {
          uploadedAt: input.uploadedAt,
          key: input.key,
          publicUrl: input.publicUrl,
          // Only write a size we actually read; never null out a known one.
          ...(input.width != null && input.height != null
            ? { width: input.width, height: input.height }
            : {}),
        },
      });
      if (count === 0) return null;
      const row = await p.image.findUnique({ where: { id: input.id } });
      return row ? toRecord(row) : null;
    },

    async attach(input: AttachImagesInput): Promise<void> {
      if (input.imageIds.length === 0) return;
      await p.image.updateMany({
        where: {
          id: { in: input.imageIds },
          ownerId: input.ownerId,
        },
        data: {
          attached: true,
          attachedAt: input.attachedAt,
          detachedAt: null, // Clear any previous detach
        },
      });
    },

    async detach(input: DetachImagesInput): Promise<void> {
      if (input.imageIds.length === 0) return;
      await p.image.updateMany({
        where: {
          id: { in: input.imageIds },
          ownerId: input.ownerId,
        },
        data: {
          attached: false,
          detachedAt: input.detachedAt,
        },
      });
    },

    async softDelete(input: SoftDeleteImagesInput): Promise<void> {
      if (input.imageIds.length === 0) return;
      await p.image.updateMany({
        where: { id: { in: input.imageIds } },
        data: { deletedAt: input.deletedAt },
      });
    },

    async softDeleteIfUnfinalized(input: {
      id: string;
      deletedAt: Date;
    }): Promise<boolean> {
      const { count } = await p.image.updateMany({
        where: { id: input.id, uploadedAt: null, deletedAt: null },
        data: { deletedAt: input.deletedAt },
      });
      return count > 0;
    },

    async listByOwner(
      ownerType: ImageOwnerType,
      ownerId: string,
    ): Promise<ImageRecord[]> {
      const rows = await p.image.findMany({
        where: {
          ownerType,
          ownerId,
          deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRecord);
    },

    async listByEventId(eventId: string): Promise<ImageRecord[]> {
      // Intentionally does NOT filter `deletedAt` — soft-deleted images still
      // cascade-delete with the event, so storage cleanup must include them.
      const rows = await p.image.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRecord);
    },

    async getPrimaryImageRefs(
      eventIds: string[],
    ): Promise<Map<string, PrimaryImageRef>> {
      if (eventIds.length === 0) return new Map();

      // An event's primary image IS its hero image — resolved through the
      // `Event.heroImageId` FK, the only durable statement of that intent.
      //
      // This used to filter `attached: true` and take the oldest such row.
      // Nothing outside the seed script ever sets `attached`, so for every
      // real, organizer-uploaded event this matched zero rows and both callers
      // (search-index cards, gated preview) silently rendered no image at all.
      const rows = await p.event.findMany({
        where: {
          id: { in: eventIds },
          heroImageId: { not: null },
          heroImage: {
            // A soft-deleted hero is not a hero.
            deletedAt: null,
            // Nor is one whose upload never finalized: `requestEventImageUpload`
            // creates the row with `publicUrl: ""`, and the owned-builder save
            // path accepts any uuid for heroImageId without checking. The old
            // `attached: true` filter excluded these incidentally; keep that.
            uploadedAt: { not: null },
          },
        },
        select: {
          id: true,
          heroImage: {
            select: {
              publicUrl: true,
              // Storage key so PUBLIC callers can run the moderation gate
              // before surfacing the url (gating is keyed by storage key).
              key: true,
            },
          },
        },
      });

      const result = new Map<string, PrimaryImageRef>();
      for (const row of rows) {
        if (!row.heroImage) continue;
        result.set(row.id, {
          publicUrl: row.heroImage.publicUrl,
          key: row.heroImage.key,
        });
      }
      return result;
    },

    async listSweepCandidates(input: {
      createdBefore: Date;
      limit: number;
      after?: { createdAt: Date; id: string } | null;
    }): Promise<ImageRecord[]> {
      // Age + not-already-soft-deleted is the whole predicate. Reachability is
      // decided by the caller against the owning event; see the port doc for
      // why the old `attached: false` filter was not a reachability test.
      //
      // The `(createdAt, id)` keyset is what keeps the scan ADVANCING. Kept
      // images stay live forever, so a bare `take: limit` would hand back the
      // same retained rows every night and never reach anything newer.
      const rows = await p.image.findMany({
        where: {
          deletedAt: null,
          createdAt: { lt: input.createdBefore },
          ...(input.after
            ? {
                OR: [
                  { createdAt: { gt: input.after.createdAt } },
                  {
                    createdAt: input.after.createdAt,
                    id: { gt: input.after.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async listSoftDeleted(input: {
      deletedBefore: Date;
      limit: number;
    }): Promise<ImageRecord[]> {
      const rows = await p.image.findMany({
        where: {
          deletedAt: { not: null, lt: input.deletedBefore },
        },
        orderBy: { deletedAt: "asc" },
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async hardDelete(id: string): Promise<void> {
      await p.image.delete({ where: { id } });
    },
  };
}

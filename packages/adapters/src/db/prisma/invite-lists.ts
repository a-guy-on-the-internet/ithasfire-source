import type {
  AttachInviteListToEventInput,
  BatchUpsertInviteListEntriesInput,
  BatchUpsertResult,
  CopyInviteListEntriesInput,
  CreateInviteListEntryInput,
  CreateInviteListInput,
  DetachInviteListFromEventInput,
  EventInviteListLinkRecord,
  InviteListEntryRecord,
  InviteListRecord,
  InviteListsRepo,
  ListInviteListEntriesInput,
  ListInviteListsByOwnerInput,
  DeleteInviteListEntryInput,
  GetInviteListEntryInput,
  UpdateInviteListEntryInput,
  UpdateInviteListInput,
} from "@th/ports/repos/events";
import { Prisma } from "@prisma/client";
import type {
  EventInviteList as PrismaEventInviteList,
  InviteList as PrismaInviteList,
  InviteListEntry as PrismaInviteListEntry,
} from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;
const coerceJsonRecord = (
  value: Prisma.JsonValue | null,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const mapList = (record: PrismaInviteList): InviteListRecord => ({
  id: record.id,
  ownerType: record.ownerType,
  ownerId: record.ownerId,
  name: record.name,
  description: record.description,
  passwordHint: record.passwordHint,
  contactCount: record.contactCount,
  lastImportAt: record.lastImportAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const mapEntry = (record: PrismaInviteListEntry): InviteListEntryRecord => ({
  id: record.id,
  inviteListId: record.inviteListId,
  humanId: record.humanId,
  contactEmail: record.contactEmail,
  contactPhone: record.contactPhone,
  displayName: record.displayName,
  notes: record.notes,
  tags: record.tags,
  lastInvitedAt: record.lastInvitedAt,
  metadata: coerceJsonRecord(record.metadata),
  importId: record.importId,
  consentSource: record.consentSource,
  consentRecordedAt: record.consentRecordedAt,
  unsubscribedAt: record.unsubscribedAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const mapLink = (record: PrismaEventInviteList): EventInviteListLinkRecord => ({
  id: record.id,
  eventId: record.eventId,
  inviteListId: record.inviteListId,
  context: coerceJsonRecord(record.context),
  createdAt: record.createdAt,
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

export function makeInviteListsRepo(p: PrismaClientOrTx): InviteListsRepo {
  return {
    createList: async (input: CreateInviteListInput) => {
      const record = await p.inviteList.create({
        data: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description ?? null,
          passwordHint: input.passwordHint ?? null,
        },
      });

      return mapList(record);
    },
    updateList: async (input: UpdateInviteListInput) => {
      const data: Prisma.InviteListUpdateInput = {};
      if (Object.prototype.hasOwnProperty.call(input, "name")) {
        data.name = input.name;
      }

      if (Object.prototype.hasOwnProperty.call(input, "description")) {
        data.description = input.description ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "passwordHint")) {
        data.passwordHint = input.passwordHint ?? null;
      }

      const record = await p.inviteList.update({
        where: { id: input.inviteListId },
        data,
      });

      return mapList(record);
    },
    deleteList: async (inviteListId: string) => {
      await p.inviteList.delete({ where: { id: inviteListId } });
    },
    listByOwner: async (input: ListInviteListsByOwnerInput) => {
      const records = await p.inviteList.findMany({
        where: { ownerType: input.ownerType, ownerId: input.ownerId },
        orderBy: { createdAt: "desc" },
      });

      return records.map(mapList);
    },
    getListById: async (inviteListId: string) => {
      const record = await p.inviteList.findUnique({
        where: { id: inviteListId },
      });
      return record ? mapList(record) : null;
    },
    createEntry: async (input: CreateInviteListEntryInput) => {
      const record = await p.inviteListEntry.create({
        data: {
          inviteListId: input.inviteListId,
          humanId: input.humanId ?? null,
          contactEmail: input.contactEmail ?? null,
          contactPhone: input.contactPhone ?? null,
          displayName: input.displayName ?? null,
          notes: input.notes ?? null,
          tags: input.tags ?? [],
          metadata: toJsonValue(input.metadata ?? {}),
          consentSource: input.consentSource ?? null,
          consentRecordedAt: input.consentRecordedAt ?? null,
        },
      });

      return mapEntry(record);
    },
    getEntry: async (input: GetInviteListEntryInput) => {
      const record = await p.inviteListEntry.findFirst({
        where: { id: input.entryId, inviteListId: input.inviteListId },
      });
      return record ? mapEntry(record) : null;
    },
    updateEntry: async (input: UpdateInviteListEntryInput) => {
      const data: Prisma.InviteListEntryUpdateManyMutationInput = {};

      if (Object.prototype.hasOwnProperty.call(input, "contactEmail")) {
        data.contactEmail = input.contactEmail ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "contactPhone")) {
        data.contactPhone = input.contactPhone ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "displayName")) {
        data.displayName = input.displayName ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "notes")) {
        data.notes = input.notes ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "tags")) {
        data.tags = input.tags ?? [];
      }

      if (Object.prototype.hasOwnProperty.call(input, "metadata")) {
        data.metadata = toJsonValue(input.metadata ?? {});
      }

      if (Object.prototype.hasOwnProperty.call(input, "lastInvitedAt")) {
        data.lastInvitedAt = input.lastInvitedAt ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "unsubscribedAt")) {
        data.unsubscribedAt = input.unsubscribedAt ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "consentSource")) {
        data.consentSource = input.consentSource ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "consentRecordedAt")) {
        data.consentRecordedAt = input.consentRecordedAt ?? null;
      }

      // Scoped to the list (security review F9): an entry id from another
      // list matches zero rows instead of being rewritten.
      const where = { id: input.entryId, inviteListId: input.inviteListId };
      const { count } = await p.inviteListEntry.updateMany({ where, data });
      if (count === 0) return null;

      const record = await p.inviteListEntry.findFirst({ where });
      return record ? mapEntry(record) : null;
    },
    deleteEntry: async (input: DeleteInviteListEntryInput) => {
      const { count } = await p.inviteListEntry.deleteMany({
        where: { id: input.entryId, inviteListId: input.inviteListId },
      });
      return { deleted: count > 0 };
    },
    listEntries: async (input: ListInviteListEntriesInput) => {
      const { take, skip } = sanitizePagination(input);
      const where: Prisma.InviteListEntryWhereInput = {
        inviteListId: input.inviteListId,
      };

      if (input.search?.trim()) {
        const query = input.search.trim();
        where.OR = [
          { displayName: { contains: query, mode: "insensitive" } },
          { contactEmail: { contains: query, mode: "insensitive" } },
          { contactPhone: { contains: query, mode: "insensitive" } },
        ];
      }

      const entries = await p.inviteListEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      });

      return entries.map(mapEntry);
    },
    copyEntries: async (input: CopyInviteListEntriesInput) => {
      const sourceEntries = await p.inviteListEntry.findMany({
        where: { inviteListId: input.sourceInviteListId },
      });

      if (!sourceEntries.length) {
        return 0;
      }

      const data = sourceEntries.map((entry) => ({
        inviteListId: input.targetInviteListId,
        humanId: entry.humanId,
        contactEmail: entry.contactEmail,
        contactPhone: entry.contactPhone,
        displayName: entry.displayName,
        notes: entry.notes,
        tags: entry.tags,
        metadata: toJsonValue(coerceJsonRecord(entry.metadata)),
      }));

      const result = await p.inviteListEntry.createMany({
        data,
        skipDuplicates: true,
      });
      return result.count;
    },
    batchUpsertEntries: async (
      input: BatchUpsertInviteListEntriesInput,
    ): Promise<BatchUpsertResult> => {
      if (!input.entries.length) {
        return { insertedCount: 0, skippedCount: 0 };
      }

      const now = new Date();
      const data = input.entries.map((entry) => ({
        inviteListId: input.inviteListId,
        contactEmail: entry.contactEmail ?? null,
        contactPhone: entry.contactPhone ?? null,
        displayName: entry.displayName ?? null,
        notes: entry.notes ?? null,
        tags: entry.tags ?? [],
        humanId: entry.humanId ?? null,
        importId: entry.importId ?? null,
        consentSource: entry.consentSource ?? null,
        consentRecordedAt: entry.consentRecordedAt ?? now,
        metadata: toJsonValue({}),
      }));

      const result = await p.inviteListEntry.createMany({
        data,
        skipDuplicates: true,
      });
      return {
        insertedCount: result.count,
        skippedCount: input.entries.length - result.count,
      };
    },
    deleteAllEntries: async (inviteListId: string): Promise<number> => {
      const result = await p.inviteListEntry.deleteMany({
        where: { inviteListId },
      });
      return result.count;
    },
    updateListCounts: async (inviteListId: string): Promise<void> => {
      const count = await p.inviteListEntry.count({ where: { inviteListId } });
      await p.inviteList.update({
        where: { id: inviteListId },
        data: { contactCount: count },
      });
    },
    attachToEvent: async (input: AttachInviteListToEventInput) => {
      const record = await p.eventInviteList.create({
        data: {
          eventId: input.eventId,
          inviteListId: input.inviteListId,
          context: toJsonValue(input.context ?? {}),
        },
      });

      return mapLink(record);
    },
    detachFromEvent: async (input: DetachInviteListFromEventInput) => {
      await p.eventInviteList.delete({
        where: {
          eventId_inviteListId: {
            eventId: input.eventId,
            inviteListId: input.inviteListId,
          },
        },
      });
    },
    listEventLinks: async (eventId: string) => {
      const records = await p.eventInviteList.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });

      return records.map(mapLink);
    },

    getEntryByListAndEmail: async (inviteListId: string, email: string) => {
      const record = await p.inviteListEntry.findFirst({
        where: {
          inviteListId,
          contactEmail: { equals: email, mode: "insensitive" },
        },
      });
      return record ? mapEntry(record) : null;
    },

    unsubscribeEntry: async (entryId: string, unsubscribedAt: Date) => {
      const record = await p.inviteListEntry.update({
        where: { id: entryId },
        data: { unsubscribedAt },
      });
      return mapEntry(record);
    },
  } satisfies InviteListsRepo;
}

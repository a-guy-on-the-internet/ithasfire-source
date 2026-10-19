import type {
  CreateWaitlistEntryInput,
  EventWaitlistEntryRecord,
  EventWaitlistsRepo,
  FindWaitlistEntryInput,
  ListWaitlistEntriesInput,
  UpdateWaitlistEntryStatusInput,
} from "@th/ports/repos/events";
import { Prisma } from "@prisma/client";
import type { EventWaitlistEntry as PrismaEventWaitlistEntry } from "@prisma/client";

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

const mapEntry = (
  record: PrismaEventWaitlistEntry,
): EventWaitlistEntryRecord => ({
  id: record.id,
  eventId: record.eventId,
  humanId: record.humanId,
  contactEmail: record.contactEmail,
  contactPhone: record.contactPhone,
  source: record.source,
  status: record.status,
  metadata: coerceJsonRecord(record.metadata),
  notifiedAt: record.notifiedAt,
  convertedOrderId: record.convertedOrderId,
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

export function makeEventWaitlistsRepo(
  p: PrismaClientOrTx,
): EventWaitlistsRepo {
  return {
    createEntry: async (input: CreateWaitlistEntryInput) => {
      const record = await p.eventWaitlistEntry.create({
        data: {
          eventId: input.eventId,
          humanId: input.humanId ?? null,
          contactEmail: input.contactEmail ?? null,
          contactPhone: input.contactPhone ?? null,
          source: input.source,
          status: input.status ?? "PENDING",
          metadata: toJsonValue(input.metadata ?? {}),
        },
      });

      return mapEntry(record);
    },
    updateEntry: async (input: UpdateWaitlistEntryStatusInput) => {
      const data: Prisma.EventWaitlistEntryUpdateInput = {
        status: input.status,
        updatedAt: input.updatedAt,
      };

      if (Object.prototype.hasOwnProperty.call(input, "notifiedAt")) {
        data.notifiedAt = input.notifiedAt ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "convertedOrderId")) {
        data.convertedOrderId = input.convertedOrderId ?? null;
      }

      // REPLACE semantics — callers merge with the existing metadata first
      // (see UpdateWaitlistEntryStatusInput). Used for the WAITLISTED
      // application decision's submissionId linkback.
      if (Object.prototype.hasOwnProperty.call(input, "metadata")) {
        data.metadata = toJsonValue(input.metadata ?? {});
      }

      const record = await p.eventWaitlistEntry.update({
        where: { id: input.entryId },
        data,
      });

      return mapEntry(record);
    },
    listEntries: async (input: ListWaitlistEntriesInput) => {
      const { take, skip } = sanitizePagination(input);

      const entries = await p.eventWaitlistEntry.findMany({
        where: {
          eventId: input.eventId,
          ...(input.statuses?.length
            ? {
                status: {
                  in: input.statuses,
                },
              }
            : {}),
        },
        orderBy: { createdAt: "asc" },
        skip,
        take,
      });

      return entries.map(mapEntry);
    },
    findEntry: async (input: FindWaitlistEntryInput) => {
      const record = await p.eventWaitlistEntry.findFirst({
        where: {
          eventId: input.eventId,
          ...(input.humanId ? { humanId: input.humanId } : {}),
          ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
          ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
        },
      });

      return record ? mapEntry(record) : null;
    },
  } satisfies EventWaitlistsRepo;
}

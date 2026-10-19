import { z } from "zod";

export const waitlistEntrySources = [
  "PUBLIC",
  "INVITE",
  "APPLICATION",
] as const;
export const waitlistEntryStatuses = [
  "PENDING",
  "NOTIFIED",
  "PURCHASED",
  "DROPPED",
] as const;

export const eventWaitlistEntryRecordSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  humanId: z.string().uuid().nullable(),
  contactEmail: z.string().max(320).nullable(),
  contactPhone: z.string().max(64).nullable(),
  source: z.enum(waitlistEntrySources),
  status: z.enum(waitlistEntryStatuses),
  metadata: z.record(z.string(), z.unknown()),
  notifiedAt: z.date().nullable(),
  convertedOrderId: z.string().max(64).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

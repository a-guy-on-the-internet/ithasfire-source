import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_ANY_ROLE } from "../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listAnnouncementsInputSchema = z.object({
  ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
  ownerId: z.string().uuid(),
  actorHumanId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

const announcementRecordSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  subject: z.string(),
  audienceType: z.enum([
    "ALL_TICKET_HOLDERS",
    "EVENT_TICKET_HOLDERS",
    "MULTIPLE_EVENTS",
    "EVENT_TICKET_TIER",
    "CONTACT_LIST",
  ]),
  audienceRef: z.string().nullable(),
  recipientCount: z.number().int().nullable(),
  sentAt: z.coerce.date().nullable(),
  sentBy: z.string().uuid(),
  createdAt: z.coerce.date(),
});

export const listAnnouncementsOutputSchema = z.object({
  items: z.array(announcementRecordSchema),
  total: z.number().int(),
});

export type ListAnnouncementsInput = z.infer<
  typeof listAnnouncementsInputSchema
>;
export type ListAnnouncementsOutput = z.infer<
  typeof listAnnouncementsOutputSchema
>;

export type ListAnnouncementsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function listAnnouncements(
  deps: ListAnnouncementsDeps,
  rawInput: unknown,
): Promise<ListAnnouncementsOutput> {
  const input = parseInput(listAnnouncementsInputSchema, rawInput);

  // ── RBAC: authorize based on owner type ───────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ANY_ROLE,
  });

  const result = await deps.repos.announcements.listByOrg({
    orgId: input.ownerId,
    limit: input.limit,
    offset: input.offset,
  });

  return listAnnouncementsOutputSchema.parse({
    items: result.items.map((item) => ({
      id: item.id,
      orgId: item.orgId,
      eventId: item.eventId,
      subject: item.subject,
      audienceType: item.audienceType,
      audienceRef: item.audienceRef,
      recipientCount: item.recipientCount ?? null,
      sentAt: item.sentAt,
      sentBy: item.sentBy,
      createdAt: item.createdAt,
    })),
    total: result.total,
  });
}
